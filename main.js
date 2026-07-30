/* =====================================================================
   THE SCI-FI IDEA BANK — Four Centuries of Tomorrow
   A 2.5D "river of time" browser for the Sci-Fi Idea Bank dataset.

   Structure
     1. CONFIG        — palette, tunables
     2. LAYOUT        — year->Z, domain->XY constellation  (XY fn is swappable)
     3. BUILD         — instanced spheres, threads, ground haze
     4. CAMERA RAIL   — scroll/drag with inertia
     4b. COVERS       — book-cover join + lazy image loading
     5. INTERACTION   — hover, click, card, filters
     6. LOOP          — bobbing, pulsing, labels (LOD)
   ===================================================================== */

import * as THREE from './vendor/three.module.js';

/* ============================ 1. CONFIG ============================= */

const PALETTE = {
  paper:   0xF2E8D5,
  paper2:  0xE7D9BE,
  fog:     0xEFE3CB,
  ink:     0x17253F,
  orange:  0xC8552B,
  teal:    0x1E7A73,
  mustard: 0xD9A521,
  rust:    0x9E3B1E,
  sky:     0x3E7C8C,
};

const CFG = {
  yearNow:      2023,
  yearFloor:    1600,
  depthK:       36,      // units per (year-age)^depthP
  depthP:       0.72,    // <1 compresses the sparse early centuries
  xTaper:       0,       // 0 = off. >0 converges lanes with depth.
                         // MUST stay off for the domain layout: a depth-dependent
                         // X puts a near lane on top of a far one, so the 14 domain
                         // bands smear together and the field reads as random.
                         // ~3000 is the old value if you ever want the effect back.
  xSpread:      560,     // half-width of the author field
  xJitter:      42,      // spread of ideas within one author's lane
  /* yBuilt / yUnbuilt are LEGACY: they only apply to the 'author' and 'novel'
     strategies now. In the domain constellation Y is a spatial coordinate like
     X, and realization is carried entirely by colour, material and threads. */
  yBuilt:      -46,      // realized ideas settle low   (author/novel only)
  yUnbuilt:     78,      // unrealized ideas hover high (author/novel only)
  yJitter:      26,
  groundY:     -360,     // the horizon plate + year gridlines, below everything
  radiusBuilt:  5.2,
  radiusUnbuilt:4.4,
  camAhead:     300,     // camera sits this far "toward the present"
  /* ---- where the river runs ---------------------------------------
     HOME is the point the camera returns to in the cross-section, and with
     the islands it is a real decision, not a default. The old centre line
     (0, 46) now runs straight THROUGH the ROBOTS disc, which means the
     resting view is buried inside one bundle looking at the backs of its own
     nodes — the worst possible read.

     So home is the widest empty corridor inside the constellation: a shaft of
     clear sky about 90 units across, walled by ROBOTS above-left, MIND above-
     right and MEDICINE below. Flying the rail with no input at all is now a
     run down that canyon with islands to either side, which is the shot the
     whole layout exists for. (Found by maximising clearance over points
     enclosed by discs on all four sides — redo that search if you move the
     composition.) */
  camHomeX:     108,
  camHeight:    -54,     // ...and home Y. Not "eye height" any more.
  /* The resting tilt used to look DOWN, because the interesting half of the
     field (the realized band) was below the eye. The constellation is spread
     above and below the centre line instead, so a 7-degree droop now aims the
     default view under the whole composition — which, among other things, made
     the floating sign name whichever island happened to be lowest. Almost
     level, with a hint of downward so the horizon plate stays visible. */
  camTilt:      -0.035,
  lookAhead:    900,
  scrollSpeed:  0.85,    // world units of flight per unit of wheel deltaY
  ease:         0.055,   // camera smoothing (the glide)
  maxPanX:      300,   // how far sideways a button-driven flight may aim
  maxPanY:      240,   // ...and how far up or down (the islands need both now)
  labelCount:   16,
  labelRange:   620,

  /* ---- the data envelope + its elastic edge -----------------------
     The wheel now flies free along the view direction, which means it can
     point at nothing at all. Rather than a hard wall (which reads as a bug),
     the envelope is a soft one: push past it and the TARGET is dragged back
     toward it every frame, so the further out you go the harder it pulls,
     and letting go of the wheel always drifts you home. envSlack is the
     absolute limit — you can bulge this far past the data and no further. */
  envPadX:      260,     // room beyond the widest lane
  envPadY:      210,     // room above the unbuilt band / below the built one
  envSlack:     300,     // maximum bulge past the envelope
  envElastic:   0.055,   // per-frame pull back toward the envelope

  /* ---- thread arcs -------------------------------------------------
     687 arcs at opacity .42 inked a fifth of the ground band: the lag
     threads stopped being individual facts and became a haze. Two cheap
     fixes, both live here: a lower base opacity, and a distance fade so
     only the arcs near the camera carry weight. No arc is ever dropped or
     capped — a far arc is still drawn, at threadFadeMin. */
  threadOpacity:     0.22,   // was 0.42
  threadFadeNear:    220,    // full weight within this distance of the eye
  threadFadeFar:     950,    // faded out to threadFadeMin by here
  threadFadeMin:     0.09,   // never 0: the far field keeps a hint of texture
  threadDimFiltered: 0.22,   // arcs belonging to nodes the filters washed out

  /* ---- the domain constellation (the XY cross-section) -------------
     Z is time; the river's FACE is a 2D map of the taxonomy. Each of the
     fourteen domains owns a disc in XY, hand-placed in DOMAIN_DISCS below,
     and every idea in that domain lives inside its disc for the whole length
     of the field — so a domain is a bundle of streams running through four
     centuries, and the fourteen bundles are islands with sky between them.

     Radius scales with sqrt(population), so node DENSITY is roughly equal
     across the constellation rather than the big domains being ten times
     more crowded. discK is the only size knob: everything scales together,
     and the gaps between islands shrink as you raise it. */
  discK:        4.0,     // radius = discK * sqrt(count)  (space 527 -> ~92)
  discFill:     0.80,    // subject anchors stay inside this fraction of r
  subjectSpread:0.16,    // per-idea jitter around its subject anchor, x r
  subjectMinR:  6.0,     // ...but never tighter than this, or tiny subjects
                         // collapse to a single overlapping dot

  /* ---- bridges between islands ------------------------------------
     Faint arcs joining ADJACENT discs that genuinely share novels. Garnish:
     one draw call, static geometry, and quiet enough that you notice it only
     once you stop moving. bridgeGap is the adjacency test (centre distance
     minus both radii); bridgeTop the number of pairs kept, by co-occurrence. */
  bridgeGap:      120,   // world units of sky: wider than this is not "adjacent"
  bridgeTop:      9,     // how many pairs actually get drawn
  bridgeOpacity:  0.13,
  /* Spaced by DEPTH, not by year. Years are non-linear (depthForYear), so
     "every 20 years" bunches the ropes into a thicket at the far end where
     the centuries are compressed and there is almost no data to justify
     them — and in the sparse 1600s the bridges were the only thing on
     screen. Even world spacing keeps them evenly quiet at every era. */
  bridgeEveryZ:   460,   // world units of depth between one rope and the next
  bridgeSag:      0.22,  // catenary droop, as a fraction of the span
  bridgeSegs:     10,

  /* ---- floating domain signs -------------------------------------
     One merged quad-strip with a texture atlas = ONE extra draw call for
     all fourteen signs, not fourteen. They ride along at a fixed distance
     ahead of the camera (an island runs the whole length of the field, so a
     sign pinned to one year would only be readable at that year) and fade
     in by how close they are to the centre of view — turn your head and
     the name of the island you turned toward lights up.

     Fourteen names cannot all be legible at once — at a readable size each
     sign is far wider than a disc. So only the disc nearest the centre of
     view is shown properly; the discs ADJACENT to it in the constellation are
     ghosted in as a hint of what is next door. Each sign hangs just above the
     top of its own disc, so the name is attached to the island. */
  laneSignAhead: 340,    // world units ahead of the camera
  laneSignRise:  34,     // sign floats this far above the top of its disc
  laneSignW:     230,    // quad width in world units at that distance
  laneSignH:     32.3,   // quad height (atlas rows are 512x72 = the same ratio)
  laneSignNear:  0.95,   // opacity of the disc you are looking at
  laneSignSide:  0.26,   // opacity of its constellation neighbours
  laneSignEdge:  0.85,   // NDC radius past which even the near sign fades out

  /* ---- free look (drag to rotate) --------------------------------
     Two ways to move, and the split is deliberate:

       WHEEL / TOUCH SWIPE — fly along the direction you are LOOKING. Turn
       to face a lane and push, and you go toward it. This is the browsing
       control, and the one that has to feel like a glide.

       KEYBOARD (arrows / PageUp / PageDown / Home / End) — pure time travel
       along the Z axis, whatever direction you are facing. This is the
       scrubbing control: it cannot take you off the time axis, so there is
       always one input that behaves exactly like the old absolute rail.

     Either way the YEAR readout is computed from the camera's ACTUAL Z, so
     it stays truthful however you got there. */
  lookSensX:    0.0045,  // radians of yaw per pixel dragged (~250px = 65°)
  lookSensY:    0.0035,  // radians of pitch per pixel dragged
  lookEase:     0.075,   // rotation smoothing — same weighted glide as the rail
  lookInertia:  0.90,    // per-frame decay of a released flick (0 = no coasting)
  maxPitch:     1.40,    // ±80°: never quite over the pole, never gimbal-locked.
                         // The unbuilt band thins out past ~35° of pitch, so the
                         // top of this range looks at bare sky; raising yUnbuilt
                         // is what fills it, not clamping this lower.
  invertY:      false,   // flip if pushing the world down should look down
  clickSlop:    7,       // px of travel before a press counts as a drag, not a click
  idleRecenter: 0,       // >0 = radians/sec of gentle auto-return to forward (0 = off)
  idleDelay:    3.0,     // seconds of stillness before idleRecenter kicks in
};

const TAU = Math.PI * 2;
/** Shortest signed angle equivalent of a, in (-PI, PI]. */
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const ERAS = [
  [1600, 'THE FIRST DREAMERS'], [1800, 'THE ROMANTIC AGE'],
  [1860, 'THE VERNE ERA'],      [1895, 'THE SCIENTIFIC ROMANCE'],
  [1926, 'THE PULP EXPLOSION'], [1938, 'THE GOLDEN AGE'],
  [1960, 'THE NEW WAVE'],       [1980, 'THE CYBERPUNK YEARS'],
  [2000, 'THE NETWORKED AGE'],  [2015, 'THE PRESENT TENSE'],
];
function eraName(y) {
  let n = ERAS[0][1];
  for (const [start, name] of ERAS) if (y >= start) n = name;
  return n;
}

/* ============================ 2. LAYOUT ============================= */

/** Stable string hash -> uint32. */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
/** hash -> float in [0,1) */
const hashUnit = (s) => hash32(s) / 4294967296;

/**
 * Z (depth) from the year an idea was predicted.
 * Non-linear: age^p, so 1850+ (where most rows live) gets the room,
 * and the sparse 1634-1800 stretch is compressed into the far distance.
 * Returns a POSITIVE depth; scene objects sit at z = -depth.
 */
function depthForYear(year) {
  const y = Number.isFinite(year) ? year : CFG.yearNow;
  const age = Math.max(0, CFG.yearNow - y);
  return CFG.depthK * Math.pow(age, CFG.depthP);
}
/** Inverse, for the year HUD. */
function yearForDepth(depth) {
  const d = Math.max(0, depth);
  const age = Math.pow(d / CFG.depthK, 1 / CFG.depthP);
  return CFG.yearNow - age;
}

