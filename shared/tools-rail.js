// Bottom-right dock for the Synthigy web-component bundle, loaded straight
// from a CDN — see ./README.md. Config: window.SYNTHIGY_TOOLS = { endpoint,
// demoLogin, bundle, bundleCss }. No dependency, no build step; safe to
// include on any page.
//
// The three components present THEMSELVES: each is `position:fixed; inset:0`
// with `:host{display:none}` / `:host([open]){display:block}`, so the whole
// contract is one attribute. Opening is the host's call (set `open`); closing
// is the component's own (it clears `open` and dispatches a bubbling `close`).
// So this file deliberately has no overlay, frame or close button of its own —
// an earlier version wrapped each component in one and the component, being a
// full-viewport fixed layer, painted straight over that wrapper's close
// button, leaving no way to dismiss it. We set the attribute and listen.
//
// Login-return and silent-renew, and why a component remounts itself on load:
// the components do a full-page OAuth redirect (`synthigy.client.login/login-start`,
// `redirect_uri` = this page's own origin) and schedule background silent
// renewal via a hidden same-origin iframe that reloads this exact page.
// Neither completes on its own here, because the component that contains ALL
// of the OIDC callback-handling code is only ever created lazily, on a dock
// click. A redirect back, or a silent-renew iframe's load, would otherwise
// find no such component mounted anywhere and the pending login/renewal would
// simply be lost (the redirect strands a `?code&state` nobody reads; the
// iframe times out and silent renewal never keeps a session alive). So: the
// last-opened tool's key is remembered in `sessionStorage` (tab-scoped — gone
// once the tab closes, never cleared on close so background renewal keeps
// working across later reloads) and, on every load of this script, that tool
// is silently remounted — mounted but NOT opened, which is enough for its
// `connectedCallback` to run the same auth restore/callback logic a dock
// click would. It is only opened for real when this load is the top window
// landing back from a login redirect (not a hidden renewal iframe, not an
// ordinary reload) — the same URL-shape check auth.cljs's own
// `on-callback-page?` uses.
(function () {
  "use strict";

  var TOOLING_VERSION = "0.1.16";
  var CDN = "https://cdn.jsdelivr.net/npm/@synthigy/tooling@" + TOOLING_VERSION + "/dist/";
  var cfg = window.SYNTHIGY_TOOLS || {};
  var endpoint = cfg.endpoint || window.location.origin;
  var LAST_OPEN_KEY = "syn-tools-last-open";

  // Published CDN bundle by default — that IS the pitch. A demo overrides
  // with `bundle`/`bundleCss` when a locally built copy exists (each BFF
  // injects those only if examples/shared/vendor/tooling/ is on disk; see
  // examples/scripts/build-tooling.sh), which is how a component change is
  // tested live before @synthigy/tooling is republished.
  // `.xsql` sources to open the data console with — the very files the
  // demo's codegen reads, so the console shows the queries behind the page
  // instead of a blank buffer. Fetched once, handed to the modeler, which
  // forwards them to the console (seeded by @workspace name, never
  // clobbering an edited buffer).
  var xsqlUrls = cfg.xsql || [];
  var xsqlTexts = null;
  // The console seeds a workspace per source and dedupes by the source's own
  // flush-left `@workspace "name"` header — a source without one is SKIPPED
  // (no stable key, so re-opening would pile up copies). Not every demo's
  // .xsql carries one, and adding it there is not free: it is a codegen input,
  // and touching it invalidates that domain's pulled IR. So name it here
  // instead, from the file name — the tab identity is a console concern.
  function hasWorkspace(text) {
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (/^@workspace\s+"/.test(lines[i])) return true;
      if (/^\S/.test(lines[i])) return false;   // an op line ends the header
    }
    return false;
  }
  function withWorkspace(text, url) {
    if (hasWorkspace(text)) return text;
    var base = (url.split("?")[0].split("/").pop() || "queries").replace(/\.xsql$/, "");
    var name = base.replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
    return '@workspace "' + name + '"\n\n' + text;
  }
  function loadXsql() {
    if (!xsqlUrls.length) return Promise.resolve([]);
    if (xsqlTexts) return Promise.resolve(xsqlTexts);
    return Promise.all(xsqlUrls.map(function (u) {
      return fetch(u, { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) { return t == null ? null : withWorkspace(t, u); })
        .catch(function () { return null; });
    })).then(function (texts) {
      xsqlTexts = texts.filter(Boolean);
      return xsqlTexts;
    });
  }

  var bundleJs = cfg.bundle || (CDN + "tooling.js");
  var bundleCss = cfg.bundleCss || (CDN + "tooling.css");
  var isLocalBundle = !!cfg.bundle;

  // Each button opens its OWN element. All three self-configure from their
  // `endpoint` attribute (synthigy.bootstrap/ensure!, called from each one's
  // init!) into the same shared context atom, so whichever mounts first
  // configures it and the rest reuse it; the SDK connection underneath is
  // reference-counted (synthigy.connection).
  //
  // This used to route every button through `<synthigy-data-modeling>`,
  // deep-linking to its console/cockpit panels via sessionStorage, because
  // the modeler was then the only one that could configure itself. The
  // giveaway was closing the console: the panel hid and the modeler's ERD
  // canvas appeared underneath, instead of this page — the modeler had never
  // been closed. Each component is a `position:fixed; inset:0` layer, so
  // mounted on its own, closing it reveals the page it was opened from.
  var TOOLS = [
    { key: "model", label: "Model", glyph: "▦", accent: "#7c8cff", tag: "synthigy-data-modeling" },
    { key: "console", label: "Console", glyph: "⌘", accent: "#38d6b0", tag: "synthigy-data-console" },
    { key: "logs", label: "Logs", glyph: "≡", accent: "#f0b429", tag: "synthigy-log-cockpit" }
  ];

  // Bottom-LEFT by default: two of the four demos already own the
  // bottom-right corner (movies' debug ribbon at z-index 9999 — which simply
  // covered this dock — and music's toasts, which this dock covered in turn).
  // Bottom-left is clear in all of them. `position: "right"` overrides.
  var SIDE = cfg.position === "right" ? "right" : "left";

  // `admin`/`admin` is the seeded superuser on every demo instance
  // (bootstrap-instance.sh). The dock names it; the engine's sign-in page
  // names it too (shared/login-page). Override with
  // window.SYNTHIGY_TOOLS.demoLogin = "user / pw", or false to hide it.
  var DEMO_LOGIN = cfg.demoLogin !== undefined ? cfg.demoLogin : "admin / admin";


  function rememberOpen(key) {
    try { window.sessionStorage.setItem(LAST_OPEN_KEY, key); } catch (e) { /* private mode */ }
  }
  function lastOpen() {
    try { return window.sessionStorage.getItem(LAST_OPEN_KEY); } catch (e) { return null; }
  }
  function looksLikeOAuthReturn() {
    var search = window.location.search;
    return /state=/.test(search) && (/code=/.test(search) || /error=/.test(search));
  }

  var STYLE = [
    ".syn-tools-dock{position:fixed;bottom:16px;z-index:9997;display:flex;",
    "flex-direction:column;gap:8px;font-family:system-ui,sans-serif}",
    ".syn-tools-dock[data-side=left]{left:16px;align-items:flex-start}",
    ".syn-tools-dock[data-side=right]{right:16px;align-items:flex-end}",
    ".syn-tools-btn{display:flex;align-items:center;gap:9px;padding:9px 15px 9px 12px;",
    "border-radius:999px;border:1px solid rgba(255,255,255,.12);cursor:pointer;",
    "background:#14151b;color:#e7e9ee;font-size:13px;font-weight:600;",
    "letter-spacing:.01em;box-shadow:0 4px 14px rgba(0,0,0,.35);",
    "transition:transform .16s,background .16s,border-color .16s,box-shadow .16s}",
    ".syn-tools-btn:hover{background:#1b1d26;transform:translateY(-1px);",
    "border-color:color-mix(in srgb,var(--a) 55%,transparent);",
    "box-shadow:0 6px 18px rgba(0,0,0,.4),0 0 0 3px color-mix(in srgb,var(--a) 16%,transparent)}",
    ".syn-tools-btn:active{transform:translateY(0)}",
    ".syn-tools-chip{display:flex;align-items:stretch}",
    ".syn-tools-chip .syn-tools-btn{border-top-right-radius:0;border-bottom-right-radius:0;padding-right:12px}",
    ".syn-tools-tour{display:flex;align-items:center;gap:5px;padding:0 13px 0 10px;cursor:pointer;",
    "border-radius:0 999px 999px 0;border:1px solid rgba(255,255,255,.12);border-left:1px solid rgba(255,255,255,.06);",
    "background:#14151b;color:#8b8f99;font:600 11px system-ui,sans-serif;letter-spacing:.04em;",
    "box-shadow:0 4px 14px rgba(0,0,0,.35);transition:color .16s,background .16s,border-color .16s}",
    ".syn-tools-tour:hover{color:var(--a);background:#1b1d26;border-color:color-mix(in srgb,var(--a) 55%,transparent)}",
    ".syn-tools-tour[aria-busy=true]{cursor:progress;color:var(--a)}",
    ".syn-tools-btn[aria-busy=true]{cursor:progress}",
    ".syn-tools-btn[aria-busy=true] .g{animation:syn-tools-spin .9s linear infinite}",
    "@keyframes syn-tools-spin{to{transform:rotate(360deg)}}",
    ".syn-tools-btn .g{display:grid;place-items:center;width:20px;height:20px;",
    "border-radius:6px;font-size:13px;line-height:1;color:var(--a);",
    "background:color-mix(in srgb,var(--a) 15%,transparent)}",
    ".syn-tools-hint{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;",
    "color:#8b8f99;background:rgba(20,21,27,.9);padding:3px 9px;border-radius:999px;",
    "border:1px solid rgba(255,255,255,.08);line-height:1.5;white-space:nowrap;",
    "max-width:100%;cursor:default}",
    ".syn-tools-hint b{color:#c9ccd3;font-weight:600;font-family:ui-monospace,monospace}",
    ".syn-tools-hint i{font-style:normal;color:#6f7480}",
    "@media (prefers-reduced-motion:no-preference){",
    ".syn-tools-dock--invite .syn-tools-btn{animation:syn-tools-breathe 2.6s ease-in-out 3}",
    ".syn-tools-dock--invite .syn-tools-chip:nth-child(3) .syn-tools-btn{animation-delay:.12s}",
    ".syn-tools-dock--invite .syn-tools-chip:nth-child(4) .syn-tools-btn{animation-delay:.24s}}",
    "@keyframes syn-tools-breathe{0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.35)}",
    "50%{box-shadow:0 4px 14px rgba(0,0,0,.35),0 0 0 6px color-mix(in srgb,var(--a) 13%,transparent)}}"
  ].join("");

  var styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    var el = document.createElement("style");
    el.textContent = STYLE;
    document.head.appendChild(el);
  }

  var loaded = false;
  var loading = null;
  function loadBundle() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = bundleCss;
      document.head.appendChild(css);

      var script = document.createElement("script");
      script.src = bundleJs;
      script.onload = function () { loaded = true; resolve(); };
      script.onerror = function () { loading = null; reject(new Error("tooling bundle failed to load")); };
      document.head.appendChild(script);
    });
    return loading;
  }

  var dockEl = null;
  var mounted = {};

  // Create a tool's element once and leave it in the DOM. Mounted-but-closed
  // is a real state here: it is what lets a silent-renew iframe load, and a
  // post-redirect reload, run the component's auth code without anything
  // appearing on screen. `endpoint` is the engine's BASE url — every component
  // appends /data itself.
  function mount(tool, xsql) {
    if (mounted[tool.key]) return mounted[tool.key];
    var el = document.createElement(tool.tag);
    el.setAttribute("endpoint", endpoint);
    // Set BEFORE `open`: components read their props during init!, which runs
    // when they first see the open attribute.
    if (xsql && xsql.length) el.xsql = xsql;
    // The component clears its own `open` when the user closes it; this is
    // only so the dock knows, and so a stale `open` can never linger.
    el.addEventListener("close", function () {
      el.removeAttribute("open");
      notify("close", tool.key);
    });
    document.body.appendChild(el);
    mounted[tool.key] = el;
    return el;
  }

  // A page can react to a tool opening or closing without knowing anything
  // about the components — the movies tour uses `synthigy-tools:close` to
  // pick its guided tour back up where the visitor left it.
  function notify(kind, key) {
    try {
      document.dispatchEvent(new CustomEvent("synthigy-tools:" + kind, { detail: { tool: key } }));
    } catch (e) { /* ancient browser — the dock still works */ }
  }

  function openTool(tool, show) {
    ensureStyle();
    rememberOpen(tool.key);
    // Never rethrow: a resumed (not user-clicked) mount fails silently on a
    // network hiccup rather than leaving an unhandled rejection — nobody
    // downstream awaits this call.
    var btn = show !== false && dockEl && dockEl.querySelector('[data-tour="rail:' + tool.key + '"]');
    if (btn) btn.setAttribute("aria-busy", "true");
    Promise.all([loadBundle(), loadXsql()]).then(function (r) {
      if (btn) btn.removeAttribute("aria-busy");
      var el = mount(tool, r[1]);
      if (show !== false) {
        el.setAttribute("open", "");
        notify("open", tool.key);
        if (tool.key === "model") openDataset(el);
      }
    }, function (err) {
      if (btn) btn.removeAttribute("aria-busy");
      if (show !== false) window.alert("Couldn't load Synthigy tooling: " + err.message);
    });
  }

  // `dataset`: the modeler starts on an empty canvas until a dataset is
  // picked, which a first-time visitor (and a tour step anchored on an entity)
  // never gets past. Name the demo's dataset and the rail picks it through the
  // modeler's own Open Dataset list — only while the canvas is still empty, so
  // a dataset the visitor opened is never replaced. Behind Sign In nothing is
  // there to click; the open after the sign-in redirect comes back here.
  function openDataset(el) {
    var name = cfg.dataset;
    if (!name) return;
    var tries = 0, asked = false;
    (function poll() {
      if (!el.hasAttribute("open") || ++tries > 200) return;
      var root = el.shadowRoot;
      if (root) {
        if (root.querySelector(".entity-box")) return;
        var items = root.querySelectorAll(".dataset-item");
        for (var i = 0; i < items.length; i++) {
          var label = items[i].querySelector(".dataset-item-name");
          if (label && label.textContent.trim() === name) { items[i].click(); return; }
        }
        // The first action-bar button is Open Dataset.
        var open = !items.length && !asked && root.querySelector(".action-btn");
        if (open) { open.click(); asked = true; }
      }
      setTimeout(poll, 100);
    })();
  }

  function buildDock() {
    ensureStyle();
    var dock = document.createElement("div");
    dockEl = dock;
    dock.className = "syn-tools-dock" + (lastOpen() ? "" : " syn-tools-dock--invite");
    dock.setAttribute("data-side", SIDE);

    // One short line — it sits over page content, so it stays out of the way;
    // the full sentence is the tooltip.
    var hint = document.createElement("div");
    hint.className = "syn-tools-hint";
    hint.title = (isLocalBundle
      ? "Locally built @synthigy/tooling (not the CDN) — examples/scripts/build-tooling.sh"
      : "The published @synthigy/tooling bundle, loaded from a CDN — not demo code") +
      (DEMO_LOGIN ? ". Sign in with " + DEMO_LOGIN : "");
    hint.innerHTML = (DEMO_LOGIN ? "sign in <b>" + DEMO_LOGIN + "</b>" : "@synthigy/tooling") +
      (isLocalBundle ? " <i>· local build</i>" : "");
    dock.appendChild(hint);

    TOOLS.forEach(function (tool) {
      var chip = document.createElement("div");
      chip.className = "syn-tools-chip";
      chip.style.setProperty("--a", tool.accent);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "syn-tools-btn";
      btn.setAttribute("data-tour", "rail:" + tool.key);
      btn.innerHTML = '<span class="g">' + tool.glyph + "</span><span>" + tool.label + "</span>";
      btn.addEventListener("click", function () {
        dock.classList.remove("syn-tools-dock--invite");
        openTool(tool);
      });

      var tourBtn = document.createElement("button");
      tourBtn.type = "button";
      tourBtn.className = "syn-tools-tour";
      tourBtn.title = "Take the " + tool.label.toLowerCase() + " tour";
      tourBtn.setAttribute("data-tour", "rail-tour:" + tool.key);
      tourBtn.textContent = "tour";
      tourBtn.addEventListener("click", function () {
        dock.classList.remove("syn-tools-dock--invite");
        runToolTour(tool.key, tourBtn);
      });

      chip.appendChild(btn);
      chip.appendChild(tourBtn);
      dock.appendChild(chip);
    });
    document.body.appendChild(dock);
  }

  // Programmatic open — same effect as a dock click, for a page that wants to
  // hand the visitor straight to a tool (e.g. the movies guide's "Open it in
  // the modeler" callout after a deploy). key is "model" | "console" | "logs";
  // returns false for an unknown key or before the dock exists.
  function openByKey(key) {
    for (var i = 0; i < TOOLS.length; i++) {
      if (TOOLS[i].key === key) {
        if (dockEl) dockEl.classList.remove("syn-tools-dock--invite");
        openTool(TOOLS[i]);
        return true;
      }
    }
    return false;
  }
  cfg.open = openByKey;
  window.SYNTHIGY_TOOLS = cfg;

  function resumePendingAuth() {
    var key = lastOpen();
    if (!key) return;
    var tool = null;
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].key === key) tool = TOOLS[i];
    if (!tool) return;
    // Top window freshly back from a real login redirect: open it visibly —
    // that is what the visitor was doing before the redirect took them away.
    // Anything else mounts without opening (see the header comment).
    var isTop = (window.self === window.top);
    openTool(tool, isTop && looksLikeOAuthReturn());
  }

  // The silent-renew iframe, answered without loading the bundle: the same
  // postMessage synthigy.client.login/silent-callback! sends.
  function answerSilentRenew() {
    if (window.self === window.top || !looksLikeOAuthReturn()) return false;
    window.parent.postMessage(
      { source: "synthigy-login", url: window.location.href },
      window.location.origin);
    return true;
  }

  // Tool tours run on shared/scenario.js, which a demo page normally loads
  // itself; fetched here only when it is missing.
  var scenarioLoad = null;
  function loadScenario() {
    if (window.SynthigyScenario) return Promise.resolve();
    if (scenarioLoad) return scenarioLoad;
    scenarioLoad = new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = "/scenario.js";
      el.onload = resolve;
      el.onerror = function () { scenarioLoad = null; reject(new Error("/scenario.js failed to load")); };
      document.head.appendChild(el);
    });
    return scenarioLoad;
  }
  function runToolTour(key, btn) {
    if (btn) btn.setAttribute("aria-busy", "true");
    loadScenario().then(function () { return window.SynthigyScenario.tool(key); })
      .then(function () { if (btn) btn.removeAttribute("aria-busy"); },
            function (err) {
              if (btn) btn.removeAttribute("aria-busy");
              window.alert("Couldn't load the tour: " + err.message);
            });
  }
  cfg.tour = runToolTour;

  function init() {
    if (answerSilentRenew()) return;
    // Any other iframe load (there shouldn't be one) gets no dock either —
    // the dock is for the visitor, and the visitor is in the top window.
    if (window.self === window.top) buildDock();
    resumePendingAuth();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
