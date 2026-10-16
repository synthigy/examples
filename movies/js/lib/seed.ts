// Deploy + seed the movies model — the logic scripts/setup.ts and the guide's
// /demo/import job both run. The export's bytes go over the wire untouched;
// the server decodes them. See examples/movies/js/README.md "Guided demo".
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SynthigyClient } from "@synthigy/sdk"

const HERE = dirname(fileURLToPath(import.meta.url))
export const DATASETS = join(HERE, "..", "..", "..", "datasets", "movies")
export const EXPORT_PATH = join(DATASETS, "Movies Example@0.5.json")
const SEED_DIR = join(DATASETS, "movies")

export type SeedPhaseKey =
  | "genres" | "actors" | "movies" | "genre-links" | "actor-links" | "ratings" | "tags"
// The five entity phases move a DemoCounts field; the two link phases don't
// (a link doesn't create a row in any of the five counted entities).
const ENTITY_FIELD: Partial<Record<SeedPhaseKey, keyof DemoCounts>> = {
  genres: "genres", actors: "actors", movies: "movies", ratings: "ratings", tags: "tags",
}

export type SeedPhase = { key: SeedPhaseKey; entity: string; rows: Record<string, unknown>[] }
export type DemoCounts = { genres: number; actors: number; movies: number; ratings: number; tags: number }
export type SeedProgress = {
  key: SeedPhaseKey; entity: string; done: number; total: number
  phaseIndex: number; phaseCount: number; written: DemoCounts; elapsedMs: number
}

const load = async (name: string) => JSON.parse(await readFile(join(SEED_DIR, `${name}.json`), "utf8"))
const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n))

export async function readExport(): Promise<string> {
  return readFile(EXPORT_PATH, "utf8")
}

// The export's own dataset xid — deploy() preserves it, so this is also what
// destroy() takes. No `generated/deploy.json` needed: the xid is a property
// of the (committed, never-edited) export file, not per-instance state.
export function exportDatasetXid(exportText: string): string {
  const parsed = JSON.parse(exportText)
  const xid = parsed?.["~:dataset"]?.["~:xid"]
  if (typeof xid !== "string") throw new Error("export has no ~:dataset ~:xid — wrong file?")
  return xid
}

// Same reshaping as bench/competitors/synthigy_http.mjs: actors dedupe on
// Name (UNIQUE), m2m links ride on the parent entity, ratings/tags carry only
// what the model declares. Users are not seeded — that is IAM, not this model.
export async function loadSeedPhases(): Promise<SeedPhase[]> {
  const genres = (await load("movie_genres")).map((g: any) => ({ xid: g.xid, name: g.name }))

  const byName = new Map<string, any>(), remap = new Map<string, string>()
  for (const a of await load("movie_actors")) {
    const kept = byName.get(a.name)
    if (kept) remap.set(a.xid, kept.xid); else byName.set(a.name, a)
  }
  const actors = [...byName.values()].map((a) => ({
    xid: a.xid, name: a.name, avatar: a.avatar ?? null, birth_year: a.birth_year ?? null, nationality: a.nationality ?? null,
  }))

  const movies = (await load("movies")).map((m: any) => ({ xid: m.xid, title: m.title ?? null, release_year: m.release_year ?? null, poster: m.poster ?? null }))
  const genreMap = (await load("movie_genres_mapping")).map((g: any) => ({ xid: g.xid, movies: g.movies.map((m: any) => ({ xid: m.xid })) }))

  const actorMap = new Map<string, any>()
  for (const a of await load("movie_actors_mapping")) {
    const xid = remap.get(a.xid) ?? a.xid
    const row = actorMap.get(xid) ?? actorMap.set(xid, { xid, movies: [] }).get(xid)
    const seen = new Set(row.movies.map((m: any) => m.xid))
    for (const m of a.movies) if (!seen.has(m.xid)) row.movies.push({ xid: m.xid })
  }

  const strip = (r: any) => ({ xid: r.xid, value: r.value, timestamp: r.timestamp ?? null, movie: { xid: r.movie.xid } })
  const ratings = (await load("user_ratings")).map(strip)
  const tags    = (await load("user_tags")).map(strip)

  return [
    { key: "genres",      entity: "Movie Genre", rows: genres },
    { key: "actors",      entity: "Movie Actor", rows: actors },
    { key: "movies",      entity: "Movie",       rows: movies },
    { key: "genre-links", entity: "Movie Genre", rows: genreMap },
    { key: "actor-links", entity: "Movie Actor", rows: [...actorMap.values()] },
    { key: "ratings",     entity: "User Rating", rows: ratings },
    { key: "tags",        entity: "User Tag",    rows: tags },
  ]
}

export function seedCounts(phases: SeedPhase[]): DemoCounts {
  const out: DemoCounts = { genres: 0, actors: 0, movies: 0, ratings: 0, tags: 0 }
  for (const p of phases) {
    const field = ENTITY_FIELD[p.key]
    if (field) out[field] = p.rows.length
  }
  return out
}

export async function deployModel(client: SynthigyClient) {
  return client.deploy(await readExport())
}

export async function destroyDataset(client: SynthigyClient, xid: string) {
  return client.destroy(xid)
}

export class AbortedError extends Error { constructor() { super("import aborted") } }

export async function runSeed(
  client: SynthigyClient,
  phases: SeedPhase[],
  opts: { chunk?: number; signal?: AbortSignal; onProgress?: (p: SeedProgress) => void } = {},
): Promise<DemoCounts> {
  const chunkSize = opts.chunk ?? 500
  const startedAt = Date.now()
  const written: DemoCounts = { genres: 0, actors: 0, movies: 0, ratings: 0, tags: 0 }
  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const { key, entity, rows } = phases[phaseIndex]
    const parts = chunk(rows, chunkSize)
    let done = 0
    for (const part of parts) {
      if (opts.signal?.aborted) throw new AbortedError()
      await client.sync(entity, part)
      done += part.length
      const field = ENTITY_FIELD[key]
      if (field) written[field] = done
      opts.onProgress?.({
        key, entity, done, total: rows.length,
        phaseIndex, phaseCount: phases.length,
        written: { ...written }, elapsedMs: Date.now() - startedAt,
      })
    }
  }
  return written
}
