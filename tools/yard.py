# The farmhouses' yards' everyday things (src/yard.js puts them in the yards), built in Blender. Run through
# tools/blender.mjs:
#   blender -b --factory-startup -P tools/yard.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin at the yard's level, its front towards -y (Blender: z up;
# glTF: y up, so the front faces +z in the page), with a lighter `<kind>_far` model:
# - maki: split firewood stacked between stakes on two sleepers under a board laid over it, the ends out (1.8 m long);
# - ido: a well: a ring of dressed stone, a board lid half over it, a frame of two posts and a beam under a little board
#   roof, a pulley (kassha) hung from the beam, its rope down to a wooden bucket (tsurube) on the rim;
# - hatake: a kitchen garden of five ridges of dug earth, young greens in rows on four and peas climbing bamboo canes
#   on the fifth (3 x 2.2 m);
# - hoshi: washing on a bamboo pole between crossed bamboo stakes: indigo and white cloths, a striped kimono hung by
#   its sleeves (3.4 m long);
# - wara: last year's rice straw, tied in sheaves and stacked on a pallet, two lying by it;
# - kago: a tall woven bamboo basket, a shallow one, and a wooden washtub;
# - kuruma: a handcart (daihachi-guruma): a board bed on two spoked wheels with iron tyres, its shafts down on the ground;
# - usu: a stone mortar for pounding rice, a wooden pestle (kine) leaning on it.
# Shading in the vertex colours (ambient occlusion by ray casting); nothing glows (alpha 0). The parts take the
# photographed textures by their surface kind (village.py): timber, straw (the thatch's), stone.
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import lerp, tris, smoothstep
from village import Kit, srgb, K_NONE, K_WOOD, K_THATCH, K_STONE
from lamps import finish

V = Vector
WOOD = srgb('#7a6650')       # sun-greyed boards and posts
WOOD_D = srgb('#3e3127')
BARK = srgb('#4e3d2e')       # the firewood's bark
SPLIT = srgb('#a58560')      # its split faces
END = srgb('#bfa071')        # its sawn ends
STRAW = srgb('#b8a066')
STRAW_D = srgb('#8c7748')
STONE = srgb('#857f74')
BAMBOO = srgb('#a99d63')     # dry bamboo, yellowed
BAMBOO_N = srgb('#7f744a')   # its nodes
WICKER = srgb('#8f8058')     # woven bamboo, weathered
SOIL = srgb('#5e4831')
SOIL_D = srgb('#4a3826')
LEAF = srgb('#4d7a28')
LEAF_L = srgb('#7aa63c')
INDIGO = srgb('#26355a')
CLOTH = srgb('#e0dccd')
STRIPE = srgb('#8a5a3a')
ROPE = srgb('#a38c5f')
IRON = srgb('#2b2723')
WATER = srgb('#11140f')


class kind:
    """with kind(k, K): the parts made meanwhile take surface kind K"""

    def __init__(self, k, K):
        self.k, self.K = k, K

    def __enter__(self):
        self.k.force = self.K

    def __exit__(self, *a):
        self.k.force = None


def frame(d):
    """an orthonormal frame (x, y, z) with z along d"""
    z = d.normalized()
    x = z.orthogonal().normalized()
    return x, z.cross(x), z


def lathe(k, M, prof, seg, col, smooth=True, caps=(True, True)):
    """a solid of revolution about z from prof [(r, z)] (bottom to top), through M, coloured col(p, t) (p in the solid's
    own frame, t 0..1 up the profile); caps: close its bottom and top"""
    rings = []
    n = len(prof)
    for j, (r, z) in enumerate(prof):
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            p = V((math.cos(a) * r, math.sin(a) * r, z))
            v = k.bm.verts.new(M @ p)
            k.paint(v, col(p, j / max(1, n - 1)), 0.0)
            ring.append(v)
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(seg):
            k.bm.faces.new((a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i])).smooth = smooth
    if caps[0]:
        k.bm.faces.new(list(reversed(rings[0])))
    if caps[1]:
        k.bm.faces.new(rings[-1])
    return rings


