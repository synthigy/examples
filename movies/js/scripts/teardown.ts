// Destroy the dataset setup.ts (or the guide) deployed — every version, table
// and row. Idempotent: safe after a failed setup, safe to run twice.
//
//   node scripts/teardown.ts
import { createClient } from "@synthigy/sdk"
import { destroyDataset, exportDatasetXid, readExport } from "../lib/seed.ts"

const client = createClient({
  endpoint:     process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887",
  clientId:     process.env.SYNTHIGY_CLIENT_ID,
  clientSecret: process.env.SYNTHIGY_CLIENT_SECRET,
})

const xid = exportDatasetXid(await readExport())
const destroyed = await destroyDataset(client, xid)
console.log(destroyed ? `destroyed dataset ${xid}` : `nothing deployed — dataset ${xid} was already gone`)
client.close()
