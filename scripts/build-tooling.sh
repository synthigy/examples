#!/usr/bin/env bash
# Build the web-component bundle from the private tree and drop it into
# examples/shared/vendor/tooling/, so the demos serve YOUR build instead of
# the published CDN one — the loop for testing a component change live before
# `@synthigy/tooling` is republished.
#
#   ./scripts/build-tooling.sh
#
# Every demo checks for that directory at render time: present → it injects
# `bundle`/`bundleCss` into window.SYNTHIGY_TOOLS and the rail loads the local
# files; absent → the rail falls back to the pinned CDN version. So this is
# self-reverting — `./scripts/build-tooling.sh --clean` (or deleting the
# directory) puts every demo back on the CDN with no code change.
#
# Uses `shadow-cljs release` (advanced optimizations, one self-contained file),
# the same build the publish path runs — testing the dev build instead would
# test something we never ship. Nothing here is committed: examples/.gitignore
# ignores shared/vendor/, matching the repo's "nothing generated is committed"
# convention.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="shared/vendor/tooling"
WC="../tooling/web-components"

if [ "${1:-}" = "--clean" ]; then
  rm -rf "$DEST"
  echo "removed $DEST — every demo is back on the CDN bundle"
  exit 0
fi

[ -d "$WC" ] || { echo "!! $WC not found (private tree only)" >&2; exit 1; }

echo ">> shadow-cljs release tooling"
(cd "$WC" && rm -rf target/tooling && npx shadow-cljs release tooling)

BUNDLE="$WC/target/tooling/tooling.js"
[ -f "$BUNDLE" ] || { echo "!! $BUNDLE missing — build failed?" >&2; exit 1; }

mkdir -p "$DEST"
cp "$BUNDLE" "$DEST/tooling.js"
# pub/tooling.css is a template; the version only appears in a comment there,
# so a local marker is honest and keeps the file identical in shape to the
# published one.
sed "s/{{VERSION}}/0.0.0-local/g" "$WC/pub/tooling.css" > "$DEST/tooling.css"

echo
echo "built from $(git -C "$WC" rev-parse --short HEAD 2>/dev/null || echo 'working tree')"
du -h "$DEST"/*
echo
echo "rls-demo (go) and chat (clj) check per request — reload the page."
echo "movies (js) and music (py) check at import — restart those two."
echo "Revert with: --clean"
