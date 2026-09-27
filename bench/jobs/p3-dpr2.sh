#!/usr/bin/env bash
# DPR-2 parity checks for DPR-dependent settings (bench/dpr_parity.py): reference = the DPR-1 policy applied at DPR 2
cd "$(dirname "$0")/../.."
b=${1:-wtd}
ref='"shaftScale":0.5,"reflScale":0.5,"msaa":4,"ldr8":true'
run() { node bench/visual.mjs --build $b --backend webgpu --dpr 2 --only stills --settings default,time050 --tag "dpr2-$1" --extra "{$ref$2}" > "bench/out/logs/dpr2-$1.log" 2>&1; }
run ref ''
run jit ',"jitter":[0.125,0.125]'
run shaft ',"shaftScale":0.25'
run refl ',"reflScale":0.25'
run msaa2 ',"msaa":2'
for t in shaft refl msaa2; do
  bench/.venv/bin/python bench/dpr_parity.py --ref out/visual/$b-webgpu-dpr2-ref --calib out/visual/$b-webgpu-dpr2-jit --test out/visual/$b-webgpu-dpr2-$t --json out/p3-dpr2-$t.json > bench/out/logs/dpr2-$t-parity.log 2>&1
done
echo done > bench/out/logs/p3-dpr2.done
