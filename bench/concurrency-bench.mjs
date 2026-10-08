// Test 2 — throughput under concurrency.
//
// Same nested search query as search-bench.mjs, but instead of one request
// at a time it drives sustained concurrent load and reports throughput +
// latency percentiles. All three engines go over HTTP (Synthigy via an
// OAuth client-credentials token) so the comparison includes each server's
// own request handling and connection pool.

const DURATION_MS = 3000;
const CONCURRENCY = [1, 8, 16, 32, 64];
const REQ_TIMEOUT_MS = 5000; // a hung request aborts here instead of stalling the run

const HASURA = "http://localhost:8088/v1/graphql";
const HASURA_SECRET = "benchsecret";
const PGRST = "http://localhost:3001/rpc/movie_search";
const SYN = "http://localhost:7887";
const SYN_CLIENT = "bench-read";
const SYN_SECRET = "bench-read-secret-2026";

const HASURA_QUERY = `query {
  movie(where: {release_year: {_gt: 2000}}, order_by: {title: asc}, limit: 10) {
    title
    genre_links { genre { name } }
    avg_rating
    rating_links_aggregate { aggregate { count } }
    rating_links(order_by: {rating: {value: desc}}, limit: 3) { rating { value } }
  }
}`;

const SYN_OP = {
  operations: [{
    op: "search",
    entity: "CuquTMuTdnWZUP6GxurJqM",
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

async function synToken() {
  const res = await fetch(`${SYN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${SYN_CLIENT}&client_secret=${SYN_SECRET}`,
  });
  return (await res.json()).access_token;
}

async function timedFetch(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function engines(token) {
  return {
    "Synthigy /data": async () => {
      const r = await timedFetch(`${SYN}/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(SYN_OP),
      });
      if (!r.ok) throw new Error(`syn ${r.status}`);
      await r.json();
    },
    "PostgREST": async () => {
      const r = await timedFetch(PGRST, { method: "POST" });
      if (!r.ok) throw new Error(`pgrst ${r.status}`);
      await r.json();
    },
  };
}

async function loadTest(queryFn, concurrency, durationMs) {
  const latencies = [];
  let errors = 0;
  let stop = false;
  const timer = setTimeout(() => { stop = true; }, durationMs);
  const worker = async () => {
    while (!stop) {
      const t0 = performance.now();
      try { await queryFn(); latencies.push(performance.now() - t0); }
      catch { errors++; }
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  clearTimeout(timer);
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  return {
    count: latencies.length,
    errors,
    throughput: latencies.length / elapsed,
    p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
  };
}

const token = await synToken();
const eng = engines(token);

console.log(`\nConcurrency benchmark — ${DURATION_MS}ms sustained load per cell\n`);

for (const [name, fn] of Object.entries(eng)) {
  console.log(`  ${name}`);
  console.log("  conc    req/s     p50      p95      p99    errors");
  console.log("  " + "-".repeat(52));
  for (const c of CONCURRENCY) {
    await fn(); // warm
    const r = await loadTest(fn, c, DURATION_MS);
    console.log(
      `  ${String(c).padStart(4)}  ${r.throughput.toFixed(0).padStart(7)}` +
      `  ${r.p50.toFixed(1).padStart(7)}  ${r.p95.toFixed(1).padStart(7)}` +
      `  ${r.p99.toFixed(1).padStart(7)}  ${String(r.errors).padStart(7)}`,
    );
  }
  console.log();
}
