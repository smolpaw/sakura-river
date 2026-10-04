# The wayside's stones by the lanes (src/wayside.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/wayside.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin at ground level, its front towards -y (Blender: z up; glTF:
# y up, so the front faces +z in the page), its footing sunk 0.3 m so it sits on sloping ground, with a lighter
# `<kind>_far` model:
# - jizo: a roku-jizō, six small stone Jizō (~0.7 m: a monk's round shaven head, a robe to the feet, hands together,
#   or a staff and a jewel) on lotus pedestals in a row on a stone plinth, under a little gabled shelter on four cedar
#   posts, roofed with cedar shingles (kokera) in overlapping courses (shingle_roof); each wears a red cloth bib (yodarekake) hanging in folds and a red knitted cap; cups
#   of tea and small stones left in front of them;
# - jizo1: one Jizō (~0.8 m) with bib and cap on a plinth, a stone vase of fresh flowers and a cup in front;
# - dohyo: a stone signpost (michishirube) ~1.2 m, a square pillar under a worn pyramid top, the way carved into two
#   faces (「右 寺」, 「左 村」, brush strokes cut in and inked black);
# - hokora: a roadside shrine ~1.05 m: two stacked stones, a little cedar shrine on them with closed lattice doors under
#   a copper-green gabled roof (crossed chigi at its gables, katsuogi on the ridge), a small vermilion torii in front,
#   sakaki branches in two white vases and two sake cups.
# Weathered granite: mottled, pale and yellow lichen on what faces the sky, moss low down and in the hollows. Shading
# in the vertex colours (ambient occlusion by ray casting); nothing glows (alpha 0).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import lerp, link, tris, evaluated, smoothstep
from village import Kit, srgb
from lamps import finish, stone_face, cedar

V = Vector
GRANITE = srgb('#8c877d')
LICHEN = srgb('#b9b99a')     # pale grey-green crust
LICHEN_Y = srgb('#c4b46a')   # yellow
MOSS = srgb('#4f5d27')
SOIL = srgb('#4a4136')
BIB = srgb('#d8301c')        # vermilion cloth
CAP = srgb('#c8281b')
CEDAR = srgb('#5c4636')
CEDAR_D = srgb('#2e231b')
CEDAR_G = srgb('#77716a')    # sun-greyed boards
COPPER = srgb('#5f917c')     # verdigris
COPPER_D = srgb('#3c5a4c')
SHU = srgb('#c23b22')
BLACK = srgb('#1c1a19')
PORCELAIN = srgb('#e8e4da')
TEA = srgb('#6b5a2a')
INK = srgb('#151211')
LEAF = srgb('#2c4720')
STEM = srgb('#4b4a2a')

LOTUS_H = 0.13  # the figure stands on its lotus this high


def emit(k, M, pts, faces, cols, smooth=True):
    """points (transformed by M) with colours, faces as index tuples"""
    vs = []
    for p, c in zip(pts, cols):
        v = k.bm.verts.new(M @ p)
        v[k.col] = (*c, 0.0)
        vs.append(v)
    for f in faces:
        try:
            k.bm.faces.new([vs[i] for i in f]).smooth = smooth
        except ValueError:
            pass
    return vs


def add_mesh(k, me, M, col):
    """mesh `me` transformed by M into the kit, smooth, coloured col(p, n) in the kit's frame"""
    me = me.copy()
    me.transform(M)
    k.add_mesh(me, lambda p, n: (col(p, n), 0.0))
    bpy.data.meshes.remove(me)


def granite(seed, base=GRANITE):
    """weathered granite col(p, n) in the model's frame (z up from the ground): mottled grain, pale and yellow lichen
    on what faces the sky, moss low down and on the tops' hollows, earth splashed on the foot"""
    off = V((seed * 1.7, seed * 3.1, seed * 0.7))

    def col(p, n):
        c = base * (0.84 + 0.2 * noise.noise(p * 7 + off) + 0.12 * noise.noise(p * 26 + off))
        up = smoothstep(-0.2, 0.8, n.z)
        c = c.lerp(LICHEN, 0.6 * smoothstep(0.25, 0.55, noise.noise(p * 6 + off * 2)) * up)
        c = c.lerp(LICHEN_Y, 0.45 * smoothstep(0.45, 0.7, noise.noise(p * 13 + off * 3)) * up)
        m = smoothstep(0.3, 0.75, noise.noise(p * 4 + off * 0.5) + 0.7 * smoothstep(0.35, 0.0, p.z) + 0.3 * smoothstep(0.5, 1.0, n.z))
        c = c.lerp(MOSS * (0.8 + 0.4 * noise.noise(p * 15 + off)), 0.7 * m)
        return c.lerp(SOIL, 0.6 * smoothstep(0.08, -0.05, p.z))
    return col


def decimate(me, target):
    ob = link(me, me.name)
    d = ob.modifiers.new('decimate', 'DECIMATE')
    d.ratio = min(1.0, target / max(1, tris(me)))
    d.use_collapse_triangulate = True
    return evaluated(ob)


# ---------- Jizō ----------
def solid(bm, kind, M, seg=16):
    """a closed primitive into bm: 'ball' (a unit sphere) or 'rod' (a unit cylinder along z, 0..1), through M"""
    if kind == 'ball':
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2 + 2, radius=1.0, matrix=M)
    else:
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=1.0, radius2=1.0, depth=1.0, matrix=M @ Matrix.Translation(V((0, 0, 0.5))))


def ellipsoid(bm, c, r):
    solid(bm, 'ball', Matrix.Translation(V(c)) @ Matrix.Diagonal(V((*r, 1.0))))


def capsule(bm, a, b, r):
    """a rod from a to b with round ends"""
    a, b = V(a), V(b)
    d = b - a
    rot = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    solid(bm, 'rod', Matrix.Translation(a) @ rot @ Matrix.Diagonal(V((r, r, d.length, 1.0))), 12)
    ellipsoid(bm, a, (r, r, r))
    ellipsoid(bm, b, (r, r, r))


