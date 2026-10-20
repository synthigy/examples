# Chat — Clojure

A live chat with rooms on `com.synthigy/sdk`, served by babashka. Each open
tab keeps three live queries — its rooms, their messages and an activity
report — all read as that tab's user and pushed as Datastar SSE patches.
Tyrell web components and Datastar come from a CDN, so there is no build step.

Row-level security is the point of this one. A single confidential client holds
the token and switches identity per request with `acting_as`. Who sees which
room, who may change it and who may edit or delete a message is decided by the
guards in the model; this app only asks.

## What only this example shows

The other examples cover roles on projects (project-management), history and live queries
(movies, music). Chat is about **people and what they may change**, and about
**notifications that respect the guards**:

- **Membership is data, and so is the right to change it.** Rooms list their
  members and administrators; the read guards walk those links, and only a
  room's administrators may change them. A refused change comes back typed.
- **Notifications that cannot leak.** Each tab subscribes to the *records* of
  the rooms its user may read, not to the whole entity, so a message elsewhere
  raises no event for it. Events carry no data; the tab re-reads as its user,
  and the notification, the unread badge and the tab title come from that
  re-read. A notification can never show a row the guards hide.

## What it shows

| Feature | Where to see it | Where it lives |
|---|---|---|
| One client, many people (`acting_as`) | the user switcher; the "engine sees" chip is `whoami` | `main.clj`, every call passes `:acting-as` |
| Rows filtered by guards | each user gets different rooms and messages from the same query | `Chat Room` / `Chat Message` read guards in the model |
| Three read guards on one entity | the chip under each room: admin, member, or "via your posts" | `Chat Room` guards |
| Writes refused by the engine | as a non-administrator, add or remove a room member: `ROW_FORBIDDEN · iam` | `Chat Room` write guard (administrators) |
| Moderation | a room's administrator can delete anyone's message there (shield icon) | `Chat Message` delete guard via room → administrators |
| Typed errors | the toast shows the code and category the SDK received | `engine-answer` in `main.clj` |
| Model constraints | open a room called Croatia: `UNIQUE_VIOLATION · conflict` | `Chat Room.Name` is unique |
| Live, RLS-correct, membership included | add Bob to a room in one tab, it appears in Bob's tab; remove him, it disappears | `watch-rooms` with the `chat_room.members` relation interest |
| Live messages, re-read as each user | a message, edit or delete reaches every tab that may read it | `watch-list` over the user's rooms, re-opened when that set changes |
| Notifications under the guards | a message in a room you are not looking at: a notification, an unread badge on the room, a count in the tab title | `on-messages!` in `main.clj`, from the tab's own re-read |
| Record-scoped subscriptions | **woke N×** in the header: post into a room and only its readers' counters move | `watch-list` with `:records` (the rooms) + `:track-rows`, `:entity-track false` |
| Analytics under the same guards | the activity panel: one SQL template, each user's own numbers, live | `@sql-template activity` in [`chat.xsql`](../xsql/chat.xsql) |
| Codegen and batching | `chat.ops.room/overview` fetches rooms and activity in one request | `@batch overview` |
| Counts in the database | members per room | `_count` in `@search rooms` |
| History | the clock on a message shows its edits; deleted messages are recovered | `/history` (`history-events`, `history-get-at`) |
| Tools rail and tour | the "Synthigy tools" tray, bottom left: model (opens Synthigy Chat), console (with `chat.xsql`), logs; "Take the tour" | `examples/shared/` |

`/history` runs as the app's client, not as the user, so the BFF first reads
the message as the user and answers only if the guards let them. The list of
recently deleted messages is the BFF's memory (it is gone after a restart);
their content comes back from `/history`, shown to whoever the message's read
guard would let in.

## Tour

**Take the tour** starts in a room that has both a member and an outsider. It
walks the features above and opens Bob's and Charlie's windows for the
notification steps; those windows do not inherit the tour. The steps are data
in [`../tour.json`](../tour.json). If the two windows don't open, allow
pop-ups for `localhost:5177`.

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
  clients*): `bb setup` deploys the model and creates the cast. What the client
  holds does not widen what a *user* sees — every read and write for a person
  carries `acting_as`, and the guards are evaluated against that identity.

## Setup / teardown

```bash
bb setup      # deploys the model, seeds the cast, rooms and a few messages
bb teardown   # destroys the dataset, then removes the users setup created
```

`setup` reads the export and `seed.json` straight off disk and calls nothing
but `search()`, `deploy()`, `stack()` and `sync()`. It is re-runnable: a user
or room already carrying one of these names is reused, never duplicated, and
messages are seeded only into rooms it opened itself.

Rooms and messages are dataset data, so `destroy` takes them with the dataset.
The cast is IAM data, which it does not: setup records the users it minted in
`.deploy.edn` and teardown removes exactly those — never a user it found there.

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

Open <http://localhost:5177>. Open `?user=alice` and `?user=bob` in two tabs,
send a message into a room both are in, and watch it arrive in both. Then, as
Alice, add Bob to Family: the room appears in Bob's tab.

## Configuration

Set in [`.synthigy/.env`](.synthigy/.env):

| Variable | Default | Meaning |
|---|---|---|
| `SYNTHIGY_ENDPOINT` | `http://localhost:7887` | Synthigy base URL the BFF dials |
| `SYNTHIGY_PUBLIC_ENDPOINT` | `SYNTHIGY_ENDPOINT` | Engine URL the browser's tools rail calls, when a proxy fronts both |
| `SYNTHIGY_CLIENT_ID` | `chat-bff` | OAuth client |
| `SYNTHIGY_CLIENT_SECRET` | `chatbff-secret` | OAuth secret |
| `PORT` | `5177` | BFF listen port |
| `EXAMPLES_URL` | unset | The examples landing page; when set, the header links back to it |

## The codegen step

`gen/` is produced from [`../xsql`](../xsql) and is not committed, because
producing it is the example. `bb gen` pulls the schema your credentials are
allowed to see, compiles the templates on the server, and writes the typed
namespaces under `chat.ops`: `chat.ops.room` (`rooms`, `activity`, their
`watch-` versions and the `overview` batch) and `chat.ops.message` (`list`,
`watch-list`).

`bb gen-check` is the matching gate, comparing what is on disk against the
templates. Both run in babashka, as does everything else here.

Writes stay plain SDK calls (`sync`, `stack`, `delete`): Clojure codegen
generates reads.

## The cast

Nothing about the seeded data is pinned in `main.clj`. The cast is every
active Internal Member who is in a room or wrote in one; rooms and messages are
read per user; the `Content` attribute xid `/history` filters on comes from
`/schema`. Point the BFF at a database seeded by `bb setup` and it resolves to
that cast.

## How rooms are opened

The app opens a room as itself and makes the person who asked its first
administrator and member. From then on only the room's administrators may
change it. A user cannot open a room alone under these guards: the write guard
reaches administrators through a relation, and a new room has none yet.

## SDK 0.2.2 workaround

With `:track-rows`, a refetch still in flight when a watch is closed puts its
interest back without a channel, and the next event then throws inside the
shared dispatch loop, so no watch in the process receives it. `close-messages!`
in `main.clj` drops the SDK's own track-rows hook before closing.

## Deliberately omitted

Per-user login. The BFF holds one trusted client and selects the acting user
from the query string, which keeps the demo about row-level security rather
than about sessions. The movies example shows the full login flow. Unread
counts live in the BFF's memory and reset when it restarts.