/* ---- LEGACY Y: built low, fiction high ----------------------------
   Only the 'author' and 'novel' strategies use this. The domain
   constellation gives Y a spatial meaning instead, and lets colour and the
   threads carry realization on their own. */
function legacyY(item) {
  const base = item.built ? CFG.yBuilt : CFG.yUnbuilt;
  const jit = (hashUnit('y' + item.id + item.device) - 0.5) * 2 * CFG.yJitter;
  return base + jit;
}

/* ---- XY STRATEGY (swappable) --------------------------------------
   Every strategy is (item) -> {x, y}. It used to be (item) -> x with Y
   nailed to built/unbuilt; the domain constellation needs both axes, so the
   whole cross-section is the strategy's business now. 'domain' is the default
   once domains.json has loaded; setXStrategy('author'|'novel'|'domain'|fn)
   swaps live and re-lays-out the field. */
const XY_STRATEGIES = {
  /** Cluster by author: same author = same lane, jitter per idea. */
  author(item) {
    const key = item.author || 'Unknown';
    // two hashes so lanes don't correlate with alphabet order
    const base = (hashUnit(key) * 2 - 1) * CFG.xSpread;
    const skew = (hashUnit('lane:' + key) - 0.5) * 90; // de-collide near lanes
    const jit  = (hashUnit(key + '|' + item.device + '|' + item.id) - 0.5) * 2 * CFG.xJitter;
    return { x: base + skew + jit, y: legacyY(item) };
  },
  /** Cluster by novel — tighter groups, more of them. */
  novel(item) {
    const key = item.novel || item.author || 'Unknown';
    const base = (hashUnit(key) * 2 - 1) * CFG.xSpread;
    const jit  = (hashUnit(key + item.id) - 0.5) * 2 * CFG.xJitter;
    return { x: base + jit, y: legacyY(item) };
  },
  /**
   * Subject domain: fourteen islands in the XY cross-section. Positions are
   * precomputed by buildDomainLayout() because an idea's place inside its disc
   * depends on its `subject`'s hashed anchor, not on the item alone. Falls back
   * to the author field if domains.json never loaded, so the site still runs
   * unclassified.
   */
  domain(item) {
    const p = DOMAIN_XY.get(item.id);
    return p === undefined ? XY_STRATEGIES.author(item) : p;
  },
};
/** Back-compat alias — the debug handle and old console snippets use this. */
const X_STRATEGIES = XY_STRATEGIES;
let xStrategy = XY_STRATEGIES.author;
let xStrategyName = 'author';

/**
 * Swap the cross-section and RE-LAY-OUT what is already on screen: node
 * positions are baked into the instance matrices and the thread arcs at build
 * time, so changing the function alone would do nothing visible.
 */
function setXStrategy(nameOrFn) {
  if (typeof nameOrFn === 'function') { xStrategy = nameOrFn; xStrategyName = 'custom'; }
  else {
    xStrategyName = XY_STRATEGIES[nameOrFn] ? nameOrFn : 'author';
    xStrategy = XY_STRATEGIES[xStrategyName];
  }
  if (S.nodes.length) relayoutXY();
  return xStrategyName;
}
window.setXStrategy = setXStrategy; // handy from the console

/** Recompute every node's XY in place, then rebuild everything keyed to it. */
function relayoutXY() {
  for (const n of S.nodes) {
    const p = positionForItem(n.item);
    n.x = Number.isFinite(p.x) ? p.x : 0;
    n.y = Number.isFinite(p.y) ? p.y : 0;
  }
  rebuildThreads();
  buildBridges();
  buildEnvelope();
  if (LANE_SIGNS.mesh) LANE_SIGNS.mesh.visible = xStrategyName === 'domain';
  // instance matrices are rewritten every frame by updateInstances()
}
const relayoutX = relayoutXY;   // old name, kept for the console

/* ---- THE FOURTEEN ISLANDS -----------------------------------------
   Order is load-bearing: it runs matter -> information. This list is the
   single source of truth for domain order in the UI; classify-domains.js
   holds the identical list (with its glosses) for the classifier. */
const DOMAINS = [
  ['materials',    'MATERIALS & MAKING'],
  ['energy',       'ENERGY & ENVIRONMENT'],
  ['transport',    'TRANSPORT & VEHICLES'],
  ['space',        'SPACE & FLIGHT'],
  ['weapons',      'WEAPONS & WARFARE'],
  ['robots',       'ROBOTS & AUTOMATA'],
  ['living',       'FOOD & DAILY LIFE'],
  ['medicine',     'MEDICINE & THE BODY'],
  ['bio',          'GENETICS & LIFE'],
  ['mind',         'MIND & PERCEPTION'],
  ['society',      'SOCIETY & ECONOMY'],
  ['surveillance', 'SURVEILLANCE & IDENTITY'],
  ['comms',        'COMMUNICATION & MEDIA'],
  ['computing',    'COMPUTING & INTELLIGENCE'],
];
const DOMAIN_ORDER = DOMAINS.map((d) => d[0]);
const DOMAIN_LABEL = Object.fromEntries(DOMAINS);

/* ---- THE COMPOSITION ----------------------------------------------
   Hand-placed disc CENTRES. These are a composition, not an algorithm: a
   packing solver gets you fourteen circles and no reading. The constellation
   sweeps matter -> information as a rough S:

       materials sits alone in the lower left, the raw stuff;
       energy / transport / space climb the left edge and arc over the top,
         which is the "outward" arm — bigger machines, further away;
       weapons and robots hold the middle, where the made thing acquires
         will of its own;
       living / medicine / bio run along the bottom right — the body, and
         what is done to it;
       mind, society and surveillance stack up the right edge, the step from
         one head to many;
       comms and computing close the loop at the top right: pure information,
         diagonally opposite the raw materials they started as.

   Adjacencies the taxonomy demands are all honoured as literal neighbours:
   space-transport, robots-weapons, medicine-bio, mind-comms, comms-computing,
   computing-surveillance.

   RADIUS is NOT here: it comes from sqrt(population) at load, so the
   composition survives the data changing under it. If you move a centre, run
   the overlap check in buildDomainLayout()'s return value — it reports the
   tightest gap in the constellation and warns if any two discs touch. */
const DOMAIN_DISCS = {
  materials:    [-470, -150],
  energy:       [-495,   30],
  transport:    [-360,  160],
  space:        [-165,  205],
  weapons:      [-235,  -45],
  robots:       [ -40,   35],
  living:       [-150, -195],
  medicine:     [  95, -205],
  bio:          [ 275, -110],
  mind:         [ 205,   70],
  society:      [ 395,  -30],
  surveillance: [ 440,  120],
  comms:        [ 135,  225],
  computing:    [ 350,  245],
};

/** id -> {x,y}, filled by buildDomainLayout(). Empty = unclassified dataset. */
const DOMAIN_XY = new Map();
/** Legacy view: id -> x only. Kept because the debug handle exposes it. */
const DOMAIN_X = new Map();
/** Per-disc geometry, in taxonomy order: {slug,label,count,cx,cy,r,share}. */
let LANES = [];
/** slug -> disc, for O(1) lookup. */
let DISC_BY_SLUG = new Map();
/** [{a,b,count,gap}] — the adjacency graph, strongest co-occurrences first. */
let BRIDGES = [];

/**
 * Place every idea inside its domain's disc.
 *
 * Disc radius = discK * sqrt(count): equal-area-per-idea, so a 527-idea
 * island is not five times denser than a 134-idea one, just bigger.
 *
 * Inside a disc, an idea's home is its SUBJECT's anchor, not its own: the
 * subject string hashes to a (angle, radius) pair — radius via sqrt() so the
 * anchors spread evenly over the disc's area instead of crowding the middle —
 * and the idea then jitters a little way around that anchor. So every idea
 * about "video telephone" is one small knot inside COMMUNICATION & MEDIA,
 * and the knot is in the same place at every year of the river.
 */
function buildDomainLayout(items) {
  DOMAIN_XY.clear();
  DOMAIN_X.clear();
  LANES = [];
  DISC_BY_SLUG = new Map();
  const byDomain = new Map(DOMAIN_ORDER.map((s) => [s, []]));
  let unclassified = 0;
  for (const it of items) {
    const list = byDomain.get(it.domain);
    if (list) list.push(it); else unclassified++;
  }
  const total = DOMAIN_ORDER.reduce((a, s) => a + byDomain.get(s).length, 0);
  if (!total) return { discs: 0, unclassified };

  DOMAIN_ORDER.forEach((slug) => {
    const list = byDomain.get(slug);
    if (!list.length) return;
    const c = DOMAIN_DISCS[slug] || [0, 0];
    const r = CFG.discK * Math.sqrt(list.length);
    const disc = {
      slug, label: DOMAIN_LABEL[slug], count: list.length,
      cx: c[0], cy: c[1], r, share: list.length / total,
      // kept so anything still reading the old lane fields gets something sane
      x0: c[0] - r, x1: c[0] + r,
    };
    LANES.push(disc);
    DISC_BY_SLUG.set(slug, disc);

    const anchorR = r * CFG.discFill;
    const jitR = Math.max(r * CFG.subjectSpread, CFG.subjectMinR);
    for (const it of list) {
      const subj = it.subject || ('~' + it.device);
      const ang = hashUnit('sa|' + slug + '|' + subj) * TAU;
      const rad = Math.sqrt(hashUnit('sr|' + slug + '|' + subj)) * anchorR;
      let x = c[0] + Math.cos(ang) * rad;
      let y = c[1] + Math.sin(ang) * rad;
      // per-idea jitter around the subject knot, again sqrt-weighted
      const ja = hashUnit('ja|' + it.id + '|' + it.device) * TAU;
      const jr = Math.sqrt(hashUnit('jr|' + it.id + '|' + it.device)) * jitR;
      x += Math.cos(ja) * jr;
      y += Math.sin(ja) * jr;
      // never let the jitter push an idea out of its own island
      const dx = x - c[0], dy = y - c[1];
      const d = Math.hypot(dx, dy);
      const lim = r * 0.97;
      if (d > lim) { const k = lim / d; x = c[0] + dx * k; y = c[1] + dy * k; }
      DOMAIN_XY.set(it.id, { x, y });
      DOMAIN_X.set(it.id, x);
    }
  });

  // --- overlap audit: the composition is by hand, so check it by machine ---
  let tightest = Infinity, tightestPair = null, overlaps = 0;
  for (let i = 0; i < LANES.length; i++) {
    for (let j = i + 1; j < LANES.length; j++) {
      const A = LANES[i], B = LANES[j];
      const gap = Math.hypot(A.cx - B.cx, A.cy - B.cy) - A.r - B.r;
      if (gap < tightest) { tightest = gap; tightestPair = A.slug + '/' + B.slug; }
      if (gap <= 0) {
        overlaps++;
        console.warn('[idea-bank] discs overlap:', A.slug, B.slug, gap.toFixed(1));
      }
    }
  }
  buildBridgeGraph(items);
  return {
    discs: LANES.length, unclassified, overlaps,
    tightest: +tightest.toFixed(1), tightestPair, bridges: BRIDGES.length,
  };
}

/**
 * Which islands get a rope between them?
 *
 * Two conditions, both required. ADJACENCY is spatial — the gap of empty sky
 * between the two discs has to be under CFG.bridgeGap, so a bridge is always a
 * short hop you can see both ends of, never a wire across the whole sky.
 * AFFINITY is from the data — how many single novels put ideas in both
 * domains. Ranked by affinity, top CFG.bridgeTop kept.
 *
 * Cost: one pass over 3,746 rows, a Set per novel. Runs once at load.
 */
