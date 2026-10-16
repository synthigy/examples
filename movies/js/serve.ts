/**
 * datastar-movies — Synthigy SDK live-data showcase.
 *
 *   Browser (Datastar, no JS framework)
 *      ↕ HTML + SSE patches
 *   Node BFF (this file)
 *      ↕ @synthigy/sdk (watch / watchQuery / watchSqlTemplate)
 *   Synthigy server (/data, /oauth, /data/events)
 *
 * One SDK client per process → ONE SSE BFF→Synthigy regardless of how
 * many browser sessions are open. Each browser page opens ONE SSE
 * browser→BFF; the BFF translates SDK watch events into Datastar
 * element patches and pushes them down.
 *
 * Tokens NEVER touch the browser. OIDC code+PKCE flow; session is a
 * cookie-keyed in-memory record.
 *
 * Run from this directory:
 *   SYNTHIGY_CLIENT_ID=movies-js \
 *   SYNTHIGY_CLIENT_SECRET=… \
 *   node serve.ts
 *
 * Required env:
 *   SYNTHIGY_CLIENT_ID       OAuth client (authorization_code grant)
 *   SYNTHIGY_CLIENT_SECRET   ditto
 * Optional:
 *   SYNTHIGY_ENDPOINT        default http://localhost:7887
 *   SYNTHIGY_PUBLIC_ENDPOINT default SYNTHIGY_ENDPOINT — what the BROWSER is
 *                            told to call (the console and modeler talk to
 *                            the engine directly); differs only behind a
 *                            proxy fronting both on one hostname
 *   PORT                     default 5174
 *   BASE_URL                 default http://localhost:5174  (used for redirect_uri)
 *
 * See README.md for setup (deploy Movies dataset, register OAuth client).
 */

// Demo BFF: don't let a stray rejection from an aborted watch / SSE
// teardown crash the server. Real prod code should fix the source.
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message ?? String(reason)
  const isBenignAbort = reason?.name === "AbortError"
    || /aborted/i.test(msg)
  if (isBenignAbort) {
    console.warn("[unhandledRejection] swallowed AbortError:", msg)
    return
  }
  console.error("[unhandledRejection]", reason)
})

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { basename, extname, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configure, client, Movie, UserRating, MovieActor, MovieGenre, Dashboard, Demo } from "./generated/ops.ts"
import type { MovieList, MovieActorList, MovieGenreList, MovieDetail } from "./generated/ops.ts"

import { MemoryLoginStore } from "@synthigy/sdk"
import {
  getSession, createSession, logout,
  applyLogin, applyLogout, dropSession,
} from "./lib/auth.ts"
import {
  sseHeaders, patchElements, patchSignals, removeElement, pipeWatch, holdOpen, esc,
} from "./lib/bff.ts"
import { EXPORT_PATH, deployModel, destroyDataset, exportDatasetXid, readExport, runSeed, loadSeedPhases } from "./lib/seed.ts"
import { demoState, invalidateDemoState, initExpectedCounts, type DemoPhase } from "./lib/demo-state.ts"
import { startJob, onJobEvent } from "./lib/demo-jobs.ts"
import { bindDemoBus, broadcast } from "./lib/presence.ts"
import { startCrowd, onCrowd } from "./lib/crowd.ts"
import { movieFields, extraFields, extraValues, coerce, onMovieModelChange, watchMovieModel } from "./lib/movie-model.ts"
import { movieHistory, movieStateBefore } from "./lib/movie-history.ts"

// Append one line to the in-page event console (#debug-log on /movies).
// Each line is class-tagged so the CSS can color-code by event kind
// (link=green, unlink=red, changed=amber, sentinels=gray, warn=red).
function debugLine(res: ServerResponse, type: string, detail = "", warn = false) {
  const ts = new Date().toISOString().slice(11, 23)
  const kind = warn ? "warn" : classifyEvent(type)
  const html = `<span class="ev-row ev-${kind}">`
    + `<span class="ev-time">${ts}</span>`
    + `<span class="ev-type">${esc(type)}</span>`
    + `<span class="ev-detail">${esc(detail)}</span>`
    + `</span>`
  patchElements(res, { selector: "#debug-log", html, mode: "append" })
}

function classifyEvent(type: string) {
  if (type.includes("/link") || type.includes("/added") || type.includes("/insert")) return "add"
  if (type.includes("/unlink") || type.includes("/removed") || type.includes("/delete")) return "remove"
  if (type.includes("/changed") || type.includes("/update")) return "change"
  // Stream-lifecycle sentinels + snapshot replays.
  if (type === "stream/open" || type === "watch/ready" || type === "snapshot/sync"
      || type.startsWith("sentinel/")) return "info"
  return "info"
}

import { landingPage } from "./views/landing.ts"
import { guidePage } from "./views/guide.ts"
import { moviesPage, movieRow, searchMeta, moviesPagerInner, actorChip, ACTOR_PICKER_PAGE, movieDetailPage, movieDetailCard, dashboardPage, yearCharts, extrasPanel, historyPanel, type DetailSide } from "./views/movies.ts"
import { actorsPage, actorRow, actorDetailPage, actorDetailCard } from "./views/actors.ts"

// Returns "stale-session" when the SDK error implies the cached
// session.user.xid (or the cached client token) is no longer valid
// server-side — the only recovery is to drop the BFF session and
// force a re-login. Returns null otherwise.
//
// Server emits typed `code` discriminants (wire-triage 2026-05-30) so
// this is a small set membership check, not a regex over message text.
// HTTP_ERROR with details containing one of the auth-class codes is
// also handled — token-exchange failures bubble up as HTTP_ERROR
// wrapping the OAuth server's error code.
const STALE_SESSION_CODES = new Set([
  "USER_NOT_FOUND",       // acting_as user is gone
  "CLIENT_NOT_FOUND",     // OAuth client is gone
  "CLIENT_INACTIVE",      // OAuth client deactivated
  "UNAUTHORIZED",         // token rejected
])
function classifySdkError(e: any) {
  if (STALE_SESSION_CODES.has(e?.code)) return "stale-session"
  // Token-exchange failures surface as HTTP_ERROR; the OAuth server's
  // own error code rides on `e.details`.
  if (e?.code === "HTTP_ERROR"
      && typeof e?.details === "string"
      && /invalid_client|invalid_grant/.test(e.details)) {
    return "stale-session"
  }
  return null
}

// Bounce to /login after dropping the bad session — leaves a banner
// query-string so the login page (or the next /movies render) can
// say *why* the user got kicked out.
function bounceToLogin(req: IncomingMessage, res: ServerResponse, returnTo: string, reason: string) {
  const sid = logout(req)           // also clears file-store entry
  if (sid) dropSession(sid)         // belt-and-suspenders for callers that pass req but expect server-side cleanup
  applyLogout(res, `/login?returnTo=${encodeURIComponent(returnTo)}&reason=${encodeURIComponent(reason)}`)
}

