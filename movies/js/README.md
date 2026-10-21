# Movies — JavaScript

A live, authenticated movies app on `@synthigy/sdk`: real-time list and detail,
OIDC login, infinite scroll, live counters. No client-side framework and no
build step; the browser receives HTML and SSE patches.

```
Browser            Datastar + Tyrell + Tailwind, all from CDN
   |  HTML + SSE patches
Node BFF           this directory, TypeScript run directly by node
   |  @synthigy/sdk, typed from ../xsql
Synthigy           /data, /oauth, /data/events
```

Tokens never reach the browser. Reads run as the BFF's own client; the
visitor's `actingAs` rides along once they log in, which only rating needs.

## Run

Needs an instance from `../../scripts/bootstrap-instance.sh`.

```bash
npm install
synthigy exec -- npm run setup          # deploy the model + seed MovieLens-small
synthigy exec -- npm run codegen:pull   # typed client from ../xsql
synthigy exec -- npm start
```

Open <http://localhost:5174>. `npm run teardown` destroys the dataset again.

## Guided demo

On a fresh instance `/` is a guide instead of the landing page, and every other
page redirects there until it is done: **deploy** the model, **import** ~100k
ratings / 9.7k movies / 1.5k actors (progress counted live by the
`demo/progress` template in [`../xsql/movies.xsql`](../xsql/movies.xsql)),
**explore**, **destroy** to start over. `npm run setup` does the same offline.

- The buttons run as the BFF's SUPERUSER client, for anyone: local demo
  policy only.
- Jobs are single-flight and state is read from the server on every request,
  so a restart mid-import resumes, and explicit xids make re-runs no-ops.
- The dataset xid comes from the committed export, so nothing goes stale
  across a wipe.
- The real-time tour (`?tour=1`) spans the list, a detail page and the
  dashboard plus a second and an incognito window, with console and modeler
  lanes when a tool opens. It runs on driver.js over
  [`../../shared/tour.js`](../../shared/README.md).

## What each page shows

| Route | Behaviour | SDK |
|---|---|---|
| `/` | the guide, then the landing page | `Demo.progress` / `watchProgress` |
| `/movies` | paginated search; rate or edit and the row repaints | `Movie.watchList`, `Movie.list`, `Movie.count` |
| `/movies/:xid` | detail; edit title, year, cast, genres | `Movie.watchDetail`, `Movie.detail`, `Movie.sync` |
| ↳ Fields from the modeler | attributes added to Movie after codegen: shown and editable, appear live on deploy | `client.schema`, `client.get`/`sync` with a runtime selection |
| ↳ History | who changed what, from what to what; Restore a change | `client.history.events`, `history.getAt` |
| `/actors` | infinite-scroll grid | `MovieActor.list` |
| `/dashboard` | live counters + destroy | `Dashboard.watchStats` |
| footer: Let a crowd in | 15 s of simulated ratings across the first page (and the open movie) | `UserRating.stack` |

Writes answer with an empty SSE response and the watch repaints, so there is
no reload and no polling. Rate a film in one window and watch another follow —
or let the crowd in and watch every page move at once.

History needs `audit/persist` on Movie, which is what model 0.5 adds over 0.4.
Movies imported under 0.4 have no history until their first edit, and that
first change cannot know the value it replaced.

## SDK 0.2.2 workarounds

Two live paths do not work through the SDK alone today; `serve.ts` and
`lib/movie-model.ts` carry the workaround next to a comment:

- **`watchQuery()` ignores `record/update`.** It re-runs only on `entity/*` and
  `relation/*` events, so an attribute changed on its own (a title from the
  console) never repaints `Movie.watchDetail()`. The detail stream watches the
  record itself and repaints the card. `/movies` and `/actors` still have the gap.
- **`watchSchema()` never yields.** Deploy events reach the SSE, but `listen()`
  strips the SSE event name the multiplexer needs to recognise them. A deploy
  is noticed by polling the deployed version instead (one small read every 3 s).

## Codegen

`codegen:pull` is the part worth reading:

1. **Pull the schema** your client may see into `../xsql/schema.json`
   (permission-filtered, so two users can get two schemas).
2. **Compile the templates** on the server into `../xsql/ops.ir.json`, with the
   exact shape of every projection.
3. **Generate** `generated/ops.ts` and `generated/schema.ts`, type-checked
   before they are written.

None of it is committed. `npm run codegen` regenerates offline and recompiles
on the server when a template's hash changed.

## Notes

- `npm start` runs node in watch mode; run one instance.
- Changing `PORT`/`BASE_URL` in `.synthigy/.env` means re-registering the
  client's redirect URI (exact match).
- `EXAMPLES_URL`, when set, adds a link back to the examples landing page
  (`../../landing/`) to the header.
- Omitted on purpose: optimistic UI, a production session store, `id_token`
  signature verification.
- Removing an attribute in the modeler and adding one with the same name later
  fails to deploy on SQLite (`SCHEMA_CONFLICT: duplicate column name`): the
  old column stays. Use a new name.

```
serve.ts              routes, OAuth bounce, SSE streams
views/                movies, actors, layout, landing, guide
lib/auth.ts           cookie sessions (client.login does the OIDC half)
lib/seed.ts           deploy / seed / destroy, shared by scripts/ and the guide
lib/demo-state.ts     the guide's phase machine
lib/demo-jobs.ts      single-flight job registry
lib/presence.ts       "N tabs live" pill + destroy broadcast
lib/crowd.ts          the simulated crowd
lib/movie-model.ts    Movie's live shape + deploy detection
lib/movie-history.ts  audit events → "who changed what"
public/guide-tour.js  the real-time tour steps
```
