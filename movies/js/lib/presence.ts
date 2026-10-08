// Counts open SSE tabs per page kind and reflects the total in the topbar
// pill (#presence, server-rendered in layout.ts) — the visible proof, during
// the real-time tour, that "another tab" and "an incognito window" are
// actually two separate connections. Also bounces every open page to `/`
// the moment a destroy job starts, so no tab is left showing a dataset that
// no longer exists.
import type { ServerResponse, IncomingMessage } from "node:http"
import { patchElements } from "./bff.ts"
import { onJobEvent } from "./demo-jobs.ts"

export type PresenceKind = "guide" | "movies" | "detail" | "dashboard"

const counts: Record<PresenceKind, number> = { guide: 0, movies: 0, detail: 0, dashboard: 0 }
const responses = new Set<ServerResponse>()

function renderPill(): string {
  const total = counts.guide + counts.movies + counts.detail + counts.dashboard
  return `<span id="presence" class="presence-pill" data-tour="presence"`
    + ` data-p-guide="${counts.guide}" data-p-movies="${counts.movies}"`
    + ` data-p-detail="${counts.detail}" data-p-dashboard="${counts.dashboard}">`
    + `<span class="ribbon-dot"></span> ${total} `
    + `<span class="max-[560px]:hidden">tab${total === 1 ? "" : "s"} </span>live</span>`
}

function broadcastPill() {
  const html = renderPill()
  for (const res of responses) {
    try { patchElements(res, { selector: "#presence", html, mode: "outer" }) } catch { /* dead stream */ }
  }
}

function broadcastReload() {
  for (const res of responses) {
    try { patchElements(res, { selector: "body", mode: "append", html: `<div data-init="location='/'"></div>` }) } catch { /* dead stream */ }
  }
}

onJobEvent(({ type, job }) => {
  if (type === "start" && job.kind === "destroy") broadcastReload()
})

export function snapshot(): Record<PresenceKind, number> {
  return { ...counts }
}

// Call right after sseHeaders() in every page's stream handler.
//
// Release is idempotent and hangs off FOUR events on purpose: `req` "close"
// alone leaks. A stream the SERVER ends (pipeWatch's `finally` calls
// res.end() when a watch drains, and several routes return early) may never
// see a request-side close, and a browser killed mid-connection can leave
// its socket half-open for a while. A leaked count is not cosmetic here —
// the tour's "open another tab" steps advance off these numbers, so a stale
// +1 makes them fire before the visitor has done anything.
export function bindDemoBus(req: IncomingMessage, res: ServerResponse, kind: PresenceKind) {
  counts[kind]++
  responses.add(res)
  broadcastPill()

  let released = false
  const release = () => {
    if (released) return
    released = true
    counts[kind] = Math.max(0, counts[kind] - 1)
    responses.delete(res)
    broadcastPill()
  }
  req.on("close", release)
  req.on("aborted", release)
  res.on("close", release)
  res.on("finish", release)
}
