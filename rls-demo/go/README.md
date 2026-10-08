# RLS Demo BFF — Go + Datastar + Tyrell

A live row-level-security showcase. One Synthigy database, four users, **one
query rendered four ways** — so RLS is visible at a glance. A single Go BFF
holds one confidential, trusted OAuth token and switches identity per panel via
the `/data` `acting_as` trusted parameter (no per-user login).

## What it shows

- **4-panel grid** (Alice / Bob / Charlie / Diana). Each panel runs the same
  `search` + `sql-template` under a different `acting_as`, so the server applies
  that principal's RLS. Alice sees Project Alpha + its tasks; Bob sees Beta;
  Charlie sees only the tasks assigned to him (across both projects); Diana sees
  nothing.
- **RLS-aware analytics.** The cross-cutting bar is the identical
  `SELECT count(*) FROM {project_task}` per principal — different answers because
  `sql-template` runs under the `acting_as` RLS scope. (Most BaaS leak analytics
  via a service role; here even raw SQL respects RLS.) Note the braces: guards
  attach to `{…}` placeholders, so a bare `FROM project_task` is rejected rather
  than run unguarded. Aggregating across several entities means one CTE per
  entity — a scalar subquery puts the entity in a scope the guard can't reach.
  Entity- and relation-level RBAC apply too, exactly as they do to `search`.
  What raw SQL does *not* get is attribute-level filtering: aliases are
  deterministic, so the projection can name any column of an entity the
  principal can read. Rows are RLS-filtered; columns are not.
- **Live RLS on/off toggle.** "Toggle RLS" redeploys the Project Management
  model with the RLS config stripped (off) or restored (on) and re-seeds the
  deterministic cast — watch the panels diverge and converge in real time.
- **Live writes.** "Cycle a task" advances a task's status; the change shows up
  instantly in exactly the panels whose principal can see that task. Raw `psql`
  writes propagate too (the BFF holds an upstream plug watch and
  re-fetches — notify-then-refetch, never trusting delta payloads for RLS-scoped
  lists).

## Stack

- **Synthigy Go SDK** (`github.com/synthigy/go`) — `/data` reads (`acting_as`, LEFT-join default,
  `sql-template`) + SSE watch.
- **Datastar Go SDK** (`github.com/starfederation/datastar-go`) — BFF→browser
  SSE; the BFF emits HTML, Datastar morphs the DOM.
- **Tyrell** (`tyrell-components@tc`, via CDN) — server-rendered `<ty-*>` web
  components (tags, icons, buttons, surfaces), dark theme. No build step.

## Prerequisites

- A running engine: `synthigy up` — a fresh install opens the setup wizard;
  pick SQLite. Run from inside this port it still reaches the instance, not
  the port's profile.
- This port's client on it, with the id and secret
  [`.synthigy/.env`](.synthigy/.env) connects as:

  ```bash
  synthigy iam add-client "RLS Demo BFF" --id rls-demo-bff --type confidential \
    --secret rlsbff-secret --grant client_credentials \
    --api Synthigy --role SUPERUSER --trusted --local
  ```

  (`../../scripts/bootstrap-instance.sh` does this for every port at once.)

## Run

```bash
synthigy exec -- go run ./setup        # deploy the model + seed the cast
synthigy exec -- go generate ./...     # see below: this is the interesting step
synthigy exec -- go run .
# open http://localhost:5176
```

`./setup` comes first because the generator needs the model on the server,
and it builds without the generated code. It deploys the Project Management and
Resource Planning datasets from
[`../../datasets/project-management`](../../datasets/project-management) through
the SDK's `deploy`, one call each, then seeds the four users, their role and
group, and the projects, tasks and allocations. Re-running it resets the data to
the seeded state. The four users are shared with the [chat demo](../../chat/),
so users are written with `stack`, never `sync`, which would strip the links
chat grants them.

The server also deploys and seeds on a cold start when it finds nothing, so a
server that already has the model can skip `./setup`.

## The codegen step

Nothing typed is committed here. The templates in
[`../xsql/project.xsql`](../xsql/project.xsql) are the only source, and
`go generate` turns them into `gen/generated.go`: it pulls the schema your
client is allowed to see, sends the templates to the server, which compiles
them and returns every operation with its parameters and result shape, and
writes the typed client. The panels, the analytics bar and the task rows all
read through it, so a template that selects a field the Go code doesn't expect
is a compile error, not a blank cell.

## Configuration

Set in [`.synthigy/.env`](.synthigy/.env):

| Variable | Meaning |
|---|---|
| `SYNTHIGY_ENDPOINT` | Synthigy base URL |
| `SYNTHIGY_CLIENT_ID` | OAuth client (`rls-demo-bff`) |
| `SYNTHIGY_CLIENT_SECRET` | Its secret |
| `PORT` | HTTP port, default `5176` |

`GET /?snapshot` renders the full grid server-side (no SSE) — handy for
screenshots and no-JS clients.

## Notes / known shape

- The RLS toggle redeploys over `/data` (`deploy`): the guarded dataset
  versions, or the unguarded ones baked beside them by
  [`../../datasets/project-management/bake-rls-toggle.py`](../../datasets/project-management/bake-rls-toggle.py). It
  then checks that the panels actually changed and retries, because two
  datasets define Project Task and a deploy can land before the other's rules
  are folded in.
- RLS off shows every `project` row on the server — on a shared instance that
  includes other datasets' projects, which is the point (full exposure). The
  list is capped with "+N more" while the tile shows the true SQL count.
