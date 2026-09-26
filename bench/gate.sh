#!/usr/bin/env bash
# Visual gate for a build on both backends, one after the other; results to bench/results/<name>-<backend>.json.
# Usage: bench/gate.sh <build> <result-name> [base]
cd "$(dirname "$0")/.."
b=$1; name=$2; base=${3:-base0-webgl}
for be in webgl webgpu; do
  node bench/visual.mjs --build "$b" --backend $be > "bench/out/logs/gate-$b-$be.log" 2>&1
  bench/.venv/bin/python bench/flip_eval.py gate --cand "bench/out/visual/$b-$be" --base "bench/out/visual/$base" --json "bench/results/$name-$be.json" >> "bench/out/logs/gate-$b-$be.log" 2>&1
done
