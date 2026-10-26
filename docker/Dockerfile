# The demo image: one Synthigy engine, every example running at once, a
# reverse proxy in front and the landing page at its root. See README.md here.
#
#   docker build -f docker/Dockerfile -t synthigy-examples .
#   docker run --rm -p 8080:80 synthigy-examples        # http://localhost:8080
#
# base  – the runtimes every stage needs, and the engine jar
# build – dependencies, then the engine is started once to seed the examples
#         and generate their typed ops; its database is kept as a snapshot
# final – base + what build produced; every container starts from the snapshot

ARG SYNTHIGY_VERSION=v0.3.1
ARG SYNTHIGY_SHA256=6de235b5f1a04b2b0abd3a4ab72b3d94c7cd15cdfdca633277792dfe13e857d3
ARG BABASHKA_VERSION=1.13.226

FROM node:22.18.0-bookworm-slim AS node
FROM caddy:2.10-alpine AS caddy
FROM golang:1.27-bookworm AS golang

# ── base ────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-noble AS base
ARG SYNTHIGY_VERSION
ARG SYNTHIGY_SHA256
ARG BABASHKA_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
RUN curl -fsSL "https://github.com/babashka/babashka/releases/download/v${BABASHKA_VERSION}/babashka-${BABASHKA_VERSION}-linux-amd64-static.tar.gz" \
    | tar -xz -C /usr/local/bin bb
# The engine: the public release jar, checked against the release's sha256.
RUN mkdir -p /opt/synthigy \
 && curl -fsSL -o /opt/synthigy/synthigy.jar \
    "https://github.com/synthigy/synthigy/releases/download/${SYNTHIGY_VERSION}/synthigy-sqlite-${SYNTHIGY_VERSION}.jar" \
 && echo "${SYNTHIGY_SHA256}  /opt/synthigy/synthigy.jar" | sha256sum -c -
ENV SYNTHIGY_HOME=/var/lib/synthigy \
    SYNTHIGY_BUNDLE=sqlite \
    SYNTHIGY_SERVER_PORT=7887 \
    PYTHONUTF8=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

# ── build ───────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=golang /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH
# Dependencies first, so a code change does not refetch them.
COPY movies/js/package.json movies/js/package-lock.json movies/js/
RUN cd movies/js && npm ci --no-audit --no-fund
COPY music/py/requirements.txt music/py/
RUN python3 -m venv music/py/.venv && music/py/.venv/bin/pip install --no-cache-dir -q -r music/py/requirements.txt
COPY project-management/go/go.mod project-management/go/go.sum project-management/go/
RUN cd project-management/go && go mod download
COPY chat/clj/bb.edn chat/clj/
RUN cd chat/clj && bb prepare
COPY . .
# Start the engine, seed every example, generate their ops, build the Go BFF,
# stop the engine: its database becomes the snapshot each container starts from.
RUN bash docker/seed.sh && mkdir -p /root/.m2 /root/.deps.clj /root/.gitlibs

# ── final ───────────────────────────────────────────────────────────────
FROM base AS final
# babashka's resolved dependencies (chat), so nothing is fetched at start
COPY --from=build /root/.m2 /root/.m2
COPY --from=build /root/.deps.clj /root/.deps.clj
COPY --from=build /root/.gitlibs /root/.gitlibs
COPY --from=build /app /app
ENV PUBLIC_HOST=localhost:8080 \
    PUBLIC_SCHEME=http \
    HOST_PATTERN="{app}.{host}"
EXPOSE 80
CMD ["bash", "/app/docker/start.sh"]