def plain(c, amount=0.12, seed=0, f=6.0):
    """a colour mottled a little by noise"""
    off = V((seed * 1.3, seed * 2.9, seed * 0.7))
    return lambda p, t=0: c * (1 + amount * noise.noise(p * f + off))


# ---------- maki: firewood ----------
def split_log(k, a, b, r, rng, far):
    """a piece of firewood from a to b: a log split in quarters (two split faces meeting at the heart, the bark round
    its back), in halves, or a thin branch left round; the ends sawn, pale"""
    x, y, z = frame(b - a)
    turn = rng.uniform(0, math.tau)
    cut = rng.choice((0.5, 0.5, 1.0, 2.0))  # (the share of a round it is)
    seg = 3 if far else (5 if cut < 2 else 7)
    # the section: the heart, then round the bark's arc
    arc = math.pi * cut
    sec = ([V((0, 0, 0))] if cut < 2 else []) + [V((math.cos(turn + i * arc / (seg - (1 if cut < 2 else 0))), math.sin(turn + i * arc / (seg - (1 if cut < 2 else 0))), 0)) * r * (1.0 if cut < 2 else 0.6) for i in range(seg)]
    sec = [s - sum(sec, V()) / len(sec) for s in sec]
    m = len(sec)
    ends = []
    for e in (a, b):
        ring = []
        for s in sec:
            v = k.bm.verts.new(e + x * s.x + y * s.y)
            ring.append(v)
        ends.append(ring)
    with kind(k, K_WOOD):
        shade = rng.uniform(0.85, 1.12)
        for i in range(m):
            j = (i + 1) % m
            # (the faces from the heart are split wood, the rest bark)
            c = SPLIT if cut < 2 and (i == 0 or j == 0) else BARK
            vs = [k.bm.verts.new(ends[0][i].co), k.bm.verts.new(ends[0][j].co), k.bm.verts.new(ends[1][j].co), k.bm.verts.new(ends[1][i].co)]
            for v in vs:
                k.paint(v, c * shade, 0.0)
            k.bm.faces.new(vs).smooth = c is BARK
        for ring, flip in ((ends[0], True), (ends[1], False)):
            for v in ring:
                k.paint(v, END * shade * rng.uniform(0.9, 1.05), 0.0)
            k.bm.faces.new(list(reversed(ring)) if flip else ring)


def maki(far):
    k = Kit(pane=False)
    rng = random.Random(11)
    L, D, H = 1.8, 0.42, 1.15
    with kind(k, K_WOOD):
        for x in (-L / 2 + 0.2, L / 2 - 0.2):
            k.box(WOOD_D, (0.1, D + 0.1, 0.1), V((x, 0, 0.05)))  # the sleepers
        for x in (-L / 2 - 0.05, L / 2 + 0.05):
            for y in (-D / 2, D / 2):
                k.cyl(WOOD, V((x, y, -0.1)), V((x, y, H + 0.05)), 0.03, seg=5)  # the stakes
        # a board over the top, a stone on it
        k.box(WOOD, (L + 0.3, D + 0.25, 0.03), V((0, 0.02, H + 0.08)), rz=0.02)
    with kind(k, K_STONE):
        k.box(STONE, (0.22, 0.18, 0.12), V((0.3, 0.05, H + 0.15)), rz=0.4)
    if far:
        with kind(k, K_WOOD):
            k.box(END * 0.9, (L, D, H - 0.1), V((0, 0, 0.1 + (H - 0.1) / 2)))
        return finish(k, 'maki_far', 0.4)
    # the logs, their ends out front and back, in courses
    z = 0.1
    while z < H - 0.05:
        x = -L / 2 + 0.07
        rr = rng.uniform(0.06, 0.075)
        while x < L / 2 - 0.06:
            r = rng.uniform(0.055, 0.08)
            ln = D + rng.uniform(-0.04, 0.06)
            ox = rng.uniform(-0.03, 0.03)
            split_log(k, V((x + r, -ln / 2 + ox, z + rr)), V((x + r, ln / 2 + ox, z + rr)), r * 1.25, rng, False)
            x += 2 * r + 0.005
        z += 2 * rr
    return finish(k, 'maki', 0.4)


