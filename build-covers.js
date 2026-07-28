#!/usr/bin/env node
/**
 * Sci-Fi Idea Bank — offline cover-image pipeline.
 *
 *   node build-covers.js                     # every work referenced by data.json
 *   node build-covers.js --all               # every work in the source CSV
 *   node build-covers.js --only "Dune"       # spot-debug a single title
 *   node build-covers.js --limit 20          # first N works (debugging)
 *   node build-covers.js --refresh           # ignore caches
 *
 * Re-running plainly is the way to "recheck rejects": every stage is cached on
 * disk (norm / search / verify / the JPEGs themselves), so a full re-run makes
 * no LLM calls and no catalogue requests — it only re-applies the deterministic
 * guard and downloads covers for works the guard now lets through.
 *
 * Stage 1  normalize each messy (novel, author, year) record with a LOCAL LLM
 *          (Ollama) -> clean title/author, short-story flag, search query.
 * Stage 2  search Open Library, then have the LOCAL LLM verify that a candidate
 *          really is the same work ("none" allowed and preferred when unsure).
 *          Accepted covers are downloaded to covers/photo/<key>.jpg.
 * Stage 4  write covers.json (work key -> manifest entry) + covers-report.json.
 *
 * Everything is cached under covers/.cache so reruns are cheap and resumable.
 * No network access happens at site runtime; all bytes land on disk here.
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ settings
const ROOT = __dirname;
const COVERS_DIR = path.join(ROOT, 'covers');
const PHOTO_DIR = path.join(COVERS_DIR, 'photo');
const CACHE_DIR = path.join(COVERS_DIR, '.cache');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:14b';
const FALLBACK_MODEL = 'qwen3:8b';

// Open Library asks that scripted clients identify themselves. Set
// COVER_CONTACT to your own email or project URL before a large run so they
// have someone to reach if this misbehaves.
const USER_AGENT = 'scifi-idea-bank-cover-builder/1.0' +
  (process.env.COVER_CONTACT ? ` (${process.env.COVER_CONTACT})` : '');

const OL_MIN_INTERVAL_MS = 1050; // be polite: ~1 request/second, globally
const OL_TIMEOUT_MS = 30000;
const LLM_TIMEOUT_MS = 120000;
const WORKERS = 3; // pipeline concurrency (Ollama calls are separately gated)
const LLM_SLOTS = 2; // max simultaneous Ollama requests

// Override with --in <path> or SCIFI_CSV. Default looks next to this script.
const DEFAULT_CSV = process.env.SCIFI_CSV ||
  path.join(__dirname, 'Sci-Fi Idea Bank.csv');

// ------------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  for (const d of [
    COVERS_DIR,
    PHOTO_DIR,
    CACHE_DIR,
    path.join(CACHE_DIR, 'norm'),
    path.join(CACHE_DIR, 'search'),
    path.join(CACHE_DIR, 'verify'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * Stable work key. THE JOIN KEY: derived from (novel, author) exactly the same
 * way on both sides, so data.json rows can be joined without touching data.json.
 *   key = slug(novel) + '--' + slug(author)
 */
function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}
function workKey(novel, author) {
  return `${slug(novel) || 'untitled'}--${slug(author) || 'unknown'}`;
}

/**
 * Diacritic folding for COMPARISON ONLY (never for the join key / filenames).
 *
 * NFKD alone is not enough: it decomposes "\u00e9" into "e" + combining acute, but
 * letters that carry the mark *inside* the glyph \u2014 \u0142 \u00f8 \u0111 \u00e6 \u00df \u2026 \u2014 have no
 * canonical decomposition and survive untouched. Catalogue records spell
 * authors properly ("Stanis\u0142aw Lem") while the source CSV does not
 * ("Stanislaw Lem"), so without this map the two never compare equal and a
 * perfectly good match is thrown away as an "author mismatch".
 */
