# Synthigy Chat — dataset export

`synthigy-chat@0.1.2.json` — transit-serialized dataset version (same format as
the rls-demo datasets): `{:euuid :name :xid :dataset :model}`.

Version 0.1.2 is the first with the **correct RLS write guard** — the
`author = current user` `:ref` condition points at the live Author attribute
(0.1.1 shipped with a dangling reference that fail-closed all edits).

`seed.json` beside it is the cast the demo expects: three rooms, four people,
a handful of messages. `bb setup` in [`../../chat/clj`](../../chat/clj/)
deploys the model and seeds the cast; `bb teardown` removes both. `main.clj`
pins none of it and reads rooms, cast and attribute xids from the server at
boot.
