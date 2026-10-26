# Demo image

One image that boots one Synthigy engine, every example at once, the
examples landing page and a reverse proxy in front of all of it. It is the
blueprint for the hosted sandbox slots.

```bash
docker build -f docker/Dockerfile -t synthigy-examples .
docker run --rm -p 8080:80 synthigy-examples
```

Then open <http://localhost:8080>. Every `*.localhost` name resolves to your
own machine in Chrome, Edge and Firefox, so nothing needs to go in
`/etc/hosts`.

| Host | What |
|---|---|
| `localhost:8080` | the landing page |
| `movies.localhost:8080` | Movies (JavaScript) — starts empty; its guide deploys and imports |
| `chat.localhost:8080` | Chat (Clojure) |
| `projects.localhost:8080` | Project Management (Go) |
| `music.localhost:8080` | Music (Python) — sign in as `admin` / `admin` |
| `console.localhost:8080` | the engine's console — `admin` / `admin` |
| `engine.localhost:8080` | the engine itself: sign-in, `/data`, `/oauth`, the tools' API |

## What is in it

| | |
|---|---|
| Engine | the public `synthigy-sqlite` release jar (`SYNTHIGY_VERSION`, sha256-checked), on Temurin 21 |
| Movies | the JavaScript port: the most complete one, with the guided deploy and import |
| Chat, Project Management, Music | their only ports: Clojure (babashka), Go (compiled), Python |
| Proxy | Caddy, routing by host name; SSE is never buffered |
| Landing page | `landing/`, served as static files |

The `synthigy` CLI is not in the image: its Linux build is not published.
`docker/lib.sh` starts the engine from its jar (every module, through its
lifecycle), and creates the demo account and clients with the engine's own
`synthigy.ops`. Every script here passes its client credentials explicitly:
nothing relies on `synthigy exec` supplying a token.

## Fresh on every start

`docker/seed.sh` runs **at build time**: it starts the engine once, adds
`admin`/`admin` and every example's client, seeds the examples (one cast,
Alice, Bob, Charlie and Diana, shared by Chat and Project Management),
generates each one's typed ops, builds the Go BFF, and keeps the engine's
database as `docker/snapshot`.

`docker/start.sh` runs **on every container start**: it copies that snapshot
into place, starts the engine and the four BFFs, points the OAuth clients at
the public host names (`docker/urls.py`), writes the landing page with links
to them and starts Caddy. Nothing persists between containers, and a start
takes seconds, not a re-seed.

If any process exits, the container exits with it: a sandbox slot is replaced,
not left half-working.

## Configuration

| Variable | Default | |
|---|---|---|
| `PUBLIC_HOST` | `localhost:8080` | the host visitors use, with its port if any |
| `PUBLIC_SCHEME` | `http` | `https` behind a proxy that terminates TLS |
| `HOST_PATTERN` | `{app}.{host}` | each app's host; `{app}` is movies, chat, projects, music, engine or console |
| `SYNTHIGY_JAVA_OPTS` | `-Xmx768m` | the engine's JVM flags |

On the sandbox, with one wildcard certificate for `*.sandbox.synthigy.com`
and a visitor slot `ab12`:

```bash
docker run -e PUBLIC_HOST=ab12.sandbox.synthigy.com -e PUBLIC_SCHEME=https \
           -e HOST_PATTERN='{app}-{host}' …
```

gives `ab12.sandbox.synthigy.com` for the landing page and
`movies-ab12.sandbox.synthigy.com` and so on for the rest, every one of them
one label deep, so the one certificate covers them all. The proxy in front
only has to send every one of those names to the slot's port 80, with the
`Host` header intact.

The engine's session cookie is `Secure`, so outside `*.localhost` serve it
over **https**: on plain http to any other host (a LAN address, say) the
browser drops the cookie and signing in to the console or an app goes round
in circles.

## Inside a running container

| | |
|---|---|
| Logs | `/var/log/examples/<engine, movies, music, projects, chat>.log`, and all of them on stdout with a `[name]` prefix |
| Engine data | `/var/lib/synthigy/db` (the copied snapshot) |
| Ports | engine 7887, movies 5174, music 5175, projects 5176, chat 5177; only Caddy's 80 is exposed |

The engine's encryption key is made at build time and kept in the image
(`docker/engine.key`), because the snapshot's encrypted values only open with
it. That is fine for throwaway demo slots and nothing else: do not run real
data on this image.
