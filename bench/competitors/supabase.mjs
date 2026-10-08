// Supabase import harness — MovieLens-small via the PostgREST data API.
//
// Supabase's data plane (/rest/v1) IS PostgREST. This harness drives the
// same PostgREST engine Supabase ships, against the same bench-postgres,
// so the "Supabase" row is measured on identical hardware/dataset/config
// as every other tool — see bench/README.md for the objectivity notes.
//
// Usage:  node competitors/supabase.mjs [batchSize]
//
// Assumes the bench stack is up (./setup.sh) — that also reloads the
// PostgREST schema cache.

import {
  loadDataset, loadDatasetJunctions, PHASES, PHASES_JUNCTIONS, chunk,
} from "../data.mjs";
import { makeTimer } from "../report.mjs";

const ENDPOINT = process.env.POSTGREST_URL ?? "http://localhost:3001";
const BATCH = Number(process.argv[2] ?? process.env.BATCH ?? 1000);
// SCHEMA=junctions → feature-matched (every relation a junction table).
const SCHEMA = process.env.SCHEMA ?? "fk";
const LABEL =
  process.env.CONFIG ??
  (SCHEMA === "junctions"
    ? "feature-matched (junction per relation)"
    : "config A (default fast path)");

async function waitForPostgrest() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${ENDPOINT}/`);
      if (res.ok || res.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("PostgREST not reachable at " + ENDPOINT);
}

async function insertBatch(table, objects) {
  const res = await fetch(`${ENDPOINT}/${table}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // PostgREST's fast path: don't serialize inserted rows back.
      prefer: "return=minimal",
    },
    body: JSON.stringify(objects),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostgREST ${res.status} on ${table}: ${body}`);
  }
  return objects.length;
}

async function main() {
  console.log(`\nSupabase import (PostgREST data API) — ${LABEL}, batch=${BATCH}\n`);
  await waitForPostgrest();

  const ds = SCHEMA === "junctions" ? loadDatasetJunctions() : loadDataset();
  const phases = SCHEMA === "junctions" ? PHASES_JUNCTIONS : PHASES;
  const timer = makeTimer();
  timer.start();

  for (const table of phases) {
    const rows = ds[table];
    await timer.phase(table, rows.length, async () => {
      let affected = 0;
      for (const batch of chunk(rows, BATCH)) {
        affected += await insertBatch(table, batch);
      }
      return affected;
    });
  }

  timer.report(`Supabase/PostgREST — ${LABEL} (batch ${BATCH})`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
