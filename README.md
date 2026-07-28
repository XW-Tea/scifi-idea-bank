# THE SCI-FI IDEA BANK — Four Centuries of Tomorrow

A 2.5D "river of time" browser for 3,746 science-fiction ideas (1634–2023),
from the Technovelgy dataset compiled by Not Boring.

Fly backwards through four centuries. Realized ideas settle low and trail a
thread down to the year they actually came true; unrealized ones hover above
you, still waiting. Ideas are laid out left-to-right by domain, running from
matter to information.

## Run it

It must be served over HTTP (ES modules + `fetch`), not opened as a file.

```bash
cd D:\SciFi\scifi-idea-bank
python -m http.server 8123
```

Then open <http://localhost:8123>. `npx serve` works too.

No internet connection is needed — three.js, all data and all cover images are
local. The page makes zero external requests at runtime.

## Controls

| input | what it does |
|---|---|
| **mouse wheel** | fly forward/back **along the direction you are facing** |
| **click + drag** | look around; 360° horizontally, ±80° vertically |
| **arrows / PgUp / PgDn / Home / End** | scrub purely through time, whatever direction you face |
| **hover a node** | name, year, novel, author + the book cover |
| **click a node** | full dossier; "Follow the thread" flies to the year it was realized |
| **`/`** | focus the search box; Enter flies to the first hit |
| **`R`** | random jump |
| **`V`** / RESET VIEW | return to the river — restores both orientation and position |
| **`Esc`** | closes help, then dossier, then search (one press, one thing) |

UNBUILT ONLY and the search box compose as an intersection: both active means
unbuilt **and** matching. Non-matching nodes wash out and become unclickable.

If you fly off into blank paper, you stop at the edge of the data and drift
back on your own. `V` always brings you home.

## Layout

- **Depth** = the year the idea was predicted, on a `36 · age^0.72` curve so the
  crowded modern era gets room and the sparse 1600s–1700s compress into the
  distance. The YEAR plate reads off the camera's actual position, so it stays
  honest no matter how you got there.
- **The cross-section (X and Y)** = a hand-placed constellation of 14 domain
  islands, each a disc-shaped bundle of ideas flowing through time. The
  matter→information gradient sweeps from materials (lower-left) through
  space, robots and the body over to comms/computing (upper-right), matching
  the matte (Atoms) vs glowing (Bits) materials. Disc radius scales with
  population; same-subject ideas cluster inside their disc. Faint rope bridges
  connect neighbouring islands whose ideas co-occur in the same novels.
- **Realization status** is carried by colour and material alone — orange and
  settled vs teal and restlessly pulsing — plus the thread each realized idea
  drops to the year it came true. (Height stopped encoding built/unbuilt when
  the constellation landed; the default camera rests in the empty canyon
  between the robots, mind and medicine islands.)

## Files

| file | what it is |
|---|---|
| `index.html` `style.css` `main.js` | the site; all tunables live in `CFG` at the top of main.js |
| `vendor/` | three.js, vendored |
| `data.json` | 3,746 ideas, generated from the CSV |
| `domains.json` | per-idea domain, confidence, vault domain, subject |
| `covers.json` + `covers/photo/` | 573 book covers (8.1 MB) |
| `preprocess.js` | CSV → data.json |
| `classify-domains.js` | local-LLM domain classification |
| `build-covers.js` | local-LLM cover matching + download |
| `*-report.json` | full run reports, distributions, samples, every rejection |

## Regenerating

All three scripts cache to disk and are resumable — a plain re-run makes zero
LLM calls and costs nothing. They need [Ollama](https://ollama.com) running
locally with `qwen2.5:14b` pulled.

```bash
node preprocess.js --all
node classify-domains.js
node build-covers.js
```

To point the layout at something other than domains, from the browser console:

```js
setXStrategy('author')   // or 'novel', or 'domain'
```

## Known rough edges

- **Coverage of covers is 61% of ideas** (573 of 1,207 works). The gap is almost
  entirely pulp-magazine short stories that were never published as books, so no
  cover exists to find. There is deliberately no generated fallback art — those
  ideas just get a text-only tooltip.
- Covers are third-party publisher artwork. Attribution and cover id are
  recorded per entry in `covers.json` and shown in the dossier. To keep a
  public deploy clean, `COVER.source` in main.js is `'auto'`: on localhost the
  bundled `covers/photo/` files are used (fully offline), while on any real
  host the page hotlinks Open Library's covers API instead of redistributing
  the bundled files. If you deploy publicly (GitHub Pages etc.) you can also
  simply delete `covers/photo/` from the deployed copy — everything falls back
  to the API URLs.
- One unused cover (`le-vingtieme-siecle...--albert-robida`) no longer joins to
  any row. Harmless, ~15 KB.
- **Looking straight up shows empty sky.** The unrealized band sits only ~30
  units above eye level, so it thins out past about 35° of pitch. Raising
  `CFG.yUnbuilt` from 78 toward 150 fills the ceiling, at the cost of changing
  the forward composition.
- 42 rows record a realization year *before* the year they were predicted
  (retro-entries in the source data). They get no thread.
- The classifier occasionally wrote its rejection *reasons* in Chinese. Cosmetic
  only — it appears in report files, never in the UI.
