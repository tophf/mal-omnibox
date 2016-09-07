const MAX_CACHE_AGE = 24 * 3600 * 1000; // ms
const REQUEST_DELAY = 200; // ms

const API_URL = 'https://myanimelist.net/search/prefix.json?type=%t&v=1&keyword=';
const SEARCH_URL = 'https://myanimelist.net/anime.php?q=';
const MAL_URL = 'https://myanimelist.net/';

const STORAGE_QUOTA = 5242880;
const CATEGORIES = {a: 'anime', m: 'manga', c: 'character', p: 'person', '': 'all'};

let g = {
	category: '',
	text: '',

	xhrScheduled: 0,
	xhr: new XMLHttpRequest(),

	cache: chrome.storage.local,

	img: document.body.appendChild(document.createElement('img')),
	canvas: document.body.appendChild(document.createElement('canvas')),
	canvas2d: null,
};
g.xhr.responseType = 'json';
g.canvas2d = g.canvas.getContext('2d');

/*****************************************************************************/

chrome.omnibox.setDefaultSuggestion({description: `Open <url>${MAL_URL}</url>`});

chrome.omnibox.onInputChanged.addListener(onInputChanged);

chrome.omnibox.onInputEntered.addListener(text =>
	chrome.tabs.update({
		url: text.match(/^https?:/) ? text
		                            : text.trim() ? SEARCH_URL + g.textForURL : MAL_URL
	}));

chrome.omnibox.onInputCancelled.addListener(abortRequest);

chrome.alarms.onAlarm.addListener(alarm =>
	g.cache.remove(alarm.name));

/*****************************************************************************/

function onInputChanged(text, suggest)
{
	g.category = CATEGORIES[(text.match(/\/([amcp])$/) || {1:''})[1]];
	g.text = normalizeSpaces(text).replace(/[!-\/:-?\[-`{-~\s]+$/, '');
	g.textForURL = encodeURIComponent(g.text.replace(/\/([amcp])$/, ''));
	g.siteLink = `<dim>Search for <match>${escapeXML(g.text)}</match> on site.</dim>`;

	chrome.omnibox.setDefaultSuggestion({description: g.siteLink});

	if (text.length < 3)
		return;

	pipe(
		readCache,
		searchMAL,
		updateCache,
		data => {
			chrome.omnibox.setDefaultSuggestion({description: data.siteLink});
			suggest(data.suggestions);
			notify(data.best);
		}
	);
}

function readCache(data, next)
{
	var key = 'input:' + g.text;
	g.cache.get(key, results =>
		next(results[key])
	);
}

function searchMAL(data, next)
{
	abortRequest();

	if (data && data.expires > Date.now())
		return next(data);

	g.xhrScheduled = setTimeout(() => {
		g.xhr.open('GET', API_URL.replace('%t', g.category) + g.textForURL);
		g.xhr.onreadystatechange = () =>
			g.xhr.readyState == XMLHttpRequest.DONE && g.xhr.status == 200
			? next(g.xhr.response) : null;
		g.xhr.send();
	}, REQUEST_DELAY);
}

function updateCache(data, next)
{
	if (!data)
		return;
	if (!data.expires) {
		data = cookSuggestions(data);
		g.cache.set({['input:' + g.text]: data});
		g.cache.getBytesInUse(null, size => size > STORAGE_QUOTA/2 && g.cache.clear());
		chrome.alarms.create(g.text, {when: data.expires});
	}
	next(data);
}

function notify(best) {
	if (!best)
		return;
	g.img.src = best.image;
	g.img.onload = (e) => {
		g.canvas.width = g.img.naturalWidth;
		g.canvas.height = g.img.naturalHeight;
		g.canvas2d.drawImage(g.img, 0, 0);
		chrome.notifications.create('best', {
			type: 'image',
			iconUrl: 'icon/128.png',
			imageUrl: g.canvas.toDataURL(),
			title: best.name + ' (' + best.type + ')',
			message: best.dates,
			contextMessage: best.status,
		});
	};
}

function abortRequest()
{
	g.xhr.abort();
	clearTimeout(g.xhrScheduled);
}

function cookSuggestions(found)
{
	if (!found)
		return;

	var rxWords = wordsAsRegexp(g.text, 'gi');
	var best;
	return {
		siteLink: g.siteLink + ' Found in categories: ' +
			found.categories
				.map(cat => `${cat.type} (${cat.items.length})`)
				.join(', '),
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
		expires: Date.now() + MAX_CACHE_AGE,
	};

	function _preprocess(item) {
		var isInCategory = item.type.toLowerCase() == g.category;
		var payload = item.payload;
		var type = item.type = payload.media_type || item.type || '';
		var name = item.name = item.name.replace(new RegExp(`\\s+${type}$`), '');
		var marked = item.marked = name.replace(rxWords, '\r$&\n');
		item.weight += 100 * (isInCategory ? 1 : 0) +
		                10 * (marked.match(/^\r|^/g).length - 1) +
		                 4 * (marked.match(/ \r|^/g).length - 1) +
		                     (marked.match(/\S\r|^/g).length - 1);
		var related = (payload.related_works || []).join(', ');
		var altName = payload.alternative_name;
		item.status = reescapeXML(payload.status || related || altName || '')
		             .replace(/Finished.*|Currently\s*/, '');
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

function normalizeSpaces(s)
{
	// strip leading spaces, replace 2+ spaces with one space (which allows 1 trailing space)
	return s.replace(/^\s+/, '').replace(/\s{2,}/, ' ');
}

function pipe()
{
	var hasSeed = typeof arguments[0] != 'function';
	var fnIndex = hasSeed ? 1 : 0;
	var fns = Array.apply(null, arguments);

	_next(hasSeed ? arguments[0] : undefined);

	function _next(data) {
		if (fnIndex < fns.length)
			fns[fnIndex++](data, _next);
	}
}
