# The village's buildings (src/village.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/village.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin, its front (the veranda, the door) towards -y (Blender: z up;
# glTF: y up, so the front faces +z in the page), named as in KINDS, with a lighter `<kind>_far` model. Old farmhouses
# (minka) under thick thatch (kayabuki): the big one hip-and-gable (irimoya), the small one hipped (yosemune);
# a white storehouse (kura) under tile; a board shed with firewood stacked along it; a torii for the temple's approach;
# a waterwheel (mizuguruma) and its mill hut (the wheel a model of its own, which the page turns).
# Shading in the vertex colours (ambient occlusion by ray casting, weathering); alpha: how much a part glows after
# dusk (the shoji's paper, lit from inside).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, evaluated, tris, vertex_ao

V = Vector


def srgb(h):
    return V([((int(h[i:i + 2], 16) / 255 + 0.055) / 1.055) ** 2.4 for i in (1, 3, 5)])


WOOD = srgb('#4a3426')       # old cedar posts and beams, darkened by smoke and sun
WOOD_L = srgb('#6b5038')     # boards
WOOD_D = srgb('#2a1e17')
PLASTER = srgb('#d9d2c2')    # shikkui, a little dusty
PAPER = srgb('#ece4cf')      # shoji
STONE = srgb('#7d776c')
THATCH = srgb('#94805c')     # aged thatch, greyed straw
THATCH_CUT = srgb('#b39b6a')  # the cut ends at the eaves
THATCH_D = srgb('#3a3226')
MOSS = srgb('#5d6332')
TILE = srgb('#3e4044')
SHU = srgb('#c23b22')        # the torii's vermilion
BLACK = srgb('#1c1a19')
LOG = srgb('#5a4330'); LOG_END = srgb('#b89a6c')


