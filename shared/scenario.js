// Scenario runner: one declarative tour format for every demo, on tour.js and
// driver.js (both loaded on demand). See ./README.md for the format.
//
//   window.SYNTHIGY_TOUR = "/tour.json"        // or the scenario object inline
//   ?tour=1                                    // starts it
//   SynthigyScenario.tool("console")           // a tool's own tour (dock chips)
//
// A scenario is { name, steps, tools }. Page steps anchor on data-tour="…";
// tool steps open a tool and anchor inside its shadow root by named anchor;
// `{ tool: "logs" }` includes that tool's built-in tour. `tools` rewrites
// single steps of the built-in tool tours.
(function () {
  "use strict";

  if (window.SynthigyScenario) return;

  var DRIVER = "https://cdnjs.cloudflare.com/ajax/libs/driver.js/1.8.0/";
  var TAG = { model: "synthigy-data-modeling", console: "synthigy-data-console", logs: "synthigy-log-cockpit" };
  var LABEL = { model: "modeler", console: "console", logs: "log cockpit" };

  // ── tools: anchors, readiness ────────────────────────────────────────────

  function host(key) { return document.querySelector(TAG[key]); }
  function find(key, sel) {
    var h = host(key);
    return h && h.shadowRoot ? h.shadowRoot.querySelector(sel) : null;
  }

  // The console runs XSQL from its op chips; `.execute-btn` exists only on
  // the mutate/SQL surfaces.
  function consoleRunTarget() {
    return find("console", ".execute-btn") || find("console", ".buffer-op:not(.buffer-op--batch)");
  }

  var ANCHORS = {
    model: {
      canvas: [".modeling-container"],
      entity: [".entity-box", ".modeling-container"],
      deploy: ['.action-btn[data-tooltip="Deploy"]', ".modeling-container"],
    },
    console: {
      tabs: [".query-tabs"],
      run: [consoleRunTarget, ".buffer-ops"],
      results: [".result-header", ".buffer-ops"],
    },
    logs: {
      lenses: [".lc-lens-tabs"],
      toolbar: [".lc-toolbar"],
      rows: [".lc-stream", ".lens-table-wrap", ".lc-empty", ".lc-toolbar"],
    },
  };
  var READY = { model: ".entity-box", console: ".query-tabs", logs: ".lc-lens-tabs" };

  function anchorFn(key, name, selector) {
    var list = selector ? [selector] : (ANCHORS[key][name] || ANCHORS[key][Object.keys(ANCHORS[key])[0]]);
    return function () {
      for (var i = 0; i < list.length; i++) {
        var el = typeof list[i] === "function" ? list[i]() : find(key, list[i]);
        if (el) return el;
      }
      return null;
    };
  }

  // The tools' shared gate marks itself; only the Sign In state blocks a
  // tour ("connecting…" resolves on its own, "can't reach" says so itself).
  // Tooling before 0.1.14 renders only the Sign In screen (unmarked) and
  // nothing while pending.
  function gateStatus(key) {
    var g = find(key, ".sy-gate");
    if (g) return g.getAttribute("data-status");
    return find(key, ".sy-login-mark") ? "login" : null;
  }
  function isOpen(key) { var h = host(key); return !!(h && h.hasAttribute("open")); }
  function open(key) {
    var tools = window.SYNTHIGY_TOOLS;
    if (!isOpen(key) && tools && tools.open) tools.open(key);
  }
  var closingByTour = false;
  function close(key) {
    var h = host(key);
    if (!h) return;
    closingByTour = true;
    try { h.removeAttribute("open"); } catch (e) { console.warn("[scenario] close threw", e); }
    closingByTour = false;
  }

  // ── built-in tool tours, in the scenario format ──────────────────────────

  var HINT = function (text) { return '<p class="syn-tour-hint">' + text + "</p>"; };

  var TOOL_TOURS = {
    model: [
      { id: "erd-is-the-db", tool: "model", anchor: "canvas", title: "The diagram is the database",
        html: "Entities with typed attributes and the relations between them. Deploying a model is what creates the tables, the <code>/data</code> endpoints and the permissions — nobody writes a migration, a schema file or an API." },
      { id: "versioned-and-deployed", tool: "model", anchor: "entity", title: "You change the model, not the schema",
        html: "Add an attribute, rename a relation, split an entity — every edit is a tracked version you can compare and roll back. The database follows the diagram, never the other way round." },
      { id: "permissions-in-model", tool: "model", anchor: "deploy", title: "Models travel, and their permissions travel with them",
        html: "Export a model, deploy it on another instance — entities, relations and the IAM rules guarding them move as one piece."
          + HINT("Deploy stays greyed out until something has changed since the last deploy.") },
    ],
    console: [
      { id: "workspaces", tool: "console", anchor: "tabs", title: "The data layer is these files",
        html: "These tabs are the app's <code>.xsql</code> files — the same ones codegen turns into the typed SDK the pages call. No resolvers, no controllers, no ORM: the deployed model is already the API." },
      { id: "run", tool: "console", anchor: "run", title: "One query language, every client",
        html: "Run it — this is the same <code>/data</code> call the app makes, and the same file the JS, Python, Go, Clojure and PHP SDKs generate typed clients from."
          + HINT("Reads are yours to play with. A <code>@purge</code> really deletes what it matches."),
        action: { label: "Run it", do: "run-query" }, wait: "console-ran" },
      { id: "results", tool: "console", anchor: "results", title: "The exact call your app makes",
        html: "Whatever just ran is the identical <code>/data</code> call behind the page — no separate API, no mock data. A write here repaints every page watching it." },
    ],
    logs: [
      { id: "lenses", tool: "logs", anchor: "lenses", title: "One log, many lenses",
        html: "Everything the engine does lands in one store. Each lens is a view over it: traffic, sign-ins, dataset changes, the system itself." },
      { id: "window", tool: "logs", anchor: "toolbar", title: "Live, or any window back",
        html: "Follow it live, or pick a time window and a limit. Filters narrow by level, user, client or request." },
      { id: "rows", tool: "logs", anchor: "rows", title: "The calls you just made are here",
        html: "Every request the demo sent — with its user, operation and timing. Open a row to see what it carried; a request id follows it through every line it wrote." },
    ],
  };

  // ── named hooks: waits and actions a step refers to by name ──────────────

  var WAITS = {
    "console-ran": function (api) {
      var header = find("console", ".result-header");
      if (!header) return null;
      var baseline = header.textContent;
      var mo = new MutationObserver(function () {
        if (header.textContent === baseline || !find("console", ".result-count")) return;
        api.refresh();
        api.next();
      });
      mo.observe(header, { childList: true, subtree: true, characterData: true });
      return function () { mo.disconnect(); };
    },
  };
  var ACTIONS = {
    "run-query": function () { var b = consoleRunTarget(); if (b) b.click(); },
  };

  // ── scenario → tour.js definitions ───────────────────────────────────────

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function popoverOf(step) {
    var html = step.html != null ? step.html : esc(step.body);
    if (step.action) {
      html += '<div class="syn-tour-actions"><button type="button" data-act="' + esc(step.action["do"]) + '">'
        + esc(step.action.label || "Do it") + "</button></div>";
    }
    return { title: step.title || "", description: html };
  }

  // `wait: true` advances on the next change inside the step's own element,
  // `{ watch: "<selector>" }` inside another one (what the click repaints);
  // a string names a hook in WAITS.
  function armOf(step, element) {
    if (!step.wait) return null;
    if (typeof step.wait === "string") return WAITS[step.wait] || null;
    var watch = step.wait.watch;
    return function (api) {
      var el = watch ? document.querySelector(watch)
        : typeof element === "function" ? element() : document.querySelector(element);
      if (!el) return null;
      var mo = new MutationObserver(function () { api.next(); });
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      return function () { mo.disconnect(); };
    };
  }

  function pageStep(step, i) {
    var element = step.target ? '[data-tour="' + step.target + '"]' : undefined;
    return {
      id: step.id || step.target || "step-" + i,
      page: step.page ? new RegExp(step.page) : undefined,
      element: element,
      popover: popoverOf(step),
      arm: armOf(step, element),
    };
  }

  var laneTool = {};   // lane name → tool key

  function defineLane(name, key, steps) {
    laneTool[name] = key;
    var compiled = steps.map(function (step, i) {
      var element = anchorFn(key, step.anchor, step.selector);
      return {
        id: step.id || step.anchor || "step-" + i,
        element: element,
        popover: popoverOf(step),
        arm: armOf(step, element),
      };
    });
    SynthigyTour().define(name, compiled, {
      actions: ACTIONS,
      canRun: function () { return isOpen(key) && gateStatus(key) == null; },
      onEnd: function () { finishLane(key); },
      stopPrompt: "Stop the tour?",
      driver: driverOpts("syn-tour", "Done"),
    });
  }

  // A lane is done: back to whoever pushed it. Only a dock-chip tour with
  // nothing underneath leaves its tool open.
  function finishLane(key, closedByVisitor) {
    var Tour = SynthigyTour();
    var s = Tour.stack();
    var below = s.length > 1 ? s[s.length - 2].tour : null;
    var chip = below && below.indexOf("chip:") === 0;
    if (!closedByVisitor && !(chip && s.length === 2)) close(key);
    if (chip) Tour.unwind(2);
    else Tour.pop({ advance: true });
  }

  // Waits for the tool's real content: "ready", "gated" (the Sign In screen:
  // the stack stays put and the sign-in reload resumes it), or "empty".
  var waiting = {};
  function whenReady(key, cb) {
    var token = {};
    waiting[key] = token;
    var tries = 0;
    (function poll() {
      if (waiting[key] !== token) return;
      var gate = gateStatus(key);
      if (gate === "login") { delete waiting[key]; cb("gated"); return; }
      if (gate === "unreachable") { delete waiting[key]; cb("unreachable"); return; }
      if (find(key, READY[key])) { delete waiting[key]; cb("ready"); return; }
      if (++tries > 150) { delete waiting[key]; cb("empty"); return; }
      setTimeout(poll, 100);
    })();
  }

  function note(text) {
    var el = document.createElement("div");
    el.className = "syn-tour-note";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  // An `enter` step: open the tool, then push its lane once it shows content.
  // The answer only counts if the tour is still on this step when it comes.
  function enterTool(key, lane) {
    return function (api) {
      var Tour = SynthigyTour();
      var at = Tour.current();
      api.pause();
      open(key);
      whenReady(key, function (state) {
        var now = Tour.current();
        if (!at || !now || now.tour !== at.tour || now.step !== at.step) return;
        if (state === "ready") { Tour.push(lane); return; }
        if (state === "gated") return;
        var s = Tour.stack();
        if (!(s.length === 1 && s[0].tour === "chip:" + key)) close(key);
        note(state === "unreachable"
          ? "Can't reach the engine, so the " + LABEL[key] + " tour can't run."
          : "Nothing to show in the " + LABEL[key] + " yet — is a model deployed?");
        Tour.skip();
      });
    };
  }

  function withOverrides(key, steps) {
    var o = (scenario && scenario.tools && scenario.tools[key]) || {};
    return steps.map(function (step) {
      var p = o[step.id];
      if (!p) return step;
      var copy = {};
      for (var k in step) copy[k] = step[k];
      for (var j in p) copy[j] = p[j];
      if (p.body != null && p.html == null) delete copy.html;
      return copy;
    });
  }

  function defineTools() {
    Object.keys(TOOL_TOURS).forEach(function (key) {
      defineLane("tool:" + key, key, withOverrides(key, TOOL_TOURS[key]));
      var enter = [{ id: "enter", enter: enterTool(key, "tool:" + key) }];
      // chip: started from the dock; enter: pushed by a demo's own tour
      SynthigyTour().define("chip:" + key, enter, {});
      SynthigyTour().define("enter:" + key, enter, {});
    });
  }

  // Consecutive tool steps for the same tool become one lane; a bare
  // `{ tool }` (optionally with `only`) includes the built-in tour.
  function defineScenario(sc) {
    var name = sc.name || "scenario";
    var main = [];
    var steps = sc.steps || [];
    var i = 0;
    while (i < steps.length) {
      var step = steps[i];
      if (!step.tool) { main.push(pageStep(step, i)); i++; continue; }
      var key = step.tool;
      if (!TOOL_TOURS[key]) { console.warn("[scenario] unknown tool " + key); i++; continue; }
      var lane, laneSteps;
      if (!step.anchor && !step.selector && !step.title) {
        laneSteps = withOverrides(key, TOOL_TOURS[key]);
        if (step.only) laneSteps = laneSteps.filter(function (s) { return step.only.indexOf(s.id) >= 0; });
        lane = name + "/" + i;
        i++;
      } else {
        laneSteps = [];
        while (i < steps.length && steps[i].tool === key && (steps[i].anchor || steps[i].selector || steps[i].title)) {
          laneSteps.push(steps[i]);
          i++;
        }
        lane = name + "/" + (i - laneSteps.length);
      }
      if (!laneSteps.length) continue;
      defineLane(lane, key, laneSteps);
      main.push({ id: "enter-" + lane, enter: enterTool(key, lane) });
    }
    SynthigyTour().define(name, main, {
      actions: ACTIONS,
      stopPrompt: "Stop the tour?",
      driver: driverOpts("syn-tour", "Done"),
    });
    return name;
  }

  function driverOpts(cls, done) {
    return {
      showProgress: true,
      progressText: "STEP {{current}} / {{total}}",
      nextBtnText: "Next →",
      prevBtnText: "← Back",
      doneBtnText: done,
      allowClose: true,
      overlayColor: "#07080b",
      overlayOpacity: 0.55,
      popoverClass: cls,
      smoothScroll: true,
      stagePadding: 8,
      stageRadius: 10,
    };
  }

  // ── loading ──────────────────────────────────────────────────────────────

  function SynthigyTour() { return window.SynthigyTour; }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error(src + " failed to load")); };
      document.head.appendChild(el);
    });
  }

  var engine = null;
  function ensureEngine() {
    if (engine) return engine;
    var hasDriver = window.driver && window.driver.js && window.driver.js.driver;
    if (!hasDriver && !document.querySelector('link[href*="driver.min.css"]')) {
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = DRIVER + "driver.min.css";
      document.head.appendChild(css);
    }
    ensureStyle();
    engine = (hasDriver ? Promise.resolve() : loadScript(DRIVER + "driver.js.iife.min.js"))
      .then(function () { return window.SynthigyTour ? null : loadScript("/tour.js"); });
    engine.catch(function () { engine = null; });
    return engine;
  }

  var scenario = null;
  var scenarioName = null;
  var ready = null;
  function ensureDefined() {
    if (ready) return ready;
    var src = window.SYNTHIGY_TOUR;
    var load = typeof src === "string"
      ? fetch(src, { cache: "no-store" }).then(function (r) {
          if (!r.ok) throw new Error(src + " answered " + r.status);
          return r.json();
        })
      : Promise.resolve(Array.isArray(src) ? { steps: src } : (src || {}));
    ready = Promise.all([ensureEngine(), load]).then(function (r) {
      scenario = r[1] || {};
      defineTools();
      if (scenario.steps && scenario.steps.length) scenarioName = defineScenario(scenario);
    });
    ready.catch(function (err) { ready = null; console.warn("[scenario]", err); });
    return ready;
  }

  // ── public ───────────────────────────────────────────────────────────────

  function start() {
    return ensureDefined().then(function () {
      if (scenarioName) SynthigyTour().start(scenarioName);
      return !!scenarioName;
    });
  }

  // A tool's own tour. Inside a running tour it is pushed; `push` makes the
  // pusher advance when it ends (a demo tour handing off to a tool).
  function tool(key, opts) {
    opts = opts || {};
    return ensureDefined().then(function () {
      var Tour = SynthigyTour();
      var at = Tour.current();
      if (waiting[key] || (at && (at.tour === "chip:" + key || at.tour === "enter:" + key
                                  || laneTool[at.tour] === key))) return;
      if (opts.push) Tour.push("enter:" + key);
      else if (Tour.current()) Tour.push("chip:" + key);
      else Tour.start("chip:" + key);
    });
  }

  function register(ext) {
    ext = ext || {};
    for (var w in ext.waits || {}) WAITS[w] = ext.waits[w];
    for (var a in ext.actions || {}) ACTIONS[a] = ext.actions[a];
  }

  // Closing a tool by its own ✕: a running lane ends as if walked to the end;
  // a tour still waiting on that tool (behind Sign In) gives it up.
  document.addEventListener("synthigy-tools:close", function (e) {
    var key = e.detail && e.detail.tool;
    var Tour = SynthigyTour();
    if (!key || !Tour || closingByTour) return;
    delete waiting[key];
    var at = Tour.current();
    if (!at) return;
    if (laneTool[at.tour] === key) { finishLane(key, true); return; }
    if (at.tour === "chip:" + key) {
      if (Tour.stack().length > 1) Tour.unwind(1); else Tour.stop();
      return;
    }
    var placeholder = /^enter-(.+)$/.exec(at.step || "");
    if (at.tour === "enter:" + key || (placeholder && laneTool[placeholder[1]] === key)) Tour.skip();
  });

  var STYLE = [
    ".syn-tour{background:#14151b;color:#e7e9ee;border:1px solid rgba(255,255,255,.12);",
    "border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);max-width:360px;font-family:system-ui,sans-serif}",
    ".syn-tour .driver-popover-title{font-size:15px;font-weight:700;color:#fff}",
    ".syn-tour .driver-popover-description{font-size:13px;line-height:1.55;color:#c9ccd3}",
    ".syn-tour code{font-family:ui-monospace,monospace;font-size:12px;color:#f0c94a}",
    ".syn-tour .driver-popover-progress-text{color:#6f7480;font-size:11px;letter-spacing:.08em}",
    /* driver.js renders a <footer>: a page's own `footer` rule (movies: border-top) leaks in unless this sets it */
    ".syn-tour .driver-popover-footer{margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}",
    ".syn-tour .driver-popover-navigation-btns{gap:8px}",
    ".syn-tour .driver-popover-navigation-btns button+button{margin-left:0}",
    ".syn-tour .driver-popover-footer button{background:#1b1d26;color:#e7e9ee;border:1px solid rgba(255,255,255,.14);",
    "border-radius:6px;padding:5px 12px;font-size:12px;line-height:1.3;text-shadow:none;",
    "transition:background .15s,border-color .15s}",
    ".syn-tour .driver-popover-footer button:hover{background:#242733;border-color:rgba(255,255,255,.26)}",
    ".syn-tour .driver-popover-footer button:focus-visible{outline:2px solid rgba(240,201,74,.55);outline-offset:2px}",
    ".syn-tour .driver-popover-footer .driver-popover-next-btn{background:#f0c94a;color:#14151b;border-color:#f0c94a;font-weight:600}",
    ".syn-tour .driver-popover-footer .driver-popover-next-btn:hover{background:#f5d56b;border-color:#f5d56b}",
    ".syn-tour .driver-popover-close-btn{color:#8b8f99}",
    ".syn-tour .driver-popover-arrow-side-left{border-left-color:#14151b}",
    ".syn-tour .driver-popover-arrow-side-right{border-right-color:#14151b}",
    ".syn-tour .driver-popover-arrow-side-top{border-top-color:#14151b}",
    ".syn-tour .driver-popover-arrow-side-bottom{border-bottom-color:#14151b}",
    ".syn-tour-hint{margin:10px 0 0;font-size:12px;color:#8b8f99}",
    ".syn-tour-actions{margin-top:10px}",
    ".syn-tour-actions button{background:transparent;color:#f0c94a;border:1px solid #f0c94a;border-radius:6px;",
    "padding:4px 12px;font-size:12px;cursor:pointer}",
    ".syn-tour-note{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;",
    "background:#14151b;color:#e7e9ee;border:1px solid rgba(255,255,255,.14);border-radius:999px;",
    "padding:8px 16px;font:13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)}",
    /* driver.js turns pointer events off outside the spotlit element, which
       lives in a shadow root the page's CSS can't reach: keep the tools live. */
    ".driver-active synthigy-data-modeling,.driver-active synthigy-data-console,",
    ".driver-active synthigy-log-cockpit{pointer-events:auto}",
  ].join("");

  function ensureStyle() {
    if (document.getElementById("syn-tour-style")) return;
    var s = document.createElement("style");
    s.id = "syn-tour-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // `?tour=1` starts the scenario; a tour already on this tab's stack (a
  // reload, the return from a sign-in) resumes.
  function boot() {
    if (window.self !== window.top) return;
    var armed = !!window.SYNTHIGY_TOUR && new URL(location.href).searchParams.get("tour") === "1";
    var pending = false;
    try { pending = !!sessionStorage.getItem("syn-tour"); } catch (e) { /* private mode */ }
    if (!armed && !pending) return;
    ensureDefined().then(function () {
      var Tour = SynthigyTour();
      if (armed && scenarioName && Tour.armedBy("tour")) { Tour.start(scenarioName); return; }
      Tour.resume();
    });
  }

  window.SynthigyScenario = {
    start: start, tool: tool, register: register, ready: ensureDefined,
    anchors: ANCHORS, tours: TOOL_TOURS,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
