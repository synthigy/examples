import { layout } from "./layout.ts";
import { esc } from "../lib/bff.ts";
import { icon as renderIcon } from "../lib/icons.ts";
import type { DemoState } from "../lib/demo-state.ts";

// ──────────────────────────────────────────────────────────────────────────
// Signal shape — mirrored by serve.ts's /stream/guide patches and the
// /demo/deploy|import|destroy POST handlers. Keep the two in sync.
//
//   guide: { step, completed, busy, error, deployed, partial, phase }
//   exp:   DemoCounts   — expected totals, computed once at boot
//   imp:   DemoCounts & { phase, done, total, elapsedMs }  — importer's OWN tally
//   live:  DemoCounts   — counted live by the demo/progress XSQL template
// ──────────────────────────────────────────────────────────────────────────

const STEP_META = [
  { id: "deploy", label: "Deploy", icon: "rocket" },
  { id: "import", label: "Import", icon: "cloud-upload" },
  { id: "explore", label: "Explore", icon: "play" },
  { id: "destroy", label: "Destroy", icon: "trash" },
] as const;

function stepFor(phase: DemoState["phase"]): string {
  if (phase === "ready") return "explore";
  if (phase === "absent" || phase === "deploying") return "deploy";
  return "import"; // deployed | importing | destroying(before probe catches up)
}

function completedFor(phase: DemoState["phase"]): string[] {
  if (phase === "ready") return ["deploy", "import", "explore"];
  if (phase === "absent" || phase === "deploying") return [];
  return ["deploy"];
}

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