def figure(seed, variant):
    """the stone figure from its feet (z 0) to the top of its head (~0.54): a monk in a robe to the feet, sleeves
    hanging wide, the big round shaven head with long ear lobes, a faint brow, nose and closed eyes; variant 0 hands
    together (gasshō), 1 a staff (shakujō) in the right hand and a jewel (hōju) in the left, 2 both hands holding the
    jewel. Primitives fused by a voxel remesh and smoothed, as a worn stone. Returns (mesh, staff ends or None)."""
    bm = bmesh.new()
    # the robe: a solid of revolution, oval in section, from the hem up over the sloping shoulders to the neck
    prof = [(0.0, 0.0), (0.082, 0.0), (0.086, 0.025), (0.083, 0.07), (0.079, 0.16), (0.08, 0.25), (0.082, 0.31),
            (0.078, 0.345), (0.062, 0.372), (0.04, 0.388), (0.03, 0.405), (0.0, 0.42)]
    seg = 20
    rings = []
    for r, z in prof:
        rings.append([bm.verts.new(V((math.cos(2 * math.pi * i / seg) * r, math.sin(2 * math.pi * i / seg) * r * 0.8 + 0.006, z))) for i in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for i in range(seg):
            bm.faces.new((a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i]))
    ellipsoid(bm, (0, 0, 0.466), (0.068, 0.07, 0.074))       # the head
    for s in (-1, 1):
        ellipsoid(bm, (s * 0.066, 0.006, 0.452), (0.012, 0.016, 0.03))  # the long ear lobes
        ellipsoid(bm, (s * 0.074, 0.008, 0.215), (0.03, 0.058, 0.115))  # the sleeves hanging at the sides
    ellipsoid(bm, (0, -0.064, 0.458), (0.011, 0.012, 0.016))   # the nose
    staff = None
    if variant == 0:
        for s in (-1, 1):
            capsule(bm, (s * 0.074, -0.01, 0.27), (s * 0.014, -0.08, 0.3), 0.024)
        ellipsoid(bm, (0, -0.086, 0.318), (0.02, 0.016, 0.042))
    elif variant == 1:
        capsule(bm, (-0.074, -0.01, 0.27), (-0.066, -0.078, 0.265), 0.024)  # the right hand down at the staff
        ellipsoid(bm, (-0.066, -0.084, 0.27), (0.02, 0.02, 0.026))
        capsule(bm, (0.074, -0.01, 0.27), (0.03, -0.08, 0.285), 0.024)     # the left hand at the chest
        ellipsoid(bm, (0.03, -0.096, 0.312), (0.02, 0.02, 0.024))           # the jewel on its palm
        staff = (V((-0.066, -0.086, -0.02)), V((-0.066, -0.086, 0.6)))
    else:
        for s in (-1, 1):
            capsule(bm, (s * 0.074, -0.01, 0.26), (s * 0.02, -0.08, 0.245), 0.024)
        ellipsoid(bm, (0, -0.086, 0.248), (0.036, 0.022, 0.018))
        ellipsoid(bm, (0, -0.094, 0.276), (0.021, 0.021, 0.023))
    me = bpy.data.meshes.new('fig')
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'fig')
    rm = ob.modifiers.new('remesh', 'REMESH')
    rm.mode, rm.voxel_size, rm.adaptivity = 'VOXEL', 0.004, 0.0
    sm = ob.modifiers.new('smooth', 'SMOOTH')
    sm.factor, sm.iterations = 0.6, 4
    out = evaluated(ob)
    bpy.data.meshes.remove(me)
    # folds in the robe falling from the shoulders, wider towards the hem; the closed eyes pressed in under the brow
    bm = bmesh.new()
    bm.from_mesh(out)
    bm.normal_update()
    off = V((seed * 2.3, seed * 0.7, 0))
    for v in bm.verts:
        p = v.co
        if p.z < 0.36 and not (p.y < -0.05 and p.z > 0.2):
            a = math.atan2(p.x, -p.y)
            g = noise.noise(V((a * 2.4, p.z * 2.5, 0)) + off)
            v.co -= v.normal * 0.0045 * smoothstep(0.1, 0.5, abs(g)) * smoothstep(0.36, 0.22, p.z)
        for s in (-1, 1):
            e = math.hypot((p.x - s * 0.026) / 0.018, (p.z - 0.47) / 0.006)
            if e < 1.5 and p.y < -0.04:
                v.co.y += 0.003 * smoothstep(1.5, 0.5, e)
    bm.to_mesh(out)
    bm.free()
    return out, staff


def lathe(k, M, prof, seg, col, petals=0):
    """a solid of revolution about z from prof [(r, z, lobe)] (bottom to top, both ends closed): each row's radius
    swelling into `petals` pointed lobes by its lobe weight"""
    pts, cols, faces = [], [], []
    for r, z, lobe in prof:
        for i in range(seg):
            a = 2 * math.pi * i / seg
            w = abs(math.cos(a * petals / 2)) ** 3 if petals else 0
            rr = r * (1 + 0.13 * lobe * w)
            p = V((math.cos(a) * rr, math.sin(a) * rr, z))
            pts.append(p)
    n = len(prof)
    for j in range(n - 1):
        for i in range(seg):
            faces.append((j * seg + i, j * seg + (i + 1) % seg, (j + 1) * seg + (i + 1) % seg, (j + 1) * seg + i))
    faces.append(tuple(reversed(range(seg))))
    faces.append(tuple(range((n - 1) * seg, n * seg)))
    for p in pts:
        n_ = V((p.x, p.y, 0.3)).normalized()
        cols.append(col(M @ p, n_))
    emit(k, M, pts, faces, cols)