// One-shot message carried on the redirect target; layout() renders it as a
// dismissible banner and strips it from the URL. Parsing against a dummy
// origin also pins the result to a local path.
function withNotice(to: string, notice: string) {
  const u = new URL(to || "/", "http://placeholder/")
  u.searchParams.set("notice", notice)
  return u.pathname + u.search + u.hash
}

const HERE          = dirname(fileURLToPath(import.meta.url))
const ENDPOINT      = process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887"
// Where the BROWSER reaches the engine. Identical to ENDPOINT unless a proxy
// fronts both this BFF and the engine on one hostname (the sandbox), where
// ENDPOINT is in-container and unreachable from outside. Only the OAuth
// authorize redirect and the page's tools config use it — every server-side
// call still goes to ENDPOINT.
const PUBLIC_ENDPOINT = process.env.SYNTHIGY_PUBLIC_ENDPOINT ?? ENDPOINT
const CLIENT_ID     = process.env.SYNTHIGY_CLIENT_ID
const CLIENT_SECRET = process.env.SYNTHIGY_CLIENT_SECRET
const PORT          = Number(process.env.PORT ?? 5174)
const BASE_URL      = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "")
const REDIRECT_URI  = `${BASE_URL}/auth/callback`

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("SYNTHIGY_CLIENT_ID and SYNTHIGY_CLIENT_SECRET are required.")
  console.error("See README.md for how to register an OAuth client.")
  process.exit(1)
}

// ──────────────────────────────────────────────────────────────────────────
// SDK — one client per process. Watches multiplex onto its single SSE.
// ──────────────────────────────────────────────────────────────────────────

configure({
  endpoint:     ENDPOINT,
  clientId:     CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  // Pin the upstream SSE open for the lifetime of the BFF so events
  // aren't lost between browser sessions.
  keepAlive:    true,
  // In-flight logins between /login and the callback. One process here, so a
  // Map is honest; behind a load balancer this must be shared storage or a
  // callback landing on another instance finds no verifier.
  loginStore:   new MemoryLoginStore(),
})

// Parses the seed files once at boot for the guide's hero numbers — cheap
// (no rows held after this), and needed before the first "/" render.
await initExpectedCounts()

// Every read in this demo is anonymous-safe: the guide/list/detail/dashboard
// pages run as the BFF's own SUPERUSER client when nobody is logged in, and
// only pass `actingAs` once a session exists. Only the RATING write (and the
// deploy/import/destroy buttons, deliberately — see README "Guided demo")
// need a real user.
const as = (req: IncomingMessage) => {
  const sess = getSession(req)
  return sess?.user?.xid ? { actingAs: sess.user.xid } : {}
}

// Every open page hears the crowd's progress (the footer button's label) and
// every model deploy (a toast naming what changed on Movie).
onCrowd((s) => broadcast((res) => patchSignals(res, { crowd: s })))

watchMovieModel()
onMovieModelChange(({ added, removed, version }) => {
  const parts = [
    added.length ? `Movie gained ${added.map((n) => `<code>${esc(n)}</code>`).join(", ")}` : "",
    removed.length ? `lost ${removed.map((n) => `<code>${esc(n)}</code>`).join(", ")}` : "",
  ].filter(Boolean)
  const what = parts.length ? ` ${parts.join(" and ")} — no restart, no codegen.` : ""
  const html = `<div class="model-toast" role="status" data-init="setTimeout(() => el.remove(), 9000)">`
    + `<strong>Model ${esc(version ?? "")} deployed.</strong>${what}</div>`
  broadcast((res) => patchElements(res, { selector: "body", mode: "append", html }))
})

// The detail page's two panels outside the typed watchDetail() projection.
// Each fails on its own: a model the schema read can't parse should not take
// the history down with it, and vice versa.
async function detailSide(xid: string): Promise<DetailSide> {
  const [extras, history] = await Promise.all([
    extraFields()
      .then(async (fields) => extrasPanel(xid, fields, await extraValues(xid, fields)))
      .catch((e) => { console.error(`[extras ${xid}]`, e?.message); return "" }),
    movieHistory(xid)
      .then((entries) => historyPanel(xid, entries))
      .catch((e) => historyPanel(xid, [], e?.code === "HISTORY_UNAVAILABLE" ? "no audit store on this instance" : e?.message)),
  ])
  return { extras, history }
}


// ──────────────────────────────────────────────────────────────────────────
// Router — tiny hand-rolled (Node http, no framework dep).
// ──────────────────────────────────────────────────────────────────────────

type Params = Record<string, string>
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => unknown
type Route = { method: string; pattern: string | RegExp; handler: Handler }

const routes: Route[] = []
const route = (method: string, pattern: string | RegExp, handler: Handler) =>
  routes.push({ method, pattern, handler })

