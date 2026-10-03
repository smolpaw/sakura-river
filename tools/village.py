# The village's buildings (src/village.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/village.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin, its front (the veranda, the door) towards -y (Blender: z up;
# glTF: y up, so the front faces +z in the page), named as in KINDS, with a lighter `<kind>_far` model. Old farmhouses
# (minka) under thick thatch (kayabuki): the big one hip-and-gable (irimoya), the small one hipped (yosemune);
# a white storehouse (kura) under tile; a board shed with firewood stacked along it; a torii for the temple's approach;
# a waterwheel (mizuguruma) and its mill hut (the wheel a model of its own, which the page turns).
# Shading in the vertex colours (ambient occlusion by ray casting, weathering); alpha: how much a part glows after
# dusk (the shoji's paper, lit from inside). For the Ultra tier each also has a detailed `<kind>_near` model, built
# after the full one from the same parts (none moved) and shaded as it (shared_ao), with finer parts added (`near`).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, evaluated, tris, vertex_ao, tube

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

    # the near models' finer parts (`<kind>_near`, the Ultra tier's level for objects seen from a metre or two)
    def lattice_box(self, size, at, div, col, disp=None, rz=0.0, glow=0.0, skip=(), smooth=None):
        """box()'s box with its faces divided into grids (div: cells along x, y, z) that share their edges, each vertex
        pushed in along its normal by disp(p, n) and coloured col(p, n) -> rgb, both in the box's own frame (centred
        on it); smooth shaded when displaced, so its arrises read a little rounded (undisplaced, flat like box()). skip:
        faces left out, e.g. ('-z',)."""
        s = V(size) / 2
        m = Matrix.Translation(at) @ Matrix.Rotation(rz, 4, 'Z')
        pts, nor, quads = {}, {}, []
        for ax in range(3):
            for sign in (-1, 1):
                if ('-' if sign < 0 else '+') + 'xyz'[ax] in skip:
                    continue
                ua, va = (ax + 1) % 3, (ax + 2) % 3  # e_ua x e_va = e_ax
                nu, nv = div[ua], div[va]
                n = V((0.0, 0.0, 0.0))
                n[ax] = sign
                keys = []
                for j in range(nv + 1):
                    for i in range(nu + 1):
                        p = V((0.0, 0.0, 0.0))
                        p[ax] = sign * s[ax]
                        p[ua] = -s[ua] + 2 * s[ua] * i / nu
                        p[va] = -s[va] + 2 * s[va] * j / nv
                        key = tuple(round(x * 1e5) for x in p)
                        if key not in pts:
                            pts[key], nor[key] = p, V((0.0, 0.0, 0.0))
                        nor[key] += n
                        keys.append(key)
                for j in range(nv):
                    for i in range(nu):
                        q = [keys[j * (nu + 1) + i], keys[j * (nu + 1) + i + 1], keys[(j + 1) * (nu + 1) + i + 1], keys[(j + 1) * (nu + 1) + i]]
                        quads.append(q if sign > 0 else q[::-1])
        vs = {}
        for key, p in pts.items():
            n = nor[key].normalized()
            q = p - n * disp(p, n) if disp else p
            v = self.bm.verts.new(m @ q)
            v[self.col] = (*(col(p, n) if callable(col) else col), glow)
            vs[key] = v
        for q in quads:
            try:
                self.bm.faces.new([vs[key] for key in q]).smooth = disp is not None if smooth is None else smooth
            except ValueError:
                pass
        return list(vs.values())

    def prism(self, ring_a, ring_b, cols, rows, col, smooth=False):
        """the sides between two closed rings of corners (as many each), each side a grid of cols x rows cells, flat
        between its corners; col(p, u, t) -> (rgb, glow), u round the rings (0..1), t from ring_a to ring_b"""
        n = len(ring_a)
        grid = []
        for j in range(rows + 1):
            t = j / rows
            row = []
            for s in range(n):
                a = ring_a[s].lerp(ring_b[s], t)
                b = ring_a[(s + 1) % n].lerp(ring_b[(s + 1) % n], t)
                for i in range(cols):
                    p = a.lerp(b, i / cols)
                    c, g = col(p, (s + i / cols) / n, t)
                    v = self.bm.verts.new(p)
                    v[self.col] = (*c, g)
                    row.append(v)
            grid.append(row)
        w = n * cols
        for j in range(rows):
            for i in range(w):
                f = self.bm.faces.new((grid[j][i], grid[j][(i + 1) % w], grid[j + 1][(i + 1) % w], grid[j + 1][i]))
                f.smooth = smooth
        return [v for row in grid for v in row]

    def tube(self, pts, radii, seg, col):
        """forest.py's tube along pts, coloured col(p, along, around) -> (rgb, glow): along 0..1 over the points,
        around 0..1 round the tube (the tip: along 1)"""
        n0, f0 = len(self.bm.verts), len(self.bm.faces)
        tube(self.bm, pts, radii, seg)
        self.bm.verts.ensure_lookup_table()
        self.bm.faces.ensure_lookup_table()
        new = self.bm.verts[n0:]
        for idx, v in enumerate(new):
            j, i = divmod(idx, seg)
            c, g = col(v.co, min(1.0, j / max(1, len(pts) - 1)), i / seg if j < len(pts) else 0.0)
            v[self.col] = (*c, g)
        for f in self.bm.faces[f0:]:
            f.smooth = True
        return new