export function guidePage({ user, state }: { user: any; state: DemoState }) {
  const step = stepFor(state.phase);
  const completed = completedFor(state.phase);
  const exp = state.expected;
  const live = state.counts ?? { genres: 0, actors: 0, movies: 0, ratings: 0, tags: 0 };
  const guideSignals = {
    step, completed, phase: state.phase,
    busy: state.phase === "deploying" ? "deploy" : state.phase === "importing" ? "import" : state.phase === "destroying" ? "destroy" : null,
    error: null as string | null,
    deployed: state.dataset ? { version: state.dataset.version, xid: state.dataset.xid } : null,
    partial: state.partial,
  };
  const impSignals = { ...live, phase: null as string | null, done: 0, total: 0, elapsedMs: 0 };

  return layout({
    title: "Start here",
    user,
    stream: "/stream/guide",
    content: /* html */ `
      <div data-signals="${esc(JSON.stringify({
        guide: guideSignals, exp, imp: impSignals, live,
      }))}"></div>

      <section class="guide-hero ty-elevated mt-6 mb-8 px-10 py-9 rounded-lg border max-[560px]:px-5 max-[560px]:py-6" data-tour="guide-hero">
        <div class="flex flex-wrap gap-2 mb-[18px]">
          <ty-tag flavor="primary" size="sm">${renderIcon("zap", { slot: "start", size: "sm" })} Live import</ty-tag>
          <ty-tag flavor="neutral" size="sm">${renderIcon("database", { slot: "start", size: "sm" })} Movies Example 0.4</ty-tag>
        </div>
        <h1 class="m-0 mb-3 text-[1.7rem] font-bold tracking-[-0.02em]">
          Deploy a model. Import a hundred thousand ratings. Watch it go live.
        </h1>
        <p class="hero-text m-0 mb-6 max-w-[62ch]">
          Nothing exists yet — this instance has no Movies model deployed. The three
          steps below deploy it, import the real MovieLens dataset with progress
          counted live by an XSQL template, then hand you a live app to click
          around and a button to tear it all down again.
        </p>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-5 max-[560px]:grid-cols-3 max-[560px]:gap-3">
          ${heroFigure(fmt(exp.ratings), "user ratings", "star")}
          ${heroFigure(fmt(exp.movies), "movies", "film")}
          ${heroFigure(fmt(exp.actors), "actors", "users")}
          ${heroFigure(fmt(exp.genres), "genres", "tag", true)}
          ${heroFigure(fmt(exp.tags), "tags", "hash", true)}
        </div>
      </section>

      <script>
        // One-shot count-up on first paint — purely decorative, so it is
        // skipped entirely under prefers-reduced-motion rather than jumped
        // to the end (a static number is the reduced-motion equivalent).
        (function () {
          if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
          document.querySelectorAll(".guide-figure-value[data-count-to]").forEach(function (el) {
            var target = parseInt(String(el.getAttribute("data-count-to")).replace(/[^0-9]/g, ""), 10);
            if (!Number.isFinite(target) || target <= 0) return;
            var start = performance.now(), duration = 900;
            function tick(now) {
              var p = Math.min(1, (now - start) / duration);
              var eased = 1 - Math.pow(1 - p, 3);
              el.textContent = Math.round(eased * target).toLocaleString("en-US");
              if (p < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          });
        })();
      </script>

      <ty-wizard id="guide-wizard" width="100%" height="620px"
                 data-attr:active="$guide.step"
                 data-attr:completed="$guide.completed.join(',')"
                 data-on:ty-wizard-step-change="
                   var id = evt.detail.activeId;
                   if ($guide.completed.includes(id) || id === $guide.step || $guide.phase === 'ready') { $guide.step = id }
                 ">
        ${STEP_META.map((s) => `<div slot="indicator-${s.id}">${renderIcon(s.icon, { size: "sm" })}</div>`).join("")}

        <ty-step id="deploy" label="Deploy the model">
          <div class="guide-panel p-7 max-[560px]:p-5">
            <h2 class="m-0 mb-2 text-[1.15rem]">1. Deploy the data model</h2>
            <p class="hint mb-3 max-w-[62ch]">
              A data model here is the ERD itself — entities, their attributes and the
              relations between them — kept as one versioned document instead of a pile
              of migration scripts. This one is <strong>Movies Example 0.4</strong>: five
              entities (Movie, Movie Actor, Movie Genre, User Rating, User Tag) and four
              relations, 8&nbsp;kB of it.
            </p>
            <p class="hint mb-4 max-w-[62ch]">
              Deploying sends that document to the engine untouched. The engine reconciles
              the database schema to match it — tables, columns, constraints, the DDL is
              its job, not yours — exposes every entity over the <code>/data</code> endpoint
              as CRUD plus live subscriptions, and registers it with IAM so access can be
              granted per entity and per attribute. No API code is written or generated
              anywhere. Nothing is imported yet; that is step 2.
            </p>
            <div class="flex gap-2.5 flex-wrap mb-5">
              <a href="/demo/model.json" target="_blank" rel="noopener" style="text-decoration:none">
                <ty-button flavor="success" size="sm">
                  ${renderIcon("file-json", { slot: "start", size: "sm" })}
                  Look at the document
                </ty-button>
              </a>
            </div>
            <ty-button size="lg" flavor="primary" data-tour="deploy-btn"
                       data-indicator="_deploying" data-attr:loading="$_deploying"
                       data-attr:disabled="!!$guide.busy"
                       data-on:click="@post('/demo/deploy')">
              ${renderIcon("rocket", { slot: "start" })}
              Deploy the data model
            </ty-button>

            <div data-show="$guide.deployed" class="guide-callout mt-6 p-5 rounded-lg border" data-tour="deployed-callout">
              <p class="m-0 mb-3">
                <strong>Movies Example <span data-text="$guide.deployed?.version"></span></strong>
                is deployed
                <span class="detail-id-value px-1.5 py-0.5 rounded" data-text="$guide.deployed?.xid"></span>.
              </p>
              <div class="flex gap-2.5 flex-wrap">
                <ty-button flavor="success" size="sm" data-tour="rail:model"
                           onclick="if (window.MoviesGuide) MoviesGuide.showModel(); else if (window.SYNTHIGY_TOOLS) SYNTHIGY_TOOLS.open('model')">
                  ${renderIcon("external-link", { slot: "start", size: "sm" })}
                  Open it in the modeler
                </ty-button>
                <ty-button flavor="primary" size="sm" data-on:click="$guide.step = 'import'">
                  Continue to import
                  ${renderIcon("arrow-right", { slot: "end", size: "sm" })}
                </ty-button>
              </div>
            </div>
            ${errorBanner()}
          </div>
        </ty-step>

        <ty-step id="import" label="Import the data">
          <div class="guide-panel p-7 max-[560px]:p-5">
            <h2 class="m-0 mb-2 text-[1.15rem]">2. Import the data</h2>
            <p class="hint mb-4 max-w-[62ch]">
              Seven phases, ~238 write calls, dominated by 100,836 ratings. Every row
              carries an explicit xid, so this is safe to run again.
            </p>

            <div data-show="$guide.partial" class="guide-note mb-4 p-3.5 rounded-md border">
              ${renderIcon("info", { size: "sm" })}
              The server already holds some rows. Sync upserts by xid, so running the
              import again completes it without duplicating anything.
            </div>

            <ty-button size="lg" flavor="primary" data-tour="import-btn"
                       data-indicator="_importing" data-attr:loading="$_importing"
                       data-attr:disabled="!!$guide.busy"
                       data-on:click="@post('/demo/import')">
              ${renderIcon("cloud-upload", { slot: "start" })}
              <span data-text="$guide.partial ? 'Resume import' : 'Import the data'"></span>
            </ty-button>

            <div id="import-progress" class="mt-6 flex flex-col gap-3.5" data-tour="import-progress">
              ${progressBar("movies", "Movies", "film", true)}
              ${progressBar("actors", "Actors", "users", true)}
              ${progressBar("ratings", "User ratings", "star", true)}
              ${progressBar("genres", "Genres", "tag", false)}
              ${progressBar("tags", "Tags", "hash", false)}
            </div>

            <div class="guide-status mt-4 flex items-center gap-3 flex-wrap">
              <span class="guide-status-phase" data-text="$imp.phase ? ('writing ' + $imp.phase + '… ' + $imp.done.toLocaleString() + ' / ' + $imp.total.toLocaleString()) : ($guide.busy === 'import' ? 'starting…' : '')"></span>
              <span class="guide-status-elapsed" data-show="$imp.elapsedMs > 0" data-text="(($imp.elapsedMs/1000).toFixed(1) + 's')"></span>
            </div>

            <div class="guide-legend mt-5 flex items-center gap-2.5 flex-wrap">
              <ty-tag size="sm" flavor="neutral">${renderIcon("terminal", { slot: "start", size: "xs" })} XSQL: demo/progress</ty-tag>
              <ty-button flavor="success" size="sm" data-tour="rail:console"
                         onclick="if (window.SYNTHIGY_TOOLS) SYNTHIGY_TOOLS.open('console')">
                ${renderIcon("terminal", { slot: "start", size: "sm" })}
                Run this template in the console
              </ty-button>
            </div>
            ${errorBanner()}
          </div>
        </ty-step>

        <ty-step id="explore" label="See it live">
          <div class="guide-panel p-7 max-[560px]:p-5 flex flex-col items-start">
            <h2 class="m-0 mb-2 text-[1.15rem]">${renderIcon("party-popper", { size: "sm" })} It's live</h2>
            <p class="hint mb-6 max-w-[58ch]">
              <span data-text="$live.ratings.toLocaleString()"></span> ratings,
              <span data-text="$live.movies.toLocaleString()"></span> movies and
              <span data-text="$live.actors.toLocaleString()"></span> actors are in the
              database right now. Every page you're about to open reads and watches
              them live.
            </p>
            <div class="flex gap-2.5 flex-wrap">
              <a href="/movies" style="text-decoration:none">
                <ty-button flavor="primary" size="lg">
                  ${renderIcon("list", { slot: "start" })}
                  Explore the movies
                </ty-button>
              </a>
              <a href="/movies?tour=1" style="text-decoration:none">
                <ty-button flavor="success" size="lg">
                  ${renderIcon("compass", { slot: "start" })}
                  Start the real-time tour
                </ty-button>
              </a>
            </div>
            <p class="hint mt-5 max-w-[58ch]">
              The tour opens two companion windows — the movies list and the
              dashboard — and asks for a third: an incognito window with no
              session at all. Rate a film and watch the same write reach all
              four surfaces at once.
            </p>
          </div>
        </ty-step>

        <ty-step id="destroy" label="Tear it down">
          <div class="guide-panel p-7 max-[560px]:p-5">
            <h2 class="m-0 mb-2 text-[1.15rem]">4. Destroy the dataset</h2>
            <p class="hint mb-5 max-w-[58ch]">
              Deletes every version, table and row this demo owns. The guide starts
              over at step 1 — nothing else on the instance is touched.
            </p>
            <ty-button size="lg" flavor="danger" data-tour="destroy"
                       data-attr:disabled="!!$guide.busy"
                       data-on:click="$confirmDestroy = true">
              ${renderIcon("trash", { slot: "start" })}
              Destroy the dataset
            </ty-button>
            ${errorBanner()}
          </div>
        </ty-step>
      </ty-wizard>
    `,
  });
}