function buildBridgeGraph(items) {
  BRIDGES = [];
  const byNovel = new Map();
  for (const it of items) {
    if (!it.domain || !DISC_BY_SLUG.has(it.domain)) continue;
    const k = (it.novel || '') + '' + (it.author || '');
    if (k === '') continue;
    let s = byNovel.get(k);
    if (!s) byNovel.set(k, (s = new Set()));
    s.add(it.domain);
  }
  const co = new Map();
  for (const s of byNovel.values()) {
    if (s.size < 2) continue;
    const a = [...s];
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++) {
        const k = a[i] < a[j] ? a[i] + '~' + a[j] : a[j] + '~' + a[i];
        co.set(k, (co.get(k) || 0) + 1);
      }
  }
  const cand = [];
  for (let i = 0; i < LANES.length; i++) {
    for (let j = i + 1; j < LANES.length; j++) {
      const A = LANES[i], B = LANES[j];
      const gap = Math.hypot(A.cx - B.cx, A.cy - B.cy) - A.r - B.r;
      if (gap > CFG.bridgeGap) continue;          // not neighbours
      const k = A.slug < B.slug ? A.slug + '~' + B.slug : B.slug + '~' + A.slug;
      const count = co.get(k) || 0;
      if (!count) continue;                        // no shared novels, no rope
      cand.push({ a: A.slug, b: B.slug, count, gap: +gap.toFixed(1) });
    }
  }
  cand.sort((x, y) => y.count - x.count);
  BRIDGES = cand.slice(0, CFG.bridgeTop);
  // every disc's constellation neighbours, for the sign fade
  for (const d of LANES) d.near = [];
  for (const br of BRIDGES) {
    DISC_BY_SLUG.get(br.a)?.near.push(br.b);
    DISC_BY_SLUG.get(br.b)?.near.push(br.a);
  }
  return BRIDGES;
}

/**
 * Depth convergence. With CFG.xTaper > 0 the cross-section narrows as we
 * travel back, which keeps the sparse early centuries in frame — but it also
 * makes XY mean different things at different depths, which smears the islands
 * into each other. Normally off (xTaper = 0); perspective does the converging.
 */
const taperAt = (depth) => (CFG.xTaper > 0 ? 1 / (1 + depth / CFG.xTaper) : 1);

/** Full position for an idea. */
function positionForItem(item) {
  const depth = depthForYear(item.year);
  const t = taperAt(depth);
  const p = xStrategy(item);
  return { x: p.x * t, y: p.y * t, z: -depth };
}

/* ============================= STATE ================================ */

const S = {
  items: [],
  nodes: [],          // {item, x,y,z, mesh:'bits'|'atoms', localIndex}
  meshes: {},         // bits / atoms InstancedMesh
  threadLine: null,
  scene: null, camera: null, renderer: null, raycaster: null,
  /* Camera POSITION is the primitive now, not depth-along-a-rail: the wheel
     flies along the view vector, so the camera is a free point in space.
     "Depth" (and therefore the YEAR plate) is a READING taken off that
     point's Z every frame — see depthForZ() — which is what keeps the HUD
     honest no matter how diagonally you arrived. */
  pos: new THREE.Vector3(), posTarget: new THREE.Vector3(),
  depthCur: 0, depthMax: 1,
  env: null,          // {min, max} data envelope, built once from the nodes
  // free look: yaw 0 = facing the past (down -Z), pitch = CFG.camTilt at rest
  yaw: 0, yawTarget: 0, pitch: 0, pitchTarget: 0,
  yawVel: 0, pitchVel: 0, lastLookAt: 0,
  dragging: false, lastPointer: { x: 0, y: 0 },
  pointerNDC: new THREE.Vector2(9, 9),
  pointerPx: { x: -400, y: -400 },   // last cursor position, for tooltip placement
  hovered: null, selected: null,
  unbuiltOnly: false,
  query: '', queryRaw: '', matchCount: 0,   // search (see 5b)
  flyTo: null,        // Vector3 destination when a button flew us somewhere
  clock: null,
  labelPool: [],
};

/* Depth <-> camera Z. The camera sits CFG.camAhead toward the present of the
   depth it is "at", so these two are exact inverses and nothing else in the
   file is allowed to convert between the two by hand. */
const zForDepth = (d) => CFG.camAhead - d;
const depthForZ = (z) => CFG.camAhead - z;

/* The old S.depthTarget still exists, as a VIEW of the position target's Z.
   Keyboard time-travel writes it; the HUD's projected year and the tests read
   it; nothing has to know the camera became a free point. */
Object.defineProperty(S, 'depthTarget', {
  get() { return depthForZ(S.posTarget.z); },
  set(d) { S.posTarget.z = zForDepth(clampDepth(d)); },
});

/* ============================== 3. BUILD ============================ */

function initScene() {
  const canvas = document.getElementById('scene');
  S.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  S.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  S.renderer.setSize(innerWidth, innerHeight, false);
  S.renderer.setClearColor(PALETTE.paper, 1);

  S.scene = new THREE.Scene();
  S.scene.fog = new THREE.FogExp2(PALETTE.fog, 0.00085);

  S.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 6000);

  // Light: soft paper-lit studio, no harsh cyberpunk contrast.
  S.scene.add(new THREE.HemisphereLight(0xFFF6E4, 0xB89A72, 1.15));
  const key = new THREE.DirectionalLight(0xFFE9C8, 1.25);
  key.position.set(-0.6, 1, 0.5);
  S.scene.add(key);
  const rim = new THREE.DirectionalLight(0x8FC6C2, 0.55);
  rim.position.set(0.8, -0.3, -0.6);
  S.scene.add(rim);

  S.raycaster = new THREE.Raycaster();
  S.raycaster.params.Points = { threshold: 6 };
  S.t0 = performance.now();
}

/** Colour for an idea — pulp palette, keyed to status + era. */
const _c = new THREE.Color();
function colorForItem(item) {
  if (item.built) {
    // realized: warm side of the palette, older = deeper rust
    const t = THREE.MathUtils.clamp((item.year - 1850) / 170, 0, 1);
    return _c.setHex(PALETTE.rust).lerp(new THREE.Color(PALETTE.orange), t);
  }
  // still fiction: cool side, older predictions sitting deeper toward ink.
  // Every colour on screen has to mean something — an earlier version threw a
  // random 22% of these to mustard purely for visual texture, which just made
  // viewers hunt for a third status that does not exist.
  const t = THREE.MathUtils.clamp((item.year - 1850) / 170, 0, 1);
  return _c.setHex(PALETTE.ink).lerp(new THREE.Color(PALETTE.teal), 0.35 + 0.65 * t);
}

