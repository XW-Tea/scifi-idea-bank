#!/usr/bin/env node
/**
 * covers-manual.js — add a cover by hand when the automated pipeline can't.
 *
 * Some works simply have no keyless catalogue to match against: film and TV
 * have no route at all, and a legitimate match is sometimes rejected on
 * purpose (Fallout's Steam listing shows the 2013 re-release publisher and
 * year, so the verifier declines it — correctly, given a wrong cover is worse
 * than none). This is the escape hatch for a human who knows the answer.
 *
 *   node covers-manual.js --list
 *       every work with no cover, worst-offender first, with the key to use
 *
 *   node covers-manual.js --add "Black Mirror" <image-url> [--credit "..."]
 *       fetch the image, record it, merge into covers.json
 *
 *   node covers-manual.js --add "Black Mirror" ./poster.jpg
 *       same, from a local file
 *
 *   node covers-manual.js --remove "Black Mirror"
 *   node covers-manual.js --sync          # re-merge after editing by hand
 *
 * The record of truth is covers-manual.json, which IS committed. covers.json
 * is regenerated from it plus the automated results, and `covers/photo/` is
 * gitignored — so **prefer a URL over a local file**: a URL survives a fresh
 * clone, a local file does not. The site prefers `remoteUrl` when it is not
 * running on localhost, so a URL is also what the published page will use.
 *
 * Manual entries always win over automated ones, and the cover builders skip
 * any work that has one, so a hand-picked cover is never quietly replaced.
 */
const fs = require('fs');
const path = require('path');
const bc = require('./build-covers.js'); // same join key, never let these drift

const ROOT = __dirname;
const MANUAL_JSON = path.join(ROOT, 'covers-manual.json');
const COVERS_JSON = path.join(ROOT, 'covers.json');
const PHOTO_DIR = path.join(ROOT, 'covers', 'photo');
const DATA_JSON = path.join(ROOT, 'data.json');

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

// ------------------------------------------------------------------ helpers
function loadWorks() {
  const d = readJSON(DATA_JSON);
  if (!d || !Array.isArray(d.items)) throw new Error('data.json missing — run preprocess.js first');
  const byKey = new Map();
  for (const it of d.items) {
    const key = bc.workKey(it.novel, it.author);
    let w = byKey.get(key);
    if (!w) { w = { key, novel: it.novel, author: it.author, year: it.year, medium: it.medium || 'book', count: 0 }; byKey.set(key, w); }
    w.count++;
    if (it.year != null && (w.year == null || it.year < w.year)) w.year = it.year;
  }
  return [...byKey.values()];
}

/** Accepts a work key, an exact title, or a unique case-insensitive substring. */
function resolveWork(works, needle) {
  const n = String(needle).trim();
  const exactKey = works.find((w) => w.key === n);
  if (exactKey) return exactKey;
  const exactTitle = works.filter((w) => w.novel.toLowerCase() === n.toLowerCase());
  if (exactTitle.length === 1) return exactTitle[0];
  const partial = works.filter((w) => w.novel.toLowerCase().includes(n.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${needle}" matches ${partial.length} works:\n` +
      partial.slice(0, 12).map((w) => `    ${w.key}   ${w.novel} — ${w.author}`).join('\n') +
      '\n  Pass the key instead.');
  }
  throw new Error(`no work matching "${needle}" (try --list)`);
}

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', w: null, h: null, ...jpegSize(buf) };
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', w: null, h: null };
  return null;
}
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return {};
}

/** covers.json = automated entries with manual ones layered on top. */
function syncCoversJSON(manual) {
  const covers = readJSON(COVERS_JSON, {});
  // drop stale manual entries that are no longer listed
  for (const [k, v] of Object.entries(covers)) if (v.source === 'manual' && !manual[k]) delete covers[k];
  for (const [k, m] of Object.entries(manual)) covers[k] = m;
  writeJSON(COVERS_JSON, covers);
  return Object.keys(covers).length;
}