function heroFigure(value: string, label: string, ico: string, small = false) {
  return /* html */ `<div class="guide-figure ${small ? "guide-figure--sm" : ""}">
    <div class="guide-figure-value tabular-nums" data-count-to="${esc(value)}">${esc(value)}</div>
    <div class="guide-figure-label">${renderIcon(ico, { size: "xs" })} ${esc(label)}</div>
  </div>`;
}

function progressBar(key: string, label: string, ico: string, big: boolean) {
  return /* html */ `<div class="guide-bar ${big ? "guide-bar--big" : "guide-bar--sm"}">
    <div class="guide-bar-head">
      <span class="guide-bar-label">${renderIcon(ico, { size: "xs" })} ${esc(label)}</span>
      <span class="guide-bar-readout tabular-nums"
            data-text="$live.${key}.toLocaleString() + ' / ' + $exp.${key}.toLocaleString()"></span>
    </div>
    <div class="guide-bar-track">
      <div class="guide-bar-written" data-attr:style="'left:' + Math.min(100, $imp.${key} / ($exp.${key} || 1) * 100) + '%'"></div>
      <div class="guide-bar-fill ${big ? "" : "guide-bar-fill--sm"}"
           data-class="{'guide-bar-shimmer': $guide.busy === 'import'}"
           data-attr:style="'width:' + Math.min(100, $live.${key} / ($exp.${key} || 1) * 100) + '%'"></div>
    </div>
  </div>`;
}

