#!/usr/bin/env bash
# D2 experiment: temporal AA variants against the baseline (WebGPU), stills + sequences
#   bench/jobs/p3-aa.sh <build> [variant...]   variants: tag:extra-json (default: traa, taau at 1, 0.75, 0.5)
cd "$(dirname "$0")/../.."
build=${1:-wtc}; shift
[ -f bench/out/visual/base0-webgl/manifest.json ] || node bench/visual.mjs --build base0 > bench/out/logs/p3-base0.log 2>&1
vs=("$@"); [ ${#vs[@]} -gt 0 ] || vs=('traa:{"aa":"traa"}' 'taau100:{"aa":"taau","renderScale":1}' 'taau075:{"aa":"taau","renderScale":0.75}' 'taau050:{"aa":"taau","renderScale":0.5}')
for v in "${vs[@]}"; do
  tag=${v%%:*}; extra=${v#*:}
  node bench/visual.mjs --build "$build" --backend webgpu --tag "$tag" --extra "$extra" > "bench/out/logs/p3-$tag.log" 2>&1
  bench/.venv/bin/python bench/flip_eval.py gate --cand "bench/out/visual/$build-webgpu-$tag" --base bench/out/visual/base0-webgl --json "bench/out/p3-$tag.json" >> "bench/out/logs/p3-$tag.log" 2>&1
done
echo done > bench/out/logs/p3-aa.done
