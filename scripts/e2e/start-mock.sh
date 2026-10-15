#!/usr/bin/env bash
# start-mock.sh — boot the fauxcord mock Discord for the Tier-4 E2E suite.
#
# Clones fauxcord (pinned commit), applies the vendored fidelity/simulation
# patch (scripts/e2e/fauxcord-e2e.patch — upstream PRs pending), installs,
# and starts the server in the background. Idempotent: exits 0 immediately
# when a healthy mock already answers (set FRESH=1 to force a restart).
#
# Env overrides: FAUXCORD_DIR (clone location), PORT, HOST, FAUXCORD_DATA_DIR,
# FAUXCORD_URL (health-check + suite target; defaults to http://127.0.0.1:PORT),
# PNPM_VERSION (mock installer; default = upstream packageManager pin).
set -euo pipefail

# Keep in sync with the base of scripts/e2e/fauxcord-e2e.patch. Bump only
# after re-deriving the patch against the new base (git diff > patch).
FAUXCORD_PIN="${FAUXCORD_PIN:-fe7a9f5c2b61ab100c1b933220c7d1d92921dcb9}"
FAUXCORD_REPO="${FAUXCORD_REPO:-https://github.com/tomacheese/fauxcord}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/fauxcord-e2e.patch"

PORT="${PORT:-3100}"
HOST="${HOST:-127.0.0.1}"
FAUXCORD_DIR="${FAUXCORD_DIR:-/tmp/opencode/fauxcord-e2e}"
FAUXCORD_DATA_DIR="${FAUXCORD_DATA_DIR:-/tmp/opencode/fauxcord-data-e2e}"
BASE_URL="${BASE_URL:-http://${HOST}:${PORT}}"
PID_FILE="${PID_FILE:-$FAUXCORD_DATA_DIR/fauxcord.pid}"
LOG_FILE="${LOG_FILE:-$FAUXCORD_DATA_DIR/fauxcord.log}"
export FAUXCORD_URL="${FAUXCORD_URL:-$BASE_URL}"

healthy() {
  curl -sf --max-time 2 "$FAUXCORD_URL/_mock/health" >/dev/null 2>&1
}

if healthy && [ "${FRESH:-0}" != "1" ]; then
  echo "[start-mock] healthy mock already answering at $FAUXCORD_URL — reusing it (FRESH=1 to restart)"
  exit 0
fi

"$SCRIPT_DIR/stop-mock.sh" >/dev/null 2>&1 || true

mkdir -p "$FAUXCORD_DATA_DIR"

# --- clone / sync to pinned commit ------------------------------------------
if [ ! -d "$FAUXCORD_DIR/.git" ]; then
  echo "[start-mock] cloning $FAUXCORD_REPO -> $FAUXCORD_DIR"
  git clone --quiet "$FAUXCORD_REPO" "$FAUXCORD_DIR"
fi
cd "$FAUXCORD_DIR"
# Discard any previous patch application so the tree is pristine.
if [ -n "$(git status --porcelain -- src)" ]; then
  git checkout -q -- .
fi
# Drop a previously vendored (untracked) lockfile so a pin bump never runs
# against the previous pin's resolution.
git clean -qf -- package-lock.json 2>/dev/null || true
if [ "$(git rev-parse HEAD)" != "$FAUXCORD_PIN" ]; then
  echo "[start-mock] fetching pinned commit ${FAUXCORD_PIN:0:8}"
  git fetch --quiet origin "$FAUXCORD_PIN"
  git checkout --quiet --detach FETCH_HEAD
fi

# --- apply the vendored patch series ----------------------------------------
echo "[start-mock] applying $(basename "$PATCH_FILE")"
git apply --check "$PATCH_FILE"
git apply "$PATCH_FILE"

# --- install + start ---------------------------------------------------------
# fauxcord is pnpm-based upstream (pnpm-lock.yaml + packageManager pin in the
# pinned tree), so provision the mock with pnpm against that lockfile.
# `npm install` re-resolved the whole dev tree from the registry on every run
# and crashes npm 10.9.9's arborist (npm/cli#7672, "edgesOut" TypeError on
# nested peer sets — hit hard on the self-hosted runner); it was also never
# lockfile-deterministic. better-sqlite3 v13 ships prebuilds resolved at
# require time, so pnpm's build-script gating is not a concern here.
PNPM_VERSION="${PNPM_VERSION:-12.11.2}"
if [ ! -d node_modules ]; then
  echo "[start-mock] pnpm install (first run, pnpm@$PNPM_VERSION)"
  npx --yes "pnpm@$PNPM_VERSION" install --frozen-lockfile --reporter=append-only
fi

rm -f "$PID_FILE"
# setsid makes the mock its own process-group leader so stop-mock.sh can
# kill the whole npm→sh→tsx chain with one signal (Linux: util-linux).
setsid env PORT="$PORT" HOST="$HOST" BASE_URL="$BASE_URL" \
  DB_PATH="$FAUXCORD_DATA_DIR/mock.db" \
  npm start >"$LOG_FILE" 2>&1 < /dev/null &
echo $! >"$PID_FILE"

# --- wait for health ---------------------------------------------------------
for _ in $(seq 1 60); do
  if healthy; then
    echo "[start-mock] mock healthy at $FAUXCORD_URL (pid $(cat "$PID_FILE"), log $LOG_FILE)"
    exit 0
  fi
  sleep 0.5
done

echo "[start-mock] FAIL: mock never became healthy at $FAUXCORD_URL — last log lines:" >&2
tail -n 25 "$LOG_FILE" >&2 || true
exit 1
