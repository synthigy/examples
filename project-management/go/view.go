package main

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	datastar "github.com/starfederation/datastar-go/datastar"
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
	case "Medium":
		return "primary"
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
	"shield":  `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
	"chart":   `<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16h8"/><path d="M7 11h12"/><path d="M7 6h3"/>`,
	"users":   `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
	"sun":     `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
	"moon":    `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
	"compass": `<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>`,
	"rotate":  `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`,
}

func icon(name, attrs string) string {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` + icons[name] + `</svg>`
	return `<ty-icon ` + attrs + `>` + svg + `</ty-icon>`
}

func avatar(p *Person, size string) string {
	if p == nil {
		return `<span class="avatar ` + size + ` ty-content ty-text--">?</span>`
	}
	return `<span class="avatar ` + size + ` ty-bg-` + p.Flavor + ` ty-text-` + p.Flavor + `++" title="` + esc(p.Name) + `">` + esc(p.Name[:1]) + `</span>`
}

func roleTag(role string) string {
	if role == "" {
		return ""
	}
	return `<ty-tag size="xs" flavor="` + roleFlavor[role] + `">` + esc(role) + `</ty-tag>`
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

// ---- page shell ----------------------------------------------------------

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

// open-stream retries ~forever with capped backoff, so a BFF restart doesn't
// leave the tab deaf. One URL on purpose: Datastar cancels the previous
// request by method+URL, so user and project travel as signals.
const openStream = `@get('/stream', {filterSignals: {include: /^(user|project)$/}, openWhenHidden: true, retryMaxCount: 1000000, retryMaxWait: 10000})`

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
<html lang="en" class="dark">
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
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC54/css/tyrell.css">
<!-- the token layer: without it every --ty-* is undefined and the page renders unthemed -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC54/css/tyrell-theme.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC54/dist/tyrell.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js"></script>
<style>
  body{font-family:'DM Sans',system-ui,sans-serif;font-size:13px}
  .t11{font-size:11px}.t12{font-size:12px}
  .avatar{display:inline-grid;place-items:center;border-radius:9999px;font-weight:600;flex-shrink:0}
  .avatar.sm{width:22px;height:22px;font-size:11px}.avatar.md{width:28px;height:28px;font-size:12px}
  ty-icon:not(:defined){display:inline-flex;width:1em;height:1em}
  ty-icon:not(:defined)[size=xs]{width:.75em;height:.75em}
  ty-icon:not(:defined)[size=sm]{width:.875em;height:.875em}
  ty-icon:not(:defined) svg{width:100%;height:100%}
  .field{background:var(--ty-bg-content,transparent);border:1px solid var(--ty-border,rgba(255,255,255,.15));border-radius:8px;padding:5px 8px;color:inherit;font-size:12px}
  .field:focus{outline:2px solid var(--ty-color-primary,#6aa0ff);outline-offset:-1px}
  select.field{padding-right:4px}
  ty-tag{width:fit-content}
  .card{border:1px solid var(--ty-border-,rgba(255,255,255,.08))}
  .card.mine{border-left:3px solid var(--ty-color-primary,#6aa0ff)}
  .nav-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;cursor:pointer}
  .nav-item:hover{background:var(--ty-bg-content,rgba(255,255,255,.04))}
  .nav-item.active{background:var(--ty-bg-primary,rgba(106,160,255,.15))}
  .iconbtn{opacity:.6}.iconbtn:hover{opacity:1}
  #notifications{position:fixed;right:20px;bottom:20px;z-index:60;display:flex;flex-direction:column;gap:10px;width:340px;max-width:calc(100vw - 40px)}
  .notify{border-left:3px solid var(--ty-color-primary,#6aa0ff);animation:notify-in .25s ease-out}
  @keyframes notify-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  #live{transition:opacity .15s}
</style>
</head>
<body class="ty-canvas ty-text h-screen flex flex-col overflow-hidden" data-signals="` + attr(js(sig)) + `">
<header class="ty-elevated border-b ty-border- px-5 py-2 flex items-center gap-4 shrink-0">`)
	if s.examplesURL != "" {
		b.WriteString(`<a class="flex items-center gap-1 t12 ty-text- hover:ty-text" href="` + esc(s.examplesURL) + `" data-tour="examples">` +
			icon("back", `size="xs"`) + `Examples</a>`)
	}
	b.WriteString(`<div class="flex items-center gap-2">
  <div class="w-7 h-7 rounded-lg ty-bg-primary ty-text-primary++ grid place-items-center">` + icon("kanban", `size="sm"`) + `</div>
  <div class="flex flex-col leading-tight"><span class="font-semibold ty-text++ text-sm">Synthigy Projects</span>
  <span class="t11 ty-text--">roles · guards · live · notifications</span></div>
</div>
<div class="ml-auto"></div>`)
	b.WriteString(renderCast(me))
	b.WriteString(renderWhoami(me))
	b.WriteString(s.renderBell(me))
	b.WriteString(`<button class="ty-text- hover:ty-text" title="Toggle theme" data-on:click="document.documentElement.classList.toggle('dark')">` +
		icon("sun", `class="hidden dark:block"`) + icon("moon", `class="block dark:hidden"`) + `</button>`)
	if !peer {
		b.WriteString(`<ty-button size="sm" flavor="secondary" data-tour="topbar-tour" onclick="location.href='` +
			pageURL("alice", tour, "tour", "1") + `'">` + icon("compass", `slot="start" size="sm"`) + `Take the tour</ty-button>`)
	}
	b.WriteString(`</header>`)

	// data-init opens the live stream; navigation reopens it.
	b.WriteString(`<div class="flex-1 flex min-h-0" data-init="` + attr(openStream) + `"
  data-on:pm-nav__window="` + attr(`$user = evt.detail.user || $user; $project = evt.detail.project || ''; `+openStream) + `"
  data-on:popstate__window="` + attr(`$user = new URLSearchParams(location.search).get('user') || $user; $project = new URLSearchParams(location.search).get('project') || ''; `+openStream) + `">`)
	b.WriteString(`<aside class="w-64 shrink-0 border-r ty-border- flex flex-col min-h-0">`)
	b.WriteString(renderSidebar(v))
	// the shared tools dock is fixed bottom-left: this tray is its seat
	b.WriteString(`<div class="shrink-0 border-t ty-border- px-4 pt-3" style="height:220px"><span class="t11 uppercase tracking-wide ty-text--">Synthigy tools</span></div>`)
	b.WriteString(`</aside>`)
	b.WriteString(s.renderMain(r.Context(), v))
	b.WriteString(`</div>`)
	b.WriteString(renderToast(nil))
	b.WriteString(`<div id="notifications"></div>`)

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
<script src="/scenario.js"></script>
<script>window.SynthigyScenario && SynthigyScenario.register({actions: window.PM_TOUR_ACTIONS});</script>
</body></html>`)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(b.String()))
}

func title(b *inbox, me *Person) string {
	_, unread := b.list(me.XID)
	t := "Synthigy Projects · " + me.Name
	if unread > 0 {
		t = fmt.Sprintf("(%d) %s", unread, t)
	}
	return t
}

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
			`<nav id="sidebar" class="flex-1 overflow-y-auto">` + renderSidebarInner(v) + `</nav>` +
			s.renderMain(ctx, v)); err != nil {
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

// ---- header --------------------------------------------------------------

func renderCast(me *Person) string {
	var b strings.Builder
	b.WriteString(`<div id="cast" class="flex items-center gap-1 p-1 rounded-xl ty-content" data-tour="cast">`)
	for _, p := range cast {
		cls := "flex items-center gap-1.5 px-2 py-1 rounded-lg ty-text- hover:ty-text"
		if p == me {
			cls = "flex items-center gap-1.5 px-2 py-1 rounded-lg ty-elevated ty-text++"
		}
		b.WriteString(`<a class="` + cls + `" href="` + pageURL(p.Key, "") + `" data-on:click="` +
			attr(`evt.preventDefault(); pmNav(`+js(p.Key)+`, null)`) + `">` + avatar(p, "sm") +
			`<span class="t12">` + esc(p.Name) + `</span></a>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

func renderWhoami(me *Person) string {
	return `<div id="whoami" class="flex items-center gap-1 t11 ty-text-- px-2" data-tour="whoami" title="Every read and write for this person carries acting_as">` +
		icon("shield", `size="xs"`) + `<span>acting_as</span><span class="font-mono ty-text-">` + esc(me.XID[:6]) + `…</span></div>`
}

func (s *server) renderBell(me *Person) string {
	notes, unread := s.inbox.list(me.XID)
	var b strings.Builder
	b.WriteString(`<div id="bell" class="relative" data-tour="bell">`)
	b.WriteString(`<button class="relative ty-text- hover:ty-text p-1" title="Notifications" data-on:click="` +
		attr(`$bell = !$bell; $bell && @post('/notifications/read', {filterSignals: {include: /^user$/}})`) + `">` + icon("bell", `size="md"`))
	if unread > 0 {
		b.WriteString(fmt.Sprintf(`<span class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full ty-bg-danger ty-text-danger++ t11 font-semibold grid place-items-center">%d</span>`, unread))
	}
	b.WriteString(`</button>`)
	b.WriteString(`<div class="absolute right-0 top-9 z-50 w-80 ty-floating rounded-xl shadow-xl p-3" data-show="$bell" style="display:none">
  <div class="flex items-center mb-2"><span class="font-semibold ty-text+">Notifications</span>
  <button class="ml-auto ty-text- hover:ty-text" data-on:click="$bell = false">` + icon("x", `size="xs"`) + `</button></div>`)
	if len(notes) == 0 {
		b.WriteString(`<p class="t12 ty-text--">Nothing yet. They come from re-reading what you may see, so they only ever name rows you can read.</p>`)
	}
	for i := len(notes) - 1; i >= 0; i-- {
		n := notes[i]
		b.WriteString(`<div class="py-2 border-t ty-border- t12">` + noteLink(n, me) + `<div class="t11 ty-text--">` + n.At.Format("15:04:05") + `</div></div>`)
	}
	b.WriteString(`</div></div>`)
	return b.String()
}

func noteLink(n Note, me *Person) string {
	if n.Project == "" {
		return `<span class="ty-text">` + esc(n.Text) + `</span>`
	}
	return `<a class="ty-text hover:underline" href="` + pageURL(me.Key, n.Project) + `" data-on:click="` +
		attr(`evt.preventDefault(); $bell = false; pmNav(null, `+js(n.Project)+`)`) + `">` + esc(n.Text) + `</a>`
}

func renderNotify(n Note, me *Person) string {
	return fmt.Sprintf(`<div id="note-%d" class="notify ty-floating rounded-xl shadow-xl px-4 py-3 flex items-start gap-2" data-init="setTimeout(() => el.remove(), 7000)">`, n.Seq) +
		icon("bell", `size="sm" class="ty-text-primary mt-0.5"`) + `<div class="flex-1 t12">` + noteLink(n, me) + `</div>` +
		`<button class="ty-text- hover:ty-text" data-on:click="el.parentElement.remove()">` + icon("x", `size="xs"`) + `</button></div>`
}

// renderToast carries the engine's answer to a write, refusals included.
func renderToast(a *answer) string {
	if a == nil {
		return `<div id="toast" class="fixed top-16 right-6 z-50 max-w-md"></div>`
	}
	flavor, ic := "success", "check"
	if !a.OK {
		flavor, ic = "danger", "ban"
	}
	code := ""
	if a.Code != "" {
		code = `<div class="t11 font-mono ty-text-` + flavor + ` mt-1">` + esc(a.Code)
		if a.Category != "" {
			code += ` · ` + esc(a.Category)
		}
		code += `</div>`
	}
	return `<div id="toast" class="fixed top-16 right-6 z-50 max-w-md"><div class="ty-floating rounded-xl shadow-xl px-4 py-3 flex items-start gap-2 border-l-4 ty-border-` + flavor + `" data-init="setTimeout(() => el.remove(), 6000)">` +
		icon(ic, `size="sm" class="ty-text-`+flavor+` mt-0.5"`) + `<div class="flex-1"><div class="t12 ty-text">` + esc(a.Message) + `</div>` + code + `</div>` +
		`<button class="ty-text- hover:ty-text" data-on:click="el.parentElement.remove()">` + icon("x", `size="xs"`) + `</button></div></div>`
}

// ---- sidebar -------------------------------------------------------------

func renderSidebar(v view) string {
	return `<nav id="sidebar" class="flex-1 overflow-y-auto">` + renderSidebarInner(v) + `</nav>`
}

func navItem(v view, target, label, ic, right, tour string) string {
	cls := "nav-item"
	if v.Project == target {
		cls += " active"
	}
	t := ""
	if tour != "" {
		t = ` data-tour="` + tour + `"`
	}
	return `<a class="` + cls + `"` + t + ` href="` + pageURL(v.Me.Key, target) + `" data-on:click="` +
		attr(`evt.preventDefault(); pmNav(null, `+js(target)+`)`) + `">` + icon(ic, `size="sm" class="ty-text-"`) +
		`<span class="flex-1 truncate ty-text+">` + esc(label) + `</span>` + right + `</a>`
}

func renderSidebarInner(v view) string {
	var b strings.Builder
	b.WriteString(`<div class="p-3 flex flex-col gap-1">`)
	b.WriteString(navItem(v, "access", "Who can do what", "grid", "", "access"))
	b.WriteString(`<div class="t11 uppercase tracking-wide ty-text-- px-3 pt-4 pb-1">Your projects</div><div data-tour="projects" class="flex flex-col gap-1">`)
	if len(v.Projects) == 0 {
		b.WriteString(`<div class="px-3 t12 ty-text--">No project's guard lets you in.</div>`)
	}
	for _, p := range v.Projects {
		n := openCount(v.tasksOf(p.Xid))
		right := roleTag(roleIn(p, v.Me.XID)) + fmt.Sprintf(`<span class="t11 ty-text-- w-4 text-right">%d</span>`, n)
		b.WriteString(navItem(v, p.Xid, s2(p.Name), "folder", right, ""))
	}
	b.WriteString(`</div>`)
	if out := v.outside(); len(out) > 0 {
		b.WriteString(`<div class="t11 uppercase tracking-wide ty-text-- px-3 pt-4 pb-1">Assigned to you elsewhere</div>`)
		b.WriteString(navItem(v, "outside", "Projects you can't open", "lock",
			fmt.Sprintf(`<span class="t11 ty-text-- w-4 text-right">%d</span>`, len(out)), "outside"))
	}
	b.WriteString(`</div>`)
	return b.String()
}

// ---- main ----------------------------------------------------------------

func (s *server) renderMain(ctx context.Context, v view) string {
	var b strings.Builder
	b.WriteString(`<div id="main" class="flex-1 flex min-h-0">`)
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
	b.WriteString(`<main class="flex-1 overflow-y-auto p-6 flex flex-col gap-6">`)
	b.WriteString(`<div><h1 class="text-lg font-semibold ty-text++">Who can do what</h1>
<p class="t12 ty-text- mt-1 max-w-3xl">Each row is that person's own read of the same query, through the same client, under their <span class="font-mono">acting_as</span>. A dash is a project whose guards let them nowhere near it: for them it does not exist.</p></div>`)
	b.WriteString(`<div class="ty-elevated rounded-xl overflow-x-auto" data-tour="matrix"><table class="w-full t12"><thead><tr class="ty-text-- t11 uppercase tracking-wide"><th class="text-left px-4 py-3">Person</th>`)
	for _, c := range cols {
		b.WriteString(`<th class="text-left px-4 py-3">` + esc(c) + `</th>`)
	}
	b.WriteString(`<th class="text-right px-4 py-3">Tasks they read</th><th class="text-right px-4 py-3">Assigned to them</th></tr></thead><tbody>`)
	for _, r := range rows {
		cls := "border-t ty-border-"
		if r.P == v.Me {
			cls += " ty-content"
		}
		b.WriteString(`<tr class="` + cls + `"><td class="px-4 py-3"><span class="flex items-center gap-2">` + avatar(r.P, "sm") + esc(r.P.Name) + `</span></td>`)
		for _, c := range cols {
			role, ok := r.Roles[c]
			cell := `<span class="ty-text--">—</span>`
			if ok {
				cell = roleTag(role)
			}
			b.WriteString(`<td class="px-4 py-3">` + cell + `</td>`)
		}
		b.WriteString(fmt.Sprintf(`<td class="px-4 py-3 text-right font-mono">%d</td><td class="px-4 py-3 text-right font-mono">%d</td></tr>`, r.Tasks, r.Mine))
	}
	b.WriteString(`</tbody></table></div>`)

	b.WriteString(`<div class="grid gap-4" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))" data-tour="legend">`)
	for _, role := range []string{"owner", "manager", "member", "viewer", "assignee"} {
		b.WriteString(`<div class="ty-elevated rounded-xl p-4 flex flex-col gap-2"><div>` + roleTag(role) + `</div>`)
		for _, c := range roleCan[role] {
			b.WriteString(`<div class="flex gap-1.5 t12 ty-text">` + icon("check", `size="xs" class="ty-text-success mt-0.5"`) + esc(c) + `</div>`)
		}
		for _, c := range roleCannot[role] {
			b.WriteString(`<div class="flex gap-1.5 t12 ty-text-">` + icon("ban", `size="xs" class="ty-text-danger mt-0.5"`) + esc(c) + `</div>`)
		}
		b.WriteString(`</div>`)
	}
	b.WriteString(`</div>`)
	b.WriteString(`<p class="t11 ty-text--">The cards are the guards on Project and Project Task in plain words. Open the model from the tools tray to see them as they are deployed.</p>`)
	b.WriteString(`</main>`)
	return b.String()
}

func renderOutside(v view) string {
	var b strings.Builder
	b.WriteString(`<main class="flex-1 overflow-y-auto p-6 flex flex-col gap-4">`)
	b.WriteString(`<div><h1 class="text-lg font-semibold ty-text++">Assigned to you, in projects you can't open</h1>
<p class="t12 ty-text- mt-1 max-w-3xl">Project Task has a guard on its assignee: you may read and change a task assigned to you whatever its project says. The project's own guard still hides the project, so the query's left pull <span class="font-mono">-&gt;project</span> comes back empty.</p></div>`)
	b.WriteString(`<div class="flex flex-col gap-2 max-w-xl" data-tour="outside-tasks">`)
	for _, t := range v.outside() {
		b.WriteString(renderCard(v, t, nil))
	}
	b.WriteString(`</div></main>`)
	return b.String()
}

func renderBoard(v view, p gen.ProjectProjects) string {
	tasks := v.tasksOf(p.Xid)
	role := roleIn(p, v.Me.XID)
	var b strings.Builder
	b.WriteString(`<main class="flex-1 min-w-0 overflow-y-auto p-6 flex flex-col gap-4">`)
	b.WriteString(`<div class="flex items-center gap-2"><h1 class="text-lg font-semibold ty-text++">` + esc(s2(p.Name)) + `</h1>` + roleTag(role) + `</div>`)
	people := rolesOf(p)

	// add a task: a write on the project
	b.WriteString(`<div class="flex items-center gap-2" data-tour="new-task">
  <input class="field flex-1" placeholder="New task…" data-bind="newTitle" data-on:keydown="` + attr(`evt.key === 'Enter' && @post('/act/add-task')`) + `">
  <select class="field" data-bind="newAssignee"><option value="">Unassigned</option>`)
	for _, c := range cast {
		b.WriteString(`<option value="` + c.XID + `">` + esc(c.Name) + `</option>`)
	}
	b.WriteString(`</select><ty-button size="sm" flavor="primary" data-on:click="@post('/act/add-task')">` + icon("plus", `slot="start" size="sm"`) + `Add</ty-button></div>`)

	b.WriteString(`<div class="grid grid-cols-3 gap-4 items-start" data-tour="board">`)
	for _, st := range statuses {
		var col []gen.ProjectTasks
		for _, t := range tasks {
			if s2(t.Status) == st || (st == "ToDo" && s2(t.Status) == "") {
				col = append(col, t)
			}
		}
		b.WriteString(`<section class="ty-content rounded-xl p-3 flex flex-col gap-2 min-h-[120px]">` +
			`<div class="flex items-center gap-2 px-1"><ty-tag size="xs" flavor="` + statusFlavor(st) + `">` + humanize(st) + `</ty-tag>` +
			fmt.Sprintf(`<span class="t11 ty-text--">%d</span></div>`, len(col)))
		for _, t := range col {
			b.WriteString(renderCard(v, t, &people))
		}
		b.WriteString(`</section>`)
	}
	b.WriteString(`</div>`)
	b.WriteString(`<p class="t11 ty-text--">The buttons are the same for everyone. Whether a move, an assignment or a delete goes through is the guards' call, and the toast shows what the engine answered.</p>`)
	b.WriteString(`</main>`)
	return b.String()
}

func renderCard(v view, t gen.ProjectTasks, _ *roles) string {
	st := s2(t.Status)
	mine := taskAssignee(t) == v.Me.XID
	cls := "card ty-elevated rounded-lg p-3 flex flex-col gap-2"
	if mine {
		cls += " mine"
	}
	idx := 0
	for i, s := range statuses {
		if s == st {
			idx = i
		}
	}
	move := func(to int, ic, label string) string {
		if to < 0 || to >= len(statuses) {
			return `<span class="w-5"></span>`
		}
		return `<button class="iconbtn ty-text" title="` + label + `" data-on:click="` +
			attr(`@post('/act/move?task=`+t.Xid+`&to=`+statuses[to]+`')`) + `">` + icon(ic, `size="sm"`) + `</button>`
	}
	var b strings.Builder
	b.WriteString(`<div class="` + cls + `" id="task-` + t.Xid + `">`)
	b.WriteString(`<div class="flex items-start gap-2"><span class="flex-1 ty-text+">` + esc(t.Title) + `</span>`)
	if p := s2(t.Priority); p != "" {
		b.WriteString(`<ty-tag size="xs" flavor="` + priorityFlavor(p) + `">` + esc(humanize(p)) + `</ty-tag>`)
	}
	b.WriteString(`</div><div class="flex items-center gap-1.5">`)
	b.WriteString(avatar(personByXID(taskAssignee(t)), "sm"))
	b.WriteString(`<select class="field t11 py-0.5" title="Assignee" data-on:change="` +
		attr(`@post('/act/assign?task=`+t.Xid+`&to=' + evt.target.value)`) + `"><option value="">Unassigned</option>`)
	for _, c := range cast {
		sel := ""
		if c.XID == taskAssignee(t) {
			sel = " selected"
		}
		b.WriteString(`<option value="` + c.XID + `"` + sel + `>` + esc(c.Name) + `</option>`)
	}
	b.WriteString(`</select><span class="flex-1"></span>`)
	b.WriteString(move(idx-1, "left", "Move back") + move(idx+1, "right", "Move forward"))
	b.WriteString(`<button class="iconbtn ty-text-danger ml-1" title="Delete" data-on:click="` +
		attr(`@post('/act/delete-task?task=`+t.Xid+`')`) + `">` + icon("trash", `size="sm"`) + `</button>`)
	b.WriteString(`</div></div>`)
	return b.String()
}

// ---- right panel: people, your role, workload ---------------------------

func renderPanel(v view, p gen.ProjectProjects) string {
	r := rolesOf(p)
	role := roleIn(p, v.Me.XID)
	var b strings.Builder
	b.WriteString(`<aside class="w-80 shrink-0 border-l ty-border- overflow-y-auto p-4 flex flex-col gap-6">`)

	// description
	b.WriteString(`<section class="flex flex-col gap-2"><span class="t11 uppercase tracking-wide ty-text--">About</span>
<textarea class="field" rows="2" data-on:input="$desc = el.value">` + esc(p.Description) + `</textarea>
<div class="flex justify-end"><ty-button size="xs" flavor="neutral" data-on:click="` +
		attr(`$desc = el.closest('section').querySelector('textarea').value; @post('/act/describe')`) + `">Save</ty-button></div></section>`)

	// people
	b.WriteString(`<section class="flex flex-col gap-2" data-tour="roles"><div class="flex items-center gap-1">` + icon("users", `size="sm" class="ty-text-"`) +
		`<span class="t11 uppercase tracking-wide ty-text--">People and roles</span></div>`)
	person := func(x ref, roleKey string) {
		pp, name := personByXID(x.XID), x.Name
		if pp != nil {
			name = pp.Name
		}
		b.WriteString(`<div class="flex items-center gap-2 py-0.5">` + avatar(pp, "sm") + `<span class="flex-1 ty-text">` + esc(name) + `</span>` + roleTag(roleKey))
		if roleKey != "owner" {
			b.WriteString(`<button class="iconbtn ty-text-" title="Remove from this role" data-on:click="` +
				attr(`@post('/act/revoke?role=`+roleKey+`&who=`+x.XID+`')`) + `">` + icon("x", `size="xs"`) + `</button>`)
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
	b.WriteString(`<div class="flex items-center gap-1 mt-1"><select class="field flex-1" data-bind="grantUser"><option value="">Add someone…</option>`)
	for _, c := range cast {
		b.WriteString(`<option value="` + c.XID + `">` + esc(c.Name) + `</option>`)
	}
	b.WriteString(`</select><select class="field" data-bind="grantRole"><option value="manager">manager</option><option value="member">member</option><option value="viewer">viewer</option></select>` +
		`<ty-button size="xs" flavor="primary" data-on:click="@post('/act/grant')">` + icon("plus", `size="xs"`) + `</ty-button></div></section>`)

	// your role
	b.WriteString(`<section class="flex flex-col gap-2 ty-content rounded-xl p-3" data-tour="your-role"><div class="flex items-center gap-2"><span class="t11 uppercase tracking-wide ty-text--">You are</span>` + roleTag(role) + `</div>`)
	for _, c := range roleCan[role] {
		b.WriteString(`<div class="flex gap-1.5 t12 ty-text">` + icon("check", `size="xs" class="ty-text-success mt-0.5"`) + esc(c) + `</div>`)
	}
	for _, c := range roleCannot[role] {
		b.WriteString(`<div class="flex gap-1.5 t12 ty-text-">` + icon("ban", `size="xs" class="ty-text-danger mt-0.5"`) + esc(c) + `</div>`)
	}
	b.WriteString(`<div class="t11 ty-text-- mt-1">and anyone may change a task assigned to them</div></section>`)

	// workload
	b.WriteString(`<section class="flex flex-col gap-2" data-tour="workload"><div class="flex items-center gap-1">` + icon("chart", `size="sm" class="ty-text-"`) +
		`<span class="t11 uppercase tracking-wide ty-text--">Workload you can see</span></div>`)
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
		b.WriteString(fmt.Sprintf(`<div class="flex items-center gap-2 t12"><span class="w-16 truncate ty-text-">%s</span>
<div class="flex-1 h-3 rounded ty-content overflow-hidden flex"><div class="h-full" style="width:%d%%;background:var(--ty-solid-warning,var(--ty-color-warning-strong))"></div><div class="h-full" style="width:%d%%;background:var(--ty-solid-success,var(--ty-color-success-strong))"></div></div>
<span class="w-10 text-right font-mono ty-text-">%d/%d</span></div>`, esc(name), w.Open*100/maxN, w.Done*100/maxN, w.Open, w.Open+w.Done))
	}
	b.WriteString(`<div class="t11 ty-text--">open / all · one SQL template for everyone; the guards are injected into it, so each person gets their own numbers</div></section>`)

	b.WriteString(`<section class="mt-auto flex flex-col gap-2">
<ty-button size="xs" flavor="danger" appearance="ghost" data-on:click="` + attr(`confirm('Delete this project and its tasks?') && @post('/act/delete-project')`) + `">` + icon("trash", `slot="start" size="xs"`) + `Delete project</ty-button>
<ty-button size="xs" flavor="neutral" appearance="ghost" data-on:click="` + attr(`confirm('Put every seeded project back as setup left it?') && @post('/reset')`) + `">` + icon("rotate", `slot="start" size="xs"`) + `Reset demo data</ty-button></section>`)
	b.WriteString(`</aside>`)
	return b.String()
}