function buildNodes(items) {
  const geo = new THREE.SphereGeometry(1, 14, 10);

  // Two instanced meshes so Bits and Atoms can read as different substances.
  const matAtoms = new THREE.MeshStandardMaterial({
    roughness: 0.98, metalness: 0.0, flatShading: false,
  });
  const matBits = new THREE.MeshStandardMaterial({
    roughness: 0.18, metalness: 0.05,
    transparent: true, opacity: 0.62,
    emissive: new THREE.Color(0x2A6E78), emissiveIntensity: 0.55,
    depthWrite: false,
  });

  const groups = { atoms: [], bits: [] };
  for (const item of items) {
    const p = positionForItem(item);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    const bucket = item.kind === 'bits' ? 'bits' : 'atoms';
    groups[bucket].push({ item, ...p, bucket });
  }

  S.nodes = [];
  for (const bucket of ['atoms', 'bits']) {
    const list = groups[bucket];
    const mesh = new THREE.InstancedMesh(
      geo, bucket === 'bits' ? matBits : matAtoms, Math.max(list.length, 1)
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = list.length;
    mesh.frustumCulled = false;
    mesh.userData.bucket = bucket;
    mesh.userData.nodes = list;
    mesh.renderOrder = bucket === 'bits' ? 2 : 1;

    const dummy = new THREE.Object3D();
    list.forEach((n, i) => {
      n.localIndex = i;
      n.mesh = bucket;
      n.radius = (n.item.built ? CFG.radiusBuilt : CFG.radiusUnbuilt) *
                 (0.82 + hashUnit('r' + n.item.id) * 0.5);
      n.bobPhase = hashUnit('b' + n.item.id) * Math.PI * 2;
      n.baseColor = colorForItem(n.item).clone();
      dummy.position.set(n.x, n.y, n.z);
      dummy.scale.setScalar(n.radius);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, n.baseColor);
      S.nodes.push(n);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    S.meshes[bucket] = mesh;
    S.scene.add(mesh);
  }
}

/**
 * Threads: for every realized idea, a thin arc from the prediction node
 * toward the same idea's realization year on the Z axis. The visible
 * length of the arc IS the prediction->reality lag.
 */
/* Uniform objects are created once and handed to every compiled program, so
   applyThreadTuning() can retune the arcs live from CFG (console or tests)
   without recompiling anything. */
const THREAD_U = {
  uFadeNear: { value: 220 },
  uFadeFar:  { value: 950 },
  uFadeMin:  { value: 0.09 },
};

/** Push CFG's thread knobs into the live material + uniforms. */
function applyThreadTuning() {
  THREAD_U.uFadeNear.value = CFG.threadFadeNear;
  THREAD_U.uFadeFar.value = Math.max(CFG.threadFadeFar, CFG.threadFadeNear + 1);
  THREAD_U.uFadeMin.value = CFG.threadFadeMin;
  if (S.threadLine) S.threadLine.material.opacity = CFG.threadOpacity;
}

function buildThreads() {
  const SEG = 14;
  const pos = [];
  const col = [];
  const dim = [];   // per-vertex filter weight, rewritten by applyFilter()
  const cA = new THREE.Color(PALETTE.orange);
  const cB = new THREE.Color(PALETTE.mustard);
  const tmp = new THREE.Vector3();

  for (const n of S.nodes) {
    n.threadV0 = -1; n.threadVN = 0;
    const it = n.item;
    if (!it.built || !Number.isFinite(it.realYear)) continue;
    if (it.realYear <= it.year) continue;
    n.realDepth = depthForYear(it.realYear);
    const v0 = pos.length / 3;   // first vertex of THIS arc, for per-arc fading
    /* A thread now runs from the idea to the SAME PLACE IN THE CROSS-SECTION
       at the year it came true — it stays inside its own island for the whole
       length of the lag, so following a thread never carries you out of the
       domain you were reading. (It used to converge on a single "realized"
       band, which only made sense while Y meant built/unbuilt.) The sag is
       what still reads as falling to earth. */
    const start = new THREE.Vector3(n.x, n.y, n.z);
    const end = new THREE.Vector3(n.x, n.y, -n.realDepth);
    // control point sags below, giving a hanging-cable feel
    const sag = 22 + Math.min(140, Math.abs(end.z - start.z) * 0.10);
    const ctrl = new THREE.Vector3(
      (start.x + end.x) / 2,
      Math.min(start.y, end.y) - sag,
      (start.z + end.z) / 2
    );
    let prev = null;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const mt = 1 - t;
      tmp.set(
        mt * mt * start.x + 2 * mt * t * ctrl.x + t * t * end.x,
        mt * mt * start.y + 2 * mt * t * ctrl.y + t * t * end.y,
        mt * mt * start.z + 2 * mt * t * ctrl.z + t * t * end.z
      );
      if (!Number.isFinite(tmp.x) || !Number.isFinite(tmp.z)) { prev = null; continue; }
      if (prev) {
        pos.push(prev.x, prev.y, prev.z, tmp.x, tmp.y, tmp.z);
        const f = 1 - t;
        _c.copy(cA).lerp(cB, t);
        col.push(_c.r, _c.g, _c.b, _c.r * f + 0.35, _c.g * f + 0.35, _c.b * f + 0.35);
        dim.push(1, 1);
      }
      prev = tmp.clone();
    }
    n.threadEnd = end;
    n.threadV0 = v0;
    n.threadVN = pos.length / 3 - v0;
  }

  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const aDim = new THREE.Float32BufferAttribute(dim, 1);
  aDim.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aDim', aDim);

  /* Still ONE LineBasicMaterial and ONE draw call for all 687 arcs — the two
     new behaviours are patched into the stock shader rather than replacing it,
     so fog, vertex colours and the material's own opacity all keep working:

       aDim        per-vertex, per-arc: the filters' handle on an individual
                   thread. Fading arcs one by one is what lets UNBUILT ONLY and
                   the search dim the threads that belong to washed-out nodes
                   instead of dimming the whole bundle.
       distance    computed in the vertex shader from view-space depth. Arcs
                   near the eye keep their weight, far ones sink toward
                   uFadeMin, so the ground band stops reading as a wash.

     Nothing is dropped or culled: a far arc is still drawn, still there if you
     fly to it. */
  const m = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: CFG.threadOpacity, depthWrite: false,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeNear = THREAD_U.uFadeNear;
    shader.uniforms.uFadeFar = THREAD_U.uFadeFar;
    shader.uniforms.uFadeMin = THREAD_U.uFadeMin;
    shader.vertexShader =
      'attribute float aDim;\nvarying float vThreadA;\n' +
      'uniform float uFadeNear;\nuniform float uFadeFar;\nuniform float uFadeMin;\n' +
      shader.vertexShader.replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
         float _td = -mvPosition.z;
         float _tf = 1.0 - smoothstep(uFadeNear, uFadeFar, _td);
         vThreadA = aDim * mix(uFadeMin, 1.0, _tf);`);
    shader.fragmentShader =
      'varying float vThreadA;\n' +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.a *= vThreadA;');
  };
  m.customProgramCacheKey = () => 'thread-fade-v1';

  S.threadLine = new THREE.LineSegments(g, m);
  S.threadLine.frustumCulled = false;
  S.threadLine.renderOrder = 0;
  S.scene.add(S.threadLine);
  applyThreadTuning();
}

/** Throw the old arcs away and re-trace them — after an X-axis change. */
function rebuildThreads() {
  if (S.threadLine) {
    S.scene.remove(S.threadLine);
    S.threadLine.geometry.dispose();
    S.threadLine.material.dispose();
    S.threadLine = null;
  }
  buildThreads();
  applyFilter();   // the filter owns the thread opacity
}

/* -------------------------- THE BRIDGES ----------------------------
   Garnish, and deliberately built as garnish: ONE static LineSegments, one
   draw call, no per-frame work at all. For each adjacent+co-occurring pair
   of islands, a sagging rope from centre to centre, repeated every
   CFG.bridgeEveryYr years down the river — so however far back you fly there
   is always one near you, and the constellation reads as connected rather
   than as fourteen unrelated shafts.

   Repeating them beats one camera-following arc: no update cost, and the
   ropes are then part of the field's geometry (they recede with the fog and
   parallax properly) instead of a HUD element pretending to be in the world. */
const BRIDGE = { mesh: null };

function buildBridges() {
  if (BRIDGE.mesh) {
    S.scene.remove(BRIDGE.mesh);
    BRIDGE.mesh.geometry.dispose();
    BRIDGE.mesh.material.dispose();
    BRIDGE.mesh = null;
  }
  if (xStrategyName !== 'domain' || !BRIDGES.length) return;

  const pos = [];
  const SEG = Math.max(2, CFG.bridgeSegs | 0);
  const step = Math.max(60, CFG.bridgeEveryZ);
  const far = Math.max(S.depthMax || 0, depthForYear(CFG.yearFloor));
  for (let d = step * 0.5; d <= far; d += step) {
    const z = -d;
    for (const br of BRIDGES) {
      const A = DISC_BY_SLUG.get(br.a), B = DISC_BY_SLUG.get(br.b);
      if (!A || !B) continue;
      const span = Math.hypot(A.cx - B.cx, A.cy - B.cy);
      const drop = span * CFG.bridgeSag;
      let px = 0, py = 0;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const x = A.cx + (B.cx - A.cx) * t;
        // a parabola in Y is a close enough catenary at this size and costs
        // nothing; 4t(1-t) is 0 at both ends and 1 in the middle
        const y = A.cy + (B.cy - A.cy) * t - drop * 4 * t * (1 - t);
        if (s) pos.push(px, py, z, x, y, z);
        px = x; py = y;
      }
    }
  }
  if (!pos.length) return;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.LineBasicMaterial({
    color: PALETTE.ink, transparent: true,
    opacity: CFG.bridgeOpacity, depthWrite: false, fog: true,
  });
  const mesh = new THREE.LineSegments(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;   // under the nodes and the threads: it is background
  S.scene.add(mesh);
  BRIDGE.mesh = mesh;
}

/* ---------------------- FLOATING DOMAIN SIGNS ----------------------
   All fourteen names live in ONE canvas atlas on ONE merged quad strip:
   +1 draw call, not +14. The quads are billboarded in the VERTEX SHADER
   (corner offsets are added in view space) so they always face the camera
   with no roll, at constant on-screen size, however far the head is turned.
   Per-lane opacity is a vertex attribute — 56 floats rewritten per frame,
   which is cheaper than touching a uniform per object would be.          */

const LANE_SIGNS = { mesh: null, geo: null, tex: null };

function buildLaneSigns() {
  if (LANE_SIGNS.mesh) {
    S.scene.remove(LANE_SIGNS.mesh);
    LANE_SIGNS.geo.dispose();
    LANE_SIGNS.mesh.material.dispose();
    LANE_SIGNS.tex.dispose();
    LANE_SIGNS.mesh = null;
  }
  if (!LANES.length) return;

  const ROW_W = 512, ROW_H = 72;
  const cv = document.createElement('canvas');
  cv.width = ROW_W;
  cv.height = ROW_H * LANES.length;
  const g = cv.getContext('2d');
  const inkCSS = '#' + PALETTE.ink.toString(16).padStart(6, '0');
  const paperCSS = '#' + PALETTE.paper.toString(16).padStart(6, '0');
  const rustCSS = '#' + PALETTE.rust.toString(16).padStart(6, '0');

  LANES.forEach((L, i) => {
    const y0 = i * ROW_H;
    g.save();
    g.translate(0, y0);
    // pulp signboard: cream plate, hard offset shadow, ink rule under the name
    g.fillStyle = rustCSS;
    g.globalAlpha = 0.55;
    g.fillRect(12, 12, ROW_W - 20, ROW_H - 22);
    g.globalAlpha = 1;
    g.fillStyle = paperCSS;
    g.fillRect(6, 6, ROW_W - 20, ROW_H - 22);
    g.strokeStyle = inkCSS;
    g.lineWidth = 3;
    g.strokeRect(6, 6, ROW_W - 20, ROW_H - 22);

    g.fillStyle = inkCSS;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    try { g.letterSpacing = '3px'; } catch (_) {}
    // shrink to fit rather than overflow the plate
    let size = 30;
    g.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
    while (size > 12 && g.measureText(L.label).width > ROW_W - 56) {
      size -= 1;
      g.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
    }
    g.fillText(L.label, (ROW_W - 14) / 2 + 6, ROW_H / 2 - 2);
    g.restore();
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;

  const n = LANES.length;
  const position = new Float32Array(n * 4 * 3); // per-vertex world anchor
  const corner = new Float32Array(n * 4 * 2);   // view-space offset
  const uv = new Float32Array(n * 4 * 2);
  const alpha = new Float32Array(n * 4);
  const index = [];
  const hw = CFG.laneSignW / 2, hh = CFG.laneSignH / 2;
  for (let i = 0; i < n; i++) {
    const v = i * 4;
    const v0 = i / n, v1 = (i + 1) / n;
    // canvas row 0 is the TOP of the atlas, UV v=1 is the top -> flip
    const corners = [[-hw, -hh, 0, 1 - v1], [hw, -hh, 1, 1 - v1],
                     [hw, hh, 1, 1 - v0], [-hw, hh, 0, 1 - v0]];
    corners.forEach((c, k) => {
      corner[(v + k) * 2] = c[0];
      corner[(v + k) * 2 + 1] = c[1];
      uv[(v + k) * 2] = c[2];
      uv[(v + k) * 2 + 1] = c[3];
    });
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setIndex(index);
  geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
  geo.attributes.aAlpha.setUsage(THREE.DynamicDrawUsage);

  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex } },
    transparent: true,
    depthWrite: false,
    depthTest: false,   // signs float over the field, never half-buried in it
    // fog is deliberately NOT applied: a sign 340 units out would be washed
    // to nothing by the haze, and the whole point is that it stays readable.
    vertexShader: `
      attribute vec2 aCorner;
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aCorner;              // billboard: offset in view space
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.004) discard;
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(t.rgb, t.a * vAlpha);
        if (gl_FragColor.a < 0.01) discard;
        #include <colorspace_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = xStrategyName === 'domain';
  S.scene.add(mesh);
  LANE_SIGNS.mesh = mesh;
  LANE_SIGNS.geo = geo;
  LANE_SIGNS.tex = tex;
}

const _signV = new THREE.Vector3();
const _signNdc = [];
/**
 * Park the signs a fixed distance ahead of the camera, each hanging just above
 * the top of its OWN disc, then light up the island nearest the centre of view
 * and ghost in the ones it is roped to.
 *
 * The "nearest" test used to be |ndc.x| — with lanes, only sideways mattered.
 * The cross-section is two-dimensional now, so it is the NDC RADIUS: look up
 * at COMPUTING and COMPUTING lights, look down at MEDICINE and MEDICINE does.
 * Cost: fourteen projections and 70 float writes a frame, unchanged.
 */
function updateLaneSigns() {
  const mesh = LANE_SIGNS.mesh;
  if (!mesh || !mesh.visible) return;
  const n = LANES.length;
  const depth = S.depthCur + CFG.laneSignAhead;
  const taper = taperAt(depth);
  const z = -depth;
  const pos = LANE_SIGNS.geo.attributes.position;
  const alpha = LANE_SIGNS.geo.attributes.aAlpha;
  const P = pos.array, A = alpha.array;

  // pass 1 — where does each sign land on screen?
  let best = -1, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const L = LANES[i];
    const x = L.cx * taper;
    const y = (L.cy + L.r + CFG.laneSignRise) * taper;
    _signV.set(x, y, z).applyMatrix4(S.camera.matrixWorldInverse);
    let nd = Infinity;
    if (-_signV.z > 40) {                       // in front of the eye
      _signV.applyMatrix4(S.camera.projectionMatrix);
      if (Number.isFinite(_signV.x) && Number.isFinite(_signV.y)) {
        nd = Math.hypot(_signV.x, _signV.y * 0.8);   // slight sideways bias:
      }                                              // the field is wider than tall
    }
    _signNdc[i] = nd;
    if (nd < bestD) { bestD = nd; best = i; }
    for (let k = 0; k < 4; k++) {
      const v = (i * 4 + k) * 3;
      P[v] = x; P[v + 1] = y; P[v + 2] = z;
    }
  }

  // pass 2 — opacity by rank, not by raw distance, so exactly one sign reads
  // as "the island you are facing" however unevenly they are spaced.
  const nearOf = best >= 0 ? (LANES[best].near || []) : [];
  for (let i = 0; i < n; i++) {
    const nd = _signNdc[i];
    let a = 0;
    if (Number.isFinite(nd) && nd < CFG.laneSignEdge) {
      // past the edge of the screen even the winner is on its way out
      const edge = THREE.MathUtils.clamp((CFG.laneSignEdge - nd) / 0.25, 0, 1);
      const base = i === best ? CFG.laneSignNear
                 : nearOf.includes(LANES[i].slug) ? CFG.laneSignSide : 0;
      a = base * edge * edge * (3 - 2 * edge);
    }
    for (let k = 0; k < 4; k++) A[i * 4 + k] = a;
  }
  pos.needsUpdate = true;
  alpha.needsUpdate = true;
}