function matchRoute(method: string, url: URL): { handler: Handler; params: Params } | null {
  for (const r of routes) {
    if (r.method !== method) continue
    if (typeof r.pattern === "string") {
      if (r.pattern === url.pathname) return { handler: r.handler, params: {} }
    } else {
      const m = url.pathname.match(r.pattern)
      if (m) return { handler: r.handler, params: m.groups ?? {} }
    }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Pages — HTML
// ──────────────────────────────────────────────────────────────────────────

route("GET", "/", async (req, res) => {
  const user = getSession(req)?.user
  const state = await demoState()
  if (state.phase !== "ready") return send(res, 200, "text/html", guidePage({ user, state }))
  send(res, 200, "text/html", landingPage({ user }))
})

// Always the guide, even once ready — step "explore"/"destroy" live here too.
route("GET", "/guide", async (req, res) => {
  const user = getSession(req)?.user
  const state = await demoState()
  send(res, 200, "text/html", guidePage({ user, state }))
})

// Every app page needs the dataset deployed AND fully imported. 302 to the
// guide otherwise — there is no partial-data rendering path for these pages
// (the guide IS that path, with its own progress UI).
async function requireReady(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const state = await demoState()
  if (state.phase === "ready") return true
  res.writeHead(302, { Location: "/" }); res.end()
  return false
}

const MOVIES_SINCE = 1995   // floor matches the live /stream/movies watch
const PER_PAGE = 20
const TOUR_MOVIE = "Donnie Darko"   // the guided tour's fixed first-row target

route("GET", "/movies", async (req, res) => {
  if (!(await requireReady(req, res))) return
  const sess = getSession(req)
  const url    = new URL(req.url ?? "/", BASE_URL)
  // The tour targets the list's first row (data-tour="movie-link") — pin that
  // to a known, well-reviewed title via the same search box a visitor would
  // use, rather than whatever's newest by release_year.
  const tourQ  = url.searchParams.get("tour") === "1" ? TOUR_MOVIE : ""
  const term   = (url.searchParams.get("q") || tourQ).trim()
  const page    = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1)
  const q       = term ? `%${term}%` : "%"          // always passed; "%" = match all
  const offset  = (page - 1) * PER_PAGE

  let initial: MovieList[] = [], actors: MovieActorList[] = [], genres: MovieGenreList[] = [], total = 0, pageError: string | null = null
  try {
    // List rows + a typed filtered count — both XSQL ops. Count is a typed
    // sql-template (Movie.count, @returns total:int); ?q="%" default = match all,
    // so no host-built SQL and no raw client() escape hatch.
    let countRows
    ;[initial, actors, genres, countRows] = await Promise.all([
      Movie.list({ since: MOVIES_SINCE, q, limit: PER_PAGE, offset }, as(req)),
      MovieActor.list({ limit: ACTOR_PICKER_PAGE, offset: 0 }, as(req)),
      MovieGenre.list({ limit: 100 }, as(req)),
      Movie.count({ since: MOVIES_SINCE, q }, as(req)),
    ])
    total = countRows?.[0]?.total ?? 0   // typed number — no coercion
    console.log(`[/movies] page=${page} term="${term}" got ${initial.length}/${total}`)
  } catch (e) {
    console.error(`[/movies] search failed:`, e.message, e.details || "")
    if (sess && classifySdkError(e) === "stale-session") {
      return bounceToLogin(req, res, "/movies", "session-expired")
    }
    pageError = `${e.message}${e.details ? " — " + e.details : ""}`
  }
  send(res, 200, "text/html", moviesPage({
    user: sess?.user, initial, actors, genres, error: pageError,
    term, page, total, perPage: PER_PAGE,
  }))
})

// Debounced live search — patches ONLY the list fragments (no full reload).
// The ty-input fires a 400ms-debounced CustomEvent; Datastar @get's here and
// we answer with patch-elements for #movies / #movies-meta / #movies-pager.
// We also re-point the live stream (replacing #movie-stream aborts the old SSE
// via its req.on("close")) and sync the URL so reload/back/tab-switch match.
route("GET", "/movies-search", async (req, res) => {
  if (!(await requireReady(req, res))) return
  const url  = new URL(req.url ?? "/", BASE_URL)
  const term = (url.searchParams.get("q") || "").trim()
  const q    = term ? `%${term}%` : "%"
  sseHeaders(res)
  try {
    const [rows, countRows] = await Promise.all([
      Movie.list({ since: MOVIES_SINCE, q, limit: PER_PAGE, offset: 0 }, as(req)),
      Movie.count({ since: MOVIES_SINCE, q }, as(req)),
    ])
    const total = countRows?.[0]?.total ?? 0
    const pages = Math.max(1, Math.ceil(total / PER_PAGE))
    patchElements(res, { selector: "#movies", mode: "inner",
      html: rows.map((m) => movieRow(m)).join("")
        || `<li class="empty-panel" style="padding:18px 22px">No movies match “${esc(term)}”.</li>` })
    patchElements(res, { selector: "#movies-meta", mode: "inner", html: searchMeta(term, total) })
    patchElements(res, { selector: "#movies-pager", mode: "inner", html: moviesPagerInner(term, 1, pages) })
    const qs = term ? `?q=${encodeURIComponent(term)}` : ""
    patchElements(res, { selector: "#movie-stream", mode: "outer",
      html: `<div id="movie-stream" data-init="@get('/stream/movies${qs}')"></div>` })
    patchElements(res, { selector: "body", mode: "append",
      html: `<div data-init="history.replaceState(null,'','/movies${qs}')"></div>` })
  } catch (e) {
    console.error(`[/movies-search] q="${term}" failed:`, e.message)
  }
  res.end()
})

route("GET", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  if (!(await requireReady(req, res))) return
  const sess = getSession(req)
  // Movie.detail() uses get — sdk.search with { xid } filter doesn't work
  // (server "Character cannot be cast to Map$Entry" on that path).
  // Actor + genre lists ride along to populate the edit modal's pickers.
  let movie = null, actors: MovieActorList[] = [], genres: MovieGenreList[] = [], side: DetailSide = {}
  try {
    ;[movie, actors, genres, side] = await Promise.all([
      Movie.detail({ xid }, as(req)),
      MovieActor.list({ limit: ACTOR_PICKER_PAGE, offset: 0 }, as(req)),
      MovieGenre.list({ limit: 100 }, as(req)),
      detailSide(xid),
    ])
  } catch (e) {
    console.error(`[/movies/${xid}] get failed:`, e.message, e.details || "")
    if (sess && classifySdkError(e) === "stale-session") {
      return bounceToLogin(req, res, `/movies/${xid}`, "session-expired")
    }
    return send(res, 500, "text/html",
      `<h1>Movie fetch failed</h1><pre>${esc(e.message)}\n${esc(e.details || "")}</pre>`)
  }
  if (!movie) return send(res, 404, "text/html", "<h1>Not found</h1>")
  send(res, 200, "text/html", movieDetailPage({ user: sess?.user, movie, actors, genres, side }))
})

route("GET", "/dashboard", async (req, res) => {
  if (!(await requireReady(req, res))) return
  const user = getSession(req)?.user
  send(res, 200, "text/html", dashboardPage({ user }))
})

const ACTORS_PER_PAGE = 40

route("GET", "/actors", async (req, res) => {
  if (!(await requireReady(req, res))) return
  const sess = getSession(req)
  let initial: MovieActorList[] = []
  try {
    initial = await MovieActor.list({ limit: ACTORS_PER_PAGE, offset: 0 }, as(req))
  } catch (e) {
    console.error(`[/actors] list failed:`, e.message)
    if (sess && classifySdkError(e) === "stale-session")
      return bounceToLogin(req, res, "/actors", "session-expired")
  }
  send(res, 200, "text/html", actorsPage({ user: sess?.user, initial, pageSize: ACTORS_PER_PAGE }))
})

route("GET", /^\/actors\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  if (!(await requireReady(req, res))) return
  const sess = getSession(req)
  let actor = null
  try {
    actor = await MovieActor.detail({ xid }, as(req))
  } catch (e) {
    console.error(`[/actors/${xid}] get failed:`, e.message)
    if (sess && classifySdkError(e) === "stale-session")
      return bounceToLogin(req, res, `/actors/${xid}`, "session-expired")
    return send(res, 500, "text/html", `<h1>Actor fetch failed</h1><pre>${esc(e.message)}</pre>`)
  }
  if (!actor) return send(res, 404, "text/html", "<h1>Not found</h1>")
  send(res, 200, "text/html", actorDetailPage({ user: sess?.user, actor }))
})


