// The movies real-time tour — its STEPS and nothing else. The sequencing
// (named steps, the resume stack, page gates, arming) lives in the shared
// engine, examples/shared/tour.js, served here as /tour.js and loaded first
// by views/layout.ts.
//
// Written against the engine directly rather than as a scenario
// (examples/shared/scenario.js): its steps arm on page-specific watchers,
// open companion windows and hand off across pages. Tool tours come from the
// scenario runner; this file's wording for them is in ../../tour.json.
//
// The step list spans THREE pages (movies list → movie detail → dashboard).
// Two steps hand off by naming the next step and navigating; the rest
// advance on Next or on an `arm()` watcher noticing the visitor did the
// thing the step asked for.
(function () {
  "use strict";

  var Tour = window.SynthigyTour;
  if (!Tour) { console.warn("[guide-tour] /tour.js did not load"); return; }

  function guidePhase() { return document.body.getAttribute("data-guide-phase"); }
  // The callout is always in the guide's markup and only shown once deployed.
  function modelDeployed() {
    var p = guidePhase();
    var callout = document.querySelector('[data-tour="deployed-callout"]');
    return p === "deployed" || p === "importing" || p === "ready"
      || !!(callout && callout.offsetParent);
  }
  function scenario() { return window.SynthigyScenario; }
  function loggedIn() { return document.body.getAttribute("data-user") === "1"; }
  function movieXidFromPath() {
    var m = location.pathname.match(/^\/movies\/([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  }

  // ── auto-advance watchers ────────────────────────────────────────────────
  // Each returns its own dispose function; the engine calls it when the step
  // ends, however it ends.

  // Fires once the given pill count RISES above whatever it was when the
  // step armed — robust to however many of that kind were already open (a
  // companion window opened earlier in the tour, a stray tab from before the
  // tour started), unlike a fixed threshold that assumes a known baseline.
  // A page that has only just loaded is not counted in the pill yet — its own
  // SSE registers a moment after the tour arms, and a naive baseline reads
  // that as "someone else joined" and advances instantly. So the baseline
  // keeps re-latching for a short settling window; a human opening a phone or
  // another browser is always slower than that.
  function whenPresenceIncrease(api, attr) {
    var el = document.getElementById("presence");
    if (!el) return null;
    var SETTLE_MS = 2500;
    var armedAt = Date.now();
    var read = function () { return parseInt(el.getAttribute(attr) || "0", 10); };
    var baseline = read();
    var mo = new MutationObserver(function () {
      var now = read();
      if (Date.now() - armedAt < SETTLE_MS) { baseline = now; return; }
      if (now > baseline) api.next();
    });
    mo.observe(el, { attributes: true });
    return function () { mo.disconnect(); };
  }

  // Any additional watcher satisfies the step — a companion window, a second
  // tab, or a phone on the shared link. The visitor picks; the claim is the
  // same either way, and nothing here should force a popup.
  function whenAnySurfaceJoins(api) {
    var el = document.getElementById("presence");
    if (!el) return null;
    var attrs = ["data-p-movies", "data-p-detail", "data-p-dashboard", "data-p-guide"];
    var SETTLE_MS = 2500;
    var armedAt = Date.now();
    var total = function () {
      var n = 0;
      attrs.forEach(function (a) { n += parseInt(el.getAttribute(a) || "0", 10); });
      return n;
    };
    var baseline = total();
    var mo = new MutationObserver(function () {
      var now = total();
      // This page's own connection registers a moment after the step arms;
      // without the settling window it would count itself as company.
      if (Date.now() - armedAt < SETTLE_MS) { baseline = now; return; }
      if (now > baseline) api.next();
    });
    mo.observe(el, { attributes: true });
    return function () { mo.disconnect(); };
  }

  // One popup per click is all a browser grants without the popup
  // permission — window.open() consumes the click's transient activation and
  // a second call returns null, silently — so each companion has its own
  // button, and the step won't advance until both are counted.
  function openCompanion(kind, url) {
    var w = Math.min(720, Math.round(screen.availWidth / 2));
    var h = Math.round(screen.availHeight / 2);
    var left = screen.availWidth - w;
    var top = kind === "dashboard" ? h : 0;
    return window.open(url, kind + "-companion",
      "popup,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
  }

  // Datastar morphs the detail card rather than replacing it, so watch the
  // card's own subtree — a childList watcher on its parent never fires.
  // driver.js puts a popover below its target and, when that does not fit,
  // slides it UP over the target. On a 720px-tall window the rate step's
  // popover is a few pixels too tall for the room under the form, so it lands
  // on the Submit button the step is telling you to press (caught by
  // tests/tour.browser.mjs, which runs at exactly that height). Scrolling the
  // page down by the shortfall moves the target up and gives the popover its
  // room; refresh() repositions it. Runs after the popover exists and after
  // driver's own smoothScroll has settled — both are why this polls.
  function keepTargetClear(selector, api, tries) {
    var n = tries || 0;
    var el = document.querySelector(selector);
    var pop = document.querySelector(".driver-popover");
    var scroller = document.querySelector(".page-scroll");
    if (!el || !scroller || !pop || !pop.getBoundingClientRect().height) {
      if (n > 40) return;
      requestAnimationFrame(function () { keepTargetClear(selector, api, n + 1); });
      return;
    }
    var short = (pop.getBoundingClientRect().height + 28)
              - (window.innerHeight - el.getBoundingClientRect().bottom);
    if (short > 0) {
      var was = scroller.scrollTop;
      scroller.scrollTop = was + short;
      if (scroller.scrollTop !== was) api.refresh();
    }
    // driver's scroll may still be animating; check once more when it is done.
    if (n < 2) setTimeout(function () { keepTargetClear(selector, api, n + 2); }, 400);
  }

  // The footer's crowd button relabels itself ("Crowd · 12 ratings · 9s")
  // from the `crowd` signal the moment the server starts one — whoever
  // pressed it, in whichever tab.
  function whenCrowdStartsUnlockNext(api) {
    var btn = document.querySelector('[data-tour="crowd"]');
    if (!btn) return null;
    var check = function () { if (/Crowd ·/.test(btn.textContent || "")) api.showButton("next"); };
    var mo = new MutationObserver(check);
    mo.observe(btn, { childList: true, characterData: true, subtree: true });
    check();
    return function () { mo.disconnect(); };
  }

  function whenRatedUnlockNext(api, selector) {
    var card = document.querySelector(selector);
    if (!card) return null;
    var mo = new MutationObserver(function () {
      api.showButton("next");
    });
    mo.observe(card, { childList: true, characterData: true, subtree: true });
    return function () { mo.disconnect(); };
  }

  // ── the steps ────────────────────────────────────────────────────────────

  var STEPS = [
    {
      id: "list-is-live",
      page: /^\/movies$/,
      element: '[data-tour="movies-list"]',
      popover: {
        title: "Every query here is a subscription",
        description: "This list is <code>Movie.watchList()</code> — the same <code>movie/list</code> query in <code>movies.xsql</code>, with <code>@watch</code> on it. Nobody wrote a channel, a topic or an invalidation. Pick a movie to continue.",
      },
      onNext: function (api) {
        var first = document.querySelector('[data-tour="movie-link"]');
        if (first) { api.setStep("companions"); location.href = first.getAttribute("href"); }
      },
    },
    {
      id: "companions",
      page: /^\/movies\/[^/]+$/,
      element: '[data-tour="rate"]',
      popover: {
        title: "Put another live surface next to this one",
        description: 'Keep this tab, and add at least one more watcher. Any of these will do — a window beside this page, or someone else\'s phone.'
          + '<div class="tour-actions">'
          + '<ty-button size="sm" flavor="primary" appearance="outlined" data-act="open-list">Open the list</ty-button>'
          + '<ty-button size="sm" flavor="primary" appearance="outlined" data-act="open-dashboard">Open the dashboard</ty-button>'
          + '<ty-button size="sm" flavor="neutral" appearance="outlined" data-act="copy-dashboard">Copy the link</ty-button>'
          + '</div>'
          + '<div class="tour-qr"></div>'
          + '<p class="tour-hint">Separate pages, separate connections — and a phone is a different machine on a different network, with no session shared with this one. The pill in the topbar counts them; the tour moves on as soon as one joins.</p>',
        showButtons: ["next", "close"],
      },
      arm: function (api) {
        renderShareQr();
        return whenAnySurfaceJoins(api);
      },
    },
    {
      id: "rate",
      page: /^\/movies\/[^/]+$/,
      element: '[data-tour="rate"]',
      popover: {
        title: "One write. Watch what it does not need.",
        description: "Pick a value and press Submit. The POST returns nothing — no response body, no refetch, no client state."
          + (loggedIn() ? "" : " Not logged in? The platform's own login asks first: <code>admin</code> / <code>admin</code>, and the BFF brings you straight back here — the browser never sees a token.")
          + '<p class="tour-hint">Keep an eye on the ratings list below <em>and</em> on both companion windows as it lands — the list row, and the ratings tile on the dashboard. Rate again as often as you like; Next appears after the first one lands.</p>'
          + '<p class="tour-hint">Those four tiles are one <code>Dashboard.watchStats()</code> — a single SQL template declaring <code>@watch movie, user_rating, movie_actor</code>. The engine knows which writes touch which query; you declared it once.</p>',
        // The write is the step; the first repaint unlocks Next.
        showButtons: ["previous", "close"],
      },
      arm: function (api) {
        keepTargetClear('[data-tour="rate"]', api);
        var xid = movieXidFromPath();
        return xid ? whenRatedUnlockNext(api, "#movie-" + xid) : null;
      },
    },
    {
      id: "watch-not-form",
      page: /^\/movies\/[^/]+$/,
      element: '[data-tour="rating-list"]',
      popover: {
        title: "That was the engine's event, not the form",
        description: "Synthigy emitted one change for that rating. The detail watch here, the list watch in one companion window, the dashboard watch in the other — and, if you scanned the code, a phone on a different network — all came from that one event. Datastar painted the patches; Synthigy is why there was anything to paint.",
      },
    },
    {
      // Footer button, on every page — no page gate.
      id: "crowd",
      element: '[data-tour="crowd"]',
      popover: {
        title: "One rating was easy. Let a crowd in.",
        description: "For fifteen seconds the server rates the movies on the first page — and this one — a few times a second, like a launch-day rush."
          + '<div class="tour-actions">'
          + '<ty-button size="sm" flavor="primary" appearance="outlined" data-act="start-crowd">Let a crowd in</ty-button>'
          + '</div>'
          + '<p class="tour-hint">Watch the rating count on this page and your companion window. Nothing here polls and nothing repaints on purpose — every number that moves is a watch reacting to a write it did not make. Next appears once the crowd is in.</p>',
        showButtons: ["previous", "close"],
      },
      arm: function (api) { return whenCrowdStartsUnlockNext(api); },
    },
    {
      id: "history",
      page: /^\/movies\/[^/]+$/,
      element: '[data-tour="history"]',
      popover: {
        title: "Every change is remembered",
        description: "The model sets one flag on Movie — <code>audit/persist</code> — and the engine keeps every attribute change: who, when, and what it replaced. This panel is <code>client.history.events()</code>. Nobody wrote an audit table, a trigger or a log."
          + '<p class="tour-hint"><strong>Edit</strong> the title above and save: the change lands here, in every open tab. <strong>Restore</strong> puts it back from <code>history.getAt()</code> — and the restore is recorded too.</p>',
      },
    },
    {
      id: "model-live",
      page: /^\/movies\/[^/]+$/,
      element: '[data-tour="extra-fields"]',
      popover: {
        title: "The page reads the model, not just the data",
        description: "The typed client was generated for title, year and poster. This panel asks the engine what Movie has <em>now</em>. Add an attribute to Movie in the modeler — a <code>Tagline</code>, say — and deploy: it appears here, editable, in every open tab. No restart, no codegen."
          + '<div class="tour-actions">'
          + '<ty-button size="sm" flavor="primary" appearance="outlined" data-act="open-model">Open the modeler</ty-button>'
          + '</div>'
          + '<p class="tour-hint">In the modeler (signed in as <code>admin</code> / <code>admin</code>): the cube at the bottom opens <strong>Movies Example</strong>; add an attribute to Movie, then deploy. Close the modeler and the tour picks up here.</p>',
      },
    },
    {
      // No page gate: the tools dock and the destroy button live in the
      // footer of every page, so the tour finishes where the visitor already
      // is. It used to hop to /dashboard because the steps that lived there
      // needed it — those are gone.
      id: "console",
      element: '[data-tour="rail:console"]',
      // The spotlit dock button opens the console too: hand off to its tour
      // the same way the popover's own button does.
      arm: function (api) {
        var onOpen = function (e) {
          if (e.detail && e.detail.tool === "console") ACTIONS["open-console"](api);
        };
        document.addEventListener("synthigy-tools:open", onOpen);
        return function () { document.removeEventListener("synthigy-tools:open", onOpen); };
      },
      popover: {
        title: "Run the exact query these pages watch",
        description: 'The app\'s own <code>.xsql</code> files, on the same engine these pages run against — <code>dashboard/stats</code>, <code>demo/progress</code>, all of it. Reads are yours to play with.'
          + '<div class="tour-actions">'
          + '<ty-button size="sm" flavor="primary" appearance="outlined" data-act="open-console">Open the console</ty-button>'
          + '</div>'
          + '<p class="tour-hint">The console signs in to the engine itself — <code>admin</code> / <code>admin</code>.</p>',
      },
    },
    {
      id: "destroy",
      element: '[data-tour="destroy"]',
      popover: {
        title: "What you did not write",
        description: "A websocket server, a pub/sub layer, cache invalidation, a refetch-on-mutate, a diff of old and new rows. Two <code>.xsql</code> files and one deployed model — every query in them is already a live query in the JS, Python, Go, Clojure and PHP SDKs."
          + '<p class="tour-hint">Destroy deletes every version, table and row. The guide starts over at deploy.</p>',
      },
    },
  ];

  // The QR encoder is fetched the first time a visitor asks for it — the demo
  // pages should not carry it for a step most visitors reach once.
  var QR_SRC = "https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js";
  function withQrious(done) {
    if (window.QRious) { done(true); return; }
    var el = document.createElement("script");
    el.src = QR_SRC;
    el.onload = function () { done(!!window.QRious); };
    el.onerror = function () { done(false); };
    document.head.appendChild(el);
  }

  function shareUrl() { return location.origin + "/dashboard"; }

  // Drawn as soon as the step opens — a code you have to ask for is a code
  // nobody scans. driver.js renders the popover after `onHighlightStarted`,
  // so this waits for the box rather than assuming it is there.
  function renderShareQr(tries) {
    var box = document.querySelector(".driver-popover-description .tour-qr");
    if (!box) {
      if ((tries || 0) > 40) return;
      requestAnimationFrame(function () { renderShareQr((tries || 0) + 1); });
      return;
    }
    if (box.dataset.rendered) return;
    box.dataset.rendered = "1";
    withQrious(function (ok) {
      box.textContent = "";
      if (!ok) { box.appendChild(document.createTextNode("Could not load the QR encoder — use the link.")); return; }
      var canvas = document.createElement("canvas");
      box.appendChild(canvas);
      new window.QRious({ element: canvas, value: shareUrl(), size: 168, background: "#ffffff", foreground: "#000000" });
      var note = document.createElement("p");
      note.className = "tour-hint";
      note.textContent = reachableFromAnotherDevice()
        ? shareUrl()
        : shareUrl() + " — only this machine can reach that. A hosted instance has a public address, and then the code works from any phone.";
      box.appendChild(note);
    });
  }

  // A QR pointing at localhost is a dead end on a phone — say so instead of
  // drawing a code that cannot resolve.
  function reachableFromAnotherDevice() {
    return !/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(location.hostname);
  }

  function companionOpened(win, btn, label, url) {
    if (!win) {
      window.alert("Popups are blocked for this site. Allow them (the icon at the right of the "
        + "address bar) and press again, or open " + url + " in a tab yourself.");
      return;
    }
    if (btn) { btn.textContent = label; btn.removeAttribute("data-act"); btn.setAttribute("disabled", ""); btn.disabled = true; }
  }

  var ACTIONS = {
    // Separate windows, on purpose: independent surfaces, separate
    // connections, all repainted by one write. Optional now — the shared link
    // proves the same thing from someone else's device.
    "open-list": function (api, btn) {
      // Scope the list to THIS movie, or the next step's write lands on a row
      // that window doesn't have: /movies is 5837 rows newest-first, and the
      // guide's movie (2001) is nowhere near page 1.
      var title = (document.getElementById("movie-title") || {}).textContent || "";
      title = title.replace(/\s+/g, " ").trim();
      var url = "/movies" + (title ? "?q=" + encodeURIComponent(title) : "");
      companionOpened(openCompanion("movies", url), btn, "List open", url);
    },
    "open-dashboard": function (api, btn) {
      companionOpened(openCompanion("dashboard", "/dashboard"), btn, "Dashboard open", "/dashboard");
    },
    // The console owns the whole viewport, so the movies lane steps aside and
    // the console's own lane runs on top of it. Closing the console pops back
    // one step on, however the visitor leaves.
    "open-console": function (api) {
      if (!scenario()) return;
      api.pause();
      scenario().tool("console", { push: true });
    },
    // Press the real footer button, so the tour starts exactly what a visitor
    // pressing it would (its @post sends this page's path, which is how the
    // crowd knows to pile onto this movie).
    "start-crowd": function (api, btn) {
      var real = document.querySelector('[data-tour="crowd"]');
      if (real) real.click();
      if (btn) { btn.removeAttribute("data-act"); btn.setAttribute("disabled", ""); }
    },
    // Unlike the console hand-off above, no tool tour here: the visitor needs
    // the modeler open to ADD an attribute, and a tool lane closes the tool
    // when it ends. Step aside instead, and come back to this same step when
    // the modeler closes — by then the new field is on the page.
    "open-model": function (api) {
      if (!window.SYNTHIGY_TOOLS) return;
      api.pauseUntil("synthigy-tools:close");
      window.SYNTHIGY_TOOLS.open("model");
    },
    "copy-dashboard": function (api, btn) {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(location.origin + "/dashboard").then(function () {
        if (!btn) return;
        // Lock the box to its current width first — "Copied" is shorter
        // than the label, and letting the button shrink can collapse a
        // wrapped line in the popover, visibly shifting everything below
        // it (including the footer) upward.
        btn.style.minWidth = btn.offsetWidth + "px";
        var was = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = was; btn.style.minWidth = ""; }, 1500);
      });
    },
  };

  Tour.define("movies", STEPS, {
    actions: ACTIONS,
    // Destroying the dataset resets the demo to its empty state — the tour
    // resets with it rather than resuming into pages that 302 back to `/`.
    canRun: function () { return guidePhase() === "ready"; },
    stopPrompt: "Stop the tour? You can resume any time from the topbar link.",
    driver: {
      showProgress: true,
      progressText: "STEP {{current}} / {{total}}",
      nextBtnText: "Next →",
      prevBtnText: "← Back",
      doneBtnText: "Done",
      allowClose: true,
      overlayColor: "#07080b",
      overlayOpacity: 0.72,
      popoverClass: "movies-tour",
      smoothScroll: true,
      // stagePadding/-Radius match the app's own card radius, and the
      // spotlit element's outline-offset in style.css stays inside them.
      stagePadding: 8,
      stageRadius: 10,
    },
  });

  // ── boot + public API ────────────────────────────────────────────────────

  function boot() {
    if (Tour.armedBy("tour")) { Tour.start("movies"); return; }
    Tour.resume();
  }

  function celebrate() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.4/dist/confetti.browser.min.js";
    function fire() {
      var brand = "oklch(0.86 0.15 95)"; // matches --ty-color-primary
      window.confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 }, colors: [brand, "#ffffff"] });
      setTimeout(function () { window.confetti({ particleCount: 60, spread: 100, origin: { y: 0.55 }, colors: [brand] }); }, 180);
      setTimeout(function () { window.confetti({ particleCount: 60, spread: 100, origin: { y: 0.55 }, colors: ["#34d399", "#ffffff"] }); }, 360);
    }
    if (window.confetti) { fire(); return; }
    var s = document.createElement("script");
    s.src = src;
    s.onload = fire;
    document.head.appendChild(s);
  }

  // The guide's "Open it in the modeler" (shown once deployed) opens the
  // modeler with its tour.
  function showModel() {
    if (!window.SYNTHIGY_TOOLS) return;
    if (modelDeployed() && scenario()) scenario().tool("model");
    else window.SYNTHIGY_TOOLS.open("model");
  }

  window.MoviesGuide = {
    start: function () { Tour.start("movies"); },
    resume: boot,
    stop: function () { Tour.stop(); },
    celebrate: celebrate,
    showModel: showModel,
    act: function (name, btn) { var fn = ACTIONS[name]; if (fn) fn(Tour.api(), btn); },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
