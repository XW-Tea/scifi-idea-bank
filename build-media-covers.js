#!/usr/bin/env node
/**
 * Sci-Fi Idea Bank — cover pipeline for anime/manga, games and
 * Chinese-language novels (工程3, pilot extension of build-covers.js).
 *
 *   node build-media-covers.js                # every work in data.json with a `medium` field
 *   node build-media-covers.js --only "akira"  # spot-debug a single title
 *   node build-media-covers.js --refresh       # ignore caches
 *
 * SCOPE. build-covers.js owns the 573 book covers (English-language prose,
 * matched against Open Library). This script is separate and additive: it
 * only looks at data.json rows that carry a `medium` field ("manga", "anime",
 * "game", "novel" for the non-English novels) and merges its results into
 * the SAME covers.json, without touching the existing entries or caches.
 *
 * JOIN KEY — identical to build-covers.js, reused from it directly so the two
 * scripts can never drift apart: key = slug(novel) + "--" + slug(author).
 *
 * SOURCES (all keyless):
 *   manga/anime -> AniList GraphQL   https://graphql.anilist.co
 *   game        -> Steam storefront  store.steampowered.com/api/{storesearch,appdetails}
 *   novel       -> Open Library      (same catalogue build-covers.js uses)
 *
 * MATCHING IS UNRELIABLE. A single top search hit is not trustworthy — see
 * README notes on AniList "Deus Ex" -> a Chinese anime, Steam "Death
 * Stranding" -> the sequel, Steam "Deus Ex" -> Mankind Divided, Wikidata
 * "Ghost in the Shell" -> the 2017 live-action film. So: fetch several
 * candidates, then ask a LOCAL LLM (Ollama, qwen2.5:14b) to confirm which
 * one — if any — is genuinely the same work, given title, native title,
 * creator and year. "none" is an allowed and PREFERRED answer. After the LLM
 * picks, a deterministic year gate still applies: a candidate whose release
 * year is far from the work's year is rejected unless the native title
 * matches exactly. A wrong cover is much worse than no cover.
 *
 * Every stage is cached under covers/.cache/media-* so reruns are cheap and
 * resumable, exactly like build-covers.js. Writes covers-media-report.json.
 */

const fs = require('fs');
const path = require('path');
const bc = require('./build-covers.js'); // reuse the join key + OL guard logic verbatim

// ------------------------------------------------------------------ settings
const ROOT = __dirname;
const COVERS_DIR = path.join(ROOT, 'covers');
const PHOTO_DIR = path.join(COVERS_DIR, 'photo');
const CACHE_DIR = path.join(COVERS_DIR, '.cache');
const SEARCH_CACHE = path.join(CACHE_DIR, 'media-search');
const VERIFY_CACHE = path.join(CACHE_DIR, 'media-verify');
const COVERS_JSON = path.join(ROOT, 'covers.json');
const REPORT_JSON = path.join(ROOT, 'covers-media-report.json');
const MANUAL_JSON = path.join(ROOT, 'covers-manual.json');

/** Works whose cover a human chose by hand; see covers-manual.js. */
const MANUAL_KEYS = new Set(Object.keys(
  (() => { try { return JSON.parse(fs.readFileSync(MANUAL_JSON, 'utf8')); } catch { return {}; } })()
));

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:14b';
const FALLBACK_MODEL = 'qwen3:8b';
const LLM_TIMEOUT_MS = 120000;
const LLM_SLOTS = 2;

const USER_AGENT = 'scifi-idea-bank-cover-builder/1.0' +
  (process.env.COVER_CONTACT ? ` (${process.env.COVER_CONTACT})` : '');

// Polite, per-domain rate limits. AniList and Steam are both keyless public
// endpoints that will 429 an impatient client.
const RATE_MS = { anilist: 700, steam: 1200, openlibrary: 1050, img: 400 };
const HTTP_TIMEOUT_MS = 30000;
const WORKERS = 2;