/** A faint horizon plate + drifting dust so the void reads as *space*. */
function buildAtmosphere() {
  const depth = S.depthMax + 600;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(4200, depth + 1200, 1, 1),
    new THREE.MeshBasicMaterial({
      color: PALETTE.paper2 || 0xE7D9BE, transparent: true, opacity: 0.35,
      depthWrite: false,
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(0, CFG.groundY, -depth / 2);
  plane.renderOrder = -1;
  S.scene.add(plane);

  // year gridlines every 25 years — faint navigational rungs
  const gp = [];
  for (let y = 1650; y <= CFG.yearNow; y += 25) {
    const z = -depthForYear(y);
    gp.push(-1600, CFG.groundY + 2, z, 1600, CFG.groundY + 2, z);
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  S.scene.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({
    color: PALETTE.ink, transparent: true, opacity: 0.13, depthWrite: false,
  })));

  // dust motes
  const N = 900;
  const dp = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    dp[i * 3]     = (Math.random() * 2 - 1) * 1500;
    dp[i * 3 + 1] = (Math.random() * 2 - 1) * 380 + 20;
    dp[i * 3 + 2] = -Math.random() * depth;
  }
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dg, new THREE.PointsMaterial({
    color: PALETTE.ink, size: 2.1, sizeAttenuation: true,
    transparent: true, opacity: 0.22, depthWrite: false,
  }));
  dust.frustumCulled = false;
  S.scene.add(dust);
}

/* ========================== 4. CAMERA RAIL ========================== */

function initRail() {
  S.depthMax = Math.max(...S.nodes.map((n) => -n.z), 1) + 120;
  S.pos.set(CFG.camHomeX, CFG.camHeight, zForDepth(0));
  S.posTarget.copy(S.pos);
  S.depthCur = 0;
  S.pitch = S.pitchTarget = CFG.camTilt;
  buildEnvelope();

  // WHEEL = fly along the view vector (see flyBy).
  addEventListener('wheel', (e) => {
    flyBy(e.deltaY * CFG.scrollSpeed);
  }, { passive: true });

  addEventListener('keydown', (e) => {
    const el = e.target;
    const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

    /* Esc precedence, most-modal-first: HELP, then the DOSSIER, then the
       SEARCH. One press never dismisses two things, and the search box —
       which is the thing you are most likely to want to keep — is last. */
    if (e.key === 'Escape') {
      const help = document.getElementById('help');
      if (help && !help.hidden) { help.hidden = true; return; }
      if (S.selected) { closeCard(); return; }
      if (S.queryRaw) { clearSearch(); return; }
      if (typing) el.blur();
      return;
    }
    // While the search box has focus every other key belongs to it.
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); focusSearch(); return; }

    // KEYBOARD = pure time travel along Z, whatever direction you are facing.
    const step = e.shiftKey ? 900 : 260;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { S.flyTo = null; S.depthTarget = S.depthTarget + step; }
    if (e.key === 'ArrowUp' || e.key === 'PageUp')     { S.flyTo = null; S.depthTarget = S.depthTarget - step; }
    if (e.key === 'Home')   { S.flyTo = null; S.depthTarget = 0; }
    if (e.key === 'End')    { S.flyTo = null; S.depthTarget = S.depthMax; }
    if (e.key === 'r' || e.key === 'R') randomJump();
    if (e.key === 'v' || e.key === 'V') resetView();
  });

  const canvas = S.renderer.domElement;
  let downAt = 0, moved = 0;

  let touchInput = false;   // touch drives rotation from the touch handlers below

  canvas.addEventListener('pointerdown', (e) => {
    touchInput = e.pointerType === 'touch';
    S.dragging = true; moved = 0; downAt = performance.now();
    S.yawVel = 0; S.pitchVel = 0;
    S.lastPointer = { x: e.clientX, y: e.clientY };
    // capture keeps the drag alive outside the canvas; harmless if refused
    if (!touchInput) { try { canvas.setPointerCapture?.(e.pointerId); } catch (_) {} }
  });
  addEventListener('pointermove', (e) => {
    S.pointerNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    S.pointerPx.x = e.clientX; S.pointerPx.y = e.clientY;
    if (S.dragging && touchInput) {
      moved += Math.abs(e.clientX - S.lastPointer.x) + Math.abs(e.clientY - S.lastPointer.y);
      S.lastPointer = { x: e.clientX, y: e.clientY };
    } else if (S.dragging) {
      const dx = e.clientX - S.lastPointer.x;
      const dy = e.clientY - S.lastPointer.y;
      moved += Math.abs(dx) + Math.abs(dy);
      // Grab-the-world: the scene follows the cursor, the head turns the other way.
      lookBy(dx * CFG.lookSensX, dy * CFG.lookSensY * (CFG.invertY ? -1 : 1));
      S.lastPointer = { x: e.clientX, y: e.clientY };
      hideHint();
    }
    moveTooltip(e.clientX, e.clientY);
  });
  addEventListener('pointerup', (e) => {
    // A drag that turned the head must not also select whatever was under it.
    if (S.dragging && moved < CFG.clickSlop && performance.now() - downAt < 500) {
      S.yawVel = 0; S.pitchVel = 0;
      onClickScene();
    }
    S.dragging = false;
  });
  addEventListener('pointercancel', () => { S.dragging = false; });
  canvas.addEventListener('pointerleave', () => { S.pointerNDC.set(9, 9); });

  // touch: vertical swipe travels through time, horizontal swipe looks around
  let touchX = null, touchY = null;
  canvas.addEventListener('touchstart', (e) => {
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
    S.yawVel = 0; S.pitchVel = 0;
  }, { passive: true });
  canvas.addEventListener('touchend', () => { touchX = touchY = null; }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (touchY == null) return;
    const dy = touchY - e.touches[0].clientY;
    const dx = e.touches[0].clientX - touchX;
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
    if (Math.abs(dx) > Math.abs(dy)) {
      lookBy(dx * CFG.lookSensX, 0);
    } else {
      flyBy(dy * 4.2);   // same rule as the wheel: fly where you are looking
    }
    hideHint();
  }, { passive: true });

  addEventListener('resize', onResize);
}

const clampDepth = (d) => THREE.MathUtils.clamp(
  Number.isFinite(d) ? d : 0, -120, S.depthMax);

/**
 * The box the data actually occupies, plus a margin. Z is pinned to exactly
 * the same range the keyboard rail uses, so the two controls agree about where
 * the corpus ends.
 */
function buildEnvelope() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of S.nodes) {
    if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y;
  }
  if (!Number.isFinite(x0)) { x0 = -CFG.xSpread; x1 = CFG.xSpread; y0 = CFG.yBuilt; y1 = CFG.yUnbuilt; }
  S.env = {
    min: new THREE.Vector3(x0 - CFG.envPadX, y0 - CFG.envPadY, zForDepth(S.depthMax)),
    max: new THREE.Vector3(x1 + CFG.envPadX, y1 + CFG.envPadY, zForDepth(-120)),
  };
}

const _fwd = new THREE.Vector3();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
/**
 * Fly `dist` world units along the direction the view is heading for.
 *
 * The heading is taken from the TARGET yaw/pitch rather than the eased current
 * ones: mid-turn, the wheel should send you where you are turning to look, not
 * where the head happens to have got to this frame. Nothing here is clamped —
 * the envelope's elastic edge (updateCamera) is what stops you, so that
 * overshooting reads as resistance rather than as hitting a wall.
 */
function flyBy(dist) {
  if (!Number.isFinite(dist) || dist === 0) return;
  S.flyTo = null;
  _eul.set(S.pitchTarget, S.yawTarget, 0, 'YXZ');
  _fwd.set(0, 0, -1).applyEuler(_eul);
  if (!Number.isFinite(_fwd.x) || !Number.isFinite(_fwd.y) || !Number.isFinite(_fwd.z)) return;
  S.posTarget.addScaledVector(_fwd, dist);
  hideHint();
}

/**
 * Turn the head. Yaw is unbounded (full 360° and beyond); pitch is clamped
 * short of the pole so the horizon never flips and YXZ never gimbal-locks.
 */
function lookBy(dYaw, dPitch) {
  if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) return;
  S.yawTarget += dYaw;
  S.pitchTarget = THREE.MathUtils.clamp(S.pitchTarget + dPitch, -CFG.maxPitch, CFG.maxPitch);
  // remember the flick so the view coasts to a stop instead of stopping dead
  S.yawVel = dYaw;
  S.pitchVel = dPitch;
  S.lastLookAt = performance.now();
}

/** How far the view has been turned from dead-ahead, in radians. */
function lookOffset() {
  return Math.abs(wrapAngle(S.yaw)) + Math.abs(S.pitch - CFG.camTilt);
}
/** How far the camera has strayed off the centre line of the river, in units. */
function riverOffset() {
  return Math.abs(S.pos.x - CFG.camHomeX) + Math.abs(S.pos.y - CFG.camHeight);
}

/** Ease the head back to facing down the rail, by the shortest way round. */
function resetLook(instant = false) {
  S.yawTarget = Math.round(S.yaw / TAU) * TAU;   // nearest whole turn = shortest path
  S.pitchTarget = CFG.camTilt;
  S.yawVel = 0; S.pitchVel = 0;
  S.lastLookAt = performance.now();
  if (instant) { S.yaw = S.yawTarget; S.pitch = S.pitchTarget; }
}

/**
 * RETURN TO THE RIVER (button, or V).
 *
 * Free flight can leave you off to one side, above the field, or nose-up at
 * blank paper — and once there, "face forward" alone is not enough, because
 * forward from out there is still nothing. So this restores BOTH: orientation
 * AND the lateral/vertical position, gliding back onto the centre line.
 *
 * The one thing it deliberately does NOT change is Z: you come back to the
 * river at the year you had reached, not at the start.
 */
function resetView(instant = false) {
  resetLook(instant);
  S.flyTo = null;
  S.posTarget.x = CFG.camHomeX;
  S.posTarget.y = CFG.camHeight;
  S.posTarget.z = zForDepth(clampDepth(depthForZ(S.posTarget.z)));
  if (instant) S.pos.copy(S.posTarget);
}

function onResize() {
  S.camera.aspect = innerWidth / innerHeight;
  S.camera.updateProjectionMatrix();
  S.renderer.setSize(innerWidth, innerHeight, false);
}

