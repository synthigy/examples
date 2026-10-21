package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	datastar "github.com/starfederation/datastar-go/datastar"
	synthigy "github.com/synthigy/go"
	gen "github.com/synthigy/project-management-bff/gen"
)

// The page wears the examples' shared look: examples/shared/theme.css and
// chrome.js (the topbar, the footer with the tools dock, the tokens) on the
// Tyrell version every example pins. Only what is this app's own is styled
// here.

const (
	tyrell    = "1.0.0-TC55"
	datastar_ = "v1.0.2"
)

const ownCSS = `
.card-mine { border-left: 3px solid var(--ty-color-primary); }
.nav-link { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; font-size: 0.88rem; }
.nav-link .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { background: none; border: 0; padding: 2px; cursor: pointer; color: var(--ty-text-faint); border-radius: 5px; display: inline-flex; }
.icon-btn:hover { color: var(--ty-text); background: var(--ty-surface-floating); }
.icon-btn.danger:hover { color: var(--ty-color-danger); }
.bar { height: 6px; border-radius: 999px; background: var(--ty-surface-elevated); border: 1px solid var(--ty-border); overflow: hidden; display: flex; }
.bar > span { height: 100%; }
table.matrix { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
table.matrix th { text-align: left; padding: 10px 16px; }
table.matrix td { padding: 10px 16px; border-top: 1px solid var(--ty-border-soft); }
table.matrix tr.me td { background: var(--ty-bg-primary-soft); }
`

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	me := personByKey(q.Get("user"))
	peer := q.Has("peer")
	v := s.read(r.Context(), me, q.Get("project"))
	tour := s.tourProject(r.Context())

	sig := map[string]any{"user": me.Key, "project": v.Project, "newTitle": "", "newAssignee": "",
		"grantUser": "", "grantRole": "member", "desc": "", "bell": false}

	var b strings.Builder
	b.WriteString(`<!doctype html>
<html lang="en" class="dark" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + esc(title(s.inbox, me)) + `</title>`)
	if peer {
		// A window the tour opened as someone else starts with a copy of the
		// opener's sessionStorage: drop it, or the tour would resume in here.
		b.WriteString(`<script>try{sessionStorage.clear()}catch(e){}</script>`)
	}
	b.WriteString(`
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@` + tyrell + `/css/tyrell.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@` + tyrell + `/css/tyrell-theme.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/tyrell-components@` + tyrell + `/dist/tyrell.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@` + datastar_ + `/bundles/datastar.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { corePlugins: { preflight: false } }</script>
<link rel="stylesheet" href="/theme.css">
<style>` + ownCSS + `</style>
</head>
<body class="ty-canvas" data-signals="` + attr(js(sig)) + `">
<header class="topbar flex items-center px-6 py-3 gap-6 shrink-0">`)
	if s.examplesURL != "" {
		b.WriteString(`<a class="back-link flex items-center gap-1" href="` + esc(s.examplesURL) + `" data-tour="examples">` +
			icon("back", `size="xs"`) + `examples</a>`)
	}
	b.WriteString(`<a class="brand flex items-center gap-2 shrink-0 font-semibold text-[1.02rem] tracking-[-0.01em]" href="/?user=` + me.Key + `">` +
		icon("kanban", `size="md"`) + `<span>projects</span></a>`)
	b.WriteString(renderCast(me))
	b.WriteString(renderWhoami(me))
	b.WriteString(s.renderBell(me))
	if !peer {
		b.WriteString(`<ty-button size="sm" flavor="success" data-tour="topbar-tour" onclick="location.href='` +
			pageURL("alice", tour, "tour", "1") + `'">` + icon("compass", `slot="start" size="sm"`) + `Take the tour</ty-button>`)
	}
	b.WriteString(`</header>`)

	// data-init opens the live stream; navigation reopens it.
	b.WriteString(`<div class="page-fill" data-init="` + attr(openStream) + `"
  data-on:pm-nav__window="` + attr(`$user = evt.detail.user || $user; $project = evt.detail.project || ''; `+openStream) + `"
  data-on:popstate__window="` + attr(`$user = new URLSearchParams(location.search).get('user') || $user; $project = new URLSearchParams(location.search).get('project') || ''; `+openStream) + `">`)
	b.WriteString(`<aside class="w-72 shrink-0 divider-r overflow-y-auto">` + renderSidebar(v) + `</aside>`)
	b.WriteString(s.renderMain(r.Context(), v))
	b.WriteString(`</div>`)

	b.WriteString(`<footer class="px-6 py-3 text-[0.8em] shrink-0 flex flex-wrap items-center gap-3 justify-between">
  <div class="flex flex-wrap items-center gap-2">
    <div id="footer-tools" class="flex flex-wrap items-center gap-2"></div>
    <ty-button size="sm" flavor="neutral" appearance="outlined" data-on:click="` + attr(`confirm('Put every seeded project back as setup left it?') && @post('/reset')`) + `">` +
		icon("rotate", `slot="start" size="sm"`) + `Reset demo data</ty-button>
  </div>
  <span class="footer-credit">one client, <code>acting_as</code> per person · the guards decide · components by tyrell, reactivity by datastar</span>
</footer>`)
	b.WriteString(renderToast(nil))
	b.WriteString(`<div id="notifications" class="toast-stack bottom"></div>`)

	bundle := ""
	if localToolingBundle() {
		bundle = `, bundle: "/vendor/tooling/tooling.js", bundleCss: "/vendor/tooling/tooling.css"`
	}
	peers := map[string]string{
		"bob":   pageURL("bob", tour, "peer", "1"),
		"diana": pageURL("diana", tour, "peer", "1"),
	}
	// endpoint is the engine's own address: the rail's components call it
	// directly, not this BFF (examples/shared/README.md).
	b.WriteString(`<script>
window.SYNTHIGY_TOOLS = { endpoint: ` + js(s.endpoint) + `, xsql: ["/xsql/project.xsql"], dataset: "Project Management"` + bundle + ` };
window.SYNTHIGY_TOUR = "/tour.json";
window.PM_PEERS = ` + js(peers) + `;
function pmNav(user, project) {
  var q = new URLSearchParams(location.search);
  if (user) q.set('user', user);
  if (project) q.set('project', project); else q.delete('project');
  q.delete('tour'); q.delete('peer');
  history.pushState(null, '', '/?' + q.toString());
  window.dispatchEvent(new CustomEvent('pm-nav', {detail: {user: user, project: project}}));
}
function pmOpen(who, left) { var u = window.PM_PEERS[who];
  if (u) window.open(u, 'pm-' + who, 'popup,noopener,width=1180,height=820,left=' + left + ',top=60'); }
window.PM_TOUR_ACTIONS = {
  'as-charlie': function () { pmNav('charlie', ` + js(tour) + `) },
  'open-bob':   function () { pmOpen('bob', 40) },
  'open-diana': function () { pmOpen('diana', 640) },
  'open-access': function () { pmNav(null, 'access') }
};
</script>
<script src="/tools-rail.js"></script>
<script src="/chrome.js"></script>
<script src="/scenario.js"></script>
<script>window.SynthigyScenario && SynthigyScenario.register({actions: window.PM_TOUR_ACTIONS});</script>
</body></html>`)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(b.String()))
}