// ──────────────────────────────────────────────────────────────────────────
// SSE streams — one per page kind. Each opens a watch + pipes events.
// ──────────────────────────────────────────────────────────────────────────

route("GET", "/stream/movies", async (req, res) => {
  const _t0 = Date.now()
  sseHeaders(res)
  bindDemoBus(req, res, "movies")
  console.log(`[stream/movies] OPEN`)
  req.on("close", () => {
    console.log(`[stream/movies] CLOSE after ${Date.now()-_t0}ms`)
  })

  // Track the SAME window the page is showing — the list orders by
  // release_year (immutable under rating), so paged-live only ever fires
  // query/changed (in-place), never cross-page add/remove.
  const surl   = new URL(req.url ?? "/", BASE_URL)
  const term   = (surl.searchParams.get("q") || "").trim()
  const page   = Math.max(1, parseInt(surl.searchParams.get("page") || "1", 10) || 1)
  const q      = term ? `%${term}%` : "%"
  const offset = (page - 1) * PER_PAGE

  const acting = as(req)
  debugLine(res, "stream/open", `watching Movie page ${page}${term ? ` q="${term}"` : ""} as actingAs=${acting.actingAs ?? "(none)"}`)

  const live = Movie.watchList({ since: MOVIES_SINCE, q, limit: PER_PAGE, offset }, acting)
  try {
    await live.ready()
  } catch (e) {
    console.error(`[stream/movies] watch ready failed:`, e.message, e.details || "")
    const kind = classifySdkError(e)
    patchElements(res, {
      selector: "#movies",
      html: `<li id="stream-error" style="background:#3a1212;color:#ffb4b4;border:1px solid #ff4040;padding:14px;border-radius:6px;line-height:1.4;">`
        + `<strong>Live data unavailable.</strong> ${esc(e.message)}`
        + (e.details ? `<br><code style="opacity:.8">${esc(e.details)}</code>` : "")
        + (kind === "stale-session"
            ? `<br><br><a href="/logout" data-on-click="@post('/logout')" style="color:#ffb4b4;text-decoration:underline;">Log out and sign in again</a>`
            : "")
        + `</li>`,
      mode: "inner",
    })
    debugLine(res, "watch/error", `${e.message}${e.details ? " — " + e.details : ""}`, true)
    return res.end()
  }
  debugLine(res, "watch/ready", `${live.list().length} rows in initial set; awaiting events…`)

  // The tour's `[data-tour="movie-link"]` anchor is on the FIRST row: this
  // snapshot replay fully replaces the server-rendered `#movies` moments
  // after page load (the SSE connects immediately), so the marker has to be
  // reapplied here too — otherwise it exists only in the pre-SSE HTML and a
  // real page (unlike curl) never sees it.
  patchElements(res, { selector: "#movies", html: live.list().map((m, i) => movieRow(m, { tour: i === 0 })).join(""), mode: "inner" })
  debugLine(res, "snapshot/sync", `replayed ${live.list().length} rows`)

  await pipeWatch(req, res, live, (ev) => {
    const xid = (ev as any).record?.xid ?? (ev as any).recordXid ?? ""
    console.log(`[stream/movies] EVT ${ev.type} ${xid}`)
    debugLine(res, ev.type, `${xid} actor=${ev.actor ?? "?"} txid=${ev.txid ?? "?"}`)
    if (ev.type === "query/added") {
      patchElements(res, { selector: "#movies", html: movieRow(ev.record as MovieList, { fresh: true }), mode: "append" })
    } else if (ev.type === "query/removed") {
      removeElement(res, `#movie-${ev.recordXid}`)
    } else if (ev.type === "query/changed") {
      patchElements(res, { selector: `#movie-${(ev as any).record.xid}`, html: movieRow((ev as any).record, { fresh: true }), mode: "outer" })
    }
  }, {
    onSentinel: (s) => {
      debugLine(res, `sentinel/${s.type}`, JSON.stringify(s).slice(0, 200), true)
    },
  })
})

route("GET", /^\/stream\/movies\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  sseHeaders(res)
  bindDemoBus(req, res, "detail")

  const live = Movie.watchDetail({ xid }, as(req))
  try {
    await live.ready()
  } catch (e) {
    console.error(`[stream/movies/${xid}] watch ready failed:`, e.message)
    return res.end()
  }
  if (!live.records.size) return res.end()

  // The extras + history panels. watchDetail() only fires when its OWN
  // projection changes — a write to an attribute added in the modeler is
  // invisible to it — so a plain record watch on this movie drives them, and
  // a deploy (a new attribute to show) does too. The audit store lands a
  // moment after the write, hence the second, later read.
  let side: DetailSide = {}
  let alive = true
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const refreshSide = async () => {
    if (!alive) return
    side = await detailSide(xid)
    if (!alive) return
    patchElements(res, { selector: "#movie-extras", html: side.extras ?? "", mode: "inner" })
    patchElements(res, { selector: "#movie-history", html: side.history ?? "", mode: "inner" })
  }
  const scheduleSide = () => {
    for (const ms of [300, 1500]) {
      const t = setTimeout(() => { timers.delete(t); refreshSide().catch(() => {}) }, ms)
      timers.add(t)
    }
  }
  refreshSide().catch(() => {})

  // Workaround, @synthigy/sdk 0.2.2: watchQuery() (under watchDetail) only
  // re-runs on `entity/*` and `relation/*` events, but the engine names an
  // attribute write `record/update` — so a title changed on its own (Restore,
  // the console) never repaints the card; only writes that also re-link
  // actors/genres do. The record watch below sees `record/update`, so it
  // repaints the card itself.
  let cardTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleCard = () => {
    if (cardTimer) return
    cardTimer = setTimeout(async () => {
      cardTimer = null
      if (!alive) return
      try {
        const movie = await Movie.detail({ xid }, as(req))
        if (alive && movie) patchElements(res, { selector: `#movie-${xid}`, html: movieDetailCard(movie, side), mode: "outer" })
      } catch (e) { console.error(`[stream/movies/${xid}] card refresh failed:`, e.message) }
    }, 120)
  }

  // Ratings link to the movie (relation events) — the crowd makes plenty.
  // Only the movie's own attributes changing is a reason to re-read.
  const raw = client().watch({ records: [xid] })
  ;(async () => {
    for await (const ev of raw.events) {
      if (ev.type !== "record/update") continue
      scheduleCard()
      scheduleSide()
    }
  })().catch(() => {})
  const offModel = onMovieModelChange(() => scheduleSide())
  req.on("close", () => {
    alive = false
    raw.close()
    offModel()
    for (const t of timers) clearTimeout(t)
    if (cardTimer) clearTimeout(cardTimer)
  })

  await pipeWatch(req, res, live, (ev) => {
    if (ev.type === "query/changed") {
      patchElements(res, { selector: `#movie-${xid}`, html: movieDetailCard(ev.record as MovieDetail, side), mode: "outer" })
    }
  })
})

