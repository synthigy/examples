// Read-path benchmark at ml-25m scale — nested search with filtering,
// ordering, per-parent limit, count, avg.
//
//   Movies released after 2000, ordered by title, limit 10. Per movie:
//   title, genre names, total rating count, average rating, top 3 rating
//   values (ordered value-descending).
//
// Times Hasura (GraphQL) and PostgREST (RPC) over HTTP. Synthigy's number
// is produced by competitors/synthigy_search.clj run inside the headless
// REPL (writes synthigy-result.json), folded in here so all three are
// normalised and diffed.
//
// Hasura uses the FK-column schema (auto-tracked relationships); PostgREST
// uses the movie_search() SQL function (aggregates not expressible in
// PostgREST query syntax when combined with a non-aggregated nested child).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const N = 30;
const HASURA = "http://localhost:8088/v1/graphql";
const HASURA_SECRET = "benchsecret";
const PGRST = "http://localhost:3001/rpc/movie_search";

const HASURA_QUERY = `query {
  movie(where: {release_year: {_gt: 2000}}, order_by: {title: asc}, limit: 10) {
    title
    movie_genre_mappings { movie_genre { name } }
    user_ratings_aggregate { aggregate { count avg { value } } }
    user_ratings(order_by: {value: desc}, limit: 3) { value }
  }
}`;

const round = (x) => (x == null ? null : Math.round(Number(x) * 1e6) / 1e6);
const canon = (rows) =>
  rows.map((r) => ({
    title: r.title,
    genres: [...r.genres].sort(),
    rating_count: Number(r.rating_count),
    avg_rating: round(r.avg_rating),
    top_ratings: [...r.top_ratings].map(Number).sort((a, b) => b - a),
  }));

const fromHasura = (data) =>
  canon(
    data.movie.map((m) => ({
      title: m.title,
      genres: m.movie_genre_mappings.map((mgm) => mgm.movie_genre.name),
      rating_count: m.user_ratings_aggregate.aggregate.count,
      avg_rating: m.user_ratings_aggregate.aggregate.avg.value,
      top_ratings: m.user_ratings.map((r) => r.value),
    })),
  );

const fromPgrst = (rows) =>
  canon(
    rows.map((r) => ({
      title: r.title,
      genres: r.genres ?? [],
      rating_count: r.rating_count,
      avg_rating: r.avg_rating,
      top_ratings: r.top_ratings ?? [],
    })),
  );

async function time(label, fn) {
  await fn(); // warm-up
  const ts = [];
  let last;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    last = await fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  const pct = (p) => ts[Math.min(ts.length - 1, Math.floor(ts.length * p))];
  return {
    label,
    min: ts[0],
    median: pct(0.5),
    p95: pct(0.95),
    result: last,
  };
}

async function hasura() {
  const res = await fetch(HASURA, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": HASURA_SECRET,
    },
    body: JSON.stringify({ query: HASURA_QUERY }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return fromHasura(j.data);
}

async function pgrst() {
  const res = await fetch(PGRST, { method: "POST" });
  return fromPgrst(await res.json());
}

const fmt = (n) => `${n.toFixed(2)} ms`;
console.log(`\nRead-path benchmark at ml-25m — nested search, ${N} iterations\n`);

const runs = [
  await time("Hasura (GraphQL/HTTP)", hasura),
  await time("PostgREST (RPC/HTTP)", pgrst),
];

const synPath = join(HERE, "synthigy-result.json");
if (existsSync(synPath)) {
  const s = JSON.parse(readFileSync(synPath, "utf8"));
  runs.unshift({
    label: "Synthigy (/data engine, in-process)",
    min: s.min,
    median: s.median,
    p95: s.p95,
    result: canon(s.result),
  });
} else {
  console.log("(synthigy-result.json missing — run the REPL harness first)\n");
}

console.log("  engine                                 min      median     p95");
console.log("  " + "-".repeat(64));
for (const r of runs)
  console.log(
    `  ${r.label.padEnd(36)} ${fmt(r.min).padStart(9)} ${fmt(r.median).padStart(10)} ${fmt(r.p95).padStart(9)}`,
  );

console.log("\nResult match:");
const base = runs[0];
const baseStr = JSON.stringify(base.result);
let allMatch = true;
for (const r of runs.slice(1)) {
  const ok = JSON.stringify(r.result) === baseStr;
  allMatch &&= ok;
  console.log(`  ${base.label}  vs  ${r.label}: ${ok ? "IDENTICAL" : "MISMATCH"}`);
  if (!ok) {
    for (let i = 0; i < Math.max(base.result.length, r.result.length); i++) {
      const a = JSON.stringify(base.result[i]);
      const b = JSON.stringify(r.result[i]);
      if (a !== b) console.log(`    row ${i}:\n      A ${a}\n      B ${b}`);
    }
  }
}
console.log();