# ---------- ido: the well ----------
def ido(far):
    k = Kit(pane=False)
    rng = random.Random(12)
    R, Hc = 0.55, 0.72  # the curb's outer radius, its height
    seg = 10 if far else 20
    stone = plain(STONE, 0.14, 3, 4)
    with kind(k, K_STONE):
        # the curb: a ring of dressed stone, its wall 0.12 thick; the water dark below
        prof = [(R, 0.0), (R, Hc), (R - 0.12, Hc), (R - 0.12, 0.25)]
        rings = lathe(k, Matrix(), prof, seg, stone, smooth=False, caps=(False, False))
        if not far:
            # the joints between its stones, a shade darker
            for j in range(4):
                z = 0.18 * j + 0.17
                lathe(k, Matrix.Translation(V((0, 0, z))), [(R + 0.004, 0), (R + 0.004, 0.012)], seg, lambda p, t: STONE * 0.55, caps=(False, False))
    with kind(k, K_NONE):
        k.mesh([V((math.cos(a) * (R - 0.12), math.sin(a) * (R - 0.12), 0.25)) for a in (2 * math.pi * i / seg for i in range(seg))], [tuple(range(seg))], WATER)
    with kind(k, K_WOOD):
        # a lid of boards over its back half
        for i in range(4):
            y = 0.08 + i * 0.12
            w = 2 * math.sqrt(max(0.0, R * R - (y + 0.06) ** 2)) + 0.06
            k.box(WOOD * rng.uniform(0.9, 1.1), (w, 0.115, 0.03), V((0, y, Hc + 0.015)))
        k.box(WOOD_D, (0.05, 0.5, 0.04), V((0, 0.3, Hc + 0.05)))
        # the frame: two posts, a beam, a small roof of boards
        for sx in (-1, 1):
            k.box(WOOD, (0.1, 0.1, 2.25), V((sx * 0.72, 0, 1.12)))
        k.box(WOOD, (1.7, 0.1, 0.1), V((0, 0, 2.1)))
        for sy in (-1, 1):
            a, b = V((-1.0, 0, 2.42)), V((1.0, 0, 2.42))
            k.mesh([a, b, b + V((0, sy * 0.55, -0.22)), a + V((0, sy * 0.55, -0.22))], [(0, 1, 2, 3) if sy < 0 else (3, 2, 1, 0)], WOOD_D)
            k.mesh([a + V((0, 0, -0.03)), b + V((0, 0, -0.03)), b + V((0, sy * 0.55, -0.25)), a + V((0, sy * 0.55, -0.25))], [(3, 2, 1, 0) if sy < 0 else (0, 1, 2, 3)], WOOD_D * 0.8)
        for sx in (-1, 1):  # the gables' struts from the beam to the ridge
            k.beam(WOOD, V((sx * 0.72, 0, 2.12)), V((sx * 0.72, 0, 2.42)), 0.06, 0.06)
        # the pulley: a wheel in a block under the beam
        if not far:
            k.box(WOOD_D, (0.05, 0.12, 0.2), V((0, 0, 1.97)))
            k.cyl(WOOD_D * 1.2, V((-0.03, 0, 1.88)), V((0.03, 0, 1.88)), 0.09, seg=12)
        # the bucket on the rim: staves under two hoops, a bail
        bx, by, bz = 0.0, -0.36, Hc
        lathe(k, Matrix.Translation(V((bx, by, bz))), [(0.13, 0.0), (0.16, 0.3)], 8 if far else 14, plain(WOOD * 1.05, 0.1, 5, 12), caps=(True, False))
        if not far:
            lathe(k, Matrix.Translation(V((bx, by, bz))), [(0.157, 0.29), (0.15, 0.25), (0.13, 0.04)], 14, lambda p, t: WOOD * 0.6, caps=(False, False))
            for z, r in ((0.06, 0.137), (0.24, 0.155)):
                lathe(k, Matrix.Translation(V((bx, by, bz))), [(r + 0.005, z), (r + 0.006, z + 0.025)], 14, lambda p, t: WOOD_D * 0.7, caps=(False, False))
            k.beam(WOOD_D, V((bx - 0.16, by, bz + 0.3)), V((bx, by, bz + 0.42)), 0.025, 0.025)
            k.beam(WOOD_D, V((bx, by, bz + 0.42)), V((bx + 0.16, by, bz + 0.3)), 0.025, 0.025)
    if not far:
        with kind(k, K_NONE):
            # the rope from the bucket's bail over the pulley and down into the well
            k.cyl(ROPE, V((bx, by, bz + 0.42)), V((0.0, -0.09, 1.86)), 0.008, seg=4)
            k.cyl(ROPE, V((0.0, 0.09, 1.86)), V((0.0, 0.12, Hc + 0.06)), 0.008, seg=4)
    return finish(k, 'ido' + ('_far' if far else ''), 0.6)


