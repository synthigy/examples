// The examples landing page, without Docker: serves landing/index.html at "/"
// with the shared theme next to it, the way the demo image's proxy does.
//
//   node scripts/landing.mjs                 # http://localhost:5170
//
// The page links to each example's local port. Point them elsewhere (the
// sandbox, a tunnel) with MOVIES_URL, CHAT_URL, PM_URL and MUSIC_URL, and
// start each example with EXAMPLES_URL set to this page, so it links back.
import http from "node:http"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.LANDING_PORT ?? 5170)

// The local defaults written in index.html, and what may replace them.
const LINKS = {
  "http://localhost:5174/": process.env.MOVIES_URL,
  "http://localhost:5177/": process.env.CHAT_URL,
  "http://localhost:5176/": process.env.PM_URL,
  "http://localhost:5175/": process.env.MUSIC_URL,
}

const FILES = {
  "/": ["landing/index.html", "text/html; charset=utf-8"],
  "/index.html": ["landing/index.html", "text/html; charset=utf-8"],
  "/theme.css": ["shared/theme.css", "text/css; charset=utf-8"],
  "/chrome.js": ["shared/chrome.js", "text/javascript; charset=utf-8"],
  "/groove-harbor.svg": ["music/brand/logo.svg", "image/svg+xml"],
}

const page = (html) =>
  Object.entries(LINKS).reduce(
    (out, [local, url]) => (url ? out.replaceAll(`href="${local}"`, `href="${url}"`) : out), html)

http.createServer(async (req, res) => {
  const file = FILES[new URL(req.url ?? "/", "http://x").pathname]
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" })
    return res.end("not found\n")
  }
  const [path, type] = file
  let body = await readFile(resolve(ROOT, path))
  if (path.endsWith(".html")) body = page(body.toString("utf8"))
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" })
  res.end(body)
}).listen(PORT, () => console.log(`\n  examples landing page on http://localhost:${PORT}\n`))
