# Project Management — dataset

`project-management@0.2.0.json` — transit-serialized dataset version (the
modeler's export format): `{:euuid :name :xid :dataset :model}`.
`seed.json` — the cast, the projects with everyone's role, and the tasks, all
by name; [`../../project-management/go/setup`](../../project-management/go/setup/)
resolves the names and writes them.

## 0.2.0: roles are relations

| Entity | Attributes | Relations |
|---|---|---|
| Project | Name (unique), Description, Active, Avatar | `project_owner` → User, `managers` ↔ User, `members` ↔ User, `viewers` ↔ User, `tasks` → Project Task |
| Project Task | Title, Description, Status (To do / In Progress / Done), Priority, Due Date, Assignee (user) | `project` → Project |

Guards:

| Entity | Guard | Operations |
|---|---|---|
| Project | `project_owner` | read, write, delete |
| Project | `managers` | read, write |
| Project | `members` | read |
| Project | `viewers` | read |
| Project Task | `project → project_owner` | read, write, delete |
| Project Task | `project → managers` | read, write, delete |
| Project Task | `Assignee` | read, write |
| Project Task | `project → members` | read |
| Project Task | `project → viewers` | read |

A new project has no owner yet, so no person may create one under these
guards: the app opens it as itself and names its owner. A task is added
through its project, which is a write on the project.

0.2.0 keeps the dataset and the Project / Project Task xids of 0.1.x. It
replaces 0.1.x's owner (one-to-one) and members (one-to-many, from User)
relations: on engine 0.3.0, User carries an `Owner` attribute of its own, and
0.1.x's `owner` label on User collided with it (`FIELD_KEY_CONFLICT`). It also
drops `Assignee Group` and the Resource Planning dataset.
