// A simulated crowd: for a few seconds the BFF rates movies as fast as a busy
// launch day would — a handful of ratings every few hundred milliseconds,
// spread over the first page of the list and, when started from a detail
// page, the movie being looked at.
//
// The point is what it does NOT do: nothing here touches a page. Every number
// that moves while it runs moves because a watch noticed a write — the list
// rows, the detail card, the dashboard tiles. It exists for the visitor who
// is alone (a sandbox has no colleague to open a second tab).
//
// Single-flight like the guide's jobs, but kept apart from lib/demo-jobs.ts on
// purpose: those drive the guide's phase, and a crowd is not a phase.
import { Movie, UserRating } from "../generated/ops.ts"

export type CrowdState = { running: boolean; written: number; left: number; error: string | null }

const DURATION_MS = 15_000
const TICK_MS = 400
const PER_TICK = 3
const MOVIES_SINCE = 1995   // the list page's own floor, so the visible rows are the ones rated
// Skewed towards the ratings people actually give.
const VALUES = [2.5, 3, 3, 3.5, 3.5, 4, 4, 4, 4.5, 4.5, 5, 5]

let state: CrowdState = { running: false, written: 0, left: 0, error: null }
let endsAt = 0
const listeners = new Set<(s: CrowdState) => void>()

function emit() {
  state = { ...state, left: state.running ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : 0 }
  for (const cb of listeners) {
    try { cb(state) } catch (e: any) { console.error("[crowd] listener error:", e?.message) }
  }
}

export function crowdState(): CrowdState {
  return { ...state, left: state.running ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : 0 }
}

export function onCrowd(cb: (s: CrowdState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const pickOne = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

// Returns at once; the crowd runs detached from the request that started it.
// A second start while one is running joins it.
export async function startCrowd(focusXid?: string | null): Promise<CrowdState> {
  if (state.running) return crowdState()
  const pool = (await Movie.list({ since: MOVIES_SINCE, q: "%", limit: 20, offset: 0 })).map((m) => m.xid)
  if (focusXid && !pool.includes(focusXid)) pool.push(focusXid)
  if (!pool.length) throw new Error("no movies to rate")

  state = { running: true, written: 0, left: 0, error: null }
  endsAt = Date.now() + DURATION_MS
  emit()

  ;(async () => {
    try {
      while (Date.now() < endsAt) {
        const batch = Array.from({ length: PER_TICK }, () => ({
          value: pickOne(VALUES),
          // Half the crowd piles onto the movie being looked at, so the page
          // the visitor is on visibly moves.
          movie: { xid: focusXid && Math.random() < 0.5 ? focusXid : pickOne(pool) },
        }))
        await UserRating.stack(batch)
        state = { ...state, written: state.written + batch.length }
        emit()
        await new Promise((r) => setTimeout(r, TICK_MS))
      }
    } catch (e: any) {
      console.error("[crowd] stopped:", e?.message)
      state = { ...state, error: e?.message ?? String(e) }
    } finally {
      state = { ...state, running: false }
      emit()
    }
  })()

  return crowdState()
}