func title(b *inbox, me *Person) string {
	_, unread := b.list(me.XID)
	t := "projects · " + me.Name
	if unread > 0 {
		t = fmt.Sprintf("(%d) %s", unread, t)
	}
	return t
}

// open-stream retries ~forever with capped backoff, so a BFF restart doesn't
// leave the tab deaf. One URL on purpose: Datastar cancels the previous
// request by method+URL, so user and project travel as signals.
const openStream = `@get('/stream', {filterSignals: {include: /^(user|project)$/}, openWhenHidden: true, retryMaxCount: 1000000, retryMaxWait: 10000})`

// ---- live stream ---------------------------------------------------------

// handleStream is the tab's live connection. It paints the tab's user and
// project, then repaints whenever anything changes, reading again as that
// user: the hub says only "something changed".
func (s *server) handleStream(w http.ResponseWriter, r *http.Request) {
	var sig signals
	if err := datastar.ReadSignals(r, &sig); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	me := personByKey(sig.User)
	ctx := r.Context()
	sse := datastar.NewSSE(w, r)
	notify := s.hub.subscribe()
	defer s.hub.unsubscribe(notify)

	seen := s.inbox.last() // toasts only for what arrives from now on
	project := sig.Project
	paint := func() error {
		v := s.read(ctx, me, project)
		if v.Project != project {
			project = v.Project
			sse.MarshalAndPatchSignals(map[string]any{"project": project})
		}
		if err := sse.PatchElements(renderCast(me) + renderWhoami(me) + s.renderBell(me) +
			renderSidebar(v) + s.renderMain(ctx, v)); err != nil {
			return err
		}
		notes, last := s.inbox.since(me.XID, seen)
		seen = last
		if len(notes) > 0 {
			var nb strings.Builder
			for _, n := range notes {
				nb.WriteString(renderNotify(n, me))
			}
			sse.PatchElements(nb.String(), datastar.WithSelectorID("notifications"), datastar.WithModeAppend())
		}
		return sse.ExecuteScript("document.title = " + js(title(s.inbox, me)))
	}
	if err := paint(); err != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-notify:
			// coalesce a burst into one re-read
			time.Sleep(80 * time.Millisecond)
			select {
			case <-notify:
			default:
			}
			if err := paint(); err != nil {
				log.Printf("stream %s: %v", me.Key, err)
				return
			}
		case <-heartbeat.C:
			if sse.IsClosed() {
				return
			}
		}
	}
}

