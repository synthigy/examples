// Read-path benchmark — HTTP variant.
//
// Same nested search query as search-bench.mjs, but ALL THREE engines are
// measured the same way: over HTTP against their real running server.
// Synthigy is hit at :7887/data via an OAuth client-credentials token, so
// its number now includes the Pedestal request path, auth, JSON (de)serde
// and connection pool — directly comparable to Hasura/PostgREST.

const N = 30;

const HASURA = "http://localhost:8088/v1/graphql";
const HASURA_SECRET = "benchsecret";
const PGRST = "http://localhost:3001/rpc/movie_search";
const SYN = "http://localhost:7887";
const SYN_CLIENT = "bench-read";
const SYN_SECRET = "bench-read-secret-2026";
const SYN_ENTITY = "CuquTMuTdnWZUP6GxurJqM";

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

// acting_as: bench-read is a trusted confidential client; it impersonates
// the SYNTHIGY superuser so the Phase-1 fused read path's safety gate
// (superuser + no-RLS) engages on the HTTP request path.
const SYN_ACTING_AS = "RQb935cnLog5tiFsXgfMhv";

const SYN_OP = {
  operations: [{
    op: "search",
    entity: SYN_ENTITY,
    args: { release_year: { _gt: 2000 }, _order_by: { title: "asc" }, _limit: 10 },
    selections: {
      title: null,
      genres: [{ selections: { name: null } }],
      _count: [{ selections: { movie_ratings: [null] } }],
      _agg: [{ selections: { movie_ratings: [{ selections: { value: [{ selections: { avg: null } }] } }] } }],
      movie_ratings: [{ args: { _order_by: { value: "desc" }, _limit: 3 }, selections: { value: null } }],
    },
  }],
};

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

const fromSyn = (j) =>
  canon(
    j.results[0].data.map((m) => ({
      title: m.title,
      genres: m.genres.map((g) => g.name),
      rating_count: m._count.movie_ratings,
      avg_rating: m._agg.movie_ratings.avg.value,
      top_ratings: m.movie_ratings.map((r) => r.value),
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
  return { label, min: ts[0], median: pct(0.5), p95: pct(0.95), result: last };
}

async function synToken() {
  const res = await fetch(`${SYN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${SYN_CLIENT}&client_secret=${SYN_SECRET}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`syn token: ${JSON.stringify(j)}`);
  return j.access_token;
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

function synthigy(token) {
  return async () => {
    const res = await fetch(`${SYN}/data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(SYN_OP),
    });
    if (!res.ok) throw new Error(`syn ${res.status}`);
    const j = await res.json();
    if (!j.results?.[0]?.ok) throw new Error(`syn op: ${JSON.stringify(j)}`);
    return fromSyn(j);
  };
}

// --- run ------------------------------------------------------------------
const fmt = (n) => `${n.toFixed(2)} ms`;
console.log(`\nRead-path benchmark (HTTP) — nested search, ${N} iterations`);
console.log(`all three engines over HTTP against their running server\n`);

const token = await synToken();

const runs = [];
for (const [label, fn] of [
  ["Synthigy (/data HTTP)", synthigy(token)],
  ["Hasura (GraphQL/HTTP)", hasura],
  ["PostgREST (RPC/HTTP)", pgrst],
]) {
  try { runs.push(await time(label, fn)); }
  catch (e) { console.log(`  ${label}: SKIPPED — ${e.message}`); }
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