def lotus(k, M, col, far):
    """the pedestal: a round foot, a waist, and a ring of lotus petals turned up round the figure's feet"""
    prof = [(0.13, 0.0, 0), (0.135, 0.028, 0), (0.12, 0.04, 0), (0.098, 0.05, 0), (0.104, 0.06, 0.2),
            (0.128, 0.085, 1), (0.145, 0.106, 1), (0.134, 0.12, 0.7), (0.1, LOTUS_H, 0)]
    if far:
        prof = [prof[0], prof[6], prof[8]]
    else:
        prof = prof[:2] + prof[3:]
    lathe(k, M, prof, 6 if far else 16, col, 0 if far else 8)


def bib(k, M, bvh, seed, far, bottom):
    """the red cloth bib (yodarekake) tied round the neck, hanging over the chest and whatever is in front of it in
    folds fanning out from the ties, its hem waving; a thin cloth (front and back), the tie round the neck"""
    rng = random.Random(seed)
    nu, nv = (3, 1) if far else (10, 6)
    zt = 0.398
    ph = rng.uniform(0, 6.28)
    fade = rng.uniform(0.0, 0.25)  # some bibs faded by the sun
    D, Z, RB = [], [], []
    for i in range(nu + 1):
        t = -1 + 2 * i / nu
        D.append([]), Z.append([]), RB.append([])
        for j in range(nv + 1):
            v = j / nv
            phi = t * math.radians(lerp(98, 64, v ** 0.7))
            z = lerp(zt + 0.006 * t * t, bottom + 0.05 * t * t, v)
            if j == nv and not far:
                z += 0.005 * math.sin(t * 9 + ph)
            d = V((math.sin(phi), -math.cos(phi), 0))
            hit = bvh.ray_cast(V((0, 0, z)) + d * 0.3, -d, 0.35)[0]
            D[i].append(d), Z[i].append(z), RB[i].append(V((hit.x, hit.y, 0)).length if hit else 0.06)
    # the cloth's distance from the axis: clear of the body, hanging down from what it lies on rather than following
    # the body back in, and stretched across the hollows between the hands and the sleeves rather than into them
    R = [[rb + 0.007 for rb in col] for col in RB]
    for _ in range(4):
        for i in range(nu + 1):
            for j in range(1, nv + 1):
                R[i][j] = max(R[i][j], R[i][j - 1] - 0.003)
        R = [[max(R[i][j], 0.5 * (R[max(0, i - 1)][j] + R[min(nu, i + 1)][j])) for j in range(nv + 1)] for i in range(nu + 1)]
    grid = []
    for i in range(nu + 1):
        t = -1 + 2 * i / nu
        col_ = []
        for j in range(nv + 1):
            v = j / nv
            fold = 0.0 if far else math.sin(t * math.pi * 2.6 + ph + 0.6 * math.sin(v * 3)) * (0.0015 + 0.0075 * v)
            col_.append((D[i][j], Z[i][j], max(R[i][j] + fold, RB[i][j] + 0.005) - fold, fold))
        grid.append(col_)
    pts, cols = [], []
    for i in range(nu + 1):
        for j in range(nv + 1):
            d, z, r, fold = grid[i][j]
            pts.append(V((0, 0, z)) + d * (r + fold))
            crest = fold / (0.0015 + 0.0075 * (j / nv)) if not far else 0.0
            c = BIB * (0.9 + 0.22 * crest) * (0.92 + 0.12 * noise.noise(V((i * 0.7, j * 0.9, seed))))
            c = c.lerp(srgb('#e0705a'), fade * (0.6 + 0.4 * (1 - j / nv)))
            cols.append(c)
    for i in range(nu + 1):  # the back of the cloth, a little inside
        for j in range(nv + 1):
            d, z, r, fold = grid[i][j]
            pts.append(V((0, 0, z)) + d * (r + fold - 0.003))
            cols.append(BIB * 0.45)
    N = (nu + 1) * (nv + 1)
    at = lambda i, j: i * (nv + 1) + j
    faces = []
    for i in range(nu):
        for j in range(nv):
            q = (at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j))
            faces.append(q)
            faces.append(tuple(N + x for x in reversed(q)))
    # the edges between front and back
    rim = [at(0, j) for j in range(nv + 1)] + [at(i, nv) for i in range(1, nu + 1)] + [at(nu, j) for j in range(nv - 1, -1, -1)] + [at(i, 0) for i in range(nu - 1, 0, -1)]
    for a, b in zip(rim, rim[1:] + rim[:1]):
        faces.append((b, a, N + a, N + b))
    emit(k, M, pts, faces, cols)
    # the tie round the back of the neck
    seg = 6 if far else 14
    ring = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        d = V((math.sin(a), -math.cos(a), 0))
        hit = bvh.ray_cast(V((0, 0, zt + 0.004)) + d * 0.3, -d, 0.35)[0]
        ring.append(((V((hit.x, hit.y, 0)).length if hit else 0.04) + 0.004, d))
    pts = [V((0, 0, zt + dz)) + d * r for dz in (-0.005, 0.006) for r, d in ring]
    faces = [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)]
    emit(k, M, pts, faces, [BIB * 0.8] * len(pts))