// ---- topbar --------------------------------------------------------------

// renderCast is the topbar's nav: one link per person, the acting one current.
func renderCast(me *Person) string {
	var b strings.Builder
	b.WriteString(`<nav id="cast" class="flex gap-0.5 flex-1 ml-2" data-tour="cast">`)
	for _, p := range cast {
		cur := ""
		if p == me {
			cur = ` aria-current="page"`
		}
		b.WriteString(`<a class="nav-link"` + cur + ` href="` + pageURL(p.Key, "") + `" data-on:click="` +
			attr(`evt.preventDefault(); pmNav(`+js(p.Key)+`, null)`) + `">` + avatar(p, "sm") + esc(p.Name) + `</a>`)
	}
	b.WriteString(`</nav>`)
	return b.String()
}

func renderWhoami(me *Person) string {
	return `<span id="whoami" class="pill" data-tour="whoami" title="Every read and write for this person carries acting_as">` +
		`<span class="live-dot"></span>acting_as ` + esc(me.XID[:6]) + `…</span>`
}

func (s *server) renderBell(me *Person) string {
	notes, unread := s.inbox.list(me.XID)
	var b strings.Builder
	b.WriteString(`<div id="bell" class="relative" data-tour="bell">`)
	flavor := "neutral"
	if unread > 0 {
		flavor = "primary"
	}
	b.WriteString(`<ty-button size="sm" flavor="` + flavor + `" appearance="outlined" title="Notifications" data-on:click="` +
		attr(`$bell = !$bell; $bell && @post('/notifications/read', {filterSignals: {include: /^user$/}})`) + `">` +
		icon("bell", `slot="start" size="sm"`) + fmt.Sprintf(`%d`, unread) + `</ty-button>`)
	b.WriteString(`<div class="absolute right-0 top-10 z-50 w-80 surface rounded-xl p-4 flex flex-col gap-2" style="display:none;box-shadow:0 20px 50px -14px rgba(0,0,0,.6)" data-show="$bell">
  <div class="flex items-center"><span class="section-title flex-1">Notifications</span>
  <button class="icon-btn" data-on:click="$bell = false">` + icon("x", `size="xs"`) + `</button></div>`)
	if len(notes) == 0 {
		b.WriteString(`<p class="hint">Nothing yet. They come from reading again what you may see, so they only ever name rows you can read.</p>`)
	}
	for i := len(notes) - 1; i >= 0; i-- {
		n := notes[i]
		b.WriteString(`<div class="divider-t pt-2 text-[0.86rem]">` + noteLink(n, me) + `<div class="faint mono text-[0.72rem]">` + n.At.Format("15:04:05") + `</div></div>`)
	}
	b.WriteString(`</div></div>`)
	return b.String()
}