// Year gate for AniList/Steam candidates (Open Library reuses build-covers's
// own ambiguity/guard logic, which already has an equivalent gate baked in).
const YEAR_GATE = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  for (const d of [COVERS_DIR, PHOTO_DIR, CACHE_DIR, SEARCH_CACHE, VERIFY_CACHE]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// ------------------------------------------------------------ concurrency
function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}
function makeRateLimiter(intervalMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = run.then(() => {}, () => {});
    return run;
  };
}
const llmSlot = makeSemaphore(LLM_SLOTS);
const limiters = {
  anilist: makeRateLimiter(RATE_MS.anilist),
  steam: makeRateLimiter(RATE_MS.steam),
  openlibrary: makeRateLimiter(RATE_MS.openlibrary),
  img: makeRateLimiter(RATE_MS.img),
};

// ---------------------------------------------------------------- HTTP core
async function fetchRaw(url, { headers = {}, timeout = HTTP_TIMEOUT_MS, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { method, body, headers: { 'User-Agent': USER_AGENT, ...headers }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Retries with backoff, rate-limited per domain. */
async function fetchWithRetry(url, { limiter, binary = false, ...opts } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1200 * Math.pow(2, attempt - 1));
    try {
      const res = await limiter(() => fetchRaw(url, opts));
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      if (res.status === 404) return { notFound: true, status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary
        ? { buffer: Buffer.from(await res.arrayBuffer()), status: res.status }
        : { json: await res.json(), status: res.status };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('request failed');
}

// ---------------------------------------------------------------- LLM client
const llmStats = { calls: 0, ms: 0, errors: 0, fallbacks: 0 };

async function ollamaJSON(prompt, { model, temperature = 0, numPredict = 300 }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt, format: 'json', stream: false, think: false,
        options: { temperature, num_predict: numPredict },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const body = await res.json();
    const text = String(body.response || '').trim();
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object in response');
    return JSON.parse(cleaned.slice(start, end + 1));
  } finally {
    clearTimeout(timer);
    llmStats.ms += Date.now() - started;
    llmStats.calls++;
  }
}
async function askLLM(label, prompt, opts = {}) {
  return llmSlot(async () => {
    const models = [opts.model || CFG.model, FALLBACK_MODEL];
    let lastErr;
    for (let mi = 0; mi < models.length; mi++) {
      const attempts = mi === 0 ? 3 : 1;
      for (let a = 0; a < attempts; a++) {
        try {
          const out = await ollamaJSON(prompt, { ...opts, model: models[mi] });
          if (mi > 0) llmStats.fallbacks++;
          return out;
        } catch (e) {
          lastErr = e; llmStats.errors++;
          if (a < attempts - 1) await sleep(1500 * (a + 1));
        }
      }
    }
    throw new Error(`LLM failed (${label}): ${lastErr && lastErr.message}`);
  });
}

/** Minimal JPEG SOF parser — enough to sanity-check dimensions. Same as build-covers.js. */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** PNG stores its size in the IHDR chunk at a fixed offset. */
function pngSize(buf) {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** WebP: the three stream flavours each encode the size differently. */
function webpSize(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (fourcc === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    const rd24 = (o) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
    return { w: rd24(24) + 1, h: rd24(27) + 1 };
  }
  return null;
}

/**
 * Identify by magic bytes, not by the URL's extension. AniList serves some
 * covers as PNG from paths that look like images generally — a JPEG-only check
 * here silently threw away a correct, verified match for Dennou Coil. Whatever
 * the bytes turn out to be decides the extension we write, because
 * `covers.json.file` is the path the page actually loads.
 */
function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', size: jpegSize(buf) };
  if (buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', size: pngSize(buf) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', size: webpSize(buf) };
  }
  return null;
}

/** Takes a path WITHOUT extension; returns the path it actually wrote. */
async function downloadImage(url, destBase) {
  for (const ext of ['jpg', 'png', 'webp']) {
    const p = `${destBase}.${ext}`;
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) {
      const buf = fs.readFileSync(p);
      const s = sniffImage(buf);
      return { bytes: buf.length, size: s && s.size, ext, file: p, cached: true };
    }
  }
  const r = await fetchWithRetry(url, { limiter: limiters.img, binary: true });
  if (r.notFound) throw new Error('image 404');
  const buf = r.buffer;
  if (!buf || buf.length < 1000) throw new Error(`image too small (${buf ? buf.length : 0} bytes)`);
  const sniffed = sniffImage(buf);
  if (!sniffed) throw new Error('not a recognised image (jpg/png/webp)');
  const { ext, size } = sniffed;
  if (!size || size.w < 80 || size.h < 80) throw new Error(`dimensions too small (${size ? size.w + 'x' + size.h : 'unparseable'})`);
  const destFile = `${destBase}.${ext}`;
  fs.writeFileSync(destFile, buf);
  return { bytes: buf.length, size, ext, file: destFile, cached: false };
}

// ------------------------------------------------------------- work loading
/** Primary creator only, for prompts/gates — mirrors build-covers's heuristic
 * author-stripping but also handles the "A (manga); B (1995 film)" shape that
 * shows up in these rows. The RAW author string is still what lands in the
 * manifest, unmodified. */
function primaryCreator(author) {
  let a = String(author || '').split(';')[0];
  a = a.replace(/\((?:w\/|with)[^)]*\)/gi, '').replace(/\([^)]*\)\s*$/, '').trim();
  return a || String(author || '');
}

