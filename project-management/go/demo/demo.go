// Package demo deploys the Project Management model and seeds its cast over
// /data with the plain SDK. It never touches the generated gen/ package, so
// `go run ./setup` works on a fresh clone before `go generate` has anything
// to pull.
package demo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	synthigy "github.com/synthigy/go"
)

// Export is the dataset version this example deploys.
const Export = "project-management@0.2.0.json"

// DatasetName is the dataset's name, as the modeler lists it.
const DatasetName = "Project Management"

// Seed is datasets/project-management/seed.json: people, projects with their
// roles, tasks. Everything refers to people and projects by name.
type Seed struct {
	Users []struct {
		Name string `json:"name"`
	} `json:"users"`
	Projects []struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Owner       string   `json:"owner"`
		Managers    []string `json:"managers"`
		Members     []string `json:"members"`
		Viewers     []string `json:"viewers"`
	} `json:"projects"`
	Tasks []struct {
		Project  string `json:"project"`
		Title    string `json:"title"`
		Status   string `json:"status"`
		Priority string `json:"priority"`
		Assignee string `json:"assignee"`
	} `json:"tasks"`
}

// datasetDir resolves datasets/project-management relative to THIS source
// file, so `go run ./setup` and the server find it from any working directory.
func datasetDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "datasets", "project-management")
}

// LoadSeed reads seed.json.
func LoadSeed() (Seed, error) {
	var s Seed
	b, err := os.ReadFile(filepath.Join(datasetDir(), "seed.json"))
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(b, &s)
}

// Deploy sends the export to the engine. The bytes travel verbatim; the server
// decodes them. Re-deploying the deployed version is a no-op.
func Deploy(ctx context.Context) (synthigy.DeployAck, error) {
	b, err := os.ReadFile(filepath.Join(datasetDir(), Export))
	if err != nil {
		return synthigy.DeployAck{}, err
	}
	return synthigy.Deploy(ctx, string(b))
}

// Deployed reports whether the model is already on the server.
func Deployed(ctx context.Context) bool {
	_, err := synthigy.Search(ctx, "project_task", synthigy.Args{"_limit": 1}, synthigy.Selection{"xid": nil})
	return err == nil
}

// byName maps name → xid for the rows of `entity` that carry one of `names`.
func byName(ctx context.Context, entity string, names []string) (map[string]string, error) {
	in := make([]any, len(names))
	for i, n := range names {
		in[i] = n
	}
	rows, err := synthigy.Search(ctx, entity, synthigy.Args{"name": map[string]any{"_in": in}},
		synthigy.Selection{"name": nil})
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, r := range rows {
		n, _ := r["name"].(string)
		x, _ := r["xid"].(string)
		out[n] = x
	}
	return out, nil
}

// Reset deletes the seeded projects and every task in them, as the service
// user, then seeds again: the demo back as setup left it.
func Reset(ctx context.Context, s Seed) error {
	names := make([]any, len(s.Projects))
	for i, p := range s.Projects {
		names[i] = p.Name
	}
	ps, err := synthigy.Search(ctx, "project", synthigy.Args{"name": synthigy.In(names...)},
		synthigy.Selection{"tasks": synthigy.Selection{"xid": nil}})
	if err != nil {
		return err
	}
	for _, p := range ps {
		ts, _ := p["tasks"].([]any)
		for _, t := range ts {
			if m, ok := t.(map[string]any); ok {
				if _, err := synthigy.Delete(ctx, "project_task", map[string]any{"xid": m["xid"]}); err != nil {
					return err
				}
			}
		}
		if _, err := synthigy.Delete(ctx, "project", map[string]any{"xid": p["xid"]}); err != nil {
			return err
		}
	}
	_, err = SeedAll(ctx, s)
	return err
}

// Result says what SeedAll did.
type Result struct {
	Users, Projects, Tasks int
	ProjectsExisted        bool
}