func noteLink(n Note, me *Person) string {
	if n.Project == "" {
		return `<span>` + esc(n.Text) + `</span>`
	}
	return `<a href="` + pageURL(me.Key, n.Project) + `" data-on:click="` +
		attr(`evt.preventDefault(); $bell = false; pmNav(null, `+js(n.Project)+`)`) + `">` + esc(n.Text) + `</a>`
}

func renderNotify(n Note, me *Person) string {
	return fmt.Sprintf(`<div id="note-%d" class="toast" data-init="setTimeout(() => el.remove(), 7000)">`, n.Seq) +
		icon("bell", `size="sm" class="ty-text-primary"`) + `<div class="flex-1">` + noteLink(n, me) + `</div>` +
		`<button class="toast-close" data-on:click="el.parentElement.remove()">` + icon("x", `size="xs"`) + `</button></div>`
}

// renderToast carries the engine's answer to a write, refusals included.
func renderToast(a *answer) string {
	if a == nil {
		return `<div id="toast" class="toast-stack top"></div>`
	}
	cls, ic, color := "toast ok", "check", "ty-text-success"
	if !a.OK {
		cls, ic, color = "toast err", "ban", "ty-text-danger"
	}
	code := ""
	if a.Code != "" {
		code = `<div class="toast-code">` + esc(a.Code)
		if a.Category != "" {
			code += ` · ` + esc(a.Category)
		}
		code += `</div>`
	}
	return `<div id="toast" class="toast-stack top"><div class="` + cls + `" data-init="setTimeout(() => el.remove(), 6000)">` +
		icon(ic, `size="sm" class="`+color+`"`) + `<div class="flex-1"><div>` + esc(a.Message) + `</div>` + code + `</div>` +
		`<button class="toast-close" data-on:click="el.parentElement.remove()">` + icon("x", `size="xs"`) + `</button></div></div>`
}

// ---- sidebar -------------------------------------------------------------

func navItem(v view, target, label, ic, right, tour string) string {
	cur := ""
	if v.Project == target {
		cur = ` aria-current="page"`
	}
	t := ""
	if tour != "" {
		t = ` data-tour="` + tour + `"`
	}
	return `<a class="nav-link"` + cur + t + ` href="` + pageURL(v.Me.Key, target) + `" data-on:click="` +
		attr(`evt.preventDefault(); pmNav(null, `+js(target)+`)`) + `">` + icon(ic, `size="sm"`) +
		`<span class="grow">` + esc(label) + `</span>` + right + `</a>`
}

func renderSidebar(v view) string {
	var b strings.Builder
	b.WriteString(`<nav id="sidebar" class="p-4 flex flex-col gap-1">`)
	b.WriteString(`<div class="section-title px-2 pb-1">Overview</div>`)
	b.WriteString(navItem(v, "access", "Who can do what", "grid", "", "access"))
	b.WriteString(`<div class="section-title px-2 pt-5 pb-1">Your projects</div><div data-tour="projects" class="flex flex-col gap-1">`)
	if len(v.Projects) == 0 {
		b.WriteString(`<div class="px-2 hint">No project's guard lets you in.</div>`)
	}
	for _, p := range v.Projects {
		right := roleTag(roleIn(p, v.Me.XID)) + fmt.Sprintf(`<span class="section-count">%d</span>`, openCount(v.tasksOf(p.Xid)))
		b.WriteString(navItem(v, p.Xid, s2(p.Name), "folder", right, ""))
	}
	b.WriteString(`</div>`)
	if out := v.outside(); len(out) > 0 {
		b.WriteString(`<div class="section-title px-2 pt-5 pb-1">Assigned to you elsewhere</div>`)
		b.WriteString(navItem(v, "outside", "Projects you can't open", "lock",
			fmt.Sprintf(`<span class="section-count">%d</span>`, len(out)), "outside"))
	}
	b.WriteString(`</nav>`)
	return b.String()
}