function loadMediaWorks() {
  const d = readJSON(path.join(ROOT, 'data.json'));
  if (!d || !Array.isArray(d.items)) throw new Error('data.json missing or malformed');
  const rows = d.items.filter((it) => it.medium);
  const byKey = new Map();
  for (const r of rows) {
    const key = bc.workKey(r.novel, r.author);
    let w = byKey.get(key);
    if (!w) {
      w = {
        key, novel: r.novel, author: r.author, year: r.year,
        medium: String(r.medium || '').toLowerCase(),
        titleNative: r.titleNative || '', count: 0,
      };
      byKey.set(key, w);
    }
    w.count++;
    if (w.year == null || (r.year != null && r.year < w.year)) w.year = r.year;
  }
  return [...byKey.values()].sort((a, b) => (a.year || 0) - (b.year || 0));
}

// ----------------------------------------------------------- AniList (manga/anime)
async function searchAniList(work) {
  const cacheFile = path.join(SEARCH_CACHE, `${work.key}.json`);
  if (!CFG.refresh) { const hit = readJSON(cacheFile); if (hit) return hit; }
  const type = work.medium === 'anime' ? 'ANIME' : 'MANGA';
  const query = `query ($s: String, $t: MediaType) { Page(perPage: 8) { media(search: $s, type: $t) { id title{romaji native english} startDate{year} coverImage{large extraLarge} format siteUrl } } }`;
  const terms = [...new Set([work.novel, work.titleNative].filter(Boolean))];
  const seen = new Map();
  let error = null;
  for (const term of terms) {
    try {
      const r = await fetchWithRetry('https://graphql.anilist.co', {
        limiter: limiters.anilist, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: { s: term, t: type } }),
      });
      const media = (r.json && r.json.data && r.json.data.Page && r.json.data.Page.media) || [];
      for (const m of media) if (!seen.has(m.id)) seen.set(m.id, m);
    } catch (e) { error = String(e.message); }
  }
  const out = { candidates: [...seen.values()].slice(0, 10), error };
  writeJSON(cacheFile, out);
  return out;
}
function anilistLabel(m) {
  return `title: ${JSON.stringify(m.title.romaji)} | native: ${JSON.stringify(m.title.native)} | english: ${JSON.stringify(m.title.english)} | year: ${m.startDate && m.startDate.year || 'unknown'} | format: ${m.format}`;
}

// -------------------------------------------------------------- Steam (game)
function parseSteamYear(dateStr) {
  const m = String(dateStr || '').match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}