def cap(k, M, bvh, seed, far):
    """the red knitted cap pulled over the head: thick, a little peaked, ribbed, its brim rolled up; lower at the
    back"""
    c0 = V((0, 0, 0.466))
    na, nr = (6, 2) if far else (20, 5)
    pts, cols = [], []
    rows = []
    for j in range(nr + 1):
        row = []
        for i in range(na):
            az = 2 * math.pi * i / na
            back = 0.5 - 0.5 * math.cos(az)  # 0 at the front (-y), 1 at the back
            edge = math.radians(lerp(74, 108, back))
            a = edge * j / nr
            d = V((math.sin(a) * math.sin(az), -math.sin(a) * math.cos(az), math.cos(a)))
            hit = bvh.ray_cast(c0 + d * 0.3, -d, 0.35)[0]
            r = (hit - c0).length if hit else 0.072
            r += 0.008 + 0.008 * (1 - j / nr) ** 2  # its knit's thickness and the peak
            if j >= nr - 1:
                r += 0.004 if j == nr - 1 else 0.007  # the rolled brim
            pts.append(c0 + d * r)
            rib = 1.0 if far else (1.1 if i % 2 else 0.86)
            cols.append(CAP * rib * (0.95 if j < nr - 1 else 0.82))
            row.append(len(pts) - 1)
        rows.append(row)
    # the brim's inside, back into the head
    inner = []
    for i in range(na):
        az = 2 * math.pi * i / na
        back = 0.5 - 0.5 * math.cos(az)
        a = math.radians(lerp(74, 108, back)) - 0.14
        d = V((math.sin(a) * math.sin(az), -math.sin(a) * math.cos(az), math.cos(a)))
        hit = bvh.ray_cast(c0 + d * 0.3, -d, 0.35)[0]
        pts.append(c0 + d * (((hit - c0).length if hit else 0.072) - 0.004))
        cols.append(CAP * 0.5)
        inner.append(len(pts) - 1)
    top = len(pts)
    pts.append(c0 + V((0, 0, 0.074 + 0.016)))
    cols.append(CAP * 0.95)
    faces = [(rows[0][i], rows[0][(i + 1) % na], top) for i in range(na)]
    for j in range(nr):
        for i in range(na):
            faces.append((rows[j][i], rows[j + 1][i], rows[j + 1][(i + 1) % na], rows[j][(i + 1) % na]))
    for i in range(na):
        faces.append((rows[nr][i], inner[i], inner[(i + 1) % na], rows[nr][(i + 1) % na]))
    emit(k, M, pts, faces, cols)


def jizo_statue(k, M, seed, variant, far, bottom=0.27):
    """one Jizō on its lotus, standing on M's origin"""
    col = granite(seed)
    lotus(k, M, col, far)
    me, staff = figure(seed, variant)
    bm = bmesh.new()
    bm.from_mesh(me)
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    lowres = decimate(me.copy(), 40 if far else 520)
    Mf = M @ Matrix.Translation(V((0, 0, LOTUS_H)))
    add_mesh(k, lowres, Mf, col)
    bpy.data.meshes.remove(lowres)
    bib(k, Mf, bvh, seed, far, bottom)
    cap(k, Mf, bvh, seed, far)
    if staff and not far:
        a, b = staff
        k.cyl(srgb('#5a5850'), Mf @ a, Mf @ b, 0.007, seg=6)
        # its head: a loop with rings hanging on it
        top = b + V((0, 0, 0.035))
        loop = [b + V((math.sin(t) * 0.024, 0, 0.022 - math.cos(t) * 0.022 + 0.012)) for t in (math.pi * 2 * i / 10 for i in range(11))]
        for p, q in zip(loop, loop[1:]):
            k.cyl(srgb('#4a4a44'), Mf @ p, Mf @ q, 0.004, seg=4)
        for s in (-1, 1):
            k.cyl(srgb('#4a4a44'), Mf @ (b + V((s * 0.022, 0, 0.02))), Mf @ (b + V((s * 0.026, 0, 0.0))), 0.006, seg=5)
        k.cyl(srgb('#4a4a44'), Mf @ top, Mf @ (top + V((0, 0, 0.012))), 0.006, seg=5, r2=0.002)
    bpy.data.meshes.remove(me)


def cup(k, at, r=0.022, h=0.035, tea=True):
    k.cyl(PORCELAIN, at, at + V((0, 0, h)), r * 0.8, seg=10, r2=r, smooth=True)
    if tea:
        k.cyl(TEA, at + V((0, 0, h - 0.008)), at + V((0, 0, h - 0.006)), r * 0.96, seg=10, smooth=False)


def pebbles(k, at, rng, n):
    for i in range(n):
        p = at + V((rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), 0.012 + i * 0.012))
        s = rng.uniform(0.012, 0.02)
        c = GRANITE * rng.uniform(0.7, 1.15)
        k.mesh([p + V((x * s * rng.uniform(0.8, 1.3), y * s * rng.uniform(0.8, 1.3), z * s * 0.7)) for x, y, z in
                ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))],
               [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)], c, smooth=True)


def board(k, o, eu, ev, nu, nv, col, thick, under=0.55):
    """a board: its top the grid o + eu*u + ev*v (u, v 0..1 over nu x nv cells; eu x ev points out of it) coloured
    col(p, u, v), its underside `thick` behind, darker, the edges closed"""
    n = eu.cross(ev).normalized()
    top = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            p = o + eu * (i / nu) + ev * (j / nv)
            v = k.bm.verts.new(p)
            v[k.col] = (*col(p, i / nu, j / nv), 0.0)
            row.append(v)
        top.append(row)
    for j in range(nv):
        for i in range(nu):
            k.bm.faces.new((top[j][i], top[j][i + 1], top[j + 1][i + 1], top[j + 1][i]))
    rim = [top[0][i] for i in range(nu + 1)] + [top[j][nu] for j in range(1, nv + 1)] + [top[nv][i] for i in range(nu - 1, -1, -1)] + [top[j][0] for j in range(nv - 1, 0, -1)]
    low = []
    for v in rim:
        w = k.bm.verts.new(v.co - n * thick)
        c = v[k.col]
        w[k.col] = (c[0] * under, c[1] * under, c[2] * under, 0.0)
        low.append(w)
    m = len(rim)
    for i in range(m):
        k.bm.faces.new((rim[(i + 1) % m], rim[i], low[i], low[(i + 1) % m]))
    k.bm.faces.new(list(reversed(low)))


