# datastar-music

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

# 4. start
synthigy exec -- uvicorn serve:app --port 5175 --reload --timeout-graceful-shutdown 3
```

Open <http://localhost:5175> and log in as `admin` / `admin`.

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