async function searchSteam(work) {
  const cacheFile = path.join(SEARCH_CACHE, `${work.key}.json`);
  if (!CFG.refresh) { const hit = readJSON(cacheFile); if (hit) return hit; }
  let error = null;
  let items = [];
  try {
    const url = `https://store.steampowered.com/api/storesearch/?cc=us&l=en&term=${encodeURIComponent(work.novel)}`;
    const r = await fetchWithRetry(url, { limiter: limiters.steam });
    items = (r.json && r.json.items) || [];
  } catch (e) { error = String(e.message); }
  const candidates = [];
  for (const it of items.slice(0, 6)) {
    try {
      const durl = `https://store.steampowered.com/api/appdetails?appids=${it.id}&l=en`;
      const r = await fetchWithRetry(durl, { limiter: limiters.steam });
      const d = r.json && r.json[String(it.id)];
      if (!d || !d.success || !d.data) continue;
      const data = d.data;
      candidates.push({
        id: it.id,
        name: data.name,
        type: data.type,
        developers: data.developers || [],
        publishers: data.publishers || [],
        releaseDate: data.release_date && data.release_date.date,
        releaseYear: parseSteamYear(data.release_date && data.release_date.date),
        headerImage: data.header_image || null,
      });
    } catch (e) { error = error || String(e.message); }
  }
  const out = { candidates, error };
  writeJSON(cacheFile, out);
  return out;
}
function steamLabel(c) {
  return `name: ${JSON.stringify(c.name)} | type: ${c.type} | developer: ${JSON.stringify(c.developers.join(', '))} | release: ${c.releaseDate || 'unknown'} (${c.releaseYear || 'unknown'})`;
}

// --------------------------------------------------------- Open Library (novel)
const OL_FIELDS = 'key,title,author_name,cover_i,first_publish_year,edition_count';
function lastName(s) {
  const parts = bc.fold(s).trim().split(/\s+/);
  return parts[parts.length - 1] || '';
}
async function searchOpenLibraryNovel(work) {
  const cacheFile = path.join(SEARCH_CACHE, `${work.key}.json`);
  if (!CFG.refresh) { const hit = readJSON(cacheFile); if (hit) return hit; }
  const queries = [
    `https://openlibrary.org/search.json?title=${encodeURIComponent(work.novel)}` +
      `&author=${encodeURIComponent(primaryCreator(work.author))}&fields=${OL_FIELDS}&limit=15`,
    `https://openlibrary.org/search.json?q=${encodeURIComponent(work.novel + ' ' + primaryCreator(work.author))}` +
      `&fields=${OL_FIELDS}&limit=15`,
  ];
  // Original-script (e.g. Chinese) editions are frequently catalogued under
  // their native title with the author's name in the native script too, so an
  // English "title=...&author=..." query can miss the original edition
  // entirely (verified: OL has "三体" by 刘慈欣, cover 9157544, but a
  // title="The Three-Body Problem"&author="Liu Cixin" query returns neither —
  // it only surfaces the sequels). Querying the native title alone catches it.
  if (work.titleNative && work.titleNative !== work.novel) {
    queries.push(
      `https://openlibrary.org/search.json?title=${encodeURIComponent(work.titleNative)}` +
        `&fields=${OL_FIELDS}&limit=15`
    );
  }
  const seen = new Map();
  let error = null;
  for (const url of queries) {
    try {
      const r = await fetchWithRetry(url, { limiter: limiters.openlibrary });
      const docs = (r.json && r.json.docs) || [];
      for (const d of docs) { if (!d.cover_i) continue; if (!seen.has(d.key)) seen.set(d.key, d); }
    } catch (e) { error = String(e.message); }
    if (seen.size >= 6) break;
  }
  const wantTitle = bc.normTitle(work.novel);
  const wantAuthor = lastName(primaryCreator(work.author));
  const scored = [...seen.values()].map((d) => {
    const t = bc.normTitle(d.title);
    let score = 0;
    if (t === wantTitle) score += 100;
    else if (t.startsWith(wantTitle) || wantTitle.startsWith(t)) score += 45;
    else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 20;
    const authors = (d.author_name || []).map((a) => lastName(a));
    if (wantAuthor && authors.includes(wantAuthor)) score += 40;
    if (work.year && d.first_publish_year) {
      const diff = Math.abs(d.first_publish_year - work.year);
      if (diff <= 3) score += 15; else if (diff <= 15) score += 6;
    }
    score += Math.min(10, Math.log10((d.edition_count || 1) + 1) * 6);
    return { ...d, _score: Math.round(score) };
  });
  scored.sort((a, b) => b._score - a._score);
  const out = { candidates: scored.slice(0, 6), error };
  writeJSON(cacheFile, out);
  return out;
}
function olLabel(c) {
  return `title: ${JSON.stringify(c.title)} | author: ${JSON.stringify((c.author_name || []).join(', '))} | first published: ${c.first_publish_year || 'unknown'}`;
}