const _envClamped = new THREE.Vector3();
function updateCamera(dt) {
  const frames = dt * 60;

  /* ---- flight ------------------------------------------------------
     Two-stage easing, unchanged in feel: a button-driven flight eases the
     TARGET toward its destination, and the camera then eases toward the
     target. That second lag is the weight — the glide, not a snap. */
  if (S.flyTo) {
    S.posTarget.lerp(S.flyTo, 1 - Math.pow(1 - 0.045, frames));
    if (S.posTarget.distanceToSquared(S.flyTo) < 16) { S.posTarget.copy(S.flyTo); S.flyTo = null; }
  }

  /* ---- the elastic edge of the data --------------------------------
     Outside the envelope the target is dragged back toward it every frame,
     so a wheel push into blank paper decays instead of stranding you; and
     an absolute limit of envSlack past the envelope means no amount of
     spinning the wheel can put the field out of sight. */
  if (S.env) {
    _envClamped.copy(S.posTarget).clamp(S.env.min, S.env.max);
    if (!_envClamped.equals(S.posTarget)) {
      S.posTarget.lerp(_envClamped, 1 - Math.pow(1 - CFG.envElastic, frames));
      const s = CFG.envSlack;
      S.posTarget.x = THREE.MathUtils.clamp(S.posTarget.x, S.env.min.x - s, S.env.max.x + s);
      S.posTarget.y = THREE.MathUtils.clamp(S.posTarget.y, S.env.min.y - s, S.env.max.y + s);
      S.posTarget.z = THREE.MathUtils.clamp(S.posTarget.z, S.env.min.z - s, S.env.max.z + s);
    }
  }

  // frame-rate independent easing
  const k = 1 - Math.pow(1 - CFG.ease, frames);
  S.pos.lerp(S.posTarget, k);
  // A single non-finite frame would poison the year HUD forever; catch it here
  // instead of letting NaN propagate into the matrices.
  if (!Number.isFinite(S.pos.x + S.pos.y + S.pos.z)) {
    S.pos.set(CFG.camHomeX, CFG.camHeight, zForDepth(0));
    S.posTarget.copy(S.pos);
  }
  // THE reading: depth (and so the YEAR plate) comes off the camera's own Z.
  S.depthCur = depthForZ(S.pos.z);

  /* ---- free look --------------------------------------------------- */
  if (S.dragging) {
    // pausing mid-drag should kill the flick, so letting go there stops dead
    const d = Math.pow(0.72, frames);
    S.yawVel *= d; S.pitchVel *= d;
  } else if (S.yawVel || S.pitchVel) {
    // released flick keeps turning, then dies away
    S.yawTarget += S.yawVel * frames;
    S.pitchTarget = THREE.MathUtils.clamp(
      S.pitchTarget + S.pitchVel * frames, -CFG.maxPitch, CFG.maxPitch);
    const decay = Math.pow(CFG.lookInertia, frames);
    S.yawVel *= decay; S.pitchVel *= decay;
    if (Math.abs(S.yawVel) < 1e-5) S.yawVel = 0;
    if (Math.abs(S.pitchVel) < 1e-5) S.pitchVel = 0;
  }
  // optional gentle auto-return once the user has been still for a while
  if (CFG.idleRecenter > 0 && !S.dragging && !S.yawVel && !S.pitchVel &&
      (performance.now() - S.lastLookAt) / 1000 > CFG.idleDelay) {
    const home = Math.round(S.yawTarget / TAU) * TAU;
    const step = CFG.idleRecenter * dt;
    S.yawTarget += THREE.MathUtils.clamp(home - S.yawTarget, -step, step);
    S.pitchTarget += THREE.MathUtils.clamp(CFG.camTilt - S.pitchTarget, -step, step);
  }

  const kr = 1 - Math.pow(1 - CFG.lookEase, frames);
  S.yaw += (S.yawTarget - S.yaw) * kr;
  S.pitch += (S.pitchTarget - S.pitch) * kr;
  // keep the angle bounded without disturbing the motion (identical rotation)
  if (Math.abs(S.yaw) > TAU) {
    const turns = Math.trunc(S.yaw / TAU) * TAU;
    S.yaw -= turns; S.yawTarget -= turns;
  }
  S.pitch = THREE.MathUtils.clamp(S.pitch, -CFG.maxPitch, CFG.maxPitch);

  S.camera.position.copy(S.pos);
  // YXZ: yaw about world up, then pitch about the camera's own right axis.
  // No roll is ever introduced, so the horizon stays level at any heading.
  S.camera.rotation.set(S.pitch, S.yaw, 0, 'YXZ');
  // Labels and picking read the camera matrices this same frame, before
  // render() would refresh them — so refresh them here.
  S.camera.updateMatrixWorld(true);
  S.camera.matrixWorldInverse.copy(S.camera.matrixWorld).invert();
}

/* ============================ 4b. COVERS ============================
   covers.json is a manifest of book covers fetched offline by build-covers.js.
   It is joined to data.json rows purely by (novel, author) — data.json is
   never touched — so the two slug implementations MUST stay identical.
   ==================================================================== */

/**
 * !! KEEP IN SYNC WITH slug() IN build-covers.js !!
 * NFKD, drop combining marks, lowercase, "&" -> " and ", everything else
 * non-alphanumeric -> "-", trim dashes, first 70 chars. Drift here and every
 * cover silently disappears with no error anywhere.
 */
function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}
/** The join key: slug(novel) + "--" + slug(author). */
const coverKey = (novel, author) =>
  `${slug(novel) || 'untitled'}--${slug(author) || 'unknown'}`;

const COVER = {
  manifest: {},       // key -> manifest entry (absent = this work has no cover)
  imgs: new Map(),    // key -> decoded <img> template, or 'error'
  pending: new Map(), // key -> in-flight promise, so a key loads at most once
  token: 0,           // bumps on every hover change; late arrivals are dropped
  timer: 0,
  delay: 90,          // ms of pointer stillness before an uncached fetch starts
  ttWidth: 76,        // thumbnail width in the tooltip
  cardWidth: 128,     // and in the dossier

  /* Where cover pixels come from.
       'local'       — the bundled covers/photo/*.jpg. Fully offline. Right for
                       private/local use, wrong for a public deploy: the files
                       are third-party publisher artwork and putting them on a
                       public host means redistributing them.
       'openlibrary' — hotlink covers.openlibrary.org by the olCoverId recorded
                       in covers.json. This is the use their covers API exists
                       for, so it is the mode a public deploy (GitHub Pages
                       etc.) should ship with. Needs the viewer to be online.
       'auto'        — 'local' on localhost/file://, 'openlibrary' anywhere
                       else. Safe default: a copied-to-a-host build does the
                       right thing without anyone remembering this switch. */
  source: 'auto',
};

/** Resolved cover source for this page load. */
function coverSource() {
  if (COVER.source !== 'auto') return COVER.source;
  const h = location.hostname;
  const local = location.protocol === 'file:' ||
    h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
  return local ? 'local' : 'openlibrary';
}

/** URL for a manifest entry under the active source. */
function coverURL(entry) {
  if (coverSource() === 'openlibrary' && entry.olCoverId)
    return `https://covers.openlibrary.org/b/id/${entry.olCoverId}-M.jpg`;
  return entry.file;
}

/** Manifest entry for an idea's work, or null. ~1/3 of ideas have none. */
function coverFor(item) {
  return (item && COVER.manifest[coverKey(item.novel, item.author)]) || null;
}

/**
 * The cream mount + hard offset shadow, with the picture area pre-sized from
 * the manifest's real pixel dimensions. Reserving the box up front is what
 * keeps the tooltip from resizing under the pointer when the image lands.
 */
function plateHTML(entry, cls, w) {
  const ratio = entry.width && entry.height ? entry.height / entry.width : 1.5;
  const h = Math.round(w * Math.min(Math.max(ratio, 0.6), 2.4));
  return `<figure class="pulp-plate ${cls}">` +
    `<span class="plate-slot" style="width:${w}px;height:${h}px"></span></figure>`;
}

/** Load a cover once; the decoded element is kept as a clone template. */
function loadCover(key, entry) {
  const hit = COVER.imgs.get(key);
  if (hit) return Promise.resolve(hit === 'error' ? null : hit);
  let p = COVER.pending.get(key);
  if (p) return p;
  p = new Promise((resolve) => {
    const img = new Image();
    img.alt = '';            // decorative: the title is already in the text
    img.decoding = 'async';
    img.onload = () => { COVER.imgs.set(key, img); COVER.pending.delete(key); resolve(img); };
    img.onerror = () => { COVER.imgs.set(key, 'error'); COVER.pending.delete(key); resolve(null); };
    img.src = coverURL(entry);
  });
  COVER.pending.set(key, p);
  return p;
}

/**
 * Put the cover into `slot`.
 *   - already decoded  -> inserted synchronously, so re-hovering is instant
 *   - not yet loaded   -> waits out `delay` ms of stillness first, so a fast
 *                         sweep across thirty nodes fires one request, not thirty
 *   - `isStale()` is re-checked after the wait AND after the load, so an image
 *     that arrives once the pointer has moved on is thrown away rather than
 *     popping up under the wrong idea.
 * A clone is mounted, never the template itself — the tooltip and the open
 * dossier can want the same cover at the same time, and an element can only
 * live in one of them.
 */
function fillCoverSlot(key, entry, slot, isStale, delay = 0) {
  if (!slot) return;
  const hit = COVER.imgs.get(key);
  if (hit === 'error') return;
  if (hit) { slot.appendChild(hit.cloneNode()); return; }
  const go = () => {
    if (isStale()) return;
    loadCover(key, entry).then((img) => {
      if (!img || isStale() || !slot.isConnected) return;
      slot.textContent = '';
      slot.appendChild(img.cloneNode());
    });
  };
  if (!delay) { go(); return; }
  clearTimeout(COVER.timer);
  COVER.timer = setTimeout(go, delay);
}

/* ========================== 5. INTERACTION ========================== */

const tooltipEl = () => document.getElementById('tooltip');

function moveTooltip(x, y) {
  const t = tooltipEl();
  if (t.style.display !== 'block') return;
  const pad = 16;
  t.style.left = Math.min(x + pad, innerWidth - t.offsetWidth - 8) + 'px';
  t.style.top = Math.min(y + pad, innerHeight - t.offsetHeight - 8) + 'px';
}

function pickNode() {
  if (S.pointerNDC.x > 2) return null;
  S.raycaster.setFromCamera(S.pointerNDC, S.camera);
  const targets = [S.meshes.atoms, S.meshes.bits].filter(Boolean);
  const hits = S.raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    if (h.instanceId == null) continue;
    const list = h.object.userData.nodes;
    const n = list && list[h.instanceId];
    if (!n) continue;
    if (!isVisible(n)) continue;   // washed-out nodes are not pickable either
    return n;
  }
  return null;
}

function updateHover() {
  const n = pickNode();
  if (n === S.hovered) return;
  S.hovered = n;
  // Any cover still in flight belongs to the idea we just left.
  const token = ++COVER.token;
  clearTimeout(COVER.timer);

  const t = tooltipEl();
  if (!n) { t.style.display = 'none'; document.body.style.cursor = ''; return; }
  document.body.style.cursor = 'pointer';

  const it = n.item;
  const key = coverKey(it.novel, it.author);
  const entry = COVER.manifest[key] || null;
  // No cover is the normal case for a third of the ideas, and there is no
  // fallback artwork by design: the tooltip is simply the text one, with no
  // empty frame and no gap where a picture would have been.
  t.innerHTML =
    `<div class="tt-row">` +
      (entry ? plateHTML(entry, 'tt-plate', COVER.ttWidth) : '') +
      `<div class="tt-text"><span class="tt-name">${esc(it.device)}</span>` +
      `<span class="tt-sub">${it.year} · ${esc(it.author)} · ` +
      `${it.built ? "IT'S REAL" : 'STILL FICTION'}</span></div>` +
    `</div>`;
  t.style.display = 'block';
  if (entry) {
    fillCoverSlot(key, entry, t.querySelector('.tt-plate .plate-slot'),
      () => token !== COVER.token, COVER.delay);
  }
  // Re-clamp now that the tooltip has its new size, so it never hangs off-screen.
  moveTooltip(S.pointerPx.x, S.pointerPx.y);
}