# ---------- hatake: the kitchen garden ----------
def leaf(k, base, d, length, width, c):
    """a leaf from base along d (its blade tilted by d), both faces"""
    side = V((0, 0, 1)).cross(d)
    side = side.normalized() * width if side.length > 1e-6 else V((width, 0, 0))
    tip = base + d.normalized() * length
    mid = base + d.normalized() * length * 0.45
    pts = [base, mid + side, tip, mid - side]
    k.mesh(pts, [(0, 1, 2, 3)], c)
    k.mesh(pts, [(3, 2, 1, 0)], c)  # (its own vertices: bmesh keeps one face per set of vertices)


def hatake(far):
    k = Kit(pane=False)
    rng = random.Random(13)
    L, W, n = 3.0, 2.2, 5
    with kind(k, K_NONE):
        # the dug bed: ridges along x, the furrows between them
        for i in range(n):
            y = -W / 2 + (i + 0.5) * W / n
            # a ridge: rounded in section, earth crumbled along it, sloping down at its ends
            prof = [(-0.22, 0.0), (-0.16, 0.12), (-0.07, 0.19), (0.07, 0.19), (0.16, 0.12), (0.22, 0.0)]  # (W / n wide)
            if far:
                prof = [prof[0], prof[2], prof[3], prof[5]]
            cols = 12 if not far else 2
            vs = []
            for j in range(cols + 1):
                t = j / cols
                end = smoothstep(0.0, 0.08, min(t, 1 - t))
                row = []
                for a, z in prof:
                    p = V((-L / 2 + L * t + 0.06 * noise.noise(V((i * 3.1, a * 5, 0))), y + a, 0.01 + z * lerp(0.2, 1.0, end)))
                    if 0 < j < cols:
                        p.z += 0.015 * noise.noise(p * 7 + V((i, 0, 0)))
                    v = k.bm.verts.new(p)
                    k.paint(v, SOIL.lerp(SOIL_D, smoothstep(0.08, 0.0, z)) * (0.85 + 0.25 * noise.noise(p * 9)), 0.0)
                    row.append(v)
                vs.append(row)
            m = len(prof)
            for j in range(cols):
                for q in range(m - 1):
                    k.bm.faces.new((vs[j][q], vs[j + 1][q], vs[j + 1][q + 1], vs[j][q + 1])).smooth = True
            for row, flip in ((vs[0], False), (vs[-1], True)):
                k.bm.faces.new(row if flip else list(reversed(row)))
            if far:
                # the rows' green, as a strip along the ridge
                k.box(LEAF, (L - 0.2, 0.16, 0.06), V((0, y, 0.2)))
                continue
            if i > 0:
                # young greens: little rosettes along the ridge
                x = -L / 2 + 0.15
                while x < L / 2 - 0.1:
                    base = V((x + rng.uniform(-0.03, 0.03), y + rng.uniform(-0.03, 0.03), 0.2))
                    c = LEAF.lerp(LEAF_L, rng.uniform(0, 1))
                    a0 = rng.uniform(0, math.tau)
                    for q in range(4):
                        a = a0 + q * math.pi / 2
                        leaf(k, base, V((math.cos(a), math.sin(a), rng.uniform(0.5, 1.0))), rng.uniform(0.1, 0.16), 0.04, c * rng.uniform(0.85, 1.1))
                    x += rng.uniform(0.17, 0.24)
            else:
                # peas climbing a row of bamboo canes, crossed in pairs over a cane along the top
                for j in range(9):
                    x = -L / 2 + 0.2 + j * (L - 0.4) / 8
                    for s in (-1, 1):
                        k.cyl(BAMBOO, V((x, y + s * 0.08, 0.1)), V((x, y - s * 0.06, 1.15)), 0.008, seg=4)
                    for q in range(6):
                        zz = 0.25 + q * 0.14
                        base = V((x + rng.uniform(-0.06, 0.06), y + rng.uniform(-0.05, 0.05), zz))
                        a = rng.uniform(0, math.tau)
                        leaf(k, base, V((math.cos(a), math.sin(a), 0.3)), 0.07, 0.03, LEAF * rng.uniform(0.85, 1.15))
                k.cyl(BAMBOO, V((-L / 2 + 0.1, y, 1.05)), V((L / 2 - 0.1, y, 1.05)), 0.01, seg=4)
    if not far:
        # a hoe left on the bed's end
        with kind(k, K_WOOD):
            k.cyl(WOOD, V((L / 2 + 0.15, -0.6, 0.02)), V((L / 2 + 0.25, 0.6, 0.05)), 0.018, seg=5)
        with kind(k, K_NONE):
            k.box(IRON, (0.2, 0.14, 0.02), V((L / 2 + 0.25, 0.66, 0.04)), rz=0.1)
    return finish(k, 'hatake' + ('_far' if far else ''), 0.25)


