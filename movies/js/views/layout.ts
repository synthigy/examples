import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { esc } from "../lib/bff.ts"
import { icon } from "../lib/icons.ts"
import { peekPhase } from "../lib/demo-state.ts"
import { confirmDestroyModal } from "./guide.ts"

// The tools rail's components talk to the Synthigy engine directly, not to
// this BFF (see examples/shared/README.md) — a demo running standalone (no
// hub in front) would otherwise default to its own origin and 404 on every
// /data call.
// What the BROWSER is told to call. Behind a proxy that fronts both this BFF
// and the engine on one hostname (the sandbox), this is the public origin and
// SYNTHIGY_ENDPOINT stays the in-container address the BFF itself dials.
const ENDPOINT = process.env.SYNTHIGY_PUBLIC_ENDPOINT
  ?? process.env.SYNTHIGY_ENDPOINT
  ?? "http://localhost:7887"

// Point the rail at a locally built bundle when one is present (dropped by
// examples/scripts/build-tooling.sh), so a component change can be tested
// before @synthigy/tooling is republished; otherwise the rail uses the pinned
// CDN version. Checked at module load — rebuild drops a file, it does not
// change this answer, and a restart is the same command you already ran.
const LOCAL_BUNDLE = existsSync(
  resolve(import.meta.dirname, "..", "..", "..", "shared", "vendor", "tooling", "tooling.js"))
const BUNDLE_CFG = LOCAL_BUNDLE
  ? `, bundle: "/vendor/tooling/tooling.js", bundleCss: "/vendor/tooling/tooling.css"`
  : ""

// driver.js runs the guided deploy → import → real-time → destroy tour on
// this demo (public/guide-tour.js) and the shared tool tours (scenario.js).
const DRIVER_VERSION = "1.8.0"
const DRIVER_CSS = `https://cdnjs.cloudflare.com/ajax/libs/driver.js/${DRIVER_VERSION}/driver.min.css`
const DRIVER_JS  = `https://cdnjs.cloudflare.com/ajax/libs/driver.js/${DRIVER_VERSION}/driver.js.iife.min.js`

/**
 * Page shell. Tyrell components + Datastar, both from CDN — zero
 * browser-side build step.
 *
 *   Tyrell components: <ty-button>, <ty-input>, <ty-tag>, <ty-icon>,
 *                      <ty-select>, <ty-modal>, <ty-wizard>, etc.
 *                      Form-associated, shadow-DOM-isolated, native events.
 *   Datastar         : data-on-load / data-on:click / @post / @get — opens
 *                      SSE, applies patch-elements + patch-signals as they
 *                      arrive from the BFF.
 *
 * The `data-init="@get('…/stream')"` directive on a child opens the
 * per-page SSE stream and applies patches into the rendered page.
 *
 * Typography: Fraunces (variable serif, opsz + SOFT axes) for display,
 * DM Sans for UI, JetBrains Mono for the event console.
 */
// Tracks BFF process start time. Shown in the topbar so the user can
// confirm the rendering process is alive and not a cached page.
const BFF_START = new Date().toISOString().replace("T", " ").slice(0, 19)