const FOLD_MAP = {
  '\u0142': 'l', '\u00f8': 'o', '\u0111': 'd', '\u00f0': 'd', '\u00fe': 'th', '\u00e6': 'ae', '\u0153': 'oe',
  '\u00df': 'ss', '\u0127': 'h', '\u0131': 'i', '\u0140': 'l', '\u014b': 'n', '\u017f': 's', '\u0180': 'b',
  '\u023c': 'c', '\u0247': 'e', '\u0268': 'i', '\u0249': 'j', '\u0167': 't', '\u0289': 'u', '\u01b6': 'z',
};
function fold(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks left over from NFKD
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (c) => FOLD_MAP[c] || c);
}

function normTitle(s) {
  return fold(s)
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function lastName(s) {
  const parts = fold(s).trim().split(/\s+/);
  return parts[parts.length - 1] || '';
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// --------------------------------------------------------------- CSV parsing
/** RFC4180-ish parser (same behaviour as preprocess.js). */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const NA = new Set(['', 'n/a', 'na', 'none', 'unknown', '-', '?']);
function clean(v) {
  const s = (v == null ? '' : String(v)).trim().replace(/\s+/g, ' ');
  return NA.has(s.toLowerCase()) ? '' : s;
}
function parseYear(raw) {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/(1[0-9]{3}|20[0-9]{2})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (!Number.isFinite(y) || y < 1400 || y > 2100) return null;
  return y;
}

// ------------------------------------------------------------- work assembly
/**
 * Collect unique works. Each work carries the ideas (device + description)
 * belonging to it, which is what the future hover UI shows next to the cover.
 */
function worksFromRows(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r.novel) continue;
    const key = workKey(r.novel, r.author);
    let w = byKey.get(key);
    if (!w) {
      w = {
        key,
        novel: r.novel,
        author: r.author || 'Unknown',
        year: r.year,
        ideas: [],
        count: 0,
      };
      byKey.set(key, w);
    }
    w.count++;
    if (w.year == null || (r.year != null && r.year < w.year)) w.year = r.year;
    if (w.ideas.length < 8 && r.device) {
      w.ideas.push({ device: r.device, desc: r.desc || '' });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.year || 0) - (b.year || 0));
}

function loadFromDataJson() {
  const d = readJSON(path.join(ROOT, 'data.json'));
  if (!d || !Array.isArray(d.items)) throw new Error('data.json missing or malformed');
  return d.items.map((it) => ({
    novel: it.novel,
    author: it.author,
    year: it.year,
    device: it.device,
    desc: it.desc,
  }));
}

function loadFromCSV(csvPath) {
  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const headerIdx = rows.findIndex((r) => r.some((c) => clean(c) === 'Device Name'));
  if (headerIdx === -1) throw new Error('Could not locate CSV header row');
  const header = rows[headerIdx].map(clean);
  const col = (n) => header.indexOf(n);
  const I = {
    date: col('Date'), device: col('Device Name'), novel: col('Novel'),
    author: col('Author'), desc: col('Description'),
  };
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => clean(c) === '')) continue;
    const novel = clean(r[I.novel]);
    if (!novel) continue;
    out.push({
      novel,
      author: clean(r[I.author]) || 'Unknown',
      year: parseYear(r[I.date]),
      device: clean(r[I.device]),
      desc: clean(r[I.desc]),
    });
  }
  return out;
}

// ------------------------------------------------------------ concurrency it
function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(res, rej)
      .finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

/** Global serialised rate limiter for Open Library. */
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
const olLimit = makeRateLimiter(OL_MIN_INTERVAL_MS);

// ---------------------------------------------------------------- LLM client
const llmStats = { calls: 0, ms: 0, errors: 0, fallbacks: 0 };

async function ollamaJSON(prompt, { model, temperature = 0, numPredict = 400 }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        format: 'json',
        stream: false,
        think: false,
        options: { temperature, num_predict: numPredict },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const body = await res.json();
    const text = String(body.response || '').trim();
    // qwen3 may emit <think> blocks even with think:false — strip defensively.
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

/** Retries, then one attempt with the fallback model, then gives up. */
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
          lastErr = e;
          llmStats.errors++;
          if (a < attempts - 1) await sleep(1500 * (a + 1));
        }
      }
    }
    throw new Error(`LLM failed (${label}): ${lastErr && lastErr.message}`);
  });
}