// ---- main ----------------------------------------------------------------

func (s *server) renderMain(ctx context.Context, v view) string {
	var b strings.Builder
	b.WriteString(`<div id="main" class="flex-1 flex min-h-0 min-w-0">`)
	if v.Err != "" {
		b.WriteString(`<div class="p-6 ty-text-danger">` + esc(v.Err) + `</div>`)
	}
	switch v.Project {
	case "access":
		b.WriteString(s.renderAccess(ctx, v))
	case "outside":
		b.WriteString(renderOutside(v))
	default:
		if p := v.project(); p != nil {
			b.WriteString(renderBoard(v, *p))
			b.WriteString(renderPanel(v, *p))
		}
	}
	b.WriteString(`</div>`)
	return b.String()
}

func pageHead(title, sub string) string {
	return `<div class="flex flex-col gap-1.5"><h1 class="text-[1.5rem] font-semibold tracking-[-0.02em]">` + title + `</h1>` +
		`<p class="hint max-w-3xl">` + sub + `</p></div>`
}

// renderAccess asks the engine, once per person, which projects and tasks
// they may read. Every cell is that person's own read: the app computes no
// permission of its own.
func (s *server) renderAccess(ctx context.Context, v view) string {
	type row struct {
		P     *Person
		Roles map[string]string // project name → role
		Tasks int
		Mine  int
	}
	var rows []row
	names := map[string]bool{}
	for _, p := range cast {
		b, err := gen.API.Overview(ctx, synthigy.ActingAs(p.XID))
		r := row{P: p, Roles: map[string]string{}}
		if err == nil {
			for _, pr := range b.Projects {
				r.Roles[s2(pr.Name)] = roleIn(pr, p.XID)
				names[s2(pr.Name)] = true
			}
			r.Tasks = len(b.Tasks)
			for _, t := range b.Tasks {
				if taskAssignee(t) == p.XID {
					r.Mine++
				}
			}
		}
		rows = append(rows, r)
	}
	var cols []string
	for n := range names {
		cols = append(cols, n)
	}
	sort.Strings(cols)

	var b strings.Builder
	b.WriteString(`<main class="flex-1 overflow-y-auto px-8 pt-8 pb-16 flex flex-col gap-6">`)
	b.WriteString(pageHead("Who can do what", `Each row is that person's own read of the same query, through the same client, under their <code>acting_as</code>. A dash is a project whose guards let them nowhere near it: for them it does not exist.`))
	b.WriteString(`<div class="surface rounded-xl overflow-x-auto shrink-0" data-tour="matrix"><table class="matrix"><thead><tr><th class="section-title">Person</th>`)
	for _, c := range cols {
		b.WriteString(`<th class="section-title">` + esc(c) + `</th>`)
	}
	b.WriteString(`<th class="section-title text-right">Tasks they read</th><th class="section-title text-right">Assigned to them</th></tr></thead><tbody>`)
	for _, r := range rows {
		cls := ""
		if r.P == v.Me {
			cls = ` class="me"`
		}
		b.WriteString(`<tr` + cls + `><td><span class="flex items-center gap-2">` + avatar(r.P, "sm") + esc(r.P.Name) + `</span></td>`)
		for _, c := range cols {
			cell := `<span class="faint">—</span>`
			if role, ok := r.Roles[c]; ok {
				cell = roleTag(role)
			}
			b.WriteString(`<td>` + cell + `</td>`)
		}
		b.WriteString(fmt.Sprintf(`<td class="mono text-right">%d</td><td class="mono text-right">%d</td></tr>`, r.Tasks, r.Mine))
	}
	b.WriteString(`</tbody></table></div>`)

	b.WriteString(`<div class="grid gap-4" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))" data-tour="legend">`)
	for _, role := range []string{"owner", "manager", "member", "viewer", "assignee"} {
		b.WriteString(`<div class="surface rounded-xl p-4 flex flex-col gap-2"><div>` + roleTag(role) + `</div>` + canList(role) + `</div>`)
	}
	b.WriteString(`</div>`)
	b.WriteString(`<p class="hint">The cards are the guards on Project and Project Task in plain words. Open the model from the tools in the footer to see them as they are deployed.</p>`)
	b.WriteString(`</main>`)
	return b.String()
}