function errorBanner() {
  return /* html */ `<div data-show="$guide.error" class="guide-error mt-5 p-3.5 rounded-md border">
    ${renderIcon("triangle-alert", { size: "sm" })}
    <span data-text="$guide.error"></span>
  </div>`;
}

export function confirmDestroyModal() {
  return /* html */ `
<ty-modal id="confirm-destroy-dialog" data-signals="{confirmDestroy: false}"
          data-attr:open="$confirmDestroy"
          data-on:close="$confirmDestroy = false" data-on:cancel="$confirmDestroy = false">
  <div class="ty-floating flex flex-col w-[min(440px,calc(100vw-32px))] rounded-[14px] border p-6">
    <h2 class="m-0 mb-3 text-[1.05rem]">${renderIcon("triangle-alert", { size: "sm" })} Destroy the dataset?</h2>
    <p class="hint m-0 mb-5">
      This deletes every version, table and row of the Movies model. The guide
      starts over at "Deploy the data model".
    </p>
    <div class="flex justify-end gap-2.5">
      <ty-button flavor="neutral" size="sm" data-on:click="$confirmDestroy = false">Cancel</ty-button>
      <ty-button flavor="danger" size="sm" data-indicator="_destroying" data-attr:loading="$_destroying"
                 data-on:click="$confirmDestroy = false; @post('/demo/destroy')">
        ${renderIcon("trash", { slot: "start", size: "sm" })}
        Destroy
      </ty-button>
    </div>
  </div>
</ty-modal>`;
}