# ---------- thatch ----------
def thatch(a, b, he, pitch, *, irimoya, T, voxel, target, seed, gable=0.6, smooth_iter=4):
    """A thick thatched roof over the eave rectangle 2a x 2b at height he: its top the lower of the four planes at
    `pitch` (hipped, yosemune), or for irimoya the hips only up to `gable` of the rise with a vertical gable above;
    T thick, the solid rounded by a voxel remesh (smooth_iter passes of smoothing: more on a finer grid, so it rounds
    off as much), lumpy, decimated to `target` triangles. Returns (mesh, ridge half-length, ridge height, gable x,
    gable base height)."""
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
    sm.factor, sm.iterations = 0.5, smooth_iter
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


# the near models' thatch: the same roof on a finer grid (smoothed as much), its eaves' cut face finer still (eave_ends)
NEAR_THATCH = dict(voxel_scale=0.62, smooth_scale=2.6, target_scale=3.2)


def eave_ends(me, he, T):
    """the near thatch's cut face at the eaves, finer: its triangles there split in four, then laid in three courses
    (a groove between each, the middle one set back). Returns the mesh; its colour (eave_colour) stipples the
    straw's cut ends over it."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    band = lambda co: he - T - 0.15 < co.z < he + 0.12
    faces = [f for f in bm.faces if abs(f.normal.z) < 0.7 and band(f.calc_center_median())]
    edges = list({e for f in faces for e in f.edges})
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
    bm.normal_update()
    for v in bm.verts:
        if abs(v.normal.z) < 0.7 and band(v.co):
            f = (he - v.co.z) / T * 3  # courses, from the top of the cut face
            groove = smoothstep(0.18, 0.0, abs(f - round(f))) if 0.5 < f < 2.5 else 0.0
            back = 0.02 * smoothstep(0.9, 1.1, f) * smoothstep(2.1, 1.9, f)
            v.co -= v.normal * (0.02 * groove + back)
    out = bpy.data.meshes.new('thatch')
    bm.to_mesh(out)
    bm.free()
    return out


def eave_colour(fn, he, T, seed):
    """thatch_colour() with the cut ends stippled pale and dark, the courses' grooves in shadow"""
    rng = random.Random(seed)

    def col(co, n):
        c, g = fn(co, n)
        if abs(n.z) < 0.7 and he - T - 0.15 < co.z < he + 0.12:
            f = (he - co.z) / T * 3
            groove = smoothstep(0.18, 0.0, abs(f - round(f))) if 0.5 < f < 2.5 else 0.0
            c = c * rng.uniform(0.86, 1.12) * (1 - 0.2 * groove)
        return c, g
    return col


def wood(base, seed, cell, along=2, seams=0.0, start=0.0, dark=None):
    """weathered boards for Kit.lattice_box (cell: its grid's spacing): streaks of grain running along axis `along`
    (0 x, 1 y, 2 z), a few cells wide (finer detail cannot show in vertex colours); with `seams`, boards that wide
    across the grain from `start` (in the box's frame), a darker line where they meet (keep the seams on grid lines)"""
    off = V((seed * 3.3, seed * 1.9, seed * 4.1))
    f = 0.55 / cell
    dark = dark or base * 0.45

    def col(p, n):
        ax = max(range(3), key=lambda i: abs(n[i]))
        acr = 3 - ax - along if ax != along else (along + 1) % 3
        u, w = p[acr], p[along]
        g = noise.noise(V((u * f, w * 1.2, seed)) + off) * 0.75 + noise.noise(V((u * f * 1.9, w * 3, 1.7)) + off) * 0.25
        c = base * (1.0 + 0.4 * g)
        if seams:
            b = ((u - start) / seams) % 1
            board = int(math.floor((u - start) / seams))
            c = c * (0.88 + 0.24 * ((board * 7919 + seed) % 13) / 12)
            c = c.lerp(dark, smoothstep(cell * 0.6 / seams, 0.0, min(b, 1 - b)))
        return c
    return col


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
def nail(k, at, out, s=0.011):
    """a square nail head on a face (out: its normal)"""
    t = out.orthogonal().normalized()
    w = out.cross(t)
    k.mesh([at + (t * x + w * y) * s for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))] + [at + out * s * 0.6],
           [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], BLACK * 1.6)


