# Music dataset

The model and seed data behind the `music` examples.

| Path | What |
|---|---|
| `Music Demo@0.1.3.json` | Deployable model, exported from the modeler — deploy it with a client's SDK (`deploy(exportContents)`), never by hand |
| `artists.json`, `genres.json`, `albums.json` | Seed payloads, upserted over `/data` by the example's `seed.py` |
| `prep_spotify.bb` | Reshapes a Kaggle Spotify CSV into those three files |

Entity names carry a `Music ` prefix because names are globally unique across
every dataset, and bare `Genre` already exists elsewhere.

There used to be a `build.clj` here that built and deployed the ERD from a
server REPL under the name "Synthigy Music" — a second dataset whose entity
names collided with the modeler-managed "Music Demo". Deleted: the export
above is the modeler-authored artifact and the one every example should
deploy, not a REPL reproducer that can drift from it.

## Regenerating the seed

```bash
bb prep_spotify.bb /path/to/spotify-tracks.csv --top 300
```

Without those files the example falls back to a small curated set, so it runs
with no download at all. Both carry explicit ids and link their relations by
id, so seeding twice upserts rather than duplicating.
