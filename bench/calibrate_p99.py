"""p99 parity thresholds from a sample-placement A/A: the baseline against itself rendered with a 1/8-pixel view
offset (bench/calib/base0-jitter.patch). A same-build A/A gives p99 ~0.0003, which no renderer change can meet;
the shifted A/A measures how much pure sub-pixel sampling differences move p99 FLIP for each image.
  calibrate_p99.py <base-dir> <jittered-dir> <out.json>"""
import sys, os, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from flip_eval import load, fl
base, jit, out = sys.argv[1:4]
m = json.load(open(os.path.join(base, 'manifest.json')))
files = [s['file'] for s in m['stills']] + [f['file'] for fr in m['sequences'].values() for f in fr]
thr = {}
for f in files:
    e, _ = fl(load(os.path.join(base, f)), load(os.path.join(jit, f)))
    thr[f] = round(float(np.percentile(e, 99)), 4)
json.dump({'method': '1/8-px view-offset A/A of the baseline', 'base': base, 'jittered': jit, 'p99': thr}, open(out, 'w'), indent=1)
v = list(thr.values()); print(f'{len(v)} images: p99 threshold min {min(v):.3f} median {np.median(v):.3f} max {max(v):.3f} -> {out}')
