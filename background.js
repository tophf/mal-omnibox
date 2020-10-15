const MAX_CACHE_AGE = 7 * 24 * 3600 * 1000; // ms, 7 days
const REQUEST_DELAY = 200; // ms
const KEY_PREFIX = 'input:'; // cache key prefix

const SITE_URL = 'https://myanimelist.net/';
const API_URL = SITE_URL + 'search/prefix.json?type=%t&v=1&keyword=';
const SEARCH_URL = SITE_URL + '%c.php?q=';
const SEARCH_ALL_URL = SITE_URL + 'search/all?q=';

const STORAGE_QUOTA = 5242880;
const CATEGORIES = {
  'a': 'anime',
  'm': 'manga',
  'c': 'character',
  'p': 'person',
  'u': 'user',
  'n': 'news',
  'f': 'forum',
  'k': 'club',
  '': 'all',
};
const CATEGORY_SPLITTER = new RegExp('^(.*?)(/[' +
                                     Object.keys(CATEGORIES).join('') + '])?!?$', 'i');

const g = {
  text: '',          // sanitized
  textForCache: '',  // sanitized with optional '/' + category 1-letter key
  textForURL: '',    // sanitized %-encoded
  category: '',      // full name of category specified after /
  siteLink: '',      // top suggestion with site search link and info
  partialInputs: [], // [o, on, oni, oniz, onizu, onizuk, onizuka]
  // assuming the last one is actually fetched and stored,
  // each of the preceding strings will be remembered in cache
  // to resolve as onizuka

  xhrScheduled: 0,   // setTimeout id
  xhr: new XMLHttpRequest(),

  cache: chrome.storage.local,

  img: document.createElement('img'),
  canvas: document.createElement('canvas'),
  canvas2d: null,
  best: null,        // the best match to display in a notification
};
g.xhr.responseType = 'json';
g.canvas2d = g.canvas.getContext('2d');

/*****************************************************************************/

chrome.omnibox.setDefaultSuggestion({description: `Open <url>${SITE_URL}</url>`});

chrome.omnibox.onInputChanged.addListener(onInputChanged);

chrome.omnibox.onInputEntered.addListener(text =>
  chrome.tabs.update({
    url: text.match(/^https?:/)
      ? text
      : text.trim()
        ? (g.category === 'all' ? SEARCH_ALL_URL : SEARCH_URL.replace('%c', g.category)) +
          g.textForURL
        : SITE_URL,
  }));

chrome.omnibox.onInputCancelled.addListener(abortPendingSearch);

chrome.alarms.onAlarm.addListener(alarm =>
  g.cache.remove(alarm.name));

/*****************************************************************************/

function onInputChanged(text, suggest) {
  text = text.trim();
  g.forceSearch = text.endsWith('!');
  const m = text.match(CATEGORY_SPLITTER);
  g.categoryKey = m[2] || '';
  g.category = CATEGORIES[g.categoryKey.substr(1)];
  g.text = sanitizeInput(m[1]);
  g.textForURL = encodeURIComponent(m[1]);
  g.textForCache = KEY_PREFIX + g.text.toLowerCase() + g.categoryKey;

  while (g.partialInputs.length) {
    const last = g.partialInputs.slice(-1)[0];
    if (!last || !g.text.startsWith(last) || g.text.toLowerCase() === last) {
      g.partialInputs.pop();
    } else {
      break;
    }
  }
  g.partialInputs.push(g.text.toLowerCase());

  g.siteLink = `<dim>Search for <match>${escapeXML(g.text)}</match> on site.</dim>`;
  chrome.omnibox.setDefaultSuggestion({description: g.siteLink});

  if (!g.text.length)
    return;

  Promise.resolve(g.textForCache)
    .then(readCache)
    .then(searchSite)
    .then(data => displayData(data, suggest));
}

function readCache(key) {
  return new Promise(done =>
    g.cache.get(key, items => {
      const data = items[key];
      if (typeof data == 'string') {
        key = KEY_PREFIX + data;
        g.cache.get(key, items => done(items[key]));
      } else {
        done(data);
      }
    })
  );
}

function searchSite(data) {
  abortPendingSearch();
  return data && data.expires > Date.now() && !g.forceSearch ? data
    : new Promise(done => (
      g.xhrScheduled = setTimeout(() => {
        g.xhr.open('GET', API_URL.replace('%t', g.category) + g.textForURL);
        g.xhr.onreadystatechange = () => {
          if (g.xhr.readyState === XMLHttpRequest.DONE && g.xhr.status === 200) {
            data = cookSuggestions(g.xhr.response);
            updateCache(data);
            done(data);
          }
        };
        g.xhr.send();
      }, REQUEST_DELAY)
    ));
}

