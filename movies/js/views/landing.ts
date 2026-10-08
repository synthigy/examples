import { layout } from "./layout.ts"
import { esc } from "../lib/bff.ts"
import { icon } from "../lib/icons.ts"

// Layout/spacing = Tailwind utilities inline (preflight off, Play CDN).
// Colours stay Tyrell: the `.hero/.card/.note` classes in style.css carry
// only background/border/text tokens + hover effects.
export function landingPage({ user }: { user: any }) {
  return layout({
    title: "Home",
    user,
    content: /* html */ `
      <section class="hero ty-elevated mt-6 mb-12 px-10 py-9 rounded-lg border max-[560px]:px-5 max-[560px]:py-6">
        <div class="flex flex-wrap gap-2 mb-[18px]">
          <ty-tag flavor="primary" size="sm">
            ${icon("zap", { slot: "start", size: "sm" })}
            Live queries
          </ty-tag>
          <ty-tag flavor="success" size="sm">
            ${icon("radio", { slot: "start", size: "sm" })}
            One stream upstream
          </ty-tag>
          <ty-tag flavor="neutral" size="sm">
            ${icon("code", { slot: "start", size: "sm" })}
            Typed SDK, 5 languages
          </ty-tag>
        </div>
        <h1 class="m-0 mb-3 text-[1.7rem] font-bold tracking-[-0.02em]">Every query is a live query.</h1>
        <p class="hero-text m-0 mb-6 max-w-[60ch]">
          This app is two <code>.xsql</code> files deployed against a Synthigy model.
          Each query in them is watchable, and every page here is nothing but those
          watches painted to the screen.
        </p>
        <div class="flex gap-2.5 flex-wrap">
          <a href="/movies?tour=1" class="no-underline">
            <ty-button flavor="primary">
              ${icon("compass", { slot: "start", size: "sm" })}
              Take the tour
            </ty-button>
          </a>
          ${user
            ? `<p class="m-0 self-center"><strong>You're logged in</strong>&nbsp;as <code>${esc(user.xid)}</code>.</p>`
            : `<a href="/login" class="no-underline" data-tour="login">
                 <ty-button flavor="success">
                   ${icon("log-in", { slot: "start", size: "sm" })}
                   Log in
                 </ty-button>
               </a>`}
        </div>
      </section>

      <section class="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4 mb-12">
        ${cardLink("/movies", "list", "Live movies list",
          "Rate a film in one window, its average and count repaint in the other.",
          "Movie.watchList()")}
        ${cardLink("/movies", "film", "Live movie detail",
          "Edit a title in the console, watch it patch in any open detail tab. Ratings append live.",
          "Movie.watchDetail()")}
        ${cardLink("/actors", "users", "Live actors",
          "Browse the cast, click through to filmography. Edits propagate live.",
          "MovieActor.watchList()")}
        ${cardLink("/dashboard", "chart-column", "Live dashboard",
          "Four counters, one SQL template, one watch.",
          "Dashboard.watchStats()")}
      </section>

      <section class="note ty-content p-[22px] rounded-md border">
        <h3 class="m-0 mb-3 text-[0.95rem]">
          ${icon("info", { size: "sm" })}
          What's going on under the hood
        </h3>
        <ul class="note-list m-0 pl-5">
          <li class="my-1.5">Any query can carry <code>@watch</code> — a list, a detail, a hand-written SQL template — and repaint whatever it feeds when a write touches it.</li>
          <li class="my-1.5">One SSE from BFF → Synthigy <code>/data/events</code>, regardless of how many browser tabs are open.</li>
          <li class="my-1.5">One <code>@synthigy/sdk</code> client per BFF process; the same <code>.xsql</code> generates typed clients in JS, Python, Go, Clojure and PHP.</li>
          <li class="my-1.5">Each page opens one SSE from browser → BFF; BFF translates SDK watch events into Datastar element patches.</li>
          <li class="my-1.5">Login is OIDC authorization-code with PKCE. Tokens stay server-side.</li>
        </ul>
      </section>
    `,
  })
}

function cardLink(href: string, ico: string, title: string, body: string, tag: string) {
  return /* html */ `<a class="card ty-elevated block p-[22px] rounded-md border" href="${href}">
    <div class="card-icon mb-3">${icon(ico, { size: "lg" })}</div>
    <h2 class="block m-0 mb-2 text-[1.05rem]">${esc(title)}</h2>
    <p class="card-text m-0 mb-3 text-[0.92em]">${esc(body)}</p>
    <ty-tag size="sm" flavor="neutral">${esc(tag)}</ty-tag>
  </a>`
}
