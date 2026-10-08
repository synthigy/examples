// Hasura import harness — MovieLens-small, config A (default fast path:
// auto-generated insert mutations, no audit, no row permissions).
//
// Usage:  node competitors/hasura.mjs [batchSize]
//
// Assumes the bench stack is up (docker compose up -d) and schema.sql has
// been applied. Tracks every table, then runs the timed import.

import {
  loadDataset, loadDatasetJunctions, PHASES, PHASES_JUNCTIONS, chunk,
} from "../data.mjs";
import { makeTimer } from "../report.mjs";

const ENDPOINT = process.env.HASURA_URL ?? "http://localhost:8088";
const SECRET = process.env.HASURA_SECRET ?? "benchsecret";
const BATCH = Number(process.argv[2] ?? process.env.BATCH ?? 1000);
// SCHEMA=junctions → feature-matched (every relation a junction table).
const SCHEMA = process.env.SCHEMA ?? "fk";
const LABEL =
  process.env.CONFIG ??
  (SCHEMA === "junctions"
    ? "feature-matched (junction per relation)"
    : "config A (default fast path)");

// Phase names ARE the table names — track exactly the tables this run uses.
const TABLES = SCHEMA === "junctions" ? PHASES_JUNCTIONS : PHASES;

async function metadata(body) {
  const res = await fetch(`${ENDPOINT}/v1/metadata`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": SECRET },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, json: await res.json() };
}

async function graphql(query, variables) {
  const res = await fetch(`${ENDPOINT}/v1/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

async function waitForHasura() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${ENDPOINT}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Hasura did not become healthy at " + ENDPOINT);
}

async function trackTables() {
  // Clear all metadata then track fresh. Bulletproof across schema swaps
  // (./setup.sh drops/recreates tables, leaving stale tracked metadata).
  // The `default` source is env-var-backed (HASURA_GRAPHQL_DATABASE_URL)
  // and survives clear_metadata — only the tracked tables get cleared.
  await metadata({ type: "clear_metadata", args: {} });
  const { ok, json } = await metadata({
    type: "bulk",
    args: TABLES.map((table) => ({
      type: "pg_track_table",
      args: { source: "default", table },
    })),
  });
  if (!ok) throw new Error("track tables failed: " + JSON.stringify(json));
}

async function insertBatch(table, objects) {
  const data = await graphql(
    `mutation ins($o: [${table}_insert_input!]!) {
       insert_${table}(objects: $o) { affected_rows }
     }`,
    { o: objects },
  );
  return data[`insert_${table}`].affected_rows;
}

async function main() {
  console.log(`\nHasura import — ${LABEL}, batch=${BATCH}\n`);
  await waitForHasura();
  await trackTables();

  const ds = SCHEMA === "junctions" ? loadDatasetJunctions() : loadDataset();
  const timer = makeTimer();
  timer.start();

  for (const table of TABLES) {
    const rows = ds[table];
    await timer.phase(table, rows.length, async () => {
      let affected = 0;
      for (const batch of chunk(rows, BATCH)) {
        affected += await insertBatch(table, batch);
      }
      return affected;
    });
  }

  timer.report(`Hasura — ${LABEL} (batch ${BATCH})`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