# ---------- hoshi: washing on a pole ----------
def cloth(k, top, width, drop, c, far, sag=0.0, stripes=None):
    """a cloth hung over a pole along x at `top`: front and back sheets falling `drop`, waving a little"""
    nu, nv = (2, 1) if far else (6, 4)
    for side, flip in ((-1, False), (-1, True), (1, False), (1, True)):
        rows = []
        for j in range(nv + 1):
            v = j / nv
            row = []
            for i in range(nu + 1):
                u = i / nu
                x = top.x - width / 2 + width * u
                w = 0.02 * math.sin(u * 9 + side) * v
                p = V((x, top.y + side * (0.03 + 0.02 * v) + w, top.z - drop * v - sag * math.sin(math.pi * u)))
                cc = c
                if stripes and int(u * 24) % 3 == 0:
                    cc = stripes
                vv = k.bm.verts.new(p)
                k.paint(vv, cc * (1 - 0.15 * v), 0.0)
                row.append(vv)
            rows.append(row)
        for j in range(nv):
            for i in range(nu):
                q = (rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i])
                k.bm.faces.new(tuple(reversed(q)) if flip else q).smooth = True


def hoshi(far):
    k = Kit(pane=False)
    L, H = 3.4, 1.85
    with kind(k, K_NONE):
        # crossed bamboo stakes at each end, the pole in their fork
        for sx in (-1, 1):
            x = sx * L / 2
            for s in (-1, 1):
                k.cyl(BAMBOO, V((x, s * 0.35, 0.0)), V((x, -s * 0.12, H + 0.15)), 0.022, seg=5 if far else 7)
        k.cyl(BAMBOO, V((-L / 2 - 0.25, 0, H)), V((L / 2 + 0.25, 0, H)), 0.024, seg=5 if far else 8)
        if not far:
            for x in (-1.2, -0.4, 0.4, 1.2):  # the pole's nodes
                k.cyl(BAMBOO_N, V((x - 0.01, 0, H)), V((x + 0.01, 0, H)), 0.028, seg=8)
        top = V((0, 0, H + 0.02))
        # an indigo tenugui, a white sheet, the striped kimono hung by its sleeves, another tenugui
        cloth(k, top + V((-1.15, 0, 0)), 0.38, 0.45, INDIGO, far)
        cloth(k, top + V((-0.5, 0, 0)), 0.75, 0.75, CLOTH, far, sag=0.02)
        cloth(k, top + V((0.45, 0, 0)), 0.95, 0.95, CLOTH * 0.92, far, sag=0.03, stripes=None if far else STRIPE)
        cloth(k, top + V((1.2, 0, 0)), 0.36, 0.4, INDIGO * 1.2, far)
    return finish(k, 'hoshi' + ('_far' if far else ''), 0.3)


