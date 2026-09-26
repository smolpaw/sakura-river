"""Visual gate for Sakura River (NVIDIA FLIP, LDR).

  flip_eval.py downsample --src <raw dir> --dst <golden dir> --factor 3
  flip_eval.py gate --cand <dir> [--base <dir>] [--golden <dir>] [--eps 0.002] [--p99 <thr>] [--json <file>]

Goldens are box-downsampled in linear light. PPD = 44.2: a 1600x900 image shown 1:1 on a 24" 1920x1080
monitor (0.2766 mm pixels) viewed from 0.7 m.
"""
import argparse, json, os, sys, html
import numpy as np
from PIL import Image
import flip_evaluator as flip

PPD = 44.2
HERE = os.path.dirname(os.path.abspath(__file__))


def load(p):
    return np.asarray(Image.open(p).convert('RGB'), dtype=np.float32) / 255.0


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def downsample(src, dst, f):
    n = 0
    for root, _, files in os.walk(src):
        for fn in files:
            if not fn.endswith('.png'):
                continue
            a = srgb_to_lin(load(os.path.join(root, fn)))
            h, w = a.shape[0] // f, a.shape[1] // f
            a = a[:h * f, :w * f].reshape(h, f, w, f, 3).mean(axis=(1, 3))
            out = os.path.join(dst, os.path.relpath(os.path.join(root, fn), src))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Image.fromarray(np.clip(np.round(lin_to_srgb(a) * 255), 0, 255).astype(np.uint8)).save(out)
            n += 1
    m = json.load(open(os.path.join(src, 'manifest.json')))
    m['downsample'] = {'factor': f, 'space': 'linear'}
    json.dump(m, open(os.path.join(dst, 'manifest.json'), 'w'), indent=1)
    print(f'downsampled {n} images x{f} into {dst}')


def fl(ref, test):
    err, mean, _ = flip.evaluate(ref, test, 'LDR', applyMagma=False, parameters={'ppd': PPD})
    return np.asarray(err).squeeze(), float(mean)


def heat_png(err, path):
    # magma-like ramp without matplotlib: black -> purple -> orange -> yellow
    stops = np.array([[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]], dtype=np.float32)
    x = np.clip(err, 0, 1) * (len(stops) - 1)
    i = np.minimum(x.astype(int), len(stops) - 2)
    t = (x - i)[..., None]
    rgb = stops[i] * (1 - t) + stops[i + 1] * t
    Image.fromarray(rgb.astype(np.uint8)).save(path)


