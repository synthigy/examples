// Single-flight registry for the guide's deploy/import/destroy actions.
// A job runs detached from the HTTP request that started it — the POST
// handler only observes it, so a page reload or a second tab never starts a
// second import, and the guide's own SSE (serve.ts /stream/guide) can report
// progress to every open tab regardless of which one clicked the button.
import type { SeedProgress } from "./seed.ts"

export type JobKind = "deploy" | "import" | "destroy"
export type JobEventType = "start" | "progress" | "done" | "error"

export type Job = {
  kind: JobKind
  startedAt: number
  progress: SeedProgress | null
  error: string | null
  done: Promise<void>
  abort: AbortController
}

let current: Job | null = null
const listeners = new Set<(ev: { job: Job; type: JobEventType }) => void>()

function emit(job: Job, type: JobEventType) {
  for (const cb of listeners) {
    try { cb({ job, type }) } catch (e: any) { console.error("[demo-jobs] listener error:", e?.message) }
  }
}

export function currentJob(): Job | null {
  return current
}

export function onJobEvent(cb: (ev: { job: Job; type: JobEventType }) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Starts `run` unless a job is already active. Returns `started: false` (and
// the ALREADY-running job) when busy — callers should treat that as "join
// the existing job", never as an error.
export function startJob(
  kind: JobKind,
  run: (job: Job, onProgress: (p: SeedProgress) => void) => Promise<void>,
): { job: Job; started: boolean } {
  if (current) return { job: current, started: false }

  const abort = new AbortController()
  const job: Job = { kind, startedAt: Date.now(), progress: null, error: null, abort, done: null as any }
  const onProgress = (p: SeedProgress) => { job.progress = p; emit(job, "progress") }

  // Clear `current` BEFORE emitting — a listener reacting to "done"/"error"
  // synchronously (as /stream/guide's celebration check does, to force a
  // fresh demoState() probe) must see currentJob() already cleared, or the
  // probe's result gets overridden back to the in-flight phase by the very
  // job that just finished (proven live: a `.finally()` run after `.then()`
  // left `current` set for one more microtask, so the "done" listener's own
  // demoState(true) read back "importing" moments after import completed).
  job.done = run(job, onProgress).then(
    () => { if (current === job) current = null; emit(job, "done") },
    (e: any) => { job.error = e?.message ?? String(e); if (current === job) current = null; emit(job, "error") },
  )

  current = job
  emit(job, "start")
  return { job, started: true }
}
