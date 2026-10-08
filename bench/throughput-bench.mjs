// Throughput bench — peak search requests/minute, Synthigy vs Hasura.
//
// Drives the nested search query (docs/plans/bench/SEARCH.md) at rising concurrency, 5s of
// sustained load per cell, and reports throughput as req/s and req/min.
// Both engines over HTTP against their running server.

const DURATION_MS = 5000;
const CONCURRENCY = [1, 4, 8, 16, 32, 64, 128];
const REQ_TIMEOUT_MS = 10000;

const HASURA = "http://localhost:8088/v1/graphql";
const HASURA_SECRET = "benchsecret";
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
    rating_links(order_by: {rating: {value: desc}}, limit: 3) { rating { value } }
  }
}`;

// acting_as: bench-read impersonates the SYNTHIGY superuser so the
// Phase-1 fused read path engages on the HTTP request path.
const SYN_ACTING_AS = "RQb935cnLog5tiFsXgfMhv";

const SYN_OP = {
  acting_as: SYN_ACTING_AS,
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

async function timedFetch(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function engines(token) {
  return {
    Synthigy: async () => {
      const r = await timedFetch(`${SYN}/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(SYN_OP),
      });
      if (!r.ok) throw new Error(`syn ${r.status}`);
      await r.json();
    },
    Hasura: async () => {
      const r = await timedFetch(HASURA, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hasura-admin-secret": HASURA_SECRET },
        body: JSON.stringify({ query: HASURA_QUERY }),
      });
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors));
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
    reqPerSec: latencies.length / elapsed,
    count: latencies.length,
    errors,
    p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
  };
}

const token = await synToken();
const eng = engines(token);

console.log(`\nThroughput benchmark — nested search query`);
console.log(`${DURATION_MS / 1000}s sustained load per concurrency level\n`);

const peaks = {};
for (const [name, fn] of Object.entries(eng)) {
  console.log(`  ${name}`);
  console.log("  conc      req/s       req/min      p50      p95      p99   errors");
  console.log("  " + "-".repeat(68));
  let peak = 0;
  for (const c of CONCURRENCY) {
    await fn(); // warm
    const r = await loadTest(fn, c, DURATION_MS);
    peak = Math.max(peak, r.reqPerSec);
    console.log(
      `  ${String(c).padStart(4)}  ${r.reqPerSec.toFixed(0).padStart(9)}` +
      `  ${Math.round(r.reqPerSec * 60).toLocaleString().padStart(12)}` +
      `  ${r.p50.toFixed(1).padStart(7)}  ${r.p95.toFixed(1).padStart(7)}` +
      `  ${r.p99.toFixed(1).padStart(7)}  ${String(r.errors).padStart(6)}`,
    );
  }
  peaks[name] = peak;
  console.log();
}

console.log("  Peak sustained throughput");
console.log("  " + "-".repeat(40));
for (const [name, p] of Object.entries(peaks))
  console.log(`  ${name.padEnd(10)} ${Math.round(p).toLocaleString().padStart(8)} req/s   ${Math.round(p * 60).toLocaleString().padStart(11)} req/min`);
const [a, b] = Object.values(peaks);
const [an, bn] = Object.keys(peaks);
console.log(`\n  ${an} sustains ${(a / b * 100).toFixed(0)}% of ${bn}'s peak throughput.\n`);