route("GET", "/stream/dashboard", async (req, res) => {
  sseHeaders(res)
  bindDemoBus(req, res, "dashboard")

  const live = Dashboard.watchStats(as(req))

  live.ready().then(() => {
    const s = live.first
    if (!s) return
    patchElements(res, { selector: "#counter-movies-val",  html: esc(String(s.total_movies  ?? "…")) })
    patchElements(res, { selector: "#counter-ratings-val", html: esc(String(s.total_ratings ?? "…")) })
    patchElements(res, { selector: "#counter-avg-val",     html: esc(s.avg_rating != null ? `${s.avg_rating.toFixed(2)} ★` : "—") })
    patchElements(res, { selector: "#counter-actors-val",  html: esc(String(s.total_actors  ?? "…")) })
  }).catch(() => {})

  // Second watch on the same SSE response: the per-year series only cares
  // about `movie`, so rating writes never re-render the charts.
  const years = Dashboard.watchByYear(as(req))
  years.ready().then(() => {
    patchElements(res, { selector: "#year-charts", html: yearCharts(years.value ?? []), mode: "outer" })
  }).catch(() => {})

  await Promise.all([
    pipeWatch(req, res, live, (ev) => {
      if (ev.type === "result/changed") {
        const s = (ev as any).after[0]
        if (!s) return
        patchElements(res, { selector: "#counter-movies-val",  html: esc(String(s.total_movies  ?? 0)) })
        patchElements(res, { selector: "#counter-ratings-val", html: esc(String(s.total_ratings ?? 0)) })
        patchElements(res, { selector: "#counter-avg-val",     html: esc(s.avg_rating != null ? `${s.avg_rating.toFixed(2)} ★` : "—") })
        patchElements(res, { selector: "#counter-actors-val",  html: esc(String(s.total_actors  ?? 0)) })
      }
    }, { keepOpen: true }),
    pipeWatch(req, res, years, (ev) => {
      if (ev.type === "result/changed")
        patchElements(res, { selector: "#year-charts", html: yearCharts((ev as any).after ?? []), mode: "outer" })
    }, { keepOpen: true }),
  ])
  res.end()
})

// Infinite-scroll load-more (pure pagination, no watch). Same technique as the
// modal picker: ty-scroll-container fires `nearend`, the handler gates a sync
// flag, we append the next page and re-arm the cursor via patchSignals.
route("GET", "/actors-more", async (req, res) => {
  const url    = new URL(req.url ?? "/", BASE_URL)
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0)
  sseHeaders(res)
  try {
    const batch = await MovieActor.list({ limit: ACTORS_PER_PAGE, offset }, as(req))
    if (batch.length)
      patchElements(res, { selector: "#actors", html: batch.map(actorRow).join(""), mode: "append" })
    patchSignals(res, {
      actorsOffset: offset + batch.length,
      actorsMore: batch.length === ACTORS_PER_PAGE,
    })
  } catch (e) {
    console.error(`[/actors-more] offset=${offset} failed:`, e.message)
    patchSignals(res, { actorsMore: false })
  }
  res.end()
})

// New-movie modal actor picker: server-side search + infinite scroll.
// offset 0 = replace the list (initial / new search term); offset>0 = append
// the next page. patchSignals advances the cursor and re-arms `_pickerMore`
// (false when the last page came up short → scrolling stops).
route("GET", "/actors-picker", async (req, res) => {
  const url    = new URL(req.url ?? "/", BASE_URL)
  const term   = (url.searchParams.get("q") || "").trim()
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0)
  const q      = term ? `%${term}%` : "%"
  sseHeaders(res)
  try {
    const batch = await MovieActor.list({ limit: ACTOR_PICKER_PAGE, offset, q }, as(req))
    const chips = batch.map(actorChip).join("")
    if (offset === 0)
      patchElements(res, { selector: "#picker-list", mode: "inner",
        html: chips || `<p class="empty-panel" style="margin:0;grid-column:1/-1">No actors match.</p>` })
    else if (chips)
      patchElements(res, { selector: "#picker-list", mode: "append", html: chips })
    patchSignals(res, {
      _pickerOffset: offset + batch.length,
      _pickerMore: batch.length === ACTOR_PICKER_PAGE,
    })
  } catch (e) {
    console.error(`[/actors-picker] q="${term}" offset=${offset} failed:`, e.message)
  }
  res.end()
})

