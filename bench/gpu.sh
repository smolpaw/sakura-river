#!/usr/bin/env bash
# Runs one command while holding the machine-wide GPU/CPU lock, so Blender builds, Vite builds, look captures,
# headed browser runs and timing runs never overlap (the GPU is the measured resource and the CPU is shared).
# Usage: bench/gpu.sh <command> [args...]      (waits for the lock; LOCK_WAIT=<seconds> gives up instead)
# The lock is one file for every checkout and worktree of this repo on the machine.
lock="${XDG_RUNTIME_DIR:-/tmp}/sakura-river-gpu.lock"
exec 9>"$lock"
if ! flock ${LOCK_WAIT:+-w "$LOCK_WAIT"} 9; then echo "gpu.sh: lock busy" >&2; exit 75; fi
echo "$(date +%T) $$ $*" >> "${lock%.lock}.log"
"$@"