// ------------------------------------------------------------- LLM verify
function buildVerifyPrompt(work, labels, mediumLabel) {
  return `You are matching a creative work against catalogue search results for a "${mediumLabel}" cover-art pipeline. A WRONG cover is much worse than no cover, so answer "none" whenever you are not confident.

THE WORK WE WANT
  title (as recorded, usually English): ${JSON.stringify(work.novel)}
  native/original title: ${JSON.stringify(work.titleNative || 'unknown')}
  creator: ${JSON.stringify(primaryCreator(work.author))}
  approximate year: ${work.year == null ? 'unknown' : work.year}
  medium: ${mediumLabel}

CANDIDATES FROM THE CATALOGUE
${labels.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

Choose the ONE candidate that is genuinely the SAME WORK by the SAME creator/studio/developer.

Reject (answer 0) if:
- it is a sequel, prequel, remake, spin-off, other installment in the same series or franchise, OR
- it is a different, unrelated work that merely shares a title or a similar name, OR
- the creator/studio/developer differs, OR
- you are simply unsure.

Return ONLY this JSON object:
{"choice": <integer 0 for none, or the candidate number>, "confidence": "high" | "medium" | "low", "reason": "<max 15 words>"}`;
}

async function verifyCandidate(work, candidates, labels, mediumLabel) {
  const cacheFile = path.join(VERIFY_CACHE, `${work.key}.json`);
  if (!CFG.refresh) { const hit = readJSON(cacheFile); if (hit) return hit; }
  let out;
  try {
    const raw = await askLLM('verify', buildVerifyPrompt(work, labels, mediumLabel), { numPredict: 200 });
    let choice = Number(raw.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > candidates.length) choice = 0;
    const confidence = ['high', 'medium', 'low'].includes(String(raw.confidence).toLowerCase())
      ? String(raw.confidence).toLowerCase() : 'low';
    const accepted = choice > 0 && confidence !== 'low';
    out = {
      choice, confidence, accepted,
      reason: String(raw.reason || '').slice(0, 160),
      candidateIdx: choice > 0 ? choice - 1 : -1,
    };
  } catch (e) {
    out = { choice: 0, confidence: 'low', accepted: false, reason: 'llm error', _error: String(e.message), candidateIdx: -1 };
  }
  writeJSON(cacheFile, out);
  return out;
}

// -------------------------------------------------------- deterministic gates
/** AniList/Steam year gate: reject if release year is far from the work's
 * year, unless the candidate's native title matches the record's exactly. */
function yearGateReject(work, candidateYear, candidateNative) {
  if (!work.year || !candidateYear) return null; // nothing to compare against — let the LLM's call stand
  const diff = Math.abs(candidateYear - work.year);
  if (diff <= YEAR_GATE) return null;
  if (work.titleNative && candidateNative && String(candidateNative).trim() === String(work.titleNative).trim()) return null;
  return `year gate: candidate ${candidateYear} vs work ${work.year} (diff ${diff}, native titles didn't rescue it)`;
}

// ----------------------------------------------------------------- pipeline
const CFG = { model: DEFAULT_MODEL, refresh: false, only: null };
const RESULTS = [];
const FAILURES = [];
let done = 0;
function log(total, work, msg) {
  done++;
  const label = `${work.novel} — ${work.author}`.slice(0, 52).padEnd(52);
  console.log(`[${String(done).padStart(2)}/${total}] ${label} ${msg}`);
}