// -------------------------------------------------------------------- verbs
async function cmdList(works, manual) {
  const covers = readJSON(COVERS_JSON, {});
  const missing = works.filter((w) => !covers[w.key]).sort((a, b) => b.count - a.count);
  if (!missing.length) { console.log('every work has a cover'); return; }
  console.log(`${missing.length} works without a cover (of ${works.length}), most ideas first:\n`);
  for (const w of missing.slice(0, Number(arg('limit', 40)))) {
    console.log(`  ${String(w.count).padStart(3)} ideas  ${w.medium.padEnd(6)} ${w.novel} — ${w.author}`);
    console.log(`             key: ${w.key}`);
  }
  const shown = Math.min(missing.length, Number(arg('limit', 40)));
  if (missing.length > shown) console.log(`\n  ...and ${missing.length - shown} more (--limit N to see further)`);
  console.log('\nAdd one with:\n  node covers-manual.js --add "<title or key>" <image-url> --credit "source, rights"');
}

async function cmdAdd(works, manual) {
  const needle = arg('add');
  const src = argv[argv.indexOf('--add') + 2];
  if (!needle || !src || src.startsWith('--')) throw new Error('usage: --add "<title or key>" <image-url-or-path> [--credit "..."]');
  const work = resolveWork(works, needle);

  let buf, remoteUrl = '';
  if (/^https?:\/\//i.test(src)) {
    remoteUrl = src;
    const res = await fetch(src, { headers: { 'User-Agent': 'scifi-idea-bank-manual-cover/1.0' } });
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = fs.readFileSync(path.resolve(src));
    console.warn('! local file: covers/photo/ is gitignored, so this image will not survive a fresh clone.\n' +
                 '  Prefer a URL, or re-run --add on any machine that needs it.');
  }
  const s = sniff(buf);
  if (!s) throw new Error('not a recognised image (jpg/png/webp)');
  if (buf.length < 1000) throw new Error(`image too small (${buf.length} bytes)`);

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const file = `covers/photo/${work.key}.${s.ext}`;
  fs.writeFileSync(path.join(ROOT, file), buf);

  manual[work.key] = {
    type: 'photo', file, title: work.novel, author: work.author,
    width: s.w || null, height: s.h || null,
    matchedTitle: work.novel, matchedAuthor: work.author, matchedYear: work.year,
    source: 'manual',
    ...(remoteUrl ? { remoteUrl } : {}),
    attribution: arg('credit') || 'Added by hand; rights held by the original publisher.',
    addedBy: 'covers-manual.js',
  };
  writeJSON(MANUAL_JSON, manual);
  const total = syncCoversJSON(manual);
  console.log(`added ${work.novel} — ${work.author}`);
  console.log(`  key   ${work.key}`);
  console.log(`  file  ${file}  (${(buf.length / 1024).toFixed(0)} KB${s.w ? `, ${s.w}x${s.h}` : ''})`);
  console.log(`  ${remoteUrl ? 'url   ' + remoteUrl : 'no remoteUrl — will not show on the published site'}`);
  console.log(`covers.json now has ${total} entries`);
}

function cmdRemove(works, manual) {
  const work = resolveWork(works, arg('remove'));
  if (!manual[work.key]) throw new Error(`${work.key} has no manual cover`);
  delete manual[work.key];
  writeJSON(MANUAL_JSON, manual);
  const total = syncCoversJSON(manual);
  console.log(`removed manual cover for ${work.novel}; covers.json now has ${total} entries`);
  console.log('(the image file under covers/photo/ was left in place)');
}

// --------------------------------------------------------------------- main
(async () => {
  const manual = readJSON(MANUAL_JSON, {});
  const works = loadWorks();
  if (flag('add')) await cmdAdd(works, manual);
  else if (flag('remove')) cmdRemove(works, manual);
  else if (flag('sync')) console.log(`covers.json now has ${syncCoversJSON(manual)} entries (${Object.keys(manual).length} manual)`);
  else await cmdList(works, manual);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
