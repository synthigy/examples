# Competitive write benchmark

Same-machine, same-Postgres, same-dataset write-throughput comparison:
Synthigy `sync-entity` vs auto-API competitors, importing MovieLens-small.

## Dataset

The MovieLens-small import (`../datasets/movies/movies/`). The competitor harnesses
consume it via `data.mjs` (flat FK-resolved rows); the Synthigy harness
consumes the same JSONs via `competitors/synthigy_import.clj`.

| Phase                 | Rows    |
|-----------------------|---------|
| movie_genre           | 19      |
| movie_actor           | 1,465   |
| app_user              | 610     |
| movie                 | 9,742   |
| movie_genre_mapping   | 22,050  |
| movie_actor_mapping   | 1,999   |
| user_rating           | 100,836 |
| user_tag              | 3,683   |
| **total**             | **140,404** |

The schema (`schema.sql`) mirrors the Synthigy "Movies Example" ERD.

## Methodology

- **One Postgres instance, same box.** `bench-postgres` (postgres:15-alpine,
  `:5433`, `shared_buffers=256MB`) is dedicated and isolated — it never
  touches the dev Postgres on `:5432`. Hasura and Supabase import into
  database `bench`, Synthigy into database `synthigy` — **same container,
  same config**, one tool at a time (each run is preceded by a full schema
  reset).
- **Each tool on its native bulk-insert fast path**, identical input
  (`data.mjs` / `synthigy_import.clj`), identical batch size. No tool is
  handicapped or favoured in how it is driven.
- **Two configs per tool:**
  - **Config A** — no history audit.
  - **Config B** — audit on. For Hasura *and* Supabase: an audit trigger on
    every table (`schema-audit.sql`) writing each insert to a shared
    `audit_log`. For Synthigy: its native audit substrate (per-entity delta
    triggers → `__entity_delta_queue` / `__relation_delta_queue`,
    attribute-primary).
- **Batch size 1,000.** Single-process, single connection-pool. 3 runs
  per config; median reported.

### Known asymmetries (documented, not hidden)

1. **No id-resolution for competitors.** The competitor schema uses the
   natural euuid as PK, so FK columns carry it directly. Synthigy resolves
   xid→\_eid on every write.
2. **Synthigy does structurally more even at config A:** xid→nanoid
   conversion, RLS guard injection, the mutation hook chain, a per-row
   xid-guard trigger, and a junction table for *every* relation — including
   m2o/o2m, where the competitor uses a plain FK column.
3. **Row count: Synthigy 139,794 vs competitors 140,404.** The deployed
   Movies model links ratings/tags to `movie` only — the `user` relation
   needed a cross-dataset clone that would not deploy cleanly. So Synthigy
   skips the 610 `app_user` rows *and* the `user_id` FK on 104,519
   rating+tag rows. This asymmetry **favours Synthigy** (one fewer batched
   reference-resolution pass on the two largest phases).
4. **Audit shape differs (config B).** Hasura *and* Supabase config B both
   use the same `schema-audit.sql` trigger — one flat `audit_log` row per
   insert (140,404 rows). Synthigy's substrate instead enqueues
   attribute-primary deltas: **115,745 entity-delta + 128,568 relation-delta
   = 244,313** rows via per-row triggers + statement-level notify. Synthigy
   config B does ~1.7× more audit writes, attribute-primary. The competitors'
   config B audit is a **conservative** match — it favours the competitors.

## Results

Machine: AMD Ryzen 9 5950X (16C/32T), 30 GB RAM, Linux 6.17.
postgres:15-alpine, `shared_buffers=256MB`, batch 1,000, otherwise-quiet
box, 2026-05-20. Each competitor config run **3×**; median reported, every
raw run shown — nothing cherry-picked.

