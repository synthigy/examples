// Loads MovieLens JSON payloads and reshapes them into flat, FK-resolved
// row arrays — the same dataset Synthigy's sync-entity import consumes.
// Shared by every competitor harness so the input is identical.
//
// Dataset selection via env var `DATASET` (default "movies", ml-latest-small):
//   DATASET=movies-25m node competitors/hasura.mjs
//
// Large datasets ship as sharded files (user_ratings_0001.json, ...). The
// loader globs and concatenates them transparently.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = process.env.DATASET ?? "movies";
const DATA = join(HERE, "..", "datasets", "movies", DATASET);

// movie/genre/actor/rating/tag fixtures carry `xid` (Base58 nanoid) natively
// post euuid-naming-sweep migration in core — competitor schemas use `text`
// PK/FK columns so these ids are used as-is, no uuid remap needed.
//
// users.json still carries the original euuid (untouched by the sweep,
// since Synthigy's own harness never imports it — see movies-bench README).
// Ratings/tags reference the user via `user.xid`, computed with Synthigy's
// uuid->nanoid — mirror that here so app_user gets the SAME nanoid id and no
// rating/tag foreign key needs remapping.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function euuidToXid(euuid) {
  let n = BigInt("0x" + euuid.replaceAll("-", ""));
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s.padStart(22, "1");
}

// Load `<base>.json` if present, otherwise concat `<base>_NNNN.json` shards.
// Accepts either "foo" or "foo.json" — same result.
function load(name) {
  const base = name.endsWith(".json") ? name.slice(0, -5) : name;
  const single = join(DATA, `${base}.json`);
  if (existsSync(single)) return JSON.parse(readFileSync(single, "utf8"));
  const shardRe = new RegExp(`^${base}_\\d+\\.json$`);
  const shards = readdirSync(DATA).filter((f) => shardRe.test(f)).sort();
  if (shards.length === 0) {
    throw new Error(`No ${base}.json or ${base}_NNNN.json in ${DATA}`);
  }
  const out = [];
  for (const f of shards) {
    const arr = JSON.parse(readFileSync(join(DATA, f), "utf8"));
    for (const x of arr) out.push(x);
  }
  return out;
}

export function loadDataset() {
  const movies = load("movies.json");
  const genres = load("movie_genres.json");
  const actorsRaw = load("movie_actors.json");
  const users = load("users.json");
  const ratings = load("user_ratings.json");
  const tags = load("user_tags.json");
  const genreMapRaw = load("movie_genres_mapping.json");
  const actorMapRaw = load("movie_actors_mapping.json");

  // The source has one accidental actor name collision ("Sam Phillips", two
  // xids). MovieActor.Name is a UNIQUE column, so dedupe by name here and
  // remap mapping rows to the surviving xid — every competitor then imports
  // an identical, internally consistent dataset (1465 actors, not 1466).
  const actorByName = new Map();
  const actorRemap = new Map();
  for (const a of actorsRaw) {
    const kept = actorByName.get(a.name);
    if (kept) actorRemap.set(a.xid, kept.xid);
    else actorByName.set(a.name, a);
  }
  const remapActor = (xid) => actorRemap.get(xid) ?? xid;

  return {
    // Entities — xid (Synthigy's own nanoid) is the PK (`id`) directly.
    movie: movies.map((m) => ({
      id: m.xid,
      title: m.title ?? null,
      release_year: m.release_year ?? null,
    })),
    movie_genre: genres.map((g) => ({ id: g.xid, name: g.name })),
    movie_actor: [...actorByName.values()].map((a) => ({
      id: a.xid,
      name: a.name,
      birth_year: a.birth_year ?? null,
      nationality: a.nationality ?? null,
    })),
    app_user: users.map((u) => ({
      id: euuidToXid(u.euuid),
      name: u.name ?? null,
      email: u.email ?? null,
    })),
    user_rating: ratings.map((r) => ({
      id: r.xid,
      value: r.value,
      timestamp: r.timestamp ?? null,
      movie_id: r.movie.xid,
      user_id: r.user.xid,
    })),
    user_tag: tags.map((t) => ({
      id: t.xid,
      value: t.value,
      timestamp: t.timestamp ?? null,
      movie_id: t.movie.xid,
      user_id: t.user.xid,
    })),
    // m2m mappings flattened to junction-row pairs.
    movie_genre_mapping: genreMapRaw.flatMap((g) =>
      g.movies.map((m) => ({ movie_id: m.xid, genre_id: g.xid })),
    ),
    movie_actor_mapping: dedupePairs(
      actorMapRaw.flatMap((a) =>
        a.movies.map((m) => ({
          movie_id: m.xid,
          actor_id: remapActor(a.xid),
        })),
      ),
      "movie_id",
      "actor_id",
    ),
  };
}

// Remapping actor euuids can produce duplicate junction pairs — collapse them.
function dedupePairs(pairs, a, b) {
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    const k = p[a] + "|" + p[b];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// Phase order respects FK dependencies.
export const PHASES = [
  "movie_genre",
  "movie_actor",
  "app_user",
  "movie",
  "movie_genre_mapping",
  "movie_actor_mapping",
  "user_rating",
  "user_tag",
];

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Feature-matched ("junctions") shape — mirrors Synthigy's data model: EVERY
// relation is its own junction table, no FK-column shortcut. ratings/tags
// carry no relation columns; rating→movie and tag→movie become junction rows.
// Matches Synthigy exactly: 5 entity tables + 4 junction tables, no app_user.
// ---------------------------------------------------------------------------

export function loadDatasetJunctions() {
  const fk = loadDataset();
  return {
    movie_genre: fk.movie_genre,
    movie_actor: fk.movie_actor,
    movie: fk.movie,
    user_rating: fk.user_rating.map((r) => ({
      id: r.id,
      value: r.value,
      timestamp: r.timestamp,
    })),
    user_tag: fk.user_tag.map((t) => ({
      id: t.id,
      value: t.value,
      timestamp: t.timestamp,
    })),
    movie_genre_mapping: fk.movie_genre_mapping,
    movie_actor_mapping: fk.movie_actor_mapping,
    user_rating_movie: fk.user_rating.map((r) => ({
      user_rating_id: r.id,
      movie_id: r.movie_id,
    })),
    user_tag_movie: fk.user_tag.map((t) => ({
      user_tag_id: t.id,
      movie_id: t.movie_id,
    })),
  };
}

export const PHASES_JUNCTIONS = [
  "movie_genre",
  "movie_actor",
  "movie",
  "user_rating",
  "user_tag",
  "movie_genre_mapping",
  "movie_actor_mapping",
  "user_rating_movie",
  "user_tag_movie",
];