def boards(seed, nb, base, moss_at=None):
    """weathered cedar boards running along v: each its own shade, a dark seam between, greyed by the sun, moss
    creeping in from the lower edge (v 0)"""
    rng = random.Random(seed)
    shades = [rng.uniform(0.8, 1.2) for _ in range(nb)]
    off = V((seed * 1.3, seed * 2.1, 0))

    def col(p, u, v):
        b = u * nb + 1e-6
        seam = smoothstep(0.38, 0.48, abs(b % 1 - 0.5))
        c = base * shades[min(nb - 1, int(b))] * (1 - 0.45 * seam) * (0.9 + 0.2 * noise.noise(V((b * 0.7, v * 4, 0)) + off))
        c = c.lerp(CEDAR_G, 0.35 * smoothstep(0.0, 0.5, noise.noise(V((u * 3, v * 2, 1)) + off)))
        m = smoothstep(0.35, 0.0, v) * smoothstep(0.0, 0.4, noise.noise(V((u * 9, v * 5, 2)) + off) + 0.2)
        return c.lerp(MOSS * 0.9, 0.6 * m)
    return col


SHINGLE = srgb('#9a8a74')    # sun-greyed cedar shingles
SILVER = srgb('#a29e95')     # ... silvered where the weather has bleached them
POST = srgb('#7f6e5b')       # the shelter's weathered posts


def shingle_roof(k, RZ, EZ, EY, L, rng, courses=8):
    """a gabled roof of kokera: thin cedar shingles of differing widths in overlapping courses up each slope (ridge RZ
    up, eaves EZ up and EY out front and back, L either side), each course's butt standing proud of the one below it
    and the joints staggered; the eaves' edge thicker, the boards' ends layered in it; a board under them all (seen
    from below and at the gables), a cap and a beam along the ridge, barge boards up the gables. Each shingle its own
    shade, bleached in places, moss on the lower courses and along the butts where the rain lingers."""
    off = V((rng.uniform(0, 50), rng.uniform(0, 50), 0))
    H = RZ - EZ
    slope = math.hypot(EY, H)
    T, T0, UNDER = 0.022, 0.05, 0.025  # a course's butt, the eaves' edge (proud of the board under them), that board
    for side in (-1, 1):
        n = V((0, -side * H, EY)) / slope  # out of the slope

        def at(x, s, lift):
            return V((x, -side * EY * (1 - s), EZ + H * s)) + n * lift
        # the board under the shingles: its top on the slope's plane
        board(k, at(-L * side, 0, 0), V((2 * L * side, 0, 0)), at(0, 1, 0) - at(0, 0, 0), 4, 1, lambda p, u, v: CEDAR_D * 1.3, UNDER)
        for c in range(courses):
            s0, s1 = c / courses, (c + 1) / courses
            t = T0 if c == 0 else T
            x = -L - rng.uniform(0.0, 0.12)
            while x < L:
                w = rng.uniform(0.1, 0.19)
                xa, xb = max(x, -L) + 0.003, min(x + w, L) - 0.003
                x += w
                if xb - xa < 0.02:
                    continue
                mid = V(((xa + xb) / 2, s0, 0))
                shade = rng.uniform(0.78, 1.18)
                bleach = smoothstep(-0.2, 0.5, noise.noise(V((mid.x * 0.9, s0 * 1.6, 1.0)) + off) + rng.uniform(-0.25, 0.25))
                moss = smoothstep(0.0, 0.45, noise.noise(V((mid.x * 1.4, s0 * 2.8, 2.0)) + off) + 0.45 * (1 - s0) - 0.1) * (0.4 + 0.6 * (1 - s0))
                base = (SHINGLE * shade).lerp(SILVER, 0.45 * bleach)

                def col(m, dark=1.0):
                    return (base * dark).lerp(MOSS * rng.uniform(0.75, 1.1), min(0.8, m))
                # its face, from the butt up to where the next course covers it; the butt's end below
                pts = [at(xa, s0, t), at(xb, s0, t), at(xb, s1, 0.0), at(xa, s1, 0.0)]
                cols = [col(0.7 * moss + 0.15), col(0.7 * moss + 0.15), col(0.4 * moss, 0.85), col(0.4 * moss, 0.85)]
                faces = [(0, 1, 2, 3)]
                if c == 0:
                    # the eaves' edge: the butts of the courses laid double there, and the board under them
                    for l0, l1, d in ((t, t * 0.5, 0.62), (t * 0.5, 0.0, 0.48)):
                        b = len(pts)
                        pts += [at(xa, s0, l0), at(xb, s0, l0), at(xb, s0, l1), at(xa, s0, l1)]
                        cols += [col(0.5 * moss, d)] * 4
                        faces.append((b + 3, b + 2, b + 1, b))
                else:
                    pts += [at(xa, s0, 0.0), at(xb, s0, 0.0)]
                    cols += [col(0.8 * moss + 0.1, 0.6)] * 2
                    faces.append((4, 5, 1, 0))
                if side < 0:
                    faces = [tuple(reversed(f)) for f in faces]
                emit(k, Matrix(), pts, faces, cols, smooth=False)
        # the ridge cap: a board down each side from the ridge over the top course
        o = at(-L * side - 0.03 * side, 0.84, 0.035)
        board(k, o, V((2 * (L + 0.03) * side, 0, 0)), at(0, 1.0, 0.035) - at(0, 0.84, 0.035) + V((0, 0, 0.012)), 6, 1,
              boards(47 + side, 6, SHINGLE * 0.82), 0.025)
        # barge boards up the gables
        for sx in (-1, 1):
            k.beam(CEDAR_D * 1.4, at(sx * (L + 0.018), -0.02, 0.01), at(sx * (L + 0.018), 1.0, 0.01) + V((0, 0, 0.03)),
                   0.03, 0.1, up=n)
    k.box(CEDAR_D * 1.2, (2 * L + 0.1, 0.07, 0.06), V((0, 0, RZ + 0.07)))  # the beam along the ridge