// SeedAll writes the cast, the projects and their tasks. Re-runnable: a user
// or project that already carries one of these names is reused, never
// duplicated (`name` is UNIQUE on both), and tasks are seeded only into
// projects this run created.
//
// The four users are SHARED with the chat example, which resolves them by
// name and links them to its rooms. `sync` replaces a link-set, so users and
// their role are written with `stack`, which only adds.
func SeedAll(ctx context.Context, s Seed) (Result, error) {
	var res Result
	names := make([]string, len(s.Users))
	for i, u := range s.Users {
		names[i] = u.Name
	}
	users, err := byName(ctx, "user", names)
	if err != nil {
		return res, err
	}
	for _, n := range names {
		if users[n] == "" {
			users[n] = synthigy.NewXID()
		}
	}
	rows := make([]map[string]any, 0, len(names))
	for _, n := range names {
		// The cast can sign in to the tools with these: `password` is the
		// demo convention (README, Demo clients).
		rows = append(rows, map[string]any{"xid": users[n], "name": n, "type": "PERSON",
			"active": true, "password": "password"})
	}
	if _, err := synthigy.StackMany(ctx, "user", rows); err != nil {
		return res, fmt.Errorf("users: %w", err)
	}
	res.Users = len(rows)

	// Internal Member is the directory-read preset every internal user gets:
	// it lets a person read the names of the people beside them. The project
	// entities need no role at all — their guards decide alone.
	roles, err := synthigy.Search(ctx, "user_role", synthigy.Args{"name": synthigy.Eq("Internal Member")},
		synthigy.Selection{"name": nil})
	if err != nil || len(roles) == 0 {
		return res, fmt.Errorf("role Internal Member: %v", err)
	}
	refs := func(ns []string) []map[string]any {
		out := make([]map[string]any, 0, len(ns))
		for _, n := range ns {
			out = append(out, map[string]any{"xid": users[n]})
		}
		return out
	}
	if _, err := synthigy.Stack(ctx, "user_role", map[string]any{"xid": roles[0]["xid"], "users": refs(names)}); err != nil {
		return res, fmt.Errorf("grant Internal Member: %w", err)
	}

	pnames := make([]string, len(s.Projects))
	for i, p := range s.Projects {
		pnames[i] = p.Name
	}
	projects, err := byName(ctx, "project", pnames)
	if err != nil {
		return res, err
	}
	res.ProjectsExisted = len(projects) == len(pnames)
	fresh := map[string]bool{}
	for _, n := range pnames {
		if projects[n] == "" {
			projects[n] = synthigy.NewXID()
			fresh[n] = true
		}
	}

	// Projects are opened by the app, as the service user: a new project has
	// no owner yet, so no guard would let a person write it. From then on the
	// guards decide whoever asks.
	prows := make([]map[string]any, 0, len(s.Projects))
	for _, p := range s.Projects {
		prows = append(prows, map[string]any{
			"xid": projects[p.Name], "name": p.Name, "description": p.Description, "active": true,
			"project_owner": map[string]any{"xid": users[p.Owner]},
			"managers":      refs(p.Managers),
			"members":       refs(p.Members),
			"viewers":       refs(p.Viewers),
		})
	}
	if _, err := synthigy.SyncMany(ctx, "project", prows); err != nil {
		return res, fmt.Errorf("projects: %w", err)
	}
	res.Projects = len(prows)

	trows := []map[string]any{}
	for _, t := range s.Tasks {
		if !fresh[t.Project] {
			continue
		}
		row := map[string]any{"xid": synthigy.NewXID(), "title": t.Title, "status": t.Status,
			"priority": t.Priority, "project": map[string]any{"xid": projects[t.Project]}}
		// `assignee` is a user-typed attribute, which the engine expands into a
		// to-one relation: write it as one.
		if t.Assignee != "" {
			row["assignee"] = map[string]any{"xid": users[t.Assignee]}
		}
		trows = append(trows, row)
	}
	if len(trows) > 0 {
		if _, err := synthigy.SyncMany(ctx, "project_task", trows); err != nil {
			return res, fmt.Errorf("tasks: %w", err)
		}
	}
	res.Tasks = len(trows)
	return res, nil
}
