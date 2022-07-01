import {init, reescapeXML, wordsAsRegexp} from './bg-search.js';

const SITE_URL = 'https://myanimelist.net/';

init(/** @namespace SiteState */ {
  SITE_URL,
  FETCH_OPTS: {
    headers: {'X-LControl': 'x-no-cache'},
  },
  API_URL: SITE_URL + 'search/prefix.json?type=%t&v=1&keyword=',
  SEARCH_URL: SITE_URL + '%c.php?q=',
  SEARCH_ALL_URL: SITE_URL + 'search/all?q=',
  CATEGORIES: {
    'a': 'anime',
    'm': 'manga',
    'c': 'character',
    'p': 'person',
    'u': 'user',
    'n': 'news',
    'f': 'forum',
    'k': 'club',
    '': 'all',
  },

  makeSearchUrl() {
    const c = this.category;
    const base = c === 'all' ? this.SEARCH_ALL_URL : this.SEARCH_URL.replace('%c', c);
    return base + this.textForURL;
  },
  makeImageUrl: s => s,
  cookSuggestions(found) {
    const {category, siteLink, text} = this;
    const rxWords = wordsAsRegexp(text, 'gi');
    let best;
    return /** @namespace CookedData */ {
      siteLink: siteLink + ' Found in categories: ' + found.categories
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
      const isInCategory = item.type.toLowerCase() === category;
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
          dim(year + ' ' + score) + '&#x20;' +
          `<url>${name}</url> ` +
          dim(item.type + ' ' + item.status.replace(/.+/, ' ($&)')),
      };
    }

    function dim(s) {
      s = s.trim();
      return s ? `<dim>${s}</dim>` : '';
    }
  },
});