def roku_jizo(level):
    far = level == '_far'
    k = Kit()
    rng = random.Random(41)
    PT = 0.24  # the plinth's top
    if far:
        k.box(GRANITE * 0.95, (3.05, 0.62, 0.54), V((0, 0, PT - 0.27)))
    else:
        col, disp = stone_face(41, 0.12, chips=0.02)
        k.lattice_box((3.05, 0.62, 0.54), V((0, 0, PT - 0.27)), (16, 4, 4), col, disp, skip=('-z',))
    variants = [1, 0, 2, 0, 1, 2]
    for i in range(6):
        x = -1.25 + 0.5 * i
        s = rng.uniform(0.95, 1.05)
        M = Matrix.Translation(V((x, 0.04, PT))) @ Matrix.Rotation(rng.uniform(-0.1, 0.1), 4, 'Z') @ Matrix.Scale(s, 4)
        jizo_statue(k, M, 100 + i, variants[i], far, bottom=rng.uniform(0.26, 0.3))
        if not far:
            if i % 2 == 0:
                cup(k, V((x + rng.uniform(-0.05, 0.05), -0.2, PT)))
            else:
                pebbles(k, V((x + rng.uniform(-0.06, 0.06), -0.21, PT)), rng, rng.randint(2, 4))
    # the shelter: four cedar posts on footing stones, plates and tie beams, a gabled roof of boards
    X, Y, EH = 1.62, 0.4, 1.48
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.box(POST, (0.075, 0.075, EH + 0.3), V((sx * X, sy * Y, (EH - 0.3) / 2)), rz=0.0)
            if not far:
                k.box(GRANITE * 0.9, (0.17, 0.17, 0.12), V((sx * X, sy * Y, 0.0)))
    for sy in (-1, 1):
        k.box(POST * 0.7, (2 * X + 0.25, 0.07, 0.08), V((0, sy * Y, EH)))
    for sx in (-1, 1):
        k.box(POST * 0.7, (0.07, 2 * Y + 0.1, 0.08), V((sx * X, 0, EH)))
        k.box(POST * 0.7, (0.06, 0.06, 0.36), V((sx * X, 0, EH + 0.2)))
    RZ, EZ, EY, L = 1.9, 1.44, 0.8, 1.9  # (src/wayside.js waysideRoofs casts this roof into the valley's shadow map)
    k.box(CEDAR_D, (2 * L, 0.08, 0.08), V((0, 0, RZ - 0.06)))
    if far:
        for side in (-1, 1):
            o = V((-L * side, side * -EY, EZ))
            eu, ev = V((2 * L * side, 0, 0)), V((0, side * EY, RZ - EZ))
            board(k, o, eu, ev, 3, 1, boards(43 + side, 3, SHINGLE * 0.9), 0.06)
        k.box(CEDAR_D * 0.8, (2 * L + 0.04, 0.14, 0.05), V((0, 0, RZ + 0.01)))  # the ridge
    else:
        shingle_roof(k, RZ, EZ, EY, L, rng)
    return finish(k, 'jizo' + level, 0.6)


def jizo_one(level):
    far = level == '_far'
    k = Kit()
    rng = random.Random(77)
    PT = 0.28
    if far:
        k.box(GRANITE * 0.95, (0.5, 0.58, PT + 0.3), V((0, 0, (PT - 0.3) / 2)))
    else:
        col, disp = stone_face(77, 0.08, chips=0.018)
        k.lattice_box((0.5, 0.58, PT + 0.3), V((0, 0, (PT - 0.3) / 2)), (6, 7, 6), col, disp, skip=('-z',))
    M = Matrix.Translation(V((0, 0.06, PT))) @ Matrix.Scale(1.17, 4)
    jizo_statue(k, M, 207, 1, far, bottom=0.28)
    if not far:
        # a stone vase of fresh flowers at the front corner, a cup of water at the other
        va = V((0.17, -0.2, PT))
        k.cyl(GRANITE * 0.85, va, va + V((0, 0, 0.12)), 0.035, seg=10, r2=0.042)
        k.cyl(BLACK, va + V((0, 0, 0.118)), va + V((0, 0, 0.121)), 0.034, seg=10, smooth=False)
        flowers = [(srgb('#f0c82a'), 0.02), (srgb('#f4f0e2'), 0.019), (srgb('#d8325a'), 0.016), (srgb('#f0c82a'), 0.017), (srgb('#b07ad0'), 0.015)]
        for j, (fc, fr) in enumerate(flowers):
            a = 2 * math.pi * j / len(flowers) + 0.3
            tip = va + V((math.cos(a) * 0.05, math.sin(a) * 0.05 - 0.01, 0.2 + rng.uniform(-0.03, 0.04)))
            k.cyl(STEM, va + V((0, 0, 0.1)), tip, 0.003, seg=4)
            # the bloom: a ball of petals, a leaf below it
            k.mesh([tip + V((x * fr, y * fr, z * fr * 0.7)) for x, y, z in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))],
                   [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)], fc, smooth=True)
            lp = va + V((0, 0, 0.1)).lerp(tip - va, 0.55)
            d = V((math.cos(a), math.sin(a), 0.4)).normalized() * 0.035
            side = V((-math.sin(a), math.cos(a), 0)) * 0.012
            k.mesh([lp, lp + d * 0.5 + side, lp + d, lp + d * 0.5 - side], [(0, 1, 2, 3), (3, 2, 1, 0)], LEAF)
        cup(k, V((-0.16, -0.21, PT)), tea=False)
        pebbles(k, V((-0.05, -0.24, PT)), rng, 3)
    return finish(k, 'jizo1' + level, 0.4)