async function processWork(work, total) {
  const rec = { key: work.key, novel: work.novel, author: work.author, year: work.year, medium: work.medium };
  try {
    let search, candidates, labels, mediumLabel, buildEntry;

    if (work.medium === 'manga' || work.medium === 'anime') {
      mediumLabel = work.medium === 'anime' ? 'anime' : 'manga';
      search = await searchAniList(work);
      candidates = search.candidates;
      labels = candidates.map(anilistLabel);
      buildEntry = async (cand) => {
        const imgUrl = (cand.coverImage && (cand.coverImage.extraLarge || cand.coverImage.large)) || null;
        if (!imgUrl) throw new Error('candidate has no cover image');
        const dest = path.join(PHOTO_DIR, work.key);  // extension decided by the bytes
        const dl = await downloadImage(imgUrl, dest);
        return {
          entry: {
            type: 'photo',
            file: `covers/photo/${work.key}.${dl.ext}`,
            title: work.novel,
            author: work.author,
            width: dl.size ? dl.size.w : null,
            height: dl.size ? dl.size.h : null,
            matchedTitle: cand.title.romaji || cand.title.english || cand.title.native,
            matchedAuthor: work.author,
            matchedYear: (cand.startDate && cand.startDate.year) || null,
            source: 'anilist',
            anilistId: cand.id,
            sourceUrl: cand.siteUrl || `https://anilist.co/${work.medium === 'anime' ? 'anime' : 'manga'}/${cand.id}`,
            remoteUrl: imgUrl,
            attribution: `Cover image via AniList (media id ${cand.id}). Third-party artwork; rights held by the original publisher/studio.`,
          },
          bytes: dl.bytes,
        };
      };
    } else if (work.medium === 'game') {
      mediumLabel = 'video game';
      search = await searchSteam(work);
      candidates = search.candidates;
      labels = candidates.map(steamLabel);
      buildEntry = async (cand) => {
        const tallUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${cand.id}/library_600x900.jpg`;
        const dest = path.join(PHOTO_DIR, work.key);  // extension decided by the bytes
        let dl, remoteUrl;
        try {
          dl = await downloadImage(tallUrl, dest);
          remoteUrl = tallUrl;
        } catch (e) {
          if (!cand.headerImage) throw e;
          dl = await downloadImage(cand.headerImage, dest);
          remoteUrl = cand.headerImage;
        }
        return {
          entry: {
            type: 'photo',
            file: `covers/photo/${work.key}.${dl.ext}`,
            title: work.novel,
            author: work.author,
            width: dl.size ? dl.size.w : null,
            height: dl.size ? dl.size.h : null,
            matchedTitle: cand.name,
            matchedAuthor: cand.developers.join(', ') || work.author,
            matchedYear: cand.releaseYear,
            source: 'steam',
            steamAppId: cand.id,
            sourceUrl: `https://store.steampowered.com/app/${cand.id}/`,
            remoteUrl,
            attribution: `Cover art via Steam store page (app id ${cand.id}). Third-party artwork; rights held by the original publisher/developer.`,
          },
          bytes: dl.bytes,
        };
      };
    } else if (work.medium === 'novel') {
      mediumLabel = 'novel';
      search = await searchOpenLibraryNovel(work);
      candidates = search.candidates;
      labels = candidates.map(olLabel);
      buildEntry = async (cand) => {
        const dest = path.join(PHOTO_DIR, work.key);  // extension decided by the bytes
        const imgUrl = `https://covers.openlibrary.org/b/id/${cand.cover_i}-M.jpg?default=false`;
        const dl = await downloadImage(imgUrl, dest);
        return {
          entry: {
            type: 'photo',
            file: `covers/photo/${work.key}.${dl.ext}`,
            title: work.novel,
            author: work.author,
            width: dl.size ? dl.size.w : null,
            height: dl.size ? dl.size.h : null,
            matchedTitle: cand.title,
            matchedAuthor: (cand.author_name || []).join(', '),
            matchedYear: cand.first_publish_year || null,
            source: 'openlibrary',
            olWork: cand.key,
            olCoverId: cand.cover_i,
            sourceUrl: `https://openlibrary.org${cand.key}`,
            remoteUrl: `https://covers.openlibrary.org/b/id/${cand.cover_i}-M.jpg`,
            attribution: `Cover image via Open Library (cover id ${cand.cover_i}, ${cand.key}). Third-party artwork; rights held by the original publisher.`,
          },
          bytes: dl.bytes,
        };
      };
    } else {
      rec.status = 'unsupported-medium';
      RESULTS.push(rec);
      log(total, work, `unsupported medium "${work.medium}"`);
      return;
    }

    rec.candidates = candidates.length;
    if (search.error) rec.searchError = search.error;
    if (!candidates.length) {
      rec.status = 'no-candidate';
      RESULTS.push(rec);
      log(total, work, 'no candidate');
      return;
    }

    const verdict = await verifyCandidate(work, candidates, labels, mediumLabel);
    rec.verdict = { choice: verdict.choice, confidence: verdict.confidence, reason: verdict.reason };
    if (!verdict.accepted) {
      rec.status = verdict.choice > 0 ? 'rejected-lowconf' : 'rejected-none';
      RESULTS.push(rec);
      log(total, work, `LLM said none (${verdict.confidence}) — ${verdict.reason}`);
      return;
    }

    const cand = candidates[verdict.candidateIdx];

    // Deterministic post-LLM guards.
    if (work.medium === 'novel') {
      // Open Library often catalogues the original-language edition of a
      // translated novel under its native title with the author's name only
      // in that script (verified: OL work "三体" by 刘慈欣 lists French
      // translators alongside the Chinese author name, so build-covers's
      // Latin-token author guard sees no shared token and would wrongly
      // reject a genuinely correct match). An exact native-title match is
      // the same escape hatch the year gate uses, so it overrides the
      // author-token guard here too; short of that, reuse build-covers's
      // guard verbatim (title-ambiguity + author-token check) unchanged.
      const nativeMatch = work.titleNative &&
        String(cand.title || '').trim() === String(work.titleNative).trim();
      const yearGuard = yearGateReject(work, cand.first_publish_year, cand.title);
      if (yearGuard) {
        rec.status = 'rejected-guard';
        rec.guard = yearGuard;
        RESULTS.push(rec);
        log(total, work, `guard rejected — ${yearGuard}`);
        return;
      }
      if (!nativeMatch) {
        const norm = { title_clean: work.novel, author_clean: primaryCreator(work.author) };
        const guard = bc.guardMatch(work, norm, candidates, cand);
        if (guard) {
          rec.status = 'rejected-guard';
          rec.guard = guard;
          RESULTS.push(rec);
          log(total, work, `guard rejected — ${guard}`);
          return;
        }
      }
    } else {
      const candYear = work.medium === 'game' ? cand.releaseYear : (cand.startDate && cand.startDate.year);
      const candNative = work.medium === 'game' ? null : (cand.title && cand.title.native);
      const guard = yearGateReject(work, candYear, candNative);
      if (guard) {
        rec.status = 'rejected-guard';
        rec.guard = guard;
        RESULTS.push(rec);
        log(total, work, `guard rejected — ${guard}`);
        return;
      }
      if (work.medium === 'game' && cand.type && cand.type !== 'game') {
        rec.status = 'rejected-guard';
        rec.guard = `steam listing type is "${cand.type}", not "game"`;
        RESULTS.push(rec);
        log(total, work, `guard rejected — ${rec.guard}`);
        return;
      }
    }

    try {
      const { entry, bytes } = await buildEntry(cand);
      rec.status = 'photo';
      rec.entry = entry;
      rec.bytes = bytes;
      log(total, work, `PHOTO ${entry.matchedTitle} (${entry.matchedYear || '?'}) ${Math.round(bytes / 1024)}KB via ${entry.source}`);
    } catch (e) {
      rec.status = 'download-failed';
      rec.error = String(e.message);
      FAILURES.push({ key: work.key, stage: 'download', error: String(e.message) });
      log(total, work, `download failed: ${e.message}`);
    }
    RESULTS.push(rec);
  } catch (e) {
    rec.status = 'failed';
    rec.error = String(e.message);
    FAILURES.push({ key: work.key, stage: 'pipeline', error: String(e.message) });
    RESULTS.push(rec);
    log(total, work, `FAILED: ${e.message}`);
  }
}

