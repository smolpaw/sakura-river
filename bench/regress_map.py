"""Where is a candidate worse than the baseline, relative to the golden?
   regress_map.py <cand-dir> <base-dir> <still-id> <out.png>
Writes a 3-panel image: candidate, baseline, per-pixel max(0, FLIP(cand,golden) - FLIP(base,golden)) (magma)."""
import sys, os, numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from flip_eval import load, fl, heat_png
cand, base, sid, out = sys.argv[1:5]
g = load(f'bench/goldens/stills/{sid}.png'); c = load(f'{cand}/stills/{sid}.png'); b = load(f'{base}/stills/{sid}.png')
ec, mc = fl(g, c); eb, mb = fl(g, b)
d = np.clip(ec - eb, 0, 1)
heat_png(np.clip(d * 2, 0, 1), out + '.tmp.png')
H = 450
im = [Image.fromarray((c * 255).astype(np.uint8)), Image.fromarray((b * 255).astype(np.uint8)), Image.open(out + '.tmp.png')]
W = 800
o = Image.new('RGB', (W * 2, H * 2))
for i, x in enumerate(im): o.paste(x.resize((W, H)), ((i % 2) * W, (i // 2) * H))
o.save(out); os.remove(out + '.tmp.png')
print(sid, 'cand', round(mc, 4), 'base', round(mb, 4), 'regression mass by row-band (top->bottom):', [round(float(d[i*150:(i+1)*150].mean()), 4) for i in range(6)])