def walls(k, L, D, H, floor, *, front_shoji, side_door, posts=1.8, detail=True, near=False):
    """the body: L long (x), D deep (y), walls H tall from a floor raised `floor` above the ground; posts and beams,
    plaster above a tie beam, boards below; the front (-y) shoji behind an open veranda, a side the earthen-floored
    entrance (doma), its door open. near: the boards' grain and seams, the battens' nails, stains on the plaster,
    the shoji's finer lattice."""
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
        out = V((0, sign, 0)) if n_axis == 'y' else V((sign, 0, 0))
        npost = max(2, round(ln / posts) + 1)
        for i in range(npost):
            t = -ln / 2 + ln * i / (npost - 1)
            pos = V((t, sign * hy, 0)) if n_axis == 'y' else V((sign * hx, t, 0))
            if near:
                k.lattice_box((0.18, 0.18, top), pos + V((0, 0, top / 2)), (3, 3, 9), wood(WOOD, side * 31 + i, 0.06), skip=('-z',))
            elif detail or i in (0, npost - 1):
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
        inner = ('+' if sign < 0 else '-') + n_axis  # the face inside the house
        cells = lambda h, c: (max(1, round((L - 0.1) / c)), 1, max(1, round(h / 0.6))) if n_axis == 'y' else (1, max(1, round((D - 0.1) / c)), max(1, round(h / 0.6)))
        if side == 0 and front_shoji:
            # shoji: paper panels on a lattice (kumiko), lit from inside after dusk; a plaster band above
            k.box(PAPER, size(H * 0.78), c0 + V((0, 0, floor + H * 0.39)), glow=1.0)
            if detail:
                for i in range(int(L / 0.45)):
                    x = -hx + 0.2 + i * 0.45
                    k.box(WOOD_L, (0.03, 0.08, H * 0.78), V((x, -hy + 0.02, floor + H * 0.39)))
                for j in range(1, 6):
                    k.box(WOOD_L, (L - 0.1, 0.08, 0.03), V((0, -hy + 0.02, floor + H * 0.78 * j / 6)))
            if near:  # the kumiko's thinner bars between
                for i in range(int(L / 0.45)):
                    x = -hx + 0.2 + i * 0.45 + 0.225
                    if x < hx - 0.08:
                        k.box(WOOD_L * 1.1, (0.015, 0.07, H * 0.78), V((x, -hy + 0.02, floor + H * 0.39)))
                for j in range(12):
                    if j % 2:
                        k.box(WOOD_L * 1.1, (L - 0.1, 0.07, 0.015), V((0, -hy + 0.02, floor + H * 0.78 * j / 12)))
            k.box(PLASTER, size(H * 0.22), c0 + V((0, 0, floor + H * 0.89)))
        else:
            if near:
                h = mid - 0.2
                w = (L if n_axis == 'y' else D) - 0.1
                k.lattice_box(size(h), c0 + V((0, 0, 0.2 + h / 2)), cells(h, 0.1), wood(WOOD_L * 0.85, side * 7 + 1, 0.1, 2, 0.2, -w / 2),
                              skip=(inner,))
                k.lattice_box(size(top - mid), c0 + V((0, 0, mid + (top - mid) / 2)), cells(top - mid, 0.25), plaster(side * 5 + 2, top - mid),
                              skip=(inner,))
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
                    if near:  # nailed to every other board
                        for i in range(int((ln - 0.3) / 0.4)):
                            t = -ln / 2 + 0.25 + i * 0.4
                            at = V((t, sign * (hy + 0.045), z)) if n_axis == 'y' else V((sign * (hx + 0.045), t, z))
                            nail(k, at, out)
        # tie beam and wall plate
        for z in (mid, top - 0.1):
            if near:
                sz = (L + 0.3, 0.2, 0.18) if n_axis == 'y' else (0.2, D + 0.3, 0.18)
                at = V((0, sign * hy, z)) if n_axis == 'y' else V((sign * hx, 0, z))
                k.lattice_box(sz, at, (round(sz[0] / 0.25), 2, 2) if n_axis == 'y' else (2, round(sz[1] / 0.25), 2),
                              wood(WOOD, side * 3 + int(z * 10), 0.1, 0 if n_axis == 'y' else 1))
            elif n_axis == 'y':
                k.box(WOOD, (L + 0.3, 0.2, 0.18), V((0, sign * hy, z)))
            else:
                k.box(WOOD, (0.2, D + 0.3, 0.18), V((sign * hx, 0, z)))
    if side_door:
        # the doma's entrance on the right end: a dark opening, the board door slid aside
        k.box(BLACK, (0.12, 1.5, 1.9), V((hx + 0.02, -hy + 1.4, 1.05)))
        if near:
            k.lattice_box((0.06, 1.4, 1.85), V((hx + 0.08, -hy + 2.9, 1.05)), (1, 14, 4), wood(WOOD_L, 9, 0.1, 2, 0.2, -0.7))
            for z in (0.4, 1.7):  # its battens
                k.box(WOOD_D, (0.03, 1.35, 0.08), V((hx + 0.125, -hy + 2.9, z)))
        else:
            k.box(WOOD_L, (0.06, 1.4, 1.85), V((hx + 0.08, -hy + 2.9, 1.05)))
    return top


