"""Parity check for DPR-dependent settings, at a device scale the standard gate (DPR 1) does not render.

Compares a test render against a reference render of the same build at the same DPR, and bounds the difference
by an A/A calibration: the reference build rendered with a 1/8-pixel view offset. A change passes when, per
image, its p99 FLIP against the reference is no higher than the A/A p99 and its mean FLIP is within eps of the
A/A mean, i.e. it is no more visible than sub-pixel sample placement.

  python bench/dpr_parity.py --ref out/visual/X-dpr2 --calib out/visual/X-dpr2-jit --test out/visual/X-dpr2-change \
      [--ppd 88.4] [--eps 0.002] [--json results/name.json]
PPD 88.4: the DPR-2 image (3200x1800) on the display the gate's PPD 44.2 assumes for 1600x900.
"""
import argparse, json, os, sys
import numpy as np
import flip_evaluator as flip
sys.path.insert(0, os.path.dirname(__file__))
from flip_eval import load

HERE = os.path.dirname(os.path.abspath(__file__))


def fl(ref, test, ppd):
    err, mean, _ = flip.evaluate(ref, test, 'LDR', applyMagma=False, parameters={'ppd': ppd})
    return err, float(mean)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True); ap.add_argument('--calib', required=True); ap.add_argument('--test', required=True)
    ap.add_argument('--ppd', type=float, default=88.4); ap.add_argument('--eps', type=float, default=0.002); ap.add_argument('--json')
    a = ap.parse_args()
    d = lambda p: p if os.path.isabs(p) else os.path.join(HERE, p)
    ref, cal, test = d(a.ref), d(a.calib), d(a.test)
    rows, fail = [], []
    for f in sorted(os.listdir(os.path.join(ref, 'stills'))):
        r = load(os.path.join(ref, 'stills', f))
        ec, mc = fl(r, load(os.path.join(cal, 'stills', f)), a.ppd)
        et, mt = fl(r, load(os.path.join(test, 'stills', f)), a.ppd)
        row = {'name': f[:-4], 'meanAA': mc, 'p99AA': float(np.percentile(ec, 99)), 'mean': mt, 'p99': float(np.percentile(et, 99))}
        row['pass'] = row['p99'] <= row['p99AA'] and row['mean'] <= row['meanAA'] + a.eps
        if not row['pass']:
            fail.append(row['name'])
        rows.append(row)
        print(f"{row['name']:<22} mean {mt:.4f} (A/A {mc:.4f})  p99 {row['p99']:.4f} (A/A {row['p99AA']:.4f})  {'PASS' if row['pass'] else 'FAIL'}")
    print('PARITY', 'PASS' if not fail else 'FAIL ' + ', '.join(fail))
    if a.json:
        with open(d(a.json), 'w') as fh:
            json.dump({'ref': a.ref, 'calib': a.calib, 'test': a.test, 'ppd': a.ppd, 'eps': a.eps, 'stills': rows, 'fail': fail}, fh, indent=1)


if __name__ == '__main__':
    main()