# ---------- the signpost ----------
# brush strokes in a character's box (u right, v down, 0..1), each a polyline
GLYPHS = {
    '右': [[(0.52, 0.04), (0.44, 0.34), (0.1, 0.84)], [(0.08, 0.3), (0.92, 0.27)],
          [(0.36, 0.52), (0.36, 0.96)], [(0.36, 0.52), (0.84, 0.52), (0.84, 0.96)], [(0.36, 0.92), (0.84, 0.92)]],
    '寺': [[(0.24, 0.13), (0.76, 0.12)], [(0.5, 0.02), (0.5, 0.38)], [(0.08, 0.38), (0.92, 0.37)],
          [(0.08, 0.58), (0.92, 0.57)], [(0.66, 0.45), (0.66, 0.94), (0.54, 0.88)], [(0.27, 0.65), (0.4, 0.8)]],
    '左': [[(0.08, 0.28), (0.92, 0.27)], [(0.44, 0.04), (0.36, 0.4), (0.08, 0.9)],
          [(0.4, 0.56), (0.86, 0.55)], [(0.63, 0.56), (0.63, 0.9)], [(0.3, 0.9), (0.95, 0.89)]],
    '村': [[(0.02, 0.3), (0.42, 0.29)], [(0.22, 0.04), (0.22, 0.97)], [(0.21, 0.33), (0.04, 0.72)], [(0.24, 0.42), (0.4, 0.58)],
          [(0.48, 0.33), (0.98, 0.32)], [(0.82, 0.04), (0.82, 0.92), (0.71, 0.85)], [(0.58, 0.5), (0.68, 0.65)]],
}