// ------------------------------------------------------- stage 1: normalize
function heuristicNormalize(work) {
  // Primary author only: drop "(w/ X)", "and X", "& X", "with X".
  let author = work.author
    .replace(/\((?:w\/|with)[^)]*\)/gi, '')
    .split(/\s*(?:,|&| and | with |\/)\s*/i)[0]
    .replace(/\s+/g, ' ')
    .trim() || work.author;
  // Title: strip parenthetical translations/subtitles for the query.
  let title = work.novel.replace(/\s*\([^)]*\)\s*$/, '').trim() || work.novel;
  return {
    title_clean: title,
    author_clean: author,
    is_short_story: false,
    book_likelihood: 'medium',
    search_query: `${title} ${author}`,
    _source: 'heuristic',
  };
}

const NORM_PROMPT = (w) => `You are cleaning bibliographic records of science-fiction works so they can be looked up in a library catalogue.

RECORD
  title as written: ${JSON.stringify(w.novel)}
  author as written: ${JSON.stringify(w.author)}
  year associated with the record: ${w.year == null ? 'unknown' : w.year}

Return ONLY a JSON object with exactly these keys:
{
  "title_clean": string,        // the work's canonical title. Drop parenthetical translations or alternate titles, keep the best-known English or original title.
  "author_clean": string,       // the PRIMARY author only. Strip collaborator fragments like "(w/ X)", "and X", "& X", "with X".
  "is_short_story": boolean,    // true if this is a short story or novelette (often first published in a pulp magazine), false if it is a novel, book, film, TV series or other book-length work
  "book_likelihood": "high" | "medium" | "low",  // how likely it is that a standalone BOOK edition with a cover exists for this exact title
  "search_query": string        // a short library-catalogue query, normally "<title_clean> <author_clean>"
}

Rules:
- Do not invent a different work. If you do not recognise it, just clean up the strings you were given.
- Never output explanations, only the JSON object.`;

const ENUM_LIKELIHOOD = new Set(['high', 'medium', 'low']);

async function normalizeWork(work) {
  const cacheFile = path.join(CACHE_DIR, 'norm', `${work.key}.json`);
  if (!CFG.refresh) {
    const hit = readJSON(cacheFile);
    if (hit && hit.title_clean) return hit;
  }
  let out;
  try {
    const raw = await askLLM('normalize', NORM_PROMPT(work), { numPredict: 300 });
    const h = heuristicNormalize(work);
    out = {
      title_clean: typeof raw.title_clean === 'string' && raw.title_clean.trim()
        ? raw.title_clean.trim().slice(0, 200) : h.title_clean,
      author_clean: typeof raw.author_clean === 'string' && raw.author_clean.trim()
        ? raw.author_clean.trim().slice(0, 120) : h.author_clean,
      is_short_story: raw.is_short_story === true,
      book_likelihood: ENUM_LIKELIHOOD.has(String(raw.book_likelihood).toLowerCase())
        ? String(raw.book_likelihood).toLowerCase() : 'medium',
      search_query: typeof raw.search_query === 'string' && raw.search_query.trim()
        ? raw.search_query.trim().slice(0, 200) : h.search_query,
      _source: 'llm',
    };
  } catch (e) {
    out = { ...heuristicNormalize(work), _error: String(e.message) };
  }
  writeJSON(cacheFile, out);
  return out;
}

