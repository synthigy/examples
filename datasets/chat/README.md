# Synthigy Chat — dataset export

`synthigy-chat@0.1.3.json` — transit-serialized dataset version (same format as
the project-management datasets): `{:euuid :name :xid :dataset :model}`.

## 0.1.3: rooms of its own

Chat no longer borrows User Group for its rooms or adds anything to the system
entities. It points at `User` and keeps every rule on its own entities:

| Entity | Read | Write | Delete |
|---|---|---|---|
| Chat Room | members, administrators, authors of a message in it | administrators | administrators |
| Chat Message | its author, the room's members, the room's administrators | its author | its author, the room's administrators |

- `Chat Room`: `Name` (unique, mandatory), `Description`; `members` and
  `administrators`, both many-to-many to `User`.
- `Chat Message` (was `Chato Message`): `Content`, `Author` (user),
  `Published On`; one `chat room`.

Earlier versions used User Group as the room and added a read guard to User
Group. The engine now takes RLS on system entities only from the Synthigy and
OAuth datasets, so that guard is refused at deploy and ignored in the model.

`synthigy-chat@0.1.2.json` is the previous version, kept for reference.

`seed.json` beside it is the cast the demo expects: four people, three rooms
with administrators and members, a handful of messages. `bb setup` in
[`../../chat/clj`](../../chat/clj/) deploys the model and seeds it; `bb
teardown` removes both. `main.clj` pins none of it and reads rooms, cast and
attribute xids from the server.
