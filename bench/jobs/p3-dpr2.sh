#!/usr/bin/env bash
# DPR-2 parity checks for DPR-dependent settings (bench/dpr_parity.py): reference = the DPR-1 policy applied at DPR 2
#   bench/jobs/p3-dpr2.sh <build> tag:extra-json...   (extra is merged over the reference settings)
cd "$(dirname "$0")/../.."
b=$1; shift
ref='"shaftScale":0.5,"reflScale":0.5,"msaa":4,"ldr8":true'
run() { node bench/visual.mjs --build $b --backend webgpu --dpr 2 --only stills --settings default,time050 --tag "dpr2-$1" --extra "{$ref$2}" > "bench/out/logs/dpr2-$b-$1.log" 2>&1; }
run ref ''
run jit ',"jitter":[0.125,0.125]'
for v in "$@"; do
  t=${v%%:*}; run "$t" ",${v#*:}"
  bench/.venv/bin/python bench/dpr_parity.py --ref out/visual/$b-webgpu-dpr2-ref --calib out/visual/$b-webgpu-dpr2-jit --test out/visual/$b-webgpu-dpr2-$t --json out/p3-dpr2-$b-$t.json > "bench/out/logs/dpr2-$b-$t-parity.log" 2>&1
done
echo done > bench/out/logs/p3-dpr2-$b.done
