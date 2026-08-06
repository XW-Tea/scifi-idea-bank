#!/usr/bin/env node
/**
 * Sci-Fi Idea Bank preprocessor.
 *   node preprocess.js [--in <csv>] [--out data.json] [--sample 500] [--all]
 *
 * Parses the raw Google-Sheets export (6 junk lines, header on line 7,
 * leading empty column), cleans it, and writes a stratified sample to JSON.
 */

const fs = require('fs');
const path = require('path');

// Override with --in <path> or SCIFI_CSV. Default looks next to this script.
const DEFAULT_IN = process.env.SCIFI_CSV ||
  path.join(__dirname, 'Sci-Fi Idea Bank.csv');

// ---------------------------------------------------------------- CSV parser
/** RFC4180-ish parser: handles quoted fields containing commas/newlines/"" */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // normalise newlines
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

// ------------------------------------------------------------------- helpers
const NA = new Set(['', 'n/a', 'na', 'none', 'unknown', '-', '?']);
function clean(v) {
  const s = (v == null ? '' : String(v)).trim().replace(/\s+/g, ' ');
  return NA.has(s.toLowerCase()) ? '' : s;
}

/** Parse a year-ish string. Returns integer or null. Handles "2000s", "c. 1890", "1920s-1930s". */
function parseYear(raw) {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/(1[0-9]{3}|20[0-9]{2})/);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  if (!Number.isFinite(y) || y < 1400 || y > 2100) return null;
  // "1990s" -> mid-decade
  if (/^\D*\d{4}s/.test(s)) y += 5;
  return y;
}

function isFuzzyYear(raw) {
  const s = clean(raw);
  return !!s && (/s\b/.test(s) || /c\.|circa|~|about|early|late|mid/i.test(s));
}

