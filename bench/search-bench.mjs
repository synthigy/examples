// Read-path benchmark — the nested search query from docs/plans/bench/SEARCH.md.
//
//   Movies released after 2000, ordered by title, limit 10. Per movie:
//   title, genre names, total rating count, average rating, and the 3
//   highest rating values (value >= 4, ordered value desc).
//
// Times Hasura (GraphQL) and PostgREST (RPC) over HTTP. Synthigy's number
// + result are produced separately by the REPL (synthigy-result.json) and
// folded in here so all three are normalised and diffed identically.

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
    genre_links { genre { name } }
    avg_rating
    rating_links_aggregate { aggregate { count } }
    rating_links(order_by: {rating: {value: desc}}, limit: 3) {
      rating { value }
    }
  }
}`;

// --- normalisation: collapse each engine's shape to one canonical form ----
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
      genres: m.genre_links.map((g) => g.genre.name),
      rating_count: m.rating_links_aggregate.aggregate.count,
      avg_rating: m.avg_rating,
      top_ratings: m.rating_links.map((rl) => rl.rating.value),
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

// --- timing ---------------------------------------------------------------
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

// --- run ------------------------------------------------------------------
const fmt = (n) => `${n.toFixed(2)} ms`;
console.log(`\nRead-path benchmark — nested search, ${N} iterations\n`);

const runs = [await time("Hasura (GraphQL/HTTP)", hasura),
              await time("PostgREST (RPC/HTTP)", pgrst)];

// Synthigy — produced by the REPL harness
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

// --- result match ---------------------------------------------------------
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
console.log(
  `\n${allMatch ? "ALL ENGINES RETURN IDENTICAL RESULTS" : "RESULTS DIFFER"} — ${base.result.length} rows\n`,
);