function onClickScene() {
  const n = S.hovered || pickNode();
  if (!n) { closeCard(); return; }
  openCard(n);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openCard(n) {
  S.selected = n;
  const it = n.item;
  const kv = (k, v) => (v ? `<div class="kv"><b>${k}</b><span>${esc(v)}</span></div>` : '');
  const lag = it.built && Number.isFinite(it.realYear) ? it.realYear - it.year : null;
  // A thread only exists when reality came *after* the story. Some rows in the
  // dataset are retro-entries (realized before the book was written).
  const hasThread = Number.isFinite(n.realDepth) && !!n.threadEnd;
  const coverK = coverKey(it.novel, it.author);
  const cover = COVER.manifest[coverK] || null;

  document.getElementById('card-body').innerHTML = `
    <div class="badge ${it.built ? '' : 'fiction'}">${it.built ? "IT'S REAL!" : 'STILL FICTION'}</div>
    <div class="card-year">PREDICTED IN ${it.year}</div>
    <h2>${esc(it.device)}</h2>
    <p class="card-src">
      ${it.novel ? `<em>${esc(it.novel)}</em>` : '<em>Unknown work</em>'}
      ${it.author ? ` &nbsp;·&nbsp; ${esc(it.author)}` : ''}
    </p>
    ${cover ? plateHTML(cover, 'card-plate', COVER.cardWidth) : ''}
    ${it.desc ? `<p class="card-desc">${esc(it.desc)}</p>` : ''}
    <div class="card-rule"></div>
    ${kv('Domain', it.domain ? DOMAIN_LABEL[it.domain] : '')}
    ${kv('Subject', it.subject)}
    ${kv('Status', it.built ? 'Realized' : 'Not yet built')}
    ${kv('Built by', it.byWhom)}
    ${kv('As product', it.product)}
    ${kv('First made', it.realYearRaw)}
    ${lag != null && lag > 0 ? kv('Lead time', lag + ' years ahead of reality') : ''}
    ${lag != null && lag <= 0 ? kv('Lead time', 'already existed when the story was written') : ''}
    ${kv('Bits or atoms', it.kind === 'unknown' ? '' : it.kind === 'bits' ? 'Bits' : 'Atoms')}
    ${kv('Companies', it.companies)}
    ${kv('Notes', it.details)}
    <div class="card-actions">
      ${hasThread
        ? `<button class="pulp-btn" id="btn-fly">FOLLOW THE THREAD &rarr; ${it.realYear}</button>` : ''}
      <button class="pulp-btn ghost" id="btn-goto">CENTRE ON THIS</button>
    </div>
    ${cover ? `<p class="cover-credit">${esc(cover.attribution)}</p>` : ''}`;

  const card = document.getElementById('card');
  card.classList.add('open');
  card.setAttribute('aria-hidden', 'false');

  // The dossier was asked for explicitly, so no settle delay here — but it is
  // still guarded, in case a RANDOM JUMP replaces the card mid-load.
  if (cover) {
    fillCoverSlot(coverK, cover,
      document.querySelector('#card-body .card-plate .plate-slot'),
      () => S.selected !== n);
  }

  document.getElementById('btn-goto')?.addEventListener('click', () => flyToNode(n, -n.z));
  document.getElementById('btn-fly')?.addEventListener('click', () => flyToNode(n, n.realDepth));
}

function closeCard() {
  S.selected = null;
  const card = document.getElementById('card');
  card.classList.remove('open');
  card.setAttribute('aria-hidden', 'true');
}

/**
 * Fly to a year, optionally sliding across the cross-section at the same time.
 *
 * Now that the camera is a free point, a flight has to say where it wants to
 * END UP in all three axes or it can leave you at the right year but still
 * parked off to one side of the field from an earlier wheel run.
 *
 * Y is an argument now, not a constant: with the islands, "centre on this"
 * has to be able to rise to COMPUTING or sink to MEDICINE, and always
 * returning to camHeight would put half the constellation permanently
 * overhead. Omit it and you still come back to the river's height, as before.
 */
function flyToDepth(d, x = null, y = null) {
  if (!Number.isFinite(d)) return;
  S.flyTo = new THREE.Vector3(
    x == null ? S.posTarget.x : THREE.MathUtils.clamp(x, -CFG.maxPanX, CFG.maxPanX),
    y == null ? CFG.camHeight : THREE.MathUtils.clamp(y, -CFG.maxPanY, CFG.maxPanY),
    zForDepth(clampDepth(d))
  );
  // Anything that flies you somewhere also squares the view up, otherwise
  // you arrive at the right year facing the wrong way and see nothing.
  resetLook();
  hideHint();
}

/**
 * Fly to a node's year, drifting HALF WAY toward its island as we go.
 *
 * Half, not all the way: park the camera dead on top of a disc and you are
 * inside the bundle looking at the backs of its own nodes. Coming to rest
 * beside it keeps the idea you asked for in frame with the sky around it, and
 * keeps the rest of the constellation in view so you still know where you are.
 */
function flyToNode(n, depth) {
  flyToDepth(depth, n.x * 0.5, CFG.camHeight + (n.y - CFG.camHeight) * 0.5);
}

function randomJump() {
  const pool = S.nodes.filter(isVisible);
  if (!pool.length) return;
  const n = pool[Math.floor(Math.random() * pool.length)];
  flyToNode(n, -n.z);
  openCard(n);
}

/* ========================== 5b. THE FILTERS =========================
   Two independent filters — UNBUILT ONLY and the search box — and they
   INTERSECT: an idea is live only if it passes both. Neither replaces the
   other, so you can search inside the unbuilt set, or vice versa, and
   clearing one leaves the other exactly as it was.

   "Live" means three things at once, and applyFilter() is the single place
   that keeps them in step: the node keeps its colour, it stays pickable, and
   its lag thread keeps its weight.
   ==================================================================== */

/**
 * !! SAME RULES AS fold() IN build-covers.js !!
 * NFKD, drop the combining marks it leaves behind, lowercase, then map the
 * letters that carry their mark INSIDE the glyph and so have no canonical
 * decomposition at all: ł ø đ ð þ æ œ ß … Without that last step "Stanislaw"
 * would never find "Stanisław", which is exactly the case the corpus has.
 */
const FOLD_MAP = {
  'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'æ': 'ae', 'œ': 'oe',
  'ß': 'ss', 'ħ': 'h', 'ı': 'i', 'ŀ': 'l', 'ŋ': 'n', 'ſ': 's', 'ƀ': 'b',
  'ȼ': 'c', 'ɇ': 'e', 'ɨ': 'i', 'ɉ': 'j', 'ŧ': 't', 'ʉ': 'u', 'ƶ': 'z',
};
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (c) => FOLD_MAP[c] || c);
}
/**
 * Search form: folded, with every run of punctuation flattened to one space.
 * Applied to BOTH sides, so "ray-gun" finds "ray gun", "20,000" finds "20 000",
 * and a title's stray colon never hides it. Letters and digits of any script
 * survive (\p{L}\p{N}), so this does not quietly delete non-Latin text.
 */
const searchForm = (s) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * One folded haystack per node, built once at boot: device, novel, author and
 * description in a single string. 3,746 of them cost a few ms to build and
 * turn every keystroke into 3,746 String.includes() calls over already-folded
 * text — no per-keystroke normalising, which is the part that would stutter.
 */
function buildSearchIndex() {
  for (const n of S.nodes) {
    const it = n.item;
    // Each field is folded on its own and the pieces joined by a "|" the query
    // form can never contain, so a phrase cannot match across two fields —
    // "verne twenty" must not be satisfied by an author and a title colliding.
    n.hay = [it.device, it.novel, it.author, it.desc].map(searchForm).join(' | ');
    n.match = true;
  }
}

/** Does this node survive BOTH filters? The one definition everything uses. */
function isVisible(n) {
  if (S.unbuiltOnly && n.item.built) return false;
  if (S.query && !n.match) return false;
  return true;
}

/**
 * Run a query. Space-separated words are ANDed, so "lem solaris" narrows
 * rather than widening. An empty query restores everything — the match flags
 * all go true and isVisible() stops consulting them.
 */
function runSearch(raw) {
  S.queryRaw = String(raw || '');
  const q = searchForm(S.queryRaw).replace(/\s+/g, ' ');
  S.query = q;
  let count = 0;
  if (!q) {
    for (const n of S.nodes) n.match = true;
    count = S.nodes.length;
  } else {
    const terms = q.split(' ');
    for (const n of S.nodes) {
      let ok = true;
      for (let i = 0; i < terms.length; i++) {
        if (n.hay.indexOf(terms[i]) === -1) { ok = false; break; }
      }
      n.match = ok;
      if (ok) count++;
    }
  }
  S.matchCount = count;
  applyFilter();
  updateSearchHUD();
}

let searchTimer = 0;
/** Debounced entry point for the input event — one pass per idle 90ms. */
function queueSearch(raw) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(raw), 90);
}

function clearSearch() {
  const el = document.getElementById('search');
  if (el) el.value = '';
  clearTimeout(searchTimer);
  runSearch('');
}

function focusSearch() {
  const el = document.getElementById('search');
  if (el) { el.focus(); el.select(); }
}

/** The count is what makes an empty result obviously empty, not broken. */
function updateSearchHUD() {
  const el = document.getElementById('search-count');
  document.querySelector('.search-wrap')?.classList.toggle('filled', !!S.queryRaw);
  if (!el) return;
  if (!S.query) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.classList.toggle('none', S.matchCount === 0);
  el.textContent = S.matchCount === 0
    ? 'NO MATCHES'
    : `${S.matchCount} / ${S.nodes.length}`;
}

/**
 * Repaint for the current filter state: filtered-out nodes wash out to paper
 * and their threads dim with them. Called on every filter change, and after a
 * relayout (the threads are rebuilt from scratch there and come back at full
 * weight, so this has to run again to re-apply the dimming).
 */
function applyFilter() {
  const washed = new THREE.Color(0xE3D8C2);
  for (const bucket of ['atoms', 'bits']) {
    const mesh = S.meshes[bucket];
    if (!mesh || !mesh.instanceColor) continue;
    for (const n of mesh.userData.nodes) {
      mesh.setColorAt(n.localIndex, isVisible(n) ? n.baseColor : washed);
    }
    mesh.instanceColor.needsUpdate = true;
  }

  // Per-arc, not per-bundle: only the threads of washed-out ideas fade.
  if (S.threadLine) {
    const attr = S.threadLine.geometry.getAttribute('aDim');
    if (attr) {
      const a = attr.array;
      const dimmed = CFG.threadDimFiltered;
      for (const n of S.nodes) {
        if (n.threadV0 < 0) continue;
        const w = isVisible(n) ? 1 : dimmed;
        for (let i = 0; i < n.threadVN; i++) a[n.threadV0 + i] = w;
      }
      attr.needsUpdate = true;
    }
    S.threadLine.material.opacity = CFG.threadOpacity;
  }
}

function hideHint() {
  document.getElementById('scroll-hint')?.classList.add('gone');
}

function initUI() {
  document.getElementById('btn-random').addEventListener('click', randomJump);
  document.getElementById('btn-reset').addEventListener('click', () => resetView());
  const bu = document.getElementById('btn-unbuilt');
  bu.addEventListener('click', () => {
    S.unbuiltOnly = !S.unbuiltOnly;
    bu.classList.toggle('on', S.unbuiltOnly);
    applyFilter();
  });
  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', () => queueSearch(search.value));
    // Enter with exactly one hit is a shortcut worth having: fly straight to it.
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(searchTimer);
      runSearch(search.value);
      if (S.matchCount >= 1 && S.matchCount <= 12) {
        const hit = S.nodes.find(isVisible);
        if (hit) { flyToNode(hit, -hit.z); openCard(hit); }
      }
    });
  }
  document.getElementById('search-clear')?.addEventListener('click', () => {
    clearSearch();
    focusSearch();
  });
  document.getElementById('card-close').addEventListener('click', closeCard);
  const help = document.getElementById('help');
  document.getElementById('btn-help').addEventListener('click', () => { help.hidden = false; });
  document.getElementById('help-close').addEventListener('click', () => { help.hidden = true; });
  help.addEventListener('click', (e) => { if (e.target === help) help.hidden = true; });
}

/* ============================= 6. LOOP ============================== */

const _dummy = new THREE.Object3D();
const _v = new THREE.Vector3();

