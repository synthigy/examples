// Browser check for the guided tour's rate step, against a RUNNING dev server.
//
//   npm run test:browser              # assert the step behaves
//   PROBE=1 npm run test:browser      # dump raw measurements instead
//
// The tour resumes from sessionStorage (examples/shared/tour.js), so this
// seeds the stack straight onto the `rate` step rather than walking the popup
// steps a headless browser cannot grant.
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"

const BASE = process.env.MOVIES_URL || "http://localhost:5174"
const USER = process.env.MOVIES_USER || "admin"
const PASS = process.env.MOVIES_PASS || "admin"
const PROBE = process.env.PROBE === "1" || process.argv.includes("--probe")

// An ngrok free tunnel shows every new browser an interstitial first. The
// header that skips it cannot be used here: Playwright would put it on
// cross-origin requests too, and jsdelivr and Google Fonts reject it as a
// preflight, so Datastar never loads. A visitor clicks through once; so do we.
async function passInterstitial(page) {
  const btn = page.locator('button:has-text("Visit Site")')
  await btn.waitFor({ timeout: 4000 }).catch(() => {})
  if (await btn.count().catch(() => 0) > 0) {
    await btn.first().click()
    await page.waitForLoadState("domcontentloaded")
  }
}

// "Already signed in?" is decided by the login FORM, not by the origin: behind
// a proxy that fronts the engine and this BFF on one hostname (a sandbox, or
// an ngrok tunnel), the engine's own login page is same-origin, so an
// origin check always says "signed in" and never logs anyone in.
async function login(page) {
  await page.goto(`${BASE}/login?returnTo=/movies`, { waitUntil: "domcontentloaded" })
  await passInterstitial(page)
  const form = page.locator("#username")
  await form.waitFor({ timeout: 8000 }).catch(() => {})
  if (await form.count().catch(() => 0) === 0) return   // session still good
  await page.fill("#username", USER)
  await page.fill("#password", PASS)
  await page.click("form button")
  await page.waitForURL((u) => !u.toString().includes("/oauth/"), { timeout: 25000 })
  await passInterstitial(page)
}

async function firstMovieHref(page) {
  await page.goto(`${BASE}/movies`, { waitUntil: "domcontentloaded" })
  await passInterstitial(page)
  return page.getAttribute('[data-tour="movie-link"]', "href")
}