func canList(role string) string {
	var b strings.Builder
	for _, c := range roleCan[role] {
		b.WriteString(`<div class="flex gap-2 text-[0.86rem]">` + icon("check", `size="xs" class="ty-text-success mt-1"`) + esc(c) + `</div>`)
	}
	for _, c := range roleCannot[role] {
		b.WriteString(`<div class="flex gap-2 text-[0.86rem] faint">` + icon("ban", `size="xs" class="ty-text-danger mt-1"`) + esc(c) + `</div>`)
	}
	return b.String()
}

func renderOutside(v view) string {
	var b strings.Builder
	b.WriteString(`<main class="flex-1 overflow-y-auto px-8 pt-8 pb-16 flex flex-col gap-6">`)
	b.WriteString(pageHead("Assigned to you, in projects you can't open", `Project Task has a guard on its assignee: you may read and change a task assigned to you whatever its project says. The project's own guard still hides the project, so the query's left pull <code>-&gt;project</code> comes back empty.`))
	b.WriteString(`<div class="flex flex-col gap-2 max-w-xl" data-tour="outside-tasks">`)
	for _, t := range v.outside() {
		b.WriteString(renderCard(v, t))
	}
	b.WriteString(`</div></main>`)
	return b.String()
}

// personSelect is a ty-select of the cast; on change it runs onChange with
// the picked xid in `evt.detail.value`.
func personSelect(value, placeholder, onChange, extra string) string {
	var b strings.Builder
	b.WriteString(`<ty-select size="sm" placeholder="` + esc(placeholder) + `" value="` + esc(value) + `" ` + extra +
		` data-on:change="` + attr(onChange) + `"><ty-option value="">Unassigned</ty-option>`)
	for _, c := range cast {
		b.WriteString(`<ty-option value="` + c.XID + `">` + esc(c.Name) + `</ty-option>`)
	}
	b.WriteString(`</ty-select>`)
	return b.String()
}

