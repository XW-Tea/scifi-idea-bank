# Adding works to the dataset

The Technovelgy CSV is anglophone and book-shaped. Everything else — anime,
manga, games, non-English novels — comes in through `extra/`, and this is how.

## Where things live

| file | what it is | edit? |
|---|---|---|
| `Sci-Fi Idea Bank.csv` | the Technovelgy source, 3,746 rows | leave alone |
| `extra/*.json` | hand-curated works | **yes, add here** |
| `data.json` | the two merged; what the site reads | generated |
| `domains.json` | domain, subject, Bits/Atoms per idea | generated |
| `covers.json` | cover manifest | generated |

Split `extra/` by batch (`extra/anime-1990s.json`, `extra/games.json`) rather
than growing one file. Every `.json` in the directory is read.

## Row format

Required: `year`, `device`, `novel`, `author`, `desc`, `built`.

```json
{ "items": [
  {
    "year": 1989,
    "device": "Thermoptic camouflage",
    "deviceNative": "光学迷彩",
    "novel": "Ghost in the Shell",
    "titleNative": "攻殻機動隊",
    "author": "Masamune Shirow",
    "medium": "manga",
    "desc": "A suit that bends light around the wearer to hide them.",
    "built": false,
    "companies": "Hyperstealth",
    "sourceUrl": "https://en.wikipedia.org/wiki/..."
  }
] }
```

`novel` **must hold the English title** — `covers.json` joins on
`slug(novel)--slug(author)`, and the slug strips non-ASCII, so a Japanese-only
title collapses to an empty key and collides with every other one. The original
goes in `titleNative`, which the cover matcher also uses to find the work.

`year` is the year the *work* came out, not the year the gadget appears.

Leave `kind` out; `classify-kind.js` fills it.

## The pipeline

```bash
node preprocess.js --all      # CSV + extra/ -> data.json
node classify-kind.js         # Bits/Atoms for the new rows
node classify-domains.js      # domain, subject, vaultDomain
node preprocess.js --all      # again: classify-kind writes back into extra/
node build-media-covers.js    # AniList / Steam / Open Library covers
node covers-manual.js         # report what still has no cover
```

The second `preprocess.js` matters: `classify-kind.js` writes its answers back
into `extra/*.json`, and without a re-merge the Bits/Atoms axis never reaches
`data.json` and every new node renders as matte atoms.

All four are cached and resumable — a re-run touches only what changed and
makes zero LLM calls for anything already done. They need
[Ollama](https://ollama.com) running with `qwen2.5:14b`.

`preprocess.js` refuses to run if a row is missing `year` or `device`, so a
typo stops the pipeline instead of quietly entering a broken row.

## Deciding `built` — the part that matters

This is the dataset's spine and the only genuinely hard judgement. Get it wrong
and the whole thing becomes a gadget list.

**The rule, taken from how the existing 3,746 rows already behave:**

> The thing itself must demonstrably exist and work. Research achievements
> count. An active research field pointed at the capability does not.

The source data is consistent about this and it is worth internalising:

- **Ion drive → realized.** "First demonstrated in space missions." Not a
  product, but the thing flies.
- **Antimatter → realized.** `byWhom: "Physics research"`. It exists.
- **Fusion power → fiction.** Decades of research, no working fusion power.
- **Cloaking device → fiction.** Metamaterials research is real; the cloak is not.

The failure mode is generosity. It is tempting to reach for an adjacent real
product and call it a hit — a spinal cord stimulator for Cyberpunk's Pain
Editor, an implantable defibrillator for its Second Heart. Both were judged
realized here once and both were wrong: the stimulator dulls chronic pain, the
fiction abolishes sensation; the defibrillator prevents one kind of cardiac
death, the fiction revives you after you die. **Ask whether the real thing does
what the fiction depicts, not whether it gestures at it.** When unsure, fiction.

**There is no third status, and adding one would be a mistake.** For things
being worked on but not working, put the company in `companies` — the field
exists for exactly this, and the dossier surfaces it. Neuralink goes against
the cyberbrain; the cyberbrain stays fiction.

For a realized idea, fill `byWhom`, `product`, `realYear`, `realYearRaw`
(`"2010s"` is fine — set `realYearFuzzy: true`), and `details`.

## What to leave out

Extraction tends to pull in things that are not ideas about technology. Drop
plot events (*Akira's explosion*), settings (*Neo-Tokyo*), institutions,
medical conditions (*cyberbrain sclerosis*), sub-components of an idea already
present, and cross-volume duplicates. Record why in the batch's commit message
so the cut is auditable rather than silent.

## Covers

`build-media-covers.js` picks its source from `medium`: AniList for
anime/manga, Steam for games, Open Library for novels. None needs an API key.

Matching is unreliable and single-result trust will attach the wrong artwork —
observed failures include AniList returning a Chinese anime for "Deus Ex",
Steam returning *Death Stranding 2* for "Death Stranding", and Wikidata
returning the 2017 live-action film for "Ghost in the Shell". The script
therefore fetches several candidates and asks the local LLM to confirm the
match, with "none" allowed and preferred. A missing cover beats a wrong one.

Open Library indexes translated novels under their original title and author
(三体 / 刘慈欣), so the script searches `titleNative` too, and lets an exact
native-title match bypass the author-token guard. Without that, *The
Three-Body Problem* is correctly-but-unhelpfully rejected.

**`film` and `tv` have no route.** Two keyless alternatives were measured and
rejected: the iTunes Search API returns individual episodes (*Nosedive* rather
than *Black Mirror*) or unrelated shows entirely (*House Hunters* for
*Upload*), and Wikidata had no P18 image for any of six works tested, because
posters are copyrighted and so cannot live on Commons. TMDB would work but
needs an account.

## Adding a cover by hand

Some works will never resolve automatically, and some are rejected correctly —
*Fallout*'s Steam listing carries the 2013 re-release publisher and year, so
the verifier declines it, which is the behaviour you want in general. When you
know the answer, supply it:

```bash
node covers-manual.js                       # what has no cover, most ideas first
node covers-manual.js --add "Black Mirror" <image-url> --credit "source, rights"
```

Prefer a URL over a local path. `covers/photo/` is gitignored, so a URL is what
survives a fresh clone, and the page prefers `remoteUrl` anywhere but
localhost. A local file works but you will be warned.

Manual entries live in `covers-manual.json`, which **is** committed. The
automated builders skip those keys entirely — they will not overwrite the
entry and will not sweep away the image.

## Verify, then publish

```bash
node -e "const p=require('./data.json');console.log(p.items.length,'items')"
python -m http.server 8130
```

Open <http://localhost:8130>, check the year plate and a hover cover, and
confirm the console is clean. `classify-domains.js` prints the lane
distribution — nothing should exceed 25% or fall under 1.5%, since either
means the taxonomy is buckling under the new material.

Then commit `extra/`, the regenerated JSON, and the new cover files.
`covers/photo/` is gitignored on purpose: the published site hotlinks the
source CDNs instead of redistributing publisher artwork.

## A note on which works are worth adding

Works that predate the technology are worth far more here than recent ones. A
2020 game depicting 2015 technology produces rows whose realization year comes
*before* the work, which the site draws without a thread because nothing was
predicted. Doraemon (1969) and the Three-Body trilogy (2008) earn their place;
Cyberpunk 2077 contributed 2 realizations out of 23 ideas.
