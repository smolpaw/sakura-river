# The spring flowers of the meadow and the banks (src/vegetation.js nanohanaData places them), built in Blender. Run
# through tools/blender.mjs:
#   blender -b --factory-startup -P tools/nanohana.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin at ground level (Blender: z up; glTF: y up), with lighter
# `<kind>_far` and `<kind>_dist` models (src/lods.js):
# - nanohana0, nanohana1, nanohana2: a clump of rapeseed (nanohana, Brassica) about a metre across: six or seven plants 0.75 to
#   1 m tall, each a stem with broad, blue-green leaves clasping it low down, branching near the top, every branch
#   ending in a raceme: buds at its crown, a ring of open four-petalled yellow flowers round them, green pods below;
# - tanpopo: a dandelion, a rosette of toothed leaves flat on the ground, two or three yellow heads on their stalks;
# - tsukushi: a tuft of field horsetail's spring shoots, pale tan stalks banded by dark sheaths, each topped by its
#   spore cone.
# Shading in the vertex colours (darker low down, where the plants shade each other); alpha: how far the wind moves a
# vertex (0 at the ground .. 1 at the top of a metre-tall plant; materials.js nanohanaMaterial).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import lerp, link, tris, smoothstep
from village import srgb

V = Vector
YELLOW = srgb('#f4cf1a')     # the open flowers
YELLOW_D = srgb('#d9a812')   # their hearts, and the flowers seen from below
BUD = srgb('#b9b43a')        # buds: green going yellow
STEM = srgb('#5d8a3a')
LEAF = srgb('#4f7a4a')       # rapeseed's leaves are glaucous: a blue-grey bloom on the green
LEAF_D = srgb('#3a5e38')
POD = srgb('#7a9a3e')
DANDE_LEAF = srgb('#3f6e2a')
DANDE = srgb('#f2b90f')      # a dandelion's head, deeper than the rape
DANDE_C = srgb('#e0960a')
TAN = srgb('#c9b48a')        # horsetail's shoots
SHEATH = srgb('#4a3a2a')
CONE = srgb('#8a7a4e')

LEVELS = ['', '_far', '_dist']


class Mesh:
    """triangles with a colour per vertex (rgb, flex)"""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Color')

    def v(self, p, c, flex):
        v = self.bm.verts.new(p)
        v[self.col] = (c[0], c[1], c[2], flex)
        return v

    def face(self, vs):
        self.bm.faces.new(vs)

    def finish(self, name, shade_low=(0.5, 0.45)):
        """darkened low down (shade_low: the factor at the ground, the height it is gone by); one mesh `name`"""
        bm = self.bm
        bmesh.ops.triangulate(bm, faces=bm.faces)
        bm.normal_update()
        for v in bm.verts:
            c = v[self.col]
            k = lerp(shade_low[0], 1.0, smoothstep(0.0, shade_low[1], v.co.z))
            v[self.col] = (c[0] * k, c[1] * k, c[2] * k, c[3])
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        me.validate()
        me.color_attributes.active_color = me.color_attributes['Color']
        link(me, name)
        return me


def flex_at(z, H=1.0):
    """how far the wind moves a point z up a plant of height H (metres): stiff at the foot, most at the top"""
    return min(1.0, max(0.0, z) / 1.0) ** 1.5 * min(1.0, H / 1.0) ** 0.5


def frame(d):
    """two unit vectors across direction d"""
    a = V((1, 0, 0)) if abs(d.x) < 0.9 else V((0, 1, 0))
    u = d.cross(a).normalized()
    return u, d.cross(u).normalized()


def tube(m, pts, radii, seg, col, cols=None):
    """a tube through pts with radii; cols: a colour per ring (else col)"""
    rings = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        u, w = frame(d)
        c = cols[i] if cols else col
        rings.append([m.v(p + (u * math.cos(a) + w * math.sin(a)) * radii[i], c, flex_at(p.z)) for a in (k / seg * math.tau for k in range(seg))])
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            m.face([a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]])
    return rings