func renderBoard(v view, p gen.ProjectProjects) string {
	tasks := v.tasksOf(p.Xid)
	var b strings.Builder
	b.WriteString(`<main class="flex-1 min-w-0 overflow-y-auto px-8 pt-8 pb-16 flex flex-col gap-6">`)
	b.WriteString(`<div class="flex flex-col gap-1.5"><h1 class="text-[1.5rem] font-semibold tracking-[-0.02em]">` + esc(s2(p.Name)) + roleTag(roleIn(p, v.Me.XID)) + `</h1>` +
		`<p class="hint">` + esc(p.Description) + `</p></div>`)

	// add a task: a write on the project
	b.WriteString(`<div class="flex items-center gap-2" data-tour="new-task">
  <ty-input size="sm" class="flex-1" placeholder="New task…" data-bind="newTitle" data-on:keydown="` + attr(`evt.key === 'Enter' && @post('/act/add-task')`) + `"></ty-input>` +
		personSelect("", "Assignee", `$newAssignee = evt.detail.value || ''`, `style="width:160px"`) +
		`<ty-button size="sm" flavor="primary" data-on:click="@post('/act/add-task')">` + icon("plus", `slot="start" size="sm"`) + `Add</ty-button></div>`)

	b.WriteString(`<div class="grid grid-cols-3 gap-4 items-start" data-tour="board">`)
	for _, st := range statuses {
		var col []gen.ProjectTasks
		for _, t := range tasks {
			if s2(t.Status) == st || (st == "ToDo" && s2(t.Status) == "") {
				col = append(col, t)
			}
		}
		b.WriteString(`<section class="surface rounded-xl p-3 flex flex-col gap-2 min-h-[140px]">` +
			`<div class="flex items-center gap-2 px-1 pb-1"><span class="section-title flex-1">` + humanize(st) + `</span>` +
			fmt.Sprintf(`<span class="section-count">%d</span></div>`, len(col)))
		for _, t := range col {
			b.WriteString(renderCard(v, t))
		}
		b.WriteString(`</section>`)
	}
	b.WriteString(`</div>`)
	b.WriteString(`<p class="hint">The controls are the same for everyone. Whether a move, an assignment or a delete goes through is the guards' call; the toast shows what the engine answered.</p>`)
	b.WriteString(`</main>`)
	return b.String()
}

func renderCard(v view, t gen.ProjectTasks) string {
	st := s2(t.Status)
	cls := "surface-raised rounded-lg p-3 flex flex-col gap-2.5"
	if taskAssignee(t) == v.Me.XID {
		cls += " card-mine"
	}
	idx := 0
	for i, s := range statuses {
		if s == st {
			idx = i
		}
	}
	move := func(to int, ic, label string) string {
		if to < 0 || to >= len(statuses) {
			return ""
		}
		return `<button class="icon-btn" title="` + label + `" data-on:click="` +
			attr(`@post('/act/move?task=`+t.Xid+`&to=`+statuses[to]+`')`) + `">` + icon(ic, `size="sm"`) + `</button>`
	}
	var b strings.Builder
	b.WriteString(`<div class="` + cls + `" id="task-` + t.Xid + `">`)
	b.WriteString(`<div class="flex items-start gap-2"><span class="flex-1 text-[0.9rem] font-medium">` + esc(t.Title) + `</span>`)
	if p := s2(t.Priority); p != "" {
		b.WriteString(`<ty-tag size="xs" flavor="` + priorityFlavor(p) + `">` + esc(humanize(p)) + `</ty-tag>`)
	}
	b.WriteString(`</div><div class="flex items-center gap-2">`)
	b.WriteString(personSelect(taskAssignee(t), "Unassigned", `@post('/act/assign?task=`+t.Xid+`&to=' + (evt.detail.value || ''))`, `class="flex-1 min-w-0" title="Assignee"`))
	b.WriteString(move(idx-1, "left", "Move back") + move(idx+1, "right", "Move forward"))
	b.WriteString(`<button class="icon-btn danger" title="Delete" data-on:click="` +
		attr(`@post('/act/delete-task?task=`+t.Xid+`')`) + `">` + icon("trash", `size="sm"`) + `</button>`)
	b.WriteString(`</div></div>`)
	return b.String()
}

// ---- right panel: about, people, your role, workload ---------------------

