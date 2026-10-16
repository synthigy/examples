// Movie's shape as the ENGINE has it right now — not as codegen saw it.
//
// generated/ops.ts is typed against the model that was deployed when
// `codegen` ran: title, release_year, poster. Add an attribute to Movie in the
// modeler and deploy, and those types know nothing about it. This module reads
// the live schema instead (client().schema(), the same introspection the SDK's
// own watch resolver uses) and re-reads it on every deploy, so the detail page
// can show and edit attributes that did not exist when this BFF started.
//
// A deploy is noticed as a change of the dataset's deployed version — see
// watchMovieModel() for why that is a poll today and not only a push.
import { client } from "../generated/ops.ts"
import { exportDatasetXid, readExport } from "./seed.ts"

export type MovieField = { name: string; type: string; xid: string | null }
export type ModelChange = { added: string[]; removed: string[]; version: string | null }

// What the app was written for (and the engine's own audit attributes). Any
// other attribute on Movie is "extra" — it came from the modeler.
const KNOWN = new Set([
  "xid", "euuid", "title", "release_year", "poster",
  "created_on", "created_by", "modified_on", "modified_by",
])
// Reference-typed attributes point at another entity; their value is a
// record, not something a text box can hold.
const REFERENCE_TYPES = new Set(["user", "group", "role"])
export const EDITABLE_TYPES = new Set(["string", "int", "float", "boolean"])

let fields: MovieField[] = []
let nameByXid = new Map<string, string>()
let loading: Promise<void> | null = null

async function load(): Promise<void> {
  const schema: any = await client().schema()
  const movie = schema?.entities?.movie
  const xids: Record<string, string> = movie?.xids?.attributes ?? {}
  fields = Object.entries(movie?.attributes ?? {}).map(([name, a]: [string, any]) => ({
    name, type: String(a?.type ?? "string"), xid: xids[name] ?? null,
  }))
  nameByXid = new Map(Object.entries(xids).map(([name, xid]) => [String(xid), name]))
}

async function ensureLoaded(): Promise<void> {
  if (!loading) loading = load().catch((e) => { loading = null; throw e })
  await loading
}

export async function movieFields(): Promise<MovieField[]> {
  await ensureLoaded()
  return fields
}

export async function extraFields(): Promise<MovieField[]> {
  return (await movieFields()).filter((f) => !KNOWN.has(f.name) && !REFERENCE_TYPES.has(f.type))
}

// History events and getAt() key values by attribute xid.
export async function attributeName(xid: string): Promise<string | null> {
  await ensureLoaded()
  return nameByXid.get(xid) ?? null
}

// Current values of the extra attributes for one movie. A plain get() with a
// selection built at runtime — exactly what the typed op cannot do.
export async function extraValues(xid: string, extras: MovieField[]): Promise<Record<string, unknown>> {
  if (!extras.length) return {}
  const selection = Object.fromEntries(extras.map((f) => [f.name, null]))
  const row = await client().get("Movie", { xid }, selection) as Record<string, unknown> | null
  return row ?? {}
}

// Text from a form field → the attribute's type. Empty clears the value.
export function coerce(type: string, raw: unknown): unknown {
  const s = raw == null ? "" : String(raw).trim()
  if (s === "") return null
  if (type === "int") { const n = parseInt(s, 10); if (!Number.isFinite(n)) throw new Error(`"${s}" is not a whole number`); return n }
  if (type === "float") { const n = Number(s); if (!Number.isFinite(n)) throw new Error(`"${s}" is not a number`); return n }
  if (type === "boolean") return s === "true" || s === "1" || s === "on"
  return s
}

// ── deploy watch ──────────────────────────────────────────────────────────

const listeners = new Set<(c: ModelChange) => void>()

export function onMovieModelChange(cb: (c: ModelChange) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// The Movies dataset's deployed version — the same probe lib/demo-state.ts
// makes (plain-object `_order_by`; see the note there).
async function deployedVersion(): Promise<{ xid: string; name: string | null } | null> {
  const dataset = exportDatasetXid(await readExport())
  const row = await client().get("Dataset", { xid: dataset }, {
    xid: null,
    versions: {
      args: { _where: { deployed: { _eq: true } }, _order_by: { deployed_on: "desc" }, _limit: 1 },
      selections: { xid: null, name: null },
    },
  } as any) as any
  const v = row?.versions?.[0]
  return v ? { xid: v.xid, name: v.name ?? null } : null
}

let lastVersion: string | null | undefined   // undefined = not probed yet
let checking: Promise<void> | null = null

// Re-reads the schema and tells listeners what changed on Movie — but only
// when the deployed version actually moved, so the two triggers below can
// both fire for one deploy without a second notice.
function checkDeployed(): Promise<void> {
  if (checking) return checking
  checking = (async () => {
    const v = await deployedVersion()
    const key = v?.xid ?? null
    if (lastVersion === undefined) { lastVersion = key; return }
    if (key === lastVersion) return
    lastVersion = key
    const before = new Set(fields.map((f) => f.name))
    loading = load()
    await loading
    // A destroy leaves nothing deployed — the pages are being sent back to
    // the guide anyway, there is nothing to announce.
    if (!v) return
    const after = new Set(fields.map((f) => f.name))
    // Only what the app was not written for is news; a guide deploy after a
    // destroy "adds" title and year back, which nobody needs to be told.
    const change: ModelChange = {
      added: [...after].filter((n) => !before.has(n) && !KNOWN.has(n)),
      removed: [...before].filter((n) => !after.has(n) && !KNOWN.has(n)),
      version: v.name,
    }
    for (const cb of listeners) {
      try { cb(change) } catch (e: any) { console.error("[movie-model] listener error:", e?.message) }
    }
  })().catch((e) => console.error("[movie-model] deploy check failed:", e?.message))
    .finally(() => { checking = null })
  return checking
}

const POLL_MS = 3000

// Two triggers, one gate (checkDeployed):
//
//   - client().watchSchema() — the push. In @synthigy/sdk 0.2.2 it never
//     yields: deploys do reach the SDK's SSE, but listen() strips the SSE
//     `event:` name before the multiplexer reads it, and the multiplexer
//     recognises a deploy only by that name. Kept so this starts working
//     the day the SDK is fixed.
//   - a poll of the deployed version every few seconds — what actually
//     notices a modeler deploy today. One small read; the guide's own stream
//     already makes the same one.
let watching = false
export function watchMovieModel(): void {
  if (watching) return
  watching = true
  ensureLoaded().catch(() => {})
  checkDeployed()
  const w = client().watchSchema()
  ;(async () => { for await (const _ of w.events) await checkDeployed() })()
    .catch((e) => console.error("[movie-model] schema watch ended:", e?.message))
  setInterval(() => { checkDeployed() }, POLL_MS).unref?.()
}
