#!/usr/bin/env bash
# Resolve every example's dependencies against the PUBLISHED SDKs.
#
# This is the regression guard for the thing the whole repo rests on: an
# example must be buildable by someone who only has the registries, never this
# monorepo. It deliberately does NOT run codegen or start anything — both need
# a live Synthigy — so it stays fast and runnable anywhere.
#
# A toolchain that is not installed is SKIPPED, not failed. A pinned version
# that is not published yet is a real failure: the example is not consumable.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
pass=0 fail=0 skip=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %-22s %s\n' "$1" "$2"; fail=$((fail+1)); }
miss() { printf '  skip  %-22s (%s not installed)\n' "$1" "$2"; skip=$((skip+1)); }

have() { command -v "$1" >/dev/null 2>&1; }

check_js() {
  local dir="$1" name="$2"
  have npm || { miss "$name" npm; return; }
  local out
  out=$(cd "$ROOT/$dir" && npm install --dry-run --no-audit --no-fund 2>&1)
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | tail -1)"
}

check_go() {
  local dir="$1" name="$2"
  have go || { miss "$name" go; return; }
  local out
  out=$(cd "$ROOT/$dir" && GOWORK=off GOFLAGS=-mod=mod go mod download 2>&1)
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | tail -1)"
}

check_py() {
  local dir="$1" name="$2"
  have python3 || { miss "$name" python3; return; }
  local out
  out=$(cd "$ROOT/$dir" && python3 -m pip install --dry-run --quiet -r requirements.txt 2>&1)
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | tail -1)"
}

check_php() {
  local dir="$1" name="$2"
  local runner=""
  if have composer; then runner="composer"
  elif have docker; then runner="docker"
  else miss "$name" composer; return; fi
  local out
  if [ "$runner" = composer ]; then
    out=$(cd "$ROOT/$dir" && composer update --dry-run --no-interaction 2>&1)
  else
    # --user: a container writes to the bind mount as ROOT otherwise, and a
    # root-owned vendor/ in the worktree needs sudo to clear (it has already
    # cost one export). COMPOSER_HOME because a non-root user has no writable
    # /root to cache into.
    out=$(docker run --rm -v "$ROOT/$dir":/app -w /app \
            --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer composer:2 \
            update --dry-run --no-interaction 2>&1)
  fi
  [ $? -eq 0 ] && ok "$name" || bad "$name" "$(echo "$out" | tail -1)"
}

check_clj() {
  local dir="$1" name="$2"
  have clojure || { miss "$name" clojure; return; }
  local deps out repo
  deps=$(cd "$ROOT/$dir" && sed -n 's/.*com\.synthigy\/sdk {:mvn\/version "\([^"]*\)".*/\1/p' bb.edn | head -1)
  # Resolve into a THROWAWAY local repo. Against the developer's own ~/.m2 a
  # locally `install`-ed jar resolves happily and reports a green that a fresh
  # machine would not reproduce — exactly the false pass this guard exists to
  # catch.
  repo=$(mktemp -d)
  out=$(clojure -Sdeps "{:mvn/local-repo \"$repo\" :deps {com.synthigy/sdk {:mvn/version \"$deps\"}}}" -Spath 2>&1)
  local rc=$?
  rm -rf "$repo"
  [ $rc -eq 0 ] && ok "$name (sdk $deps)" || bad "$name" "com.synthigy/sdk $deps is not on Clojars"
}

echo "Resolving every example against the published SDKs"
echo
check_js  movies/js      "movies/js"
check_go  movies/go      "movies/go"
check_php movies/php     "movies/php"
check_py  music/py       "music/py"
check_clj chat/clj       "chat/clj"
check_go  rls-demo/go    "rls-demo/go"
echo
printf '%d ok, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
