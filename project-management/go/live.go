package main

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	synthigy "github.com/synthigy/go"
	gen "github.com/synthigy/project-management-bff/gen"
)

// Notifications that cannot leak.
//
// The app learns only that something changed, then reads each person's
// projects and tasks again under their acting_as. A notification is written
// only from the difference between two such reads, so it can never mention a
// row the guards hide from them: a task in a project Bob cannot read never
// reaches Bob's re-read, and so never reaches his inbox.

// Note is one notification.
type Note struct {
	Seq     int
	Text    string
	Project string // project xid to open, when there is one
	At      time.Time
}

type inbox struct {
	mu     sync.Mutex
	hushed time.Time // no notes before this
	seq    int
	notes  map[string][]Note // person xid → newest last
	unread map[string]int
}

func newInbox() *inbox {
	return &inbox{notes: map[string][]Note{}, unread: map[string]int{}}
}

// quiet drops notes for d from now: the app's own resets are nobody's news.
func (b *inbox) quiet(d time.Duration) {
	b.mu.Lock()
	b.hushed = time.Now().Add(d)
	b.mu.Unlock()
}

// clear empties every inbox. Seq keeps counting, so open tabs never re-toast.
func (b *inbox) clear() {
	b.mu.Lock()
	b.notes, b.unread = map[string][]Note{}, map[string]int{}
	b.mu.Unlock()
}

func (b *inbox) add(who, text, project string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if time.Now().Before(b.hushed) {
		return
	}
	b.seq++
	n := append(b.notes[who], Note{Seq: b.seq, Text: text, Project: project, At: time.Now()})
	if len(n) > 30 {
		n = n[len(n)-30:]
	}
	b.notes[who] = n
	b.unread[who]++
}

// since returns who's notes newer than seq, and the newest seq overall.
func (b *inbox) since(who string, seq int) ([]Note, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Note
	for _, n := range b.notes[who] {
		if n.Seq > seq {
			out = append(out, n)
		}
	}
	return out, b.seq
}

func (b *inbox) list(who string) ([]Note, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Note(nil), b.notes[who]...), b.unread[who]
}

func (b *inbox) markRead(who string) {
	b.mu.Lock()
	b.unread[who] = 0
	b.mu.Unlock()
}

func (b *inbox) last() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.seq
}

// ref is a person as a project's role lists carry them.
type ref struct{ XID, Name string }

// roles are the people of one project, by role. The generated row has one
// type per relation; here they are one.
type roles struct {
	Owner                      *ref
	Managers, Members, Viewers []ref
}

func rolesOf(p gen.ProjectProjects) roles {
	var r roles
	if p.ProjectOwner != nil {
		r.Owner = &ref{p.ProjectOwner.Xid, s2(p.ProjectOwner.Name)}
	}
	for _, m := range p.Managers {
		r.Managers = append(r.Managers, ref{m.Xid, s2(m.Name)})
	}
	for _, m := range p.Members {
		r.Members = append(r.Members, ref{m.Xid, s2(m.Name)})
	}
	for _, m := range p.Viewers {
		r.Viewers = append(r.Viewers, ref{m.Xid, s2(m.Name)})
	}
	return r
}

func hasRef(rs []ref, x string) bool {
	for _, r := range rs {
		if r.XID == x {
			return true
		}
	}
	return false
}

// roleIn names who's role in a project, strongest first.
func roleIn(p gen.ProjectProjects, who string) string {
	r := rolesOf(p)
	switch {
	case r.Owner != nil && r.Owner.XID == who:
		return "owner"
	case hasRef(r.Managers, who):
		return "manager"
	case hasRef(r.Members, who):
		return "member"
	case hasRef(r.Viewers, who):
		return "viewer"
	}
	return ""
}

// actorName names whoever made a change, from the event's actor.
func actorName(actor string) string {
	if p := personByXID(actor); p != nil {
		return p.Name
	}
	return "Someone"
}

func taskAssignee(t gen.ProjectTasks) string {
	if t.Assignee == nil {
		return ""
	}
	return t.Assignee.Xid
}

func taskProject(t gen.ProjectTasks) string {
	if t.Project == nil {
		return ""
	}
	return t.Project.Xid
}

