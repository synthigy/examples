# Chat — Clojure

A live group chat on `com.synthigy/sdk`, served by babashka. One server-side
subscription broadcasts every change as an SSE patch, and each open tab
re-fetches its own row-level-security scoped view. Tyrell web components and
Datastar come from a CDN, so there is no build step.

Row-level security is the point of this one. A single confidential client holds
the token and switches identity per request with `acting_as`, so Alice and Bob
see different messages from the same query.

## Prerequisites

- A running engine: `synthigy up` — a fresh install opens the setup wizard;
  pick SQLite. Run from inside this port it still reaches the instance, not
  the port's profile.
- This port's client on it, with the id and secret
  [`.synthigy/.env`](.synthigy/.env) connects as:

  ```bash
  synthigy iam add-client "chat-bff" --id chat-bff --type confidential \
    --secret chatbff-secret --grant client_credentials \
    --api Synthigy --role SUPERUSER --trusted --local
  ```

  (`../../scripts/bootstrap-instance.sh` does this for every port at once.)

  The client is trusted, so it may pass `acting_as`, and holds **SUPERUSER** —
  the demo convention (see [`../../README.md`](../../README.md), *Demo
  clients*): `bb setup` deploys the model, creates the cast, grants it a role,
  and the cast must be able to log in, and `User.Password` is superuser-only by
  design. What the client holds does not widen what a *user* sees — every read
  and write in the demo carries `acting_as`, and RLS is evaluated against that
  identity.

## Setup / teardown

```bash
bb setup      # deploys the model, seeds rooms, cast and a few messages
bb teardown   # destroys the dataset, then removes the cast setup created
```

`setup` reads the export and `seed.json` straight off disk and calls nothing
but `deploy()` and `sync()`. It is re-runnable: a group or user already
carrying one of these names is reused, never duplicated. The cast is IAM data,
which `destroy` does not reclaim, so setup records what it minted in
`.deploy.edn` and teardown removes exactly that — never a row it found there.

Each seeded message is written **as its author**, because the model's write
guard is `author = current user`. Seeding them as the service user fails
`ROW_FORBIDDEN`, which is the guard doing its job.

## Run

```bash
synthigy exec -- bb setup    # deploy + seed, from scratch
synthigy exec -- bb gen      # produces gen/ from ../xsql, needs the server
synthigy exec -- bb serve
```

`synthigy exec` finds [`.synthigy/.env`](.synthigy/.env) and gives the BFF the
endpoint and client it names.

Open <http://localhost:5177>. Add `?user=alice` and `?user=bob` in two tabs,
send a message to a shared group, and watch it arrive in both.

## Configuration

Set in [`.synthigy/.env`](.synthigy/.env):

| Variable | Default | Meaning |
|---|---|---|
| `SYNTHIGY_ENDPOINT` | `http://localhost:7887` | Synthigy base URL |
| `SYNTHIGY_CLIENT_ID` | `chat-bff` | OAuth client |
| `SYNTHIGY_CLIENT_SECRET` | `chatbff-secret` | OAuth secret |
| `PORT` | `5177` | BFF listen port |

## The codegen step

`gen/` is produced from [`../xsql`](../xsql) and is not committed, because
producing it is the example. `bb gen` pulls the schema your credentials are
allowed to see, compiles the templates on the server, and writes the typed
namespaces under `chat.ops`.

`bb gen-check` is the matching gate, comparing what is on disk against the
templates. Both run in babashka, as does everything else here.

## The cast

Nothing about the seeded data is pinned in `main.clj`. At boot it reads the
rooms (active `ACCESS` user groups), the cast (active `PERSON` users belonging
to one) and the `Content` attribute xid `/history` filters on (from `/schema`).
Message authors arrive projected through `->author`, so no id ever appears as
a literal. Point the BFF at a database seeded by `bb setup` and it resolves to
that cast; point it at another instance and it shows that directory instead.

## Deliberately omitted

Per-user login. The BFF holds one trusted client and selects the acting user
from the query string, which keeps the demo about row-level security rather
than about sessions. The movies example shows the full login flow.
