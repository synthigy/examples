# datastar-music

**The branding example.** Everything a visitor sees here wears *Groove
Harbor*, a brand made up for it: the app, its error pages, sign-out, and the
engine's own sign-in page. Swap one directory for your own brand (see [The
brand](#the-brand)).

A live **music library** for the Synthigy **Python SDK**: a FastAPI BFF renders
server-side HTML over **Tyrell** web components, and the browser gets HTML +
**Datastar** SSE patches. No client-side framework, no build step. The Python
mirror of [movies/js](../../movies/js/).

```
Browser (Datastar + Tyrell, from CDN)
   ↕ HTML + SSE patches
FastAPI BFF (this directory)
   ↕ synthigy (typed ops generated from ../xsql/music.xsql)
Synthigy (/data, /oauth, /data/events)
```

Tokens never reach the browser (OIDC code + PKCE, cookie-keyed session). One
async SDK client per process carries every read, write, batch, history call and
watch, multiplexed over one upstream SSE, and every call carries
`acting_as=user.xid`.

## What it shows

Every interactive block carries a chip naming the SDK call behind it.

| Page | Feature | SDK |
|---|---|---|
| `/albums` | live chart: debounced search, "1M+ plays" switch, sort via an **order param** | `watch_entities` + `MusicAlbumAsync.list` |
| `/albums` | ▶ bumps a play count, every open tab repaints | `get` + `stack` |
| `/albums` | add an album with a nested artist, deterministic xid (re-adding upserts) | `stack` + `MusicAlbumInput` |
| `/albums/:xid` | live detail: tracks, artists, genres | `MusicAlbumAsync.watch_detail` |
| `/albums/:xid` | add/remove tracks, delete the album | `stack`, `delete` |
| `/albums/:xid` | genre chips: add / dismiss one / clear | `stack` vs `sync` vs `synthigy.slice` |
| `/albums/:xid` | change history (needs audit on) | `synthigy.history().events` |
| `/dashboard` | counters + top-N chart in one request | `overview_async()` (`@batch`) |
| `/dashboard` | live counters from one SQL-template watch over three entities | `DashboardAsync.watch_stats` |
| `/dashboard` | "Billion club" ad-hoc search | `synthigy.search` + `gt()` |

Live updates are **notify-then-refetch**: an event only pokes, and the BFF
re-runs the RLS-scoped query. Open `/albums` in two tabs and press ▶ in one.

## The brand

A record sleeve: bone paper, ink and one loud harbor blue; condensed heavy
capitals (Archivo), an italic serif for the human voice (Instrument Serif),
mono for the small print (IBM Plex Mono); square sleeves, round buttons, and
a vinyl record drawn in pure CSS (`.gh-disc`) that the app and the engine's
pages share.

```
music/brand/            the brand, and the engine's custom-pages bundle at once
├── brand.css           tokens, fonts, the record; the app maps them onto Tyrell
├── logo.svg            the mark
├── index.html          the engine's sign-in page for this app
├── status.html         sign-in outcome (see "not yet" below)
└── error.html          request rejected before sign-in (see "not yet" below)
```

| Page | Served by | How it gets the brand |
|---|---|---|
| The app | this BFF | `shared/theme.css`, then `brand/brand.css` over it |
| Sign in | the engine, `/login/groove-harbor/` | this directory uploaded as a custom-pages bundle; the OAuth client's **Login page** names it |
| Signed out | this BFF, `/signed-out` | the app's layout |
| 404, 403, 500, sign-in failed | this BFF | exception handlers render them in the layout (`serve.py`) |

`/brand` in the app is the brand book: the palette, the type, and every one
of these pages.

`brand.py` puts the engine half in place: it uploads `../brand/` as the bundle
`groove-harbor` (what *System → Custom pages* does in the console, signed in as
`DEMO_USER`, default `admin`) and sets this app's OAuth client settings
`login-page`, `logo-url` and `logout-redirections`. Only this client changes;
the other examples keep the `default` bundle.

### Make it yours

1. Edit the `--gh-*` colours and the three fonts at the top of
   `brand/brand.css`.
2. Replace `brand/logo.svg`, and the name and tagline in `brand/*.html` and
   `BRAND` in `views.py`.
3. `synthigy exec -- python brand.py` and reload. Each run stores and serves a
   new bundle version; the console keeps the old ones to roll back to.

The sign-in page's contract is the form, not the look: carry `?state=` back,
POST to `/oauth/login` with `Accept: application/json`, keep `#username` and
`#password`. The console documents every page and code under *System → Custom
pages*.

### What the engine does not brand yet (engine 0.3.0)

- **Status, error, device and claim pages come from the `default` bundle
  only.** One app cannot have its own: `status.html` and `error.html` are in
  the bundle, finished, and the engine serves them for this app the day it
  can. Making them the instance-wide `default` would rebrand every other
  example on the instance.
- **There is no signed-out page to customize, and `/oauth/logout` answers in
  plain text** (`"Session is not active"`, 400), even right after a sign-in.
  So sign-out here ends the app's session and lands on its own page.
- **The Synthigy tools** in the footer (model, console, logs) are the
  platform's own and sign in through the `default` page, on purpose: they are
  the platform under the brand.

## Run

Needs Python ≥ 3.10 and an instance from `../../scripts/bootstrap-instance.sh`.
Everything below runs from this directory.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 1. deploy the model
synthigy exec -- python -c 'import synthigy; print(synthigy.connect().deploy(open("../../datasets/music/Music Demo@0.1.3.json").read()))'

# 2. seed
synthigy exec -- python seed.py
synthigy exec -- python backfill_covers.py      # optional album art

# 3. generate the typed ops
synthigy exec -- python -m synthigy.codegen gen ../xsql --out generated/music_gen.py --pull

# 4. put the brand on the engine's sign-in for this app
synthigy exec -- python brand.py

# 5. start
synthigy exec -- uvicorn serve:app --port 5175 --reload --timeout-graceful-shutdown 3
```

Open <http://localhost:5175> and sign in as `admin` / `admin`.

On Windows, set `PYTHONUTF8=1` first: the seed files and the codegen's output
are UTF-8, and Python there otherwise reads and prints them as cp1252.

`EXAMPLES_URL`, when set, adds a link back to the examples landing page to the
topbar.

- **Seed data:** `seed.py` uses the albums in `../../datasets/music/`. For
  your own volume, reshape the Kaggle
  [Spotify Tracks Dataset](https://www.kaggle.com/datasets/maharshipandya/spotify-tracks-dataset)
  with `bb ../../datasets/music/prep_spotify.bb dataset.csv --top 300` and
  re-run `seed.py`.
- **Identity is a deterministic xid**, derived from `artist + title`, so
  re-seeding upserts and two albums with the same title stay distinct.
- **Covers** come from Spotify oEmbed and Deezer search, no API keys.
  Albums that already have a cover are skipped; `--force` refetches and
  `--limit N` does a quick pass.
- **Codegen** pulls `../xsql/schema.json` (the model your client may see) and
  `../xsql/ops.ir.json` (the compiled templates), then renders the client.
  None of it is committed. Drop `--pull` to regenerate offline.
- **`--timeout-graceful-shutdown`** keeps `--reload` from waiting forever on
  open SSE streams.
- Changing `PORT`/`BASE_URL` in `.synthigy/.env` means re-registering the
  client's redirect URI.

## Verify

```bash
pip install playwright && playwright install chromium
python e2e.py
```

Sixteen browser checks over every feature above, self-cleaning, non-zero exit
on failure.

## Not here on purpose

`purge`, the tree ops (no self-referential relation), a production session
store (sessions mirror to `.sessions.json` so `--reload` keeps you logged in),
and `id_token` signature verification.