# ---------- wara: straw ----------
def sheaf(k, a, b, r, rng, far):
    """a tied sheaf of straw from a (the cut ends) to b (the heads): flared at both ends, pinched by its tie"""
    x, y, z = frame(b - a)
    L = (b - a).length
    prof = [(r * 0.95, 0), (r * 1.0, 0.06), (r * 0.8, 0.22), (r * 0.66, 0.3), (r * 0.66, 0.34), (r * 0.95, 0.5), (r * 1.2, 0.8), (r * 1.05, 0.95), (r * 0.5, 1.0)]
    if far:
        prof = [prof[0], prof[3], prof[6], prof[8]]
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = a
    shade = rng.uniform(0.85, 1.1)
    tie = lambda p, t: STRAW_D * 0.8 if abs(p.z / L - 0.32) < 0.025 else STRAW * shade * (1 + 0.1 * noise.noise(p * 30))
    with kind(k, K_THATCH):
        lathe(k, M @ Matrix.Diagonal(V((1, 1, L, 1))), prof, 6 if far else 10, lambda p, t: tie(V((p.x, p.y, p.z * L)), t))


def wara(far):
    k = Kit(pane=False)
    rng = random.Random(15)
    with kind(k, K_WOOD):
        for x in (-0.6, 0.0, 0.6):
            k.box(WOOD_D, (0.08, 1.0, 0.08), V((x, 0, 0.04)))  # the pallet's bearers
        for i in range(6):
            k.box(WOOD, (1.5, 0.12, 0.025), V((0, -0.42 + i * 0.17, 0.095)))
    z0 = 0.11
    if far:
        with kind(k, K_THATCH):
            for course, n in enumerate((6, 5, 4)):
                k.box(STRAW * 0.95, (n * 0.24, 1.0, 0.2), V((0, 0, z0 + 0.11 + course * 0.19)))
        return finish(k, 'wara_far', 0.35)
    # lying sheaves in courses, cut ends out front and back by turns
    for course, n in enumerate((6, 5, 4)):
        for i in range(n):
            x = (i - (n - 1) / 2) * 0.24
            zz = z0 + 0.11 + course * 0.19
            s = 1 if (i + course) % 2 else -1
            sheaf(k, V((x, -s * 0.5, zz)), V((x + rng.uniform(-0.03, 0.03), s * 0.5, zz + rng.uniform(-0.02, 0.03))), 0.11, rng, far)
    # two taken off it, lying by its end
    sheaf(k, V((0.95, -0.45, 0.1)), V((1.05, 0.5, 0.1)), 0.1, rng, far)
    sheaf(k, V((1.3, 0.45, 0.1)), V((1.12, -0.5, 0.11)), 0.1, rng, far)
    return finish(k, 'wara' + ('_far' if far else ''), 0.35)