function updateInstances(time) {
  for (const bucket of ['atoms', 'bits']) {
    const mesh = S.meshes[bucket];
    if (!mesh) continue;
    const list = mesh.userData.nodes;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      let x = n.x, y = n.y, s = n.radius;
      if (n.item.built) {
        // realized: settled. A slow, small breath, and it stays put.
        y += Math.sin(time * 0.45 + n.bobPhase) * 1.6;
      } else {
        /* Unrealized ideas are RESTLESS. Y no longer says "not yet built" —
           the islands own the cross-section now — so the motion has to carry
           what the height used to. Three things at once, all slow and all
           slightly out of step with each other so the field never pulses in
           unison: a vertical drift, a lateral wander (new: it is what makes
           them read as unmoored rather than merely bobbing), and a breath in
           scale. Deliberately kept under ~10 units and ~1Hz — restless, not
           a fairground. */
        y += Math.sin(time * 0.62 + n.bobPhase) * 9.0;
        x += Math.sin(time * 0.37 + n.bobPhase * 1.7) * 5.5;
        s *= 1 + 0.19 * Math.sin(time * 1.5 + n.bobPhase);
      }
      const hot = S.hovered === n || S.selected === n;
      if (hot) s *= 1.85;
      _dummy.position.set(x, y, n.z);
      _dummy.scale.setScalar(s);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      n.renderY = y;
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

function updateLabels() {
  // LOD: project every candidate in the near band, keep only the ones that
  // actually land on screen, then label the nearest few.
  //
  // The camera can now face any direction, so "in front" is a CAMERA-SPACE
  // test, not a world-Z one. Vector3.project() divides by w and happily maps
  // points BEHIND the camera onto the screen, mirrored — the classic ghost
  // label bug. So: transform to camera space first, reject anything with
  // z >= -30 (at or behind the eye), and only then apply the projection.
  //
  // While a search is running the sort is by (rank, distance), not distance
  // alone: filter down to three hits and the sixteen label slots would
  // otherwise all go to whatever paper happened to be nearest, leaving the
  // things you actually searched for anonymous. Matches take the slots first;
  // anything left over still gets filled, faintly.
  const near = [];
  for (const n of S.nodes) {
    if (S.unbuiltOnly && n.item.built) continue;
    _v.set(n.x, n.renderY ?? n.y, n.z).applyMatrix4(S.camera.matrixWorldInverse);
    const fwd = -_v.z;                     // positive => in front of camera
    if (fwd < 30) continue;                // behind, or right on top of us
    const dist = _v.length();
    if (dist > CFG.labelRange) continue;
    _v.applyMatrix4(S.camera.projectionMatrix);   // w = fwd > 0, divide is safe
    if (!Number.isFinite(_v.x) || Math.abs(_v.x) > 0.92 || Math.abs(_v.y) > 0.9) continue;
    const rank = S.query && !n.match ? 1 : 0;
    near.push([dist, n, (_v.x * 0.5 + 0.5) * innerWidth, (-_v.y * 0.5 + 0.5) * innerHeight, rank]);
  }
  near.sort((a, b) => (a[4] - b[4]) || (a[0] - b[0]));

  // cheap de-overlap: skip a label if it lands too close to one already placed
  const show = [];
  for (const e of near) {
    if (show.length >= CFG.labelCount) break;
    if (show.some((p) => Math.abs(p[2] - e[2]) < 130 && Math.abs(p[3] - e[3]) < 15)) continue;
    show.push(e);
  }

  const host = document.getElementById('labels');
  while (S.labelPool.length < show.length) {
    const el = document.createElement('div');
    el.className = 'node-label';
    host.appendChild(el);
    S.labelPool.push(el);
  }
  for (let i = 0; i < S.labelPool.length; i++) {
    const el = S.labelPool[i];
    const entry = show[i];
    if (!entry) { el.style.display = 'none'; continue; }
    const n = entry[1];
    const sx = entry[2], sy = entry[3];
    el.style.display = 'block';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    // Distance sets the weight, as before — except that a search hit is never
    // allowed to fade to a whisper just because it is far off (the thing you
    // searched for must be the thing you can read), and a non-match filling a
    // spare slot is pushed well back so it cannot be mistaken for a result.
    const byDist = THREE.MathUtils.clamp(1 - entry[0] / CFG.labelRange, 0.12, 0.95);
    const isHit = !!S.query && entry[4] === 0;
    el.style.opacity = String(
      isHit ? Math.max(byDist, 0.72) : entry[4] === 1 ? byDist * 0.3 : byDist);
    const txt = n.item.device;
    if (el.textContent !== txt) el.textContent = txt;
    el.classList.toggle('unbuilt', !n.item.built);
    el.classList.toggle('hit', isHit);
  }
}

function updateHUD() {
  const y = yearForDepth(S.depthCur);
  const shown = Math.round(THREE.MathUtils.clamp(y, CFG.yearFloor, CFG.yearNow));
  const el = document.getElementById('hud-year');
  if (el.textContent !== String(shown)) {
    el.textContent = String(shown);
    document.getElementById('hud-era').textContent = eraName(shown);
  }
  const pct = THREE.MathUtils.clamp(S.depthCur / S.depthMax, 0, 1) * 100;
  document.getElementById('hud-bar-fill').style.width = pct.toFixed(1) + '%';

  // RESET VIEW lights up as soon as the head is turned OR the camera has been
  // flown off the centre line, so a user who is lost can see the way home
  // without hunting for it. Being off the river is the more important of the
  // two now that the wheel can take you there.
  const btn = document.getElementById('btn-reset');
  if (btn) btn.classList.toggle('astray', lookOffset() > 0.12 || riverOffset() > 90);
}

let lastT = 0;
function animate() {
  requestAnimationFrame(animate);
  const t = (performance.now() - S.t0) / 1000;
  const dt = Math.min(t - lastT, 0.1) || 0.016;
  lastT = t;
  frame(t, dt);
}

/** One simulation+render step. Split out so it can be driven manually. */
function frame(t, dt) {
  updateCamera(dt);
  updateInstances(t);
  updateLaneSigns();
  if (!S.dragging) updateHover();
  updateLabels();
  updateHUD();
  S.renderer.render(S.scene, S.camera);
}

/* ============================== BOOT ================================ */

async function boot() {
  const sub = document.getElementById('load-sub');
  try {
    initScene();
    // covers.json rides along with data.json. It is strictly optional chrome:
    // if it is missing or malformed the site runs exactly as it did before.
    const [res, coversRes, domainsRes] = await Promise.all([
      fetch('./data.json', { cache: 'no-cache' }),
      fetch('./covers.json', { cache: 'no-cache' }).catch(() => null),
      fetch('./domains.json', { cache: 'no-cache' }).catch(() => null),
    ]);
    if (!res.ok) throw new Error('data.json HTTP ' + res.status);
    const data = await res.json();
    if (coversRes && coversRes.ok) {
      try {
        const m = await coversRes.json();
        if (m && typeof m === 'object') COVER.manifest = m;
      } catch (e) {
        console.warn('[idea-bank] covers.json unreadable, running without covers', e);
      }
    }
    const items = (data.items || []).filter(
      (d) => d && Number.isFinite(d.year) && d.device
    );
    if (!items.length) throw new Error('data.json contained no usable rows');
    S.items = items;
    // Pin the rail to the data's actual span so the HUD never reports a year
    // with nothing in it.
    const yrs = items.map((d) => d.year);
    CFG.yearNow = Math.max(...yrs);
    CFG.yearFloor = Math.min(...yrs);

    // domains.json is optional chrome too: without it the X axis silently
    // stays on the author field and no lane signs are built.
    let layout = null;
    if (domainsRes && domainsRes.ok) {
      try {
        const dj = await domainsRes.json();
        const byId = (dj && dj.byId) || {};
        let tagged = 0;
        for (const it of items) {
          const v = byId[it.id];
          if (!v || !DOMAIN_LABEL[v.domain]) continue;
          it.domain = v.domain;
          it.subject = v.subject || '';
          it.domainConfidence = v.confidence || null;
          it.vaultDomain = v.vaultDomain || null;
          it.domainFallback = !!v.fallback;
          tagged++;
        }
        if (tagged) {
          layout = buildDomainLayout(items);
          xStrategy = XY_STRATEGIES.domain;
          xStrategyName = 'domain';
        }
        console.log('[idea-bank]', tagged, 'of', items.length, 'ideas carry a domain');
      } catch (e) {
        console.warn('[idea-bank] domains.json unreadable, X axis stays on author', e);
      }
    }

    buildNodes(items);
    buildSearchIndex();  // needs S.nodes
    initRail();          // needs S.nodes for depthMax + the envelope
    buildThreads();
    buildBridges();      // needs BRIDGES from buildDomainLayout()
    buildAtmosphere();
    buildLaneSigns();    // needs LANES from buildDomainLayout()
    initUI();
    applyFilter();
    onResize();
    animate();

    // Debug handle (prototype convenience / headless testing).
    window.__bank = {
      S, CFG, THREE, frame, depthForYear, yearForDepth, positionForItem,
      randomJump, flyToDepth, flyToNode, setXStrategy,
      X_STRATEGIES, XY_STRATEGIES, buildDomainLayout, buildBridges,
      DOMAINS, DOMAIN_ORDER, DOMAIN_LABEL, DOMAIN_X, DOMAIN_XY,
      DOMAIN_DISCS, LANE_SIGNS, BRIDGE,
      get LANES() { return LANES; },
      get DISCS() { return LANES; },
      get BRIDGES() { return BRIDGES; },
      get DISC_BY_SLUG() { return DISC_BY_SLUG; },
      get xStrategyName() { return xStrategyName; },
      lookBy, resetView, resetLook, lookOffset, riverOffset, pickNode,
      flyBy, zForDepth, depthForZ, buildEnvelope, applyThreadTuning,
      fold, runSearch, clearSearch, isVisible, applyFilter, THREAD_U,
      COVER, coverKey, coverFor, loadCover, openCard, closeCard,
      /** Snap the view to an absolute heading (radians) — for tests. */
      setLook(yaw, pitch = CFG.camTilt) {
        S.yawTarget = S.yaw = yaw;
        S.pitchTarget = S.pitch = THREE.MathUtils.clamp(pitch, -CFG.maxPitch, CFG.maxPitch);
        S.yawVel = S.pitchVel = 0;
      },
      /** Advance n frames without rAF (useful when the tab isn't compositing). */
      step(n = 60, dt = 1 / 60) {
        for (let i = 0; i < n; i++) frame(i * dt, dt);
      },
    };

    const m = data.meta || {};
    sub.textContent = `${items.length} IDEAS · ${m.yearMin ?? '?'}–${m.yearMax ?? '?'}`;
    setTimeout(() => document.getElementById('loading').classList.add('gone'), 420);
    const worksWithCover = Object.keys(COVER.manifest).length;
    const ideasWithCover = items.reduce((k, it) => k + (coverFor(it) ? 1 : 0), 0);
    console.log('[idea-bank]', items.length, 'nodes ·',
      S.nodes.filter(n => n.threadEnd).length, 'threads ·',
      worksWithCover, 'covers joining', ideasWithCover, 'ideas ·',
      'cross-section:', xStrategyName,
      layout ? `(${layout.discs} islands, ${layout.unclassified} unclassified, ` +
               `${layout.bridges} bridges, tightest gap ${layout.tightest} @ ${layout.tightestPair})` : '');
  } catch (err) {
    console.error(err);
    sub.innerHTML = 'COULD NOT LOAD data.json<br><span style="font-size:10px;letter-spacing:.1em">' +
      esc(err.message) + '<br>SERVE THE FOLDER OVER HTTP (e.g. python -m http.server)</span>';
  }
}

boot();
