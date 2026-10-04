# The riverside's lamps (src/lanterns.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/lamps.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin at ground level (Blender: z up; glTF: y up), with a lighter
# `<kind>_far` model and, for the Ultra tier, a detailed `<kind>_near` one (the full model's shapes, refined: grain,
# checks, rope strands, washi, chips, rivets, split logs):
# - post: a weathered cedar post for the festival lanterns' ropes round the cherries, sunk 0.4 m, the rope tied
#   round it 2.55 m up (lanterns.js ROPE) under a small cap;
# - bonbori: a paper lamp on a wooden post on a stone footing, as along riverside paths at night cherry viewings: a
#   hexagonal shade of white washi with a red band on a dark frame, under a little hexagonal roof, its light 1.76 m up;
# - kagaribi: a fire basket of iron bands on three crossed iron legs, split pine stacked in it over glowing coals (the
#   page adds the flames, 1.55 m up).
# Shading in the vertex colours (ambient occlusion by ray casting); alpha: how much a part glows after dusk (the
# paper, lit from inside; the coals).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import lerp, link, tris, vertex_ao, smoothstep
from village import Kit, srgb, shared_ao

V = Vector
CEDAR = srgb('#8a7a68')      # weathered post: sun-greyed cedar, grey-brown
CEDAR_S = srgb('#665646')    # the post's darker grain streaks
CEDAR_D = srgb('#2e231b')
ROPE = srgb('#a08a5e')       # straw rope
STONE = srgb('#7d776c')
PAPER = srgb('#f1ead6')
RED = srgb('#b8261a')
IRON = srgb('#26221f')
CHAR = srgb('#1b1612')       # charred pine
PINE = srgb('#8a6a45')       # split faces not yet burnt
COAL = srgb('#ff6a1c')
LICHEN = srgb('#a5a68a')


def finish(k, name, ao_reach=0.5, ao_floor=0.45):
    """AO into the colours of what does not glow (the most occluded at ao_floor); one mesh named `name`"""
    bm = k.bm
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = shared_ao(name, bm, vertex_ao(bm, ao_reach))
    for v in bm.verts:
        c = v[k.col]
        a = 1.0 if c[3] > 0 else lerp(ao_floor, 1.0, ao[v.index])
        v[k.col] = (c[0] * a, c[1] * a, c[2] * a, c[3])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()
    me.color_attributes.active_color = me.color_attributes['Color']
    link(me, name)
    return me


def glowing(k, vs, g=1.0):
    """what Kit just made glows g after dusk"""
    for v in vs:
        c = v[k.col]
        v[k.col] = (c[0], c[1], c[2], g)


# ---------- the near models' surfaces ----------
# Detail in the vertex colours only reads where the vertices are closer than its own scale, so each pattern's
# frequency is matched to the grid it is painted on.
def cedar(seed, cell, checks=()):
    """weathered cedar for lattice_box (cell: its grid's spacing across the faces): grain running up it in pale and
    dark streaks, the soft rings worn into shallow grooves, greyed in places by the sun; checks (cracks along the
    grain: (axis, side, across, z0, z1) in the box's own frame) dark and deep. Returns (col, disp)."""
    off = V((seed * 3.3, seed * 1.9, seed * 4.1))
    f = 0.55 / cell  # the grain's streaks a few cells wide

    def across(p, n):
        return p.y if abs(n.x) > abs(n.y) else p.x

    def grain(p, n):
        u = across(p, n)
        return noise.noise(V((u * f, p.z * 1.5, 0)) + off) * 0.75 + noise.noise(V((u * f * 1.9, p.z * 4, 1.7)) + off) * 0.25

    def crack(p, n):
        u = across(p, n)
        k = 0.0
        for ax, side, u0, z0, z1 in checks:
            if (n.x if ax == 0 else n.y) * side > 0.5:
                k = max(k, smoothstep(cell * 0.9, cell * 0.2, abs(u - u0)) * smoothstep(z0, z0 + 0.1, p.z) * smoothstep(z1, z1 - 0.1, p.z))
        return k

    def col(p, n):
        g = grain(p, n)
        c = CEDAR * (1.0 + 0.45 * g) * (1.0 + 0.1 * noise.noise(V((across(p, n) * f * 0.3, p.z * 0.6, 5)) + off))
        c = c.lerp(srgb('#7d7468'), 0.22 * smoothstep(0.15, 0.55, noise.noise(V((across(p, n) * f * 0.25, p.z * 0.5, 3)) + off)))  # sun-greyed
        return c.lerp(CEDAR_D * 0.35, crack(p, n))

    def disp(p, n):
        return 0.0015 * smoothstep(-0.3, 0.4, -grain(p, n)) + 0.007 * crack(p, n)
    return col, disp


