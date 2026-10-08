// Test 3 — latency vs query depth.
//
// Traversal: movie -> genres -> (other) movies -> actors. Measured at depth
// 1 (movies only) through 4 (all the way to actors), 5 movies at the root,
// order + limit 3 at every level, left joins so all engines nest alike.
// The question: does Synthigy's per-relation cursor fan-out degrade with
// depth versus Hasura's single compiled SQL.

const N = 20;
const HASURA = "http://localhost:8088/v1/graphql";
const HASURA_SECRET = "benchsecret";
const PGRST = "http://localhost:3001";
// the engine bench.sh boots (default :7888); bare mode accepts every request, so a
// token is only needed against a full server (SYNTHIGY_TOKEN, as bench.sh passes it)
const SYN = process.env.SYNTHIGY_URL ?? "http://localhost:7888";


// --- Synthigy /data selection, built to `depth` -------------------------
const rel = (order, sel) => [{ args: { _order_by: order, _limit: 3, _join: "left" }, selections: sel }];
function synSelections(depth) {
  let sel = { title: null };
  if (depth >= 2) {
    let g = { name: null };
    if (depth >= 3) {
      let m = { title: null };
      if (depth >= 4) m = { ...m, actors: rel({ name: "asc" }, { name: null }) };
      g = { ...g, movies: rel({ title: "asc" }, m) };
    }
    sel = { ...sel, genres: rel({ name: "asc" }, g) };
  }
  return sel;
}

// --- Hasura GraphQL, built to `depth` (each level is 2 hops via junction) -
function hasuraQuery(depth) {
  let inner = "title";
  if (depth >= 2) {
    let g = "name";
    if (depth >= 3) {
      let m = "title";
      if (depth >= 4)
        m += ` actor_links(order_by: {actor: {name: asc}}, limit: 3) { actor { name } }`;
      g += ` movie_links(order_by: {movie: {title: asc}}, limit: 3) { movie { ${m} } }`;
    }
    inner += ` genre_links(order_by: {genre: {name: asc}}, limit: 3) { genre { ${g} } }`;
  }
  return `query { movie(where: {release_year: {_gt: 2010}}, order_by: {title: asc}, limit: 5) { ${inner} } }`;
}

// --- PostgREST embed URL, built to `depth` ------------------------------
function pgrstUrl(depth) {
  let select = "title";
  const params = ["release_year=gt.2010", "order=title", "limit=5"];
  if (depth >= 2) {
    let g = "name";
    if (depth >= 3) {
      let m = "title";
      if (depth >= 4) {
        m += ",movie_actor(name)";
        params.push("movie_genre.movie.movie_actor.order=name", "movie_genre.movie.movie_actor.limit=3");
      }
      g += `,movie(${m})`;
      params.push("movie_genre.movie.order=title", "movie_genre.movie.limit=3");
    }
    select += `,movie_genre(${g})`;
    params.push("movie_genre.order=name", "movie_genre.limit=3");
  }
  return `${PGRST}/movie?select=${select}&${params.join("&")}`;
}

async function time(fn, runs = N) {
  await fn();
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(runs / 2)]; // median
}

async function abortable(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

const token = process.env.SYNTHIGY_TOKEN;

const syn = (depth) => async () => {
  const r = await fetch(`${SYN}/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      // acting_as the SYNTHIGY superuser so the fused read path engages.
      acting_as: "RQb935cnLog5tiFsXgfMhv",
      operations: [{ op: "search", entity: "CuquTMuTdnWZUP6GxurJqM",
        args: { release_year: { _gt: 2010 }, _order_by: { title: "asc" }, _limit: 5 },
        selections: synSelections(depth) }],
    }),
  });
  const j = await r.json();
  if (!r.ok || j.results?.[0]?.ok === false) throw new Error(JSON.stringify(j));
  return j;
};

const hasura = (depth) => async () => {
  const r = await fetch(HASURA, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hasura-admin-secret": HASURA_SECRET },
    body: JSON.stringify({ query: hasuraQuery(depth) }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j;
};

const pgrst = (depth) => async () => {
  const r = await abortable(pgrstUrl(depth));
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
};

console.log(`\nDepth benchmark — median of ${N} runs (ms)\n`);
console.log("  depth   Synthigy    Hasura   PostgREST");
console.log("  " + "-".repeat(42));
for (let d = 1; d <= 4; d++) {
  const cell = async (mk, runs) => {
    try { return (await time(mk(d), runs)).toFixed(2); }
    catch (e) { return "ERR"; }
  };
  const s = await cell(syn, N);
  const h = await cell(hasura, N);
  // PostgREST recursive m2m embedding is slow past depth 2 — fewer runs.
  const p = await cell(pgrst, d >= 3 ? 3 : N);
  console.log(`  ${d}     ${s.padStart(9)} ${h.padStart(9)} ${p.padStart(11)}`);
}
console.log();
