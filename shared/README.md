# shared

Browser scripts every demo serves from this directory, one copy for all of
them: no build step, no bundler, no dependency.

| File | What it is |
|---|---|
| `tools-rail.js` | Bottom-left dock that opens the `@synthigy/tooling` components (modeler, data console, log cockpit) against the demo's engine; each chip has a **tour** half |
| `scenario.js` | Runs tour scenarios: a demo's `<domain>/tour.json` and the built-in model / console / logs tours |
| `tour.js` | The engine under it, on driver.js (named steps, resume stack, page gates, lanes) |

## tools-rail.js

```html
<script>
  window.SYNTHIGY_TOOLS = {
    endpoint: "<the BFF's own SYNTHIGY_ENDPOINT>",   // the ENGINE, not this page
    xsql: ["/xsql/your-domain.xsql"],                // opens as console tabs
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
- **`demoLogin`** shows the `admin / admin` hint, since the components log in
  through the engine's page. Local/ephemeral instances only; `false` hides it.
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
  "name": "rls-demo",
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

1. Serve `/tools-rail.js`, `/scenario.js` and `/tour.js` from here
   (`application/javascript`, no-store), and `/tour.json` from `<domain>/`.
2. Add the config + script tags above before `</body>`.
3. Put `data-tour` attributes in the server-side render, and a "Take the
   tour" link to `?tour=1`.

## Local tooling build

```bash
../scripts/build-tooling.sh          # build → shared/vendor/tooling/ (gitignored)
../scripts/build-tooling.sh --clean  # back to the CDN
```

Demos serve `shared/vendor/tooling/` when it exists and the dock says "locally
built". rls-demo and chat check per request; movies and music at start, so
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
