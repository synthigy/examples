package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	datastar "github.com/starfederation/datastar-go/datastar"
	synthigy "github.com/synthigy/go"
	"github.com/synthigy/project-management-bff/demo"
	gen "github.com/synthigy/project-management-bff/gen"
)

// signals are the page's Datastar signals, sent with every request.
type signals struct {
	User        string `json:"user"`
	Project     string `json:"project"`
	NewTitle    string `json:"newTitle"`
	NewAssignee string `json:"newAssignee"`
	GrantUser   string `json:"grantUser"`
	GrantRole   string `json:"grantRole"`
	Desc        string `json:"desc"`
}

// answer is what the engine said to a write, as the toast shows it.
type answer struct {
	OK       bool
	Message  string
	Code     string
	Category string
}

func engineAnswer(err error, ok string) answer {
	if err == nil {
		return answer{OK: true, Message: ok}
	}
	var se *synthigy.Error
	if errors.As(err, &se) {
		return answer{Message: se.Message, Code: se.Code, Category: se.Category}
	}
	return answer{Message: err.Error()}
}

func link(xid string) []map[string]any {
	if xid == "" {
		return []map[string]any{}
	}
	return []map[string]any{{"xid": xid}}
}

// one is a to-one reference: `assignee` is a user-typed attribute, which the
// engine expands into a to-one relation. nil clears it.
func one(xid string) any {
	if xid == "" {
		return nil
	}
	return map[string]any{"xid": xid}
}

// handleAct runs one write AS the acting user and answers with a toast. The
// app checks nothing first: whether the write is allowed is the guards'
// call, and a refusal comes back typed.
func (s *server) handleAct(w http.ResponseWriter, r *http.Request) {
	var sig signals
	if err := datastar.ReadSignals(r, &sig); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	me := personByKey(sig.User)
	as := synthigy.ActingAs(me.XID)
	ctx := r.Context()
	q := r.URL.Query()
	task := q.Get("task")

	var a answer
	reset := map[string]any{}
	// who is writing which record, for the notifications this causes
	if task != "" {
		s.writers.wrote(task, me.XID)
	}
	if sig.Project != "" {
		s.writers.wrote(sig.Project, me.XID)
	}
	switch strings.TrimPrefix(r.URL.Path, "/act/") {
	case "move":
		to := q.Get("to")
		_, err := synthigy.Sync(ctx, "project_task", map[string]any{"xid": task, "status": to}, as)
		a = engineAnswer(err, "Moved to "+humanize(to)+".")
	case "assign":
		to := q.Get("to")
		_, err := synthigy.Sync(ctx, "project_task", map[string]any{"xid": task, "assignee": one(to)}, as)
		who := "nobody"
		if p := personByXID(to); p != nil {
			who = p.Name
		}
		a = engineAnswer(err, "Assigned to "+who+".")
	case "delete-task":
		ok, err := gen.API.ProjectTask.Delete(ctx, task, as)
		if err == nil && !ok {
			err = errors.New("nothing was deleted")
		}
		a = engineAnswer(err, "Task deleted.")
	case "add-task":
		// A task is added THROUGH its project: the write is on the project,
		// so the project's guard decides — owners and managers may, members
		// and viewers may not.
		title := strings.TrimSpace(sig.NewTitle)
		if title == "" {
			a = answer{Message: "A task needs a title."}
			break
		}
		t := map[string]any{"xid": synthigy.NewXID(), "title": title, "status": "ToDo", "priority": "Medium"}
		s.writers.wrote(t["xid"].(string), me.XID)
		if sig.NewAssignee != "" {
			t["assignee"] = one(sig.NewAssignee)
		}
		_, err := synthigy.Stack(ctx, "project", map[string]any{"xid": sig.Project, "tasks": []any{t}}, as)
		a = engineAnswer(err, "Task added.")
		if a.OK {
			reset["newTitle"] = ""
		}
	case "grant":
		field := roleField(sig.GrantRole)
		if field == "" || sig.GrantUser == "" {
			a = answer{Message: "Pick a person and a role."}
			break
		}
		_, err := synthigy.Stack(ctx, "project", map[string]any{"xid": sig.Project, field: link(sig.GrantUser)}, as)
		a = engineAnswer(err, personName(sig.GrantUser)+" is now "+article(sig.GrantRole)+".")
		if a.OK {
			reset["grantUser"] = ""
		}
	case "revoke":
		a = engineAnswer(s.revoke(ctx, as, sig.Project, q.Get("role"), q.Get("who")),
			personName(q.Get("who"))+" no longer has that role.")
	case "describe":
		_, err := synthigy.Sync(ctx, "project", map[string]any{"xid": sig.Project, "description": sig.Desc}, as)
		a = engineAnswer(err, "Description saved.")
	case "delete-project":
		ok, err := gen.API.Project.Delete(ctx, sig.Project, as)
		if err == nil && !ok {
			err = errors.New("nothing was deleted")
		}
		a = engineAnswer(err, "Project deleted.")
	default:
		http.NotFound(w, r)
		return
	}
	s.hub.broadcast()

	sse := datastar.NewSSE(w, r)
	sse.PatchElements(renderToast(&a))
	if len(reset) > 0 {
		sse.MarshalAndPatchSignals(reset)
	}
}

func roleField(role string) string {
	switch role {
	case "manager":
		return "managers"
	case "member":
		return "members"
	case "viewer":
		return "viewers"
	}
	return ""
}

func personName(xid string) string {
	if p := personByXID(xid); p != nil {
		return p.Name
	}
	return "That person"
}

// revoke removes one person from one role. `sync` replaces a link-set, so the
// list is read as the user, and written back without them, as the user: one
// who may not read the project, or may not change it, is refused by the
// engine either way.
func (s *server) revoke(ctx context.Context, as synthigy.Opt, project, role, who string) error {
	field := roleField(role)
	if field == "" {
		return errors.New("that role cannot be removed here")
	}
	ps, err := gen.API.Project.Projects(ctx, as)
	if err != nil {
		return err
	}
	for _, p := range ps {
		if p.Xid != project {
			continue
		}
		r := rolesOf(p)
		list := map[string][]ref{"managers": r.Managers, "members": r.Members, "viewers": r.Viewers}[field]
		keep := []map[string]any{}
		for _, x := range list {
			if x.XID != who {
				keep = append(keep, map[string]any{"xid": x.XID})
			}
		}
		_, err := synthigy.Sync(ctx, "project", map[string]any{"xid": project, field: keep}, as)
		return err
	}
	return errors.New("project not found")
}

// handleRead marks the acting user's notifications read (the bell opened).
func (s *server) handleRead(w http.ResponseWriter, r *http.Request) {
	var sig signals
	_ = datastar.ReadSignals(r, &sig)
	s.inbox.markRead(personByKey(sig.User).XID)
	s.hub.broadcast()
	w.WriteHeader(http.StatusNoContent)
}

// handleReset puts the seeded projects back as setup left them: their tasks
// and the projects themselves are deleted as the app, then seeded again.
func (s *server) handleReset(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	seed, err := demo.LoadSeed()
	if err == nil {
		// the app putting its data back is nobody's news
		s.inbox.quiet(5 * time.Second)
		err = demo.Reset(ctx, seed)
		s.inbox.quiet(5 * time.Second)
		s.inbox.clear()
	}
	if err != nil {
		log.Printf("reset: %v", err)
	}
	s.hub.broadcast()
	sse := datastar.NewSSE(w, r)
	a := engineAnswer(err, "Demo data reset to the seed.")
	sse.PatchElements(renderToast(&a))
}