def plaster(seed, h):
    """white plaster for Kit.lattice_box (h tall): dusty, rain streaks running down from the top, grimier low down"""
    off = V((seed * 2.1, seed * 3.7, seed * 1.3))

    def col(p, n):
        across = p.x if abs(n.y) > abs(n.x) else p.y
        streak = smoothstep(0.1, 0.6, noise.noise(V((across * 2.5, 0, seed)) + off)) * smoothstep(-0.2, 0.5, p.z / h + 0.5)
        c = PLASTER * (0.97 + 0.05 * noise.noise(p * 1.5 + off))
        return c.lerp(PLASTER * V((0.78, 0.76, 0.72)), 0.55 * streak)
    return col


def veranda(k, L, D, floor, detail=True, near=False):
    """the engawa along the front: a board deck at floor height on short posts"""
    hy = D / 2
    if near:  # boards along it, a dark seam between
        k.lattice_box((L, 0.95, 0.08), V((0, -hy - 0.47, floor)), (round(L / 0.3), 10, 1), wood(WOOD_L, 4, 0.1, 0, 0.19, -0.475))
    else:
        k.box(WOOD_L, (L, 0.95, 0.08), V((0, -hy - 0.47, floor)))
    if detail:
        for i in range(int(L / 1.8) + 1):
            x = -L / 2 + 0.1 + i * (L - 0.2) / max(1, int(L / 1.8))
            k.box(WOOD_D, (0.12, 0.12, floor), V((x, -hy - 0.85, floor / 2)))
            k.box(STONE, (0.3, 0.3, 0.12), V((x, -hy - 0.85, 0.05)))
        # a stepping stone
        k.box(STONE * 1.1, (0.8, 0.5, 0.22), V((L * 0.15, -hy - 1.35, 0.11)))


FULL_AO = {}  # the full models' occlusion by name, which their near models take on where they share its surface


def shared_ao(name, bm, ao, reach=0.02):
    """the occlusion of model `name` (bm, triangulated, ao per vertex): a full model's is kept; a near model
    (`<name>_near`, built after it) takes the full model's on the surface they share (within reach, facing the same
    way), so the two shade alike at the switch (the full one's few vertices spread its occlusion along whole parts),
    and keeps its own on the parts only it has"""
    if not name.endswith('_near'):
        if not name.endswith('_far'):
            FULL_AO[name] = ([v.co.copy() for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], list(ao))
        return ao
    cos, faces, fao = FULL_AO[name[:-5]]
    bvh = BVHTree.FromPolygons(cos, faces)
    out = []
    for v in bm.verts:
        loc, nrm, i, d = bvh.find_nearest(v.co, reach)
        if loc is None or nrm.dot(v.normal) < 0.5:
            out.append(ao[v.index])
            continue
        a, b, c = (cos[j] for j in faces[i])
        e0, e1, e2 = b - a, c - a, loc - a
        d00, d01, d11, d20, d21 = e0.dot(e0), e0.dot(e1), e1.dot(e1), e2.dot(e0), e2.dot(e1)
        den = d00 * d11 - d01 * d01 or 1e-12
        wb, wc = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
        out.append((1 - wb - wc) * fao[faces[i][0]] + wb * fao[faces[i][1]] + wc * fao[faces[i][2]])
    return out


def finish(k, name, ao_reach=1.2):
    """AO over the whole building, into the colours; one mesh named `name`"""
    bm = k.bm
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = shared_ao(name, bm, vertex_ao(bm, ao_reach), 0.1)  # (0.1: the near thatch is lumpier than the full)
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
def suffix(far, near):
    return '_far' if far else '_near' if near else ''


def near_thatch(a, b, he, pitch, *, voxel, target, **kw):
    """thatch() for a near model: the full model's roof on a finer grid (NEAR_THATCH)"""
    return thatch(a, b, he, pitch, voxel=voxel * NEAR_THATCH['voxel_scale'], target=target * NEAR_THATCH['target_scale'],
                  smooth_iter=round(4 * NEAR_THATCH['smooth_scale']), **kw)


def minka(name, *, L, D, H, pitch, irimoya, seed, far, near=False):
    """a farmhouse: L x D body, walls H, under thatch reaching 1.1 m past the walls"""
    k = Kit()
    floor = 0.55
    top = walls(k, L, D, H, floor, front_shoji=True, side_door=True, detail=not far, near=near)
    veranda(k, L, D, floor, detail=not far, near=near)
    a, b = L / 2 + 1.15, D / 2 + 1.15
    he = top - 0.25
    if near:
        me, xg, rz, hg = near_thatch(a, b, he, pitch, irimoya=irimoya, T=0.75, voxel=0.09, target=5200, seed=seed, gable=0.58)
        k.add_mesh(eave_ends(me, he, 0.75), eave_colour(thatch_colour(he, rz, seed), he, 0.75, seed))
    else:
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
            if near:  # the vent's cross bars and its frame
                for zz in (0.16, 0.48):
                    k.box(WOOD_L * 0.6, (0.05, w * 0.95, 0.04), V((x + s * 0.035, 0, z0 + (z1 - z0) * zz)))
    ridge(k, -xg, xg, rz - 0.05, 0.3, 0 if far else max(3, int(2 * xg / 1.1)))
    return finish(k, name + suffix(far, near))


