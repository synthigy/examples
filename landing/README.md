# Examples landing page

One page where a visitor picks which example to open: Movies, Chat, Project
Management or Music. Each card says which part of the platform that example
highlights; every example links back here.

`index.html` is the whole page, static. In the demo image the proxy serves it
at `/`, with `/theme.css` and `/chrome.js` from [`../shared/`](../shared/) and
`/groove-harbor.svg` from [`../music/brand/logo.svg`](../music/brand/logo.svg).

## Run it locally

```bash
node scripts/landing.mjs            # http://localhost:5170
```

Then start the examples with `EXAMPLES_URL=http://localhost:5170` so each
header links back here.

| Example | Default link | Override |
|---|---|---|
| Movies (JavaScript) | `http://localhost:5174/` | `MOVIES_URL` |
| Chat (Clojure) | `http://localhost:5177/` | `CHAT_URL` |
| Project Management (Go) | `http://localhost:5176/` | `PM_URL` |
| Music (Python) | `http://localhost:5175/` | `MUSIC_URL` |

`landing.mjs` rewrites those default links from the overrides; a proxy that
serves `index.html` can do the same, or serve it as it is.