def card(m, centre, right, up, w, h, cols, rows=1, bend=0.0, taper=None):
    """a quad strip (rows high) from centre along up, w wide, bending back along the normal by `bend` at the tip;
    cols: colour at the foot and tip; taper(t): the width at t (0 foot .. 1 tip)"""
    n = right.cross(up).normalized()
    prev = None
    for r in range(rows + 1):
        t = r / rows
        ww = w * (taper(t) if taper else 1.0) / 2
        p = centre + up * (h * t) + n * (bend * t * t)
        c = [lerp(cols[0][i], cols[1][i], t) for i in range(3)]
        row = [m.v(p - right * ww, c, flex_at(p.z)), m.v(p + right * ww, c, flex_at(p.z))]
        if prev:
            m.face([prev[0], prev[1], row[1], row[0]])
        prev = row


def cross_flower(m, p, out, size, col, heart):
    """a four-petalled flower facing `out`: two crossed diamonds, the heart darker"""
    u, w = frame(out)
    for a in (u, w):
        c0 = m.v(p + out * 0.002, heart, flex_at(p.z))
        m.face([m.v(p - a * size, col, flex_at(p.z)), m.v(p + (a.cross(out)) * size * 0.28, col, flex_at(p.z)), c0])
        m.face([c0, m.v(p - (a.cross(out)) * size * 0.28, col, flex_at(p.z)), m.v(p - a * size, col, flex_at(p.z))])
        m.face([m.v(p + a * size, col, flex_at(p.z)), m.v(p - (a.cross(out)) * size * 0.28, col, flex_at(p.z)), c0])
        m.face([c0, m.v(p + (a.cross(out)) * size * 0.28, col, flex_at(p.z)), m.v(p + a * size, col, flex_at(p.z))])


def raceme(m, tip, d, rng, level):
    """the head of a branch at `tip` (its axis d): buds on top, a ring of open flowers round them, pods below"""
    u, w = frame(d)
    if level == 0:
        for k in range(4):  # buds: small knots at the crown
            a = rng.uniform(0, math.tau)
            p = tip + d * 0.012 + (u * math.cos(a) + w * math.sin(a)) * rng.uniform(0.0, 0.01)
            tube(m, [p - d * 0.006, p + d * 0.008], [0.005, 0.001], 3, BUD)
        n = rng.randint(9, 12)
        for k in range(n):  # the open flowers: a dome round the buds, on short stalks
            a = k / n * math.tau + rng.uniform(-0.2, 0.2)
            r = rng.uniform(0.015, 0.03)
            side = u * math.cos(a) + w * math.sin(a)
            p = tip - d * rng.uniform(0.0, 0.03) + side * r
            cross_flower(m, p, (side * 0.6 + d).normalized(), rng.uniform(0.008, 0.011), YELLOW, YELLOW_D)
        for k in range(rng.randint(3, 5)):  # pods: thin, angled up off the axis further down
            a = rng.uniform(0, math.tau)
            p = tip - d * rng.uniform(0.05, 0.12)
            side = u * math.cos(a) + w * math.sin(a)
            card(m, p, side.cross(d).normalized(), (d + side * 0.6).normalized(), 0.004, rng.uniform(0.03, 0.045), (POD, POD))
    else:
        # far: the head as two crossed yellow cards
        for a in (u, w):
            card(m, tip - d * 0.045, a, d, 0.1, 0.08, (YELLOW_D, YELLOW), taper=lambda t: 0.6 + 0.8 * t * (1.4 - t))


def leaf(m, base, d, length, width, col, rng, rows=3):
    """a broad leaf from `base` out along d (tilted), folded a little along its midrib, arching down"""
    side = d.cross(V((0, 0, 1))).normalized()
    if side.length < 0.5:
        side = V((1, 0, 0))
    up = d
    shape = lambda t: math.sin(math.pi * min(1.0, 0.15 + t * 0.95)) ** 0.7
    card(m, base, side, up, width, length, (LEAF_D, col), rows=rows, bend=-length * 0.35, taper=shape)


