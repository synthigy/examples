"""HTML fragment builders — Tyrell web components + Datastar, all from CDN
(zero browser build). The BFF renders these server-side and patches them
into the page over SSE. Colours ride Tyrell's `--ty-*` tokens; layout is
Tailwind utilities; a small <style> block carries the demo-specific edges.

Every interactive block carries a small `sdk` chip naming the SDK primitive
that powers it — the page doubles as a feature tour.
"""

from __future__ import annotations

import hashlib
import html as _html
import json as _json
import os
from pathlib import Path

from icons import icon

TYRELL = "1.0.0-TC55"  # every example pins the same version: examples/shared/README.md
DATASTAR = "v1.0.2"
# The tools rail's components talk to the Synthigy engine directly, not to
# this BFF (see examples/shared/README.md) — a demo running standalone (no
# hub in front) would otherwise default to its own origin and 404 on every
# /data call.
_ENDPOINT = os.environ.get("SYNTHIGY_PUBLIC_ENDPOINT",
                           os.environ.get("SYNTHIGY_ENDPOINT", "http://localhost:7887"))
# Point the rail at a locally built bundle when one is present (dropped by
# examples/scripts/build-tooling.sh), so a component change can be tested
# before @synthigy/tooling is republished; otherwise the rail uses the pinned
# CDN version.
_LOCAL_BUNDLE = (Path(__file__).resolve().parent.parent.parent
                 / "shared" / "vendor" / "tooling" / "tooling.js").is_file()
_BUNDLE_CFG = (', bundle: "/vendor/tooling/tooling.js",'
               ' bundleCss: "/vendor/tooling/tooling.css"') if _LOCAL_BUNDLE else ""

PER_PAGE = 20
HITS_MIN_PLAYS = 1_000_000  # "hits only" threshold for the ?min_plays param


def esc(s) -> str:
    return "" if s is None else _html.escape(str(s), quote=True)


def fmt_plays(n) -> str:
    # `plays` mixes two units — real streaming counts (curated albums, up to
    # billions) and a Kaggle popularity sum (0-100 per track, low thousands).
    # A raw comma-grouped int both overflows the dashboard tile at 10+ digits
    # AND makes the two look deceptively comparable. SI-suffix both scales.
    if n is None:
        return "—"
    n = int(n)
    a = abs(n)
    if a >= 1_000_000_000:
        return f"{n / 1_000_000_000:.1f}B"
    if a >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if a >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def art(seed: str | None, cls: str = "art-sm", icon_size: str = "md",
        cover: str | None = None) -> str:
    """Album-art tile. Real cover image when the record has one (backfilled
    from Spotify/Deezer — see backfill_covers.py); otherwise a neutral gray
    gradient where the hash only nudges lightness, so tiles stay
    distinguishable without colour. A broken image URL removes itself and
    falls back to the gradient underneath."""
    h = int(hashlib.md5((seed or "?").encode()).hexdigest()[:10], 16)
    top = 26 + h % 12          # 26–37% lightness
    bot = 12 + (h >> 8) % 6    # 12–17%
    hue = 210 + (h >> 16) % 40  # cool gray drift, near-zero saturation
    img = (f'<img src="{esc(cover)}" alt="" loading="lazy" '
           f'onerror="this.remove()">') if cover else ""
    return (f'<div class="art {cls}" style="background:'
            f'linear-gradient(135deg,hsl({hue} 6% {top}%),hsl({hue} 8% {bot}%))">'
            f'{img}{icon("disc", icon_size)}</div>')


def sdk_chip(label: str, tip: str = "Python SDK call behind this block") -> str:
    """Tiny code chip naming the SDK primitive powering a UI block."""
    return (f'<code class="sdkchip">{esc(label)}'
            f'<ty-tooltip placement="top">{esc(tip)}</ty-tooltip></code>')


def tooltip(text: str, placement: str = "top") -> str:
    """Nested ty-tooltip — attaches to its PARENT element."""
    return f'<ty-tooltip placement="{placement}">{esc(text)}</ty-tooltip>'


def poke_html(key) -> str:
    """A poke: a fresh node whose data-init re-runs the albums refresh with
    the browser's CURRENT signals ($q/$limit/$hits/$sort). The live stream
    patches one of these per entity event — the page's ONE SSE connection
    never changes, so nothing leaks. (Re-pointing the stream by DOM swap
    does NOT abort the old fetch in this Datastar version: each sort/toggle
    change leaked one live SSE connection until the browser's 6-per-host
    limit starved every request — reproduced with Playwright, +1 per
    change, page dead at +6.)"""
    return f'<div id="pk-{key}" data-init="{_REFRESH}"></div>'


def toast_html(msg: str, flavor: str = "success",
               link: str | None = None, link_text: str = "view") -> str:
    ic = {"success": "zap", "danger": "ban"}.get(flavor, "info")
    extra = (f' <a href="{esc(link)}" class="font-semibold underline">'
             f'{esc(link_text)} →</a>') if link else ""
    return (f'<div class="toast-msg">'
            f'<ty-tag flavor="{flavor}" size="md">{icon(ic, "sm", "start")}'
            f'{esc(msg)}{extra}</ty-tag></div>')


# ── shell ────────────────────────────────────────────────────────────────

_NAV = [("/albums", "disc", "Albums"), ("/dashboard", "chart", "Dashboard")]