function updateCache(data) {
  data.expires = Date.now() + MAX_CACHE_AGE;
  g.cache.set({[g.textForCache]: data});
  g.partialInputs.pop();
  if (g.partialInputs.length) {
    const partials = {};
    const lcase = g.text.toLowerCase();
    g.partialInputs.forEach(p => {
      partials[KEY_PREFIX + p + g.categoryKey] = lcase + g.categoryKey;
    });
    g.cache.set(partials);
  }
  g.cache.getBytesInUse(null, size => size > STORAGE_QUOTA / 2 && cleanupCache());
  chrome.alarms.create(g.textForCache, {when: data.expires});
}

function cleanupCache() {
  // remove the oldest half of the items
  g.cache.get(null, data => {
    const keys = Object.keys(data);
    keys.sort((a, b) => data[a].expires - data[b].expires);
    g.cache.remove(keys.slice(0, keys.length / 2 | 0));
  });
}

function displayData(data, suggest) {
  chrome.omnibox.setDefaultSuggestion({description: data.siteLink});
  suggest(data.suggestions);
  if (data.best) {
    fetch(data.best.image)
      .then(r => r.blob())
      .then(showImageNotification);
    g.best = data.best;
  }
}

function showImageNotification(blob) {
  const url = URL.createObjectURL(blob);
  chrome.notifications.create('best', {
    type: 'image',
    iconUrl: 'icon/256.png',
    imageUrl: url,
    title: g.best.title,
    message: g.best.text,
    contextMessage: g.best.note,
  }, () => URL.revokeObjectURL(url));
}

function abortPendingSearch() {
  g.xhr.abort();
  clearTimeout(g.xhrScheduled);
}

function cookSuggestions(found) {
  const rxWords = wordsAsRegexp(g.text, 'gi');
  let best;
  return {
    siteLink: g.siteLink + ' Found in categories: ' + found.categories
      .map(cat => `${cat.type} (${cat.items.length})`).join(', '),
    suggestions: []
      .concat.apply([], found.categories.map(cat => cat.items.map(_preprocess)))
      .sort((a, b) => b.weight - a.weight || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))
      .map(_formatItem),
    best: best && {
      title: best.name + ' (' + best.type + ')',
      text: best.payload.aired || best.payload.published || '',
      note: best.status,
      image: best.image_url.replace(/\/r\/\d+x\d+|\?.*/g, ''),
    },
  };

  function _preprocess(item) {
    const isInCategory = item.type.toLowerCase() === g.category;
    const payload = item.payload;
    const type = item.type = payload.media_type || item.type || '';
    const name = item.name = item.name.replace(new RegExp(`\\s+${type}$`), '');

    const marked = item.marked = name.replace(rxWords, '\r$&\n');
    item.weight = 50 * (isInCategory ? 1 : 0) +
                  10 * (marked.match(/^\r|$/g).length - 1) +
                  4 * (marked.match(/ \r|$/g).length - 1) +
                  (marked.match(/\S\r|$/g).length - 1);

    const status = (payload.status || '').replace(/Finished.*|Currently\s*/, '');
    const related = (payload.related_works || []).join(', ');
    const altName = payload.alternative_name;
    item.status = reescapeXML(status || related || altName || '');
    return item;
  }

  function _formatItem(item) {
    best = best || item;
    const name = reescapeXML(item.marked).replace(/\r/g, '<match>').replace(/\n/g, '</match>');
    const year = item.payload.start_year || '';
    const score = item.payload.score || '';
    return {
      content: item.url,
      description:
        _dim(year + ' ' + score) + '&#x20;' +
        `<url>${name}</url> ` +
        _dim(item.type + ' ' + item.status.replace(/.+/, ' ($&)')),
    };
  }

  function _dim(s) {
    return s.trim() ? `<dim>${s.trim()}</dim>` : '';
  }
}

function wordsAsRegexp(s) {
  return new RegExp(
    s.replace(/[^\w]+/g, '|')
      .replace(/^\||\|$/g, '')
    , 'gi');
}

function escapeXML(s) {
  return !s || !/["'<>&]/.test(s)
    ? s || ''
    : s.replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

function unescapeXML(s) {
  return !s || !/["'<>&]/.test(s)
    ? s || ''
    : s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, '\'')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
}

function reescapeXML(s) {
  return escapeXML(unescapeXML(s));
}

function sanitizeInput(s) {
  // trim punctuation at start/end, replace 2+ spaces with one space
  return s.replace(/^[!-/:-?[-`{-~\s]+/, '')
    .replace(/\s{2,}/, ' ')
    .replace(/[!-/:-?[-`{-~\s]+$/, '');
}
