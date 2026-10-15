#!/usr/bin/env bash
# start-mock.sh — boot the fauxcord mock Discord for the Tier-4 E2E suite.
#
# Clones fauxcord (pinned commit), applies the vendored fidelity/simulation
# patch (scripts/e2e/fauxcord-e2e.patch — upstream PRs pending), installs,
# and starts the server in the background. Idempotent: exits 0 immediately
# when a healthy mock already answers (set FRESH=1 to force a restart).
#
# Env overrides: FAUXCORD_DIR (clone location), PORT, HOST, FAUXCORD_DATA_DIR,
# FAUXCORD_URL (health-check + suite target; defaults to http://127.0.0.1:PORT).
set -euo pipefail

# Keep in sync with the base of scripts/e2e/fauxcord-e2e.patch. Bump only
# after re-deriving the patch against the new base (git diff > patch).
FAUXCORD_PIN="${FAUXCORD_PIN:-fe7a9f5c2b61ab100c1b933220c7d1d92921dcb9}"
FAUXCORD_REPO="${FAUXCORD_REPO:-https://github.com/tomacheese/fauxcord}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/fauxcord-e2e.patch"
LOCK_FILE="$SCRIPT_DIR/fauxcord.lock.json"

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
# fauxcord commits NO package-lock.json upstream, so `npm ci` is impossible
# without one: we vendor the lockfile generated for the pinned commit
# (scripts/e2e/fauxcord.lock.json) and copy it in. Regenerate BOTH this lock
# and the patch whenever FAUXCORD_PIN moves:
#   cd <clone at new pin> && npm install && cp package-lock.json <repo>/scripts/e2e/fauxcord.lock.json
# `npm ci` (not install) keeps resolution frozen — immune to upstream drift
# and to npm resolve-crash classes seen in the field.
if [ ! -d node_modules ]; then
  if [ ! -f package-lock.json ]; then
    if [ ! -f "$LOCK_FILE" ]; then
      echo "[start-mock] FAIL: no upstream lockfile and no vendored $LOCK_FILE" >&2
      exit 1
    fi
    echo "[start-mock] installing from vendored lockfile (first run)"
    cp "$LOCK_FILE" package-lock.json
  else
    echo "[start-mock] installing from upstream lockfile (first run)"
  fi
  npm ci --no-audit --no-fund --no-progress
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
