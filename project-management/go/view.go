package main

import (
	"context"
	"encoding/json"
	"html"
	"net/url"
	"strings"

	synthigy "github.com/synthigy/go"
	gen "github.com/synthigy/project-management-bff/gen"
)

// ---- small helpers -------------------------------------------------------

func s2(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func esc(s string) string { return html.EscapeString(s) }

func js(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// attr escapes a JS expression for a double-quoted HTML attribute.
func attr(s string) string { return html.EscapeString(s) }

func humanize(s string) string {
	switch s {
	case "":
		return "—"
	case "ToDo":
		return "To do"
	case "LOW":
		return "Low"
	}
	return strings.ReplaceAll(s, "_", " ")
}

var statuses = []string{"ToDo", "In_Progress", "Done"}

func statusFlavor(s string) string {
	switch s {
	case "Done":
		return "success"
	case "In_Progress":
		return "warning"
	}
	return "neutral"
}

func priorityFlavor(p string) string {
	switch p {
	case "Critical":
		return "danger"
	case "High":
		return "warning"
	}
	return "neutral"
}

var roleFlavor = map[string]string{"owner": "primary", "manager": "success", "member": "warning", "viewer": "neutral", "assignee": "secondary"}

// What each role may do, read off the guards in project-management@0.2.0.
var roleCan = map[string][]string{
	"owner":    {"read the project and every task", "change the project, its people and its tasks", "add, assign and delete tasks", "delete the project"},
	"manager":  {"read the project and every task", "change the project, its people and its tasks", "add, assign and delete tasks"},
	"member":   {"read the project and every task", "change the tasks assigned to them"},
	"viewer":   {"read the project and every task"},
	"assignee": {"read and change a task assigned to them, even without access to its project"},
}

var roleCannot = map[string][]string{
	"owner":   {},
	"manager": {"delete the project"},
	"member":  {"add or delete tasks", "change anyone else's task", "change the project or its people"},
	"viewer":  {"change anything"},
}

// icons — lucide SVGs slotted into <ty-icon>.
var icons = map[string]string{
	"kanban":  `<path d="M6 5v11"/><path d="M12 5v6"/><path d="M18 5v14"/>`,
	"back":    `<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`,
	"bell":    `<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>`,
	"folder":  `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
	"lock":    `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
	"grid":    `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>`,
	"left":    `<path d="m15 18-6-6 6-6"/>`,
	"right":   `<path d="m9 18 6-6-6-6"/>`,
	"trash":   `<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`,
	"x":       `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
	"plus":    `<path d="M5 12h14"/><path d="M12 5v14"/>`,
	"check":   `<path d="M20 6 9 17l-5-5"/>`,
	"ban":     `<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
	"chart":   `<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16h8"/><path d="M7 11h12"/><path d="M7 6h3"/>`,
	"users":   `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
	"compass": `<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>`,
	"rotate":  `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`,
	"save":    `<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>`,
}

func icon(name, attrs string) string {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` + icons[name] + `</svg>`
	return `<ty-icon ` + attrs + `>` + svg + `</ty-icon>`
}

func avatar(p *Person, size string) string {
	if p == nil {
		return `<span class="avatar ` + size + ` ty-bg-neutral ty-text-neutral++">?</span>`
	}
	return `<span class="avatar ` + size + ` ty-bg-` + p.Flavor + ` ty-text-` + p.Flavor + `++" title="` + esc(p.Name) + `">` + esc(p.Name[:1]) + `</span>`
}

func roleTag(role string) string {
	if role == "" {
		return ""
	}
	return `<span class="inline-flex"><ty-tag size="xs" flavor="` + roleFlavor[role] + `">` + esc(role) + `</ty-tag></span>`
}

// displayName is the cast's name for a seeded user (stored lowercase).
func displayName(xid, fallback string) string {
	if p := personByXID(xid); p != nil {
		return p.Name
	}
	return fallback
}

// ---- data ----------------------------------------------------------------

// view is everything one person's page shows, read as that person.
type view struct {
	Me       *Person
	Project  string // the open project's xid, "access" or "outside"
	Projects []gen.ProjectProjects
	Tasks    []gen.ProjectTasks
	Workload []gen.ProjectWorkload
	Err      string
}

func (s *server) read(ctx context.Context, me *Person, project string) view {
	v := view{Me: me, Project: project}
	// One request: the projects, the tasks and the workload, all under the
	// same acting_as, so all three agree on what this person may see.
	b, err := gen.API.Overview(ctx, synthigy.ActingAs(me.XID))
	if err != nil {
		v.Err = err.Error()
		return v
	}
	v.Projects, v.Tasks, v.Workload = b.Projects, b.Tasks, b.Workload
	for _, e := range []error{b.ProjectsErr, b.TasksErr, b.WorkloadErr} {
		if e != nil {
			v.Err = e.Error()
		}
	}
	if v.Project == "" || (v.Project != "access" && v.Project != "outside" && v.project() == nil) {
		// open the busiest project: the one with the most people in it
		most := -1
		v.Project = "access"
		for _, p := range v.Projects {
			r := rolesOf(p)
			if n := len(r.Managers) + len(r.Members) + len(r.Viewers); n > most {
				v.Project, most = p.Xid, n
			}
		}
	}
	return v
}

func (v view) project() *gen.ProjectProjects {
	for i := range v.Projects {
		if v.Projects[i].Xid == v.Project {
			return &v.Projects[i]
		}
	}
	return nil
}

// outside are the tasks this person reads through their assignee alone: the
// project's guard hides the project, so `->project` comes back empty.
func (v view) outside() []gen.ProjectTasks {
	var out []gen.ProjectTasks
	for _, t := range v.Tasks {
		if t.Project == nil {
			out = append(out, t)
		}
	}
	return out
}

func (v view) tasksOf(project string) []gen.ProjectTasks {
	var out []gen.ProjectTasks
	for _, t := range v.Tasks {
		if taskProject(t) == project {
			out = append(out, t)
		}
	}
	return out
}

func openCount(ts []gen.ProjectTasks) int {
	n := 0
	for _, t := range ts {
		if s2(t.Status) != "Done" {
			n++
		}
	}
	return n
}

func (s *server) tourProject(ctx context.Context) string {
	ps, err := synthigy.Search(ctx, "project", synthigy.Args{"name": synthigy.Eq("Website Relaunch")},
		synthigy.Selection{"name": nil})
	if err != nil || len(ps) == 0 {
		return ""
	}
	x, _ := ps[0]["xid"].(string)
	return x
}

func pageURL(user, project string, extra ...string) string {
	q := url.Values{"user": {user}}
	if project != "" {
		q.Set("project", project)
	}
	for i := 0; i+1 < len(extra); i += 2 {
		q.Set(extra[i], extra[i+1])
	}
	return "/?" + q.Encode()
}
