const MAX_CACHE_AGE = 7 * 24 * 3600 * 1000; // ms, 7 days
const REQUEST_DELAY = 200; // ms

const MAL_URL = 'https://myanimelist.net/';
const API_URL = MAL_URL + 'search/prefix.json?type=%t&v=1&keyword=';
const SEARCH_URL = MAL_URL + 'anime.php?q=';

const STORAGE_QUOTA = 5242880;
const CATEGORIES = {
	a: 'anime',
	m: 'manga',
	c: 'character',
	p: 'person',
	u: 'user',
	n: 'news',
	f: 'forum',
	k: 'club',
	'': 'all'
};
const CATEGORY_SPLITTER = new RegExp('^(.*?)(?:/([' +
	Object.keys(CATEGORIES).join('') + ']))?$', 'i');

let g = {
	text: '',          // sanitized
	textForCache: '',  // sanitized with optional '/' + category 1-letter key
	textForURL: '',    // sanitized %-encoded
	category: '',      // full name of category specified after /
	siteLink: '',      // top suggestion with site search link and info

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
g.img.onload = showImageNotification;

/*****************************************************************************/

chrome.omnibox.setDefaultSuggestion({description: `Open <url>${MAL_URL}</url>`});

chrome.omnibox.onInputChanged.addListener(onInputChanged);

chrome.omnibox.onInputEntered.addListener(text =>
	chrome.tabs.update({
		url: text.match(/^https?:/) ? text
		                            : text.trim() ? SEARCH_URL + g.textForURL
		                                          : MAL_URL
	}));

chrome.omnibox.onInputCancelled.addListener(abortRequest);

chrome.alarms.onAlarm.addListener(alarm =>
	g.cache.remove(alarm.name));

/*****************************************************************************/

function onInputChanged(text, suggest)
{
	var m = text.trim().match(CATEGORY_SPLITTER);
	g.category = CATEGORIES[m[2] || ''];
	g.text = sanitizeInput(m[1]);
	g.textForURL = encodeURIComponent(m[1]);
	g.textForCache = 'input:' + g.text + (m[2] ? '/'+m[2] : '');

	g.siteLink = `<dim>Search for <match>${escapeXML(g.text)}</match> on site.</dim>`;
	chrome.omnibox.setDefaultSuggestion({description: g.siteLink});

	if (g.text.length < 3)
		return;

	pipeAsync(
		readCache,
		searchMAL,
		updateCache,
		data => displayData(data, suggest)
	);
}

function readCache(data, next)
{
	g.cache.get(g.textForCache, results =>
		next(results[g.textForCache])
	);
}

function searchMAL(data, next)
{
	abortRequest();

	if (data && data.expires > Date.now())
		return next(data);

	g.xhrScheduled = setTimeout(() => {
		g.xhr.open('GET', API_URL.replace('%t', g.category) + g.textForURL);
		g.xhr.onreadystatechange = () => {
			if (g.xhr.readyState == XMLHttpRequest.DONE && g.xhr.status == 200)
				next(cookSuggestions(g.xhr.response));
		};
		g.xhr.send();
	}, REQUEST_DELAY);
}

function updateCache(data, next)
{
	if (!data.expires) {
		data.expires = Date.now() + MAX_CACHE_AGE;
		g.cache.set({[g.textForCache]: data});
		g.cache.getBytesInUse(null, size => size > STORAGE_QUOTA/2 && cleanupCache());
		chrome.alarms.create(g.textForCache, {when: data.expires});
	}
	next(data);
}

function cleanupCache() {
	// remove the oldest half of the items
	g.cache.get(null, data => {
		var keys = Object.keys(data);
		keys.sort((a,b) => data[a].expires - data[b].expires);
		g.cache.remove(keys.slice(0, keys.length/2 |0));
	});
}

function displayData(data, suggest) {
	chrome.omnibox.setDefaultSuggestion({description: data.siteLink});
	suggest(data.suggestions);
	if (data.best) {
		g.img.src = data.best.image;
		g.best = data.best;
	}
}

function showImageNotification(event) {
	// skip placeholder images
	if (this.naturalWidth < 50)
		return;
	g.canvas.width = this.naturalWidth;
	g.canvas.height = this.naturalHeight;
	g.canvas2d.drawImage(this, 0, 0);
	chrome.notifications.create('best', {
		type: 'image',
		iconUrl: 'icon/128.png',
		imageUrl: g.canvas.toDataURL(),
		title: g.best.name + ' (' + g.best.type + ')',
		message: g.best.dates,
		contextMessage: g.best.status,
	});
}

function abortRequest()
{
	g.xhr.abort();
	clearTimeout(g.xhrScheduled);
}

function cookSuggestions(found)
{
	var rxWords = wordsAsRegexp(g.text, 'gi');
	var best;
	return {
		siteLink: g.siteLink + ' Found in categories: ' + found.categories
			.map(cat => `${cat.type} (${cat.items.length})`).join(', '),
		suggestions: []
			.concat.apply([], found.categories.map(cat => cat.items.map(_preprocess)))
			.sort((a,b) => b.weight - a.weight)
			.map(_formatItem),
		best: best && {
			name: best.name,
			type: best.type,
			status: best.status,
			dates: best.payload.aired || best.payload.published || '',
			image: best.image_url.replace(/\/r\/\d+x\d+|\?.*/g, ''),
		},
	};

	function _preprocess(item) {
		var isInCategory = item.type.toLowerCase() == g.category;
		var payload = item.payload;
		var type = item.type = payload.media_type || item.type || '';
		var name = item.name = item.name.replace(new RegExp(`\\s+${type}$`), '');

		var marked = item.marked = name.replace(rxWords, '\r$&\n');
		item.weight = 100 * (isInCategory ? 1 : 0) +
		               10 * (marked.match(/^\r|$/g).length - 1) +
		                4 * (marked.match(/ \r|$/g).length - 1) +
		                    (marked.match(/\S\r|$/g).length - 1);

		var status = (payload.status || '').replace(/Finished.*|Currently\s*/, '');
		var related = (payload.related_works || []).join(', ');
		var altName = payload.alternative_name;
		item.status = reescapeXML(status || related || altName || '');
		return item;
	}

	function _formatItem(item) {
		best = best || item;
		var name = reescapeXML(item.marked).replace(/\r/g, '<match>').replace(/\n/g, '</match>');
		var year = item.payload.start_year || '';
		var score = item.payload.score || '';
		return {
			content: item.url,
			description:
				_dim(year + ' ' + score) + '&#x20;' +
				`<url>${name}</url> ` +
				_dim(item.type + ' ' + item.status.replace(/.+/, ' ($&)'))
		};
	}

	function _dim(s) {
		return s.trim() ? `<dim>${s.trim()}</dim>` : '';
	}
}

function wordsAsRegexp(s)
{
	return new RegExp(
		s.replace(/[^\w]+/g, '|')
		 .replace(/^\||\|$/g, '')
	, 'gi');
}

function escapeXML(s)
{
	return !s || !/["'<>&]/.test(s) ? s || ''
		: s.replace(/&/g, '&amp;')
		   .replace(/"/g, '&quot;')
		   .replace(/'/g, '&apos;')
		   .replace(/</g, '&lt;')
		   .replace(/>/g, '&gt;');
}

function unescapeXML(s)
{
	return !s || !/["'<>&]/.test(s) ? s || ''
		: s
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&');
}

function reescapeXML(s)
{
	return escapeXML(unescapeXML(s));
}

function sanitizeInput(s)
{
	// trim punctuation at start/end, replace 2+ spaces with one space
	return s.replace(/^[!-\/:-?\[-`{-~\s]+/, '')
	        .replace(/\s{2,}/, ' ')
	        .replace(/[!-\/:-?\[-`{-~\s]+$/, '');
}

function pipeAsync(...functions)
{
	var index = 0;
	_next(undefined);

	function _next(data) {
		if (index < functions.length)
			functions[index++](data, _next);
	}
}