// Land on the rate step with the tour armed, and install the probe counters
// the assertions read back.
async function openRateStep(page, href) {
  await page.goto(BASE + href, { waitUntil: "domcontentloaded" })
  await page.evaluate(() => {
    sessionStorage.setItem("syn-tour", JSON.stringify({ stack: [{ tour: "movies", step: "rate" }] }))
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector(".driver-popover", { timeout: 15000 })
  await page.waitForFunction(() => document.querySelector(".driver-active-element") !== null)
  await page.evaluate(() => {
    const card = document.querySelector('[id^="movie-"].movie-detail') || document.querySelector('[id^="movie-"]')
    const form = document.querySelector('[data-tour="rate"]')
    window.__probe = { cardTag: {}, formTag: {}, armFires: 0, clickBlockedBy: null }
    card.__tag = window.__probe.cardTag
    form.__tag = window.__probe.formTag
    // Mirror the step's own watcher, to see whether mutations reach the card.
    new MutationObserver(() => { window.__probe.armFires++ })
      .observe(card, { childList: true, characterData: true, subtree: true })
  })
}

function ratingsCount(page) {
  return page.evaluate(() => {
    const m = document.body.innerText.match(/([\d,]+)\s+ratings/)
    return m ? Number(m[1].replace(/,/g, "")) : null
  })
}

// One rating: click Submit, wait for the card's own count to move, then read
// everything the step depends on.
async function rateAndMeasure(page, n) {
  const before = await ratingsCount(page)
  await page.evaluate(() => {
    window.__probe = window.__probe || { cardTag: {}, formTag: {}, armFires: 0 }
    window.__probe.clickBlockedBy = null
  })

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-tour="rate"] ty-button[type="submit"]')
    if (!btn) return "no-button"
    const r = btn.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    // elementFromPoint stops at the shadow host, which is the button itself.
    if (hit !== btn && !btn.contains(hit)) {
      window.__probe.clickBlockedBy = hit ? hit.className || hit.tagName : "nothing"
      return "blocked"
    }
    return "ok"
  })

  if (clicked === "ok") await page.click('[data-tour="rate"] ty-button[type="submit"]', { timeout: 3000 }).catch(() => {})

  let after = before
  if (clicked === "ok") {
    await page.waitForFunction(
      (b) => {
        const m = document.body.innerText.match(/([\d,]+)\s+ratings/)
        return m && Number(m[1].replace(/,/g, "")) !== b
      },
      before,
      { timeout: 8000 },
    ).catch(() => {})
    after = await ratingsCount(page)
  }

  await page.waitForTimeout(250)   // let a rAF-deferred refresh land

  const m = await page.evaluate(() => {
    const card = document.querySelector('[id^="movie-"].movie-detail') || document.querySelector('[id^="movie-"]')
    const form = document.querySelector('[data-tour="rate"]')
    const btn = form && form.querySelector('ty-button[type="submit"]')
    const next = document.querySelector(".driver-popover-next-btn")
    const pe = btn ? getComputedStyle(btn).pointerEvents : null
    let hitsButton = false
    if (btn) {
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      hitsButton = hit === btn || btn.contains(hit)
    }
    return {
      observerFires: (window.__probe && window.__probe.armFires) || 0,
      cardSameNode: card && window.__probe ? card.__tag === window.__probe.cardTag : null,
      formSameNode: form && window.__probe ? form.__tag === window.__probe.formTag : null,
      formHasActiveClass: form ? form.classList.contains("driver-active-element") : null,
      submitPointerEvents: pe,
      submitHitTestPasses: hitsButton,
      nextExists: !!next,
      nextDisplay: next ? getComputedStyle(next).display : null,
      popoverOpen: !!document.querySelector(".driver-popover"),
      clickBlockedBy: window.__probe && window.__probe.clickBlockedBy,
    }
  })

  return { n, clicked, before, after, wrote: after !== before, ...m }
}

test("rate step: Next appears and Submit stays clickable across repeated ratings", async () => {
  // The system Chrome, not a downloaded build: `npx playwright install` is a
  // 170MB side-effect no example should need.
  const browser = await chromium.launch({ channel: "chrome" })
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => {
    // Resource 404s are the browser's own noise (favicon and friends), not a
    // failure of the page's code.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  try {
    await login(page)
    const href = await firstMovieHref(page)
    assert.ok(href, "no movie link on /movies")
    await openRateStep(page, href)

    const rounds = []
    for (let i = 1; i <= 3; i++) rounds.push(await rateAndMeasure(page, i))

    if (PROBE) {
      console.log(JSON.stringify({ rounds, errors }, null, 2))
      return
    }

    for (const r of rounds) {
      assert.equal(r.clicked, "ok", `round ${r.n}: Submit was not hittable (covered by ${r.clickBlockedBy})`)
      assert.ok(r.wrote, `round ${r.n}: ratings count did not move (${r.before} → ${r.after})`)
      assert.equal(r.submitPointerEvents, "auto", `round ${r.n}: Submit has pointer-events: ${r.submitPointerEvents}`)
      assert.ok(r.submitHitTestPasses, `round ${r.n}: Submit is covered by ${r.clickBlockedBy}`)
      assert.ok(r.formHasActiveClass, `round ${r.n}: form lost driver-active-element`)
      assert.notEqual(r.nextDisplay, "none", `round ${r.n}: Next is still hidden`)
      assert.ok(r.popoverOpen, `round ${r.n}: the popover closed`)
    }
    assert.deepEqual(errors, [], "page errors")
  } finally {
    await browser.close()
  }
})
