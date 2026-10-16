// A movie's change history, read from the engine's audit store.
//
// Model 0.5 sets one flag on Movie, `audit/persist`. From then on every write
// to a Movie lands in the audit store as one event per attribute: who, when,
// which transaction, the new value. Nothing in this app writes those events —
// this module only reads them back (client().history) and folds them into
// "who changed what from what to what".
//
// Movies imported before the flag was on have no history until their first
// edit, so the oldest change may not know the value it replaced.
import { client } from "../generated/ops.ts"
import { attributeName } from "./movie-model.ts"

export type FieldChange = { name: string; from: unknown; to: unknown; knownFrom: boolean }
export type HistoryEntry = {
  ts: string
  op: string
  actor: string
  fields: FieldChange[]
  // Every field this entry touched has a recorded "before" — only then can
  // Restore put it back faithfully.
  restorable: boolean
}

// The engine's own bookkeeping attributes are not edits anyone made.
const SKIP = new Set(["xid", "euuid", "created_on", "created_by", "modified_on", "modified_by"])

// The wire uses kebab keys (record-xid, attribute-xid); the SDK's typings
// declare camelCase. Read both so neither side's rename breaks this.
type RawEvent = Record<string, unknown>
const pick = (e: RawEvent, ...keys: string[]) => keys.map((k) => e[k]).find((v) => v != null)

const actorNames = new Map<string, string>()
async function resolveActors(xids: string[]): Promise<void> {
  const missing = xids.filter((x) => !actorNames.has(x))
  if (!missing.length) return
  try {
    const rows = await client().search("User", { _where: { xid: { _in: missing } } } as any, { xid: null, name: null }) as any[]
    for (const r of rows ?? []) actorNames.set(r.xid, r.name ?? r.xid.slice(0, 8))
  } catch (e: any) {
    console.warn("[movie-history] actor lookup failed:", e?.message)
  }
}

export async function movieHistory(xid: string, limit = 200): Promise<HistoryEntry[]> {
  const raw = await client().history.events({ recordXid: xid, limit }) as unknown as RawEvent[]
  const events = (raw ?? []).slice().sort((a, b) =>
    Number(pick(a, "seq") ?? 0) - Number(pick(b, "seq") ?? 0)
    || String(pick(a, "ts")).localeCompare(String(pick(b, "ts"))))

  // One entry per transaction: a single save that touched two fields is one
  // change, not two.
  const groups = new Map<string, RawEvent[]>()
  for (const e of events) {
    const key = String(pick(e, "txid") ?? pick(e, "ts"))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }

  await resolveActors([...new Set(events.map((e) => String(pick(e, "actor", "actorXid") ?? "")).filter(Boolean))])

  const last = new Map<string, unknown>()   // attribute name → latest value seen so far
  // Once the record's creation is on file, an attribute with no event yet was
  // simply empty (e.g. one added in the modeler later) — that is a known
  // "before". Without it (imported before history was on) it is not.
  let sawInsert = false
  const entries: HistoryEntry[] = []
  for (const group of groups.values()) {
    const first = group[0]
    const fields: FieldChange[] = []
    for (const e of group) {
      const attrXid = String(pick(e, "attribute-xid", "attributeXid") ?? "")
      const name = attrXid ? await attributeName(attrXid) : null
      if (!name || SKIP.has(name)) continue
      const to = pick(e, "value") ?? null
      const knownFrom = last.has(name) || sawInsert
      const from = last.has(name) ? last.get(name) : sawInsert ? null : undefined
      last.set(name, to)
      // An update that wrote the same value back is not a change worth a row.
      if (knownFrom && JSON.stringify(from) === JSON.stringify(to)) continue
      fields.push({ name, from, to, knownFrom })
    }
    const op = String(pick(first, "op") ?? "update")
    if (op === "insert") sawInsert = true
    if (!fields.length) continue
    const actorXid = String(pick(first, "actor", "actorXid") ?? "")
    entries.push({
      ts: String(pick(first, "ts") ?? ""),
      op,
      actor: actorNames.get(actorXid) ?? (actorXid ? actorXid.slice(0, 8) : "unknown"),
      fields,
      restorable: op !== "insert" && fields.every((f) => f.knownFrom),
    })
  }
  return entries.reverse()   // newest first
}

// The record as it was just before `ts` — keyed by attribute NAME, limited to
// plain attributes (what Restore may write back).
export async function movieStateBefore(xid: string, ts: string): Promise<Record<string, unknown> | null> {
  const at = new Date(new Date(ts).getTime() - 1).toISOString()
  const state = await client().history.getAt(xid, at) as Record<string, unknown> | null
  if (!state) return null
  const out: Record<string, unknown> = {}
  for (const [attrXid, value] of Object.entries(state)) {
    const name = await attributeName(attrXid)
    if (name && !SKIP.has(name)) out[name] = value
  }
  return out
}