// --------------------------------------------------- stage 2: find a cover
async function fetchWithRetry(url, { headers = {}, timeout = OL_TIMEOUT_MS, binary = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1200 * Math.pow(2, attempt - 1));
    try {
      const res = await olLimit(async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
          return await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, ...headers },
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (res.status === 404) return { notFound: true, status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary
        ? { buffer: Buffer.from(await res.arrayBuffer()), status: res.status }
        : { json: await res.json(), status: res.status };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('request failed');
}

const OL_FIELDS = 'key,title,author_name,cover_i,first_publish_year,edition_count';

async function searchOpenLibrary(work, norm) {
  const cacheFile = path.join(CACHE_DIR, 'search', `${work.key}.json`);
  if (!CFG.refresh) {
    const hit = readJSON(cacheFile);
    if (hit) return hit;
  }
  const queries = [
    `https://openlibrary.org/search.json?title=${encodeURIComponent(norm.title_clean)}` +
      `&author=${encodeURIComponent(norm.author_clean)}&fields=${OL_FIELDS}&limit=15`,
    `https://openlibrary.org/search.json?q=${encodeURIComponent(norm.search_query)}` +
      `&fields=${OL_FIELDS}&limit=15`,
  ];
  const seen = new Map();
  let error = null;
  for (const url of queries) {
    try {
      const r = await fetchWithRetry(url);
      const docs = (r.json && r.json.docs) || [];
      for (const d of docs) {
        if (!d.cover_i) continue;
        if (!seen.has(d.key)) seen.set(d.key, d);
      }
    } catch (e) {
      error = String(e.message);
    }
    if (seen.size >= 6) break; // first query was good enough
  }
  const wantTitle = normTitle(norm.title_clean);
  const wantAuthor = lastName(norm.author_clean);
  const scored = [...seen.values()].map((d) => {
    const t = normTitle(d.title);
    let score = 0;
    if (t === wantTitle) score += 100;
    else if (t.startsWith(wantTitle) || wantTitle.startsWith(t)) score += 45;
    else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 20;
    const authors = (d.author_name || []).map((a) => lastName(a));
    if (wantAuthor && authors.includes(wantAuthor)) score += 40;
    if (work.year && d.first_publish_year) {
      const diff = Math.abs(d.first_publish_year - work.year);
      if (diff <= 3) score += 15;
      else if (diff <= 15) score += 6;
    }
    score += Math.min(10, Math.log10((d.edition_count || 1) + 1) * 6);
    return { ...d, _score: Math.round(score) };
  });
  scored.sort((a, b) => b._score - a._score);
  const out = { candidates: scored.slice(0, 5), found: scored.length, error };
  writeJSON(cacheFile, out);
  return out;
}

const VERIFY_PROMPT = (work, norm, cands) => `You are matching a science-fiction work against library-catalogue search results. A WRONG cover is much worse than no cover, so answer "none" whenever you are not confident.

THE WORK WE WANT
  title: ${JSON.stringify(work.novel)}
  cleaned title: ${JSON.stringify(norm.title_clean)}
  author: ${JSON.stringify(work.author)}
  approximate year of the idea: ${work.year == null ? 'unknown' : work.year}
  described as a short story: ${norm.is_short_story ? 'yes' : 'no'}

CANDIDATES FROM THE CATALOGUE
${cands.map((c, i) =>
  `  ${i + 1}. title: ${JSON.stringify(c.title)} | author: ${JSON.stringify((c.author_name || []).join(', '))} | first published: ${c.first_publish_year || 'unknown'}`
).join('\n')}

Choose the ONE candidate that is genuinely the SAME WORK by the SAME AUTHOR.

Accept a candidate only if:
- it is the same work (a reprint, a translation, a different edition, or a collection named after this work all count), AND
- the author is the same person.

Reject (answer 0) if:
- it is a sequel, prequel, other book in the same series, an omnibus of several works, a companion/criticism/notebook volume, an adaptation by someone else, or a general anthology that merely contains the work, OR
- the author differs, OR
- you are simply unsure.

Return ONLY this JSON object:
{"choice": <integer 0 for none, or the candidate number>, "confidence": "high" | "medium" | "low", "reason": "<max 15 words>"}`;

async function verifyCandidate(work, norm, candidates) {
  const cacheFile = path.join(CACHE_DIR, 'verify', `${work.key}.json`);
  if (!CFG.refresh) {
    const hit = readJSON(cacheFile);
    if (hit) return hit;
  }
  let out;
  try {
    const raw = await askLLM('verify', VERIFY_PROMPT(work, norm, candidates), { numPredict: 200 });
    let choice = Number(raw.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > candidates.length) choice = 0;
    const confidence = ['high', 'medium', 'low'].includes(String(raw.confidence).toLowerCase())
      ? String(raw.confidence).toLowerCase() : 'low';
    // Low confidence is treated as "none": a wrong cover is worse than none.
    const accepted = choice > 0 && confidence !== 'low';
    out = {
      choice,
      confidence,
      accepted,
      reason: String(raw.reason || '').slice(0, 160),
      candidate: choice > 0 ? candidates[choice - 1] : null,
    };
  } catch (e) {
    out = { choice: 0, confidence: 'low', accepted: false, reason: 'llm error', _error: String(e.message), candidate: null };
  }
  writeJSON(cacheFile, out);
  return out;
}

/** Minimal JPEG SOF parser — enough to sanity-check dimensions. */
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

/**
 * Deterministic guards applied AFTER the LLM verdict. The LLM cannot see that
 * Open Library often stores a whole series under one truncated title, so it
 * happily picks one of five identically-named books. Reject those.
 * Returns null when the match is fine, or a reason string when it must be dropped.
 */
const AUTHOR_STOP = new Set(['the', 'von', 'van', 'de', 'la', 'du', 'del', 'jr', 'sir', 'lord', 'and']);

/** Comparable surname-ish tokens of an author string. Diacritic-folded. */
function authorTokens(s) {
  return new Set(
    fold(s).split(/[^a-z]+/).filter((t) => t.length >= 4 && !AUTHOR_STOP.has(t))
  );
}
function shareAuthorToken(a, b) {
  const A = authorTokens(a);
  const B = authorTokens(b);
  if (!A.size || !B.size) return true; // nothing comparable => nothing to disagree about
  for (const t of A) if (B.has(t)) return true;
  return false;
}
const authorsOf = (c) => (c.author_name || []).join(' ');

// Two catalogue entries whose first-publish years sit further apart than this
// are probably not the same book...
const AMBIG_YEAR_SPREAD = 25;
// ...unless the record's own year clearly picks a winner by this margin.
const DECISIVE_YEAR_EDGE = 15;

/**
 * Is the chosen candidate genuinely ambiguous against the entries that share
 * its title? A repeated title string is NOT by itself ambiguity: Open Library
 * routinely carries the same famous novel as several "works", and rejecting
 * those loses Looking Backward, The Steam Man of the Prairies and friends.
 * Real ambiguity means a rival could plausibly be a DIFFERENT work —
 * a different author, or a first-publish year far from the chosen one — and
 * even then the record's own year can settle it.
 * Returns a reason string, or null when the field is effectively unanimous.
 */
function ambiguityReason(work, candidates, chosen) {
  const got = normTitle(chosen.title);
  const rivals = candidates.filter(
    (c) => c.key !== chosen.key && normTitle(c.title) === got
  );
  if (!rivals.length) return null;

  const cy = chosen.first_publish_year || null;
  const wy = work.year || null;
  const chosenOff = cy && wy ? Math.abs(cy - wy) : null;
  const title = chosen.title;

  for (const r of rivals) {
    if (!shareAuthorToken(authorsOf(chosen), authorsOf(r))) {
      return `${rivals.length + 1} entries titled "${title}" credit different authors ` +
        `("${authorsOf(chosen)}" vs "${authorsOf(r)}")`;
    }
    const ry = r.first_publish_year || null;
    if (!cy || !ry) continue;
    if (Math.abs(cy - ry) <= AMBIG_YEAR_SPREAD) continue; // duplicate editions of one book
    // The years genuinely disagree — unless the record's own year favours the
    // chosen entry by a clear margin, in which case the call is decided.
    const rivalOff = wy ? Math.abs(ry - wy) : null;
    if (chosenOff != null && rivalOff != null && chosenOff + DECISIVE_YEAR_EDGE <= rivalOff) continue;
    return `entries titled "${title}" first published ${Math.min(cy, ry)} and ` +
      `${Math.max(cy, ry)} — different works`;
  }

  // The mirror image: never keep a pick that a same-titled rival beats outright
  // on the year we actually expect. That is the series-truncation failure the
  // guard exists for (five "Dune"s, LLM grabs the wrong one).
  if (chosenOff != null) {
    for (const r of rivals) {
      const ry = r.first_publish_year;
      if (!ry) continue;
      if (Math.abs(ry - wy) + DECISIVE_YEAR_EDGE <= chosenOff) {
        return `a rival "${title}" (${ry}) fits ${wy} far better than the chosen entry (${cy})`;
      }
    }
  }
  return null;
}

function guardMatch(work, norm, candidates, chosen) {
  const want = normTitle(norm.title_clean);
  const got = normTitle(chosen.title);
  if (got && got !== want) {
    const why = ambiguityReason(work, candidates, chosen);
    if (why) return `ambiguous: ${why}`;
  }
  if (!shareAuthorToken(work.author + ' ' + norm.author_clean, authorsOf(chosen))) {
    return `author mismatch: "${(chosen.author_name || []).join(', ')}"`;
  }
  return null;
}

async function downloadCover(coverId, destFile) {
  if (fs.existsSync(destFile) && fs.statSync(destFile).size > 1000) {
    const buf = fs.readFileSync(destFile);
    return { bytes: buf.length, size: jpegSize(buf), cached: true };
  }
  const url = `https://covers.openlibrary.org/b/id/${coverId}-M.jpg?default=false`;
  const r = await fetchWithRetry(url, { binary: true });
  if (r.notFound) throw new Error('cover image 404');
  const buf = r.buffer;
  if (!buf || buf.length < 1000) throw new Error(`cover too small (${buf ? buf.length : 0} bytes)`);
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) throw new Error('not a JPEG');
  const size = jpegSize(buf);
  if (!size || size.w < 80 || size.h < 80) {
    throw new Error(`cover dimensions too small (${size ? size.w + 'x' + size.h : 'unparseable'})`);
  }
  fs.writeFileSync(destFile, buf);
  return { bytes: buf.length, size, cached: false };
}

// ---------------------------------------------------------------- pipeline
const CFG = {
  model: DEFAULT_MODEL,
  refresh: false,
  all: false,
  only: null,
  limit: 0,
  csv: DEFAULT_CSV,
};

const RESULTS = [];
const FAILURES = [];

async function processWork(work, idx, total) {
  const rec = { key: work.key, novel: work.novel, author: work.author, year: work.year, ideas: work.count };
  try {
    const norm = await normalizeWork(work);
    rec.norm = norm;

    const search = await searchOpenLibrary(work, norm);
    rec.candidates = search.candidates.length;
    if (search.error) rec.searchError = search.error;

    if (!search.candidates.length) {
      rec.status = 'no-candidate';
      RESULTS.push(rec);
      log(idx, total, work, 'no candidate');
      return;
    }

    const verdict = await verifyCandidate(work, norm, search.candidates);
    rec.verdict = { choice: verdict.choice, confidence: verdict.confidence, reason: verdict.reason };

    if (!verdict.accepted) {
      rec.status = verdict.choice > 0 ? 'rejected-lowconf' : 'rejected-none';
      RESULTS.push(rec);
      log(idx, total, work, `LLM said none (${verdict.confidence}) — ${verdict.reason}`);
      return;
    }

    const cand = verdict.candidate;

    const guard = guardMatch(work, norm, search.candidates, cand);
    if (guard) {
      rec.status = 'rejected-guard';
      rec.guard = guard;
      RESULTS.push(rec);
      log(idx, total, work, `guard rejected — ${guard}`);
      return;
    }

    const dest = path.join(PHOTO_DIR, `${work.key}.jpg`);
    try {
      const dl = await downloadCover(cand.cover_i, dest);
      rec.status = 'photo';
      rec.match = {
        olWork: cand.key,
        coverId: cand.cover_i,
        title: cand.title,
        author: (cand.author_name || []).join(', '),
        firstPublishYear: cand.first_publish_year || null,
        score: cand._score,
      };
      rec.bytes = dl.bytes;
      rec.dim = dl.size;
      log(idx, total, work, `PHOTO ${cand.title} (${cand.first_publish_year || '?'}) ${Math.round(dl.bytes / 1024)}KB`);
    } catch (e) {
      rec.status = 'download-failed';
      rec.error = String(e.message);
      FAILURES.push({ key: work.key, stage: 'download', error: String(e.message) });
      log(idx, total, work, `download failed: ${e.message}`);
    }
    RESULTS.push(rec);
  } catch (e) {
    rec.status = 'failed';
    rec.error = String(e.message);
    FAILURES.push({ key: work.key, stage: 'pipeline', error: String(e.message) });
    RESULTS.push(rec);
    log(idx, total, work, `FAILED: ${e.message}`);
  }
}

let done = 0;
function log(idx, total, work, msg) {
  done++;
  const label = `${work.novel} — ${work.author}`.slice(0, 52).padEnd(52);
  console.log(`[${String(done).padStart(4)}/${total}] ${label} ${msg}`);
}

// -------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
  CFG.all = argv.includes('--all');
  CFG.refresh = argv.includes('--refresh');
  CFG.only = arg('only', null);
  CFG.limit = parseInt(arg('limit', '0'), 10) || 0;
  CFG.model = arg('model', DEFAULT_MODEL);
  CFG.csv = arg('csv', DEFAULT_CSV);

  ensureDirs();

  const rows = CFG.all ? loadFromCSV(CFG.csv) : loadFromDataJson();
  let works = worksFromRows(rows);

  // collision check on the join key
  const seenKeys = new Map();
  for (const w of works) {
    if (seenKeys.has(w.key)) console.warn('KEY COLLISION:', w.key);
    seenKeys.set(w.key, w);
  }

  if (CFG.only) {
    const q = CFG.only.toLowerCase();
    works = works.filter((w) => w.novel.toLowerCase().includes(q) || w.key.includes(slug(q)));
  }
  if (CFG.limit) works = works.slice(0, CFG.limit);

  const total = works.length;
  console.log(`--- build-covers ---`);
  console.log(`source     : ${CFG.all ? CFG.csv : 'data.json'}`);
  console.log(`model      : ${CFG.model} (fallback ${FALLBACK_MODEL}) @ ${OLLAMA_URL}`);
  console.log(`works      : ${total}`);
  console.log(`workers    : ${WORKERS}, ollama slots ${LLM_SLOTS}, OL rate 1/${OL_MIN_INTERVAL_MS}ms`);
  console.log('');

  const t0 = Date.now();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, total || 1) }, async () => {
      while (cursor < works.length) {
        const i = cursor++;
        await processWork(works[i], i, total);
      }
    })
  );
  const wall = Date.now() - t0;

  // ------------------------------------------------------------- manifest
  const manifest = {};
  let bytes = 0;
  for (const r of RESULTS) {
    if (r.status !== 'photo') continue;
    bytes += r.bytes || 0;
    manifest[r.key] = {
      type: 'photo',
      file: `covers/photo/${r.key}.jpg`,
      title: r.novel,
      author: r.author,
      width: r.dim ? r.dim.w : null,
      height: r.dim ? r.dim.h : null,
      matchedTitle: r.match.title,
      matchedAuthor: r.match.author,
      matchedYear: r.match.firstPublishYear,
      source: 'openlibrary',
      olWork: r.match.olWork,
      olCoverId: r.match.coverId,
      attribution:
        `Cover image via Open Library (cover id ${r.match.coverId}, ${r.match.olWork}). ` +
        'Third-party artwork; rights held by the original publisher.',
    };
  }
  writeJSON(path.join(ROOT, 'covers.json'), manifest);

  // Drop orphan images left behind by earlier runs (e.g. a match that a later
  // run rejected). Only on full runs, so spot-debugging cannot nuke the set.
  let orphans = 0;
  if (!CFG.only && !CFG.limit) {
    for (const f of fs.readdirSync(PHOTO_DIR)) {
      if (!f.endsWith('.jpg')) continue;
      if (!manifest[f.slice(0, -4)]) { fs.unlinkSync(path.join(PHOTO_DIR, f)); orphans++; }
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
    shortStoriesFlagged: RESULTS.filter((r) => r.norm && r.norm.is_short_story).length,
  };
  const shortStories = RESULTS.filter((r) => r.norm && r.norm.is_short_story);
  const report = {
    generated: new Date().toISOString(),
    source: CFG.all ? path.basename(CFG.csv) : 'data.json',
    model: CFG.model,
    joinKey: 'slug(novel) + "--" + slug(author); slug = NFKD, lowercase, & -> " and ", non-alphanumeric -> "-", trimmed, first 70 chars',
    counts,
    coveragePct: RESULTS.length ? +(100 * counts.photoCovers / RESULTS.length).toFixed(1) : 0,
    shortStoryCoverage: {
      flagged: shortStories.length,
      withCover: shortStories.filter((r) => r.status === 'photo').length,
    },
    totalCoverBytes: bytes,
    avgCoverBytes: counts.photoCovers ? Math.round(bytes / counts.photoCovers) : 0,
    wallClockMs: wall,
    msPerWork: RESULTS.length ? Math.round(wall / RESULTS.length) : 0,
    llm: { ...llmStats, avgCallMs: llmStats.calls ? Math.round(llmStats.ms / llmStats.calls) : 0 },
    failures: FAILURES,
    works: RESULTS.map((r) => ({
      key: r.key, novel: r.novel, author: r.author, status: r.status,
      isShortStory: r.norm ? !!r.norm.is_short_story : null,
      bookLikelihood: r.norm ? r.norm.book_likelihood : null,
      candidates: r.candidates || 0,
      verdict: r.verdict || null,
      guard: r.guard || null,
      match: r.match || null,
      error: r.error || null,
    })),
  };
  writeJSON(path.join(ROOT, 'covers-report.json'), report);

  console.log('\n--- summary ---');
  console.table(counts);
  console.log(`manifest entries : ${Object.keys(manifest).length}${orphans ? ` (${orphans} orphan image(s) removed)` : ''}`);
  console.log(`coverage         : ${report.coveragePct}% of works have a real cover`);
  console.log(`downloaded       : ${(bytes / 1024 / 1024).toFixed(2)} MB (avg ${Math.round(bytes / 1024 / (counts.photoCovers || 1))} KB)`);
  console.log(`wall clock       : ${(wall / 1000).toFixed(1)}s  (${report.msPerWork} ms/work)`);
  console.log(`llm calls        : ${llmStats.calls} (${(llmStats.ms / 1000).toFixed(1)}s total, avg ${report.llm.avgCallMs} ms, ${llmStats.errors} errors, ${llmStats.fallbacks} fallback-model)`);
  if (FAILURES.length) console.log(`failures         : ${FAILURES.length} (see covers-report.json)`);
  console.log('');
  console.log('NOTE: photo covers are THIRD-PARTY ARTWORK fetched from Open Library');
  console.log('      (covers.openlibrary.org). Attribution + cover id is recorded per');
  console.log('      entry in covers.json. Works with no verified cover simply have no');
  console.log('      manifest entry — the UI should fall back to text only.');
}

// Exported so the guard can be replayed against the caches without re-running
// the pipeline (see the --recheck-rejected note in the header).
module.exports = { slug, workKey, fold, normTitle, guardMatch, ambiguityReason,
  worksFromRows, loadFromDataJson, CFG };

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