def stone_face(seed, cell, chips=0.012):
    """dressed stone for lattice_box: mottled, pocked by the chisel, lichen on what faces up, its arrises chipped"""
    off = V((seed * 2.7, seed * 5.1, seed * 1.3))
    f = 0.5 / cell

    def col(p, n):
        c = STONE * (0.86 + 0.18 * noise.noise(p * f * 0.4 + off) + 0.1 * noise.noise(p * f + off))
        lich = smoothstep(0.25, 0.55, noise.noise(p * f * 0.7 + off * 2)) * smoothstep(0.2, 0.8, n.z + 0.3)
        return c.lerp(LICHEN, 0.5 * lich)

    def disp(p, n):
        edge = smoothstep(0.75, 0.6, max(abs(n.x), abs(n.y), abs(n.z)))  # at an arris (normal between two faces)
        return 0.002 * (0.5 + 0.5 * noise.noise(p * f + off)) + chips * edge * smoothstep(-0.2, 0.5, noise.noise(p * f * 0.6 + off))
    return col, disp


def rope(k, pts, r, lay=0.3, seed=0):
    """three-stranded straw rope along pts: rings of six, crests and grooves, turned along it by the lay (metres per
    turn of the strands), so the strands spiral round it in the shape and the colour; points about a twelfth of the
    lay apart"""
    rng = random.Random(seed)
    seg, n = 6, len(pts)
    rings, u, arc = [], None, 0.0
    for j, p in enumerate(pts):
        if j:
            arc += (p - pts[j - 1]).length
        t = (pts[min(j + 1, n - 1)] - pts[max(j - 1, 0)]).normalized()
        if u is None:
            u = V((1, 0, 0)) if abs(t.z) > 0.9 else V((0, 0, 1))
        u = (u - t * u.dot(t)).normalized()
        w = t.cross(u)
        tw = 2 * math.pi * arc / lay
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg + tw
            crest = i % 2 == 0
            v = k.bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * r * (1.0 if crest else 0.7))
            c = ROPE * ((1.08 if crest else 0.5) * (0.9 + 0.2 * rng.random()))
            v[k.col] = (*c, 0.0)
            ring.append(v)
        rings.append(ring)
    for j in range(n - 1):
        for i in range(seg):
            k.bm.faces.new((rings[j][i], rings[j][(i + 1) % seg], rings[j + 1][(i + 1) % seg], rings[j + 1][i])).smooth = True
    for ring, p, s in ((rings[0], pts[0], -1), (rings[-1], pts[-1], 1)):  # the cut ends, paler
        c = k.bm.verts.new(p)
        c[k.col] = (*(ROPE * 1.2), 0.0)
        for i in range(seg):
            q = (ring[i], ring[(i + 1) % seg], c) if s > 0 else (ring[(i + 1) % seg], ring[i], c)
            k.bm.faces.new(q)


def rope_coil(k, z0, z1, turns, half, r, seed):
    """rope wound round a square post (half its width), spiralling up, hugging the post's faces"""
    per = 20
    pts = []
    for i in range(turns * per + 1):
        a = 2 * math.pi * i / per
        c, s = math.cos(a), math.sin(a)
        e = 0.25  # a superellipse: flat along the faces, round at the corners
        R = half + r * 0.8
        pts.append(V((math.copysign(abs(c) ** e, c) * R, math.copysign(abs(s) ** e, s) * R, lerp(z0, z1, i / (turns * per)))))
    rope(k, pts, r, lay=0.3, seed=seed)