_STYLE = """
  /* Only what is this app's own. The look is examples/shared/theme.css plus
     ../brand/brand.css (Groove Harbor); swap the brand there, not here. */
  .sdkchip { font: 500 .66rem/1.3 var(--font-mono); padding: 2px 8px; border: 1px solid var(--ty-border);
             color: var(--ty-text-faint); white-space: nowrap; border-radius: 999px;
             text-transform: none; letter-spacing: 0; background: transparent; }
  /* Play counts are the one inked tag among neutrals. */
  ty-tag[flavor="rating"] { --tag-bg: var(--gh-ink); --tag-color: var(--gh-paper); --tag-border-color: var(--gh-ink); }
  .muted { color: var(--ty-text-faint); }
  .dl { font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
  .empty { color: var(--ty-text-faint); font: italic 1.15rem/1.4 var(--gh-font-serif); }
  h1.gh-display, h2.gh-display, h3.gh-display { display: block; }

  /* page heads: kicker, a big condensed title, an ink rule */
  .gh-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
             flex-wrap: wrap; padding-bottom: 16px; border-bottom: 2px solid var(--gh-ink); margin-bottom: 18px; }
  .gh-head h1 { font-size: clamp(3.2rem, 7vw, 5.4rem); margin: 10px 0 0; }
  .col-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
              padding-bottom: 10px; border-bottom: 2px solid var(--gh-ink); }

  /* home: the sleeve's front, then side A, then the liner notes */
  .hero { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 36px;
          align-items: center; padding: 18px 0 44px; border-bottom: 2px solid var(--gh-ink); }
  .hero h1 { font-size: clamp(3.8rem, 9.4vw, 7.8rem); margin: 16px 0 24px; }
  .hero .gh-lede { font: 1.45rem/1.3 var(--gh-font-serif); font-style: italic; max-width: 30ch; margin-bottom: 26px; }
  .hero-disc { display: flex; justify-content: center; }
  .hero-disc .gh-disc { --size: min(400px, 36vw); }
  .tracklist { list-style: none; margin: 0; padding: 0; }
  .track { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 22px; align-items: baseline;
           padding: 24px 0; border-bottom: 1px solid var(--ty-border); color: inherit; }
  .track:hover { text-decoration: none; }
  .track .no { font: 600 .74rem var(--font-mono); letter-spacing: .14em; color: var(--ty-text-faint); }
  .track h3 { display: block; margin: 0 0 8px; font: 850 2.4rem/.92 var(--gh-font-display); font-stretch: 68%;
              text-transform: uppercase; transition: color .15s; }
  .track p { margin: 0 0 12px; max-width: 62ch; color: var(--ty-text-soft); }
  .track .go { font-size: 1.7rem; line-height: 1; transition: transform .15s, color .15s; }
  .track:hover h3, .track:hover .go { color: var(--gh-blue); }
  .track:hover .go { transform: translateX(6px); }
  .tracklist.compact .track { padding: 18px 0; }
  .tracklist.compact .track h3 { font-size: 1.75rem; }
  .liner { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 36px; padding: 40px 0 8px; }
  .liner h2 { display: block; margin: 0; font: italic 2.6rem/1 var(--gh-font-serif); }
  .liner ol { columns: 2 300px; column-gap: 40px; margin: 0; padding-left: 1.3em; }
  .liner li { break-inside: avoid; margin: 0 0 14px; color: var(--ty-text-soft); }
  .liner li::marker { font: 600 .74rem var(--font-mono); color: var(--gh-blue); }

  /* the chart */
  .row { border-bottom: 1px solid var(--ty-border); }
  .row-link { color: inherit; transition: background .15s; }
  .row-link:hover { background: var(--gh-paper); text-decoration: none; }
  .row-link:hover .row-title { color: var(--gh-blue); }
  .rank { width: 2ch; text-align: right; font: 850 2.1rem/1 var(--gh-font-display); font-stretch: 62%;
          color: var(--ty-text-faint); font-variant-numeric: tabular-nums; }
  li:nth-child(-n+3) > .row-link .rank { color: var(--gh-ink); }
  li:first-child > .row-link .rank { color: var(--gh-blue); }
  .row-title { font: 700 1.08rem/1.25 var(--gh-font-display); transition: color .15s; }
  .row-by { font: .7rem/1.4 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ty-text-faint); }

  /* sleeves: square, the record slides out of the big one */
  .art { display: flex; align-items: center; justify-content: center; flex: none;
         color: rgba(255,255,255,.45); border-radius: 2px; position: relative; overflow: hidden; }
  .art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .art-sm { width: 52px; height: 52px; }
  .art-lg { width: 100%; aspect-ratio: 1; height: auto; box-shadow: 0 30px 50px -28px rgba(0,0,0,.6); }
  .sleeve { position: relative; width: 250px; margin-right: 96px; flex: none; }
  .sleeve .gh-disc { --size: 236px; position: absolute; top: 7px; left: 84px;
                     transition: left .6s cubic-bezier(.2,.8,.2,1); }
  .sleeve:hover .gh-disc { left: 120px; }
  .sleeve .art { z-index: 1; }
  .detail-top { display: flex; align-items: flex-end; gap: 36px; padding: 8px 0 32px;
                border-bottom: 2px solid var(--gh-ink); }
  .detail-top h1 { font-size: clamp(3rem, 6.4vw, 5.6rem); margin: 12px 0 14px; }
  .detail-top h1.long { font-size: clamp(2.4rem, 4.4vw, 3.8rem); }
  .detail-blurb { font: italic 1.35rem/1.35 var(--gh-font-serif); color: var(--ty-text-soft); margin: 0; max-width: 46ch; }
  .detail-cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 44px; padding-top: 28px; }
  .tno { width: 2.4ch; font: 600 .74rem var(--font-mono); color: var(--ty-text-faint); letter-spacing: .08em; }

  /* the dashboard: a scoreboard, then the charts */
  .scoreboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
                border-bottom: 1px solid var(--gh-ink); margin-bottom: 40px; }
  .counter { padding: 18px 20px 22px 0; }
  .counter + .counter { padding-left: 20px; border-left: 1px solid var(--ty-border); }
  .counter .value { margin-top: 12px; font: 850 clamp(3.2rem, 6vw, 4.8rem)/.88 var(--gh-font-display);
                    font-stretch: 62%; font-variant-numeric: tabular-nums; }
  #counter-plays-val { color: var(--gh-blue); }
  .bar-row { display: grid; grid-template-columns: 2ch minmax(0, 200px) 1fr 56px; gap: 14px;
             align-items: center; padding: 10px 0; border-bottom: 1px solid var(--ty-border); }
  .bar-row .n { font: 850 1.3rem/1 var(--gh-font-display); font-stretch: 62%; color: var(--ty-text-faint); text-align: right; }
  .bar-row a { color: var(--ty-text); font-weight: 600; }
  .bar-track { height: 12px; }
  .bar-fill { height: 100%; min-width: 2px; background: var(--gh-ink); transition: width .4s ease; }
  .bar-row:first-child .bar-fill { background: var(--gh-blue); }
  .bar-row:first-child .n { color: var(--gh-blue); }

  /* errors and sign-out: the code in outline, the record beside it */
  .err { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 48px; align-items: center; padding: 28px 0 40px; }
  .err .code { display: block; font: 850 clamp(7rem, 19vw, 14rem)/.8 var(--gh-font-display); font-stretch: 62%;
               text-transform: uppercase; color: transparent; -webkit-text-stroke: 2px var(--gh-ink); margin: 14px 0 22px; }
  .err .code.word { font-size: clamp(4.4rem, 11vw, 8rem); }
  .err h1 { font-size: clamp(2.4rem, 4.6vw, 3.6rem); margin: 0 0 14px; }
  .err .gh-disc { --size: min(320px, 30vw); }
  .err .gh-disc.skip { transform: rotate(-24deg); }
  .err .gh-disc.skip::before { background: conic-gradient(from 200deg, transparent 0 46%, var(--gh-bone) 46.4% 47%, transparent 47.4%); }

  /* the brand book's swatches */
  .swatches { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border: 1.5px solid var(--gh-ink); }
  .swatch { padding: 70px 14px 12px; font: .7rem/1.5 var(--font-mono); letter-spacing: .06em; }
  .swatch b { display: block; font-weight: 600; text-transform: uppercase; letter-spacing: .14em; }
  .specimens { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0;
               border: 1.5px solid var(--gh-ink); border-top: 0; }
  .specimen { padding: 18px 16px; }
  .specimen + .specimen { border-left: 1px solid var(--ty-border); }
  .specimen .big { font-size: 3rem; line-height: 1; margin: 10px 0 6px; display: block; }

  #toast { position: fixed; right: 20px; bottom: 76px; z-index: 500;
           display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
  .toast-msg { animation: toast 3s ease forwards; }
  @keyframes toast { 0% { opacity: 0; transform: translateY(8px); }
                     8% { opacity: 1; transform: none; }
                     80% { opacity: 1; } 100% { opacity: 0; } }

  @media (max-width: 760px) {
    .topbar { padding-left: 16px; padding-right: 16px; gap: 12px; }
    .topbar .pill, .topbar .tour-btn, .footer-credit { display: none; }
    .page-scroll > main { padding-left: 16px; padding-right: 16px; }
    .filters { flex-wrap: wrap; }
    .filters > ty-input { flex-basis: 100%; }
    .row-link { gap: 12px; padding-left: 4px; grid-template-columns: auto minmax(0, 1fr) auto !important; }
    .topbar .gh-wordmark-sm { display: none; }
    .topbar nav { margin-left: 0; }
    .row-link .art, .row-link .trk { display: none; }
    .rank { font-size: 1.6rem; }
    .track { grid-template-columns: 1fr auto; }
    .track .no { display: none; }
    .hero, .err, .liner, .detail-cols { grid-template-columns: 1fr; }
    .hero-disc, .err .gh-disc { display: none; }
    .detail-top { flex-direction: column; align-items: flex-start; }
    .sleeve { width: 200px; }
    .sleeve .gh-disc { --size: 190px; }
  }
"""