route("GET", /^\/stream\/actors\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  sseHeaders(res)
  const live = MovieActor.watchDetail({ xid }, as(req))
  await live.ready()
  const actor = live.records.get(xid) ?? [...live.records.values()][0]
  if (actor) patchElements(res, { selector: `#actor-${xid}`, html: actorDetailCard(actor), mode: "outer" })
  await pipeWatch(req, res, live, (ev) => {
    if (ev.type === "query/changed") {
      const a = live.records.get(xid) ?? [...live.records.values()][0]
      if (a) patchElements(res, { selector: `#actor-${xid}`, html: actorDetailCard(a), mode: "outer" })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Guide lifecycle — POST /demo/{deploy,import,destroy}, GET /stream/guide
//
// All three POSTs are single-flight (lib/demo-jobs.ts): a second click while
// one is running joins the SAME job instead of starting a duplicate. Each
// response holds its SSE open with a heartbeat for the job's whole duration
// (holdOpen) so `ty-button data-attr:loading` stays true throughout, then
// patches the guide's final signals as a fallback — /stream/guide (below)
// is what actually drives the live progress bars and the celebration, since
// it is the one connection every open tab (not just the clicker's) shares.
// ──────────────────────────────────────────────────────────────────────────

function guideSnapshot(job: { error: string | null }, state: Awaited<ReturnType<typeof demoState>>) {
  return {
    busy: null as string | null,
    error: job.error,
    phase: state.phase,
    partial: state.partial,
    deployed: state.dataset ? { version: state.dataset.version, xid: state.dataset.xid } : null,
    step: state.phase === "ready" ? "explore" : state.dataset ? "import" : "deploy",
    completed: state.phase === "ready" ? ["deploy", "import", "explore"] : state.dataset ? ["deploy"] : [],
  }
}

// The exact bytes `client.deploy()` ships to the engine — the guide's step 1
// links here so the model can be read (or kept) before anything is deployed.
route("GET", "/demo/model.json", async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const body = await readExport()
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(url.searchParams.has("download")
      ? { "Content-Disposition": `attachment; filename="${basename(EXPORT_PATH)}"` }
      : {}),
  })
  res.end(body)
})

route("POST", "/demo/deploy", async (req, res) => {
  sseHeaders(res)
  const { job } = startJob("deploy", async () => { await deployModel(client()) })
  await holdOpen(res, job.done)
  invalidateDemoState()
  const state = await demoState(true)
  patchSignals(res, { guide: guideSnapshot(job, state) })
  res.end()
})

route("POST", "/demo/import", async (req, res) => {
  sseHeaders(res)
  const { job } = startJob("import", async (_job, onProgress) => {
    const phases = await loadSeedPhases()
    await runSeed(client(), phases, { onProgress })
  })
  await holdOpen(res, job.done)
  invalidateDemoState()
  const state = await demoState(true)
  patchSignals(res, { guide: guideSnapshot(job, state), live: state.counts ?? {} })
  res.end()
})

route("POST", "/demo/destroy", async (req, res) => {
  sseHeaders(res)
  const { job } = startJob("destroy", async () => {
    const xid = exportDatasetXid(await readExport())
    await destroyDataset(client(), xid)
  })
  await holdOpen(res, job.done)
  invalidateDemoState()
  patchElements(res, { selector: "body", mode: "append", html: `<div data-init="location='/'"></div>` })
  res.end()
})

// The guide's own SSE: presence for the "N tabs live" pill, live XSQL counts
// (demo/progress), and job events for the import bars + the celebration on
// first reaching "ready". Kept open across the Demo.watchProgress() watch
// being torn down and reopened (tables don't exist until deploy finishes),
// hence pipeWatch's `keepOpen`.
route("GET", "/stream/guide", async (req, res) => {
  sseHeaders(res)
  bindDemoBus(req, res, "guide")

  let live: ReturnType<typeof Demo.watchProgress> | null = null
  let alive = true
  req.on("close", () => { alive = false; live?.close() })

  // A failed job reaches here as a job event; without threading it through,
  // this broadcast clears the error the POST just patched and the failure
  // renders as "nothing happened".
  let lastPhase: DemoPhase | null = null
  async function syncPhase(job: { error: string | null } = { error: null }) {
    const state = await demoState(true)
    lastPhase = state.phase
    patchSignals(res, { guide: guideSnapshot(job, state), live: state.counts ?? {} })
    if (!alive) return
    if (state.phase !== "absent" && !live) openLive()
  }

  function openLive() {
    const w = Demo.watchProgress()
    live = w
    w.ready()
      .then(() => { if (alive) patchSignals(res, { live: w.first ?? {} }) })
      .catch(() => { live = null; if (alive) setTimeout(() => { if (alive) openLive() }, 2000) })
    pipeWatch(req, res, w, (ev) => {
      if (ev.type !== "result/changed") return
      const counts = (ev as any).after?.[0]
      if (counts) patchSignals(res, { live: counts })
    }, {
      keepOpen: true,
      onSentinel: (s) => {
        if (s.type === "subscription/rejected") { live = null; if (alive) setTimeout(() => { if (alive) openLive() }, 2000) }
      },
    })
  }

  // Confetti fires exactly once per import — tied to a job actually
  // finishing, never to loading (or reloading) an already-ready guide page.
  // Every open guide tab sees it (onJobEvent is process-wide), which is the
  // point: whoever is watching the import land gets the payoff.
  const off = onJobEvent(({ job, type }) => {
    if (!alive) return
    if (type === "start" || type === "progress") {
      patchSignals(res, {
        guide: { busy: job.kind },
        ...(job.progress ? { imp: { ...job.progress.written, phase: job.progress.key, done: job.progress.done, total: job.progress.total, elapsedMs: job.progress.elapsedMs } } : {}),
      })
      return
    }
    if (type === "done" && job.kind === "import" && !job.error) {
      // Force a fresh probe rather than racing syncPhase()'s own (also
      // fresh, but unawaited below) one — reading the 2s cache here could
      // still see the pre-import "deployed" phase.
      demoState(true).then((s) => {
        if (!alive) return
        patchSignals(res, { guide: guideSnapshot({ error: null }, s), live: s.counts ?? {} })
        if (s.phase === "ready") {
          patchElements(res, { selector: "body", mode: "append", html: `<div data-init="MoviesGuide.celebrate()"></div>` })
        }
      })
    } else if (type === "done" && job.kind === "destroy" && !job.error) {
      invalidateDemoState()
      patchElements(res, { selector: "body", mode: "append", html: `<div data-init="location.href='/'"></div>` })
    } else {
      syncPhase(job)
    }
  })
  req.on("close", off)

  await syncPhase()
  const hb = setInterval(() => { if (!alive) return; try { res.write(": hb\n\n") } catch { alive = false } }, 15000)
  hb.unref?.()
  req.on("close", () => clearInterval(hb))

  // The tools rail's modeler talks to the engine directly, not this BFF, so
  // a deploy or destroy done there never reaches startJob/onJobEvent above —
  // nothing tells this stream to look again. This is the fallback: notice
  // the phase changed underneath us and resync, same as a job event would.
  const poll = setInterval(() => {
    if (!alive) return
    demoState().then((state) => {
      if (!alive || state.phase === lastPhase) return
      syncPhase()
    }).catch(() => {})
  }, 3000)
  poll.unref?.()
  req.on("close", () => clearInterval(poll))
})

// ──────────────────────────────────────────────────────────────────────────
// Write — POST /movies/:xid/rate
//
// Form-encoded submit from `<form method="POST">`. Reads `rateValue`
// from the body, calls UserRating.stack(…), then 302s back to the
// movie page where the live watch will pick up the new rating.
// ──────────────────────────────────────────────────────────────────────────

// Datastar @post from the detail rate-form / the list "trigger" button. The
// write lands a rating; the UI doesn't need patches in the response — the
// list/detail watch re-renders the affected row. So we answer with an empty
// SSE (datastar is happy, nothing to patch).
route("POST", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)\/rate$/, async (req, res, { xid }) => {
  const sess = getSession(req)
  if (!sess) return sseRun(res, `window.location='/login?returnTo=${encodeURIComponent("/movies/" + xid)}'`)
  const body = await readJsonOrForm(req)
  const value = Number(body.rateValue ?? body.value)
  if (!Number.isFinite(value) || value <= 0) return sseRun(res, "alert('Pick a rating between 0.5 and 5.')")

  try {
    await UserRating.stack([{ value, movie: { xid } }], { actingAs: sess.user.xid })
    sseHeaders(res); res.end()   // watch handles the UI update
  } catch (e) {
    console.error(`[/rate] failed:`, e.message, e.details || "")
    sseRun(res, `alert(${JSON.stringify("Rating failed: " + e.message)})`)
  }
})

