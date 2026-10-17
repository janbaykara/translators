{
	"translatorID": "8149344c-30af-4c66-85a8-3997a0fbd2f9",
	"label": "Spotify",
	"creator": "Jan Baykara",
	"target": "^https?://open\\.spotify\\.com/(show|episode)/",
	"minVersion": "5.0",
	"maxVersion": "",
	"priority": 100,
	"inRepository": true,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "2026-10-17 00:25:30"
}

/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Jan Baykara

	This file is part of Zotero.

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero. If not, see <http://www.gnu.org/licenses/>.

	***** END LICENSE BLOCK *****
*/


// Persisted-query hashes for Spotify's pathfinder GraphQL API. These can break
// when Spotify rotates queries; embed metadata is the fallback.
var EPISODE_QUERY_HASH = "0b4306ff996f0d8eb8520470fb312834f091b7812b8e744a990992d9509514fb";
var SHOW_QUERY_HASH = "9f0d37dcbd1590c31e3afe321853e517e353535d7b738c9ba2a7946b5c6590ad";

// Spotify web-player TOTP secret cipher (version 61). Transformed at runtime.
var TOTP_VER = 61;
var TOTP_CIPHER = [
	44,
	55,
	47,
	42,
	70,
	40,
	34,
	114,
	76,
	74,
	50,
	111,
	120,
	97,
	75,
	76,
	94,
	102,
	43,
	69,
	49,
	120,
	118,
	80,
	64,
	78
];

var TRANSCRIPT_TIMESTAMP_MOD = 5;
var cachedSpotifyToken = null;

function detectWeb(doc, url) {
	if (/\/episode\/[A-Za-z0-9]+/.test(url)) {
		return "podcast";
	}
	if (/\/show\/[A-Za-z0-9]+/.test(url)) {
		return "multiple";
	}
	return false;
}

function getSearchResults(doc, checkOnly) {
	var items = {};
	var found = false;
	var rows = doc.querySelectorAll('a[href*="/episode/"]');
	for (let row of rows) {
		let href = attr(row, "href");
		let title = ZU.trimInternal(row.textContent);
		if (!href || !title || isChromeText(title)) continue;
		href = canonicalSpotifyURL(href);
		if (!/\/episode\/[A-Za-z0-9]+/.test(href)) continue;
		if (checkOnly) return true;
		found = true;
		items[href] = title;
	}
	return found ? items : false;
}

async function doWeb(doc, url) {
	if (detectWeb(doc, url) == "multiple") {
		let results = getSearchResults(doc, false)
			|| await fetchShowEpisodes(canonicalSpotifyURL(url));
		if (!results) return;
		let items = await Zotero.selectItems(results);
		if (!items) return;
		for (let itemURL of Object.keys(items)) {
			await scrape(doc, itemURL);
		}
	}
	else {
		await scrape(doc, url);
	}
}

async function scrape(doc, url = doc.location.href) {
	url = canonicalSpotifyURL(url);
	let data = mergeEpisodeData(
		parseEpisodeFromDocument(doc, url),
		await fetchEpisodeFromPathfinder(url)
	);
	data = mergeEpisodeData(data, await fetchEpisodeFromEmbed(url));

	let item = new Zotero.Item("podcast");
	item.title = ZU.trimInternal(data.title || "");
	item.url = url;
	item.seriesTitle = data.seriesTitle || "";
	item.abstractNote = cleanDescription(data.description, data.seriesTitle);
	item.date = normalizeDate(data.date);
	item.runningTime = data.runningTime || "";
	item.audioFileType = "Audio";

	if (item.seriesTitle) {
		item.creators.push({
			lastName: item.seriesTitle,
			creatorType: "podcaster",
			fieldMode: 1
		});
	}

	// Prefer a snapshot of the episode page itself; for multi-save the passed
	// document is the show listing.
	if (doc.location && canonicalSpotifyURL(String(doc.location.href)) === url) {
		item.attachments.push({ title: "Snapshot", document: doc });
	}
	else {
		item.attachments.push({
			title: "Snapshot",
			url: url,
			mimeType: "text/html"
		});
	}

	// "Read along" transcripts: needs a logged-in Spotify session (sp_dc →
	// non-anonymous /api/token). Anonymous tokens always 401; episodes without
	// a transcript tab return empty/error. Either way we skip quietly.
	let transcriptHTML = await fetchTranscriptHTML(url, item.title);
	if (transcriptHTML) {
		item.attachments.push({
			title: "Transcript",
			mimeType: "text/html",
			document: new DOMParser().parseFromString(transcriptHTML, "text/html")
		});
	}

	item.complete();
}