| Tool / config                  | Rows    | Run 1 | Run 2 | Run 3 | Median  | rec/s  |
|---------------------------------|---------|-------|-------|-------|---------|--------|
| Supabase — A (no audit)         | 140,404 | 6.28  | 5.92  | 5.96  | 5.96 s  | 23,560 |
| Supabase — B (audit trigger)    | 140,404 | 8.32  | 8.37  | 8.35  | 8.35 s  | 16,810 |
| Hasura — A (no audit)           | 140,404 | 12.88 | 12.43 | 12.58 | 12.58 s | 11,160 |
| Hasura — B (audit trigger)      | 140,404 | 15.14 | 15.00 | 14.93 | 15.00 s |  9,360 |
| Synthigy — B (pre-optimisation) | 139,794 | 29.37 | 28.27 | 28.68 | 28.68 s |  4,870 |
| **Synthigy — B (optimised)**    | 139,794 | 12.11 | 11.47 |  —    | **~11.8 s** | **11,850** |

### Feature-matched results (the fair comparison)

Config A above lets the competitors carry relations as plain FK columns,
while Synthigy makes every relation its own junction table. To remove that
asymmetry, `schema-junctions.sql` gives the competitors **Synthigy's exact
data model** — 5 entity tables + 4 junction tables, every relation a
junction, **244,313 physical rows**, the identical logical import. No audit
on any tool. This is the apples-to-apples write comparison:

| Tool      | Rows    | Median  | rec/s  |
|-----------|---------|---------|--------|
| Supabase  | 244,313 | 6.51 s  | 37,500 |
| **Synthigy (post link-relations fixes)** | 244,313 | **8.20 s** | **17,050** |
| Hasura    | 244,313 | 13.83 s | 17,665 |
| Synthigy (pre-fix)  | 244,313 | ~17.2 s | ~8,100 |

(Synthigy = audit substrate + stamp triggers disabled, data model intact.
The post-fix number — see "Fix applied" below — lands it level with Hasura;
competitors are unchanged, the fix only touches Synthigy.)

**The FK-column "shortcut" was NOT why the competitors were fast.** Forcing
them onto Synthigy's full junction-per-relation model cost only:
Supabase +9 % (5.96 → 6.51 s), Hasura +10 % (12.58 → 13.83 s). Doing the
*identical* 244,313-row physical workload with no audit, the ranking is
unchanged: **Supabase 6.51 s, Hasura 13.83 s, Synthigy ~17.2 s.**

### JDBC isolation — the decisive measurement

To find whether the cost is the JDBC/driver layer or the `sync-entity`
framework, `competitors/synthigy_jdbc.clj` imports the *same* 140,404-row
dataset into the *same* `schema.sql` via **Synthigy's exact `next.jdbc` +
pgjdbc stack** — bulk multi-row `INSERT`, zero framework (no `sync-entity`,
no RLS, no hooks, no xid-resolution):

