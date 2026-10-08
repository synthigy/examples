// The showcase tour engine.
//
// One shared file read live from disk by each demo (same convention as
// tools-rail.js / scenario.js): no build step, no dependency of its own.
// driver.js does the drawing; this file does the sequencing driver.js has no
// opinion about — named steps, a resume stack, per-step page gates, and
// auto-advance watchers a step arms for itself.
//
//   Tour.define("movies", steps, { driver, canRun, actions })
//   Tour.start("movies")            // from the first step
//   Tour.push("console")            // pause this tour, run another
//   Tour.pop({ advance: true })     // back to the tour that pushed
//   Tour.resume()                   // on every page load
//
// A step is `{ id, page, element, popover, skip, arm, onNext, enter }`. `id` is the
// resume pointer — never an index, so steps can be added, reordered or
// removed without touching anything else. `page` is a RegExp tested against
// `location.pathname`: a saved step whose page doesn't match this one means
// the tour lives in another tab (the second tab, the incognito window) and
// nothing is drawn here. `arm(api)` returns a dispose function and is how a
// step advances itself on something happening; `onNext(api)` runs on Next
// and is how a step hands off to another page (`api.setStep(id)` first, then
// navigate — the pointer is all that survives). `enter(api)` makes a step that
// is never drawn: reaching it runs `enter` instead, which typically pauses and
// pushes a lane (scenario.js opens a tool that way).
//
// State is ONE tab's: sessionStorage, so the extra tabs the tour tells you
// to open never try to run their own copy of it.
(function () {
  "use strict";

  var KEY = "syn-tour";
  var LEGACY_KEYS = ["movies-guide-tour"];   // pre-stack, index-based

  var tours = {};
  var d = null;            // live driver instance
  var running = null;      // tour name `d` is driving
  var disposeArm = null;
  var disposeGuard = null;   // keeps `driver-active-element` on through morphs
  var silent = false;      // suppress the "stop the tour?" confirm on destroy
  var resumed = false;     // resume() runs once per page load, whoever calls it

  // ── stack ────────────────────────────────────────────────────────────────

  function read() {
    try {
      var s = JSON.parse(sessionStorage.getItem(KEY) || "null");
      return s && Array.isArray(s.stack) ? s.stack : [];
    } catch (e) { return []; }
  }
  function write(stack) {
    try {
      if (!stack || !stack.length) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, JSON.stringify({ stack: stack }));
    } catch (e) { /* private mode — the tour just won't survive navigation */ }
  }
  function top() { var s = read(); return s.length ? s[s.length - 1] : null; }

  function setStep(id) {
    var s = read();
    if (!s.length) return;
    s[s.length - 1].step = id;
    write(s);
  }

  // ── steps ────────────────────────────────────────────────────────────────

  function tour(name) { return tours[name] || null; }

  function indexOf(t, id) {
    for (var i = 0; i < t.steps.length; i++) if (t.steps[i].id === id) return i;
    return -1;
  }

  // Walk forward past steps that opt out right now (already logged in, a
  // feature this instance doesn't have). Returns steps.length when the whole
  // remainder is skipped — the caller treats that as "this tour is done".
  function skipForward(t, i) {
    while (i < t.steps.length && t.steps[i].skip && t.steps[i].skip()) i++;
    return i;
  }

  function disposeCurrentArm() {
    if (disposeGuard) { try { disposeGuard(); } catch (e) { /* gone */ } disposeGuard = null; }
    if (!disposeArm) return;
    try { disposeArm(); } catch (e) { /* already gone */ }
    disposeArm = null;
  }

  // Datastar morphs the DOM in place and syncs attributes from the server's
  // HTML, which never carries driver.js's `driver-active-element` — and
  // without that class the overlay's `pointer-events: none` swallows every
  // click on the very element the step is pointing at. Put it back whenever a
  // patch strips it, for as long as this step owns that element.
  //
  // Armed from `onHighlightStarted`, not `onHighlighted`: the latter waits
  // for the highlight animation, and a visitor who acts inside that window
  // would lose the element before the guard existed.
  function guardActiveElement(el) {
    if (!el || !el.classList) return null;
    var mo = new MutationObserver(function () {
      if (!el.isConnected) return;
      if (!el.classList.contains("driver-active-element")) el.classList.add("driver-active-element");
    });
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return function () { mo.disconnect(); };
  }

  // The engine owns the screen: once this returns, nothing driver.js drew may
  // still be on it. driver.js's own cleanup can throw (it walks the element it
  // highlighted, which for a tool lane lives in a shadow root the tool may
  // have just torn down), and the reference is dropped either way. So the
  // sweep runs even with no driver in hand — that IS the case it exists for:
  // a stranded popover with nothing left holding it, which every later
  // teardown would otherwise skip straight past.
  function destroySilently() {
    disposeCurrentArm();
    if (d) {
      silent = true;
      try { d.destroy(); } catch (e) { console.warn("[tour] driver.destroy threw", e); }
      silent = false;
      d = null;
      running = null;
    }
    sweep();
  }

  function sweep() {
    var left = document.querySelectorAll(".driver-popover, .driver-overlay");
    if (left.length) console.warn("[tour] driver.js left " + left.length + " node(s) behind");
    for (var i = 0; i < left.length; i++) left[i].remove();
    document.body.classList.remove("driver-active", "driver-fade", "driver-simple", "driver-no-scroll");
  }

  // ── api handed to steps and popover actions ──────────────────────────────

  function api() {
    return {
      next: advance,
      back: retreat,
      refresh: function () { if (d) d.refresh(); },
      // Reveal a footer button the step hid via `showButtons`. driver.js
      // renders the footer once per highlight and `refresh()` only
      // repositions, so the live button needs its own display reset — the
      // list is updated too, for the next real render.
      showButton: function (name) {
        if (!d) return;
        var steps = d.getConfig("steps") || [];
        var step = steps[d.getActiveIndex()];
        if (step && step.popover) {
          var list = step.popover.showButtons || [];
          if (list.indexOf(name) === -1) step.popover.showButtons = list.concat([name]);
        }
        var btn = document.querySelector(".driver-popover-" + name + "-btn");
        if (!btn) return;
        btn.style.display = "block";
        var footer = document.querySelector(".driver-popover-footer");
        if (footer) footer.style.display = "";
      },
      setStep: setStep,
      pause: pause,
      pauseUntil: pauseUntil,
      start: start,
      push: push,
      pop: pop,
      stop: stop,
      driver: function () { return d; },
    };
  }

  // ── driver.js wiring ─────────────────────────────────────────────────────
  // Global name is window.driver.js.driver (the npm package's `driver.js`
  // export path, preserved as-is by the IIFE build) — NOT window.driver.driver.
  function factory() {
    return window.driver && window.driver.js && window.driver.js.driver;
  }

  // `step.element` is a selector, an Element, or a FUNCTION returning one —
  // driver.js resolves a function at highlight time, which is how a step
  // anchors inside a web component's shadow root (no document selector
  // reaches in there).
  function toDriverStep(step) {
    if (step.enter) return { popover: { title: "" } };
    var popover = { title: step.popover.title, description: step.popover.description };
    if (step.popover.showButtons) popover.showButtons = step.popover.showButtons;
    popover.onNextClick = function () {
      if (step.onNext) { disposeCurrentArm(); step.onNext(api()); return; }
      advance();
    };
    popover.onPrevClick = function () { retreat(); };
    return { element: step.element, popover: popover };
  }

  // Next and Back go through these so a neighbouring `enter` step runs
  // instead of being drawn. On the last step driver.js's moveNext destroys,
  // which onDestroyStarted turns into finish().
  function advance() {
    disposeCurrentArm();
    if (!d) return;
    var t = tour(running), i = d.getActiveIndex();
    var next = t && i != null ? t.steps[i + 1] : null;
    if (next && next.enter) { runEnter(t, i + 1); return; }
    if (next && elsewhere(next)) { park(next); return; }
    d.moveNext();
  }
  function retreat() {
    disposeCurrentArm();
    if (!d) return;
    var t = tour(running), i = d.getActiveIndex();
    var prev = t && i != null && i > 0 ? t.steps[i - 1] : null;
    if (prev && prev.enter) { runEnter(t, i - 1); return; }
    if (prev && elsewhere(prev)) { park(prev); return; }
    d.movePrevious();
  }
  // A step that lives on another page: point the stack at it and take the
  // tour off screen; that page's load resumes it.
  function elsewhere(step) { return !!(step.page && !step.page.test(location.pathname)); }
  function park(step) {
    setStep(step.id);
    destroySilently();
  }
  function runEnter(t, i) {
    setStep(t.steps[i].id);
    destroySilently();
    t.steps[i].enter(api());
  }

  function wirePopoverActions() {
    var t = tour(running);
    var actions = (t && t.actions) || {};
    document.querySelectorAll(".driver-popover-description [data-act]").forEach(function (btn) {
      if (btn._synWired) return;
      btn._synWired = true;
      btn.addEventListener("click", function () {
        var fn = actions[btn.getAttribute("data-act")];
        if (fn) fn(api(), btn);
      });
    });
  }

  function build(t) {
    var make = factory();
    if (!make) return null;
    var opts = {};
    for (var k in (t.driverOpts || {})) opts[k] = t.driverOpts[k];
    opts.steps = t.steps.map(toDriverStep);
    opts.onPopoverRender = wirePopoverActions;
    opts.onHighlightStarted = function (el, _step, o) {
      disposeCurrentArm();
      var i = o && o.state ? o.state.activeIndex : null;
      if (i == null) return;
      var step = t.steps[i];
      if (step.skip && step.skip()) { d.moveNext(); return; }
      if (step.enter) { setTimeout(function () { runEnter(t, i); }, 0); return; }
      setStep(step.id);
      if (step.arm) disposeArm = step.arm(api());
      disposeGuard = guardActiveElement(el);
    };
    opts.onDestroyStarted = function () {
      if (silent) { d.destroy(); return; }
      // Reaching the end of a sub-tour returns to whoever pushed it; ending
      // the root tour ends the whole thing. Anywhere else, ask first. The X,
      // Escape and an overlay click on the last step land here too, so a
      // tour's own ending (`onEnd`) must run from here, not only from Next.
      if (d.isLastStep()) {
        disposeCurrentArm();
        if (t.onEnd) t.onEnd(api()); else finish();
        return;
      }
      if (window.confirm(t.stopPrompt || "Stop the tour?")) stop();
    };
    builtAt = performance.now();
    return make(opts);
  }

  // An Escape pressed before this driver existed (it closed a tool, which
  // drew this step) must not reach driver.js's keyup handler and close it.
  var builtAt = 0;
  var escapeDownAt = 0;
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") escapeDownAt = performance.now();
  }, true);
  window.addEventListener("keyup", function (e) {
    if (e.key === "Escape" && d && escapeDownAt < builtAt) e.stopPropagation();
  }, true);

  // ── running ──────────────────────────────────────────────────────────────

  // Draws the top frame if this page is where it lives. A frame whose page
  // doesn't match is left on the stack untouched: the tab that does match
  // picks it up, and so does this one after the step's own navigation.
  function driveTop() {
    var frame = top();
    if (!frame) return false;
    var t = tour(frame.tour);
    if (!t) return false;
    if (t.canRun && !t.canRun()) {
      // A pushed lane whose surface is gone (the tool was closed, or this is
      // a fresh page load) hands back to whoever pushed it; the root lane
      // failing its own check ends the tour.
      if (read().length > 1) return pop();
      stop();
      return false;
    }

    var i = indexOf(t, frame.step);
    if (i < 0) i = 0;
    i = skipForward(t, i);
    if (i >= t.steps.length) { finish(); return false; }

    var step = t.steps[i];
    setStep(step.id);
    if (step.page && !step.page.test(location.pathname)) return false;

    if (step.enter) { runEnter(t, i); return true; }

    destroySilently();
    d = build(t);
    if (!d) return false;
    running = frame.tour;
    d.drive(i);
    return true;
  }

  // ── public ───────────────────────────────────────────────────────────────

  function define(name, steps, opts) {
    opts = opts || {};
    tours[name] = {
      name: name,
      steps: steps,
      driverOpts: opts.driver || {},
      actions: opts.actions || {},
      canRun: opts.canRun || null,
      onEnd: opts.onEnd || null,
      stopPrompt: opts.stopPrompt || null,
    };
    return tours[name];
  }

  function start(name, atId) {
    var t = tour(name);
    if (!t || !t.steps.length) return false;
    destroySilently();
    write([{ tour: name, step: atId || t.steps[0].id }]);
    return driveTop();
  }

  // Pause the running tour and run another on top of it. The pusher's own
  // step is already on the stack, so popping returns to exactly it.
  function push(name, atId) {
    var t = tour(name);
    if (!t || !t.steps.length) return false;
    var s = read();
    s.push({ tour: name, step: atId || t.steps[0].id });
    write(s);
    destroySilently();
    return driveTop();
  }

  // `advance: true` resumes the pusher at the step AFTER the one that pushed
  // — what a "you did the thing, carry on" hand-off wants. Without it the
  // visitor lands back on the step they left, which is what an abandoned
  // sub-tour wants.
  function pop(opts) {
    var s = read();
    if (!s.length) { destroySilently(); return false; }
    s.pop();
    write(s);
    destroySilently();
    if (!s.length) return false;
    if (opts && opts.advance) {
      var frame = s[s.length - 1];
      var t = tour(frame.tour);
      if (t) {
        var i = indexOf(t, frame.step);
        if (i >= 0 && i + 1 < t.steps.length) setStep(t.steps[i + 1].id);
        // Nothing after the pusher's step: it is done too. Driving it again
        // would re-run an `enter` step forever.
        else { finish(); return false; }
      }
    }
    return driveTop();
  }

  // Drop the top `n` frames without advancing whoever is left, and redraw it.
  function unwind(n) {
    var s = read();
    s.splice(Math.max(0, s.length - n), n);
    write(s);
    destroySilently();
    return s.length ? driveTop() : false;
  }

  // Move the top frame one step on and draw it; past its last step, finish.
  function skip() {
    var frame = top();
    var t = frame && tour(frame.tour);
    if (!t) return false;
    var i = indexOf(t, frame.step);
    if (i >= 0 && i + 1 < t.steps.length) { setStep(t.steps[i + 1].id); return driveTop(); }
    finish();
    return false;
  }

  // A tour running out of steps pops to its pusher, or ends everything.
  function finish() {
    var s = read();
    if (s.length > 1) { pop({ advance: true }); return; }
    stop();
  }

  function stop() {
    destroySilently();
    write([]);
  }

  // Step the top frame forward one step without drawing anything.
  function advanceTop() {
    var frame = top();
    var t = frame && tour(frame.tour);
    if (!t) return;
    var i = indexOf(t, frame.step);
    if (i >= 0 && i + 1 < t.steps.length) setStep(t.steps[i + 1].id);
  }

  // Take the tour off screen but keep the stack — the visitor has gone
  // somewhere the tour can't follow (a tool that owns the whole viewport, a
  // second window). Nothing is lost: a reload still resumes this step.
  function pause() {
    destroySilently();
  }

  // Pause, and come back when `event` fires on `document` (or `opts.target`).
  // `advance: true` returns one step on, for a hand-off the visitor has by
  // then completed. The listener is one-shot and drops itself if the tour was
  // stopped while it was away.
  function pauseUntil(event, opts) {
    opts = opts || {};
    pause();
    var target = opts.target || document;
    var onceBack = function () {
      target.removeEventListener(event, onceBack);
      if (!top()) return;
      if (opts.advance) advanceTop();
      driveTop();
    };
    target.addEventListener(event, onceBack);
  }

  // Once per page load, and only once the frame on top is defined: the
  // runner that defines it (scenario.js) may load after the demo's own.
  function resume() {
    if (resumed || running) return running != null;
    var frame = top();
    if (frame && !tours[frame.tour]) return false;
    resumed = true;
    for (var i = 0; i < LEGACY_KEYS.length; i++) {
      try { localStorage.removeItem(LEGACY_KEYS[i]); } catch (e) { /* private mode */ }
    }
    return driveTop();
  }

  // Strips a query flag (`?tour=1`) from the URL and returns whether it was
  // there — every demo arms its tour from a link, and none of them want the
  // flag surviving into the address bar or a later reload.
  function armedBy(flag) {
    var url = new URL(location.href);
    if (url.searchParams.get(flag) !== "1") return false;
    url.searchParams.delete(flag);
    var qs = url.searchParams.toString();
    history.replaceState(null, "", url.pathname + (qs ? "?" + qs : "") + url.hash);
    return true;
  }

  window.SynthigyTour = {
    define: define,
    start: start,
    push: push,
    pop: pop,
    stop: stop,
    pause: pause,
    pauseUntil: pauseUntil,
    finish: finish,
    skip: skip,
    unwind: unwind,
    resume: resume,
    stack: read,
    defined: function (name) { return !!tours[name]; },
    armedBy: armedBy,
    current: top,
    api: api,
  };
})();