// `fill`: the page owns the viewport instead of growing past it — main becomes
// a flex column that ends at the footer, so a scroll region inside it (the
// actors grid) is the only thing that scrolls. Without it the page scrolls too
// and you get two nested scrollbars.
export type LayoutProps = { title: string; user: any; content: string; stream?: string; fill?: boolean }
export function layout({ title, user, content, stream, fill }: LayoutProps) {
  const renderedAt = new Date().toISOString().slice(11, 23)
  // Best-effort — reflects the last demoState() probe any request made, not
  // necessarily THIS one. Only gates a UI affordance (the topbar tour
  // button), never a security or data decision, so staleness is harmless.
  const phase = peekPhase()
  // The dataset only exists to destroy once it is deployed, and only a signed-in
  // visitor can post the job.
  const canDestroy = phase === "ready" && !!user
  return /* html */ `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · movies</title>

  <!-- Tyrell components — served from the installed dependency, not a CDN.
       tyrell-theme.css is the OKLCH brand layer (loaded after tyrell.css);
       the whole palette is seeded from --ty-brand-hue (set in style.css).
       It was published as tyrell-brand.css up to TC31 — renamed upstream. -->
  <link rel="stylesheet" href="/vendor/tyrell/tyrell.css">
  <link rel="stylesheet" href="/vendor/tyrell/tyrell-theme.css">
  <script type="module" src="/vendor/tyrell/tyrell.js"></script>

  <!-- No-FOUC reveal: style.css keeps <body> invisible until .ty-ready is set.
       tyrell.js (a deferred module) registers the components after first paint,
       so we wait for them to be defined, then reveal the fully-upgraded page in
       one fade — no visible snap from un-upgraded to upgraded tags. -->
  <script>
    (function () {
      var reveal = function () { document.documentElement.classList.add("ty-ready"); };
      if (window.customElements) {
        Promise.all(["ty-button", "ty-tag", "ty-input"].map(function (n) {
          return customElements.whenDefined(n);
        })).then(reveal);
      }
      setTimeout(reveal, 2000); // safety net if a component never registers
    })();
  </script>

  <!-- Fonts: clean sans for body + mono for the event console -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">

  <!-- Icons are inlined as <svg> children of <ty-icon> by the BFF in
       lib/icons.mjs — no client-side registration script, no JS
       bootstrap, no flash of missing icon. Any SVG source can be
       swapped in (lucide, heroicons, custom) by changing lib/icons.mjs. -->

  <!-- Datastar: SSE-driven reactivity -->
  <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.1/bundles/datastar.js"></script>

  <!-- Tailwind (Play CDN) for spacing/layout utilities. Preflight OFF so its
       base reset can't fight Tyrell's component styles or style.css. -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { corePlugins: { preflight: false } }</script>

  <!-- driver.js: the guided-tour engine for this demo (public/guide-tour.js). -->
  <link rel="stylesheet" href="${DRIVER_CSS}">
  <script src="${DRIVER_JS}"></script>

  <link rel="stylesheet" href="/public/style.css?v=${Date.now()}">
</head>
<body class="ty-canvas" data-guide-phase="${esc(phase)}" data-user="${user ? 1 : 0}">
  <header class="topbar ty-content flex items-center px-6 py-3 gap-8 shrink-0 border-b
                 max-[1100px]:flex-wrap max-[1100px]:px-3 max-[1100px]:py-2 max-[1100px]:gap-x-3 max-[1100px]:gap-y-1.5
                 max-[560px]:px-2.5 max-[560px]:gap-x-2">
    <a class="brand flex items-center gap-2 shrink-0 font-semibold text-[1.02rem] tracking-[-0.01em]" href="/">
      ${icon("film", { size: "md" })}
      <span class="max-[560px]:hidden">movies</span>
    </a>
    <nav class="flex gap-0.5 flex-1 ml-2
                max-[1100px]:order-10 max-[1100px]:basis-full max-[1100px]:flex-none max-[1100px]:ml-0 max-[1100px]:gap-1">
      <a class="nav-link flex items-center gap-1.5 px-[11px] py-1.5 rounded-[5px] text-[0.9rem] font-medium max-[1100px]:flex-1 max-[1100px]:justify-center max-[1100px]:py-2" href="/movies" data-tour="nav-movies">
        ${icon("list", { size: "sm" })}
        Movies
      </a>
      <a class="nav-link flex items-center gap-1.5 px-[11px] py-1.5 rounded-[5px] text-[0.9rem] font-medium max-[1100px]:flex-1 max-[1100px]:justify-center max-[1100px]:py-2" href="/actors">
        ${icon("users", { size: "sm" })}
        Actors
      </a>
      <a class="nav-link flex items-center gap-1.5 px-[11px] py-1.5 rounded-[5px] text-[0.9rem] font-medium max-[1100px]:flex-1 max-[1100px]:justify-center max-[1100px]:py-2" href="/dashboard" data-tour="nav-dashboard">
        ${icon("chart-column", { size: "sm" })}
        Dashboard
      </a>
    </nav>
    <script>
      // Highlight the current section (also matches detail sub-paths like
      // /movies/:xid → Movies). The nav <a>s above are already parsed here.
      (function () {
        var p = location.pathname;
        document.querySelectorAll(".topbar nav a").forEach(function (a) {
          var h = a.getAttribute("href");
          if (h && h !== "/" && (p === h || p.indexOf(h + "/") === 0)) a.setAttribute("aria-current", "page");
        });
      })();
    </script>
    <div class="build-badge max-[1100px]:hidden" title="BFF started ${esc(BFF_START)} · page rendered ${esc(renderedAt)}">
      <span class="build-badge-dot"></span>
      <span class="build-badge-text">build ${esc(BFF_START)} · rendered ${esc(renderedAt)}</span>
    </div>
    <span id="presence" class="presence-pill" data-tour="presence"
          data-p-guide="0" data-p-movies="0" data-p-detail="0" data-p-dashboard="0">
      <span class="ribbon-dot"></span> 0 <span class="max-[560px]:hidden">tabs </span>live
    </span>
    <div class="user flex items-center gap-2.5 max-[1100px]:gap-1.5 max-[560px]:gap-1">
      ${user
        ? `<ty-tag size="sm" flavor="neutral" class="max-[560px]:hidden">
             ${icon("user", { slot: "start", size: "sm" })}
             ${esc(user.name ?? user.xid?.slice(0, 8) ?? "?")}
           </ty-tag>
           <form method="POST" action="/logout" style="display:inline">
             <ty-button size="sm" flavor="neutral" type="submit">
               ${icon("log-out", { slot: "start", size: "sm" })}
               <span class="max-[560px]:hidden">log out</span>
             </ty-button>
           </form>`
        : `<ty-tag size="sm" flavor="neutral" class="max-[560px]:hidden" title="Demo login">
             ${icon("key-round", { slot: "start", size: "sm" })}
             <span style="font-family:var(--font-mono)">admin / admin</span>
           </ty-tag>
           <a href="/login" style="text-decoration:none" data-tour="topbar-login"
              onclick="this.href='/login?returnTo='+encodeURIComponent(location.pathname+location.search)">
             <ty-button size="sm" flavor="primary">
               ${icon("log-in", { slot: "start", size: "sm" })}
               log in
             </ty-button>
           </a>`}
      <ty-button size="sm" flavor="neutral" data-tour="topbar-share"
                 onclick="window.SynthigyShare && window.SynthigyShare.open()">
        ${icon("share-2", { slot: "start", size: "sm" })}
        <span class="max-[560px]:hidden">Share</span>
      </ty-button>
      ${phase === "ready"
        ? `<ty-button size="sm" flavor="success" data-tour="topbar-tour" onclick="location.href='/movies?tour=1'">
             ${icon("compass", { slot: "start", size: "sm" })}
             <span class="max-[560px]:hidden">Take the tour</span><span class="hidden max-[560px]:inline">Tour</span>
           </ty-button>`
        : ""}
    </div>
  </header>

  <div class="page-scroll${fill ? " page-fill" : ""}">
    <!-- One-shot message carried as ?notice= by a server redirect (see
         withNotice() in serve.ts). Read client-side so ANY page can show it
         without every layout() call site threading the prop through. -->
    <div id="auth-notice" class="auth-notice" role="status" hidden>
      ${icon("info", { size: "sm" })}
      <span class="auth-notice-text"></span>
      <button type="button" class="auth-notice-close" aria-label="Dismiss">&times;</button>
    </div>
    <script>
      (function () {
        var q = new URLSearchParams(location.search);
        var msg = q.get("notice");
        if (!msg) return;
        var el = document.getElementById("auth-notice");
        el.querySelector(".auth-notice-text").textContent = msg;
        el.hidden = false;
        el.querySelector(".auth-notice-close").addEventListener("click", function () { el.hidden = true; });
        q.delete("notice");
        var qs = q.toString();
        history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
      })();
    </script>

    ${stream ? `<div id="movie-stream" data-init="@get('${esc(stream)}')"></div>` : ""}

    <main class="max-w-[1100px] w-full mx-auto px-6 pt-9 ${fill ? "pb-6 flex-1 min-h-0 flex flex-col" : "pb-24"}
                max-[560px]:px-4 max-[560px]:pt-6 ${fill ? "max-[560px]:pb-4" : "max-[560px]:pb-10"}">
      ${content}
    </main>
  </div>

  <footer class="border-t px-6 py-3 text-[0.8em] shrink-0 flex flex-wrap items-center gap-3 justify-between
                 max-[560px]:px-3 max-[560px]:py-2 max-[560px]:gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <div id="footer-tools" class="flex flex-wrap items-center gap-2"></div>
      ${canDestroy
        ? `<ty-button size="sm" flavor="danger" appearance="outlined" data-tour="destroy"
                      data-on:click="$confirmDestroy = true">
             ${icon("trash", { slot: "start", size: "sm" })}
             Destroy the dataset
           </ty-button>`
        : ""}
    </div>
    <span class="footer-credit">spike for <a href="https://synthigy.dev/sdk">synthigy.dev/sdk</a><span class="max-[560px]:hidden"> · one SSE per page · BFF holds tokens · components by tyrell, reactivity by datastar</span></span>
  </footer>
  ${confirmDestroyModal()}
  ${sharePanel()}

  <script>
    window.SYNTHIGY_TOOLS = { endpoint: "${ENDPOINT}", xsql: ["/xsql/movies.xsql", "/xsql/actors.xsql"]${BUNDLE_CFG} };
    window.SYNTHIGY_TOUR = "/tour.json";
  </script>
  <script src="/tools-rail.js"></script>
  <script>
    // tools-rail.js builds its dock (Model/Console/Logs) as a plain,
    // non-shadow-DOM element appended to <body> — re-parent it into the
    // footer instead of floating fixed over page content. Its opened PANELS
    // stay full-viewport overlays regardless (that's load-bearing: see
    // tools-rail.js's own top-of-file comment on why they own their close
    // button).
    //
    // tools-rail.js's own init() defers buildDock() to DOMContentLoaded
    // whenever the document is still mid-parse (readyState "loading") —
    // true here, since this script runs before parsing reaches </html>. So
    // this must wait on the same event, registered AFTER tools-rail.js's own
    // listener so it fires after (same-event listeners run in registration
    // order) — running immediately would find no dock yet.
    (function () {
      function move() {
        var dock = document.querySelector(".syn-tools-dock");
        var slot = document.getElementById("footer-tools");
        if (dock && slot) slot.appendChild(dock);
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", move);
      else move();
    })();
  </script>
  <script>
    // Touch targets on a phone. Tyrell bakes each button's height into its
    // shadow root (xs 24, sm 28, md 32, lg 36, xl 40) and exposes no custom
    // property or ::part for it, so a min-height on the HOST grows the host
    // box and nothing else — measured: a tap in the strip that buys fires no
    // submit at all. "size" is the only knob that reaches the control, so
    // below 560px every button under lg asks for "lg" and hands its original
    // attribute back on the way up. The topbar is excluded: lg there costs a third
    // header row for buttons that are already 36px wide icons.
    //
    // Fields move with them, one step up (sm -> md), because Tyrell pairs the
    // two ladders: field md and button lg are both 36px, so a Submit slotted
    // into a field still sits flush. Leaving fields behind would overhang.
    //
    // An observer, not a one-shot: Datastar re-renders the detail card (which
    // carries Submit) and driver.js builds its popover buttons on the fly.
    (function () {
      var MQ = window.matchMedia("(max-width: 560px)");
      var UP = { "TY-BUTTON": { xs: "lg", sm: "lg", md: "lg", "": "lg" },
                 "TY-INPUT":  { xs: "md", sm: "md", "": "md" },
                 "TY-SELECT": { xs: "md", sm: "md", "": "md" } };
      function fit(el) {
        if (el.closest("header.topbar")) return;
        var ladder = UP[el.tagName];
        if (!ladder) return;
        var size = el.getAttribute("size");
        if (MQ.matches) {
          var want = ladder[size === null ? "" : size];
          if (want) { el.dataset.sz = size === null ? "" : size; el.setAttribute("size", want); }
        } else if (el.dataset.sz !== undefined) {
          if (el.dataset.sz) el.setAttribute("size", el.dataset.sz);
          else el.removeAttribute("size");
          delete el.dataset.sz;
        }
      }
      var SEL = "ty-button, ty-input, ty-select";
      function sweep(node) {
        if (!node || node.nodeType !== 1) return;
        if (UP[node.tagName]) fit(node);
        if (node.querySelectorAll) node.querySelectorAll(SEL).forEach(fit);
      }
      sweep(document.body);
      new MutationObserver(function (records) {
        records.forEach(function (r) { r.addedNodes.forEach(sweep); });
      }).observe(document.body, { childList: true, subtree: true });
      MQ.addEventListener("change", function () { sweep(document.body); });
    })();
  </script>
  <!-- Tour engine (shared, examples/shared/tour.js) before the movies steps
       that register against it. -->
  <script src="/tour.js"></script>
  <script src="/public/guide-tour.js"></script>
  <script src="/scenario.js"></script>
</body>
</html>`
}