// The footer's "Let a crowd in". No login, like the guide's buttons: it writes
// as the BFF's own client (local demo policy). Answers at once — progress
// reaches every tab as the `crowd` signal.
route("POST", "/demo/crowd", async (req, res) => {
  if ((await demoState()).phase !== "ready") return sseRun(res, "alert('Import the data first.')")
  const url = new URL(req.url ?? "/", BASE_URL)
  const focus = (url.searchParams.get("from") ?? "").match(/^\/movies\/([A-Za-z0-9_-]+)$/)?.[1] ?? null
  try {
    await startCrowd(focus)
    sseHeaders(res); res.end()
  } catch (e) {
    console.error(`[/demo/crowd] failed:`, e.message)
    sseRun(res, `alert(${JSON.stringify("Crowd failed: " + e.message)})`)
  }
})

// One attribute the generated client does not know — added in the modeler.
// The name is checked against the LIVE schema, the value coerced to its type,
// and written with a plain sync(); the record watch repaints every open tab.
route("POST", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)\/field$/, async (req, res, { xid }) => {
  const sess = getSession(req)
  if (!sess) return sseRun(res, `window.location='/login?returnTo=${encodeURIComponent("/movies/" + xid)}'`)
  const name = new URL(req.url ?? "/", BASE_URL).searchParams.get("name") ?? ""
  const field = (await extraFields()).find((f) => f.name === name)
  if (!field) return sseRun(res, `alert(${JSON.stringify(`Movie has no attribute "${name}" (any more?).`)})`)
  const body = await readJsonOrForm(req)
  try {
    const value = coerce(field.type, body?.xf?.[name])
    await client().sync("Movie", { xid, [name]: value }, { actingAs: sess.user.xid })
    sseHeaders(res); res.end()
  } catch (e) {
    console.error(`[POST /movies/${xid}/field ${name}] failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") return sseRun(res, "window.location='/login?reason=session-expired'")
    sseRun(res, `alert(${JSON.stringify("Save failed: " + e.message)})`)
  }
})

// History → "Restore": put the fields one recorded change touched back the
// way they were just before it (history.getAt). Only those fields — an older
// restore must not roll back unrelated later edits — and only ones that still
// exist on Movie. A field missing from the snapshot was empty then. The
// restore is itself a change and joins the history.
route("POST", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)\/restore$/, async (req, res, { xid }) => {
  const sess = getSession(req)
  if (!sess) return sseRun(res, `window.location='/login?returnTo=${encodeURIComponent("/movies/" + xid)}'`)
  const at = new URL(req.url ?? "/", BASE_URL).searchParams.get("at") ?? ""
  if (!at || Number.isNaN(Date.parse(at))) return sseRun(res, "alert('Nothing to restore to.')")
  try {
    const entry = (await movieHistory(xid)).find((e) => e.ts === at)
    if (!entry?.restorable) return sseRun(res, "alert('History has no earlier state for this change.')")
    const before = (await movieStateBefore(xid, at)) ?? {}
    const current = new Set((await movieFields()).map((f) => f.name))
    const data = Object.fromEntries(entry.fields
      .filter((f) => current.has(f.name))
      .map((f) => [f.name, f.name in before ? before[f.name] : null]))
    if (!Object.keys(data).length) return sseRun(res, "alert('Those fields no longer exist on Movie.')")
    await client().sync("Movie", { xid, ...data }, { actingAs: sess.user.xid })
    sseHeaders(res); res.end()
  } catch (e) {
    console.error(`[POST /movies/${xid}/restore] failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") return sseRun(res, "window.location='/login?reason=session-expired'")
    sseRun(res, `alert(${JSON.stringify("Restore failed: " + e.message)})`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Write — POST /movies  (create new movie + optional cast)
// ──────────────────────────────────────────────────────────────────────────

// One-shot Datastar SSE: open the stream, run a single expression on the client
// via a patched-in `data-init` element, close. Datastar's only server→client
// events are patch-elements/-signals (no built-in redirect), so navigation and
// error alerts after an @post submit ride on this.
function sseRun(res: ServerResponse, expr: string) {
  sseHeaders(res)
  patchElements(res, { selector: "body", mode: "append", html: `<div data-init="${esc(expr)}"></div>` })
  res.end()
}
// xid-string arrays (from Datastar `$actors`/`$genres` signals) → sync payload.
const toRel = (xids: unknown) =>
  (Array.isArray(xids) ? xids.filter((x): x is string => typeof x === "string") : []).map((xid) => ({ xid }))

route("POST", "/movies", async (req, res) => {
  const sess = getSession(req); if (!sess) return sseRun(res, "window.location='/login'")
  const body = await readJsonOrForm(req)
  const title = String(body.title ?? "").trim()
  if (!title) return sseRun(res, "alert('Title is required.')")
  const data = {
    title,
    ...(body.release_year ? { release_year: Number(body.release_year) } : {}),
    actors: toRel(body.actors),
    genres: toRel(body.genres),
  }
  try {
    // Relations as { xid } links — MovieWrite types them as ({xid}|MovieActorWrite)[],
    // so the link form is accepted directly, no cast.
    await Movie.sync(data, { actingAs: sess.user.xid })
    sseRun(res, "$_modalOpen = false; $title = ''; $release_year = null; $actors = []; $genres = []")
  } catch (e) {
    console.error(`[POST /movies] failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") return sseRun(res, "window.location='/login?reason=session-expired'")
    sseRun(res, `alert(${JSON.stringify("Create failed: " + e.message)})`)
  }
})

// Edit — POST /movies/:xid. Same sync payload + xid; relations are sent in full
// (sync REPLACES link-sets, so an empty list unlinks everything).
route("POST", /^\/movies\/(?<xid>[A-Za-z0-9_-]+)$/, async (req, res, { xid }) => {
  const sess = getSession(req); if (!sess) return sseRun(res, "window.location='/login'")
  const body = await readJsonOrForm(req)
  const title = String(body.title ?? "").trim()
  if (!title) return sseRun(res, "alert('Title is required.')")
  const data = {
    xid,
    title,
    release_year: body.release_year ? Number(body.release_year) : null,
    actors: toRel(body.actors),
    genres: toRel(body.genres),
  }
  try {
    await Movie.sync(data, { actingAs: sess.user.xid })
    sseRun(res, "$_modalOpen = false")
  } catch (e) {
    console.error(`[POST /movies/${xid}] failed:`, e.message, e.details || "")
    if (classifySdkError(e) === "stale-session") return sseRun(res, "window.location='/login?reason=session-expired'")
    sseRun(res, `alert(${JSON.stringify("Save failed: " + e.message)})`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// OIDC routes
// ──────────────────────────────────────────────────────────────────────────

route("GET", "/login", async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const returnTo = url.searchParams.get("returnTo") || "/"
  // publicEndpoint, not endpoint: this URL is for the BROWSER, which may
  // reach the engine at a different host than the BFF does.
  const { url: authUrl } = await client().login.start({
    redirectUri:    REDIRECT_URI,
    returnTo,
    publicEndpoint: PUBLIC_ENDPOINT,
  })
  res.writeHead(302, { Location: authUrl }); res.end()
})

route("GET", "/auth/callback", async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")

  // Cancelling on the engine's login page is a normal outcome, not a
  // failure: RFC 6749 §4.1.2.1 sends the browser back here with `error`
  // and no `code`. Recover where the visitor was headed and say why.
  if (error) {
    const pending = await client().login.cancel(state)
    const notice = url.searchParams.get("error_description")
      || (error === "access_denied"
            ? "Login cancelled — reads work anonymously, only rating needs an account."
            : `Login failed (${error}).`)
    res.writeHead(302, { Location: withNotice(pending?.returnTo ?? "/", notice) })
    return res.end()
  }

  if (!code || !state) return send(res, 400, "text/plain", "missing code or state")
  try {
    // `user` is { xid, name, scopes } straight off the id_token — the engine
    // puts the xid on every token it signs, so no lookup here.
    const { user, tokens, returnTo } = await client().login.complete({
      code, state, redirectUri: REDIRECT_URI,
    })
    applyLogin(res, { sid: createSession({ tokens, user }), returnTo })
  } catch (e) {
    const status = (e as { code?: string }).code === "LOGIN_STATE_UNKNOWN" ? 400 : 500
    send(res, status, "text/plain", (e as Error).message)
  }
})

route("POST", "/logout", async (req, res) => {
  logout(req)
  applyLogout(res, "/")
})

// GET variant so error banners ("Log out and sign back in") and old
// browser bookmarks can clear a busted session with a plain anchor.
route("GET", "/logout", async (req, res) => {
  logout(req)
  applyLogout(res, "/")
})

// ──────────────────────────────────────────────────────────────────────────
// Static
// ──────────────────────────────────────────────────────────────────────────

route("GET", /^\/public\//, async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const filename = url.pathname.replace(/^\/public\//, "")
  const path = resolve(HERE, "public", filename)
  if (!path.startsWith(resolve(HERE, "public"))) return send(res, 403, "text/plain", "")
  try {
    const buf = await readFile(path)
    const ext = extname(path).toLowerCase()
    const ct = ext === ".css" ? "text/css"
             : ext === ".js"  ? "application/javascript"
             :                  "application/octet-stream"
    send(res, 200, ct, buf)
  } catch { send(res, 404, "text/plain", "not found") }
})

// Shared, unbundled files every demo reads live from examples/shared/ (see
// examples/shared/README.md): the tools-rail dock, the tour engine and the
// scenario runner. The movies tour's own steps stay in public/guide-tour.js.
route("GET", /^\/(?<file>tools-rail|tour|scenario)\.js$/, async (req, res, { file }) => {
  try {
    const buf = await readFile(resolve(HERE, "..", "..", "shared", `${file}.js`))
    send(res, 200, "application/javascript", buf)
  } catch { send(res, 404, "text/plain", "not found") }
})

// The domain's tour scenario (examples/shared/scenario.js reads it), shared by
// every port of this domain.
route("GET", "/tour.json", async (req, res) => {
  try {
    send(res, 200, "application/json", await readFile(resolve(HERE, "..", "tour.json")))
  } catch { send(res, 404, "text/plain", "not found") }
})

// The domain's own .xsql — the exact files `npm run codegen` reads. Served so
// the tools rail can open them as data-console workspaces: the visitor sees
// that these queries are what shape the data this page renders.
const XSQL_DIR = resolve(HERE, "..", "xsql")
route("GET", /^\/xsql\//, async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const path = resolve(XSQL_DIR, url.pathname.replace(/^\/xsql\//, ""))
  if (!path.startsWith(XSQL_DIR) || !path.endsWith(".xsql")) return send(res, 403, "text/plain", "")
  try {
    send(res, 200, "text/plain; charset=utf-8", await readFile(path))
  } catch { send(res, 404, "text/plain", "not found") }
})

// A locally built web-component bundle, when examples/scripts/build-tooling.sh
// has dropped one — the loop for testing a component change before
// @synthigy/tooling is republished. layout.ts points the rail here only if the
// directory exists, so deleting it reverts every page to the CDN.
const TOOLING_DIR = resolve(HERE, "..", "..", "shared", "vendor", "tooling")
route("GET", /^\/vendor\/tooling\//, async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const path = resolve(TOOLING_DIR, url.pathname.replace(/^\/vendor\/tooling\//, ""))
  if (!path.startsWith(TOOLING_DIR)) return send(res, 403, "text/plain", "")
  try {
    const buf = await readFile(path)
    const ct = extname(path).toLowerCase() === ".css" ? "text/css" : "application/javascript"
    send(res, 200, ct, buf)
  } catch { send(res, 404, "text/plain", "not found") }
})

// Serve the Tyrell components bundle from the installed dependency (no CDN).
// dist/tyrell.js is a self-contained ESM bundle; tyrell.css is the stylesheet.
const TYRELL_DIST = resolve(HERE, "node_modules", "tyrell-components", "dist")
route("GET", /^\/vendor\/tyrell\//, async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const filename = url.pathname.replace(/^\/vendor\/tyrell\//, "")
  const path = resolve(TYRELL_DIST, filename)
  if (!path.startsWith(TYRELL_DIST)) return send(res, 403, "text/plain", "")
  try {
    const buf = await readFile(path)
    const ct = extname(path).toLowerCase() === ".css" ? "text/css" : "application/javascript"
    send(res, 200, ct, buf)
  } catch { send(res, 404, "text/plain", "not found") }
})

// ──────────────────────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer) {
  // Force browsers to fetch fresh HTML/CSS so my edits aren't shadowed
  // by stale page caches. Demo BFF only — don't ship this to prod as-is.
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  })
  res.end(body)
}

async function readJsonOrForm(req: IncomingMessage) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString("utf8")
  const ct = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
  if (ct === "application/json") return JSON.parse(raw || "{}")
  if (ct === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  // Datastar @post sends JSON by default — try JSON, fall back to raw.
  try { return JSON.parse(raw) } catch { return { _raw: raw } }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL)
  const m = matchRoute(req.method ?? "GET", url)
  if (!m) return send(res, 404, "text/plain", "not found")
  try {
    await m.handler(req, res, m.params)
  } catch (e) {
    console.error("handler error:", e)
    if (!res.headersSent) send(res, 500, "text/plain", "internal error")
  }
})

server.listen(PORT, () => {
  console.log(`
  datastar-movies BFF
    listening : ${BASE_URL}
    upstream  : ${ENDPOINT}
    client_id : ${CLIENT_ID}
    redirect  : ${REDIRECT_URI}

  open ${BASE_URL} in two browser tabs to see the magic.
`)
})
