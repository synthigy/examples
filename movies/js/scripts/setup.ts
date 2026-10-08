// Deploy the movies model and seed ml-latest-small, using nothing but the SDK.
// The same deploy/seed path the guide's "Deploy" / "Import the data" buttons
// run (lib/seed.ts) — this script is the offline, no-browser equivalent.
//
//   synthigy exec -- node scripts/setup.ts   (client must hold Dataset Developer)
import { createClient } from "@synthigy/sdk"
import { deployModel, loadSeedPhases, runSeed } from "../lib/seed.ts"

const client = createClient({
  endpoint:     process.env.SYNTHIGY_ENDPOINT ?? "http://localhost:7887",
  clientId:     process.env.SYNTHIGY_CLIENT_ID,
  clientSecret: process.env.SYNTHIGY_CLIENT_SECRET,
})

const ack = await deployModel(client)
console.log(`deployed ${ack.version} (dataset ${ack.dataset})`)

const phases = await loadSeedPhases()
await runSeed(client, phases, {
  onProgress: (p) => {
    if (p.done === p.total) console.log(`seeded ${p.entity} (${p.key}): ${p.done}`)
  },
})
client.close()
