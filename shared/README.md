# shared

Browser scripts and styles every demo serves from this directory, one copy
for all of them: no build step, no bundler, no dependency.

| File | What it is |
|---|---|
| `theme.css` | The look every demo shares: Tyrell tokens seeded yellow, DM Sans + JetBrains Mono, topbar / page / footer chrome, section titles, surfaces, avatars, pills, toasts |
| `chrome.js` | Reveals the page once Tyrell's components are defined (no flash of bare tags) and docks the tools rail into the footer's `#footer-tools` |
| `tools-rail.js` | Bottom-left dock that opens the `@synthigy/tooling` components (modeler, data console, log cockpit) against the demo's engine; each chip has a **tour** half |
| `scenario.js` | Runs tour scenarios: a demo's `<domain>/tour.json` and the built-in model / console / logs tours |
| `tour.js` | The engine under it, on driver.js (named steps, resume stack, page gates, lanes) |

## theme.css and chrome.js

Every demo pins the same versions: **Tyrell `1.0.0-TC55`** and **Datastar
`v1.0.2`**. The page anatomy is movies', which the theme was lifted from:

```html
<html lang="en" class="dark" data-theme="dark">
<head>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC55/css/tyrell.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC55/css/tyrell-theme.css">
  <script type="module" src="https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC55/dist/tyrell.js"></script>
  <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { corePlugins: { preflight: false } }</script>
  <link rel="stylesheet" href="/theme.css">
  <!-- the demo's own styles, only what is its own -->
</head>
<body class="ty-canvas">
  <header class="topbar flex items-center px-6 py-3 gap-6 shrink-0">
    <!-- a.back-link to EXAMPLES_URL · a.brand (icon + lowercase name) · nav of a.nav-link · .pill status · actions · "Take the tour" -->
  </header>
  <div class="page-scroll"><!-- or .page-fill for a full-height app --></div>
  <footer class="px-6 py-3 text-[0.8em] shrink-0 flex flex-wrap items-center gap-3 justify-between">
    <div class="flex flex-wrap items-center gap-2"><div id="footer-tools"></div><!-- data actions --></div>
    <span class="footer-credit">… · components by tyrell, reactivity by datastar</span>
  </footer>
  <script src="/tools-rail.js"></script>
  <script src="/chrome.js"></script>
</body>
```

- **Tailwind's preflight stays off**: its reset fights Tyrell's components.
  Layout is Tailwind utilities; colour, borders and type come from here.
- **`a.nav-link[aria-current="page"]`** marks where you are, in the topbar
  or in a sidebar.
- **Fields are Tyrell's** (`ty-input`, `ty-select`, `ty-textarea`), never
  bare `<input>`/`<select>`: they carry the theme. `ty-select` reports its
  pick in `evt.detail.value`.
- Serve `theme.css` as `text/css`, `chrome.js` like the other scripts.

## tools-rail.js

```html
<script>
  window.SYNTHIGY_TOOLS = {
    endpoint: "<the BFF's own SYNTHIGY_ENDPOINT>",   // the ENGINE, not this page
    xsql: ["/xsql/your-domain.xsql"],                // opens as console tabs
    // dataset: "Your Dataset",                      // opened in the modeler
    // position: "right", demoLogin: "user / pw" | false
  };
</script>
<script src="/tools-rail.js"></script>
```

- The rail itself is ~1 KB; the CDN bundle loads on the first dock click.
- **`endpoint` must be the engine's base URL.** The components call `/data`
  and `/oauth` there directly, not through the BFF.
- **`xsql`** files open as data-console workspace tabs, keyed by their
  `@workspace` header (one is added from the file name if missing), so a
  returning visitor keeps their edits. Serve the demo's real `<domain>/xsql/`
  files, `.xsql` only.
- **`dataset`** names the dataset the modeler opens. Without it the modeler
  starts on an empty canvas and a tour step anchored on an entity is skipped.
  The rail picks it from the modeler's Open Dataset list, only while the
  canvas is empty.
- **`demoLogin`** names the demo account in the dock; `false` hides it. The
  engine's sign-in page names it too: `bootstrap-instance.sh` serves
  `shared/login-page` as the instance's `default` login page
  (`scripts/add-login-page.sh`). The components carry no demo text.