def kura(name, *, far, near=False):
    """a storehouse: thick white plaster walls on a grey tiled skirt (namako), two storeys under a tile gable roof"""
    k = Kit()
    L, D, H = 4.6, 3.6, 5.2
    hx, hy = L / 2, D / 2
    k.box(STONE * 0.8, (L + 0.4, D + 0.4, 0.45), V((0, 0, 0.22)))
    if near:
        k.lattice_box((L, D, H), V((0, 0, 0.45 + H / 2)), (14, 11, 16), lambda p, n: plaster(31, H)(p, n) * 1.04, skip=('-z',))
    else:
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
    if near:
        # each tile a shade of its own, set in the skirt; the joints' plaster rounded over (namako: sea-cucumber)
        trng = random.Random(41)
        for s in range(4):
            sgn = -1 if s in (0, 2) else 1
            ln = L if s < 2 else D
            for i in range(8):
                for z0, z1 in ((0.47, 0.6), (0.6, 1.02), (1.02, 1.44), (1.44, 1.63)):
                    c = (-0.5 + (i + 0.5) / 8) * ln * 0.98
                    w, h = ln * 0.98 / 8 - 0.05, z1 - z0 - 0.04
                    sh = TILE * 1.4 * trng.uniform(0.8, 1.15)
                    if s < 2:
                        k.box(sh, (w, 0.012, h), V((c, sgn * (hy + 0.036), (z0 + z1) / 2)))
                    else:
                        k.box(sh, (0.012, w, h), V((sgn * (hx + 0.036), c, (z0 + z1) / 2)))
            for i in range(9):
                t = (-0.5 + i / 8) * ln * 0.98
                a, b = (V((t, sgn * (hy + 0.045), 0.47)), V((t, sgn * (hy + 0.045), 1.63))) if s < 2 else \
                    (V((sgn * (hx + 0.045), t, 0.47)), V((sgn * (hx + 0.045), t, 1.63)))
                k.cyl(PLASTER, a, b, 0.017, seg=6)
            for j in range(3):
                z = 0.6 + j * 0.42
                a, b = (V((-ln / 2 - 0.035, sgn * (hy + 0.05), z)), V((ln / 2 + 0.035, sgn * (hy + 0.05), z))) if s < 2 else \
                    (V((sgn * (hx + 0.05), -ln / 2 - 0.035, z)), V((sgn * (hx + 0.05), ln / 2 + 0.035, z)))
                k.cyl(PLASTER, a, b, 0.019, seg=6)
    # the heavy door and the upper window, their shutters dark
    k.box(WOOD_D, (1.3, 0.2, 2.1), V((0, -hy - 0.08, 0.45 + 1.05)))
    if near:  # its iron studs and hinges
        for x in (-0.45, -0.15, 0.15, 0.45):
            for z in (0.85, 1.45, 2.05):
                nail(k, V((x, -hy - 0.18, z)), V((0, -1, 0)), 0.018)
        for z in (0.75, 2.25):
            k.box(BLACK * 1.4, (1.32, 0.01, 0.07), V((0, -hy - 0.185, z)))
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
        if near:
            # the courses: each tile's lower edge across the slope, between the rows; round end tiles at the eaves
            n = int(b / math.cos(pitch) / 0.3)
            for j in range(1, n):
                f = j / n
                k.beam(TILE * 0.55, V((-a, s * b * (1 - f), he + (rz - he) * f + 0.018)), V((a, s * b * (1 - f), he + (rz - he) * f + 0.018)), 0.035, 0.03)
            for i in range(int(2 * a / 0.28) + 1):
                x = -a + 0.1 + i * 0.28
                k.cyl(TILE * 0.65, V((x, s * (b + 0.005), he + 0.03)), V((x, s * (b + 0.035), he + 0.03)), 0.065, seg=8, smooth=False)
    for s in (-1, 1):
        k.mesh([V((s * a, -b, he - 0.18)), V((s * a, b, he - 0.18)), V((s * a, b, he)), V((s * a, 0, rz)), V((s * a, -b, he))],
               [(0, 1, 2, 3, 4) if s > 0 else (4, 3, 2, 1, 0)], TILE * 0.9)
        k.box(PLASTER, (0.05, D, rz - he), V((s * (hx + 0.01), 0, he + (rz - he) / 3)))
    k.box(TILE * 0.7, (2 * a + 0.2, 0.42, 0.32), V((0, 0, rz + 0.12)))
    for s in (-1, 1):
        k.box(TILE * 0.6, (0.3, 0.5, 0.6), V((s * (a + 0.05), 0, rz + 0.3)))
        if near:  # the end tile's crest
            k.cyl(TILE * 0.5, V((s * (a + 0.2), 0, rz + 0.38)), V((s * (a + 0.23), 0, rz + 0.38)), 0.13, seg=10, smooth=False)
    return finish(k, name + suffix(far, near), 1.0)


