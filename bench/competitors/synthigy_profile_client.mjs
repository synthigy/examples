// Client-side timing probe for the /data write path.
//
// Drives the dominant `user_rating` phase (100,836 rows ≈ 80% of every
// tool's wall time) through /data, splitting wall time into:
//
//   prep    — JSON.stringify on the batch (client serialize cost)
//   network — fetch() resolve (network + server-side parse + work + serialize)
//   parse   — res.json() (client deserialize cost)
//
// Pairs with synthigy_profile.clj's server-side probes — together they
// decompose the network leg of the request, so you can subtract:
//
//   wire = network − (server :parse-body + :execute-ops + :transform + :format-response)
//
// Run via run_synthigy_profile.sh (boots a REPL with probes installed
// before this script runs).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.SYNTHIGY_URL ?? "http://localhost:7897";
const BATCH = Number(process.env.BATCH ?? 1000);
const DATASET = process.env.DATASET ?? "movies";
const DATA = join(HERE, "..", "..", "datasets", DATASET);

function loadJson(base) {
  const single = join(DATA, `${base}.json`);
  if (existsSync(single)) return JSON.parse(readFileSync(single, "utf8"));
  const re = new RegExp(`^${base}_\\d+\\.json$`);
  const shards = readdirSync(DATA).filter((f) => re.test(f)).sort();
  if (!shards.length) throw new Error(`No ${base}.json in ${DATA}`);
  return shards.flatMap((f) => JSON.parse(readFileSync(join(DATA, f), "utf8")));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtMs(ms) { return ms.toFixed(1).padStart(8); }
function fmtUs(us) { return us.toFixed(0).padStart(8); }
function fmtPct(part, total) {
  return total > 0 ? ((100 * part) / total).toFixed(1).padStart(5) : "  0.0";
}

async function main() {
  console.log(`\nSynthigy profile — user_rating phase, batch=${BATCH}`);
  console.log(`Endpoint: ${ENDPOINT}\n`);

  let ratings = loadJson("user_ratings").map((r) => ({
    xid: r.xid,
    value: r.value,
    timestamp: r.timestamp ?? null,
    movie: { xid: r.movie.xid },
  }));
  // SLICE=start:end for A/B halves against fresh (never-before-inserted) rows.
  if (process.env.SLICE) {
    const [s, e] = process.env.SLICE.split(":").map(Number);
    ratings = ratings.slice(s, e);
  }

  console.log(`Rows: ${ratings.length}`);
  const batches = chunk(ratings, BATCH);
  console.log(`Batches: ${batches.length} (${BATCH} rows each)\n`);

  let totalPrep = 0, totalNet = 0, totalParse = 0;
  const wallStart = performance.now();

  for (const b of batches) {
    // 1. prep — build payload + JSON.stringify
    const t0 = performance.now();
    const body = JSON.stringify({
      operations: [{ op: "sync", entity: "User Rating", data: b }],
    });
    const t1 = performance.now();

    // 2. network — fetch + read body
    const res = await fetch(`${ENDPOINT}/data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    const t2 = performance.now();

    // 3. parse — JSON.parse on the response
    const json = JSON.parse(text);
    const t3 = performance.now();

    if (!res.ok || !json.results?.[0]?.ok) {
      throw new Error(`/data failed: ${text}`);
    }

    totalPrep  += (t1 - t0);
    totalNet   += (t2 - t1);
    totalParse += (t3 - t2);
  }

  const wallMs = performance.now() - wallStart;
  const otherMs = wallMs - totalPrep - totalNet - totalParse;

  console.log(`Wall time: ${(wallMs / 1000).toFixed(2)} s\n`);
  console.log(`  stage             total ms   per-batch ms   share`);
  console.log(`  ${"-".repeat(58)}`);
  console.log(`  prep (stringify) ${fmtMs(totalPrep)}      ${fmtMs(totalPrep / batches.length)}    ${fmtPct(totalPrep, wallMs)}%`);
  console.log(`  network (fetch)  ${fmtMs(totalNet)}      ${fmtMs(totalNet / batches.length)}    ${fmtPct(totalNet, wallMs)}%`);
  console.log(`  parse (response) ${fmtMs(totalParse)}      ${fmtMs(totalParse / batches.length)}    ${fmtPct(totalParse, wallMs)}%`);
  console.log(`  other (loop ovh) ${fmtMs(otherMs)}      ${fmtMs(otherMs / batches.length)}    ${fmtPct(otherMs, wallMs)}%`);
  console.log(`  ${"-".repeat(58)}`);
  console.log(`  TOTAL            ${fmtMs(wallMs)}      ${fmtMs(wallMs / batches.length)}    100.0%\n`);
  console.log(`Per-row averages (across ${ratings.length} rows):`);
  console.log(`  prep    ${fmtUs((totalPrep / ratings.length) * 1000)} us`);
  console.log(`  network ${fmtUs((totalNet / ratings.length) * 1000)} us`);
  console.log(`  parse   ${fmtUs((totalParse / ratings.length) * 1000)} us\n`);
  console.log("Now query the REPL for the server-side breakdown:");
  console.log("  (synthigy-bench.profile/report!)\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