# ---------- kago: baskets and a tub ----------
def woven(seed, c):
    """bamboo wickerwork: a checker of strips over and under"""
    def col(p, t):
        a = math.atan2(p.y, p.x)
        u, v = int((a / math.tau + 0.5) * 36), int(p.z / 0.03)
        return c * (0.72 if (u + v) % 2 else 1.08) * (1 + 0.08 * noise.noise(p * 20 + V((seed, 0, 0))))
    return col


def kago(far):
    k = Kit(pane=False)
    seg = 10 if far else 20
    with kind(k, K_NONE):
        # a tall basket for carrying on the back (shoi-kago), its rim bound
        M = Matrix.Translation(V((-0.35, 0.05, 0)))
        lathe(k, M, [(0.17, 0.0), (0.2, 0.15), (0.26, 0.55), (0.27, 0.6)], seg, woven(1, WICKER), caps=(True, False))
        lathe(k, M, [(0.265, 0.6), (0.25, 0.56), (0.18, 0.05)], seg, lambda p, t: WICKER * 0.55, caps=(False, False))
        lathe(k, M, [(0.28, 0.57), (0.285, 0.62), (0.27, 0.625)], seg, lambda p, t: WICKER * 0.8, caps=(False, False))
        # a shallow round basket (zaru) leaning on it
        R = Matrix.Translation(V((0.05, -0.12, 0.2))) @ Matrix.Rotation(-1.2, 4, 'X') @ Matrix.Rotation(0.3, 4, 'Y')
        lathe(k, R, [(0.0, 0.0), (0.18, 0.02), (0.24, 0.07)], seg, woven(2, WICKER * 1.05), caps=(False, False))
        lathe(k, R, [(0.24, 0.069), (0.18, 0.019), (0.0, -0.001)], seg, woven(2, WICKER * 0.9), caps=(False, False))
    with kind(k, K_WOOD):
        # a wooden washtub (tarai), staves under hoops
        M = Matrix.Translation(V((0.4, 0.05, 0)))
        lathe(k, M, [(0.28, 0.0), (0.32, 0.2)], seg, plain(WOOD * 1.1, 0.1, 6, 14), caps=(True, False))
        lathe(k, M, [(0.315, 0.2), (0.3, 0.17), (0.27, 0.03)], seg, lambda p, t: WOOD * 0.65, caps=(False, False))
        if not far:
            for z, r in ((0.04, 0.287), (0.16, 0.311)):
                lathe(k, M, [(r + 0.005, z), (r + 0.006, z + 0.025)], seg, lambda p, t: WOOD_D * 0.7, caps=(False, False))
    return finish(k, 'kago' + ('_far' if far else ''), 0.35)