def log_end(k, a, b, r, shade):
    """a sawn log end at b (the log from a): pale wood, a darker ring of bark round it, the heart darker"""
    d = (b - a).normalized()
    t = d.orthogonal().normalized()
    w = d.cross(t)
    rings = [[b + (t * math.cos(2 * math.pi * i / 8) + w * math.sin(2 * math.pi * i / 8)) * rr for i in range(8)] for rr in (r, r * 0.8)]
    c = k.mesh(rings[0] + rings[1] + [b], [], LOG_END * shade)
    for v in c[:8]:
        v[k.col] = (*(LOG * 0.8), 0.0)
    c[16][k.col] = (*(LOG_END * shade * 0.7), 0.0)
    for i in range(8):
        j = (i + 1) % 8
        for f in ((c[i], c[j], c[8 + j], c[8 + i]), (c[8 + i], c[8 + j], c[16])):
            k.bm.faces.new(f)


def koya(name, *, far, near=False):
    """a shed: boards under a single-pitched board roof weighted with stones, firewood stacked along its side"""
    k = Kit()
    L, D = 3.6, 2.6
    k.box(STONE * 0.8, (L + 0.2, D + 0.2, 0.15), V((0, 0, 0.07)))
    if near:
        k.lattice_box((L, D, 2.3), V((0, 0.0, 0.15 + 1.15)), (29, 21, 4), wood(WOOD_L * 0.8, 51, 0.125), skip=('-z',))
    else:
        k.box(WOOD_L * 0.8, (L, D, 2.3), V((0, 0.0, 0.15 + 1.15)))
    if not far:
        for i in range(int(L / 0.25)):
            x = -L / 2 + 0.12 + i * 0.25
            k.box(WOOD_D, (0.03, D + 0.04, 2.25), V((x, 0, 1.3)))
            if near:
                for z in (0.45, 1.3, 2.15):
                    for s in (-1, 1):
                        nail(k, V((x, s * (D / 2 + 0.02), z)), V((0, s, 0)), 0.009)
    k.box(BLACK, (1.2, 0.08, 1.8), V((0.4, -D / 2 - 0.02, 1.05)))
    # roof boards, sloping back, with stones on them
    h0, h1 = 2.8, 2.35
    k.mesh([V((-L / 2 - 0.4, -D / 2 - 0.6, h0)), V((L / 2 + 0.4, -D / 2 - 0.6, h0)), V((L / 2 + 0.4, D / 2 + 0.5, h1)), V((-L / 2 - 0.4, D / 2 + 0.5, h1))],
           [(0, 1, 2, 3)], WOOD * 0.85)
    k.mesh([V((-L / 2 - 0.4, -D / 2 - 0.6, h0 - 0.1)), V((L / 2 + 0.4, -D / 2 - 0.6, h0 - 0.1)), V((L / 2 + 0.4, D / 2 + 0.5, h1 - 0.1)), V((-L / 2 - 0.4, D / 2 + 0.5, h1 - 0.1))],
           [(3, 2, 1, 0)], WOOD_D)
    if near:  # the roof's boards: battens over their joints, down the slope
        for i in range(15):
            x = -L / 2 - 0.4 + (i + 0.5) * (L + 0.8) / 15
            k.beam(WOOD_D * 0.9, V((x, -D / 2 - 0.6, h0 + 0.012)), V((x, D / 2 + 0.5, h1 + 0.012)), 0.04, 0.025)
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
                shade = rng.uniform(0.85, 1.1)
                k.cyl(LOG, V((x, D / 2 + 0.05, z)), V((x, D / 2 + 0.55, z)), 0.085, seg=7 if near else 5)
                if near:
                    log_end(k, V((x, D / 2 + 0.05, z)), V((x, D / 2 + 0.56, z)), 0.082, shade)
                else:
                    k.cyl(LOG_END * shade, V((x, D / 2 + 0.55, z)), V((x, D / 2 + 0.56, z)), 0.08, seg=5, smooth=False)
    else:
        k.box(LOG * 1.2, (L, 0.5, 1.0), V((0, D / 2 + 0.3, 0.7)))
    return finish(k, name + suffix(far, near), 0.8)


def sweep(k, pts, profile, c, up=V((0, 0, 1))):
    """a beam along pts (in a vertical plane) with the cross-section `profile` [(across, up)], ends capped"""
    rings = []
    for j, p in enumerate(pts):
        t = (pts[min(j + 1, len(pts) - 1)] - pts[max(j - 1, 0)]).normalized()
        y = up.cross(t).normalized()
        z = t.cross(y)
        rings.append(k.mesh([p + y * a + z * b for a, b in profile], [], c))
    m = len(profile)
    for j in range(len(pts) - 1):
        for i in range(m):
            k.bm.faces.new((rings[j][i], rings[j][(i + 1) % m], rings[j + 1][(i + 1) % m], rings[j + 1][i]))
    k.bm.faces.new(list(reversed(rings[0])))
    k.bm.faces.new(rings[-1])