class Kit:
    """Parts into one bmesh, each vertex its colour and glow (alpha); flat faces unless smooth."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Color')

    def mesh(self, verts, faces, c, glow=0.0, smooth=False):
        vs = [self.bm.verts.new(p) for p in verts]
        for v in vs:
            v[self.col] = (*c, glow)
        for f in faces:
            try:
                face = self.bm.faces.new([vs[i] for i in f])
                face.smooth = smooth
            except ValueError:
                pass
        return vs

    def box(self, c, size, at, rz=0.0, glow=0.0):
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        m = Matrix.Translation(at) @ Matrix.Rotation(rz, 4, 'Z')
        p = [m @ V((x, y, z)) for z in (-sz, sz) for y in (-sy, sy) for x in (-sx, sx)]
        return self.mesh(p, [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)], c, glow)

    def beam(self, c, a, b, w, h, up=V((0, 0, 1))):
        """a box from a to b, w wide, h tall"""
        d = b - a
        x = d.normalized()
        y = up.cross(x).normalized() if abs(up.dot(x)) < 0.99 else V((0, 1, 0))
        z = x.cross(y)
        m = Matrix((x, y, z)).transposed().to_4x4()
        m.translation = (a + b) / 2
        sx, sy, sz = d.length / 2, w / 2, h / 2
        p = [m @ V((xx, yy, zz)) for zz in (-sz, sz) for yy in (-sy, sy) for xx in (-sx, sx)]
        return self.mesh(p, [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)], c)

    def cyl(self, c, a, b, r, seg=8, r2=None, smooth=True, cap=True):
        d = b - a
        x = d.normalized()
        t = V((0, 0, 1)) if abs(x.z) < 0.9 else V((1, 0, 0))
        u = x.cross(t).normalized()
        w = x.cross(u)
        r2 = r if r2 is None else r2
        p = []
        for end, rr in ((a, r), (b, r2)):
            for i in range(seg):
                ang = 2 * math.pi * i / seg
                p.append(end + (u * math.cos(ang) + w * math.sin(ang)) * rr)
        f = [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)]
        if cap:
            f += [tuple(reversed(range(seg))), tuple(range(seg, 2 * seg))]
        return self.mesh(p, f, c, smooth=smooth)

    def add_mesh(self, me, colour_fn):
        """another mesh, smooth shaded, coloured by colour_fn(co, normal) -> (rgb, glow)"""
        n0, f0 = len(self.bm.verts), len(self.bm.faces)
        self.bm.from_mesh(me)
        self.bm.verts.ensure_lookup_table()
        self.bm.faces.ensure_lookup_table()
        self.bm.normal_update()
        for v in self.bm.verts[n0:]:
            c, g = colour_fn(v.co, v.normal)
            v[self.col] = (*c, g)
        for f in self.bm.faces[f0:]:
            f.smooth = True


# ---------- thatch ----------
def thatch(a, b, he, pitch, *, irimoya, T, voxel, target, seed, gable=0.6):
    """A thick thatched roof over the eave rectangle 2a x 2b at height he: its top the lower of the four planes at
    `pitch` (hipped, yosemune), or for irimoya the hips only up to `gable` of the rise with a vertical gable above;
    T thick, the solid rounded by a voxel remesh, lumpy, decimated to `target` triangles. Returns (mesh, ridge
    half-length, ridge height, gable x, gable base height)."""
    p = math.tan(math.radians(pitch))
    hr = b * p
    hg = hr * gable
    xg = a - hg / p if irimoya else a - b

    def top(x, y):
        zg = p * (b - abs(y))
        if irimoya and abs(x) <= xg:
            return zg
        return min(zg, p * (a - abs(x)))

    step = 0.12
    nx, ny = int(2 * a / step) + 1, int(2 * b / step) + 1
    verts, faces = [], []
    for j in range(ny):
        for i in range(nx):
            x, y = -a + 2 * a * i / (nx - 1), -b + 2 * b * j / (ny - 1)
            verts.append(V((x, y, he + top(x, y))))
    for j in range(ny):
        for i in range(nx):
            x, y = -a + 2 * a * i / (nx - 1), -b + 2 * b * j / (ny - 1)
            # the underside, parallel to the top but never above the eave's underside, T below it at the edge
            verts.append(V((x, y, he + top(x, y) - T)))
    off = nx * ny
    for j in range(ny - 1):
        for i in range(nx - 1):
            q = j * nx + i
            faces.append((q, q + 1, q + nx + 1, q + nx))
            faces.append((off + q, off + q + nx, off + q + nx + 1, off + q + 1))
    ring = [j * nx for j in range(ny)] + [(ny - 1) * nx + i for i in range(1, nx)] + [j * nx + nx - 1 for j in range(ny - 2, -1, -1)] + [i for i in range(nx - 2, 0, -1)]
    for k in range(len(ring)):
        a0, a1 = ring[k], ring[(k + 1) % len(ring)]
        faces.append((a0, a1, off + a1, off + a0))
    me = bpy.data.meshes.new('thatch')
    me.from_pydata(verts, [], faces)
    ob = link(me, 'thatch')
    rm = ob.modifiers.new('remesh', 'REMESH')
    rm.mode, rm.voxel_size, rm.adaptivity = 'VOXEL', voxel, 0.0
    sm = ob.modifiers.new('smooth', 'SMOOTH')
    sm.factor, sm.iterations = 0.5, 4
    me = evaluated(ob)
    # lumps: the thatch laid in courses, settled unevenly
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    off3 = V((seed * 3.1, seed * 1.7, seed * 2.3))
    for v in bm.verts:
        q = v.co
        d = 0.06 * noise.noise(q * 0.45 + off3) + 0.025 * noise.noise(q * 1.6 + off3) + 0.008 * noise.noise(q * 6 + off3)
        v.co += v.normal * d
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'thatch')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    me = evaluated(ob)
    return me, xg, he + hr, hg


def thatch_colour(he, ridge_z, seed):
    off = V((seed * 5.3, seed * 2.9, seed * 1.1))

    def fn(co, n):
        up = n.z
        if up < -0.4:  # the underside, in the eaves' shadow
            return THATCH_D * (0.8 + 0.2 * noise.noise(co * 2 + off)), 0.0
        h = (co.z - he) / max(0.1, ridge_z - he)
        # the thick cut edge at the eaves: pale straw ends, streaked
        cut = smoothstep(0.45, 0.15, abs(up)) * smoothstep(0.35, 0.0, h)
        streak = 0.85 + 0.15 * noise.noise(V((co.x * 3 + co.y * 3, 0, co.z * 0.3)) + off)
        c = THATCH.lerp(THATCH_D, 0.25 * smoothstep(0.3, -0.2, noise.noise(co * 0.7 + off)))
        # rain streaks down the slope, darker low down where it stays damp; moss in patches on the lower courses
        c = c * (0.8 + 0.25 * noise.noise(V((co.x * 2.5, co.y * 2.5, co.z * 0.4)) + off)) * lerp(0.82, 1.08, h)
        m = smoothstep(0.35, 0.7, noise.noise(co * 0.5 + off * 2) + 0.3 * (1 - h)) * smoothstep(0.1, 0.5, up) * 0.4
        c = c.lerp(MOSS, m)
        c = c.lerp(THATCH_CUT * streak, cut)
        return c, 0.0
    return fn


def ridge(k, x0, x1, z, r, saddles):
    """the ridge: a dark bundle along it, saddles of bamboo and cedar bark across it"""
    k.cyl(THATCH_D * 0.7, V((x0, 0, z)), V((x1, 0, z)), r, seg=10)
    k.box(WOOD_D, (abs(x1 - x0) + 0.3, r * 1.3, 0.12), V(((x0 + x1) / 2, 0, z + r * 0.95)))
    n = saddles
    for i in range(n):
        x = lerp(x0 + 0.3, x1 - 0.3, i / max(1, n - 1))
        for s in (-1, 1):
            k.beam(WOOD_D, V((x, 0, z + r * 1.1)), V((x, s * r * 2.0, z - r * 0.9)), 0.14, 0.1)


# ---------- walls ----------
def walls(k, L, D, H, floor, *, front_shoji, side_door, posts=1.8, detail=True):
    """the body: L long (x), D deep (y), walls H tall from a floor raised `floor` above the ground; posts and beams,
    plaster above a tie beam, boards below; the front (-y) shoji behind an open veranda, a side the earthen-floored
    entrance (doma), its door open"""
    hx, hy = L / 2, D / 2
    top = floor + H
    # foundation stones and the raised floor's skirt
    k.box(STONE * 0.85, (L + 0.3, D + 0.3, 0.25), V((0, 0, 0.12)))
    k.box(WOOD_D, (L, D, floor - 0.2), V((0, 0, 0.2 + (floor - 0.2) / 2)))
    # wall faces: four sides
    for side in range(4):
        if side in (0, 2):
            ln, n_axis, sign = L, 'y', -1 if side == 0 else 1
        else:
            ln, n_axis, sign = D, 'x', -1 if side == 1 else 1
        npost = max(2, round(ln / posts) + 1)
        for i in range(npost):
            t = -ln / 2 + ln * i / (npost - 1)
            pos = V((t, sign * hy, 0)) if n_axis == 'y' else V((sign * hx, t, 0))
            if detail or i in (0, npost - 1):
                k.box(WOOD, (0.18, 0.18, top), pos + V((0, 0, top / 2)))
        # infill
        inset = 0.04
        mid = floor + H * 0.55
        if n_axis == 'y':
            c0 = V((0, sign * (hy - inset), 0))
            size = lambda h: (L - 0.1, 0.06, h)
        else:
            c0 = V((sign * (hx - inset), 0, 0))
            size = lambda h: (0.06, D - 0.1, h)
        if side == 0 and front_shoji:
            # shoji: paper panels on a lattice (kumiko), lit from inside after dusk; a plaster band above
            k.box(PAPER, size(H * 0.78), c0 + V((0, 0, floor + H * 0.39)), glow=1.0)
            if detail:
                for i in range(int(L / 0.45)):
                    x = -hx + 0.2 + i * 0.45
                    k.box(WOOD_L, (0.03, 0.08, H * 0.78), V((x, -hy + 0.02, floor + H * 0.39)))
                for j in range(1, 6):
                    k.box(WOOD_L, (L - 0.1, 0.08, 0.03), V((0, -hy + 0.02, floor + H * 0.78 * j / 6)))
            k.box(PLASTER, size(H * 0.22), c0 + V((0, 0, floor + H * 0.89)))
        else:
            k.box(WOOD_L * 0.85, size(mid - 0.2), c0 + V((0, 0, 0.2 + (mid - 0.2) / 2)))
            k.box(PLASTER, size(top - mid), c0 + V((0, 0, mid + (top - mid) / 2)))
            if detail:
                # board courses
                for j in range(1, 4):
                    z = 0.2 + (mid - 0.2) * j / 4
                    if n_axis == 'y':
                        k.box(WOOD_D, (L - 0.1, 0.09, 0.025), V((0, sign * (hy + 0.0), z)))
                    else:
                        k.box(WOOD_D, (0.09, D - 0.1, 0.025), V((sign * (hx + 0.0), 0, z)))
        # tie beam and wall plate
        for z in (mid, top - 0.1):
            if n_axis == 'y':
                k.box(WOOD, (L + 0.3, 0.2, 0.18), V((0, sign * hy, z)))
            else:
                k.box(WOOD, (0.2, D + 0.3, 0.18), V((sign * hx, 0, z)))
    if side_door:
        # the doma's entrance on the right end: a dark opening, the board door slid aside
        k.box(BLACK, (0.12, 1.5, 1.9), V((hx + 0.02, -hy + 1.4, 1.05)))
        k.box(WOOD_L, (0.06, 1.4, 1.85), V((hx + 0.08, -hy + 2.9, 1.05)))
    return top


def veranda(k, L, D, floor, detail=True):
    """the engawa along the front: a board deck at floor height on short posts"""
    hy = D / 2
    k.box(WOOD_L, (L, 0.95, 0.08), V((0, -hy - 0.47, floor)))
    if detail:
        for i in range(int(L / 1.8) + 1):
            x = -L / 2 + 0.1 + i * (L - 0.2) / max(1, int(L / 1.8))
            k.box(WOOD_D, (0.12, 0.12, floor), V((x, -hy - 0.85, floor / 2)))
            k.box(STONE, (0.3, 0.3, 0.12), V((x, -hy - 0.85, 0.05)))
        # a stepping stone
        k.box(STONE * 1.1, (0.8, 0.5, 0.22), V((L * 0.15, -hy - 1.35, 0.11)))


def finish(k, name, ao_reach=1.2):
    """AO over the whole building, into the colours; one mesh named `name`"""
    bm = k.bm
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, ao_reach)
    for v in bm.verts:
        c = v[k.col]
        a = lerp(0.42, 1.0, ao[v.index])
        v[k.col] = (c[0] * a, c[1] * a, c[2] * a, c[3])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()
    me.color_attributes.active_color = me.color_attributes['Color']
    link(me, name)
    return me


# ---------- the buildings ----------
def minka(name, *, L, D, H, pitch, irimoya, seed, far):
    """a farmhouse: L x D body, walls H, under thatch reaching 1.1 m past the walls"""
    k = Kit()
    floor = 0.55
    top = walls(k, L, D, H, floor, front_shoji=True, side_door=True, detail=not far)
    veranda(k, L, D, floor, detail=not far)
    a, b = L / 2 + 1.15, D / 2 + 1.15
    he = top - 0.25
    me, xg, rz, hg = thatch(a, b, he, pitch, irimoya=irimoya, T=0.75 if not far else 0.7, voxel=0.09 if not far else 0.16,
                            target=5200 if not far else 900, seed=seed, gable=0.58)
    k.add_mesh(me, thatch_colour(he, rz, seed))
    if irimoya:
        # the gable: a dark board triangle set back on the hips, a smoke vent lattice
        for s in (-1, 1):
            x = s * (xg - 0.12)
            z0, z1 = he + hg - 0.15, rz - 0.25
            w = (z1 - z0) / math.tan(math.radians(pitch))
            k.mesh([V((x, -w, z0)), V((x, w, z0)), V((x, 0, z1))], [(0, 1, 2) if s > 0 else (0, 2, 1)], WOOD_D)
            if not far:
                for j in range(4):
                    yy = -w * 0.4 + j * w * 0.8 / 3
                    k.box(WOOD_L * 0.7, (0.06, 0.05, (z1 - z0) * 0.35), V((x + s * 0.03, yy, z0 + (z1 - z0) * 0.32)))
    ridge(k, -xg, xg, rz - 0.05, 0.3, 0 if far else max(3, int(2 * xg / 1.1)))
    return finish(k, name + ('_far' if far else ''))


def kura(name, *, far):
    """a storehouse: thick white plaster walls on a grey tiled skirt (namako), two storeys under a tile gable roof"""
    k = Kit()
    L, D, H = 4.6, 3.6, 5.2
    hx, hy = L / 2, D / 2
    k.box(STONE * 0.8, (L + 0.4, D + 0.4, 0.45), V((0, 0, 0.22)))
    k.box(PLASTER * 1.04, (L, D, H), V((0, 0, 0.45 + H / 2)))
    # namako skirt: grey tiles with white joints in a lattice
    k.box(TILE * 1.4, (L + 0.06, D + 0.06, 1.2), V((0, 0, 0.45 + 0.6)))
    if not far:
        for s in range(4):
            for i in range(9):
                t = -0.5 + i / 8
                if s < 2:
                    y = (-1 if s == 0 else 1) * (hy + 0.04)
                    k.box(PLASTER, (0.035, 0.02, 1.15), V((t * L * 0.98, y, 1.05)), rz=0)
                else:
                    x = (-1 if s == 2 else 1) * (hx + 0.04)
                    k.box(PLASTER, (0.02, 0.035, 1.15), V((x, t * D * 0.98, 1.05)))
            for j in range(3):
                z = 0.6 + j * 0.42
                if s < 2:
                    k.box(PLASTER, (L + 0.07, 0.03, 0.03), V((0, (-1 if s == 0 else 1) * (hy + 0.045), z)))
                else:
                    k.box(PLASTER, (0.03, D + 0.07, 0.03), V(((-1 if s == 2 else 1) * (hx + 0.045), 0, z)))
    # the heavy door and the upper window, their shutters dark
    k.box(WOOD_D, (1.3, 0.2, 2.1), V((0, -hy - 0.08, 0.45 + 1.05)))
    k.box(PLASTER * 0.9, (1.6, 0.25, 0.25), V((0, -hy - 0.1, 0.45 + 2.3)))
    k.box(BLACK, (0.7, 0.12, 0.7), V((0, -hy - 0.04, 0.45 + 3.9)))
    # tile gable roof: two slopes of ridged tile rows, a heavy ridge with its end tiles raised
    pitch = math.radians(27)
    a, b = hx + 0.55, hy + 0.55
    he = 0.45 + H
    rz = he + b * math.tan(pitch)
    for s in (-1, 1):
        k.mesh([V((-a, s * b, he)), V((a, s * b, he)), V((a, 0, rz)), V((-a, 0, rz))],
               [(0, 1, 2, 3) if s < 0 else (3, 2, 1, 0)], TILE)
        k.mesh([V((-a, s * b, he - 0.18)), V((a, s * b, he - 0.18)), V((a, 0, rz - 0.18)), V((-a, 0, rz - 0.18))],
               [(3, 2, 1, 0) if s < 0 else (0, 1, 2, 3)], WOOD_D)
        k.box(TILE * 0.8, (2 * a, 0.12, 0.2), V((0, s * b, he - 0.07)))
        if not far:
            for i in range(int(2 * a / 0.28) + 1):
                x = -a + 0.1 + i * 0.28
                k.beam(TILE * 0.75, V((x, s * b, he + 0.04)), V((x, 0, rz + 0.04)), 0.09, 0.07)
    for s in (-1, 1):
        k.mesh([V((s * a, -b, he - 0.18)), V((s * a, b, he - 0.18)), V((s * a, b, he)), V((s * a, 0, rz)), V((s * a, -b, he))],
               [(0, 1, 2, 3, 4) if s > 0 else (4, 3, 2, 1, 0)], TILE * 0.9)
        k.box(PLASTER, (0.05, D, rz - he), V((s * (hx + 0.01), 0, he + (rz - he) / 3)))
    k.box(TILE * 0.7, (2 * a + 0.2, 0.42, 0.32), V((0, 0, rz + 0.12)))
    for s in (-1, 1):
        k.box(TILE * 0.6, (0.3, 0.5, 0.6), V((s * (a + 0.05), 0, rz + 0.3)))
    return finish(k, name + ('_far' if far else ''), 1.0)


def koya(name, *, far):
    """a shed: boards under a single-pitched board roof weighted with stones, firewood stacked along its side"""
    k = Kit()
    L, D = 3.6, 2.6
    k.box(STONE * 0.8, (L + 0.2, D + 0.2, 0.15), V((0, 0, 0.07)))
    k.box(WOOD_L * 0.8, (L, D, 2.3), V((0, 0.0, 0.15 + 1.15)))
    if not far:
        for i in range(int(L / 0.25)):
            x = -L / 2 + 0.12 + i * 0.25
            k.box(WOOD_D, (0.03, D + 0.04, 2.25), V((x, 0, 1.3)))
    k.box(BLACK, (1.2, 0.08, 1.8), V((0.4, -D / 2 - 0.02, 1.05)))
    # roof boards, sloping back, with stones on them
    h0, h1 = 2.8, 2.35
    k.mesh([V((-L / 2 - 0.4, -D / 2 - 0.6, h0)), V((L / 2 + 0.4, -D / 2 - 0.6, h0)), V((L / 2 + 0.4, D / 2 + 0.5, h1)), V((-L / 2 - 0.4, D / 2 + 0.5, h1))],
           [(0, 1, 2, 3)], WOOD * 0.85)
    k.mesh([V((-L / 2 - 0.4, -D / 2 - 0.6, h0 - 0.1)), V((L / 2 + 0.4, -D / 2 - 0.6, h0 - 0.1)), V((L / 2 + 0.4, D / 2 + 0.5, h1 - 0.1)), V((-L / 2 - 0.4, D / 2 + 0.5, h1 - 0.1))],
           [(3, 2, 1, 0)], WOOD_D)
    if not far:
        rng = random.Random(5)
        for i in range(7):
            x = -L / 2 + 0.2 + i * (L / 6.5)
            k.box(STONE * 1.1, (0.3, 0.25, 0.18), V((x, rng.uniform(-0.6, 0.6), lerp(h0, h1, 0.5) + 0.1)))
        # firewood: split logs, ends out, stacked along the long side under the eave
        for row in range(6):
            for i in range(int(L / 0.18)):
                x = -L / 2 + 0.1 + i * 0.18 + (row % 2) * 0.09
                z = 0.25 + row * 0.17
                k.cyl(LOG, V((x, D / 2 + 0.05, z)), V((x, D / 2 + 0.55, z)), 0.085, seg=5)
                k.cyl(LOG_END * rng.uniform(0.85, 1.1), V((x, D / 2 + 0.55, z)), V((x, D / 2 + 0.56, z)), 0.08, seg=5, smooth=False)
    else:
        k.box(LOG * 1.2, (L, 0.5, 1.0), V((0, D / 2 + 0.3, 0.7)))
    return finish(k, name + ('_far' if far else ''), 0.8)


def torii(name, *, far):
    """a vermilion torii (myojin style): two leaning pillars on black footings, the tie beam through them, the upswept
    black top beam (kasagi) over the vermilion one (shimaki), the tablet's strut between"""
    k = Kit()
    span, H = 3.2, 4.4
    seg = 8 if far else 14
    for s in (-1, 1):
        base, topp = V((s * span / 2, 0, 0)), V((s * span / 2 * 0.94, 0, H))
        k.cyl(SHU, base + V((0, 0, 0.35)), topp, 0.17, seg=seg, r2=0.15)
        k.cyl(BLACK, base, base + V((0, 0, 0.4)), 0.21, seg=seg)
    # nuki (tie beam), through the pillars
    k.box(SHU, (span + 1.1, 0.18, 0.26), V((0, 0, H - 0.95)))
    # gakuzuka strut and tablet
    k.box(SHU, (0.18, 0.16, 0.6), V((0, 0, H - 0.55)))
    k.box(BLACK, (0.42, 0.08, 0.55), V((0, -0.1, H - 0.55)))
    # shimaki and the kasagi, swept up at the ends
    n = 6 if far else 12
    pts = []
    for i in range(n + 1):
        t = -1 + 2 * i / n
        x = t * (span / 2 + 1.0)
        z = H + 0.2 + 0.22 * t ** 4
        pts.append(V((x, 0, z)))
    for i in range(n):
        k.beam(SHU, pts[i] - V((0, 0, 0.2)), pts[i + 1] - V((0, 0, 0.2)), 0.26, 0.2)
        k.beam(BLACK, pts[i] + V((0, 0, 0.05)), pts[i + 1] + V((0, 0, 0.05)), 0.36, 0.26)
    return finish(k, name + ('_far' if far else ''), 0.6)