def plant(m, at, H, rng, level):
    """one rapeseed plant standing at `at`, H tall"""
    lean = V((rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08), 1)).normalized()
    curve = V((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 0))
    stem = lambda t: at + lean * (H * 0.93 * t) + curve * (t * t)
    if level == 0:
        pts = [stem(t) for t in (0, 0.3, 0.6, 0.85, 1.0)]
        tube(m, pts, [0.007, 0.006, 0.005, 0.004, 0.003], 4, STEM)
    elif level == 1:
        p0, p1 = stem(0), stem(1)
        for a in (V((1, 0, 0)), V((0, 1, 0))):
            card(m, p0, a, (p1 - p0).normalized(), 0.012, (p1 - p0).length, (STEM, STEM), taper=lambda t: 1 - 0.5 * t)
    # leaves: large ones low down clasping the stem, small ones higher
    n_low = 3 if level == 0 else 2
    for k in range(n_low):
        a = k / n_low * math.tau + rng.uniform(-0.4, 0.4)
        z = rng.uniform(0.05, 0.25)
        d = V((math.cos(a), math.sin(a), rng.uniform(0.5, 0.9))).normalized()
        leaf(m, stem(z), d, rng.uniform(0.16, 0.24) * H, rng.uniform(0.07, 0.1) * H, LEAF, rng, rows=3 if level == 0 else 1)
    if level == 0:
        for k in range(2):
            a = rng.uniform(0, math.tau)
            d = V((math.cos(a), math.sin(a), 1.4)).normalized()
            leaf(m, stem(rng.uniform(0.45, 0.65)), d, rng.uniform(0.06, 0.09) * H, 0.025 * H, LEAF, rng, rows=1)
    # the branches near the top, each ending in a raceme; the stem's own at the top
    top = stem(1.0)
    raceme(m, top + lean * 0.02, lean, rng, level)
    for k in range(rng.randint(2, 3)):
        t0 = rng.uniform(0.7, 0.85)
        a = rng.uniform(0, math.tau)
        d = (lean + V((math.cos(a), math.sin(a), 0)) * rng.uniform(0.5, 0.8)).normalized()
        L = rng.uniform(0.1, 0.2) * H
        b0 = stem(t0)
        b1 = b0 + d * L + V((0, 0, L * 0.4))
        if level == 0:
            tube(m, [b0, (b0 + b1) * 0.5 + V((0, 0, 0.02)), b1], [0.004, 0.003, 0.002], 3, STEM)
        elif level == 1:
            card(m, b0, d.cross(V((0, 0, 1))).normalized(), (b1 - b0).normalized(), 0.008, (b1 - b0).length, (STEM, STEM))
        raceme(m, b1, (b1 - b0).normalized() * 0.4 + V((0, 0, 0.6)), rng, level)


def nanohana(name, seed, level):
    rng = random.Random(seed)
    m = Mesh()
    if level < 2:
        spots = []
        while len(spots) < 7:
            p = V((rng.uniform(-0.42, 0.42), rng.uniform(-0.42, 0.42), 0))
            if p.length < 0.45 and all((p - q).length > 0.2 for q in spots):
                spots.append(p)
        for i, p in enumerate(spots):
            plant(m, p, rng.uniform(0.75, 1.0) if i else 1.0, random.Random(seed * 31 + i), level)
    else:
        # distant: three crossed cards, narrow and green at the foot, wide and yellow at the top
        for k in range(3):
            a = k / 3 * math.pi + rng.uniform(-0.2, 0.2)
            right = V((math.cos(a), math.sin(a), 0))
            prev = None
            for z, w, c in ((0.0, 0.25, LEAF_D), (0.6, 0.55, STEM), (0.78, 0.9, YELLOW_D), (0.98, 0.75, YELLOW)):
                row = [m.v(right * -w / 2 + V((0, 0, z)), c, flex_at(z)), m.v(right * w / 2 + V((0, 0, z)), c, flex_at(z))]
                if prev:
                    m.face([prev[0], prev[1], row[1], row[0]])
                prev = row
    return m.finish(name + LEVELS[level])