def torii(name, *, far, near=False):
    """a vermilion torii (myojin style): two leaning pillars on black footings, the tie beam through them, the upswept
    black top beam (kasagi) over the vermilion one (shimaki), the tablet's strut between"""
    k = Kit()
    span, H = 3.2, 4.4
    seg = 8 if far else 14
    rng = random.Random(61)
    for s in (-1, 1):
        base, topp = V((s * span / 2, 0, 0)), V((s * span / 2 * 0.94, 0, H))
        if near:
            # round, its lacquer weathered: paler where the sun and rain wear it, darker and grimy low down
            off = V((s * 7.0, 3.0, 1.0))

            def lacquer(p, u, t, off=off):
                wear = smoothstep(0.2, 0.6, noise.noise(V((u * 9, p.z * 0.6, 0)) + off))
                c = SHU * (0.92 + 0.12 * noise.noise(V((u * 20, p.z * 2, 0)) + off)) * lerp(0.7, 1.0, smoothstep(0.35, 1.2, p.z))
                return c.lerp(SHU * V((0.85, 0.75, 0.72)) * 1.15, 0.4 * wear), 0.0
            ring = lambda c, r: [c + V((math.cos(2 * math.pi * i / 24) * r, math.sin(2 * math.pi * i / 24) * r, 0)) for i in range(24)]
            k.prism(ring(base + V((0, 0, 0.35)), 0.17), ring(topp, 0.15), 1, 14, lacquer, smooth=True)
            k.cyl(BLACK, base, base + V((0, 0, 0.4)), 0.21, seg=24)
            k.cyl(BLACK * 1.6, base + V((0, 0, 0.36)), base + V((0, 0, 0.4)), 0.215, seg=24)  # the footing's band
        else:
            k.cyl(SHU, base + V((0, 0, 0.35)), topp, 0.17, seg=seg, r2=0.15)
            k.cyl(BLACK, base, base + V((0, 0, 0.4)), 0.21, seg=seg)
    # nuki (tie beam), through the pillars
    k.box(SHU, (span + 1.1, 0.18, 0.26), V((0, 0, H - 0.95)))
    if near:  # the wedges (kusabi) driven in beside each pillar
        for s in (-1, 1):
            xp = s * span / 2 * (1 - 0.06 * (H - 0.95) / H)
            k.box(SHU * 0.8, (0.07, 0.2, 0.14), V((xp + s * 0.21, 0, H - 0.95)))
    # gakuzuka strut and tablet
    k.box(SHU, (0.18, 0.16, 0.6), V((0, 0, H - 0.55)))
    k.box(BLACK, (0.42, 0.08, 0.55), V((0, -0.1, H - 0.55)))
    if near:  # the tablet's raised frame
        for x, z, w, h in ((0, 0.255, 0.42, 0.04), (0, -0.255, 0.42, 0.04), (0.19, 0, 0.04, 0.55), (-0.19, 0, 0.04, 0.55)):
            k.box(BLACK * 1.8, (w, 0.02, h), V((x, -0.145, H - 0.55 + z)))
    # shimaki and the kasagi, swept up at the ends
    n = 6 if far else 12
    curve = lambda t: V((t * (span / 2 + 1.0), 0, H + 0.2 + 0.22 * t ** 4))
    pts = [curve(-1 + 2 * i / n) for i in range(n + 1)]
    for i in range(n):
        k.beam(SHU, pts[i] - V((0, 0, 0.2)), pts[i + 1] - V((0, 0, 0.2)), 0.26, 0.2)
        if not near:
            k.beam(BLACK, pts[i] + V((0, 0, 0.05)), pts[i + 1] + V((0, 0, 0.05)), 0.36, 0.26)
    if near:
        # the kasagi swept smoothly, flat below, its top rising to a rounded crown, the ends cut square
        prof = [(-0.18, -0.13), (0.18, -0.13), (0.18, 0.095), (0.12, 0.12), (0.0, 0.13), (-0.12, 0.12), (-0.18, 0.095)]
        sweep(k, [curve(-1 + 2 * i / 36) + V((0, 0, 0.05)) for i in range(37)], prof, BLACK)
    return finish(k, name + suffix(far, near), 0.6)