// -------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
  CFG.refresh = argv.includes('--refresh');
  CFG.only = arg('only', null);
  CFG.model = arg('model', DEFAULT_MODEL);

  ensureDirs();

  let works = loadMediaWorks();
  if (CFG.only) {
    const q = CFG.only.toLowerCase();
    works = works.filter((w) => w.novel.toLowerCase().includes(q) || w.key.includes(bc.slug(q)));
  }

  const total = works.length;
  console.log('--- build-media-covers ---');
  console.log(`source     : data.json (rows with a "medium" field)`);
  console.log(`model      : ${CFG.model} (fallback ${FALLBACK_MODEL}) @ ${OLLAMA_URL}`);
  console.log(`works      : ${total}`);
  console.log('');

  const t0 = Date.now();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, total || 1) }, async () => {
      while (cursor < works.length) {
        const w = works[cursor++];
        await processWork(w, total);
      }
    })
  );
  const wall = Date.now() - t0;

  // ------------------------------------------------------- merge into covers.json
  const existing = readJSON(COVERS_JSON) || {};
  const existingCount = Object.keys(existing).length;
  const merged = { ...existing };
  let bytes = 0;
  for (const r of RESULTS) {
    if (r.status !== 'photo') continue;
    // A hand-picked cover outranks anything found here. Someone chose it
    // deliberately, usually because this pipeline got it wrong or had no
    // route at all — silently replacing it would undo their work.
    if (MANUAL_KEYS.has(r.key)) continue;
    merged[r.key] = r.entry;
    bytes += r.bytes || 0;
  }
  writeJSON(COVERS_JSON, merged);

  // Scoped orphan cleanup: only for keys THIS run targeted, never touch the
  // pre-existing 573 book entries or their image files — and never a
  // hand-added one, whose whole point is that this pipeline could not get it.
  // (It deleted the manual Fallout art once: the manifest entry survived but
  // the file went, so local mode showed nothing while the published site was
  // fine off remoteUrl — the most annoying kind of half-broken.)
  let orphans = 0;
  for (const w of works) {
    if (MANUAL_KEYS.has(w.key)) continue;
    const rec = RESULTS.find((r) => r.key === w.key);
    if (rec && rec.status === 'photo') continue;
    for (const ext of ['jpg', 'png', 'webp']) {
      const f = path.join(PHOTO_DIR, `${w.key}.${ext}`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); orphans++; }
    }
  }

  const counts = {
    worksProcessed: RESULTS.length,
    photoCovers: RESULTS.filter((r) => r.status === 'photo').length,
    rejectedNone: RESULTS.filter((r) => r.status === 'rejected-none').length,
    rejectedLowConfidence: RESULTS.filter((r) => r.status === 'rejected-lowconf').length,
    rejectedByGuard: RESULTS.filter((r) => r.status === 'rejected-guard').length,
    noCandidate: RESULTS.filter((r) => r.status === 'no-candidate').length,
    downloadFailed: RESULTS.filter((r) => r.status === 'download-failed').length,
    pipelineFailed: RESULTS.filter((r) => r.status === 'failed').length,
    unsupportedMedium: RESULTS.filter((r) => r.status === 'unsupported-medium').length,
  };
  const report = {
    generated: new Date().toISOString(),
    source: 'data.json (medium field)',
    model: CFG.model,
    joinKey: 'slug(novel) + "--" + slug(author) — identical to build-covers.js',
    counts,
    coveragePct: RESULTS.length ? +(100 * counts.photoCovers / RESULTS.length).toFixed(1) : 0,
    existingCoversBeforeMerge: existingCount,
    coversAfterMerge: Object.keys(merged).length,
    totalCoverBytes: bytes,
    wallClockMs: wall,
    llm: { ...llmStats, avgCallMs: llmStats.calls ? Math.round(llmStats.ms / llmStats.calls) : 0 },
    failures: FAILURES,
    works: RESULTS.map((r) => ({
      key: r.key, novel: r.novel, author: r.author, medium: r.medium, status: r.status,
      candidates: r.candidates || 0, verdict: r.verdict || null, guard: r.guard || null,
      match: r.entry ? { source: r.entry.source, matchedTitle: r.entry.matchedTitle, matchedYear: r.entry.matchedYear } : null,
      error: r.error || null,
    })),
  };
  writeJSON(REPORT_JSON, report);

  console.log('\n--- summary ---');
  console.table(counts);
  console.log(`covers.json      : ${existingCount} existing + ${counts.photoCovers} new = ${Object.keys(merged).length} entries${orphans ? ` (${orphans} stale media image(s) removed)` : ''}`);
  console.log(`coverage         : ${report.coveragePct}% of this run's works have a real cover`);
  console.log(`downloaded       : ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`wall clock       : ${(wall / 1000).toFixed(1)}s`);
  console.log(`llm calls        : ${llmStats.calls} (${(llmStats.ms / 1000).toFixed(1)}s total, avg ${report.llm.avgCallMs} ms, ${llmStats.errors} errors, ${llmStats.fallbacks} fallback-model)`);
  if (FAILURES.length) console.log(`failures         : ${FAILURES.length} (see covers-media-report.json)`);
  console.log('');
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}
