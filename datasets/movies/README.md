# Movies dataset

The model and seed data behind the `movies` examples and `bench/`.

| Path | What |
|---|---|
| `Movies Example@0.4.json` | Deployable model (transit-ish JSON export) — includes `MovieActor.Avatar` and `Movie.Poster` |
| `movies/` | ml-latest-small import payloads — committed |
| `movies-25m/` | ml-25m, sharded — derived, gitignored |

Superseded model exports (`Movies Example@0.3.json`, pre-Poster;
`movies-example-0.3.json`, an earlier plain-format export of the same;
`movies-example-0.2.json`, pre-Avatar/pre-Poster) live in the repo root's
`.attic/examples/datasets/movies/` — gitignored, kept for reference only,
never deployed from there.

Import payloads are addressed by directory name, which is what the `DATASET`
(JS harnesses) and `MOVIES_DATASET` (Clojure harnesses) environment variables
select. Default is `movies`.

## Regenerating

```bash
# MovieLens CSVs -> Synthigy import JSON
bb prep_movielens.bb <path-to-ml-dir> movies

# larger variants shard the ratings/tags files
bb prep_movielens.bb <path-to-ml-25m> movies-25m --shard 500000

# actor/credit enrichment from TMDb (needs TMDB_TOKEN_FILE or TMDB_TOKEN;
# caches to $TMDB_CACHE_DIR, default /tmp/tmdb-cache)
bb enrich_tmdb.bb <path-to-ml-dir> movies 200

# movie poster enrichment from TMDb — every movie in links.csv with a TMDb id
# (same TMDB_TOKEN_FILE/TMDB_TOKEN, same cache dir, separate movie-details/ subdir)
bb enrich_tmdb_posters.bb <path-to-ml-dir> movies
```

`bake_xid.clj` rewrites `:euuid` to deterministic `:xid` in place, matching the
import path's own conversion. It needs a REPL with `synthigy.dataset.id` on the
classpath. `enrich_tmdb_posters.bb` emits `movie_posters.json` keyed by
`:euuid` — bake it the same way, then left-merge `:poster` into `movies.json`
by matching `:xid` (movies with no TMDb match keep no `poster` key).
