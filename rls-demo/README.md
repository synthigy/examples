# RLS Demo

**One database. Four users. Four different views of the same data.**

Row-level security declared in the model: the same queries return different
rows for alice, bob, charlie and diana, and a single deploy turns protection on
or off. Run it from [`go/`](go/).

```
rls-demo/
├── xsql/project.xsql        the queries, shared by every port
├── tour.json                the guided tour (page steps + modeler + logs)
├── go/                      Go + Datastar + Tyrell BFF (self-seeds, RLS toggle)
└── bench/                   load-test harness (pm-100k)
datasets/project-management/
├── project-management@0.1.{0,1,2}.json
├── resource-planning@0.1.0.json
├── deploy/                  the rls-off versions the toggle deploys
├── bake-rls-toggle.py       bakes deploy/ from the guarded versions
└── seed/                    users, group, projects, tasks, allocations
```

## Versions

`Project` and `Project Task` keep their xids across all three Project
Management versions, so each deploy upgrades in place.

| Version | Adds | RLS |
|---|---|---|
| `project-management@0.1.0` | Project, Project Task, `project ↔ tasks` | off: everyone sees everything |
| `project-management@0.1.1` | User stub, assignee, assignee group, owner, members | declared off: structure right, security off |
| `project-management@0.1.2` | the guard list | **on**: same data, diana suddenly sees nothing |
| `resource-planning@0.1.0` | Allocation, cross-dataset `Project Task ↔ allocations` | own allocations + allocations on your tasks |

Guards in 0.1.2:

| Entity | Guard | Operations |
|---|---|---|
| Project | `project_owner → User` | read, write, delete |
| Project | `members → User` | read |
| Project Task | `assignee` | read |
| Project Task | `assignee_group` | read, write |
| Project Task | `project → project_owner → User` (2 hops) | read, write, delete |

Worth trying: deploy 0.1.0 with Resource Planning (its guard references
`assignee`, which does not exist yet), then 0.1.1, then 0.1.2, or jump
0.1.0 → 0.1.2 on a fresh instance.