// ------------------------------------------------------------------- loading
function loadRows(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(raw);

  // Find the header row: the one containing 'Device Name'
  let headerIdx = rows.findIndex((r) => r.some((c) => clean(c) === 'Device Name'));
  if (headerIdx === -1) throw new Error('Could not locate header row (no "Device Name" cell)');
  const header = rows[headerIdx].map(clean);
  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Missing column: ${name}`);
    return i;
  };
  const IDX = {
    date: col('Date'),
    device: col('Device Name'),
    novel: col('Novel'),
    author: col('Author'),
    desc: col('Description'),
    built: col('Built?'),
    byWhom: col('By Whom?'),
    product: col('Product'),
    firstYear: col('First Year Made'),
    details: col('Additional Details'),
    bits: col('Bits or Atoms?'),
    companies: col('Companies Working on This'),
  };

  const out = [];
  const stats = { total: 0, skippedNoDevice: 0, skippedNoYear: 0 };
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => clean(c) === '')) continue;
    stats.total++;
    const device = clean(r[IDX.device]);
    if (!device) { stats.skippedNoDevice++; continue; }
    const year = parseYear(r[IDX.date]);
    if (year == null) { stats.skippedNoYear++; continue; }

    const builtRaw = clean(r[IDX.built]).toLowerCase();
    const built = builtRaw.startsWith('y');
    const bitsRaw = clean(r[IDX.bits]).toLowerCase();
    const kind = bitsRaw.startsWith('b') ? 'bits' : bitsRaw.startsWith('a') ? 'atoms' : 'unknown';
    const realYearRaw = clean(r[IDX.firstYear]);
    const realYear = built ? parseYear(realYearRaw) : null;

    out.push({
      id: out.length,
      year,
      device,
      novel: clean(r[IDX.novel]),
      author: clean(r[IDX.author]) || 'Unknown',
      desc: clean(r[IDX.desc]),
      built,
      byWhom: clean(r[IDX.byWhom]),
      product: clean(r[IDX.product]),
      realYear,
      realYearRaw,
      realYearFuzzy: built && isFuzzyYear(realYearRaw),
      details: clean(r[IDX.details]),
      kind,
      companies: clean(r[IDX.companies]),
    });
  }
  return { items: out, stats, header };
}

// ------------------------------------------------------------------ sampling
/** Deterministic PRNG so re-runs produce the same data.json. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Stratified sample: bucket by (era x built) so both Built=Yes/No and the full
 * 1634-2023 range stay represented. Sparse early eras are taken (nearly) whole.
 */
const ERA_EDGES = [1600, 1800, 1850, 1880, 1900, 1920, 1940, 1960, 1980, 2000, 2010, 2100];
function eraOf(year) {
  for (let i = 0; i < ERA_EDGES.length - 1; i++) {
    if (year >= ERA_EDGES[i] && year < ERA_EDGES[i + 1]) return i;
  }
  return ERA_EDGES.length - 2;
}

function stratifiedSample(items, target, seed = 1634) {
  const rnd = mulberry32(seed);
  const buckets = new Map();
  for (const it of items) {
    const key = eraOf(it.year) + '|' + (it.built ? 'y' : 'n');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  const keys = [...buckets.keys()].sort();
  const picked = [];
  const taken = new Map(keys.map((k) => [k, 0]));

  // Round-robin across buckets: guarantees small/sparse buckets are fully
  // represented before the big modern ones soak up the remaining budget.
  const pools = new Map(keys.map((k) => [k, shuffled(buckets.get(k), rnd)]));
  let progress = true;
  while (picked.length < target && progress) {
    progress = false;
    for (const k of keys) {
      if (picked.length >= target) break;
      const pool = pools.get(k);
      const t = taken.get(k);
      if (t < pool.length) {
        picked.push(pool[t]);
        taken.set(k, t + 1);
        progress = true;
      }
    }
  }
  picked.sort((a, b) => a.year - b.year || a.id - b.id);
  return picked.map((it, i) => ({ ...it, id: i }));
}

// ---------------------------------------------------------------------- main
/**
 * Load the hand-curated non-CSV works from extra/*.json.
 * Missing directory is not an error — the CSV alone is a valid dataset.
 */
function loadExtra() {
  const dir = path.join(__dirname, 'extra');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const payload = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const rows = Array.isArray(payload) ? payload : payload.items || [];
    for (const r of rows) {
      if (!r.device || !Number.isFinite(r.year)) {
        throw new Error(`extra/${f}: item missing device or year: ${JSON.stringify(r).slice(0, 120)}`);
      }
      out.push({
        id: -1,                       // renumbered by the caller
        year: r.year,
        device: r.device,
        novel: r.novel,
        author: r.author || 'Unknown',
        desc: r.desc || '',
        built: !!r.built,
        byWhom: r.byWhom || '',
        product: r.product || '',
        realYear: r.built ? (Number.isFinite(r.realYear) ? r.realYear : null) : null,
        realYearRaw: r.realYearRaw || '',
        realYearFuzzy: !!(r.built && r.realYearFuzzy),
        details: r.details || '',
        kind: r.kind || 'unknown',
        companies: r.companies || '',
        // --- fields the CSV has no column for ---
        medium: r.medium || 'novel',
        titleNative: r.titleNative || '',
        deviceNative: r.deviceNative || '',
        sourceUrl: r.sourceUrl || '',
      });
    }
    console.log(`  extra/${f}: ${rows.length} items`);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i === -1 ? dflt : argv[i + 1];
  };
  const inPath = arg('in', DEFAULT_IN);
  const outPath = path.resolve(__dirname, arg('out', 'data.json'));
  const wantAll = argv.includes('--all');
  const sampleN = parseInt(arg('sample', '500'), 10);

  if (!fs.existsSync(inPath)) {
    console.error('Input CSV not found:', inPath);
    process.exit(1);
  }

  const { items, stats } = loadRows(inPath);
  const base = wantAll ? items.map((it, i) => ({ ...it, id: i })) : stratifiedSample(items, sampleN);

  /* Hand-curated works that are not in the Technovelgy CSV — anime, manga,
     games, non-anglophone novels. Each file under extra/ holds { items: [...] }
     already in the shape loadRows() produces, plus the extra fields:
       medium       manga | anime | film | game | novel
       titleNative  原題 in its own script; `novel` stays the English title
                    because covers.json joins on slug(novel)--slug(author)
       sourceUrl    where the depiction is documented
     They are appended after the CSV rows and the whole set is renumbered, so
     ids stay dense and the sampling path above is untouched. */
  const extra = loadExtra();
  const sample = base.concat(extra).map((it, i) => ({ ...it, id: i }));

  const years = sample.map((d) => d.year);
  const builtCount = sample.filter((d) => d.built).length;
  const withThread = sample.filter((d) => d.built && d.realYear != null).length;

  const payload = {
    meta: {
      generated: new Date().toISOString(),
      source: path.basename(inPath),
      totalRowsParsed: items.length,
      sampled: sample.length,
      builtYes: builtCount,
      builtNo: sample.length - builtCount,
      withRealizationYear: withThread,
      yearMin: Math.min(...years),
      yearMax: Math.max(...years),
      authors: new Set(sample.map((d) => d.author)).size,
      novels: new Set(sample.map((d) => d.novel).filter(Boolean)).size,
    },
    items: sample,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 0));

  // Validate what we just wrote.
  const reread = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const bad = reread.items.filter(
    (d) => !Number.isFinite(d.year) || !d.device || typeof d.built !== 'boolean'
  );
  if (bad.length) throw new Error(`${bad.length} malformed items in output`);

  console.log('--- preprocess ---');
  console.log('raw data rows seen :', stats.total);
  console.log('  skipped (no name):', stats.skippedNoDevice);
  console.log('  skipped (no year):', stats.skippedNoYear);
  console.log('clean rows         :', items.length);
  console.log('written            :', outPath);
  console.table(payload.meta);
  // era histogram, for eyeballing coverage
  const hist = {};
  for (const d of sample) {
    const k = ERA_EDGES[eraOf(d.year)] + '-';
    hist[k] = hist[k] || { yes: 0, no: 0 };
    hist[k][d.built ? 'yes' : 'no']++;
  }
  console.log('era coverage (built yes/no):');
  for (const k of Object.keys(hist)) console.log('  ', k, hist[k].yes + ' / ' + hist[k].no);
}

main();