def suisha_wheel(name, *, far, near=False):
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
            if near:  # the joints' iron straps, bolted
                k.beam(BLACK * 1.4, pts[i] * 0.985 + V((side * 0.052, 0, 0)), pts[i] * 1.03 + V((side * 0.052, 0, 0)), 0.006, 0.07, up=V((1, 0, 0)))
                nail(k, pts[i] + V((side * 0.058, 0, 0)), V((side, 0, 0)), 0.014)
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
        if near:  # it is two boards: the seam between them, and the water's dark stain along its outer edge
            m = (p0 + p1) / 2
            k.beam(WOOD_D, m - V((w / 2 + 0.045, 0, 0)), m + V((w / 2 + 0.045, 0, 0)), 0.045, 0.012, up=V((0, -s_, c)))
            e = p0.lerp(p1, 0.92)
            k.beam(WOOD_D * 0.7, e - V((w / 2 + 0.042, 0, 0)), e + V((w / 2 + 0.042, 0, 0)), 0.043, 0.04, up=V((0, -s_, c)))
    k.cyl(WOOD_D, V((-w / 2 - 0.15, 0, 0)), V((w / 2 + 0.15, 0, 0)), 0.3, seg=8)
    if near:  # the hub's iron bands, the axle's end through it
        for x in (-w / 2 - 0.1, w / 2 + 0.1):
            k.cyl(BLACK * 1.4, V((x - 0.03, 0, 0)), V((x + 0.03, 0, 0)), 0.31, seg=8)
        k.cyl(WOOD_D * 0.8, V((w / 2 + 0.15, 0, 0)), V((w / 2 + 0.25, 0, 0)), 0.12, seg=12)
    return finish(k, name + suffix(far, near), 0.8)


def suisha(name, *, far, near=False):
    """the waterwheel's mill: a small board hut with a thatched roof on the bank, the axle out of its side on a
    trestle (the wheel itself is suisha_wheel, turned by the page)"""
    k = Kit()
    L, D = 3.4, 3.0
    k.box(STONE * 0.8, (L + 0.3, D + 0.3, 0.3), V((0, 0, 0.15)))
    if near:
        k.lattice_box((L, D, 2.2), V((0, 0, 0.3 + 1.1)), (27, 24, 4), wood(WOOD_L * 0.75, 71, 0.125), skip=('-z',))
    else:
        k.box(WOOD_L * 0.75, (L, D, 2.2), V((0, 0, 0.3 + 1.1)))
    if not far:
        for i in range(int(L / 0.25)):
            x = -L / 2 + 0.12 + i * 0.25
            for sy in (-1, 1):
                k.box(WOOD_D, (0.03, 0.04, 2.15), V((x, sy * (D / 2 + 0.01), 1.4)))
                if near:
                    for z in (0.6, 1.4, 2.2):
                        nail(k, V((x, sy * (D / 2 + 0.03), z)), V((0, sy, 0)), 0.009)
    k.box(BLACK, (0.9, 0.06, 1.7), V((-0.6, -D / 2 - 0.02, 1.15)))
    if near:
        me, xg, rz, hg = near_thatch(L / 2 + 0.7, D / 2 + 0.7, 2.35, 48, irimoya=False, T=0.5, voxel=0.08, target=1800, seed=21)
        k.add_mesh(eave_ends(me, 2.35, 0.5), eave_colour(thatch_colour(2.35, rz, 21), 2.35, 0.5, 21))
    else:
        me, xg, rz, hg = thatch(L / 2 + 0.7, D / 2 + 0.7, 2.35, 48, irimoya=False, T=0.5, voxel=0.08 if not far else 0.14,
                                target=1800 if not far else 400, seed=21)
        k.add_mesh(me, thatch_colour(2.35, rz, 21))
    ridge(k, -xg, xg, rz - 0.05, 0.2, 0 if far else 3)
    # the axle out of the hut's river side (+x) to the wheel at (2.9, 0, 1.6), on trestles either side of the wheel
    k.cyl(WOOD_D, V((L / 2 - 0.2, 0, 1.6)), V((2.55, 0, 1.6)), 0.12, seg=16 if near else 8)
    if near:  # iron bands round the axle, and its bearing blocks on the trestles
        for x in (L / 2 + 0.1, 2.2, 2.5):
            k.cyl(BLACK * 1.4, V((x - 0.025, 0, 1.6)), V((x + 0.025, 0, 1.6)), 0.128, seg=16)
    for x in (2.25, 3.55):
        for sy in (-1, 1):
            k.beam(WOOD, V((x, sy * 0.55, -1.2)), V((x, sy * 0.2, 1.75)), 0.15, 0.15)
        k.box(WOOD, (0.18, 0.7, 0.16), V((x, 0, 1.72)))
        if near:
            for sy in (-1, 1):
                nail(k, V((x - 0.09, sy * 0.25, 1.72)), V((-1, 0, 0)), 0.014)
    return finish(k, name + suffix(far, near), 0.8)


KINDS = ['minka0', 'minka1', 'kura', 'koya', 'torii', 'suisha']

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # the full and far models, then the near ones (the Ultra tier's, which tools/blender.mjs puts in public/models/)
    for far, near in ((False, False), (True, False), (False, True)):
        for me in (
            minka('minka0', L=12.5, D=7.2, H=2.5, pitch=52, irimoya=True, seed=3, far=far, near=near),
            minka('minka1', L=8.8, D=5.8, H=2.35, pitch=50, irimoya=False, seed=8, far=far, near=near),
            kura('kura', far=far, near=near),
            koya('koya', far=far, near=near),
            torii('torii', far=far, near=near),
            suisha('suisha', far=far, near=near),
            suisha_wheel('suisha_wheel', far=far, near=near),
        ):
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
