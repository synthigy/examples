# Synthigy examples

Runnable examples for every Synthigy SDK, organised by **domain**. A domain owns
one model, one seed dataset and one set of `.xsql` templates; each language
directory under it is a port of the same app against the same resources.

Every example depends on a **published** SDK release, never on a path into the
Synthigy source tree, so each one also proves the released artifact works.

## Start

```bash
./scripts/bootstrap-instance.sh       # local SQLite instance + one client per demo
```

Then follow the README of the port you want; every command there is
`synthigy exec -- …` from inside the port.

## Domains

| Domain | Model + seed | js | py | go | php | clj |
|---|---|---|---|---|---|---|
| [movies](movies/) | [datasets/movies](datasets/movies/) | [js](movies/js/) | — | [go](movies/go/) | [php](movies/php/) | — |
| [chat](chat/) | [datasets/chat](datasets/chat/) | — | — | — | — | [clj](chat/clj/) |
| [music](music/) | [datasets/music](datasets/music/) | — | [py](music/py/) | — | — | — |
| [project-management](project-management/) | [datasets/project-management](datasets/project-management/) | — | — | [go](project-management/go/) | — | — |

```
datasets/<domain>/      model JSON, seed data, prep scripts
<domain>/xsql/          the .xsql templates, one copy, shared by every port
<domain>/tour.json      the guided tour scenario, shared by every port (shared/README.md)
<domain>/<lang>/        one port: BFF, views, README, pinned SDK dependency
shared/                 tools rail + guided tours, served by every demo
scripts/                instance bootstrap, dependency check, dev helpers
bench/                  benchmark harnesses (movies dataset)
```

## Scripts

| Script | What it does |
|---|---|
| `bootstrap-instance.sh [--wipe]` | Starts the instance in `.synthigy/`, adds `admin`/`admin`, every demo client and the demo origins on the tools client |
| `check-deps.sh` | Resolves every port against the published SDKs (CI runs it on push and weekly) |
| `add-tools-redirect.sh <origin>…` | Registers a demo origin on the "Synthigy Tools" client (bootstrap does 5174–5177) |
| `build-tooling.sh [--clean]` | Serves a local `@synthigy/tooling` build to every demo instead of the CDN one |
| `dev-proxy.mjs` | One port in front of a demo and the engine, for an ngrok tunnel |

## Conventions

- **Nothing generated or pulled is committed.** The `.xsql` templates are the
  only source; the schema snapshot, compiled IR and generated client are
  produced from your own server on first run. Producing them is the lesson.
- **Each port carries its own committed `.synthigy/.env`**: the endpoint and
  the demo client it connects as. The secrets are local demo values that
  `bootstrap-instance.sh` pins. Session tokens go to `.synthigy/.env.token`,
  which git ignores.
- **SDKs are pinned to a release.** To develop against unreleased SDK changes,
  use the ecosystem's own override: `go.work`, `-Sdeps` with
  `:override-deps`, `pip install -e`, `npm link`, or a composer `path`
  repository.
- **Demo clients are SUPERUSER.** A demo deploys its model, seeds a login-able
  cast and sets passwords, and `User.Password` is superuser-only. Every request
  still carries `acting_as`, so the model's guards decide what a visitor sees.
  Local/ephemeral instances only.
- **The cast is shared, and link-sets on `User` are always `stack`.**
  project-management and chat both seed alice, bob, charlie and diana (password
  `password`). `sync` replaces a link-set and would strip what the other demo
  granted; `stack` only adds.
- **The tools rail shows the `admin`/`admin` login** for Model, Console and
  Logs, since its login page is the engine's. Never do that on a shared or
  persistent instance.