function canonicalSpotifyURL(url) {
	try {
		let parsed = new URL(url, "https://open.spotify.com");
		let match = parsed.pathname.match(/^\/(show|episode)\/([A-Za-z0-9]+)/);
		if (match) {
			return "https://open.spotify.com/" + match[1] + "/" + match[2];
		}
	}
	catch (e) {}
	return url.replace(/[?#].*$/, "");
}

function spotifyID(url, kind) {
	let match = url.match(new RegExp("\\/" + kind + "\\/([A-Za-z0-9]+)"));
	return match ? match[1] : null;
}

function mergeEpisodeData(primary, secondary) {
	let out = Object.assign({}, primary);
	for (let key of Object.keys(secondary || {})) {
		if (!out[key] && secondary[key]) out[key] = secondary[key];
	}
	return out;
}

function normalizeDate(value) {
	if (!value) return "";
	let iso = ZU.strToISO(String(value));
	if (iso) return iso;
	let match = String(value).match(/(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : "";
}

function isChromeText(value) {
	return /^(your library|home|search|premium|spotify|play|follow|share|more)$/i.test(
		ZU.trimInternal(value || "")
	);
}

function parseEpisodeFromDocument(doc, url) {
	let data = {
		title: "",
		seriesTitle: "",
		description: "",
		date: "",
		runningTime: ""
	};

	let ld = parseEpisodeJSONLD(doc, url);
	if (ld) {
		data.title = ld.name || data.title;
		data.description = ld.description || data.description;
		data.date = ld.datePublished || data.date;
	}

	let ogTitle = attr(doc, 'meta[property="og:title"]', "content");
	let ogURL = attr(doc, 'meta[property="og:url"]', "content");
	if (ogTitle && (!ogURL || /\/episode\//.test(ogURL))) {
		data.title = data.title || ogTitle;
	}

	data.description = data.description
		|| attr(doc, 'meta[name="description"]', "content");
	data.date = data.date
		|| attr(doc, 'meta[name="music:release_date"]', "content");

	let durationMeta = attr(doc, 'meta[name="music:duration"]', "content");
	if (durationMeta) {
		data.runningTime = formatDuration(Number(durationMeta) * 1000);
	}

	for (let showLink of doc.querySelectorAll('a[href*="/show/"]')) {
		let series = ZU.trimInternal(showLink.textContent);
		if (series && !isChromeText(series)) {
			data.seriesTitle = series;
			break;
		}
	}
	if (!data.seriesTitle) {
		let ogDesc = attr(doc, 'meta[property="og:description"]', "content");
		let seriesMatch = ogDesc && ogDesc.match(/^(.+?)\s*·\s*Episode/i);
		if (seriesMatch) {
			data.seriesTitle = ZU.trimInternal(seriesMatch[1]);
		}
	}

	if (data.title && isChromeText(data.title)) {
		data.title = "";
	}
	return data;
}

function parseEpisodeJSONLD(doc, url) {
	let episodeID = spotifyID(url, "episode");
	for (let script of doc.querySelectorAll('script[type="application/ld+json"]')) {
		try {
			let parsed = JSON.parse(script.textContent);
			let nodes = Array.isArray(parsed) ? parsed : [parsed];
			for (let node of nodes) {
				if (!node || typeof node !== "object" || !node.name) continue;
				let nodeURL = String(node.url || node["@id"] || "");
				if ((episodeID && nodeURL.includes(episodeID))
						|| (/\/episode\//.test(nodeURL) && node.datePublished)) {
					return node;
				}
			}
		}
		catch (e) {}
	}
	return null;
}

async function getAccessToken(url) {
	if (cachedSpotifyToken) return cachedSpotifyToken;

	// Prefer /api/token so Connector cookies (sp_dc) yield a logged-in token
	// when the user is signed into Spotify. Needed for transcripts.
	try {
		let otp = await generateSpotifyTOTP();
		if (otp) {
			let tokenURL = "https://open.spotify.com/api/token"
				+ "?reason=init&productType=web-player"
				+ "&totp=" + otp
				+ "&totpServer=" + otp
				+ "&totpVer=" + TOTP_VER;
			let json = await requestJSON(tokenURL);
			if (json && json.accessToken) {
				cachedSpotifyToken = json.accessToken;
				return cachedSpotifyToken;
			}
		}
	}
	catch (e) {}

	// Fallback: anonymous token from embed __NEXT_DATA__.
	let episodeID = spotifyID(url || "", "episode");
	let showID = spotifyID(url || "", "show");
	let embedURL = episodeID
		? "https://open.spotify.com/embed/episode/" + episodeID
		: showID
			? "https://open.spotify.com/embed/show/" + showID
			: null;
	if (!embedURL) return null;
	try {
		let html = await requestText(embedURL);
		let match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
		if (!match) return null;
		let next = JSON.parse(match[1]);
		cachedSpotifyToken = next.props.pageProps.state.settings.session.accessToken || null;
		return cachedSpotifyToken;
	}
	catch (e) {
		return null;
	}
}

async function generateSpotifyTOTP() {
	if (!globalThis.crypto || !crypto.subtle) return null;
	let transformed = TOTP_CIPHER.map((e, t) => e ^ ((t % 33) + 9));
	let joined = transformed.join("");
	let hex = Array.from(new TextEncoder().encode(joined),
		b => b.toString(16).padStart(2, "0")).join("");
	let secretBytes = new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
	let secretB32 = base32Encode(secretBytes);
	let keyBytes = base32Decode(secretB32);
	let key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"]
	);
	let counter = Math.floor(Date.now() / 1000 / 30);
	let buf = new ArrayBuffer(8);
	new DataView(buf).setUint32(4, counter);
	let sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
	let offset = sig[sig.length - 1] & 0xf;
	let code = ((sig[offset] & 0x7f) << 24
		| sig[offset + 1] << 16
		| sig[offset + 2] << 8
		| sig[offset + 3]) % 1e6;
	return String(code).padStart(6, "0");
}

function base32Encode(bytes) {
	let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let output = "";
	for (let b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			output += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		output += alphabet[(value << (5 - bits)) & 31];
	}
	return output;
}

function base32Decode(str) {
	let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let out = [];
	for (let c of str.replace(/=+$/, "").toUpperCase()) {
		let idx = alphabet.indexOf(c);
		if (idx < 0) continue;
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

async function pathfinderQuery(operationName, sha256Hash, variables, url) {
	let token = await getAccessToken(url);
	if (!token) return null;
	try {
		return await requestJSON("https://api-partner.spotify.com/pathfinder/v2/query", {
			method: "POST",
			headers: {
				authorization: "Bearer " + token,
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify({
				variables: variables,
				operationName: operationName,
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: sha256Hash
					}
				}
			})
		});
	}
	catch (e) {
		return null;
	}
}

async function fetchEpisodeFromPathfinder(url) {
	let episodeID = spotifyID(url, "episode");
	if (!episodeID) return {};
	let json = await pathfinderQuery("episodeOrChapter", EPISODE_QUERY_HASH, {
		uri: "spotify:episode:" + episodeID
	}, url);
	let ep = json && json.data && json.data.episodeUnionV2;
	if (!ep || ep.__typename !== "Episode") return {};

	let show = ep.showOrAudiobook
		&& ep.showOrAudiobook.data
		&& ep.showOrAudiobook.data.__typename === "Podcast"
		&& ep.showOrAudiobook.data;

	return {
		title: ep.name || "",
		seriesTitle: (show && show.name)
			|| (show && show.publisher && show.publisher.name)
			|| "",
		description: ep.description || "",
		date: ep.releaseDate && ep.releaseDate.isoString,
		runningTime: formatDuration(
			ep.duration && ep.duration.totalMilliseconds
		)
	};
}

async function fetchEpisodeFromEmbed(url) {
	let episodeID = spotifyID(url, "episode");
	if (!episodeID) return {};
	let html;
	try {
		html = await requestText("https://open.spotify.com/embed/episode/" + episodeID);
	}
	catch (e) {
		return {};
	}
	let nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
	if (!nextMatch) return {};
	try {
		let next = JSON.parse(nextMatch[1]);
		let entity = next.props
			&& next.props.pageProps
			&& next.props.pageProps.state
			&& next.props.pageProps.state.data
			&& next.props.pageProps.state.data.entity;
		if (!entity || entity.type !== "episode") return {};
		let date = entity.releaseDate && entity.releaseDate.isoString;
		return {
			title: entity.name || entity.title || "",
			seriesTitle: entity.subtitle || "",
			date: date ? String(date).slice(0, 10) : "",
			runningTime: formatDuration(entity.duration)
		};
	}
	catch (e) {
		return {};
	}
}

async function fetchShowEpisodes(url) {
	let showID = spotifyID(url, "show");
	if (!showID) return false;

	let fromAPI = await fetchShowEpisodesFromPathfinder(showID);
	if (fromAPI) return fromAPI;

	let html;
	try {
		html = await requestText(url);
	}
	catch (e) {
		return false;
	}
	let items = {};
	let found = false;
	let re = /href="(\/episode\/[A-Za-z0-9]+)"[^>]*>([^<]{3,200})</gi;
	let match;
	while ((match = re.exec(html))) {
		let href = canonicalSpotifyURL(match[1]);
		let title = ZU.trimInternal(ZU.unescapeHTML(match[2]));
		if (!title || isChromeText(title)) continue;
		found = true;
		items[href] = title;
	}
	return found ? items : false;
}

async function fetchShowEpisodesFromPathfinder(showID) {
	let json = await pathfinderQuery("showOrAudiobook", SHOW_QUERY_HASH, {
		uri: "spotify:show:" + showID,
		offset: 0,
		limit: 50
	}, "https://open.spotify.com/show/" + showID);
	let pages = json && json.data && json.data.podcastUnionV2 && json.data.podcastUnionV2.pages;
	let list = pages && pages.items;
	if (!Array.isArray(list) || !list.length) return false;

	let items = {};
	let found = false;
	for (let row of list) {
		let ep = row && row.entity && row.entity.data;
		if (!ep || ep.__typename !== "Episode" || !ep.id || !ep.name) continue;
		found = true;
		items["https://open.spotify.com/episode/" + ep.id] = ZU.trimInternal(ep.name);
	}
	return found ? items : false;
}

async function fetchTranscriptHTML(url, title) {
	let episodeID = spotifyID(url, "episode");
	if (!episodeID) return null;
	let token = await getAccessToken(url);
	if (!token) return null;

	let json;
	try {
		json = await requestJSON(
			"https://spclient.wg.spotify.com/transcript-read-along/v2/episode/"
				+ episodeID
				+ "?format=json&maxSentenceLength=500&excludeCC=true",
			{
				headers: {
					authorization: "Bearer " + token,
					accept: "application/json",
					"app-platform": "WebPlayer",
					Referer: "https://open.spotify.com/"
				}
			}
		);
	}
	catch (e) {
		return null;
	}

	let lines = parseTranscriptLines(json);
	if (!lines.length) return null;
	return formatTranscriptHtml(lines, url, title || "Spotify Transcript");
}

function parseTranscriptLines(body) {
	if (!body || typeof body !== "object") return [];
	let cues = body.section;
	if (!Array.isArray(cues)) {
		for (let key of ["segments", "timedText", "lines", "cues"]) {
			if (Array.isArray(body[key])) {
				cues = body[key];
				break;
			}
		}
	}
	if (!Array.isArray(cues)) return [];

	let lines = [];
	for (let cue of cues) {
		if (!cue || typeof cue !== "object") continue;
		let line = cueToLine(cue);
		if (line) lines.push(line);
	}
	return lines;
}

function cueToLine(cue) {
	for (let wrapperKey of ["text", "fallback"]) {
		let wrapper = cue[wrapperKey];
		if (!wrapper || typeof wrapper !== "object") continue;
		let sentence = wrapper.sentence;
		if (!sentence || typeof sentence !== "object") continue;
		let text = sentence.text;
		if (typeof text !== "string" || !text.trim()) continue;
		let start = Number(
			sentence.startMs !== undefined && sentence.startMs !== null
				? sentence.startMs
				: cue.startMs
		) || 0;
		return { offset: start, text: text.trim() };
	}
	return null;
}

function formatTranscriptHtml(lines, url, title) {
	if (!lines || !lines.length) return "";
	let safeTitle = escapeHtml(ZU.trimInternal(title) || "Spotify Transcript");
	let today = new Date().toISOString().slice(0, 10);
	let sourceHref = escapeHtml(url || "");
	let mod = TRANSCRIPT_TIMESTAMP_MOD;

	let bodyRows = lines.map((line, index) => {
		let showTimestamp = index % mod === 0;
		let timestamp = formatTimestampMs(line.offset);
		let seconds = Math.max(0, Math.floor(line.offset / 1000));
		let href = url
			? escapeHtml(url + (url.includes("?") ? "&" : "?") + "t=" + seconds)
			: "#";
		let text = escapeHtml(line.text);
		let anchor = "sp-l-" + Math.max(0, Math.floor(line.offset));
		let tsCell = showTimestamp
			? `<td class="ts"><a href="${href}" data-time="${escapeHtml(timestamp)}" aria-label="${escapeHtml(timestamp)}"></a></td>`
			: `<td class="ts"></td>`;
		return `    <tr>
	  ${tsCell}
	  <td class="text" id="${anchor}">${text}</td>
	</tr>`;
	}).join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
  :root {
	color-scheme: light dark;
  }
  body {
	font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
	line-height: 1.55;
	max-width: 48rem;
	margin: 0 auto;
	padding: 1.5rem 1.25rem 3rem;
  }
  h1 {
	font-size: 1.35rem;
	margin: 0 0 0.75rem;
	line-height: 1.3;
  }
  .meta {
	color: CanvasText;
	opacity: 0.7;
	font-size: 0.9rem;
	margin-bottom: 1.5rem;
  }
  .meta a {
	color: inherit;
  }
  table.transcript {
	width: 100%;
	border-collapse: collapse;
  }
  table.transcript td {
	vertical-align: top;
	padding: 0.35rem 0;
  }
  table.transcript td.ts {
	width: 1%;
	white-space: nowrap;
	padding-right: 0.85rem;
	user-select: none;
	-moz-user-select: none;
	-webkit-user-select: none;
  }
  table.transcript td.ts a {
	font-variant-numeric: tabular-nums;
	text-decoration: none;
	font-weight: 600;
	font-size: 0.9rem;
  }
  table.transcript td.ts a::before {
	content: attr(data-time);
  }
  table.transcript td.ts a:hover {
	text-decoration: underline;
  }
  table.transcript td.text {
	width: 99%;
  }
</style>
</head>
<body>
<article>
  <h1>${safeTitle}</h1>
  <p class="meta">
	Source: ${url ? `<a href="${sourceHref}">${sourceHref}</a>` : "Unknown"}
	· Retrieved: ${escapeHtml(today)}
  </p>
  <table class="transcript">
	<tbody>
${bodyRows}
	</tbody>
  </table>
</article>
</body>
</html>
`;
}

function formatTimestampMs(ms) {
	if (!ms || ms < 0 || !isFinite(ms)) return "00:00";
	let totalSeconds = Math.floor(ms / 1000);
	let hours = Math.floor(totalSeconds / 3600);
	let minutes = Math.floor((totalSeconds % 3600) / 60);
	let seconds = totalSeconds % 60;
	let pad = n => String(n).padStart(2, "0");
	if (hours > 0) {
		return hours + ":" + pad(minutes) + ":" + pad(seconds);
	}
	return pad(minutes) + ":" + pad(seconds);
}

function escapeHtml(text) {
	return String(text || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function cleanDescription(description, seriesTitle) {
	if (!description) return "";
	let cleaned = ZU.trimInternal(description);
	cleaned = cleaned.replace(
		/^Listen to this episode from .+? on Spotify\.\s*/i,
		""
	);
	if (seriesTitle) {
		cleaned = cleaned.replace(
			new RegExp("^" + ZU.quotemeta(seriesTitle) + "\\s*[·•-]\\s*Episode\\s*", "i"),
			""
		);
	}
	return cleaned;
}

function formatDuration(ms) {
	if (!ms || !isFinite(ms) || ms < 0) return "";
	let totalSeconds = Math.round(ms / 1000);
	let hours = Math.floor(totalSeconds / 3600);
	let minutes = Math.floor((totalSeconds % 3600) / 60);
	let seconds = totalSeconds % 60;
	if (hours > 0) {
		return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
	}
	return minutes + ":" + String(seconds).padStart(2, "0");
}

/** BEGIN TEST CASES **/
var testCases = [
	{
		"type": "web",
		"url": "https://open.spotify.com/episode/5EIk9DNoblPfTIEdlpnqgF",
		"items": [
			{
				"itemType": "podcast",
				"title": "The Importance of Dramaturgy and Pedagogy in the Theatre with Dr. Susanne Shawyer",
				"creators": [
					{
						"lastName": "The Systemic Stage",
						"creatorType": "podcaster",
						"fieldMode": 1
					}
				],
				"date": "2021-05-10",
				"abstractNote": "Join us for this week’s episode of the systemic stage where we discuss dramaturgy and pedagogy in the theater with another former professor of ours, Dr. Susanne Shawyer. Hear all about her theater for social change class, the importance of dramaturgy in the theatre, and how we can be more progressive in our rehearsal and educational spaces. Check out more information on Dr. Shawyer here: https://howlround.com/commons/susanne-shawyer And here: https://www.elon.edu/u/news/2019/01/25/shawyer-publishes-in-theatre-topics-and-theatre-journal Check out theatrical intimacy education here: https://www.theatricalintimacyed.com/ Learn more about Elon’s Dramaturgy program here: https://elondramaturgy.wordpress.com/author/edramaturg/ Plays mentioned in this episode : Moment by Deirdre Kinahan Indecent by Paula Vogel Detroit ‘67 by Dominique Morisseau Oil by Ella Hickson Books mentioned in this episode : Theatre for Community Conflict and Dialogue by Michael Rohd Theatre of Good Intentions by Dani Snyder - Young",
				"audioFileType": "Audio",
				"runningTime": "53:56",
				"seriesTitle": "The Systemic Stage",
				"url": "https://open.spotify.com/episode/5EIk9DNoblPfTIEdlpnqgF",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://open.spotify.com/episode/6P9Sbi8yVsxC9pVdJO29AN",
		"items": [
			{
				"itemType": "podcast",
				"title": "On Politics: What happened to the intellectual?",
				"creators": [
					{
						"lastName": "The LRB Podcast",
						"creatorType": "podcaster",
						"fieldMode": 1
					}
				],
				"date": "2026-09-23",
				"abstractNote": "William Davies joins James to consider what distinguishes intellectuals from the technocrats, academics, experts, polemicists, thought leaders, gurus and utopians who compete for our attention, and to ask whether there’s still a role for them in the public realm. They look back to Weber's and Gramsci’s ideas about the autonomy and responsibility of the intellectual and discuss the ways in which Hayek’s anti-intellectualism has shaped discourse up to the present day. Where do politicians look for ideas and does the modern marketplace of algorithmic video platforms pose a challenge to independent thought? From the LRB Subscribe to the LRB: ⁠⁠https://lrb.me/subslrbpod Close Readings podcast: ⁠https://lrb.me/crlrbpod⁠ LRB Audiobooks: ⁠https://lrb.me/audiobookslrbpod⁠ Bags, binders and more at the LRB Store: ⁠https://lrb.me/storelrbpod⁠ Get in touch: podcasts@lrb.co.uk Learn more about your ad choices. Visit megaphone.fm/adchoices",
				"audioFileType": "Audio",
				"runningTime": "1:05:16",
				"seriesTitle": "The LRB Podcast",
				"shortTitle": "On Politics",
				"url": "https://open.spotify.com/episode/6P9Sbi8yVsxC9pVdJO29AN",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://open.spotify.com/show/6X85hfZdjfejD0KTCjqi4L",
		"items": "multiple"
	}
]
/** END TEST CASES **/
