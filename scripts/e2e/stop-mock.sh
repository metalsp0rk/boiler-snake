#!/usr/bin/env bash
# stop-mock.sh — stop the fauxcord mock started by start-mock.sh (pidfile +
# child processes). Safe to run when nothing is up.
set -uo pipefail

FAUXCORD_DATA_DIR="${FAUXCORD_DATA_DIR:-/tmp/opencode/fauxcord-data-e2e}"
PID_FILE="${PID_FILE:-$FAUXCORD_DATA_DIR/fauxcord.pid}"

if [ ! -f "$PID_FILE" ]; then
  echo "[stop-mock] no pidfile at $PID_FILE — nothing to stop"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  # Negative pid = process group (start-mock started the mock via setsid).
  kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
  kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  echo "[stop-mock] stopped pid $PID"
else
  echo "[stop-mock] pid $PID not running (stale pidfile)"
fi
rm -f "$PID_FILE"
