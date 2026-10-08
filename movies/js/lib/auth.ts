// @ts-nocheck — infra plumbing (auth/session, icon rendering); not part of the SDK-facing surface. Type later.
/**
 * Cookie sessions for the datastar-movies demo — the half of login that is
 * this app's business and not the SDK's.
 *
 * Architecture: this is a BFF (backend-for-frontend) — the browser never
 * sees a token. The OIDC protocol half (PKCE, the authorize URL, the code
 * exchange, reading the user out of the id_token) is `client().login` in
 * @synthigy/sdk; what lives here is what the SDK deliberately has no opinion
 * about: the cookie, the session record, and its lifetime.
 *
 *   1. browser GET /login            → login.start() → 302 to the engine
 *   2. user logs in on Synthigy
 *   3. browser GET /auth/callback    → login.complete() → createSession()
 *   4. server 302 → returnTo, with the session cookie set
 *
 * The cookie is HttpOnly + SameSite=Lax. Tokens stay server-side.
 *
 * Sessions live in a Map mirrored to a JSON file so dev restarts don't log
 * everyone out. Production: swap for Postgres / Redis. The shape of
 * `Session` is stable.
 */

import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const SESSION_COOKIE = "datastar_movies_sid"
const SESSION_TTL_MS = 8 * 60 * 60 * 1000  // 8h

// File-backed session store so dev restarts don't kick the user out.
// Tokens are sensitive — keep this file outside any committed tree.
const SESSION_FILE = process.env.DATASTAR_MOVIES_SESSION_FILE
  ?? "/tmp/datastar-movies-sessions.json"

function loadSessions() {
  try {
    const raw = readFileSync(SESSION_FILE, "utf8")
    const { sessions: s = [] } = JSON.parse(raw)
    return new Map(s)
  } catch { return new Map() }
}

let savePending = false
function saveSessions() {
  if (savePending) return
  savePending = true
  // Debounce writes — a burst of session ops shouldn't fsync a dozen times.
  setImmediate(() => {
    savePending = false
    try {
      writeFileSync(SESSION_FILE,
        JSON.stringify({ sessions: [...sessions.entries()] }))
    } catch (e) {
      console.warn("[auth] session save failed:", e?.message)
    }
  })
}

// sessionId → { tokens, user, expiresAt }
const sessions = loadSessions()

// Drop expired sessions on boot.
{
  const now = Date.now()
  let dropped = 0
  for (const [k, v] of sessions) if (!v?.expiresAt || v.expiresAt < now) { sessions.delete(k); dropped++ }
  if (dropped) saveSessions()
  console.log(`[auth] loaded ${sessions.size} session(s) from ${SESSION_FILE}${dropped ? ` (dropped ${dropped} expired)` : ""}`)
}

setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const [k, v] of sessions) if (v.expiresAt < now) { sessions.delete(k); changed = true }
  if (changed) saveSessions()
}, 60_000).unref()

// ──────────────────────────────────────────────────────────────────────────
// Cookies
// ──────────────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setSessionCookie(res, sessionId) {
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`)
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// ──────────────────────────────────────────────────────────────────────────
// Session lookup
// ──────────────────────────────────────────────────────────────────────────

export function getSession(req) {
  const { [SESSION_COOKIE]: sid } = parseCookies(req)
  if (!sid) return null
  const sess = sessions.get(sid)
  if (!sess) return null
  if (sess.expiresAt < Date.now()) { sessions.delete(sid); saveSessions(); return null }
  return sess
}

// ──────────────────────────────────────────────────────────────────────────
// Session creation — what the SDK hands back becomes a cookie
// ──────────────────────────────────────────────────────────────────────────

function base64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// `user` comes from login.complete() as { xid, name, scopes } — the xid rides
// the id_token, so there is no lookup here.
export function createSession({ tokens, user }) {
  const sid = base64url(randomBytes(24))
  sessions.set(sid, {
    sid,
    tokens,                                  // { access_token, refresh_token, expires_in, id_token }
    user,
    issuedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  })
  saveSessions()
  return sid
}

export function logout(req) {
  const { [SESSION_COOKIE]: sid } = parseCookies(req)
  if (sid) { sessions.delete(sid); saveSessions() }
  return sid
}

// Drop a known-bad session (stale xid, deleted user, etc.) without
// requiring the request — used by handlers that detect mid-request
// that the cached session.user.xid no longer resolves server-side.
export function dropSession(sid) {
  if (sid && sessions.has(sid)) { sessions.delete(sid); saveSessions() }
}

// ──────────────────────────────────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────────────────────────────────

export function applyLogin(res, { sid, returnTo }) {
  setSessionCookie(res, sid)
  res.writeHead(302, { Location: returnTo })
  res.end()
}

export function applyLogout(res, to = "/") {
  clearSessionCookie(res)
  res.writeHead(302, { Location: to })
  res.end()
}