func renderPanel(v view, p gen.ProjectProjects) string {
	r := rolesOf(p)
	role := roleIn(p, v.Me.XID)
	var b strings.Builder
	b.WriteString(`<aside class="w-80 shrink-0 divider-l overflow-y-auto p-5 flex flex-col gap-7">`)

	b.WriteString(`<section class="flex flex-col gap-2"><span class="section-title">About</span>
<ty-textarea size="sm" rows="2" resize="none" value="` + esc(p.Description) + `"></ty-textarea>
<div class="flex justify-end"><ty-button size="sm" flavor="neutral" appearance="outlined" data-on:click="` +
		attr(`$desc = el.closest('section').querySelector('ty-textarea').value; @post('/act/describe')`) + `">` +
		icon("save", `slot="start" size="sm"`) + `Save</ty-button></div></section>`)

	b.WriteString(`<section class="flex flex-col gap-2" data-tour="roles"><span class="section-title">People and roles</span>`)
	person := func(x ref, roleKey string) {
		b.WriteString(`<div class="flex items-center gap-2 py-0.5">` + avatar(personByXID(x.XID), "sm") +
			`<span class="flex-1">` + esc(displayName(x.XID, x.Name)) + `</span>` + roleTag(roleKey))
		if roleKey != "owner" {
			b.WriteString(`<button class="icon-btn" title="Remove from this role" data-on:click="` +
				attr(`@post('/act/revoke?role=`+roleKey+`&who=`+x.XID+`')`) + `">` + icon("x", `size="xs"`) + `</button>`)
		} else {
			b.WriteString(`<span class="w-[18px]"></span>`)
		}
		b.WriteString(`</div>`)
	}
	if r.Owner != nil {
		person(*r.Owner, "owner")
	}
	for _, x := range r.Managers {
		person(x, "manager")
	}
	for _, x := range r.Members {
		person(x, "member")
	}
	for _, x := range r.Viewers {
		person(x, "viewer")
	}
	b.WriteString(`<div class="flex flex-col gap-1.5 mt-2">` +
		personSelect("", "Add someone…", `$grantUser = evt.detail.value || ''`, ``) +
		`<div class="flex items-center gap-1.5"><ty-select size="sm" value="member" class="flex-1" data-on:change="$grantRole = evt.detail.value"><ty-option value="manager">as manager</ty-option><ty-option value="member">as member</ty-option><ty-option value="viewer">as viewer</ty-option></ty-select>` +
		`<ty-button size="sm" flavor="primary" data-on:click="@post('/act/grant')">` + icon("plus", `slot="start" size="sm"`) + `Add</ty-button></div></div></section>`)

	b.WriteString(`<section class="surface rounded-xl p-4 flex flex-col gap-2" data-tour="your-role"><div class="flex items-center gap-2"><span class="section-title">You are</span>` + roleTag(role) + `</div>` +
		canList(role) + `<div class="faint text-[0.78rem] mt-1">and anyone may change a task assigned to them</div></section>`)

	b.WriteString(`<section class="flex flex-col gap-2.5" data-tour="workload"><span class="section-title">Workload you can see</span>`)
	maxN := int64(1)
	for _, w := range v.Workload {
		if w.Open+w.Done > maxN {
			maxN = w.Open + w.Done
		}
	}
	for _, w := range v.Workload {
		name := s2(w.Person)
		if name == "" {
			name = "unassigned"
		} else if p := personByKey(name); p.Key == name {
			name = p.Name
		}
		b.WriteString(fmt.Sprintf(`<div class="flex items-center gap-2 text-[0.84rem]"><span class="w-20 truncate soft">%s</span>
<div class="bar flex-1"><span style="width:%d%%;background:var(--ty-color-warning)"></span><span style="width:%d%%;background:var(--ty-color-success)"></span></div>
<span class="w-10 text-right mono faint text-[0.76rem]">%d/%d</span></div>`, esc(name), w.Open*100/maxN, w.Done*100/maxN, w.Open, w.Open+w.Done))
	}
	b.WriteString(`<p class="faint text-[0.78rem]">open / all · one SQL template for everyone; the guards are injected into it, so each person gets their own numbers</p></section>`)

	b.WriteString(`<section class="mt-auto"><ty-button size="sm" flavor="danger" appearance="outlined" data-on:click="` +
		attr(`confirm('Delete this project and its tasks?') && @post('/act/delete-project')`) + `">` +
		icon("trash", `slot="start" size="sm"`) + `Delete project</ty-button></section>`)
	b.WriteString(`</aside>`)
	return b.String()
}