def suisha_wheel(name, *, far):
    """the waterwheel's wheel: two rims of short straight segments, spokes from an octagonal hub, boards (paddles)
    between the rims; 2.1 m in radius, turning about the x axis through the origin"""
    k = Kit()
    R, w, n = 2.1, 0.7, 16 if not far else 10
    seg = 16 if not far else 10
    for side in (-1, 1):
        x = side * w / 2
        pts = [V((x, R * math.cos(2 * math.pi * i / seg), R * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
        for i in range(seg):
            k.beam(WOOD, pts[i], pts[(i + 1) % seg], 0.1, 0.16, up=V((1, 0, 0)))
        if not far:
            inner = [p * 0.82 for p in pts]
            for i in range(seg):
                k.beam(WOOD_D, V((x, inner[i].y, inner[i].z)), V((x, inner[(i + 1) % seg].y, inner[(i + 1) % seg].z)), 0.08, 0.1, up=V((1, 0, 0)))
        for i in range(0, seg, 2):
            a = 2 * math.pi * i / seg
            k.beam(WOOD, V((x, 0.25 * math.cos(a), 0.25 * math.sin(a))), V((x, R * 0.97 * math.cos(a), R * 0.97 * math.sin(a))), 0.09, 0.09, up=V((1, 0, 0)))
    for i in range(n):
        a = 2 * math.pi * (i + 0.5) / n
        c, s_ = math.cos(a), math.sin(a)
        # a board across the rims, set radially
        p0, p1 = V((0, R * 0.8 * c, R * 0.8 * s_)), V((0, R * 1.08 * c, R * 1.08 * s_))
        k.beam(WOOD_L, (p0 + p1) / 2 - V((w / 2 + 0.04, 0, 0)), (p0 + p1) / 2 + V((w / 2 + 0.04, 0, 0)), 0.04, (p1 - p0).length, up=V((0, -s_, c)))
    k.cyl(WOOD_D, V((-w / 2 - 0.15, 0, 0)), V((w / 2 + 0.15, 0, 0)), 0.3, seg=8)
    return finish(k, name + ('_far' if far else ''), 0.8)


def suisha(name, *, far):
    """the waterwheel's mill: a small board hut with a thatched roof on the bank, the axle out of its side on a
    trestle (the wheel itself is suisha_wheel, turned by the page)"""
    k = Kit()
    L, D = 3.4, 3.0
    k.box(STONE * 0.8, (L + 0.3, D + 0.3, 0.3), V((0, 0, 0.15)))
    k.box(WOOD_L * 0.75, (L, D, 2.2), V((0, 0, 0.3 + 1.1)))
    if not far:
        for i in range(int(L / 0.25)):
            x = -L / 2 + 0.12 + i * 0.25
            for sy in (-1, 1):
                k.box(WOOD_D, (0.03, 0.04, 2.15), V((x, sy * (D / 2 + 0.01), 1.4)))
    k.box(BLACK, (0.9, 0.06, 1.7), V((-0.6, -D / 2 - 0.02, 1.15)))
    me, xg, rz, hg = thatch(L / 2 + 0.7, D / 2 + 0.7, 2.35, 48, irimoya=False, T=0.5, voxel=0.08 if not far else 0.14,
                            target=1800 if not far else 400, seed=21)
    k.add_mesh(me, thatch_colour(2.35, rz, 21))
    ridge(k, -xg, xg, rz - 0.05, 0.2, 0 if far else 3)
    # the axle out of the hut's river side (+x) to the wheel at (2.9, 0, 1.6), on trestles either side of the wheel
    k.cyl(WOOD_D, V((L / 2 - 0.2, 0, 1.6)), V((2.55, 0, 1.6)), 0.12, seg=8)
    for x in (2.25, 3.55):
        for sy in (-1, 1):
            k.beam(WOOD, V((x, sy * 0.55, -1.2)), V((x, sy * 0.2, 1.75)), 0.15, 0.15)
        k.box(WOOD, (0.18, 0.7, 0.16), V((x, 0, 1.72)))
    return finish(k, name + ('_far' if far else ''), 0.8)


KINDS = ['minka0', 'minka1', 'kura', 'koya', 'torii', 'suisha']

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for far in (False, True):
        for me in (
            minka('minka0', L=12.5, D=7.2, H=2.5, pitch=52, irimoya=True, seed=3, far=far),
            minka('minka1', L=8.8, D=5.8, H=2.35, pitch=50, irimoya=False, seed=8, far=far),
            kura('kura', far=far),
            koya('koya', far=far),
            torii('torii', far=far),
            suisha('suisha', far=far),
            suisha_wheel('suisha_wheel', far=far),
        ):
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
