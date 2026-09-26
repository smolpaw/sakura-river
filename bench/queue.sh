#!/usr/bin/env bash
# Run bench jobs strictly one at a time (the GPU is the measured resource). Usage: bench/queue.sh <jobfile>
# Each non-empty, non-# line of the job file is a command run from the repo root; output goes to bench/out/logs/.
set -u
cd "$(dirname "$0")/.."
mkdir -p bench/out/logs
exec 9>bench/out/.queue.lock
flock 9
while IFS= read -r cmd; do
  [[ -z "$cmd" || "$cmd" == \#* ]] && continue
  echo "$(date +%T) START $cmd" >> bench/out/logs/queue.log
  bash -c "$cmd" >> bench/out/logs/queue-detail.log 2>&1
  echo "$(date +%T) END($?) $cmd" >> bench/out/logs/queue.log
done < "$1"