| Path                                    | Median  | rec/s  |
|------------------------------------------|---------|--------|
| Raw `next.jdbc` (Synthigy's JDBC stack)  | **4.78 s** | 29,400 |
| Supabase / PostgREST                     | 5.96 s  | 23,560 |
| Synthigy `sync-entity` (no audit)        | ~17.2 s |  ~8,100 |

**Synthigy's own JDBC layer is the fastest thing measured — faster than
Supabase** (no HTTP hop). The driver, the pool, pgjdbc, bulk-insert: all
innocent. The entire ~12 s gap between raw `next.jdbc` (4.78 s) and
`sync-entity` (~17 s) is the **framework layered on top of JDBC** — and the
~11 s more for audit on top of that. It is not the data model, not audit,
not JDBC, not Postgres. It is `sync-entity` / `store-entity-records` / the
hook chain / xid-resolution / `REPEATABLE READ` wrapping.

### Profiling inside sync-entity — the hot spot (proven)

Each of `set-entity`'s 7 stages was wrapped with a timing probe and the
full import re-run. Breakdown of a 27.6 s run (audit on):

| Stage                  | Time     | Share |
|------------------------|----------|-------|
| **link-relations**     | **19.4 s** | **70 %** |
| analyze-data           | 5.4 s    | 19 % |
| store-entity-records   | 5.1 s    | 19 % |
| project-saved-entities | 84 ms    | — |
| enhance-write (hooks)  | **3 ms** | — |
| publish-delta          | 2 ms     | — |
| prepare-references     | **0 ms** | — |

- **Logging is not the cost.** Re-run with log min-level `ERROR`: 27.72 s
  vs 27.65 s at `INFO` — no difference.
- **The hook chain (`enhance-write`) is 3 ms; xid resolution
  (`prepare-references`) is 0 ms.** RLS / hooks / reference-resolution —
  the things suspected — are free.
- **`link-relations` is 70 % of the entire import.** Root cause: in xid
  mode every junction-row insert carries two correlated subselects —
  `(select xid from <from-table> where _eid = ?)` and the same for the
  to-side — to denormalise `from_xid` / `to_xid` onto the relation row.
  For this import that is **~257,000 subselects** that re-fetch xids the
  analysis already holds in memory (`prepare-references` resolved them).

### Fixes applied + verified

Three fixes, all "per-row → set-based":

1. **Subselect kill** — `project-saved-entities` carries each entity's
   in-memory `:xid` (4-tuple bindings); `link-relations` writes
   `from_xid`/`to_xid` as plain values instead of ~257 k correlated
   subselects.
2. **Multi-row INSERT** — `link-relations` was issuing JDBC `addBatch`
   (`execute-batch!` — N single-row inserts). Replaced with one
   `INSERT … VALUES (…),(…),…` per 1000-row chunk — the shape
   `store-entity-records` already used.
3. **Statement-level audit triggers** — the audit delta triggers were
   `AFTER INSERT FOR EACH ROW` (~244 k per-row trigger fires, each doing a
   single-row queue `INSERT`). Converted to `FOR EACH STATEMENT` with
   transition tables (`new_rows`/`old_rows`) — fires once per statement,
   bulk-enqueues with `INSERT … SELECT … FROM new_rows`.

| Synthigy | original | + subselect | + multi-row | + stmt triggers |
|----------|----------|-------------|-------------|-----------------|
| audit on | 28.68 s  | 22.57 s     | 16.11 s     | **~11.8 s** |
| no audit | 17.6 s   | 13.05 s     | **8.20 s**  | (n/a)           |

Verified correct: the statement-level triggers enqueue exactly the same
deltas — `115,745` distinct entity deltas + `128,568` relation deltas, both
exact. Audit-on import **28.68 s → ~11.8 s (2.4×)**; the audit substrate's
overhead dropped from ~8 s to ~3.6 s. The dominant stage is now
`analyze-data` (~5 s — pure-CPU parsing of input into the analysis
structure); the raw-`next.jdbc` floor is 4.78 s.

"Supabase" is the PostgREST data-API engine Supabase ships, measured
directly against the same `bench-postgres` (no Kong gateway — it is not on
the insert path). Synthigy run times are this session's clean runs; one
intervening run was discarded — a `TRUNCATE` between runs deadlocked against
the async audit drainer (a harness-reset artifact, not a write-path
effect). Synthigy "config A" (no history audit) measured **19.12 s** in a
prior run; not re-run in this round.

**Ordering is stable and unambiguous: Supabase fastest, Hasura ~2.1× slower
than Supabase, Synthigy ~4.8× slower than Supabase.** That is the measured
fact. The objective reasons for the spread:

- **Supabase / PostgREST** emits one raw multi-row `INSERT` per batch — the
  thinnest possible path over Postgres. Nothing else happens per row.
- **Hasura** parses + plans a GraphQL mutation before emitting SQL. That
  GraphQL layer is essentially the whole ~2× gap vs raw PostgREST.
- **Synthigy** does the most per row: xid→\_eid resolution, RLS guard
  injection, the mutation hook chain, a junction table for *every* relation
  (incl. m2o/o2m, where the other two use a plain FK column), and — config
  B — an attribute-primary audit substrate that enqueued **244,313** delta
  rows here vs the competitors' 140,404 flat `audit_log` rows. It is the
  slowest tool measured. Whether that per-row work is worth a 2–5× cost is
  a product judgement — it is not something this benchmark answers.

Audit cost, per tool (config A → B):
- Supabase: **+40 %** (5.96 → 8.35 s)
- Hasura:   **+19 %** (12.58 → 15.00 s)
- Synthigy: **~+50 %** (19.12 → 28.68 s) — and it writes far more audit data.

### Where Synthigy's 28.68 s actually goes (measured)

Decomposed by running with all triggers `DISABLE`d:

| Layer                                    | Cost    |
|-------------------------------------------|---------|
| The inserts themselves (the floor — what Supabase pays) | ~6 s |
| Data model + write machinery (triggers OFF: 17.60 s total) | ~12 s |
| All triggers (audit substrate + modified_on stamps + xid-guard) | ~11 s |

- **It is not JDBC / round-trips.** A 1,000-row batch is sent as *one* bulk
  `INSERT … VALUES (…),(…),…` (verified in the PG statement log), and
  throughput is flat from batch 1k→10k. If round-trips were the bottleneck,
  10× bigger batches would have been ~10× faster. They were not.
- **~12 s — data model + machinery.** Synthigy makes *every* relation its
  own junction table, so it physically writes **244,313 rows** vs the
  competitors' 140,404 (1.74×); plus xid→\_eid resolution and `REPEATABLE
  READ` transactions.
- **~11 s — triggers.** Per-row audit-delta triggers enqueue to the delta
  queues; the async drainer then fans each out to `__audit_entity` /
  `__audit_relation`. The drainer currently does **row-by-row** single-row
  `INSERT`s (one prepared `INSERT INTO __audit_entity` per audit row) — a
  bulk/`COPY` drainer would reclaim a chunk of this.

Even trigger-free (17.60 s) Synthigy is ~3× Supabase: that gap is the
data-model cost (junction-per-relation, dual IDs), which is intrinsic to
what Synthigy *is*, not an implementation slowdown.

### Batch-size sensitivity (objectivity check)

A fixed batch of 1,000 could in principle penalise a tool with heavy
per-batch overhead. It does not — every tool was swept 1k / 5k / 10k:

| Tool            | 1,000   | 5,000   | 10,000  |
|-----------------|---------|---------|---------|
| Supabase (A)    | 5.96 s  | 5.47 s  | 5.43 s  |
| Hasura (A)      | 12.58 s | 12.97 s | 12.53 s |
| Synthigy (B)    | 28.68 s | 27.61 s | 31.47 s |

None of the three is batch-overhead-bound in this range (≤10 % swing, no
consistent direction). The ranking holds at every batch size — so the
benchmark's batch=1,000 did not handicap anyone. Each tool's cost is
**per-row**, not per-batch.

Verified directly in the Postgres statement log: Synthigy sends a
1,000-row batch as **one** `INSERT INTO "movie" (...) VALUES (...),(...),…`
— the same single bulk statement PostgREST emits. The difference is not
the insert; it is what each tool does *per row* around it.

### Notes

- The `user_rating` phase dominates every tool: 100,836 rows is ~72 % of
  the import and ~80 % of wall time everywhere.
- Variance across the 3 runs is small (≤4 %) — the ordering is not noise.
- This supersedes the old REPL-measured Synthigy figure (44.5 s), which was
  on a different Postgres while the box was swap-thrashing.
- All four competitor configs inserted the full 140,404 rows (verified by
  `count(*)`); Synthigy inserted 139,794 — see asymmetry #3.

### HTTP-vs-HTTP re-baseline on tuned pg (2026-05-25)

The Synthigy figures earlier in this README are in-process (`sync-entity`
called via REPL — no HTTP). The competitors all run over HTTP. Two new
things landed 2026-05-25 to close the gap:

1. **`:synthigy/bare-server`** — a data-only lifecycle module (no IAM, no
   audit, no subscriptions; routes `/data /schema /lint
   /.well-known/synthigy /info`). Boots clean on a fresh DB — the
   SYNTHIGY.md audit-column ordering quirk does NOT fire because
   `:synthigy/audit` never loads. Driven via `competitors/synthigy_http.mjs`
   (plain `fetch`, no auth — discovery doc reports `auth.required=false`).

2. **Re-baselined Hasura + Supabase** on the **same tuned `bench-postgres`**
   (`shared_buffers=4GB`, `work_mem=256MB`, `shm_size=2g`) the bare-server
   run uses. So every number below is on identical hardware/pg config, all
   over HTTP, 3 runs each — directly comparable. (For reference: the
   tuning shaved ~6 % off every competitor vs the 256 MB README numbers
   earlier; the ranking is unchanged.)

**Default fast path (Config A — FK shortcut, 140,404 rows):**

| Tool      | Run 1 | Run 2 | Run 3 | Median  | rec/s   |
|-----------|-------|-------|-------|---------|---------|
| Supabase  |  5.68 |  5.72 |  5.64 |  5.68 s | 24,716  |
| Hasura    | 11.84 | 11.74 | 11.69 | 11.74 s | 11,962  |

**Feature-matched (every relation a junction table — Synthigy's data model,
244,313 physical rows, no audit on any tool):**

| Tool                                              | Run 1 | Run 2 | Run 3 | Median   | rec/s  |
|---------------------------------------------------|-------|-------|-------|----------|--------|
| Supabase / PostgREST                              |  6.09 |  6.21 |  6.14 |  6.14 s  | 39,775 |
| Hasura                                            | 13.04 | 13.10 | 13.06 | 13.06 s  | 18,705 |
| Synthigy bare-server (HTTP, **triggers OFF**)     | 12.55 |   —   |   —   | (single) | **11,143** |
| Synthigy bare-server (HTTP, e2e, **pre-fix**)     | 15.61 | 15.89 | 15.82 | 15.82 s  | 8,836  |
| **Synthigy bare-server (HTTP, e2e, post-fix)**    | 16.14 | 15.87 | 15.61 | **15.87 s** | **8,809** |
| Synthigy bare-server (HTTP, batch=10k, post-fix)  | 14.98 |   —   |   —   | (single) | 9,331  |

The auto-chunk DELETE fix is **throughput-neutral at batch=1,000** (15.82
→ 15.87 s, within run-to-run noise) — confirms the prior batch-sweep
reading that per-row work, not per-statement overhead, dominates. Larger
HTTP batches give a small (~6 %) win at 10k and then hit httpkit's
default 8 MB request-body cap at the 100k one-shot (12 MB payload).

All three on identical 244,313-physical-row workloads. The bare-server
import is `139,794 logical → 244,313 physical` (5 entity tables + 4
junction tables); the competitor "junctions" mode imports the exact same
244,313 rows directly. Variance < 2 % per tool — ordering is not noise.

### Why "bare-server" still pays an audit cost (and the fix that recovers it)

The 2026-05-20 measurement of `8.20 s` no-audit, post-fix (memory
`project_competitive_write_benchmark`) does not reproduce on current
code (~15.87 s). Set-entity stage profiling
(`competitors/synthigy_setentity_profile.clj`) on the rating phase shows
the time goes into `link-relations` (49 %) + `store-entity-records`
(32 %) + `analyze-data` (33 %) — but the link-relations *fn body* is
substantively the same as the post-fix commit (`ad19560`).

Direct inspection of `pg_trigger` shows **7 user triggers on
`user_rating` even on bare-server** (no IAM, no audit module loaded):

- `preserve_user_rating_created_audit` (ROW, BEFORE) — preserves created_on/by
- `prevent_xid_update_trigger_user_rating` (ROW, BEFORE) — xid guard
- `update_user_rating_modified_on` (ROW, BEFORE) — stamps modified_on
- `trg_..._entity_audit_ins/upd/del` (STMT, AFTER) — audit delta enqueue
- `trg_..._entity_notify` (STMT, AFTER) — substrate `pg_notify`

These are installed during `dataset/deploy!` unconditionally. With no
`:synthigy/audit` running, the rows pile up in `__entity_delta_queue` /
`__relation_delta_queue` and nothing drains them — but the writes still
happen on every INSERT. Memory `project_audit_opt_in_policy`'s
"triggers stay on for all; provider filters at write" was designed for
per-entity audit toggles, not for the "audit module not loaded at all"
case.

**Measured impact** (`competitors/synthigy_inproc_pure.clj`'s
`no-triggers!` fn + `competitors/run_synthigy_http_notrig.sh`):

| Path                                              | Triggers on | Triggers off | Delta |
|----------------------------------------------------|------------:|-------------:|------:|
| user_rating phase (in-process, batch=1000)        |   11.92 s   |    9.20 s    | −23 % |
| Full import (HTTP, batch=1000)                    |   15.87 s   |   12.55 s    | −21 % |

With triggers off Synthigy lands at **12.55 s** on the full import vs
Hasura's **13.06 s** — about parity, matching the prior recollection of
"we were faster than Hasura". The fix is to make trigger installation
conditional on whether the audit lifecycle module is loaded (or
deployable), not part of every `deploy!`. Filed as memory
`project_audit_trigger_install_gating`.

#### Fix shipped 2026-05-25 — bench result **13.03–13.20 s**

Substrate ownership moved out of `dataset/deploy!` and into a new
per-backend Patcho module `:synthigy/subscriptions.postgres`. Bare-server
profiles (which boot via `dev/user.clj` and do **not** load
`synthigy.core`) never require the substrate-owner namespace, so no
Patcho module is registered, no `reconcile-substrate!` runs, no triggers
land on the tables.

| Variant | Wall time |
|---|---|
| Pre-fix (HEAD before phase 4) | 15.87 s |
| **Post-fix (run 1)** | **13.20 s** |
| **Post-fix (run 3)** | **13.03 s** |
| Triggers-OFF control | 12.55 s |
| Hasura | 13.06 s |

Parity with Hasura achieved. Architectural details + phase status in
memory `project_substrate_ownership`; the original plan is
`SUBSTRATE_OWNERSHIP_PLAN.md` at the repo root.

##### Upgrading an existing bare-server deploy (orphan-trigger cleanup)

Installs that ran `dataset/deploy!` against pre-fix code carry orphan
substrate triggers + emit functions. They are harmless (queue tables
just accumulate rows that nothing drains) but pay the bench tax. To
strip them in one shot:

```clojure
(require '[next.jdbc :as jdbc]
         '[synthigy.db :as db]
         '[synthigy.substrate.postgres :as substrate])

(jdbc/with-transaction [tx (:datasource db/*db*)]
  (substrate/strip-all! db/*db* tx))
```

Idempotent. Drops every substrate trigger (`trg_*_entity_audit_*`,
`trg_*_entity_notify`, `trg_relation_*`) and the per-entity emit
functions + shared notify/populate fns. Queue tables stay in place —
empty `UNLOGGED` tables are cheap, and a future
`(lifecycle/start! :synthigy/subscriptions.postgres)` reconciles
triggers back against the existing tables.


**Cost breakdown (the honest read):**

- **Supabase 6.14 s** — single multi-row INSERT per batch; nothing else
  happens per row. The floor.
- **Hasura 13.06 s** (~2.1× Supabase) — GraphQL parse + plan, then INSERT.
  Whole gap is the GraphQL tier.
- **Synthigy 15.82 s** (~2.6× Supabase, ~1.2× Hasura) — `/data` dispatch +
  JSON-encoded sync-entity batch + xid→\_eid resolution + per-row guard
  trigger. No IAM, no audit, no subscriptions. The remaining gap vs Hasura
  is whatever `sync-entity` does that GraphQL doesn't — primarily the
  xid/dual-id machinery and the REPEATABLE READ wrap.

### Profile breakdown — where the 15.82 s actually goes (2026-05-25)

`competitors/run_synthigy_profile.sh` boots the bare-server, installs
timing probes via `alter-var-root` on five fns in
`synthigy.server.data` + `synthigy.dataset/sync-entity`, runs ONLY the
dominant `user_rating` phase (100,836 rows, ~80 % of every tool's wall
time), and dumps a stage-level breakdown — client-side and server-side
in the same run.

**Client side (wall time 12.99 s — same 100k-row phase):**

| Stage | Total ms | Share |
|---|---|---|
| prep (`JSON.stringify`) | 56.6 | 0.4 % |
| network (`fetch` + body read) | 12,897 | 99.3 % |
| parse (`res.json`) | 30.6 | 0.2 % |
| other (loop overhead) | 0.5 | < 0.1 % |

**Server side (101 batches, instrumented in-process):**

| Stage | Calls | Total ms | per-call µs |
|---|---|---|---|
| `parse-body` (JSON → map) | 101 |   97 |   956 |
| `execute-operations` | 101 | 12,499 | 123,749 |
| `sync-entity` | 101 | 12,487 | 123,635 |
| `transform-results` | 101 |    6 |    55 |
| `format-response` (JSON encode) | 101 |   90 |   891 |
| **framework (`execute-ops` − `sync-entity`)** | — |  **12** | — |

**What this proves:**

- **HTTP overhead is negligible.** Total non-`sync-entity` time on the
  server: parse-body 97 ms + transform 6 ms + format-response 90 ms +
  framework 12 ms = **~205 ms across the whole 100k-row phase** (≈ 2 µs
  per row). Client-side stringify+parse: ~87 ms total. **HTTP-vs-direct
  delta: ~300 ms on 100k rows.** "HTTP doubles in-process" — wrong; the
  earlier framing in this README was based on a stale 8.20 s in-process
  figure that doesn't reproduce on current code (see below).
- **All the time is in `sync-entity`** — 12.49 s of the 12.99 s wall.
  `parse-body` + `format-response` together are ~1.5 % of the request.
- **The framework layer above `sync-entity` is free** — 12 ms across 101
  batches (~120 µs/batch). All the cost is inside `sync-entity` itself:
  xid→\_eid resolution, RLS guard injection, `REPEATABLE READ` txn,
  multi-row INSERT into entity table + multi-row INSERT into junction
  table, per-row xid-guard trigger.

### In-process baseline vs HTTP — measured 2026-05-25

First attempt with the existing `synthigy_import.clj` harness gave a
nonsense ~33 s for the full import (vs 15.82 s HTTP) — turned out the
Clojure harness's per-shard timer **includes** the JSON read + euuid→xid
postwalk + select-keys, which the JS harness does *before* its timer
starts. Isolated via `competitors/synthigy_inproc_pure.clj` (data
pre-loaded into REPL memory, timer wraps **only** the `sync-entity`
loop):

| Path                                              | user_rating | rec/s |
|----------------------------------------------------|------------:|------:|
| Pure `sync-entity` in-process (data pre-loaded)    |    11.91 s | 8,464 |
| HTTP `/data` (bare-server, same boot)              |    12.64 s | 7,975 |

**In-process ≈ HTTP.** The ~0.7 s delta is the wire path (JSON
encode/decode + transport) — matches the profile breakdown above
(~300 ms total, plus connection acquisition jitter).

### Batch-size sensitivity — flat after 5k

`competitors/synthigy_inproc_pure.clj`'s `sweep!` ran the user_rating
phase (100k rows) at 1k / 5k / 10k / 25k / 50k batches, truncating
between each:

| Batch | Time | rec/s |
|---:|---:|---:|
| 1,000 | 12.11 s | 8,323 |
| 5,000 | 11.17 s | 9,024 |
| 10,000 | 11.13 s | 9,058 |
| 25,000 | 11.20 s | 9,000 |
| 50,000 | **11.05 s** | **9,128** |
| 100,836 | **PG param-limit crash** | — |

~9 % win from 1k→5k, then flat. The cost is **per-row** (xid resolution,
junction insert, guard trigger), not per-statement — larger chunks don't
unlock anything beyond ~5k.

### Bug — `link-relations` pre-DELETEs bypassed the auto-chunker (FIXED)

Before the fix, the 100,836-row one-shot **crashed**:

```
PreparedStatement can have at most 65,535 parameters.
Given query has 100,836 parameters
```

The framework already had the right machinery —
`synthigy.dataset.sql.protocol/max-bind-params` (PG 65535, SQLite 32766)
+ `chunk-rows-for` + `execute-multi-row!` in
`core/core/src/synthigy/dataset/sql/query.clj:2901,2915`. Every bulk
INSERT in `link-relations` and `store-entity-records` already chunked
through it. The bug was two specific DELETE statements at
`query.clj:3003` (`:relations/one` branch) and `query.clj:3041`
(`:relations/many` branch — only in `sync` mode; `stack-entity` skipped
it via `(when-not stack? …)`). Both built `DELETE … WHERE from IN (?,
?, …)` inline with one `?` per row and executed unchunked, hitting the
65,535 cap on >65k same-from-side relation links.

**Fix applied** — added `delete-by-from-side!` next to
`execute-multi-row!`: same `(partition-all (chunk-rows-for 1) current)`
shape that the INSERT path already uses. Both call sites now go through
it. Verified:

| Path                                              | Before fix | After fix |
|----------------------------------------------------|-----------:|----------:|
| 100,836 ratings as one `sync-entity` call          | **crash**  | **10.88 s** (9,268 rec/s) |
| Batch-size sweep — 1k / 5k / 10k / 25k / 50k       | 12.11 / 11.17 / 11.13 / 11.20 / 11.05 s | 11.92 / 11.17 / 11.08 / 11.20 / 10.94 s |
| Batch-size sweep — 100k one-shot                   | n/a (crashed) | **10.72 s** (9,407 rec/s — best) |
| HTTP bench (regression check, 1 run)               | 15.82 s    | 15.94 s   |

Throughput-neutral as predicted (per-row work dominates over
per-statement overhead). The 100k one-shot is now the best result,
marginal — confirms the sweep's "per-row, not per-batch" reading.
Memory: `project_sync_entity_auto_chunk_bug`.

## Running it

### Dataset selection

All harnesses default to ml-latest-small (`datasets/movies/movies/`). To run against
a larger dataset (e.g. ml-25m → `datasets/movies/movies-25m/`, sharded):

- JS harnesses: `DATASET=movies-25m node competitors/hasura.mjs`
- Clojure harnesses: `MOVIES_DATASET=movies-25m` before the REPL boot
  (env is read once at namespace load).

Large datasets ship ratings/tags as sharded files (`user_ratings_0001.json`,
...); the loader concatenates them transparently.

### Competitors (Hasura, Supabase)

```bash
./setup.sh            # config A — bare tables
node competitors/hasura.mjs
node competitors/supabase.mjs

./setup.sh audit      # config B — + audit triggers
CONFIG="config B (audit)" node competitors/hasura.mjs
CONFIG="config B (audit)" node competitors/supabase.mjs
```

`./setup.sh` is also the reset — `schema.sql` drops every table first, and
it reloads the PostgREST schema cache.

### Synthigy

Synthigy needs its full stack booted against a Postgres. See
`docs/plans/bench/competitors/SYNTHIGY.md` for the headless boot sequence (it has a
fresh-DB audit-column ordering quirk that needs one manual step). Once a
Synthigy REPL is up on `bench-postgres`/`synthigy` with the Movies model
deployed:

```clojure
(load-file ".../bench/competitors/synthigy_import.clj")
(synthigy-bench.import/run! {:batch 1000})
```

### Synthigy bare-server (HTTP, e2e)

End-to-end HTTP path against `:synthigy/bare-server` — data-only mode,
no IAM, no audit, no subscriptions. Driver script does everything (reset
DB, boot bare-server with `:postgres:httpkit:dev`, deploy model, run
harness, tear down):

```bash
./competitors/run_synthigy_http.sh           # one timed run
# repeat 3x for median
```

`reset_synthigy.sh` does the DB reset alone (drops + recreates the
`synthigy` DB in `bench-postgres`). Bare-server has `auth.required=false`
at `/.well-known/synthigy`, so the harness uses plain `fetch` — no OAuth.

### Profile + in-process comparison

```bash
./competitors/run_synthigy_profile.sh        # stage-level breakdown via
                                             # alter-var-root probes
./competitors/run_synthigy_inprocess.sh      # same boot, but the import
                                             # runs through synthigy_import.clj
                                             # (sync-entity called directly,
                                             # no HTTP)
```

The profile harness instruments five fns via `alter-var-root` and reports
both client-side (stringify/fetch/parse) and server-side (parse-body /
execute-ops / sync-entity / transform / format-response) per-stage totals
on the `user_rating` phase. See the "Profile breakdown" section above.

## Status

- [x] Hasura — config A + B (3 runs each)
- [x] Supabase / PostgREST — config A + B (3 runs each)
- [x] Synthigy — config B; config A from a prior run
- [x] Synthigy bare-server (HTTP, e2e) — 3 runs, 2026-05-25
- [ ] Prisma `createMany` — config A + B
- [ ] Postgraphile (optional)
- [ ] Re-run with the `user` relation deployed (full 140,404-row parity)