def dense(pts, step=0.02):
    """pts with points added along each span, at most `step` apart"""
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, math.ceil((b - a).length / step))
        out += [a.lerp(b, i / n) for i in range(1, n + 1)]
    return out


def hexring(z, r):
    """a ring of six corners as Kit.cyl places them about z (its first corner on +y)"""
    return [V((-math.sin(2 * math.pi * i / 6) * r, math.cos(2 * math.pi * i / 6) * r, z)) for i in range(6)]


def post(level):
    far, near = level == '_far', level == '_near'
    k = Kit()
    rng = random.Random(3)
    if near:
        # checks: (axis, side, across, z0, z1), z from the post's middle 1.2 m up
        col, disp = cedar(3, 0.015, checks=[(0, 1, 0.015, 0.2, 1.1), (1, -1, -0.015, -0.9, -0.3), (1, 1, 0.03, 0.7, 1.4)])
        k.lattice_box((0.12, 0.12, 3.2), V((0, 0, 1.2)), (8, 8, 14), col, disp, skip=('-z', '+z'))
    else:
        k.box(CEDAR, (0.12, 0.12, 3.2), V((0, 0, 1.2)))
    if not far:
        # weathering: darker grain streaks down two faces, a split near the top
        for i in range(5):
            x = rng.uniform(-0.045, 0.045)
            k.box(CEDAR_S, (0.012, 0.125, rng.uniform(0.6, 1.6)), V((x, 0, rng.uniform(0.6, 2.0))))
        if near:
            # the rope's turns round the post, and its knot: two loops and the frayed end the line leaves by
            rope_coil(k, 2.515, 2.585, 3, 0.06, 0.017, 4)
            for s in (-1, 1):
                rope(k, dense([V((0.07, 0, 2.55)), V((0.1, s * 0.03, 2.56 + s * 0.012)), V((0.112, s * 0.008, 2.535)), V((0.085, 0, 2.545))]), 0.015, seed=5 + s)
            rope(k, dense([V((0.075, 0, 2.55)), V((0.12, 0, 2.52)), V((0.16, 0, 2.48))]), 0.022, seed=8)
            frng = random.Random(9)
            for i in range(9):  # the straw fibres splaying out of the cut end
                d = V((1, frng.uniform(-0.6, 0.6), frng.uniform(-0.8, 0.4))).normalized()
                a = V((0.16, 0, 2.48)) + V((0, frng.uniform(-0.012, 0.012), frng.uniform(-0.012, 0.012)))
                k.tube([a, a + d * frng.uniform(0.02, 0.045)], [0.0025, 0.001], 3, lambda p, al, ar: (ROPE * 1.1, 0.0))
        else:
            # the rope's turns round the post, and its knot
            k.cyl(ROPE, V((0, 0, 2.5)), V((0, 0, 2.6)), 0.085, seg=8)
            k.cyl(ROPE, V((0.06, 0, 2.55)), V((0.16, 0, 2.48)), 0.03, seg=5)
    # a cap against the rain: a low pyramid of board
    k.mesh([V((-0.1, -0.1, 2.8)), V((0.1, -0.1, 2.8)), V((0.1, 0.1, 2.8)), V((-0.1, 0.1, 2.8)), V((0, 0, 2.9))],
           [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)], CEDAR_D)
    if near:  # the cap's nail heads
        for x, y in ((0.06, 0), (-0.06, 0), (0, 0.06), (0, -0.06)):
            z = 2.8 + 0.1 * (1 - max(abs(x), abs(y)) / 0.1) + 0.002
            k.cyl(IRON, V((x, y, z - 0.003)), V((x, y, z + 0.003)), 0.006, seg=5, smooth=False)
    # (a lone post in the open: little occludes it but its own cap and rope)
    return finish(k, 'post' + level, ao_floor=0.7)