BRAND = "Groove Harbor"
EXAMPLES_URL = os.environ.get("EXAMPLES_URL", "")


def logo(px: int = 28) -> str:
    return f'<img class="gh-logo" src="/brand/logo.svg" width="{px}" height="{px}" alt="">'


def layout(title: str, user, content: str, stream: str | None = None,
           signals: dict | None = None, tools: bool = True) -> str:
    # Page-level signals live on <main>, OUTSIDE any SSE-patched fragment, so
    # live repaints never re-initialise them mid-edit.
    signals_attr = f" data-signals='{esc(_json.dumps(signals))}'" if signals else ""
    back = (f'<a class="back-link flex items-center gap-1" href="{esc(EXAMPLES_URL)}">'
            f'{icon("arrow-left", "xs")}examples</a>') if EXAMPLES_URL else ""
    rail = (f"""<script>
    window.SYNTHIGY_TOOLS = {{ endpoint: "{_ENDPOINT}", xsql: ["/xsql/music.xsql"]{_BUNDLE_CFG} }};
    window.SYNTHIGY_TOUR = "/tour.json";
  </script>
  <script src="/tools-rail.js"></script>
  <script src="/scenario.js"></script>""") if tools else ""
    who = (f'<span class="gh-kicker hidden md:inline"><b>{esc(user.name)}</b></span>'
           '<form method="POST" action="/logout" style="display:inline">'
           f'<ty-button size="sm" flavor="neutral" appearance="outlined" type="submit">{icon("log-out","sm","start")}Sign out</ty-button></form>'
           if user else
           f'<a href="/login"><ty-button size="sm" flavor="neutral" appearance="outlined">{icon("log-in","sm","start")}Sign in</ty-button></a>')
    nav = ''.join(f'<a class="nav-link" href="{h}">{esc(t)}</a>' for h, _i, t in _NAV)
    return f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{esc(title)} · {BRAND}</title>
  <link rel="icon" href="/brand/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@{TYRELL}/css/tyrell.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tyrell-components@{TYRELL}/css/tyrell-theme.css">
  <script type="module" src="https://cdn.jsdelivr.net/npm/tyrell-components@{TYRELL}/dist/tyrell.js"></script>
  <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@{DATASTAR}/bundles/datastar.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = {{ corePlugins: {{ preflight: false }} }}</script>
  <link rel="stylesheet" href="/theme.css">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>{_STYLE}</style>
</head>
<body class="ty-canvas">
  <header class="topbar flex items-center px-6 py-2.5 gap-5 shrink-0">
    {back}
    <a class="brand flex items-center gap-3" href="/">
      {logo(36)}<span class="gh-wordmark-sm">Groove<br>Harbor</span>
    </a>
    <nav class="flex gap-1 flex-1 ml-3">{nav}</nav>
    <span class="pill"><span class="live-dot"></span>On air
      {tooltip("Live: watch events stream from Synthigy /data/events through the BFF to this page")}</span>
    <script>
      (function () {{ var p = location.pathname;
        document.querySelectorAll(".topbar nav a").forEach(function (a) {{
          var h = a.getAttribute("href");
          if (h && h !== "/" && (p === h || p.indexOf(h + "/") === 0)) a.setAttribute("aria-current","page");
        }}); }})();
    </script>
    <div class="flex items-center gap-3">
      <ty-button class="tour-btn" size="sm" flavor="primary" onclick="location.href='/albums?tour=1'">{icon("compass","sm","start")}Take the tour</ty-button>
      {who}
    </div>
  </header>
  <div class="page-scroll">
    {f'<div id="page-stream" data-init="@get({stream!r})"></div>' if stream else ''}
    <main class="max-w-[1120px] mx-auto px-6 pt-8 pb-24"{signals_attr}>{content}</main>
  </div>
  <div id="toast"></div>
  <footer class="px-6 py-3 text-[0.8em] shrink-0 flex flex-wrap items-center gap-3 justify-between">
    <div class="flex flex-wrap items-center gap-3"><div id="footer-tools" class="flex flex-wrap items-center gap-2"></div>
      <a href="/brand" class="flex items-center gap-1">{icon("palette","xs")}The brand book</a></div>
    <span class="footer-credit">{BRAND} is a made-up brand on Synthigy · Python SDK · components by tyrell, reactivity by datastar</span>
  </footer>
  {rail}
  <script src="/chrome.js"></script>