def stroke_cutter(a, b, w0, w1, depth):
    """a capsule from a to b (points in the face's plane, metres; the face's outward normal +z here) w0 wide at a and
    w1 at b, as a closed prism from depth below the face to above it"""
    d = (b - a).normalized()
    n = V((-d.y, d.x, 0))
    outline = []
    for i in range(5):  # round ends
        t = math.pi * i / 4
        outline.append(b + (-n * math.cos(t) + d * math.sin(t)) * (w1 / 2))
    for i in range(5):
        t = math.pi * i / 4
        outline.append(a + (n * math.cos(t) - d * math.sin(t)) * (w0 / 2))
    bm = bmesh.new()
    lo = [bm.verts.new(V((p.x, p.y, -depth))) for p in outline]
    hi = [bm.verts.new(V((p.x, p.y, 0.02))) for p in outline]
    m = len(outline)
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    for i in range(m):
        bm.faces.new((lo[i], lo[(i + 1) % m], hi[(i + 1) % m], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('cut')
    bm.to_mesh(me)
    bm.free()
    return me


def dohyo(level):
    far = level == '_far'
    h, top = 0.095, 1.1
    bm = bmesh.new()
    # a square pillar in rings (so the stone's mottling has vertices to sit on) under a worn pyramid top
    m = 1 if far else 4
    zs = [-0.3, top] if far else [-0.3] + [i * 0.05 for i in range(0, 23)]
    caps = [(top + 0.025, 0.9), (top + 0.06, 0.55), (top + 0.085, 0.18)]
    rings = []

    def square(z, hh):
        out = []
        for side in range(4):
            for i in range(m):
                t = -1 + 2 * i / m
                x, y = [(t, -1), (1, t), (-t, 1), (-1, -t)][side]
                out.append(bm.verts.new(V((x * hh, y * hh, z))))
        return out
    for z in zs:
        rings.append(square(z, h))
    for z, s in caps:
        rings.append(square(z, h * s))
    n = 4 * m
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    me = bpy.data.meshes.new('dohyo_raw')
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'dohyo_raw')
    cutters = []
    if not far:
        # the inscriptions: two characters down the front (-y) and down the left side (-x) as seen from the front
        S, W, D = 0.135, 0.017, 0.006
        faces = [('右寺', Matrix(((1, 0, 0, 0), (0, 0, -1, -h), (0, 1, 0, 0), (0, 0, 0, 1)))),   # face x = u, z = -v, out -y
                 ('左村', Matrix(((0, 0, -1, -h), (-1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))]  # face -y = u, out -x
        for text, F in faces:
            for c, ch in enumerate(text):
                z0 = 1.035 - c * (S + 0.05)
                for line in GLYPHS[ch]:
                    pts = [V(((u - 0.5) * S, z0 - v * S, 0)) for u, v in line]
                    for j, (a, b) in enumerate(zip(pts, pts[1:])):
                        # the brush pressed down at the stroke's start, lifting off at its end
                        cm = stroke_cutter(a, b, W * (1.1 if j == 0 else 0.95), W * (0.7 if j == len(pts) - 2 else 0.95), D)
                        # into the pillar's face: x along u, y up the pillar, z out of the face
                        cm.transform(F)
                        co = link(cm, 'cutter')
                        cutters.append(co)
                        mod = ob.modifiers.new('cut', 'BOOLEAN')
                        mod.operation = 'DIFFERENCE'
                        mod.solver = 'EXACT'
                        mod.object = co
    me = evaluated(ob)
    for co in cutters:
        cm = co.data
        bpy.data.objects.remove(co)
        bpy.data.meshes.remove(cm)
    k = Kit()
    col = granite(91, GRANITE * 1.05)
    off = V((3.1, 7.7, 1.3))

    def colour(p, nrm):
        c = col(p, nrm)
        # rain streaks down the faces, the top darkened and crusted
        c *= 1 - 0.18 * smoothstep(0.2, 0.6, noise.noise(V((p.x * 9 + p.y * 9, p.z * 0.8, 0)) + off))
        inset = h - max(abs(p.x), abs(p.y)) if p.z < top else 0.0
        return c.lerp(INK, 0.95 * smoothstep(0.0015, 0.005, inset))
    k.add_mesh(me, lambda p, nrm: (colour(p, nrm), 0.0))
    for f in k.bm.faces:
        f.smooth = False
    bpy.data.meshes.remove(me)
    return finish(k, 'dohyo' + level, 0.3)


# ---------- the roadside shrine ----------
def hokora(level):
    far = level == '_far'
    k = Kit()
    rng = random.Random(55)
    # two stacked stones
    if far:
        k.box(GRANITE * 0.95, (0.62, 0.52, 0.6), V((0, 0, 0.0)))
        k.box(GRANITE, (0.52, 0.44, 0.18), V((0, 0, 0.39)))
    else:
        col, disp = stone_face(55, 0.1, chips=0.02)
        k.lattice_box((0.62, 0.52, 0.6), V((0, 0, 0.0)), (6, 5, 6), col, disp, skip=('-z',))
        col, disp = stone_face(56, 0.08, chips=0.012)
        k.lattice_box((0.52, 0.44, 0.18), V((0, 0, 0.39)), (6, 5, 2), col, disp, skip=('-z',))
    B = 0.48  # the shrine's sill
    k.box(CEDAR_D, (0.44, 0.38, 0.03), V((0, 0, B + 0.015)))
    if far:
        k.box(CEDAR, (0.36, 0.3, 0.31), V((0, 0.0, B + 0.03 + 0.155)))
    else:
        col, disp = cedar(57, 0.03)
        k.lattice_box((0.36, 0.3, 0.31), V((0, 0.0, B + 0.03 + 0.155)), (8, 6, 6), lambda p, n: col(p, n) * 1.4, None)
        for sx in (-1, 1):
            for sy in (-1, 1):
                k.box(CEDAR_D, (0.032, 0.032, 0.32), V((sx * 0.18, sy * 0.15, B + 0.19)))
        # the closed doors: two panels of vertical lattice over dark boards, a black fitting where they meet
        for sx in (-1, 1):
            cx = sx * 0.078
            k.box(CEDAR_D, (0.145, 0.01, 0.24), V((cx, -0.153, B + 0.17)))
            for j in range(4):
                k.box(CEDAR * 1.5, (0.008, 0.008, 0.24), V((cx - 0.054 + j * 0.036, -0.16, B + 0.17)))
            for z in (0.06, 0.28):
                k.box(CEDAR * 1.5, (0.15, 0.01, 0.014), V((cx, -0.162, B + z)))
        k.box(BLACK, (0.02, 0.008, 0.04), V((0, -0.168, B + 0.17)))
        k.box(CEDAR_D, (0.44, 0.08, 0.02), V((0, -0.21, B + 0.035)))  # the step board in front
    # the copper roof: two slopes over the front and back, the ridge along x
    RZ, EZ, EY, L = B + 0.47, B + 0.33, 0.29, 0.29
    off = V((5.5, 1.2, 0))

    def copper(p, u, v):
        c = COPPER * (0.85 + 0.25 * noise.noise(V((u * 6, v * 3, 0)) + off))
        c = c.lerp(COPPER_D, 0.5 * smoothstep(0.1, 0.6, noise.noise(V((u * 14, v * 1.2, 1)) + off)))  # streaks down the slope
        return c * (0.9 + 0.1 * (int(u * 12) % 2))  # the seams of its sheets
    for side in (-1, 1):
        o = V((-L * side, side * -EY, EZ))
        board(k, o, V((2 * L * side, 0, 0)), V((0, side * EY, RZ - EZ)), 2 if far else 12, 1 if far else 3, copper, 0.022)
    k.box(COPPER_D, (2 * L + 0.02, 0.05, 0.035), V((0, 0, RZ + 0.012)))
    if not far:
        # chigi: the gables' boards crossed above the ridge; katsuogi: short logs across the ridge
        for sx in (-1, 1):
            for side in (-1, 1):
                a = V((sx * (L - 0.01), side * -0.06, RZ - 0.06))
                b = V((sx * (L - 0.01), side * 0.06, RZ + 0.07))
                k.beam(COPPER_D, a, b, 0.012, 0.03, up=V((1, 0, 0)))
        for x in (-0.12, 0.0, 0.12):
            k.cyl(COPPER_D, V((x, -0.04, RZ + 0.04)), V((x, 0.04, RZ + 0.04)), 0.013, seg=8)
        # the small torii in front, on the ground
        ty, H = -0.42, 0.56
        for sx in (-1, 1):
            k.cyl(SHU, V((sx * 0.11, ty, -0.05)), V((sx * 0.104, ty, H)), 0.015, seg=8)
        k.box(SHU, (0.3, 0.02, 0.022), V((0, ty, H - 0.09)))
        k.box(SHU, (0.3, 0.026, 0.018), V((0, ty, H - 0.008)))
        pts = [V((x, ty, H + 0.014 + 0.014 * abs(x / 0.18) ** 3)) for x in (-0.18, -0.09, 0.0, 0.09, 0.18)]
        for a, b in zip(pts, pts[1:]):
            k.beam(BLACK, a, b, 0.03, 0.016)
        # sakaki in two white vases at the front corners, two sake cups before the doors
        for sx in (-1, 1):
            va = V((sx * 0.21, -0.17, 0.48))
            k.cyl(PORCELAIN, va, va + V((0, 0, 0.07)), 0.015, seg=8, r2=0.02)
            for j in range(3):
                a = rng.uniform(0, math.tau)
                tip = va + V((math.cos(a) * 0.04, math.sin(a) * 0.03, 0.2 + rng.uniform(-0.03, 0.03)))
                k.cyl(STEM, va + V((0, 0, 0.06)), tip, 0.0025, seg=3)
                for q in range(6):
                    t = 0.35 + 0.65 * q / 5
                    p = (va + V((0, 0, 0.06))).lerp(tip, t)
                    d = V((math.cos(a + q * 2.1), math.sin(a + q * 2.1), 0.5)).normalized() * 0.03
                    s = V((-d.y, d.x, 0)).normalized() * 0.008
                    k.mesh([p, p + d * 0.5 + s, p + d, p + d * 0.5 - s], [(0, 1, 2, 3), (3, 2, 1, 0)], LEAF * rng.uniform(0.8, 1.2))
        for sx in (-1, 1):
            cup(k, V((sx * 0.06, -0.205, B + 0.045)), r=0.016, h=0.016, tea=False)
    return finish(k, 'hokora' + level, 0.4)


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for level in ('', '_far'):
        for me in (roku_jizo(level), jizo_one(level), dohyo(level), hokora(level)):
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