// watch is the app's one subscription: "a project or a task changed". The
// event says nothing else that is used here; on every one, each person's
// projects and tasks are read again AS that person, and the notifications
// come from the difference between their last two reads.
func (s *server) watch(ctx context.Context) {
	type snap struct {
		tasks    map[string]gen.ProjectTasks
		projects map[string]gen.ProjectProjects
	}
	read := func(p *Person) (snap, error) {
		b, err := gen.API.Overview(ctx, synthigy.ActingAs(p.XID))
		if err == nil {
			err = errors.Join(b.ProjectsErr, b.TasksErr)
		}
		if err != nil {
			return snap{}, err
		}
		sn := snap{map[string]gen.ProjectTasks{}, map[string]gen.ProjectProjects{}}
		for _, t := range b.Tasks {
			sn.tasks[t.Xid] = t
		}
		for _, pr := range b.Projects {
			sn.projects[pr.Xid] = pr
		}
		return sn, nil
	}
	last := map[string]snap{}
	for _, p := range cast {
		if sn, err := read(p); err == nil {
			last[p.XID] = sn
		}
	}

	// Who holds which role is a link, not a column: changing it touches the
	// relation, not the entity, so the relations are named too ("project.members"),
	// read off the schema rather than written down here.
	interest := synthigy.WatchInterest{Entities: []string{"project", "project_task"}}
	if m, err := synthigy.Schema(ctx, "project"); err == nil {
		ents, _ := m["entities"].(map[string]any)
		pr, _ := ents["project"].(map[string]any)
		rels, _ := pr["relations"].(map[string]any)
		for name := range rels {
			interest.Relations = append(interest.Relations, "project."+name)
		}
	} else {
		log.Printf("schema: %v (role changes will show on the next other change)", err)
	}

	for ctx.Err() == nil {
		w, err := synthigy.Watch(ctx, interest)
		if err != nil {
			log.Printf("watch: %v (retrying)", err)
			time.Sleep(2 * time.Second)
			continue
		}
		for ev := range w.Events() {
			// a write is several events; one re-read covers them all
			actor := ev.Actor
			for quiet := time.After(120 * time.Millisecond); ; {
				select {
				case e, ok := <-w.Events():
					if ok && e.Actor != "" {
						actor = e.Actor
					}
					continue
				case <-quiet:
				}
				break
			}
			for _, p := range cast {
				sn, err := read(p)
				if err != nil {
					log.Printf("re-read as %s: %v", p.Key, err)
					continue
				}
				if prev, ok := last[p.XID]; ok {
					s.taskNotes(p, actor, prev.tasks, sn.tasks)
					s.projectNotes(p, actor, prev.projects, sn.projects)
				}
				last[p.XID] = sn
			}
			s.hub.broadcast()
		}
		w.Close()
	}
}

// writers remembers who this BFF last wrote each record for. The SDK folds a
// burst of changes into one re-read and keeps the last event's actor, so the
// event alone cannot say who changed which row; the BFF knows for every write
// that goes through it. A change from anywhere else (the console, another
// app) falls back to the event's actor.
type writers struct {
	mu sync.Mutex
	by map[string]writer
}

type writer struct {
	xid string
	at  time.Time
}

func (w *writers) wrote(record, who string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.by == nil {
		w.by = map[string]writer{}
	}
	w.by[record] = writer{who, time.Now()}
}

func (w *writers) of(record, fallback string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if v, ok := w.by[record]; ok && time.Since(v.at) < 30*time.Second {
		return v.xid
	}
	return fallback
}

// taskNotes turns the difference between two reads of p's tasks into
// notifications. A person is not told about their own changes.
func (s *server) taskNotes(p *Person, actor string, prev, next map[string]gen.ProjectTasks) {
	note := func(t gen.ProjectTasks, text func(by string) string) {
		who := s.writers.of(t.Xid, actor)
		if who != p.XID {
			s.inbox.add(p.XID, text(actorName(who)), taskProject(t))
		}
	}
	for id, t := range next {
		before, seen := prev[id]
		mine := taskAssignee(t) == p.XID
		switch {
		case !seen && mine, seen && mine && taskAssignee(before) != p.XID:
			note(t, func(by string) string { return by + " assigned you “" + t.Title + "”" })
		case !seen:
			// a task appearing because p gained access to its project is
			// announced once, by projectNotes
		case !mine && taskAssignee(before) == p.XID:
			note(t, func(by string) string { return by + " took “" + t.Title + "” off your list" })
		case mine && s2(before.Status) != s2(t.Status):
			note(t, func(by string) string { return by + " moved your “" + t.Title + "” to " + humanize(s2(t.Status)) })
		}
	}
	for id, t := range prev {
		if _, ok := next[id]; !ok && taskAssignee(t) == p.XID {
			note(t, func(by string) string { return by + " deleted “" + t.Title + "”" })
		}
	}
}

func (s *server) projectNotes(p *Person, actor string, prev, next map[string]gen.ProjectProjects) {
	for id, pr := range next {
		who := s.writers.of(id, actor)
		if who == p.XID {
			continue
		}
		before, seen := prev[id]
		role := roleIn(pr, p.XID)
		switch {
		case !seen && role != "":
			s.inbox.add(p.XID, actorName(who)+" added you to "+s2(pr.Name)+" as "+role, id)
		case seen && role != roleIn(before, p.XID) && role != "":
			s.inbox.add(p.XID, actorName(who)+" made you "+article(role)+" of "+s2(pr.Name), id)
		}
	}
	for id, pr := range prev {
		if _, ok := next[id]; !ok && s.writers.of(id, actor) != p.XID {
			s.inbox.add(p.XID, "You no longer have access to "+s2(pr.Name), "")
		}
	}
}

func article(role string) string {
	if role == "owner" {
		return "the owner"
	}
	return "a " + role
}