</body>
</html>"""


# ── landing ──────────────────────────────────────────────────────────────

def landing_page(user) -> str:
    cta = (f'<a href="/albums"><ty-button flavor="primary">{icon("disc","sm","start")}'
           'Open the chart</ty-button></a>'
           if user else
           f'<a href="/login"><ty-button flavor="primary">{icon("log-in","sm","start")}'
           'Sign in to start</ty-button></a>')
    side_a = "".join(
        f'<li><a class="track" href="{h}"><span class="no">A{n}</span><div>'
        f'<h3>{esc(t)}</h3><p>{esc(d)}</p>'
        f'<div class="flex flex-wrap gap-1.5">{"".join(sdk_chip(p) for p in prims)}</div></div>'
        f'<span class="go">→</span></a></li>'
        for n, (h, t, d, prims) in enumerate([
            ("/albums", "The live chart",
             "Top albums by plays, live. Search, filter to 1M+ hits, grow the "
             "window, and bump play counts — every tab repaints in place.",
             ["watch_entities()", "await stack()"]),
            ("/dashboard", "The numbers",
             "Counters and a live top-albums chart. First paint is ONE wire "
             "request (batch); updates ride a SQL-template watch.",
             ["await overview_async()  # @batch", "DashboardAsync.watch_stats()"]),
            ("/albums", "Edit anything",
             "Add tracks, link and unlink genres, delete albums — nested "
             "writes, additive stack, surgical slice, soft delete.",
             ["await stack()", "await slice()", "await delete()"]),
            ("/brand", "The brand book",
             "Every page a visitor can meet, in this brand: the app, its errors, "
             "sign-out and the engine's own sign-in. Swap it for yours (README).",
             ["music/brand/", "python brand.py"]),
        ], 1))
    return layout("Home", user, f"""
      <section class="hero">
        <div>
          <span class="gh-kicker"><b>Groove Harbor</b> · a made-up record shop on Synthigy</span>
          <h1 class="gh-display">Your record<br>shelf, <em>live.</em></h1>
          <p class="gh-lede">Every album, every play, every tab in sync — the moment it changes.</p>
          <div class="flex items-center gap-3 flex-wrap">{cta}
            <a href="/brand"><ty-button flavor="neutral" appearance="outlined">{icon("palette","sm","start")}See the brand</ty-button></a></div>
        </div>
        <div class="hero-disc"><div class="gh-disc gh-spin"></div></div>
      </section>
      <div class="col-head mt-10"><span class="gh-kicker"><b>Side A</b> · what to try</span>
        <span class="gh-kicker">4 tracks</span></div>
      <ol class="tracklist">{side_a}</ol>
      <section class="liner">
        <div><span class="gh-kicker"><b>Liner notes</b></span><h2 class="mt-3">Under the hood</h2></div>
        <ol>
          <li>A FastAPI BFF using the <code>synthigy</code> Python SDK against <code>/data</code>. The browser sees only HTML and SSE patches — no API keys, no JWT, no JSON.</li>
          <li>One <code>synthigy</code> client per BFF process; every call carries identity with <code>acting_as=user.xid</code>.</li>
          <li>One SSE from BFF → Synthigy <code>/data/events</code>, however many tabs are open.</li>
          <li>Live updates are notify-then-refetch: writes don't repaint anything themselves — the watch does.</li>
          <li>Typed ops (<code>MusicAlbum.list</code>, <code>Dashboard.watch_stats</code>, …) are codegen'd from <code>../xsql/music.xsql</code>.</li>
          <li>Login is OIDC authorization-code with PKCE, on the engine's sign-in page in this brand. Tokens stay server-side.</li>
          <li>The small <code class="sdkchip">code chips</code> name the SDK call behind each block.</li>
        </ol>
      </section>""")


# ── album list ───────────────────────────────────────────────────────────

def _artist_chips(artists) -> str:
    return "".join(
        f'<ty-tag size="xs" flavor="neutral">{esc(a.get("name"))}</ty-tag>'
        for a in (artists or [])[:3])


def album_row(a: dict, rank: int = 0) -> str:
    xid = a.get("xid")
    count = a.get("_count") or {}
    tracks = count.get("tracks", 0)
    plays = a.get("plays") or 0
    plays_title = f"{plays:,} plays"
    by = ", ".join(ar.get("name") or "" for ar in (a.get("artists") or [])[:3])
    blurb = a.get("blurb") or ""
    return f"""<li id="album-{esc(xid)}" class="row relative flex items-center pr-[10px]">
      <a class="row-link flex-1 min-w-0 grid grid-cols-[auto_auto_minmax(0,1fr)_auto] gap-5 items-center px-3 py-3.5"
         href="/albums/{esc(xid)}">
        <span class="rank">{rank if rank else ""}</span>
        {art(xid, cover=a.get("cover"))}
        <div class="min-w-0">
          <div class="truncate row-title">{esc(a.get("title") or "(untitled)")}</div>
          <div class="truncate row-by mt-1">{esc(by)}{(" · " if by and blurb else "")}<span class="normal-case tracking-normal">{esc(blurb)}</span></div>
        </div>
        <div class="inline-flex items-center gap-2 whitespace-nowrap">
          <span class="trk muted dl text-[0.78rem]">{tracks} trk{tooltip(f"{tracks} track(s)")}</span>
          <ty-tag size="sm" flavor="rating">
            <span class="dl font-semibold">{esc(fmt_plays(plays))}</span>
            {tooltip(plays_title)}</ty-tag>
        </div>
      </a>
      <ty-button action pill size="sm" flavor="neutral" appearance="outlined"
        data-on:click="@post('/albums/{esc(xid)}/play')">
        {icon("play","sm")}{tooltip("Play — +1 play via stack_music_album()")}</ty-button>
    </li>"""


# The one search/filter/window/sort refetch — every control funnels through it.
_REFRESH = ("@get('/albums-search?q='+encodeURIComponent($q)"
            "+'&limit='+$limit+'&hits='+$hits+'&sort='+$sort)")

_SORTS = [("plays", "Most played"), ("az", "Title A→Z"),
          ("za", "Title Z→A"), ("newest", "Recently added")]


def albums_page(user, initial: list[dict], term: str, hits: bool,
                sort: str = "plays") -> str:
    shown = len(initial)
    sort_options = "".join(
        f'<ty-option value="{v}"{" selected" if v == sort else ""}>{esc(label)}</ty-option>'
        for v, label in _SORTS)
    content = f"""
      <div class="gh-head">
        <div>
          <span class="gh-kicker"><b>The chart</b> · <span id="albums-meta" class="dl">{search_meta(term, shown)}</span></span>
          <h1 class="gh-display">Albums</h1>
        </div>
        <span class="flex items-center gap-2 flex-wrap">
          {sdk_chip('watch_entities() → await MusicAlbumAsync.list(?sort)',
                    "Entity poke channel + refetch with current signals — "
                    "the stream itself never changes")}
          <ty-button size="sm" flavor="primary" data-tour="add-album" data-on:click="$_adding=!$_adding">
            {icon("plus","sm","start")}Add album
            {tooltip("New album via stack — nested artist write, deterministic artist+title identity")}</ty-button>
        </span>
      </div>
      <div data-show="$_adding" class="surface p-4 mb-4" style="display:none;border:1.5px solid var(--gh-ink)">
        <div class="flex items-center justify-between mb-3">
          <span class="muted text-[0.72rem] uppercase tracking-wider">New album</span>
          {sdk_chip("await aclient().stack(MusicAlbumInput) + nested artist")}
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <ty-input size="sm" placeholder="Album title *" class="flex-1 min-w-[180px]"
            data-bind="album_title"></ty-input>
          <ty-input size="sm" placeholder="Artist *" class="flex-1 min-w-[140px]"
            data-bind="album_artist"></ty-input>
          <ty-input size="sm" placeholder="One-line blurb" class="flex-[2] min-w-[200px]"
            data-bind="album_blurb"
            data-on:keydown="evt.key==='Enter' && @post('/albums/new')"></ty-input>
          <ty-button size="sm" flavor="primary" data-on:click="@post('/albums/new')">
            {icon("plus","sm","start")}Create</ty-button>
          <ty-button size="sm" flavor="neutral" appearance="outlined" data-on:click="$_adding=false">Cancel</ty-button>
        </div>
        <p class="m-0 mt-2 text-[0.78rem] muted">Identity is the deterministic
          artist+title xid — creating the same album twice upserts instead of
          duplicating. The artist is a nested write: created if new, linked if known.
          Every open tab's list, search and dashboard repaint from the same watch events.</p>
      </div>
      <div class="filters flex gap-2 mb-4 items-center">
        <ty-input placeholder="Filter by title…" size="md" class="flex-1 block"
          data-bind="q" value="{esc(term)}"
          data-on:input__debounce.300ms="$limit={PER_PAGE};{_REFRESH}"></ty-input>
        <ty-select size="sm" class="w-[170px]" data-tour="sort"
          data-on:change="$sort=evt.detail.value;$limit={PER_PAGE};{_REFRESH}">
          {sort_options}
        </ty-select>
        <label class="flex items-center gap-2 text-[0.88rem] soft whitespace-nowrap cursor-pointer">
          <ty-switch data-attr:checked="$hits"
            data-on:change="$hits=evt.detail.checked;$limit={PER_PAGE};{_REFRESH}"></ty-switch>
          {icon("flame","sm")}1M+ plays
          {tooltip("Only albums with 1M+ plays — a gt() filter on plays")}
        </label>
      </div>
      <ul id="albums" data-tour="play" class="m-0 p-0 list-none">{albums_list_html(initial, term)}</ul>
      <div id="poke"></div>
      <div class="mt-6 text-center">
        <ty-button size="sm" flavor="neutral" appearance="outlined"
          data-on:click="$limit=$limit+{PER_PAGE};{_REFRESH}">
          {icon("download","sm","start")}Show more
          {tooltip("Grow the query window — ?limit param; the live watch follows")}</ty-button>
      </div>"""
    # ONE fixed stream per page — a poke channel with no query window. Live
    # events patch #poke with a node that re-fires the refresh using the
    # browser's CURRENT signals, so sort/search/toggle never re-point the
    # stream (see poke_html for why re-pointing leaks connections).
    return layout("Albums", user, content, stream="/stream/albums",
                  signals={"q": term, "limit": PER_PAGE, "hits": hits,
                           "sort": sort, "_adding": False, "album_title": "",
                           "album_artist": "", "album_blurb": ""})


def search_meta(term: str, shown: int) -> str:
    # `shown` is the current window, not a true match count — the list query
    # has no COUNT companion. Word it as a window so it doesn't lie.
    if term:
        return f'showing top {shown} for "{esc(term)}"'
    return f"showing top {shown}"


def albums_list_html(rows: list[dict], term: str) -> str:
    return "".join(album_row(a, i + 1) for i, a in enumerate(rows)) or \
        f'<li class="empty px-[22px] py-4">No albums match "{esc(term)}".</li>'


# ── album detail ─────────────────────────────────────────────────────────

def _track_row(t: dict, n: int = 0) -> str:
    txid = t.get("xid")
    explicit = t.get("explicit")
    title = esc(t.get("title") or "?")
    when = esc((t.get("release_on") or "")[:10])
    length = t.get("length")
    # Quiet "E" square, the streaming-app convention — not a red warning.
    badge = (f'<ty-tag size="xs" flavor="neutral">E{tooltip("explicit lyrics")}</ty-tag>'
             if explicit else "")
    lentag = f'<span class="muted text-[0.8rem] dl">{esc(length)}</span>' if length else ""
    return (f'<div class="row flex items-center gap-3 py-2.5">'
            f'<span class="tno">{n:02d}</span>'
            f'<span class="font-semibold truncate">{title}</span>'
            f'<span class="muted text-[0.78rem] dl">{when}</span>'
            f'<span class="ml-auto flex items-center gap-2">{lentag}{badge}'
            f'<ty-button action pill size="xs" appearance="ghost" flavor="danger"'
            f' data-on:click="@post(\'/tracks/{esc(txid)}/delete\')">{icon("trash","xs")}'
            f'{tooltip("Remove — delete_music_track() (soft delete)")}</ty-button>'
            f'</span></div>')


def _genre_chip(axid: str | None, g: dict) -> str:
    gxid = g.get("xid")
    return (f'<ty-tag size="xs" flavor="neutral" dismissible'
            f' data-on:dismiss="@post(\'/albums/{esc(axid)}/genres/{esc(gxid)}/remove\')">'
            f'{esc(g.get("label"))}'
            f'{tooltip("Unlink — sync() replaces the link-set minus this one")}</ty-tag>')


def album_detail_card(a: dict) -> str:
    xid = a.get("xid")
    tracks = a.get("tracks") or []
    artists = a.get("artists") or []
    genres = a.get("genres") or []
    link = a.get("link")
    link_html = (f'<a href="{esc(link)}" target="_blank" rel="noopener" '
                 f'class="gh-kicker inline-flex items-center gap-1" style="color:var(--gh-blue)">'
                 f'{icon("external","xs")}listen</a>') if link else ""
    track_html = "".join(_track_row(t, i + 1) for i, t in enumerate(tracks)) or \
        '<div class="empty py-3">No tracks yet.</div>'
    artist_html = "".join(
        f'<div class="flex items-center gap-2 py-2.5 row">'
        f'<span class="font-semibold">{esc(ar.get("name"))}</span>'
        f'<span class="gh-kicker ml-auto">{esc(ar.get("country") or "")}</span></div>'
        for ar in artists) or '<div class="empty py-3">No artists.</div>'
    genre_html = "".join(_genre_chip(xid, g) for g in genres) or \
        '<span class="empty">No genres.</span>'
    plays = a.get("plays") or 0
    plays_title = f"{plays:,} total plays"
    by = ", ".join(ar.get("name") or "" for ar in artists[:3])
    return f"""<div id="album-{esc(xid)}">
      <div class="detail-top">
        <div class="sleeve"><div class="gh-disc"></div>{art(xid, "art-lg", "xl", cover=a.get("cover"))}</div>
        <div class="flex-1 min-w-0">
          <span class="gh-kicker"><b>LP</b> · {len(tracks)} tracks{(" · " + esc(by)) if by else ""}</span>
          <h1 class="gh-display{" long" if len(a.get("title") or "") > 28 else ""}">{esc(a.get("title"))}</h1>
          <p class="detail-blurb">{esc(a.get("blurb") or "")}</p>
          <div class="flex items-center gap-3 flex-wrap mt-6">
            <ty-button flavor="primary"
              data-on:click="@post('/albums/{esc(xid)}/play')">
              {icon("play","sm","start")}Play
              {tooltip("+1 play — stack_music_album(); watches repaint every tab")}</ty-button>
            <ty-tag flavor="rating" size="md">
              <span class="dl font-bold">{esc(fmt_plays(plays))}</span>&nbsp;plays
              {tooltip(plays_title)}</ty-tag>
            {link_html}
          </div>
        </div>
      </div>
      <div class="detail-cols">
        <section>
          <div class="col-head"><span class="gh-kicker"><b>Tracklist</b></span>
            {sdk_chip("await aclient().stack(MusicTrackInput)")}</div>
          {track_html}
          <div class="pt-4">
            <div class="flex items-center gap-2">
              <ty-input size="sm" placeholder="Track title" class="flex-1" data-bind="track_title"></ty-input>
              <ty-input size="sm" placeholder="3:45" class="w-[70px]" data-bind="track_length"></ty-input>
              <ty-button size="sm" flavor="neutral" appearance="outlined"
                data-on:click="@post('/albums/{esc(xid)}/tracks')">
                {icon("plus","sm","start")}Add
                {tooltip("Nested write: track links to this album via album: xid")}</ty-button>
            </div>
            <label class="flex items-center gap-2 mt-2 text-[0.8rem] muted cursor-pointer">
              <ty-switch size="sm" data-attr:checked="$track_explicit"
                data-on:change="$track_explicit=evt.detail.checked"></ty-switch>
              explicit lyrics</label>
          </div>
        </section>
        <section>
          <div class="col-head"><span class="gh-kicker"><b>Credits</b></span></div>
          {artist_html}
          <div class="col-head mt-8"><span class="gh-kicker"><b>Genres</b></span>
            {sdk_chip("await stack() / sync() / slice()")}</div>
          <div class="py-3 flex flex-wrap gap-1.5 items-center" data-tour="genres">{genre_html}</div>
          <div class="flex items-center gap-2">
            <ty-input size="sm" placeholder="Add genre…" class="flex-1" data-bind="genre_label"
              data-on:keydown="evt.key==='Enter' && @post('/albums/{esc(xid)}/genres')"></ty-input>
            <ty-button action pill size="sm" flavor="neutral" appearance="outlined"
              data-on:click="@post('/albums/{esc(xid)}/genres')">{icon("plus","sm")}
              {tooltip("stack_music_album() with a deterministic-xid genre — additive, idempotent")}</ty-button>
            <ty-button size="sm" flavor="neutral" appearance="outlined"
              data-on:click="confirm('Unlink ALL genres? (slice cuts the whole link-set)') && @post('/albums/{esc(xid)}/genres/clear')">
              {icon("x","sm","start")}clear
              {tooltip("synthigy.slice() — cuts the whole genres link-set in one op")}</ty-button>
          </div>
        </section>
      </div>
    </div>"""


def history_html(events) -> str:
    """Audit timeline via synthigy.history().events(record_xid=…).
    Rendered once at page load; empty string when no audit provider."""
    if not events:
        return ""
    rows = []
    for ev in events[:10]:
        if not isinstance(ev, dict):
            continue
        ts = ev.get("ts") or ev.get("at") or ev.get("time") or ""
        op = ev.get("op") or ev.get("action") or ev.get("event") or "change"
        who = ev.get("user") or ev.get("by") or ev.get("actor") or ""
        if isinstance(who, dict):
            who = who.get("name") or who.get("xid") or ""
        rows.append(
            f'<div class="row flex items-center gap-3 px-4 py-2">'
            f'{icon("clock","xs")}'
            f'<span class="dl muted text-[0.8rem]">{esc(str(ts)[:19].replace("T", " "))}</span>'
            f'<ty-tag size="sm" flavor="neutral">{esc(op)}</ty-tag>'
            f'<span class="muted text-[0.82rem] ml-auto">{esc(who)}</span></div>')
    if not rows:
        return ""
    return f"""<section class="mt-12">
      <div class="col-head"><span class="gh-kicker"><b>Change history</b></span>
        {sdk_chip("await aclient().history.events(record_xid=…)")}</div>
      {''.join(rows)}
    </section>"""


def album_detail_page(user, album: dict, history: str = "") -> str:
    xid = album.get("xid")
    content = f"""
      <div class="flex items-center justify-between mb-4">
        <a href="/albums" class="gh-kicker inline-flex items-center gap-1">
          {icon("arrow-left","xs")}back to the chart</a>
        <ty-button size="sm" flavor="danger"
          onclick="document.getElementById('delete-modal').show()">
          {icon("trash","sm","start")}Delete album
          {tooltip("delete_music_album() — soft delete; the list watch drops it live")}</ty-button>
      </div>
      <ty-modal id="delete-modal">
        <div class="surface p-6 rounded-lg max-w-md">
          <h3 class="m-0 mb-2 text-[1.05rem] font-semibold flex items-center gap-2">
            {icon("trash","sm")}Delete “{esc(album.get("title"))}”?</h3>
          <p class="m-0 mb-4 soft text-[0.9rem]">Soft delete via
            <code>delete_music_album()</code> — every open list drops it live.</p>
          <div class="flex justify-end gap-2">
            <ty-button size="sm" flavor="neutral" appearance="outlined"
              onclick="document.getElementById('delete-modal').hide()">Cancel</ty-button>
            <form method="POST" action="/albums/{esc(xid)}/delete" style="display:inline">
              <ty-button size="sm" flavor="danger" type="submit">
                {icon("trash","sm","start")}Delete</ty-button>
            </form>
          </div>
        </div>
      </ty-modal>
      {album_detail_card(album)}
      {history}"""
    return layout(album.get("title") or "Album", user, content,
                  stream=f"/stream/albums/{esc(xid)}",
                  signals={"track_title": "", "track_length": "",
                           "track_explicit": False, "genre_label": ""})


# ── dashboard ────────────────────────────────────────────────────────────

COUNTERS = [
    ("albums", "disc", "Albums"),
    ("tracks", "music", "Tracks"),
    ("plays", "play", "Plays"),
    ("artists", "users", "Artists"),
]


def counter_text(key: str, val) -> str:
    if key == "plays":
        return fmt_plays(val)  # this tile is the one that overflows at 10+ digits
    return f"{val:,}" if isinstance(val, int) else ("—" if val is None else str(val))


def top_chart_html(rows: list[dict]) -> str:
    if not rows:
        return '<div class="empty py-3">No albums yet.</div>'
    top = max((r.get("plays") or 0) for r in rows) or 1
    bars = "".join(
        f'<div class="bar-row"><span class="n">{n}</span>'
        f'<a class="truncate text-[0.9rem]" href="/albums/{esc(r.get("xid"))}">{esc(r.get("title"))}</a>'
        f'<div class="bar-track"><div class="bar-fill" style="width:{max(1, round(100 * (r.get("plays") or 0) / top))}%"></div></div>'
        f'<span class="dl muted text-[0.8rem] text-right">{esc(fmt_plays(r.get("plays")))}</span>'
        f'</div>'
        for n, r in enumerate(rows, 1))
    return bars


def _bclub_html(rows: list[dict]) -> str:
    if not rows:
        return '<div class="empty py-3">Nobody yet — go press play a billion times.</div>'
    return "".join(
        f'<div class="row flex items-center gap-3 py-2.5">'
        f'{art(r.get("xid"), "art-sm", "sm", cover=r.get("cover"))}'
        f'<a class="truncate flex-1 font-semibold text-[0.92rem]" style="color:var(--ty-text)" href="/albums/{esc(r.get("xid"))}">{esc(r.get("title"))}</a>'
        f'<span class="dl font-semibold" style="color:var(--gh-blue)">{esc(fmt_plays(r.get("plays")))}</span></div>'
        for r in rows)


def dashboard_page(user, stats: dict, top: list[dict], bclub: list[dict]) -> str:
    tiles = "".join(
        f'<div class="counter">'
        f'<span class="gh-kicker"><b>{esc(label)}</b></span>'
        f'<div id="counter-{key}-val" class="value">{counter_text(key, stats.get("total_" + key))}</div></div>'
        for key, _i, label in COUNTERS)
    content = f"""
      <div class="gh-head">
        <div>
          <span class="gh-kicker"><b>Dashboard</b> · live</span>
          <h1 class="gh-display">The <em>numbers</em></h1>
        </div>
        {sdk_chip("await overview_async()  # @batch: list + stats, ONE request")}
      </div>
      <p class="muted mb-2 text-[0.9rem]">First paint is one batched wire call;
        live updates ride <code>Dashboard.watch_stats()</code> — a SQL-template
        watch over three entities.</p>
      <div class="scoreboard">{tiles}</div>
      <div class="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-11">
        <section>
          <div class="col-head"><span class="gh-kicker"><b>Most played</b></span>
            {sdk_chip("DashboardAsync.watch_stats() → await MusicAlbumAsync.list()")}</div>
          <div id="top-chart">{top_chart_html(top)}</div>
        </section>
        <section>
          <div class="col-head"><span class="gh-kicker"><b>Billion club</b></span>
            {sdk_chip('await aclient().search("music_album", {"plays": gt(1e9)})')}</div>
          {_bclub_html(bclub)}
        </section>
      </div>"""
    return layout("Dashboard", user, content, stream="/stream/dashboard")


# ── brand: error, signed-out and the gallery of every page ───────────────
# Every page a visitor can land on wears the brand, the app's errors
# included: nothing falls back to a framework's or the platform's default.

ERRORS = {
    404: ("alert", "This record isn't on the shelf",
          "The page you asked for doesn't exist, or was moved."),
    403: ("lock", "This one's behind the counter",
          "You're signed in, but your account may not see this. The engine said no, not this app."),
    500: ("alert", "The needle skipped",
          "Something broke on our side. Try again in a moment."),
    "auth": ("lock", "We couldn't sign you in",
             "The sign-in didn't finish. Start again, and if it keeps happening, tell whoever runs Groove Harbor."),
}


def error_page(user, kind, detail: str | None = None, preview: bool = False) -> str:
    _ic, title, text = ERRORS[kind]
    big = f"{kind}" if isinstance(kind, int) else "Sign-in"
    note = (f'<p class="gh-kicker mt-6">Preview · from <a href="/brand">the brand book</a></p>'
            if preview else "")
    return layout(title, user, f"""
      <section class="err">
        <div>
          <span class="gh-kicker"><b>{"Error" if isinstance(kind, int) else "Sign-in failed"}</b> · Groove Harbor</span>
          <span class="code{"" if isinstance(kind, int) else " word"}">{esc(big)}</span>
          <h1 class="gh-display">{esc(title)}</h1>
          <p class="m-0 soft max-w-[48ch] text-[1.02rem]">{esc(text)}</p>
          {f'<p class="mt-4"><code>{esc(detail)}</code></p>' if detail else ''}
          <div class="flex gap-3 mt-7 flex-wrap">
            <a href="/"><ty-button flavor="primary">{icon("home","sm","start")}Back to the shelf</ty-button></a>
            {'<a href="/login"><ty-button flavor="neutral" appearance="outlined">' + icon("log-in","sm","start") + 'Sign in again</ty-button></a>' if kind == "auth" else ''}
          </div>
          {note}
        </div>
        <div class="gh-disc skip"></div>
      </section>""", tools=False)


def signed_out_page(user=None) -> str:
    return layout("Signed out", user, f"""
      <section class="err">
        <div>
          <span class="gh-kicker"><b>Signed out</b> · Groove Harbor</span>
          <h1 class="gh-display mt-4" style="font-size:clamp(3.4rem,8vw,6.4rem)">See you at the <em>next spin.</em></h1>
          <p class="m-0 soft max-w-[46ch] text-[1.02rem]">You're signed out of {BRAND}. Your shelf is right where you left it.</p>
          <div class="flex gap-3 mt-7 flex-wrap">
            <a href="/login"><ty-button flavor="primary">{icon("log-in","sm","start")}Sign in again</ty-button></a>
            <a href="/"><ty-button flavor="neutral" appearance="outlined">{icon("home","sm","start")}Home</ty-button></a>
          </div>
        </div>
        <div class="gh-disc"></div>
      </section>""", tools=False)


# The brand book's palette and type, as brand.css names them.
_SWATCHES = [("Bone", "--gh-bone", "the page", "var(--gh-ink)"),
             ("Paper", "--gh-paper", "sleeves, fields", "var(--gh-ink)"),
             ("Ink", "--gh-ink", "text, rules, the record", "var(--gh-paper)"),
             ("Harbor blue", "--gh-blue", "the one accent", "var(--gh-paper)"),
             ("Line", "--gh-line", "hairlines", "var(--gh-ink)")]


def brand_page(user, engine: str, bundle: str) -> str:
    """The brand book: the palette and type, then every page a visitor can
    meet, with where each comes from: this app, or the engine's bundle."""
    login = f"{engine}/login/{bundle}"

    def track(no, href, title, where, text, ext=False):
        target = ' target="_blank" rel="noopener"' if ext else ""
        return (f'<li><a class="track" href="{esc(href)}"{target}><span class="no">{no}</span><div>'
                f'<h3>{esc(title)}</h3><p>{esc(text)}</p>'
                f'<span class="gh-kicker">{esc(where)}</span></div>'
                f'<span class="go">{"↗" if ext else "→"}</span></a></li>')

    side_a = "".join([
        track("A1", "/", "The app", "this app", "Masthead, pages, components: shared/theme.css under brand.css."),
        track("A2", "/signed-out", "Signed out", "this app", "Where Sign out lands. The engine has no page of its own for this."),
        track("A3", "/brand/preview/404", "Not found · 404", "this app", "Any address this app doesn't know."),
        track("A4", "/brand/preview/403", "Forbidden · 403", "this app", "When the engine refuses a read for the signed-in person."),
        track("A5", "/brand/preview/500", "Something broke · 500", "this app", "Any error the app didn't expect."),
        track("A6", "/brand/preview/auth", "Sign-in failed", "this app", "When the sign-in comes back with an error or is cancelled."),
    ])
    side_b = "".join([
        track("B1", "/login", "Sign in", f"engine · {bundle} bundle", "The engine serves the bundle's index.html for this app's OAuth client."),
        track("B2", f"{login}/status.html?value=error&error=expired_code", "Sign-in status", f"engine · {bundle} bundle",
              "The outcome page. Built, but the engine serves it from the default bundle only (see README).", True),
        track("B3", f"{login}/error.html?error=redirect_missmatch&secure=true", "Rejected request", f"engine · {bundle} bundle",
              "Before sign-in, e.g. a bad return address. Default bundle only, like status (see README).", True),
    ])
    swatches = "".join(
        f'<div class="swatch" style="background:var({var});color:{fg}"><b>{esc(name)}</b>{var}<br>{esc(use)}</div>'
        for name, var, use, fg in _SWATCHES)
    return layout("The brand book", user, f"""
      <section class="hero">
        <div>
          <span class="gh-kicker"><b>The brand book</b> · music/brand/</span>
          <h1 class="gh-display">Groove Harbor,<br><em>everywhere.</em></h1>
          <p class="gh-lede">One stylesheet, one logo, three fonts — on every page a visitor can meet.</p>
          <p class="soft max-w-[56ch]">This app, its errors, and the engine's own sign-in all read
            <code>music/brand/brand.css</code>. Swap its tokens and <code>logo.svg</code>, run
            <code>brand.py</code>, and all of it is yours.</p>
        </div>
        <div class="hero-disc"><img src="/brand/logo.svg" alt="" style="width:min(300px,30vw);height:auto"></div>
      </section>
      <div class="col-head mt-10 mb-5"><span class="gh-kicker"><b>Palette</b> · and type</span></div>
      <div class="swatches">{swatches}</div>
      <div class="specimens">
        <div class="specimen"><span class="gh-kicker">Display · Archivo, condensed 850</span>
          <span class="big gh-display">Side A</span></div>
        <div class="specimen"><span class="gh-kicker">Voice · Instrument Serif italic</span>
          <span class="big gh-serif">live, in sync.</span></div>
        <div class="specimen"><span class="gh-kicker">Small print · IBM Plex Mono</span>
          <span class="big" style="font:500 1.6rem/1.2 var(--gh-font-mono);margin-top:18px">33⅓ RPM</span></div>
      </div>
      <div class="col-head mt-12"><span class="gh-kicker"><b>Side A</b> · pages this app renders</span>
        <span class="gh-kicker">6 tracks</span></div>
      <ol class="tracklist compact">{side_a}</ol>
      <div class="col-head mt-12"><span class="gh-kicker"><b>Side B</b> · pages the engine serves from the {esc(bundle)} bundle</span>
        <span class="gh-kicker">3 tracks</span></div>
      <ol class="tracklist compact">{side_b}</ol>
      <section class="liner">
        <div><span class="gh-kicker"><b>Liner notes</b></span><h2 class="mt-3">Not branded yet</h2></div>
        <ol>
          <li>Status, error, device and claim pages come from the <code>default</code> bundle only, so one app can't have its own.</li>
          <li><code>/oauth/logout</code> answers with plain text, and there is no signed-out page to customize.</li>
          <li>The Synthigy tools in the footer are the platform's own, and sign in with the default page.</li>
        </ol>
      </section>""")