def washi(seed):
    """the shade's paper lit from inside: fibres and the thicker patches of hand-made paper in the colour (and so in
    the glow), a little darker where it is pasted to the frame"""
    off = V((seed * 1.7, seed * 2.3, seed * 0.9))

    def col(p, u, t):
        fib = noise.noise(V((p.x * 14 + p.z * 6, p.y * 14 - p.z * 5, p.z * 9)) + off) * 0.6 + noise.noise(p * 24 + off) * 0.4
        cloud = noise.noise(p * 6 + off)
        # darker where it is pasted: round the top and foot, and down the middle of each side, behind the rib
        edge = smoothstep(0.1, 0.0, min(t, 1 - t)) * 0.1 + smoothstep(0.1, 0.0, abs((u * 6) % 1 - 0.5)) * 0.08
        c = PAPER * (0.96 + 0.08 * fib - 0.05 * cloud - edge)
        return c, 1.0
    return col


def bonbori(level):
    far, near = level == '_far', level == '_near'
    k = Kit()
    if near:
        col, disp = stone_face(5, 0.057)
        k.lattice_box((0.34, 0.34, 0.26), V((0, 0, 0.03)), (6, 6, 4), col, disp, skip=('-z',), smooth=False)
        col, disp = cedar(6, 0.012, checks=[(0, -1, 0.0, -0.43, 0.12)])
        k.lattice_box((0.085, 0.085, 1.45), V((0, 0, 0.16 + 0.72)), (7, 7, 10), col, disp, skip=('-z', '+z'))
    else:
        k.box(STONE, (0.34, 0.34, 0.26), V((0, 0, 0.03)))
        k.box(CEDAR, (0.085, 0.085, 1.45), V((0, 0, 0.16 + 0.72)))
    k.box(CEDAR_D, (0.3, 0.3, 0.035), V((0, 0, 1.52)))
    # the shade: washi on a hexagonal frame, a red band round its foot
    z0, z1, r = 1.54, 1.98, 0.19
    if near:
        k.prism(hexring(z0, r), hexring(z1, r * 1.06), 6, 12, washi(8))
    else:
        glowing(k, k.cyl(PAPER, V((0, 0, z0)), V((0, 0, z1)), r, seg=6, r2=r * 1.06, smooth=False, cap=False))
    glowing(k, k.cyl(RED, V((0, 0, z0)), V((0, 0, z0 + 0.075)), r * 1.012, seg=6, r2=r * 1.022, smooth=False, cap=False))
    if not far:
        for i in range(6):
            a = 2 * math.pi * i / 6
            c, s = math.cos(a), math.sin(a)
            k.beam(CEDAR_D, V((c * r * 1.01, s * r * 1.01, z0)), V((c * r * 1.07, s * r * 1.07, z1)), 0.022, 0.022)
        for z, rr in ((z0, r), (z1, r * 1.06)):
            k.cyl(CEDAR_D, V((0, 0, z - 0.012)), V((0, 0, z + 0.012)), rr * 1.08, seg=6, smooth=False)
        # the paper's inner face, seen through the open top's lip
        glowing(k, k.cyl(PAPER, V((0, 0, z1 - 0.01)), V((0, 0, z1)), r * 1.0, seg=6, smooth=False, cap=True))
        if near:
            # the frame's thin cross ribs under the paper, showing through it as darker bands
            for t in (0.36, 0.68):
                z, rr = lerp(z0, z1, t), r * lerp(1.0, 1.06, t)
                k.cyl(CEDAR_D, V((0, 0, z - 0.004)), V((0, 0, z + 0.004)), rr * 1.012, seg=6, smooth=False, cap=False)
    # a hexagonal roof, its eaves a little turned up, a round knob
    k.cyl(CEDAR_D, V((0, 0, 1.99)), V((0, 0, 2.03)), 0.3, seg=6, r2=0.29, smooth=False)
    if near:
        # its slopes laid in boards (alternate boards a shade apart, a dark seam between), a ridge strip on each hip
        # (a vertex on each seam and one mid-board: the colour only changes at vertices)
        brng = random.Random(12)
        shades = [brng.uniform(0.85, 1.25) for _ in range(30)]

        def boards(p, u, t):
            b = u * 30 + 1e-6
            seam = smoothstep(0.35, 0.45, abs(b % 1 - 0.5))
            return CEDAR_D * shades[int(b) % 30] * (1 - 0.35 * seam) * (0.92 + 0.16 * noise.noise(V((b, t * 3, 0)))), 0.0
        k.prism(hexring(2.03, 0.27), hexring(2.17, 0.03), 10, 3, boards)
        k.mesh(hexring(2.17, 0.03), [tuple(range(6))], CEDAR_D)
        for a, b in zip(hexring(2.036, 0.275), hexring(2.176, 0.04)):
            k.beam(CEDAR_D * 0.8, a, b, 0.016, 0.012)
        k.cyl(CEDAR_D, V((0, 0, 2.16)), V((0, 0, 2.23)), 0.035, seg=12, r2=0.015)
    else:
        k.cyl(CEDAR_D, V((0, 0, 2.03)), V((0, 0, 2.17)), 0.27, seg=6, r2=0.03, smooth=False)
        k.cyl(CEDAR_D, V((0, 0, 2.16)), V((0, 0, 2.23)), 0.035, seg=6, r2=0.015)
    return finish(k, 'bonbori' + level)


