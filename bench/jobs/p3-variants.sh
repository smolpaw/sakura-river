#!/usr/bin/env bash
# Visual gate for engine-option variants of one build, sequentially: bench/jobs/p3-variants.sh <build> <backend> tag:extra-json...
# Uses its own browser profile so it can run next to another visual job.
cd "$(dirname "$0")/../.."
b=$1; be=$2; shift 2
for v in "$@"; do
  t=${v%%:*}; extra=${v#*:}
  node bench/visual.mjs --build $b --backend $be --profile visual2 --tag $t --extra "$extra" > bench/out/logs/var-$b-$be-$t.log 2>&1
  bench/.venv/bin/python bench/flip_eval.py gate --cand bench/out/visual/$b-$be-$t --base bench/out/visual/base0-webgl --json bench/out/var-$b-$be-$t.json >> bench/out/logs/var-$b-$be-$t.log 2>&1
done
echo done > bench/out/logs/var-$b-$be.done
