const g = /** @namespace SiteState */ {
  KEY_PREFIX: 'input:', // cache key prefix
  MAX_CACHE_AGE: 7 * 24 * 3600 * 1000, // ms, 7 days
  REQUEST_DELAY: 200, // ms
  STORAGE_QUOTA: 5242880,

  text: '',          // sanitized
  textForCache: '',  // sanitized with optional '/' + category 1-letter key
  textForURL: '',    // sanitized %-encoded
  category: '',      // full name of category specified after /
  siteLink: '',      // top suggestion with site search link and info
  /**
   [o, on, oni, oniz, onizu, onizuk, onizuka]
   assuming the last one is actually fetched and stored,
   each of the preceding strings will be remembered in cache
   to resolve as onizuka
   */
  partialInputs: [],

  reqTimer: 0,
  /** @type AbortController */
  reqAborter: null,
  cache: chrome.storage.local,
  best: null,        // the best match to display in a notification
};

export function init(opts) {
  Object.assign(g, opts, /** @namespace SiteState */ {
    CATEGORY_SPLITTER: new RegExp(`^(.*?)(/[${Object.keys(opts.CATEGORIES).join('')}])?!?$`, 'i'),
  });
}

/*****************************************************************************/

chrome.omnibox.setDefaultSuggestion({description: `Open <url>${g.SITE_URL}</url>`});

chrome.omnibox.onInputChanged.addListener(onInputChanged);

chrome.omnibox.onInputEntered.addListener(text =>
  chrome.tabs.update({
    url: text.match(/^https?:/) ? text :
      text.trim() ? g.makeSearchUrl() :
        g.SITE_URL,
  }));

chrome.omnibox.onInputCancelled.addListener(abortPendingSearch);

chrome.alarms.onAlarm.addListener(alarm =>
  g.cache.remove(alarm.name));

/*****************************************************************************/

async function onInputChanged(text, suggest) {
  text = text.trim();
  g.forceSearch = text.endsWith('!');
  const m = text.match(g.CATEGORY_SPLITTER);
  g.categoryKey = m[2] || '';
  g.category = g.CATEGORIES[g.categoryKey.substr(1)];
  g.text = sanitizeInput(m[1]);
  g.textForURL = encodeURIComponent(m[1]);
  g.textForCache = g.KEY_PREFIX + g.text.toLowerCase() + g.categoryKey;

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

  const data = g.text && await searchSite();
  if (data) {
    displayData(data);
    suggest(data.suggestions);
  }
}

async function readCache(key) {
  const v = (await g.cache.get(key))[key];
  return typeof v == 'string'
    ? readCache(g.KEY_PREFIX + v)
    : v;
}

/** @return {Promise<CookedData>} */
async function searchSite() {
  abortPendingSearch();
  let data = await readCache(g.textForCache);
  if (g.forceSearch || !data || data.expires <= Date.now()) {
    await new Promise(resolve => {
      g.reqTimer = setTimeout(resolve, g.REQUEST_DELAY);
    });
    data = g.reqTimer && await doFetch();
    if (data) updateCache(data);
  }
  return data;
}

async function doFetch() {
  let data;
  try {
    const {signal} = g.reqAborter = new AbortController();
    const url = g.API_URL.replace('%t', g.category) + g.textForURL;
    const req = await fetch(url, {...g.FETCH_OPTS, signal});
    data = await req.json();
  } catch (e) {}
  return data && g.cookSuggestions(data);
}

function updateCache(data) {
  data.expires = Date.now() + g.MAX_CACHE_AGE;
  g.cache.set({[g.textForCache]: data});
  g.partialInputs.pop();
  if (g.partialInputs.length) {
    const partials = {};
    const lcase = g.text.toLowerCase();
    g.partialInputs.forEach(p => {
      partials[g.KEY_PREFIX + p + g.categoryKey] = lcase + g.categoryKey;
    });
    g.cache.set(partials);
  }
  g.cache.getBytesInUse(null, size => size > g.STORAGE_QUOTA / 2 && cleanupCache());
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

/** @param {CookedData} _ */
function displayData({best, siteLink}) {
  chrome.omnibox.setDefaultSuggestion({description: siteLink});
  const img = best.image;
  const url = g.makeImageUrl?.(img) ?? img;
  if (url) {
    g.best = best;
    fetch(url)
      .then(r => r.blob())
      .then(blob2dataUri)
      .then(showImageNotification);
  }
}

function showImageNotification(url) {
  chrome.notifications.create('best', {
    type: 'image',
    iconUrl: 'icon/256.png',
    imageUrl: url,
    title: g.best.title,
    message: g.best.text,
    contextMessage: g.best.note,
  });
}

function abortPendingSearch() {
  clearTimeout(g.reqTimer);
  g.reqAborter?.abort();
  g.reqTimer = g.reqAborter = null;
}

function blob2dataUri(blob) {
  return new Promise(resolve => {
    const fr = new FileReader();
    fr.onloadend = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

export function wordsAsRegexp(s) {
  return new RegExp(
    s.replace(/[^\w]+/g, '|')
      .replace(/^\||\|$/g, '')
    , 'gi');
}

export function escapeXML(s) {
  return !s || !/["'<>&]/.test(s)
    ? s || ''
    : s.replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

export function unescapeXML(s) {
  return !s || !/["'<>&]/.test(s)
    ? s || ''
    : s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, '\'')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
}

export function reescapeXML(s) {
  return escapeXML(unescapeXML(s));
}

export function sanitizeInput(s) {
  // trim punctuation at start/end, replace 2+ spaces with one space
  return s.replace(/^[!-/:-?[-`{-~\s]+/, '')
    .replace(/\s{2,}/, ' ')
    .replace(/[!-/:-?[-`{-~\s]+$/, '');
}
