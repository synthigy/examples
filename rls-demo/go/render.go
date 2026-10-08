package main

import (
	"context"
	"fmt"
	"html"
	"strings"

	gen "github.com/synthigy/rls-demo-bff/gen"
)

// ---- small helpers -------------------------------------------------------

// s2 dereferences an optional (pointer) string field from a generated row.
func s2(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func esc(s string) string { return html.EscapeString(s) }

// icons — a handful of inline lucide SVGs slotted into <ty-icon>.
var icons = map[string]string{
	"shield":       `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`,
	"shield-off":   `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20"/><path d="M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67-.01c2.35-.82 4.48-2.07 5.9-4.13"/><path d="M9.13 3.36C10.46 2.69 11.7 2 12 2c.5 0 4.5 2 8 2a1 1 0 0 1 1 1v7c0 .85-.1 1.62-.27 2.33"/></svg>`,
	"folder":       `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
	"check-square": `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
	"refresh":      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
	"play":         `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
	"lock":         `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
	"spinner":      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
	"list-plus":    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>`,
}

func icon(name, attrs string) string {
	svg := icons[name]
	if svg == "" {
		return `<ty-icon></ty-icon>`
	}
	if attrs != "" {
		return `<ty-icon ` + attrs + `>` + svg + `</ty-icon>`
	}
	return `<ty-icon>` + svg + `</ty-icon>`
}

func statusFlavor(s string) string {
	switch s {
	case "Done":
		return "success"
	case "In_Progress":
		return "warning"
	default:
		return "neutral"
	}
}

func priorityFlavor(p string) string {
	switch p {
	case "High":
		return "danger"
	case "Medium":
		return "warning"
	case "Low":
		return "secondary"
	default:
		return "neutral"
	}
}

// ---- page shell ----------------------------------------------------------

// localBundleConfig adds the rail's `bundle`/`bundleCss` overrides when a
// locally built web-component bundle is present, so a component change can be
// tested before @synthigy/tooling is republished — see localToolingBundle.
func localBundleConfig() string {
	if !localToolingBundle() {
		return ""
	}
	return `, bundle: "/vendor/tooling/tooling.js", bundleCss: "/vendor/tooling/tooling.css"`
}

func indexHTML(endpoint string) string { return indexHTMLWith("", endpoint) }

// indexHTMLWith renders the page shell. If gridHTML is non-empty it is inlined
// in place of the "Connecting…" placeholder (snapshot/no-JS mode); otherwise
// the shell opens the live SSE on load. endpoint is the Synthigy engine's own
// address — the tools rail's components talk to it directly, not to this BFF
// (see examples/shared/README.md); a demo running standalone (no hub in
// front) would otherwise default to its own origin and 404 on every /data call.
func indexHTMLWith(gridHTML, endpoint string) string {
	body := `<main id="grid" class="p-6"><div class="ty-text-- text-sm">Connecting…</div></main>`
	if gridHTML != "" {
		body = gridHTML
	}
	return strings.Replace(indexShell(endpoint), "<!--GRID-->", body, 1)
}

func indexShell(endpoint string) string {
	return `<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Synthigy — Row-Level Security, live</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC54/css/tyrell.css">
  <!-- tyrell-theme.css is the token layer (TC54's name for what TC31 called
       tyrell-brand.css). Without it every --ty-* custom property is undefined
       and the page renders unthemed. Pinned, not @tc: that tag moves. -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC54/css/tyrell-theme.css">
  <script type="module" src="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC54/dist/tyrell.js"></script>
  <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.0/bundles/datastar.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'DM Sans', system-ui, sans-serif; }
    .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  </style>
</head>
<body class="ty-canvas min-h-screen ty-text">
  <header class="ty-elevated sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b" style="--ty-elevated-border: var(--ty-border-)">
    <div class="flex items-center gap-3">
      ` + icon("shield", `size="md" class="ty-text-primary"`) + `
      <div>
        <div class="text-lg font-semibold ty-text++">Row-Level Security, <span class="ty-text-primary">live</span></div>
        <div class="text-xs ty-text--">One database · four users · one query · four answers</div>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <ty-button flavor="primary" size="sm" data-tour="toggle"
                 data-on:click="@post('/toggle-rls')"
                 data-indicator="rlsBusy"
                 data-attr:disabled="$rlsBusy">
        ` + icon("lock", `slot="start" size="sm" data-show="!$rlsBusy"`) + `
        ` + icon("spinner", `slot="start" size="sm" spin data-show="$rlsBusy" style="display:none"`) + `
        <span data-show="!$rlsBusy">Toggle RLS</span>
        <span data-show="$rlsBusy" style="display:none">Deploying…</span>
      </ty-button>
      <ty-button flavor="warning" size="sm" data-tour="cycle" data-on:click="@post('/cycle-task')">
        ` + icon("play", `slot="start" size="sm"`) + `Cycle a task
      </ty-button>
      <ty-button flavor="success" size="sm" data-on:click="@post('/generate-task')">
        ` + icon("list-plus", `slot="start" size="sm"`) + `Generate task
      </ty-button>
      <ty-button flavor="neutral" size="sm" data-on:click="@post('/reseed')">
        ` + icon("refresh", `slot="start" size="sm"`) + `Reseed
      </ty-button>
      <ty-button flavor="secondary" size="sm" onclick="location.search='?tour=1'">Take the tour</ty-button>
    </div>
  </header>

  <!-- Opens the persistent SSE on element init (Datastar v1.0 data-init;
       data-on-load would just listen for the DOM load event, which never
       fires on a div). Never itself patched, so it won't re-fire. -->
  <div data-init="@get('/stream')" class="hidden"></div>

  <!--GRID-->

  <footer class="px-6 py-4 text-xs ty-text-- text-center">
    BFF holds one confidential, trusted token · identity switched per panel via <span class="mono">acting_as</span> ·
    components by Tyrell · reactivity by Datastar · data by Synthigy <span class="mono">/data</span>
  </footer>

  <script>
    window.SYNTHIGY_TOOLS = { endpoint: "` + endpoint + `", xsql: ["/xsql/project.xsql"]` + localBundleConfig() + ` };
    window.SYNTHIGY_TOUR = "/tour.json";
  </script>
  <script src="/tools-rail.js"></script>
  <script src="/scenario.js"></script>
</body>
</html>`
}

// ---- live grid (patched over SSE) ---------------------------------------

func (s *server) renderGrid(ctx context.Context) string {
	panels := s.fetchAll(ctx)
	rlsOn := rlsObserved(panels, s.unscopedTaskCount(ctx))

	var b strings.Builder
	b.WriteString(`<main id="grid" class="p-6 space-y-6">`)
	b.WriteString(s.renderBanner(panels, rlsOn))
	s.mu.RLock()
	byProj := s.byProj
	s.mu.RUnlock()

	b.WriteString(renderTabs(byProj))
	if byProj {
		cols := projectColumns(panels)
		b.WriteString(fmt.Sprintf(`<div class="grid gap-4" style="grid-template-columns: repeat(%d, minmax(0,1fr))">`, max(1, len(cols))))
		for _, c := range cols {
			b.WriteString(renderProjectColumn(c))
		}
	} else {
		b.WriteString(`<div data-tour="panels" class="grid gap-4" style="grid-template-columns: repeat(4, minmax(0,1fr))">`)
		for _, p := range panels {
			b.WriteString(renderPanel(p, rlsOn))
		}
	}
	b.WriteString(`</div>`)
	b.WriteString(`</main>`)
	return b.String()
}

// renderTabs: the grid's axis. Server-side state, not a client signal — the
// pivot has to survive the SSE repaint that every write triggers.
func renderTabs(byProj bool) string {
	tab := func(label, by string, active bool) string {
		flavor := "neutral"
		if active {
			flavor = "primary"
		}
		return `<ty-button flavor="` + flavor + `" size="sm" data-on:click="@post('/view?by=` + by + `')">` +
			esc(label) + `</ty-button>`
	}
	return `<div class="flex items-center gap-2">` +
		tab("By user", "user", !byProj) +
		tab("By project", "project", byProj) +
		`<span class="text-xs ty-text-- ml-2">Same rows, pivoted. A project column shows who can see what inside it.</span>` +
		`</div>`
}

type projectColumn struct {
	Name  string
	Xid   string
	Dim   bool                             // a project no principal could read
	Seen  map[string][]gen.ProjectTaskList // user name -> the tasks THEY see here
	Users []User
}

// projectColumns pivots the per-user panels onto the project axis. A project
// appears if ANY principal can see it, or if any task claims it.
func projectColumns(panels []panel) []projectColumn {
	order := []string{}
	name := map[string]string{}
	seen := map[string]map[string][]gen.ProjectTaskList{}
	users := []User{}

	touch := func(xid, n string) {
		if _, ok := seen[xid]; !ok {
			seen[xid] = map[string][]gen.ProjectTaskList{}
			order = append(order, xid)
		}
		if n != "" {
			name[xid] = n
		}
	}
	for _, p := range panels {
		users = append(users, p.User)
		for _, pr := range p.Projects {
			touch(pr.Xid, s2(pr.Name))
		}
		for _, t := range p.Tasks {
			xid := ""
			n := ""
			if t.Project != nil {
				xid, n = t.Project.Xid, s2(t.Project.Name)
			}
			touch(xid, n)
			seen[xid][p.User.Name] = append(seen[xid][p.User.Name], t)
		}
	}
	cols := make([]projectColumn, 0, len(order))
	for _, xid := range order {
		label, dim := name[xid], false
		if label == "" {
			label, dim = "project not visible", true
		}
		cols = append(cols, projectColumn{Name: label, Xid: xid, Dim: dim, Seen: seen[xid], Users: users})
	}
	return cols
}

func renderProjectColumn(c projectColumn) string {
	var b strings.Builder
	title := `<span class="text-sm font-semibold ty-text++">` + esc(c.Name) + `</span>`
	ico := "folder"
	if c.Dim {
		title = `<span class="text-sm font-semibold ty-text-">` + esc(c.Name) + `</span>`
		ico = "lock"
	}
	b.WriteString(`<div class="ty-elevated rounded-xl overflow-hidden">`)
	b.WriteString(`<div class="px-4 py-3 flex items-center gap-2 border-b" style="--ty-elevated-border: var(--ty-border-soft)">` +
		icon(ico, `size="sm" class="ty-text-"`) + title + `</div>`)
	b.WriteString(`<div class="p-4 space-y-3">`)
	for _, u := range c.Users {
		tasks := c.Seen[u.Name]
		b.WriteString(`<div><div class="flex items-center gap-2 py-1">` +
			`<span class="inline-block w-2 h-2 rounded-full" style="background:var(--ty-solid-` + u.Flavor + `,var(--ty-color-` + u.Flavor + `-strong))"></span>` +
			`<span class="text-sm ty-text+">` + esc(u.Name) + `</span>` +
			fmt.Sprintf(`<span class="text-xs ty-text-- mono ml-auto">%d</span></div>`, len(tasks)))
		b.WriteString(`<div class="space-y-1.5 pl-4">`)
		if len(tasks) == 0 {
			b.WriteString(`<div class="text-xs ty-text--">nothing visible</div>`)
		}
		for _, t := range sortedTasks(tasks) {
			b.WriteString(renderTaskRow(t))
		}
		b.WriteString(`</div></div>`)
	}
	b.WriteString(`</div></div>`)
	return b.String()
}

// renderBanner: RLS state + the cross-cutting "tasks visible per user" analytics
// bar (each count comes from the SAME sql-template COUNT(*), RLS-scoped).
func (s *server) renderBanner(panels []panel, rlsOn bool) string {
	state := `<ty-tag flavor="success" size="sm">` + icon("shield", `slot="start" size="xs"`) + `RLS ENABLED</ty-tag>`
	blurb := `Each panel runs the identical query under a different <span class="mono">acting_as</span>. The rows simply aren't there for principals who shouldn't see them.`
	if !rlsOn {
		state = `<ty-tag flavor="danger" size="sm">` + icon("shield-off", `slot="start" size="xs"`) + `RLS DISABLED</ty-tag>`
		blurb = `Security is OFF — the unguarded dataset versions are deployed. Everyone sees everything; watch the panels converge.`
	}

	maxN := 1
	for _, p := range panels {
		if p.TaskCount > maxN {
			maxN = p.TaskCount
		}
	}
	var bars strings.Builder
	for _, p := range panels {
		pct := p.TaskCount * 100 / maxN
		bars.WriteString(fmt.Sprintf(`
      <div class="flex items-center gap-3">
        <div class="w-16 text-sm ty-text text-right">%s</div>
        <div class="flex-1 h-6 rounded ty-content overflow-hidden">
          <div class="h-full rounded transition-all duration-500" style="width:%d%%;background:var(--ty-solid-%s,var(--ty-color-%s-strong))"></div>
        </div>
        <div class="w-8 mono text-sm ty-text+ text-right">%d</div>
      </div>`, esc(p.User.Name), pct, p.User.Flavor, p.User.Flavor, p.TaskCount))
	}

	return `<section data-tour="analytics" class="ty-elevated rounded-xl p-4" style="--ty-elevated-border: var(--ty-border-)">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">` + state + `<span class="text-sm ty-text-">` + blurb + `</span></div>
      <div class="text-xs ty-text-- mono">SELECT count(*) FROM project_task  ·  same SQL, per-principal RLS</div>
    </div>
    <div class="space-y-1.5">` + bars.String() + `</div>
  </section>`
}

func renderPanel(p panel, rlsOn bool) string {
	var b strings.Builder
	b.WriteString(`<div class="ty-elevated rounded-xl overflow-hidden flex flex-col" style="--ty-elevated-border: var(--ty-border-)">`)

	// header
	b.WriteString(fmt.Sprintf(`
    <div class="flex items-center gap-3 p-4 border-b" style="border-color: var(--ty-border--)">
      <div class="w-9 h-9 rounded-full ty-bg-%s flex items-center justify-center font-semibold text-sm">%s</div>
      <div>
        <div class="font-semibold ty-text++">%s</div>
        <div class="text-xs ty-text-- mono">acting_as %s…</div>
      </div>
    </div>`, p.User.Flavor, p.User.Initial, esc(p.User.Name), esc(shortXID(p.User.XID))))

	if p.Err != "" {
		b.WriteString(`<div class="p-4 text-sm ty-text-danger">` + esc(p.Err) + `</div></div>`)
		return b.String()
	}

	// tiles
	b.WriteString(`<div class="grid grid-cols-2 gap-px ty-content">`)
	b.WriteString(tile(icon("folder", `size="sm" class="ty-text-"`), "Projects", p.ProjCount, len(p.Projects)))
	b.WriteString(tile(icon("check-square", `size="sm" class="ty-text-"`), "Tasks", p.TaskCount, len(p.Tasks)))
	b.WriteString(`</div>`)

	// body
	b.WriteString(`<div class="p-4 space-y-4 flex-1">`)

	// projects
	if len(p.Projects) == 0 && len(p.Tasks) == 0 {
		b.WriteString(`<div class="flex flex-col items-center justify-center text-center py-8 gap-2">` +
			icon("lock", `size="lg" class="ty-text--"`) +
			`<div class="text-sm ty-text-">Nothing visible</div>` +
			`<div class="text-xs ty-text--">RLS hides every row this user has no claim to.</div></div>`)
	} else {
		// Projects, each with the tasks visible inside it. Grouping is the whole
		// point: the same project shows a different task list per principal, and
		// a task whose project row RLS hid still surfaces — under "project not
		// visible", which is a claim on the task, not on the project.
		b.WriteString(`<div><div class="text-xs uppercase tracking-wide ty-text-- mb-2">Projects</div>`)
		if len(p.Projects) == 0 && len(p.Tasks) == 0 {
			b.WriteString(`<div class="text-xs ty-text--">—</div>`)
		}
		byProject := map[string][]gen.ProjectTaskList{}
		for _, t := range p.Tasks {
			key := ""
			if t.Project != nil {
				key = t.Project.Xid
			}
			byProject[key] = append(byProject[key], t)
		}
		group := func(name, iconName string, tasks []gen.ProjectTaskList, dim bool) {
			title := `<span class="text-sm ty-text+">` + esc(name) + `</span>`
			if dim {
				title = `<span class="text-sm ty-text-">` + esc(name) + `</span>`
			}
			b.WriteString(`<div class="mb-3"><div class="flex items-center gap-2 py-1">` +
				icon(iconName, `size="xs" class="ty-text-"`) + title +
				fmt.Sprintf(`<span class="text-xs ty-text-- mono ml-auto">%d</span></div>`, len(tasks)))
			b.WriteString(`<div class="space-y-1.5 pl-5">`)
			if len(tasks) == 0 {
				b.WriteString(`<div class="text-xs ty-text--">no tasks visible</div>`)
			}
			for _, t := range sortedTasks(tasks) {
				b.WriteString(renderTaskRow(t))
			}
			b.WriteString(`</div></div>`)
		}
		for _, pr := range p.Projects {
			group(s2(pr.Name), "folder", byProject[pr.Xid], false)
			delete(byProject, pr.Xid)
		}
		// Whatever is left belongs to a project this principal cannot see.
		var orphans []gen.ProjectTaskList
		for _, ts := range byProject {
			orphans = append(orphans, ts...)
		}
		if len(orphans) > 0 {
			group("project not visible", "lock", orphans, true)
		}
		b.WriteString(`</div>`)
	}

	b.WriteString(`</div></div>`)
	return b.String()
}

func renderTaskRow(t gen.ProjectTaskList) string {
	status := s2(t.Status)
	priority := s2(t.Priority)
	assignee := ""
	if t.Assignee != nil {
		assignee = s2(t.Assignee.Name)
	}

	chips := `<ty-tag size="xs" flavor="` + statusFlavor(status) + `">` + esc(humanize(status)) + `</ty-tag>`
	if priority != "" {
		chips += ` <ty-tag size="xs" flavor="` + priorityFlavor(priority) + `">` + esc(priority) + `</ty-tag>`
	}
	asg := ""
	if assignee != "" {
		asg = `<span class="text-xs ty-text-- mono">@` + esc(assignee) + `</span>`
	}
	return `<div class="ty-content rounded-lg px-3 py-2">
    <div class="text-sm ty-text+ mb-1">` + esc(t.Title) + `</div>
    <div class="flex items-center gap-1.5 flex-wrap">` + chips + ` ` + asg + `</div>
  </div>`
}

func tile(ic, label string, sqlN, listN int) string {
	return fmt.Sprintf(`<div class="ty-elevated p-3 flex items-center gap-3">
    %s
    <div>
      <div class="text-2xl font-bold ty-text++ leading-none mono">%d</div>
      <div class="text-[11px] ty-text-- mt-0.5">%s · SQL</div>
    </div>
  </div>`, ic, sqlN, esc(label))
}

func humanize(s string) string {
	if s == "" {
		return "—"
	}
	return strings.ReplaceAll(s, "_", " ")
}

func shortXID(x string) string {
	if len(x) > 6 {
		return x[:6]
	}
	return x
}