def gate(a):
    golden = a.golden or os.path.join(HERE, 'goldens')
    cand, base = a.cand, a.base
    rep_dir = os.path.join(cand, 'report')
    os.makedirs(rep_dir, exist_ok=True)
    mc = json.load(open(os.path.join(cand, 'manifest.json')))
    res = {'cand': os.path.relpath(cand, HERE), 'base': base and os.path.relpath(base, HERE), 'eps': a.eps, 'p99Threshold': a.p99, 'ppd': PPD, 'stills': [], 'sequences': {}, 'fail': []}

    def one(rel, heat_name):
        c = load(os.path.join(cand, rel))
        g = load(os.path.join(golden, rel))
        err, m = fl(g, c)
        row = {'id': rel, 'flipGolden': m}
        heat_png(err, os.path.join(rep_dir, heat_name + '-golden.png'))
        if base:
            b = load(os.path.join(base, rel))
            _, mb = fl(g, b)
            e2, m2 = fl(b, c)
            row.update({'baseFlipGolden': mb, 'flipBase': m2, 'p99Base': float(np.percentile(e2, 99))})
            heat_png(e2, os.path.join(rep_dir, heat_name + '-base.png'))
        return row

    for s in mc['stills']:
        r = one(s['file'], 'still-' + s['id'])
        r['name'] = s['id']
        if base:
            r['pass'] = r['flipGolden'] <= r['baseFlipGolden'] + a.eps and (a.p99 is None or r['p99Base'] <= a.p99)
            if not r['pass']:
                res['fail'].append(r['name'])
        res['stills'].append(r)
        print(f"{r['name']:<22} golden {r['flipGolden']:.4f}" + (f"  base {r['baseFlipGolden']:.4f}  vsBase {r['flipBase']:.4f} p99 {r['p99Base']:.4f} {'PASS' if r['pass'] else 'FAIL'}" if base else ''))

    for sid, frames in mc['sequences'].items():
        rows = []
        if sid.startswith('c-'):
            # temporal stability: per-pixel std over the captured (converged) frames
            stack = np.stack([load(os.path.join(cand, f['file'])) for f in frames])
            sd = float(stack.std(axis=0).mean())
            row = {'temporalStd': sd}
            if base:
                bstack = np.stack([load(os.path.join(base, f['file'])) for f in frames])
                row['baseTemporalStd'] = float(bstack.std(axis=0).mean())
                row['pass'] = sd <= row['baseTemporalStd'] + a.eps_temporal
                if not row['pass']:
                    res['fail'].append(sid)
            last = one(frames[-1]['file'], sid + '-last')
            row['last'] = last
            if base and a.p99 is not None and last['p99Base'] > a.p99:
                row['pass'] = False
                res['fail'].append(sid + '-p99')
            res['sequences'][sid] = row
            print(f"{sid}: temporal std {sd:.5f}" + (f" base {row['baseTemporalStd']:.5f} {'PASS' if row['pass'] else 'FAIL'}" if base else ''))
            continue
        for f in frames:
            rows.append(one(f['file'], f"{sid}-{f['k']:03d}"))
        cg = [r['flipGolden'] for r in rows]
        row = {'meanFlipGolden': float(np.mean(cg)), 'maxFlipGolden': float(np.max(cg)), 'frames': len(rows)}
        if base:
            bg = [r['baseFlipGolden'] for r in rows]
            row.update({'baseMeanFlipGolden': float(np.mean(bg)), 'baseMaxFlipGolden': float(np.max(bg)), 'maxP99Base': float(max(r['p99Base'] for r in rows))})
            row['pass'] = row['meanFlipGolden'] <= row['baseMeanFlipGolden'] + a.eps and row['maxFlipGolden'] <= row['baseMaxFlipGolden'] + a.eps and (a.p99 is None or row['maxP99Base'] <= a.p99)
            if not row['pass']:
                res['fail'].append(sid)
        row['perFrame'] = [{'k': f['k'], **{k: v for k, v in r.items() if k != 'id'}} for f, r in zip(frames, rows)]
        res['sequences'][sid] = row
        print(f"{sid}: mean {row['meanFlipGolden']:.4f} max {row['maxFlipGolden']:.4f}" + (f"  base mean {row['baseMeanFlipGolden']:.4f} max {row['baseMaxFlipGolden']:.4f} p99max {row['maxP99Base']:.4f} {'PASS' if row['pass'] else 'FAIL'}" if base else ''))

    if base:
        res['pass'] = not res['fail']
        print('GATE', 'PASS' if res['pass'] else 'FAIL ' + ', '.join(res['fail']))
    res['meanFlipGolden'] = float(np.mean([r['flipGolden'] for r in res['stills']])) if res['stills'] else None
    if base and res['stills']:
        res['baseMeanFlipGolden'] = float(np.mean([r['baseFlipGolden'] for r in res['stills']]))
    json.dump(res, open(os.path.join(rep_dir, 'gate.json'), 'w'), indent=1)
    if a.json:
        slim = {k: v for k, v in res.items() if k != 'sequences'}
        slim['sequences'] = {k: {kk: vv for kk, vv in v.items() if kk != 'perFrame'} for k, v in res['sequences'].items()}
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        json.dump(slim, open(a.json, 'w'), indent=1)
    gallery(res, cand, base, golden, rep_dir)


def gallery(res, cand, base, golden, rep_dir):
    rel = lambda p: os.path.relpath(p, rep_dir)
    rows = []
    for r in res['stills']:
        f = r['id']
        cells = [f'<img src="{rel(os.path.join(golden, f))}">', f'<img src="{rel(os.path.join(cand, f))}">', f'<img src="still-{r["name"]}-golden.png">']
        if base:
            cells[1:1] = [f'<img src="{rel(os.path.join(base, f))}">']
            cells.append(f'<img src="still-{r["name"]}-base.png">')
        stat = f"golden {r['flipGolden']:.4f}" + (f" | base {r['baseFlipGolden']:.4f} | vsBase {r['flipBase']:.4f} p99 {r['p99Base']:.4f} {'PASS' if r.get('pass') else 'FAIL'}" if base else '')
        rows.append(f"<h3>{html.escape(r['name'])} <small>{stat}</small></h3><div class=row>{''.join(cells)}</div>")
    head = 'golden | ' + ('baseline | ' if base else '') + 'candidate | FLIP vs golden' + (' | FLIP vs baseline' if base else '')
    doc = f"""<!doctype html><meta charset=utf-8><title>Visual gate</title>
<style>body{{background:#111;color:#ddd;font:14px system-ui}} .row{{display:flex;gap:4px}} img{{width:19.5vw}} small{{color:#aaa}}</style>
<h1>Visual gate: {html.escape(res['cand'])}</h1><p>{html.escape(head)} · eps {res['eps']} · {'PASS' if res.get('pass') else ('FAIL: ' + ', '.join(res['fail']) if base else 'no baseline')}</p>
{''.join(rows)}"""
    open(os.path.join(rep_dir, 'index.html'), 'w').write(doc)
    print('gallery:', os.path.join(rep_dir, 'index.html'))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest='cmd', required=True)
    d = sp.add_parser('downsample'); d.add_argument('--src'); d.add_argument('--dst'); d.add_argument('--factor', type=int, default=3)
    g = sp.add_parser('gate'); g.add_argument('--cand'); g.add_argument('--base'); g.add_argument('--golden')
    g.add_argument('--eps', type=float, default=0.002); g.add_argument('--eps-temporal', dest='eps_temporal', type=float, default=0.002)
    g.add_argument('--p99', type=float, default=None); g.add_argument('--json')
    a = p.parse_args()
    downsample(a.src, a.dst, a.factor) if a.cmd == 'downsample' else gate(a)