// Share panel — the instance has a public address, so hand it over: the link
// to THIS page, a copy button, and a QR for a phone. Opened from the topbar
// (window.SynthigyShare.open), and by the tour's share step.
//
// The QR encoder is fetched on first open rather than shipped on every page:
// most visits never open this.
export function sharePanel() {
  return /* html */ `
<ty-modal id="share-dialog">
  <div class="ty-floating share-panel flex flex-col w-[min(420px,calc(100vw-32px))] rounded-[14px] border p-6">
    <h2 class="m-0 mb-1.5 text-[1.05rem] flex items-center gap-2">
      ${icon("share-2", { size: "sm" })} Share this page
    </h2>
    <p class="hint m-0 mb-4">
      Anyone who opens it joins the same live instance — a different machine, a
      different network, no session shared with yours.
    </p>

    <div class="share-url flex items-center gap-2 rounded-lg border px-3 py-2.5 mb-3">
      <code id="share-url-text" class="flex-1 text-[0.82rem] break-all"></code>
    </div>

    <div class="flex gap-2 flex-wrap">
      <ty-button size="sm" flavor="primary" id="share-copy">Copy link</ty-button>
      <ty-button size="sm" flavor="neutral" appearance="outlined" id="share-qr">
        ${icon("qr-code", { slot: "start", size: "sm" })}
        Show QR
      </ty-button>
      <ty-button size="sm" flavor="neutral" appearance="outlined" id="share-close" class="ml-auto">Close</ty-button>
    </div>

    <div id="share-qr-box" class="share-qr mt-4" hidden></div>
    <p id="share-note" class="hint mt-3 mb-0" hidden></p>
  </div>
</ty-modal>

<script>
(function () {
  var QR_SRC = "https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js";
  var dialog = document.getElementById("share-dialog");
  var urlEl  = document.getElementById("share-url-text");
  var qrBox  = document.getElementById("share-qr-box");
  var note   = document.getElementById("share-note");

  function shareUrl() { return location.origin + location.pathname + location.search; }

  // A link to localhost is useless to anyone else — say so rather than draw a
  // code nothing can resolve.
  function reachable() {
    return !/^(localhost|127\\.|0\\.0\\.0\\.0|\\[?::1)/.test(location.hostname);
  }

  function withQrious(done) {
    if (window.QRious) return done(true);
    var el = document.createElement("script");
    el.src = QR_SRC;
    el.onload = function () { done(!!window.QRious); };
    el.onerror = function () { done(false); };
    document.head.appendChild(el);
  }

  function open() {
    urlEl.textContent = shareUrl();
    qrBox.hidden = true;
    qrBox.textContent = "";
    note.hidden = reachable();
    note.textContent = reachable() ? "" :
      "This address only resolves on this machine. Hosted instances have a public one, and then the link and the code work anywhere.";
    dialog.setAttribute("open", "");
  }
  function close() { dialog.removeAttribute("open"); }

  document.getElementById("share-close").addEventListener("click", close);
  dialog.addEventListener("close", close);
  dialog.addEventListener("cancel", close);

  document.getElementById("share-copy").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(shareUrl()).then(function () {
      var was = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = was; }, 1500);
    });
  });

  document.getElementById("share-qr").addEventListener("click", function () {
    qrBox.hidden = false;
    qrBox.textContent = "…";
    withQrious(function (ok) {
      qrBox.textContent = "";
      if (!ok) { qrBox.textContent = "Could not load the QR encoder — use the link."; return; }
      var canvas = document.createElement("canvas");
      qrBox.appendChild(canvas);
      new window.QRious({ element: canvas, value: shareUrl(), size: 176,
                          background: "#ffffff", foreground: "#000000" });
    });
  });

  window.SynthigyShare = { open: open, close: close, url: shareUrl };
})();
</script>`;
}