def tanpopo(name, seed, level):
    rng = random.Random(seed)
    m = Mesh()
    n = 8 if level == 0 else 4
    for k in range(n if level < 2 else 2):
        # the rosette: long toothed leaves lying out flat (the teeth as a zigzag edge)
        a = k / n * math.tau + rng.uniform(-0.2, 0.2)
        d = V((math.cos(a), math.sin(a), 0.12)).normalized()
        side = V((-math.sin(a), math.cos(a), 0))
        if level == 0:
            L = rng.uniform(0.1, 0.16)
            prev = None
            for r in range(6):
                t = r / 5
                ww = 0.022 * math.sin(math.pi * min(1, 0.1 + t)) * (0.6 if r % 2 else 1.0)
                p = d * (L * t) + V((0, 0, 0.005 + 0.02 * t * (1 - t)))
                row = [m.v(p - side * ww, lerp_c(DANDE_LEAF, LEAF, t), 0.0), m.v(p + side * ww, lerp_c(DANDE_LEAF, LEAF, t), 0.0)]
                if prev:
                    m.face([prev[0], prev[1], row[1], row[0]])
                prev = row
        else:
            card(m, V((0, 0, 0.005)), side, d, 0.04, 0.13, (DANDE_LEAF, DANDE_LEAF))
    heads = rng.randint(2, 3)
    for k in range(heads):
        a = rng.uniform(0, math.tau)
        h = rng.uniform(0.08, 0.18)
        top = V((math.cos(a) * 0.03, math.sin(a) * 0.03, h))
        if level == 0:
            tube(m, [V((0, 0, 0)), top * 0.5 + V((0.005, 0, 0)), top], [0.003, 0.0025, 0.002], 3, STEM)
        elif level == 1:
            card(m, V((0, 0, 0)), V((1, 0, 0)), top.normalized(), 0.005, top.length, (STEM, STEM))
        # the head: a disc of florets, deeper in the middle, facing up and a little out
        seg = 10 if level == 0 else 5
        out = (V((math.cos(a), math.sin(a), 0)) * 0.35 + V((0, 0, 1))).normalized()
        u, w = frame(out)
        c = m.v(top + out * 0.006, DANDE_C, flex_at(h))
        ring = [m.v(top + (u * math.cos(b) + w * math.sin(b)) * 0.03 * (1.0 if j % 2 == 0 or level else 0.85), DANDE, flex_at(h))
                for j, b in enumerate(i / seg * math.tau for i in range(seg))]
        for j in range(seg):
            m.face([c, ring[j], ring[(j + 1) % seg]])
    return m.finish(name + LEVELS[level], shade_low=(0.8, 0.05))


def lerp_c(a, b, t):
    return [lerp(a[i], b[i], t) for i in range(3)]


def tsukushi(name, seed, level):
    rng = random.Random(seed)
    m = Mesh()
    n = 7
    for k in range(n):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.0, 0.07)
        foot = V((math.cos(a) * r, math.sin(a) * r, 0))
        h = rng.uniform(0.09, 0.22)
        lean = V((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1)).normalized()
        top = foot + lean * h
        if level == 0:
            # the stalk banded by its sheaths, every few centimetres
            rows = 7
            pts = [foot + lean * (h * 0.8 * i / rows) for i in range(rows + 1)]
            cols = [SHEATH if i % 2 == 1 else TAN for i in range(rows + 1)]
            tube(m, pts, [0.0035] * (rows + 1), 4, TAN, cols)
            # the cone: thicker, rounded at the tip
            c0 = foot + lean * (h * 0.8)
            tube(m, [c0, c0 + lean * h * 0.08, c0 + lean * h * 0.17, top], [0.004, 0.0065, 0.006, 0.001], 5, CONE)
        else:
            u, w = frame(lean)
            card(m, foot, u, lean, 0.008, h, (TAN, CONE))
            if level == 1:
                card(m, foot, w, lean, 0.008, h, (TAN, CONE))
    return m.finish(name + LEVELS[level], shade_low=(0.8, 0.04))


KINDS = {
    'nanohana0': lambda level: nanohana('nanohana0', 3, level),
    'nanohana1': lambda level: nanohana('nanohana1', 8, level),
    'nanohana2': lambda level: nanohana('nanohana2', 13, level),
    'tanpopo': lambda level: tanpopo('tanpopo', 5, level),
    'tsukushi': lambda level: tsukushi('tsukushi', 6, level),
}

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for kind in KINDS:
        for level in range(len(LEVELS)):
            me = KINDS[kind](level)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
