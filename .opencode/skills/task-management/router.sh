#!/usr/bin/env bash
# Temporary local shim: the global router's `npx ts-node` bootstrap is broken
# in this repo (no local typescript), so run the same task-cli.ts on Node's
# native TS support. CWD (= project root, where .tmp/tasks lives) is kept.
exec node /home/spork/.config/opencode/skills/task-management/scripts/task-cli.ts "$@"
