# Project Management

**Projects, tasks, people and their roles, with every access rule in the model.**

Alice, Bob, Charlie and Diana share three projects. Each holds a different role
in each one (owner, manager, member, viewer, or none), and what they may read
or change follows from that alone: the model's guards decide, the app asks.
Run it from [`go/`](go/).

```
project-management/
├── xsql/project.xsql   the queries, shared by every port
├── tour.json           the guided tour (page steps + modeler + console)
└── go/                 Go + Datastar + Tyrell BFF
datasets/project-management/
├── project-management@0.2.0.json   the model, guards included
└── seed.json                       the cast, projects, roles and tasks
```

## The roles

A role is a relation from Project to User, and every relation carries a guard.

| | Project | Its tasks |
|---|---|---|
| **owner** | read, change, delete | read, change, add, delete |
| **manager** | read, change (people included) | read, change, add, delete |
| **member** | read | read; change those assigned to them |
| **viewer** | read | read |
| **assignee** | — | read and change their own task, even without access to its project |

Adding a task is a write on its project (`stack project {tasks: [...]}`), so
the project's guard decides who may add one.

## The cast

| | Website Relaunch | Mobile App | Hiring Plan |
|---|---|---|---|
| Alice | owner | member | owner |
| Bob | manager | owner | — |
| Charlie | member | member | — |
| Diana | viewer | — (one task assigned to her) | — |
