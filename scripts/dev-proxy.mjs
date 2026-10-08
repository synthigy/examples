// One port in front of a demo BFF and the engine — the same split traefik
// makes in the sandbox, without Docker. Point one ngrok tunnel at this and a
// phone, a colleague or an incognito window reaches the whole demo.
//
//   node examples/scripts/dev-proxy.mjs            # :5180 -> 5174 + 7887
//   ngrok http 5180
//
// Then run the BFF with the public origin it cannot work out for itself:
//
//   BASE_URL=https://<id>.ngrok-free.app \
//   SYNTHIGY_PUBLIC_ENDPOINT=https://<id>.ngrok-free.app \
//   npm start
//
// and register that origin's callback on the instance ONCE (add-client
// stacks, so re-running it is safe):
//
//   synthigy iam add-client "Movies (JS)" --id movies-js --type confidential \
//     --secret movies-secret --grant authorization_code \
//     --grant client_credentials --grant refresh_token \
//     --redirect https://<id>.ngrok-free.app/auth/callback \
//     --role SUPERUSER --api Synthigy --trusted --local
import http from "node:http"

const PORT   = Number(process.env.PROXY_PORT   ?? 5180)
const APP    = Number(process.env.PROXY_APP    ?? 5174)
const ENGINE = Number(process.env.PROXY_ENGINE ?? 7887)
const HOST   = process.env.PROXY_HOST ?? "127.0.0.1"

// The engine's own surfaces. Everything else belongs to the demo BFF, whose
// routes (/movies, /dashboard, /stream/*, /demo/*, /auth/callback, /login,
// /public, /vendor, /xsql, /tour.js) do not collide with these.
//
// /console is NOT here on purpose: the operator console has no business on a
// tunnel anyone can reach.
const ENGINE_PREFIXES = ["/data", "/oauth", "/schema", "/.well-known"]

const engineOwns = (path) =>
  ENGINE_PREFIXES.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"))

const server = http.createServer((req, res) => {
  const port = engineOwns(req.url ?? "/") ? ENGINE : APP

  // The engine derives each instance's public origin from these
  // (synthigy.oauth.core/original-uri), and so does the BFF's redirect_uri.
  // ngrok sets them on the way in; pass them through, and fill them in when
  // something reaches the proxy directly.
  const headers = { ...req.headers, host: req.headers.host }
  headers["x-forwarded-host"] = req.headers["x-forwarded-host"] ?? req.headers.host
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "http"

  const upstream = http.request(
    { host: HOST, port, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end(`dev-proxy: ${port} is not answering (${err.code ?? err.message})\n`)
  })
  req.pipe(upstream)
})

// SSE is the whole point of these demos — never buffer, never time out.
server.keepAliveTimeout = 0
server.headersTimeout = 0
server.requestTimeout = 0

server.listen(PORT, () => {
  console.log(`\n  dev-proxy on http://localhost:${PORT}`)
  console.log(`    ${ENGINE_PREFIXES.join(", ")}  ->  :${ENGINE}  (engine)`)
  console.log(`    everything else                ->  :${APP}  (demo BFF)`)
  console.log(`\n  ngrok http ${PORT}\n`)
})