- **`SYNTHIGY_TOOLS.open("model" | "console" | "logs")`** opens a tool like a
  dock click. The rail dispatches `synthigy-tools:open` / `synthigy-tools:close`
  on `document`.
- Login and silent renew survive reloads: the last-opened tool is remounted
  per tab, and the rail answers the silent-renew iframe itself (~200 ms).

## Tour scenarios

One format for every demo, kept as data in `<domain>/tour.json` and shared by
all ports of that domain (same convention as `<domain>/xsql/`):

```json
{
  "name": "project-management",
  "steps": [
    { "target": "panels", "title": "Same query, four answers", "body": "…" },
    { "target": "toggle", "title": "…", "body": "…", "wait": true },
    { "tool": "model", "anchor": "entity", "title": "This is the guard", "body": "…" },
    { "tool": "logs" }
  ],
  "tools": { "console": { "workspaces": { "title": "…", "html": "…" } } }
}
```

| Field | Meaning |
|---|---|
| `target` | page step: anchors on `data-tour="<target>"`, rendered server-side so it survives SSE repaints |
| `tool` + `anchor` | tool step: opens the tool and anchors inside it (anchors below); `selector` for a raw CSS selector in its shadow root |
| `tool` alone | includes that tool's built-in tour; `"only": ["run", "results"]` picks steps |
| `title`, `body` / `html` | popover copy; `body` is text, `html` is markup |
| `wait` | `true` advances on the next change inside the step's element; `{ "watch": "#grid" }` inside another element (what the click repaints); a string names a hook (`console-ran`) |
| `action` | `{ "label": "Run it", "do": "run-query" }` adds a button to the popover |
| `page` | regex on `location.pathname`; the tour pauses until the visitor reaches that page (say so in the step before) |
| `tools` | rewrites single steps of the built-in tool tours, by step id, here and on the dock chips |

| Tool | Anchors | Built-in tour steps |
|---|---|---|
| `model` | `canvas`, `entity`, `deploy` | `erd-is-the-db`, `versioned-and-deployed`, `permissions-in-model` |
| `console` | `tabs`, `run`, `results` | `workspaces`, `run`, `results` |
| `logs` | `lenses`, `toolbar`, `rows` | `lenses`, `window`, `rows` |

Consecutive tool steps for the same tool run as one lane: the tool opens, the
lane starts once it shows real content, and its last step closes the tool and
returns to the page. Behind the tools' Sign In the tour waits and resumes
after the sign-in reload; with nothing to show it says so and moves on.
`?tour=1` starts the scenario; a reload resumes it (per tab). Link "Take the
tour" to the page the first step lives on.

```html
<script>window.SYNTHIGY_TOUR = "/tour.json";</script>
<script src="/tools-rail.js"></script>
<script src="/scenario.js"></script>
```

`SynthigyScenario.tool("console")` runs one tool's tour (the dock chips);
`{ push: true }` hands back to the pusher's next step (movies' own tour).
`SynthigyScenario.register({ waits, actions })` adds named hooks.

## Wiring a demo

1. Serve `/tools-rail.js`, `/scenario.js`, `/tour.js` and `/chrome.js` from
   here (`application/javascript`, no-store), `/theme.css` (`text/css`), and
   `/tour.json` from `<domain>/`.
2. Add the config + script tags above before `</body>`.
3. Put `data-tour` attributes in the server-side render, and a "Take the
   tour" link to `?tour=1`.

## Local tooling build

```bash
../scripts/build-tooling.sh          # build → shared/vendor/tooling/ (gitignored)
../scripts/build-tooling.sh --clean  # back to the CDN
```

Demos serve `shared/vendor/tooling/` when it exists and the dock says "locally
built". project-management and chat check per request; movies and music at start, so
restart those.

The CDN version is `TOOLING_VERSION` at the top of `tools-rail.js`.

## Origins

The components log in through the "Synthigy Tools" client and return to the
page's own origin, which must be registered on that client.
`bootstrap-instance.sh` registers `http://localhost:5174`–`5177`; for any other
origin:

```bash
../scripts/add-tools-redirect.sh https://demo.example.com
```
