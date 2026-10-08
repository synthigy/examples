// Synthigy import harness — MovieLens via the /data HTTP endpoint, e2e.
//
// Drives :synthigy/bare-server (the no-IAM/no-audit data-only mode) over
// HTTP, so the measurement reflects the same wire path a real SDK client
// pays — matching how Hasura and Supabase are measured.
//
// Bare-server has no auth (auth.required=false at /.well-known/synthigy),
// so no token is needed. Reset between runs by dropping+recreating the
// `synthigy` DB and redeploying the model.
//
// Usage:
//   node competitors/synthigy_http.mjs [batchSize]
//
// Assumes a Synthigy bare-server is running at SYNTHIGY_URL (default
// http://localhost:7887) with the "Movies Example" model deployed.

import {
  readFileSync, readdirSync, existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeTimer } from "../report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.SYNTHIGY_URL ?? "http://localhost:7887";
const BATCH = Number(process.argv[2] ?? process.env.BATCH ?? 1000);
const DATASET = process.env.DATASET ?? "movies";
const DATA = join(HERE, "..", "..", "datasets", DATASET);
const LABEL = process.env.CONFIG ?? "bare-server (no IAM / no audit)";

// ---------------------------------------------------------------------------
// Dataset loading — mirrors synthigy_import.clj/load-small, reshapes into
// Synthigy's sync-entity shape (relations as nested {xid:...} maps).
// ---------------------------------------------------------------------------

function loadJson(base) {
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

function reshape() {
  // Small entities — dataset fixtures now carry `xid` natively (post
  // euuid-naming-sweep migration in core).
  const genres = loadJson("movie_genres").map((g) => ({
    xid: g.xid,
    name: g.name,
  }));

  // Actors — dedupe by name (Name is UNIQUE), build xid remap for the
  // collided actor so its mapping rows merge under the surviving xid.
  const actorsRaw = loadJson("movie_actors");
  const byName = new Map();
  const remap = new Map();
  for (const a of actorsRaw) {
    const kept = byName.get(a.name);
    if (kept) remap.set(a.xid, kept.xid);
    else byName.set(a.name, a);
  }
  const actors = [...byName.values()].map((a) => ({
    xid: a.xid,
    name: a.name,
    birth_year: a.birth_year ?? null,
    nationality: a.nationality ?? null,
  }));
  const remapActorXid = (x) => remap.get(x) ?? x;

  const movies = loadJson("movies").map((m) => ({
    xid: m.xid,
    title: m.title ?? null,
    release_year: m.release_year ?? null,
  }));

  // m2m maps — sync via parent entity with the relation populated.
  // Genre-map: each row is the genre with its movies xid list.
  const genreMap = loadJson("movie_genres_mapping").map((g) => ({
    xid: g.xid,
    movies: g.movies.map((m) => ({ xid: m.xid })),
  }));

  // Actor-map: collapse rows for collided actors into a single row whose
  // :movies is the union of both originals.
  const actorMapByXid = new Map();
  for (const a of loadJson("movie_actors_mapping")) {
    const actorXid = remapActorXid(a.xid);
    const movies = a.movies.map((m) => ({ xid: m.xid }));
    const prev = actorMapByXid.get(actorXid);
    if (prev) {
      const seen = new Set(prev.movies.map((m) => m.xid));
      for (const m of movies) if (!seen.has(m.xid)) prev.movies.push(m);
    } else {
      actorMapByXid.set(actorXid, { xid: actorXid, movies });
    }
  }
  const actorMap = [...actorMapByXid.values()];

  // Ratings / tags — keep only the keys the deployed model declares.
  const ratings = loadJson("user_ratings").map((r) => ({
    xid: r.xid,
    value: r.value,
    timestamp: r.timestamp ?? null,
    movie: { xid: r.movie.xid },
  }));
  const tags = loadJson("user_tags").map((t) => ({
    xid: t.xid,
    value: t.value,
    timestamp: t.timestamp ?? null,
    movie: { xid: t.movie.xid },
  }));

  // Phase count for the m2m phases is the link count, not the parent count,
  // so the reported rec/s matches the Clojure harness and the competitors.
  const linkCount = (recs) => recs.reduce((s, r) => s + r.movies.length, 0);

  return [
    { phase: "movie_genre",          entity: "Movie Genre",  rows: genres,   count: genres.length },
    { phase: "movie_actor",          entity: "Movie Actor",  rows: actors,   count: actors.length },
    { phase: "movie",                entity: "Movie",        rows: movies,   count: movies.length },
    { phase: "movie_genre_mapping",  entity: "Movie Genre",  rows: genreMap, count: linkCount(genreMap) },
    { phase: "movie_actor_mapping",  entity: "Movie Actor",  rows: actorMap, count: linkCount(actorMap) },
    { phase: "user_rating",          entity: "User Rating",  rows: ratings,  count: ratings.length },
    { phase: "user_tag",             entity: "User Tag",     rows: tags,     count: tags.length },
  ];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${ENDPOINT}/.well-known/synthigy`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Synthigy not reachable at ${ENDPOINT}`);
}

async function postSync(entity, data) {
  const res = await fetch(`${ENDPOINT}/data`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SYNTHIGY_TOKEN
        ? { authorization: `Bearer ${process.env.SYNTHIGY_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      operations: [{ op: "sync", entity, data }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`/data ${res.status} on ${entity}: ${body}`);
  }
  const json = await res.json();
  const r = json.results?.[0];
  if (!r?.ok) {
    throw new Error(`/data sync failed on ${entity}: ${JSON.stringify(r?.error)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nSynthigy import (HTTP /data) — ${LABEL}, batch=${BATCH}\n`);
  await waitForServer();

  console.log("Loading + reshaping dataset...");
  const t0 = performance.now();
  const phases = reshape();
  const loadSecs = (performance.now() - t0) / 1000;
  console.log(`  loaded in ${loadSecs.toFixed(2)}s\n`);

  const timer = makeTimer();
  timer.start();

  for (const { phase, entity, rows, count } of phases) {
    await timer.phase(phase, count, async () => {
      for (const batch of chunk(rows, BATCH)) {
        await postSync(entity, batch);
      }
      return count;
    });
  }

  timer.report(`Synthigy (HTTP, bare-server) — ${LABEL} (batch ${BATCH})`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
