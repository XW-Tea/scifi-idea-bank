#!/usr/bin/env node
/**
 * classify-kind.js — fill the Bits/Atoms axis for rows that have no value.
 *
 * The CSV carries a "Bits or Atoms?" column; hand-curated works in extra/ do
 * not, so they land as `kind: "unknown"` and render as matte atoms regardless
 * of what they are. This asks the local LLM per idea and writes the answer
 * back into the extra/*.json that produced it, so `node preprocess.js --all`
 * carries it forward. Cached on disk; a re-run makes zero LLM calls.
 *
 *   node classify-kind.js [--model qwen2.5:14b] [--force]
 */
const fs = require('fs');
const path = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EXTRA_DIR = path.join(__dirname, 'extra');
const CACHE = path.join(EXTRA_DIR, '.kind-cache.json');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const MODEL = arg('model', 'qwen2.5:14b');
const FORCE = argv.includes('--force');

const PROMPT = (it) => `Classify a science-fiction technology on one axis only.

"atoms" = a physical thing: a machine, material, vehicle, weapon, implant, body, chemical, structure.
"bits"  = information: software, data, a signal, a network, a simulation, an AI mind, a protocol, a computation.

If it is a physical device whose purpose is to process information, it is still "atoms" — the axis is what the thing IS, not what it does. A mind or a copied consciousness with no body is "bits".

Work: ${it.novel} (${it.year})
Technology: ${it.device}
Description: ${it.desc}

Reply with JSON only: {"kind":"atoms"} or {"kind":"bits"}`;

async function ask(it, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, stream: false, format: 'json',
          options: { temperature: 0.1 }, prompt: PROMPT(it) }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const j = await r.json();
      const v = JSON.parse(j.response).kind;
      if (v === 'atoms' || v === 'bits') return v;
      throw new Error('bad value ' + JSON.stringify(v));
    } catch (e) {
      if (a === tries) { console.warn(`  ! ${it.device}: ${e.message} -> atoms`); return 'atoms'; }
      await new Promise((s) => setTimeout(s, 400 * a));
    }
  }
}

(async () => {
  if (!fs.existsSync(EXTRA_DIR)) { console.log('no extra/ directory; nothing to do'); return; }
  const cache = fs.existsSync(CACHE) && !FORCE ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const files = fs.readdirSync(EXTRA_DIR).filter((f) => f.endsWith('.json'));
  let asked = 0, cached = 0, changed = 0;
  const t0 = Date.now();

  for (const f of files) {
    const p = path.join(EXTRA_DIR, f);
    const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rows = Array.isArray(payload) ? payload : payload.items || [];
    for (const it of rows) {
      if (it.kind === 'atoms' || it.kind === 'bits') continue;
      const key = `${it.novel}|${it.device}`;
      let kind = cache[key];
      if (kind) cached++;
      else { kind = await ask(it); cache[key] = kind; asked++;
             if (asked % 20 === 0) console.log(`  ${asked} asked...`); }
      it.kind = kind; changed++;
    }
    fs.writeFileSync(p, JSON.stringify(payload, null, 1));
    const counts = rows.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {});
    console.log(`${f}: ${rows.length} rows -> ${JSON.stringify(counts)}`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  console.log(`\nfilled ${changed} (llm ${asked}, cached ${cached}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('now re-run: node preprocess.js --all');
})();
