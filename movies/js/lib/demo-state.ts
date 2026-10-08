// The guide's phase machine. Derived fresh from the server on every
// uncached request — nothing here survives a BFF restart except the export
// file (committed) and whatever the server itself holds, which is exactly
// what makes a restart mid-import safe (see README "Guided demo").
import { client, Demo } from "../generated/ops.ts"
import { currentJob } from "./demo-jobs.ts"
import { exportDatasetXid, readExport, seedCounts, loadSeedPhases, type DemoCounts } from "./seed.ts"

export type DemoPhase = "absent" | "deploying" | "deployed" | "importing" | "ready" | "destroying"

export type DemoState = {
  phase: DemoPhase
  dataset: { xid: string; name: string | null; version: string | null } | null
  counts: DemoCounts | null
  expected: DemoCounts
  partial: boolean
  checkedAt: number
}

let datasetXid: string | null = null
let expected: DemoCounts | null = null

// Computed once at boot — cheap (no ratings held in memory afterward).
export async function initExpectedCounts(): Promise<DemoCounts> {
  if (expected) return expected
  const phases = await loadSeedPhases()
  expected = seedCounts(phases)
  return expected
}

async function getDatasetXid(): Promise<string> {
  if (datasetXid) return datasetXid
  datasetXid = exportDatasetXid(await readExport())
  return datasetXid
}

const TTL_MS = 2000
let cached: DemoState | null = null

export function invalidateDemoState() {
  cached = null
}

// Sync snapshot for layout() — never triggers a probe, so it's safe to call
// on every page render. "unknown" until the first demoState() call resolves.
let lastPhase: DemoPhase | "unknown" = "unknown"
export function peekPhase(): DemoPhase | "unknown" {
  return lastPhase
}

function zero(): DemoCounts {
  return { genres: 0, actors: 0, movies: 0, ratings: 0, tags: 0 }
}

async function probe(): Promise<DemoState> {
  const exp = await initExpectedCounts()
  const xid = await getDatasetXid()

  let dataset: DemoState["dataset"] = null
  try {
    // `_order_by` as an array-of-tuples (what the SDK's own Args type
    // declares) INTERNAL_ERRORs on a relation's args here — proven live,
    // bisected against `_where`/`_limit` alone (both fine on their own).
    // The plain-object form `{ field: "desc" }` is what actually works.
    const row = await client().get("Dataset", { xid }, {
      xid: null, name: null,
      versions: {
        args: { _where: { deployed: { _eq: true } }, _order_by: { deployed_on: "desc" }, _limit: 1 },
        selections: { xid: null, name: null, deployed: null },
      },
    } as any) as any
    const deployedVersion = row?.versions?.[0]
    if (row && deployedVersion) {
      dataset = { xid: row.xid, name: row.name, version: deployedVersion.name ?? null }
    }
  } catch (e: any) {
    console.warn("[demo-state] Dataset probe failed:", e?.message)
  }

  if (!dataset) {
    return { phase: "absent", dataset: null, counts: null, expected: exp, partial: false, checkedAt: Date.now() }
  }

  let counts: DemoCounts | null = null
  try {
    const rows = await Demo.progress()
    counts = rows?.[0] ?? null
  } catch (e: any) {
    console.warn("[demo-state] Demo.progress() failed:", e?.message)
  }

  const c = counts ?? zero()
  const ready = c.tags >= exp.tags && exp.tags > 0
  const partial = !ready && (c.genres > 0 || c.actors > 0 || c.movies > 0 || c.ratings > 0 || c.tags > 0)

  return {
    phase: ready ? "ready" : "deployed",
    dataset, counts, expected: exp, partial,
    checkedAt: Date.now(),
  }
}

export async function demoState(fresh = false): Promise<DemoState> {
  const job = currentJob()

  if (!fresh && cached && Date.now() - cached.checkedAt < TTL_MS && !job) {
    lastPhase = cached.phase
    return cached
  }

  const state = await probe()

  // An active job overrides the probe's phase — the probe can't see
  // "importing" mid-chunk (the tables already have SOME rows), only the job
  // registry knows a write is in flight right now.
  if (job) {
    const jobPhase: DemoPhase = job.kind === "deploy" ? "deploying" : job.kind === "import" ? "importing" : "destroying"
    const withJob: DemoState = { ...state, phase: jobPhase }
    lastPhase = withJob.phase
    return withJob
  }

  cached = state
  lastPhase = state.phase
  return state
}