# ---------- kuruma: the handcart ----------
def kuruma(far):
    k = Kit(pane=False)
    R = 0.46  # the wheels' radius; the axle across x at y = 0
    # the bed tilts down to the front, where the shafts' ends lie on the ground
    tip = V((0, -1.75, 0.04))
    pivot = V((0, 0.0, R + 0.06))
    ang = math.atan2(pivot.z - tip.z, -tip.y)
    T = Matrix.Translation(pivot) @ Matrix.Rotation(ang, 4, 'X')
    with kind(k, K_WOOD):
        # the bed: boards across two rails that run on forward as the shafts, a crossbar at their ends
        for sx in (-1, 1):
            a, b = T @ V((sx * 0.38, 0.75, 0)), T @ V((sx * 0.38, -1.78, 0))
            k.beam(WOOD_D, a, b, 0.07, 0.08)
        k.beam(WOOD, T @ V((-0.42, -1.72, 0)), T @ V((0.42, -1.72, 0)), 0.05, 0.05)
        nb = 4 if far else 9
        for i in range(nb):
            y = 0.72 - i * 1.45 / (nb - 1)
            k.box(WOOD * (0.92 + 0.12 * ((i * 7) % 3) / 2), (0.9, 1.45 / (nb - 1) - 0.008, 0.03), T @ V((0, y, 0.055)))
        # the wheels: hub, spokes, felloe, under iron tyres
        for sx in (-1, 1):
            x = sx * 0.55
            k.cyl(WOOD_D, V((x - 0.08, 0, R)), V((x + 0.08, 0, R)), 0.07, seg=8)
            ns = 6 if far else 10
            for i in range(ns):
                a = 2 * math.pi * i / ns
                d = V((0, math.cos(a), math.sin(a)))
                k.cyl(WOOD, V((x, 0, R)) + d * 0.06, V((x, 0, R)) + d * (R - 0.06), 0.018, seg=4)
            seg = 12 if far else 24
            ring = lambda r: [V((x, math.cos(2 * math.pi * i / seg) * r, R + math.sin(2 * math.pi * i / seg) * r)) for i in range(seg)]
            for (r0, r1), c, K in (((R - 0.07, R - 0.01), WOOD, K_WOOD), ((R - 0.01, R), IRON, K_NONE)):
                k.force = K
                o = [p + V((-0.035, 0, 0)) for p in ring(r1)] + [p + V((0.035, 0, 0)) for p in ring(r1)]
                inn = [p + V((-0.035, 0, 0)) for p in ring(r0)] + [p + V((0.035, 0, 0)) for p in ring(r0)]
                pts = o + inn
                faces = []
                for i in range(seg):
                    j = (i + 1) % seg
                    faces.append((i, j, seg + j, seg + i))  # the outside
                    faces.append((2 * seg + seg + i, 2 * seg + seg + j, 2 * seg + j, 2 * seg + i))  # the inside
                    faces.append((2 * seg + i, 2 * seg + j, j, i))  # the sides
                    faces.append((seg + i, seg + j, 3 * seg + j, 3 * seg + i))
                k.mesh(pts, faces, c, smooth=False)
                k.force = K_WOOD
        k.cyl(IRON, V((-0.65, 0, R)), V((0.65, 0, R)), 0.025, seg=6)  # the axle
        for sx in (-1, 1):  # the bearers from the axle up to the bed
            k.beam(WOOD_D, V((sx * 0.38, 0, R)), T @ V((sx * 0.38, 0.0, -0.04)), 0.07, 0.07)
    return finish(k, 'kuruma' + ('_far' if far else ''), 0.4)


# ---------- usu: the stone mortar ----------
def usu(far):
    k = Kit(pane=False)
    seg = 10 if far else 20
    with kind(k, K_STONE):
        # a block of granite rounded at its shoulders, the bowl worn into its top
        prof = [(0.3, 0.0), (0.33, 0.06), (0.33, 0.38), (0.3, 0.45), (0.22, 0.46), (0.18, 0.42), (0.1, 0.3), (0.0, 0.27)]
        lathe(k, Matrix(), prof, seg, plain(STONE * 1.05, 0.15, 7, 5), caps=(True, False))
    with kind(k, K_WOOD):
        # the pestle (kine): a long handle in a wooden head, leaning on the mortar's rim
        head = V((0.42, 0.22, 0.0)), V((0.36, 0.2, 0.55))
        k.cyl(WOOD * 1.05, head[0] + V((0, 0, 0.12)), head[1], 0.07, seg=6 if far else 12)
        k.cyl(WOOD, (head[0] + head[1]) / 2 + V((0, 0, 0.06)), V((0.12, 0.05, 0.98)), 0.025, seg=5 if far else 8)
    return finish(k, 'usu' + ('_far' if far else ''), 0.35)


KINDS = {'maki': maki, 'ido': ido, 'hatake': hatake, 'hoshi': hoshi, 'wara': wara, 'kago': kago, 'kuruma': kuruma, 'usu': usu}

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for far in (False, True):
        for name, make in KINDS.items():
            me = make(far)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True, export_attributes=True)
