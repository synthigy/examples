# Project Management — Go + Datastar + Tyrell

A project-management app on `github.com/synthigy/go`: projects, a task board,
people and their roles, notifications. A single Go BFF holds one confidential,
trusted client and acts for whoever is picked in the header through the `/data`
`acting_as` parameter. Tyrell web components and Datastar come from a CDN, so
there is no build step.

Access control is the point of this one. Every read and write for a person
carries their `acting_as`, and the guards in the model decide what comes back
and what goes through. The app checks nothing first.

## What only this example shows

The other examples cover history and live queries (movies, music) and
membership as data (chat). Project Management is about **roles**: four of
them on one entity, reaching a second entity through a relation, and a fifth
that works from the other side.

- **Roles are relations, and each one is a guard.** Owner, managers, members
  and viewers are relations from Project to User. Project Task reaches them
  two hops away, through its project. Nothing in the app knows what a role may
  do.
- **A task without its project.** A task's assignee may read and change it
  whatever its project says. The project's own guard still hides the project:
  `->project` is a left pull, so the task comes back with its project empty.
  That is Diana's "Projects you can't open".
- **Who can do what, asked of the engine.** The overview runs the same query
  once per person. Every cell is that person's own read.
- **Notifications that cannot leak.** The app's one subscription says only
  that a project or task changed. Each person is then read again under their
  own `acting_as`, and their notifications come from the difference between
  two such reads, so they can only ever name rows that person may read.

## What it shows

| Feature | Where to see it | Where it lives |
|---|---|---|
| One client, many people (`acting_as`) | the people switcher; the `acting_as` chip | `main.go`, every call passes `synthigy.ActingAs` |
| Roles from relations | the role tags in the sidebar and the board header | `Project` relations `project_owner`, `managers`, `members`, `viewers` |
| Who can do what | "Who can do what": a matrix of reads, one per person | `renderAccess` in `view.go` |
| Writes refused by the engine | as Charlie, move Bob's task: `ROW_FORBIDDEN · iam`; as Bob, delete the project: `DELETE_FORBIDDEN · iam` | `Project Task` and `Project` write and delete guards |
| Adding is a project write | as a member, add a task: refused; as a manager: added | `add-task` in `actions.go`, `stack project {tasks}` |
| People are links | as a member, add someone to the project: refused | the same guard: only owners and managers write a project's links |
| Assignee guard | Diana: "Projects you can't open" | `Project Task` ref guard on `Assignee`; `->project` in `project.xsql` |
| Notifications under the guards | assign a task to someone, or give them a role: their bell, a toast, the tab title | `watch` and `taskNotes` / `projectNotes` in `live.go` |
| Analytics under the same guards | "Workload you can see": one SQL template, each person's own numbers | `@sql-template workload` in [`project.xsql`](../xsql/project.xsql) |
| Codegen and batching | the page's projects, tasks and workload in one request | `@batch overview`, `gen.API.Overview` |
| Typed errors | the toast shows the code and category the SDK received | `engineAnswer` in `actions.go` |
| Tools rail and tour | the "Synthigy tools" tray, bottom left: model (opens Project Management), console (with `project.xsql`), logs; "Take the tour" | `examples/shared/` |

## Tour

**Take the tour** starts as Alice in Website Relaunch, walks the overview,
then switches to Charlie to meet the refusals. It opens Bob's and Diana's
windows for the notification and viewer steps; those windows do not inherit
the tour. The steps are data in [`../tour.json`](../tour.json). If the
windows don't open, allow pop-ups for `localhost:5176`.

## Prerequisites

- A running engine: `synthigy up` — a fresh install opens the setup wizard;
  pick SQLite. Run from inside this port it still reaches the instance, not
  the port's profile.
- This port's client on it, with the id and secret
  [`.synthigy/.env`](.synthigy/.env) connects as:

  ```bash
  synthigy iam add-client "Project Management BFF" --id project-management-bff \
    --type confidential --secret pmbff-secret --grant client_credentials \
    --api Synthigy --role SUPERUSER --trusted --local
  ```

  (`../../scripts/bootstrap-instance.sh` does this for every port at once.)

  The client is trusted, so it may pass `acting_as`, and holds **SUPERUSER**,
  the demo convention (see [`../../README.md`](../../README.md), *Demo
  clients*): setup deploys the model and creates the cast. What the client
  holds does not widen what a *person* sees: every read and write for one
  carries `acting_as`, and the guards are evaluated against that identity.

## Run

```bash
synthigy exec -- go run ./setup        # deploy the model, seed the cast
synthigy exec -- go generate ./...     # produces gen/ from ../xsql, needs the server
synthigy exec -- go run .
# open http://localhost:5176
```

`./setup` comes first because the generator needs the model on the server,
and it builds without the generated code. It deploys
[`project-management@0.2.0`](../../datasets/project-management/) with the
SDK's `deploy`, then seeds [`seed.json`](../../datasets/project-management/seed.json).
It is re-runnable: a person or project already carrying one of these names is
reused, never duplicated, and tasks are seeded only into projects it created.
The server does the same on a cold start when it finds nothing.

**Reset demo data**, at the bottom of a project's panel, deletes the seeded
projects with their tasks and seeds them again.

## The codegen step

Nothing typed is committed here. The templates in
[`../xsql/project.xsql`](../xsql/project.xsql) are the only source, and
`go generate` turns them into `gen/generated.go`: it pulls the schema your
client is allowed to see, sends the templates to the server, which compiles
them and returns every operation with its parameters and result shape, and
writes the typed client. The board, the panel and the overview all read
through it, so a template that selects a field the Go code doesn't expect is
a compile error, not a blank cell.

## Configuration

Set in [`.synthigy/.env`](.synthigy/.env):

| Variable | Default | Meaning |
|---|---|---|
| `SYNTHIGY_ENDPOINT` | `http://localhost:7887` | Synthigy base URL the BFF dials |
| `SYNTHIGY_PUBLIC_ENDPOINT` | `SYNTHIGY_ENDPOINT` | Engine URL the browser's tools rail calls, when a proxy fronts both |
| `SYNTHIGY_CLIENT_ID` | `project-management-bff` | OAuth client |
| `SYNTHIGY_CLIENT_SECRET` | `pmbff-secret` | Its secret |
| `PORT` | `5176` | HTTP port |
| `EXAMPLES_URL` | unset | The examples landing page; when set, the header links back to it |

## The cast

Nothing about the seeded data is pinned in the Go code. The cast is resolved
by name at start; projects and tasks are read per person. The four people are
shared with the [chat example](../../chat/), so they are written with `stack`,
never `sync`, which would strip the links chat gives them.

## SDK 0.2.2 workaround

A live query (`Watch<Name>()`) subscribes to the records of its current rows
and to its root entity's relations, but the relation interest only filters
events locally and subscribes to nothing. While the rows last that goes
unnoticed; once a person's result is empty (Diana between a reset and her next
role) the query hears nothing again. The app therefore holds one plain
`synthigy.Watch` on the entities and on the relations of Project by name
(`project.members`, …, read off the schema) and re-reads each person itself.

The SDK also folds a burst of events into one re-read and keeps the last
event's actor, so the BFF remembers who it wrote each record for; the event's
actor is the fallback for changes made elsewhere, such as the console.

## Deliberately omitted

Per-user login. The BFF holds one trusted client and selects the acting
person from the header, which keeps the demo about access control rather than
about sessions. The movies example shows the full login flow. Notifications
live in the BFF's memory and reset when it restarts.