def split_log(k, p0, p1, w, h, base, rng, ember):
    """a split pine log from p0 to p1 fitting a w x h beam: the split faces flat below, the bark rounded over the top;
    charred black with the crackle of burnt wood, embers glowing in the cracks underneath (ember: how much)"""
    d = p1 - p0
    x = d.normalized()
    y = V((0, 0, 1)).cross(x).normalized()
    z = x.cross(y)
    sec = [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.05), (0.32, 0.38), (0.0, 0.5), (-0.32, 0.38), (-0.5, 0.05)]
    n = 10
    off = V((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    rings = []
    for j in range(n + 1):
        t = j / n
        c = p0 + d * t
        wob = 0.08 * noise.noise(V((t * 3, 0, 0)) + off)
        ring = []
        for sx, sz in sec:
            p = c + y * (sx * w * (1 + wob)) + z * (sz * h * (1 + wob))
            cr = noise.noise(p * 14 + off)  # the crackle of the char (as coarse as the vertices allow)
            crack = smoothstep(0.25, 0.05, abs(cr))
            under = smoothstep(0.1, -0.5, sz)
            col = base * (0.8 + 0.4 * noise.noise(p * 9 + off)) * (1 - 0.5 * crack)
            g = ember * crack * under
            col = col.lerp(COAL * 0.9, g)
            v = k.bm.verts.new(p)
            v[k.col] = (*col, g)
            ring.append(v)
        rings.append(ring)
    m = len(sec)
    for j in range(n):
        for i in range(m):
            k.bm.faces.new((rings[j][i], rings[j][(i + 1) % m], rings[j + 1][(i + 1) % m], rings[j + 1][i])).smooth = True
    # the ends: sawn, paler wood ringed darker, charred at the rim
    for j, ring in ((0, rings[0]), (n, rings[n])):
        c = sum((v.co for v in ring), V()) / m
        vs = []
        for v in ring:
            e = k.bm.verts.new(v.co)
            e[k.col] = (*(PINE * 0.5), 0.0)
            vs.append(e)
        mid = k.bm.verts.new(c)
        mid[k.col] = (*(PINE * 0.9), 0.0)
        for i in range(m):
            f = (vs[i], vs[(i + 1) % m], mid) if j else (vs[(i + 1) % m], vs[i], mid)
            k.bm.faces.new(f)


def kagaribi(level):
    far, near = level == '_far', level == '_near'
    k = Kit()
    rng = random.Random(7)
    seg = 5 if far else 10 if near else 7
    # three legs splayed on the ground, crossing under the basket
    for i in range(3):
        a = 2 * math.pi * i / 3
        c, s = math.cos(a), math.sin(a)
        k.cyl(IRON, V((c * 0.62, s * 0.62, -0.05)), V((-c * 0.16, -s * 0.16, 1.32)), 0.022, seg=seg)
    k.cyl(IRON, V((0, 0, 1.06)), V((0, 0, 1.11)), 0.1, seg=10, smooth=False)
    # the basket: rings of iron band, bars flaring out from its foot to its lip
    zb, zt, rb, rt = 1.22, 1.68, 0.15, 0.34
    for z, rr in ((zb, rb), ((zb + zt) / 2, (rb + rt) / 2), (zt, rt)):
        if far and z != zt:
            continue
        k.cyl(IRON, V((0, 0, z - 0.02)), V((0, 0, z + 0.02)), rr + 0.012, seg=12, smooth=False, cap=False)
        if near:  # its inner face (the band has thickness) and rivets where the bars cross it
            k.cyl(IRON * 0.7, V((0, 0, z + 0.02)), V((0, 0, z - 0.02)), rr + 0.004, seg=12, smooth=False, cap=False)
            for i in range(12):
                a = 2 * math.pi * i / 12
                q = V((math.cos(a), math.sin(a), 0))
                at = V((0, 0, z)) + q * (rr + 0.012 * math.cos(math.pi / 12))
                k.cyl(IRON * 1.3, at, at + q * 0.006, 0.007, seg=4, r2=0.003, smooth=False)
    nb = 6 if far else 12
    for i in range(nb):
        a = 2 * math.pi * i / nb
        c, s = math.cos(a), math.sin(a)
        k.cyl(IRON, V((c * rb, s * rb, zb)), V((c * rt, s * rt, zt + 0.04)), 0.011, seg=6 if near else 4)
    k.cyl(IRON, V((0, 0, zb - 0.03)), V((0, 0, zb)), rb, seg=10, smooth=False)
    # glowing coals in its foot, split pine stacked crosswise over them, charred, the odd fresh split face
    k.mesh([V((math.cos(2 * math.pi * i / 10) * rb * 1.2, math.sin(2 * math.pi * i / 10) * rb * 1.2, zb + 0.08 + rng.uniform(0, 0.03)))
            for i in range(10)] + [V((0, 0, zb + 0.13))], [(i, (i + 1) % 10, 10) for i in range(10)], COAL, glow=1.0)
    if near:
        # lumps of coal on the bed, some still glowing, some crusted with ash
        crng = random.Random(17)
        for i in range(26):
            a, d = crng.uniform(0, math.tau), rb * 1.1 * math.sqrt(crng.random())
            c = V((math.cos(a) * d, math.sin(a) * d, zb + 0.1 + crng.uniform(0, 0.04)))
            s = crng.uniform(0.012, 0.024)
            hot = crng.random()
            col = COAL.lerp(srgb('#5a5450'), smoothstep(0.55, 0.85, hot)) * (0.6 + 0.6 * crng.random())
            pts = [c + V((crng.uniform(0.7, 1.3) * s * x, crng.uniform(0.7, 1.3) * s * y, crng.uniform(0.5, 0.9) * s * z))
                   for x, y, z in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
            k.mesh(pts, [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)], col,
                   glow=lerp(1.0, 0.15, smoothstep(0.55, 0.85, hot)))
    lrng = random.Random(23)
    for layer in range(1 if far else 3):
        z = zb + 0.16 + layer * 0.11
        a0 = layer * math.pi / 3 + rng.uniform(-0.2, 0.2)
        for j in (-1, 0, 1):
            a = a0 + j * 0.05
            c, s = math.cos(a), math.sin(a)
            off = V((-s, c, 0)) * j * 0.08
            half = 0.16 + layer * 0.07
            p0 = V((c * half, s * half, z)) + off
            p1 = V((-c * half, -s * half, z + rng.uniform(-0.03, 0.05))) + off
            colour = CHAR if rng.random() < 0.75 else PINE
            if near:
                split_log(k, p0, p1, 0.06, 0.05, colour, lrng, (0.9, 0.5, 0.2)[layer])
            else:
                k.beam(colour, p0, p1, 0.06, 0.05)
    return finish(k, 'kagaribi' + level, 0.3)


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for level in ('', '_far', '_near'):
        for me in (post(level), bonbori(level), kagaribi(level)):
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
