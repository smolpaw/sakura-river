# The village's buildings (src/village.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/village.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin, its front (the veranda, the door) towards -y (Blender: z up;
# glTF: y up, so the front faces +z in the page), named as in KINDS, with a lighter `<kind>_far` model. Old farmhouses
# (minka) under thick thatch (kayabuki), the eaves cut in stepped courses: the big one hip-and-gable (irimoya) with
# crossed logs astride its ridge, the small one hipped (yosemune) with a grassed ridge; earthen walls between dark
# posts, shoji behind a veranda, storm shutters, an earth-floored entrance hall (doma) with a wide sliding door at the
# +x end; a white storehouse (kura) under tile; a board shed with firewood stacked along it; a torii for the temple's
# approach; a waterwheel (mizuguruma) and its mill hut (the wheel a model of its own, which the page turns).
# Shading in the vertex colours (ambient occlusion by ray casting, weathering); alpha: how much a part glows after
# dusk (the shoji's paper, lit from inside; _PANE: where on the paper, Kit.paper). For the Ultra tier each also has
# a detailed `<kind>_near` model, built after the full one from the same parts (none moved) and shaded as it
# (shared_ao), with finer parts added (`near`).
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
EARTH = srgb('#a68a66')      # the farmhouses' earthen walls (tsuchikabe): clay and straw (kind plaster, set by hand)
PAPER = srgb('#ece4cf')      # shoji
STONE = srgb('#7d776c')
THATCH = srgb('#94805c')     # aged thatch, greyed straw
THATCH_CUT = srgb('#b39b6a')  # the cut ends at the eaves
THATCH_D = srgb('#3a3226')
MOSS = srgb('#5d6332')
GRASS = srgb('#6b7a36')      # the turf on a grassed ridge
IRIS = srgb('#4b6a2a')       # the irises in it
BAMBOO = srgb('#8c7a4e')     # old split bamboo, weathered
TILE = srgb('#3e4044')
SHU = srgb('#c23b22')        # the torii's vermilion
BLACK = srgb('#1c1a19')
LOG = srgb('#5a4330'); LOG_END = srgb('#b89a6c')

# Surface kinds for the photographed textures (src/kinds.js KIND, the same numbers), stored per vertex as kind / 8 in the attribute
# _KIND: which photo a part takes, worked out from the palette colour it is painted in (scaled by shading or worn
# towards another, so the nearest entry by hue, then by brightness). Parts that glow (the shoji) take none.
K_NONE, K_THATCH, K_WOOD, K_PLASTER, K_STONE, K_TILE, K_PAINT, K_CARVED = 0, 1, 2, 3, 4, 5, 6, 7
PALETTE = [(WOOD, K_WOOD), (WOOD_L, K_WOOD), (WOOD_D, K_WOOD), (LOG, K_WOOD), (SHU, K_PAINT), (PLASTER, K_PLASTER), (STONE, K_STONE),
           (THATCH, K_THATCH), (THATCH_CUT, K_THATCH), (THATCH_D, K_THATCH), (MOSS, K_THATCH), (TILE, K_TILE), (BLACK, K_NONE)]


def surface_kind(c, glow=0.0, palette=PALETTE):
    if glow > 0:
        return K_NONE
    lum = lambda x: 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]
    chroma = lambda x: [v / (x[0] + x[1] + x[2] + 1e-9) for v in x[:3]]
    a = chroma(c)
    best = min(palette, key=lambda e: 100 * sum((x - y) ** 2 for x, y in zip(a, chroma(e[0])))
               + math.log((lum(c) + 1e-4) / (lum(e[0]) + 1e-4)) ** 2)
    return best[1]


class Kit:
    """Parts into one bmesh, each vertex its colour and glow (alpha); flat faces unless smooth."""

    def __init__(self, palette=PALETTE, pane=True):
        self.palette = palette  # (colour, kind) pairs surface_kind picks from
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Color')
        self.kind = self.bm.verts.layers.float.new('_KIND')
        # the shoji's paper: where on it a vertex lies, for the page's lattice and lamplight (paper(); 0 elsewhere).
        # Only the buildings, whose material (villageMaterial) reads it; models without paper pass pane=False.
        self.pane = self.bm.verts.layers.float_vector.new('_PANE') if pane else None
        self.force = None  # a kind for the parts made meanwhile, in place of surface_kind's guess

    def paint(self, v, c, glow):
        v[self.col] = (*c, glow)
        v[self.kind] = (self.force if self.force is not None else surface_kind(c, glow, self.palette)) / 8

    def mesh(self, verts, faces, c, glow=0.0, smooth=False):
        vs = [self.bm.verts.new(p) for p in verts]
        for v in vs:
            self.paint(v, c, glow)
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
            self.paint(v, c, g)
        for f in self.bm.faces[f0:]:
            f.smooth = True

    def paper(self, s, a, b, z0, z1, o, lamp, panels=2):
        """a run of shoji's paper, `panels` panels from t = a to b along side s (Side), z0 to z1, o out from the side's
        middle line, lit from inside after dusk; their lattice (kumiko) is drawn by the page (materials.js
        villageMaterial), so each vertex keeps where it lies (_PANE): along the run in the lattice's columns (three
        a panel), up it in its rows (six), and its distance along the wall from its room's lamp (m, at t = lamp),
        stored as x / 8, y / 8, z / 4"""
        cw, rh = (b - a) / panels / 3, (z1 - z0) / 6
        nu, nv = panels * 2, 3  # (a grid, so the occlusion shades it smoothly)
        pts = [(lerp(a, b, i / nu), lerp(z0, z1, j / nv)) for j in range(nv + 1) for i in range(nu + 1)]
        faces = [(j * (nu + 1) + i, j * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i) for j in range(nv) for i in range(nu)]
        vs = self.mesh([s.at(t, o, z) for t, z in pts], faces, PAPER, 1.0)
        for v, (t, z) in zip(vs, pts):
            v[self.pane] = ((t - a) / cw / 8, (z - z0) / rh / 8, (t - lamp) / 4)
        return vs

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
            self.paint(v, col(p, n) if callable(col) else col, glow)
            vs[key] = v
        for q in quads:
            try:
                self.bm.faces.new([vs[key] for key in q]).smooth = disp is not None if smooth is None else smooth
            except ValueError:
                pass
        return list(vs.values())

    def prism(self, ring_a, ring_b, cols, rows, col, smooth=False, flip=False):
        """the sides between two closed rings of corners (as many each), each side a grid of cols x rows cells, flat
        between its corners; col(p, u, t) -> (rgb, glow), u round the rings (0..1), t from ring_a to ring_b. Its faces
        face out of a ring that runs counter-clockwise seen from ring_b's side, or the other way with flip."""
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
                    self.paint(v, c, g)
                    row.append(v)
            grid.append(row)
        w = n * cols
        for j in range(rows):
            for i in range(w):
                q = (grid[j][i], grid[j][(i + 1) % w], grid[j + 1][(i + 1) % w], grid[j + 1][i])
                f = self.bm.faces.new(q[::-1] if flip else q)
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
            self.paint(v, c, g)
        for f in self.bm.faces[f0:]:
            f.smooth = True
        return new


# ---------- thatch ----------
def thatch(a, b, he, pitch, *, irimoya, T, voxel, target, seed, gable=0.6, smooth_iter=4):
    """A thick thatched roof over the eave rectangle 2a x 2b at height he: its top the lower of the four planes at
    `pitch` (hipped, yosemune), or for irimoya the hips only up to `gable` of the rise with a vertical gable above;
    T thick, the solid rounded by a voxel remesh (smooth_iter passes of smoothing: more on a finer grid, so it rounds
    off as much), lumpy, decimated to `target` triangles. Returns (mesh, ridge half-length (for irimoya: where the
    gable stands), ridge height, the height of the gable's base)."""
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
    # lumps: the thatch laid in courses, settled unevenly (none at its rim, which the eaves' cut edge covers)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    off3 = V((seed * 3.1, seed * 1.7, seed * 2.3))
    for v in bm.verts:
        q = v.co
        d = 0.06 * noise.noise(q * 0.45 + off3) + 0.025 * noise.noise(q * 1.6 + off3) + 0.008 * noise.noise(q * 6 + off3)
        v.co += v.normal * d * smoothstep(0.0, 0.7, min(a - abs(q.x), b - abs(q.y)))
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'thatch')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    me = evaluated(ob)
    return me, xg, he + hr, he + hg


# the near models' thatch: the same roof on a finer grid (smoothed as much)
NEAR_THATCH = dict(voxel_scale=0.62, smooth_scale=2.6, target_scale=3.2)
EAVE_IN = 0.35  # how far inside the eaves the thatch's body ends: the eaves' cut edge (eave_band) covers its rounded rim


def roof(k, a, b, he, pitch, *, irimoya, T, seed, wall, lod, voxel, target, gable=0.58):
    """A thatched roof over the eave rectangle 2a x 2b at height he (the top of its cut edge): the body (thatch(), on
    the same slopes, its rim EAVE_IN inside the eaves) and round it the eaves' cut edge (eave_band), T thick. wall:
    (how far in from the eaves, at what height) its underside meets the walls. voxel, target: the full model's
    thatch() grid and triangles (the far model's coarser, the near one's finer). Returns (ridge half-length, ridge
    height, the top of the hips: the irimoya's gable stands on it, and the roof's top surface f(x, y) -> z)."""
    p = math.tan(math.radians(pitch))
    i = EAVE_IN
    kw = dict(irimoya=irimoya, T=T * 0.9, seed=seed, gable=(b * gable - i) / (b - i))  # (the same gable on the inset roof)
    if lod == 'near':
        me, xg, rz, zg = near_thatch(a - i, b - i, he + i * p, pitch, voxel=voxel, target=target, **kw)
    elif lod == 'far':
        me, xg, rz, zg = thatch(a - i, b - i, he + i * p, pitch, voxel=voxel * 1.8, target=target * 0.18, **kw)
    else:
        me, xg, rz, zg = thatch(a - i, b - i, he + i * p, pitch, voxel=voxel, target=target, **kw)
    colour = thatch_colour(he, rz, seed)
    k.add_mesh(me, colour)
    eave_band(k, a, b, he, T, p, wall, seed, lod, colour)

    def surface(x, y):
        z = he + p * (b - abs(y))
        return z if irimoya and abs(x) <= xg else min(z, he + p * (a - abs(x)))
    return xg, rz, zg, surface


def eave_band(k, a, b, he, T, p, wall, seed, lod, roof_colour):
    """The eaves' cut edge round a thatched roof (2a x 2b, its corners rounded): the thatch cut square in three
    courses, each set back a little from the one above, a dark step under each; above, the top course runs up under
    the body's slope (coloured as it: roof_colour, thatch_colour's); below, its underside goes back up to the walls
    (wall: how far in, at what height). Its outline wavers a little, the same through every course. Far: one cut face
    for the three courses."""
    rc = 0.6
    seg = {'far': 1.2, 'full': 0.35, 'near': 0.14}[lod]
    nc = {'far': 2, 'full': 4, 'near': 7}[lod]
    nx, ny = max(1, round(2 * (a - rc) / seg)), max(1, round(2 * (b - rc) / seg))
    off = V((seed * 1.3, seed * 2.1, seed * 0.7))

    def outline(o):
        """(point, outward normal) round the outline o out from the eaves, counter-clockwise from above; as many
        points for every o"""
        A, B, r = a + o, b + o, max(rc + o, 0.02)
        cs = [V((A - r, B - r, 0)), V((r - A, B - r, 0)), V((r - A, r - B, 0)), V((A - r, r - B, 0))]
        out = []
        for ci in range(4):
            th0 = ci * math.pi / 2
            for j in range(nc + 1):
                n = V((math.cos(th0 + math.pi / 2 * j / nc), math.sin(th0 + math.pi / 2 * j / nc), 0))
                out.append((cs[ci] + n * r, n))
            n = out[-1][1]
            e0, e1 = cs[ci] + n * r, cs[(ci + 1) % 4] + n * r
            ns = nx if ci % 2 == 0 else ny
            out += [(e0.lerp(e1, j / ns), n) for j in range(1, ns)]
        return out
    base = [q for q, _ in outline(0.0)]
    wob = [(0.04 * noise.noise(q * 0.8 + off), 0.03 * noise.noise(q * 0.5 + off * 1.7)) for q in base]

    def ring(o, z):
        return [q + n * w + V((0, 0, z + dz)) for (q, n), (w, dz) in zip(outline(o), wob)]
    # (o, z, the face from this ring to the next)
    top = (-0.75, he + 0.75 * p - 0.06, 'top')
    if lod == 'far':
        rings = [top, (0.0, he + 0.06, 'cut'), (-0.24, he - T, 'soffit'), (-wall[0], wall[1], None)]
    else:
        rings = [top, (0.0, he + 0.06, 'cut'), (-0.03, he - 0.3 * T, 'under'), (-0.1, he - 0.3 * T, 'cut'),
                 (-0.13, he - 0.65 * T, 'under'), (-0.2, he - 0.65 * T, 'cut'), (-0.24, he - T, 'soffit'), (-wall[0], wall[1], None)]
    rng = random.Random(seed * 13 + 1)

    def colour(face):
        def col(q, u, t):
            if face == 'top':
                return roof_colour(q, (V((q.x, q.y, 0)).normalized() * 0.6 + V((0, 0, 0.8))))
            if face == 'cut':  # the straw's cut ends, weathered grey-brown, stippled, a little darker low in each course
                age = 0.35 + 0.3 * smoothstep(-0.3, 0.4, noise.noise(q * 0.6 + off))
                return THATCH_CUT.lerp(THATCH_D, age) * rng.uniform(0.72, 1.15) * (1 - 0.22 * t), 0.0
            if face == 'under':
                return THATCH_D * 0.7, 0.0
            return THATCH_D * rng.uniform(0.75, 0.9), 0.0
        return col
    k.force = K_THATCH
    for (o0, z0, face), (o1, z1, _) in zip(rings, rings[1:]):
        rows = 3 if lod == 'near' and face == 'cut' else 1
        k.prism(ring(o0, z0), ring(o1, z1), 1, rows, colour(face), smooth=face == 'cut', flip=True)
    k.force = None


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
        c = THATCH.lerp(THATCH_D, 0.25 * smoothstep(0.3, -0.2, noise.noise(co * 0.7 + off)))
        # rain streaks down the slope, darker low down where it stays damp; moss in patches on the lower courses
        c = c * (0.8 + 0.25 * noise.noise(V((co.x * 2.5, co.y * 2.5, co.z * 0.4)) + off)) * lerp(0.82, 1.08, h)
        # strips down the slope re-thatched (sashi-kaya) a few years apart, the newer straw paler
        along = co.x if abs(n.y) > abs(n.x) else co.y
        c = c * (1 + 0.14 * smoothstep(0.2, 0.45, noise.noise(V((along * 0.45, seed * 0.7, 0.5)) + off)))
        m = smoothstep(0.35, 0.7, noise.noise(co * 0.5 + off * 2) + 0.3 * (1 - h)) * smoothstep(0.1, 0.5, up) * 0.4
        return c.lerp(MOSS, m), 0.0
    return fn


def ridge_logs(k, x0, x1, surface, lod):
    """the ridge (the irimoya's, the mill's): a bundle of thatch along it under a cover of cedar bark, and crossed
    logs (umanori) astride it in pairs, a log laid along their forks (surface: the roof's top, roof())"""
    z = surface(0, 0)
    k.cyl(THATCH_D * 0.7, V((x0, 0, z - 0.12)), V((x1, 0, z - 0.12)), 0.3, seg=10)
    # the cover, arched over the ridge and down both slopes a little proud of the thatch, bamboo laid across it
    n, w = (4 if lod == 'far' else 10), 0.55
    arch = lambda y: surface(0, y) + 0.06 + 0.24 * max(0.0, 1 - (y / w) ** 2)
    over = [(w - 2 * w * i / n, arch(w - 2 * w * i / n) - z) for i in range(n + 1)]
    sweep(k, [V((x0 - 0.25, 0, z)), V((x1 + 0.25, 0, z))], over + [(y, dz - 0.1) for y, dz in reversed(over)], WOOD_D * 1.15)
    if lod == 'far':
        k.cyl(LOG * 0.9, V((x0 - 0.4, 0, z + 0.45)), V((x1 + 0.4, 0, z + 0.45)), 0.08, seg=5)
        return
    k.force = K_WOOD
    for i in range(int((x1 - x0 + 0.5) / 0.45) + 1):
        x = x0 - 0.25 + 0.2 + i * 0.45
        pts = [V((x, y, arch(y) + 0.015)) for y in (-w * 0.98, -w * 0.5, 0.0, w * 0.5, w * 0.98)]
        for pa, pb in zip(pts, pts[1:]):
            k.cyl(BAMBOO, pa, pb, 0.022, seg=5, cap=False)
    k.force = None
    zc = z + 0.38  # where each pair crosses
    m = max(3, int((x1 - x0) / 1.05) + 1)
    seg = 7 if lod == 'near' else 5
    for i in range(m):
        x = lerp(x0 + 0.2, x1 - 0.2, i / (m - 1))
        for s in (-1, 1):
            foot = V((x + s * 0.05, s * 0.75, arch(0.75) + 0.03))
            cross = V((x + s * 0.05, 0, zc))
            k.cyl(LOG * 0.8, foot, foot.lerp(cross, 1.3), 0.065, seg=seg)
    k.cyl(LOG * 0.9, V((x0 - 0.4, 0, zc + 0.12)), V((x1 + 0.4, 0, zc + 0.12)), 0.075, seg=8 if lod == 'near' else 6)


def ridge_grass(k, x0, x1, surface, seed, lod):
    """the ridge (the hipped roof's): earth packed over a bundle of thatch along it and grassed over (shibamune),
    tapering down the hips at its ends, irises growing along it"""
    rng = random.Random(seed * 7 + 3)
    e0, e1 = x0 - 0.9, x1 + 0.9
    nx = max(4, round((e1 - e0) / (0.6 if lod == 'far' else 0.2)))
    ny = 6 if lod == 'far' else 12
    w = 0.6
    off = V((seed * 2.3, seed * 1.1, 0.4))
    verts, faces = [], []
    for i in range(nx + 1):
        x = lerp(e0, e1, i / nx)
        taper = smoothstep(0.0, 0.9, min(x - e0, e1 - x))
        for j in range(ny + 1):
            y = lerp(-w, w, j / ny)
            lump = 0.05 * noise.noise(V((x * 1.7, y * 1.7, 0)) + off) if lod != 'far' else 0.0
            thick = (0.36 * (1 - (y / w) ** 2) + lump) * taper - 0.04
            verts.append(V((x, y, surface(x, y) + thick)))
    for i in range(nx):
        for j in range(ny):
            q = i * (ny + 1) + j
            faces.append((q, q + ny + 1, q + ny + 2, q + 1))
    vs = k.mesh(verts, faces, MOSS, smooth=True)
    for v in vs:  # the turf greener on top, earthier where it thins out at its edges
        c = MOSS.lerp(GRASS, smoothstep(0.1, 0.3, v.co.z - surface(v.co.x, v.co.y)))
        c = c * (0.85 + 0.25 * noise.noise(v.co * 2.2 + off))
        v[k.col] = (*c, 0.0)
    if lod == 'far':
        return
    k.force = K_NONE
    x = e0 + 0.5
    while x < e1 - 0.5:
        y = rng.uniform(-0.12, 0.12)
        foot = V((x, y, surface(x, y) + 0.3 * smoothstep(0.0, 0.9, min(x - e0, e1 - x)) - 0.02))
        for _ in range(6 if lod == 'near' else 4):
            ang, lean = rng.uniform(0, 2 * math.pi), rng.uniform(0.08, 0.35)
            tip = foot + V((math.cos(ang) * lean, math.sin(ang) * lean, rng.uniform(0.32, 0.55)))
            k.cyl(IRIS * rng.uniform(0.8, 1.15), foot, tip, 0.022, seg=3, r2=0.002, smooth=False)
        x += rng.uniform(0.3, 0.5)
    k.force = None


# ---------- walls ----------
def nail(k, at, out, s=0.011):
    """a square nail head on a face (out: its normal)"""
    t = out.orthogonal().normalized()
    w = out.cross(t)
    k.mesh([at + (t * x + w * y) * s for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))] + [at + out * s * 0.6],
           [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], BLACK * 1.6)


def plaster(seed, h):
    """white plaster for Kit.lattice_box (h tall): dusty, rain streaks running down from the top, grimier low down"""
    off = V((seed * 2.1, seed * 3.7, seed * 1.3))

    def col(p, n):
        across = p.x if abs(n.y) > abs(n.x) else p.y
        streak = smoothstep(0.1, 0.6, noise.noise(V((across * 2.5, 0, seed)) + off)) * smoothstep(-0.2, 0.5, p.z / h + 0.5)
        c = PLASTER * (0.97 + 0.05 * noise.noise(p * 1.5 + off))
        return c.lerp(PLASTER * V((0.78, 0.76, 0.72)), 0.55 * streak)
    return col


def earth(seed, h):
    """an earthen wall (tsuchikabe) for Kit.lattice_box (h tall): clay and chopped straw, mottled, streaked from the
    top where the rain runs, darker at its foot where it splashes"""
    off = V((seed * 1.7, seed * 2.9, seed * 0.9))

    def col(p, n):
        c = EARTH * (0.94 + 0.1 * noise.noise(p * 2.2 + off) + 0.04 * noise.noise(p * 9 + off))
        streak = smoothstep(0.15, 0.6, noise.noise(V((p.x * 3.1, 0, seed)) + off)) * smoothstep(-0.3, 0.5, p.z / h + 0.5)
        return c * (1 - 0.14 * streak) * lerp(0.86, 1.0, smoothstep(-0.5, -0.2, p.z / h))
    return col


class Side:
    """a wall's frame: n its outward normal, half the body's half-size across it, ln its length; t runs along it
    (Z x n), o out from its middle line, z up"""

    def __init__(self, n, half, ln):
        self.n, self.half, self.ln = n, half, ln
        self.t = V((0, 0, 1)).cross(n)
        self.rz = math.atan2(self.t.y, self.t.x)

    def at(self, t, o, z):
        return self.t * t + self.n * (self.half + o) + V((0, 0, z))


def strip(k, s, a, b, z0, z1, o, th, c, fine=None):
    """a board, panel or beam along side s from t = a to b, z0 to z1, th thick round o; fine: (col, cell) for the near
    model's lattice_box (its inner face left out)"""
    size, at = (b - a, th, z1 - z0), s.at((a + b) / 2, o, (z0 + z1) / 2)
    if fine:
        col, cell = fine
        k.lattice_box(size, at, (max(1, round(size[0] / cell)), 1, max(1, round(size[2] / cell))), col, rz=s.rz, skip=('+y',))
    else:
        k.box(c, size, at, rz=s.rz)


def minka_layout(L, D, doma, front, back, west, door):
    """The bays between the posts round a farmhouse L x D with its earth-floored entrance hall (doma) `doma` long at
    its +x end: per side [(t0, t1, kind, lamp)], t along the side (Side.t), the bays' kinds as bay() draws them.
    front, back: the kinds along the living part (the front's shoji, in twos, rooms each lit by a lamp low in its
    middle: lamp, its t); west: the -x end's; door: the doma's doorway on the +x end (t0, t1), the end wall beyond it
    in bays of under two metres."""
    hx, hy = L / 2, D / 2
    x1 = hx - doma

    def run(t0, t1, kinds):
        return [[t0 + (t1 - t0) * i / len(kinds), t0 + (t1 - t0) * (i + 1) / len(kinds), kd, None] for i, kd in enumerate(kinds)]
    F = run(-hx, x1, front) + run(x1, hx, ['earth', 'window'])
    i = 0
    while i < len(F):  # the rooms behind the shoji: two bays each
        if F[i][2] == 'shoji':
            j = i + 2 if i + 1 < len(F) and F[i + 1][2] == 'shoji' else i + 1
            for q in range(i, j):
                F[q][3] = (F[i][0] + F[j - 1][1]) / 2
            i = j
        else:
            i += 1
    n = math.ceil((hy - door[1]) / 1.95)
    return {
        'front': F,
        'back': run(-hx, -x1, ['window', 'earth']) + run(-x1, hx, back),  # (t = -x: the doma first)
        'west': run(-hy, hy, west),
        'east': [[-hy, door[0], 'earth', None], [door[0], door[1], 'door', None]] + run(door[1], hy, ['earth'] * n),
    }


SIDES = {'front': (V((0, -1, 0)), 'y'), 'west': (V((-1, 0, 0)), 'x'), 'back': (V((0, 1, 0)), 'y'), 'east': (V((1, 0, 0)), 'x')}


def walls(k, L, D, H, floor, lay, lod, seed):
    """the body: L long (x), D deep (y), walls H tall from a floor raised `floor` above the ground, round the bays of
    `lay` (minka_layout): dark posts and beams, earthen walls on a board skirt, shoji behind the veranda, storm
    shutters (amado) closed over some openings, small barred windows, the doma's wide board door slid half open on
    the +x end. Returns the wall plate's height."""
    hx, hy = L / 2, D / 2
    top = floor + H
    zs = dict(floor=floor, top=top, mid=floor + H * 0.55, kz=floor + 0.4, zk=floor + 1.76, plate=top - 0.19)
    near = lod == 'near'
    # foundation stones and the raised floor's skirt
    k.box(STONE * 0.85, (L + 0.3, D + 0.3, 0.25), V((0, 0, 0.12)))
    k.box(WOOD_D, (L, D, floor - 0.2), V((0, 0, 0.2 + (floor - 0.2) / 2)))
    for si, (name, bays) in enumerate(lay.items()):
        n, ax = SIDES[name]
        s = Side(n, hy if ax == 'y' else hx, L if ax == 'y' else D)
        for pi, t in enumerate(sorted({b[0] for b in bays} | {bays[-1][1]})):
            if ax == 'x' and abs(abs(t) - s.ln / 2) < 1e-6:
                continue  # (the corners' posts are the long sides')
            if near:
                k.lattice_box((0.18, 0.18, top), s.at(t, 0, top / 2), (3, 3, 9), wood(WOOD, si * 31 + pi, 0.06), rz=s.rz, skip=('-z',))
            else:
                k.box(WOOD, (0.18, 0.18, top), s.at(t, 0, top / 2), rz=s.rz)
        if lod == 'far':  # the earthen walls in one, the bays' parts before them
            k.force = K_PLASTER
            strip(k, s, -s.ln / 2, s.ln / 2, zs['kz'], zs['plate'], 0.0, 0.06, EARTH)
            k.force = None
        for bi, (t0, t1, kind, lamp) in enumerate(bays):
            bay(k, s, t0, t1, kind, lamp, zs, lod, seed * 101 + si * 17 + bi)
        # the wall plate
        e = 0.15
        strip(k, s, -s.ln / 2 - e, s.ln / 2 + e, top - 0.19, top - 0.01, 0, 0.2, WOOD,
              (wood(WOOD, si * 3 + 7, 0.1, 0), 0.25) if near else None)
    return top


def bay(k, s, t0, t1, kind, lamp, zs, lod, seed):
    """one bay of a wall, between the posts at t0 and t1 (side s): 'earth' (earthen wall over a board skirt, a tie
    beam across), 'window' (the same with a small barred window, renji-mado), 'shoji' (paper screens on their sill
    and lintel, a strip of earthen wall above; lamp: its room's lamp), 'amado' (storm shutters closed in their place),
    'door' (the doma's doorway, its wide board door slid half open along the wall beyond)"""
    far, near = lod == 'far', lod == 'near'
    a, b = t0 + 0.09, t1 - 0.09
    w, tc = b - a, (t0 + t1) / 2
    fl, mid, kz, zk, plate = zs['floor'], zs['mid'], zs['kz'], zs['zk'], zs['plate']
    fine = lambda col, cell: (col, cell) if near else None
    front = 0.035 if far else 0.0  # (far: before the side's wall in one, walls())

    def wall(x0, x1, z0, z1):
        if far:
            return
        k.force = K_PLASTER
        strip(k, s, x0, x1, z0, z1, 0.0, 0.06, EARTH, fine(earth(seed, z1 - z0), 0.25))
        k.force = None

    def skirt():
        strip(k, s, a, b, 0.25, kz, 0.045, 0.03, WOOD_L * 0.8, fine(wood(WOOD_L * 0.8, seed, 0.1, 2, 0.15, -w / 2), 0.1))
        if far:
            return
        strip(k, s, a, b, kz - 0.03, kz + 0.02, 0.07, 0.05, WOOD_D)  # its top rail
        for i in range(max(1, round(w / 0.45)) - 1):  # battens
            t = a + w * (i + 1) / max(1, round(w / 0.45))
            strip(k, s, t - 0.02, t + 0.02, 0.27, kz - 0.03, 0.07, 0.025, WOOD_D)
            if near:
                for z in (0.45, kz - 0.15):
                    nail(k, s.at(t, 0.083, z), s.n)

    def tie():
        if not far:
            strip(k, s, a, b, mid - 0.08, mid + 0.08, 0.0, 0.14, WOOD, fine(wood(WOOD, seed + 5, 0.1, 0), 0.25))

    def opening():
        """sill and lintel, and the strip of wall above"""
        strip(k, s, a, b, fl, fl + 0.05, 0.0, 0.14, WOOD_D)
        strip(k, s, a, b, zk, zk + 0.1, 0.0, 0.12, WOOD, fine(wood(WOOD, seed + 3, 0.1, 0), 0.25))
        wall(a, b, zk + 0.1, plate)

    if kind in ('earth', 'window'):
        skirt()
        tie()
        if kind == 'earth':
            wall(a, b, kz, plate)
            return
        ww, z0, z1 = min(0.9, w - 0.5), kz + 0.2, mid - 0.12
        l, r = tc - ww / 2, tc + ww / 2
        wall(a, b, kz, z0)
        wall(a, b, z1, plate)
        wall(a, l, z0, z1)
        wall(r, b, z0, z1)
        strip(k, s, l, r, z0, z1, -0.04 + 2 * front, 0.02, BLACK)
        if far:
            return
        for x0, x1, y0, y1 in ((l - 0.05, l, z0, z1), (r, r + 0.05, z0, z1), (l - 0.05, r + 0.05, z0 - 0.05, z0), (l - 0.05, r + 0.05, z1, z1 + 0.05)):
            strip(k, s, x0, x1, y0, y1, 0.03, 0.08, WOOD)
        m = max(3, round(ww / 0.1))
        for i in range(1, m):  # the bars
            t = l + ww * i / m
            strip(k, s, t - 0.017, t + 0.017, z0, z1, 0.0, 0.035, WOOD_D)
    elif kind == 'shoji':
        opening()
        k.paper(s, a, b, fl + 0.05, zk, -0.03 + 2 * front, lamp)
    elif kind == 'amado':
        opening()
        strip(k, s, a, b, fl + 0.05, zk, 0.03, 0.03, WOOD_L * 0.7, fine(wood(WOOD_L * 0.7, seed, 0.06, 2, 0.12, -w / 2), 0.06))
        if far:
            return
        m = max(2, round(w / 0.9))
        for i in range(1, m):  # where one shutter meets the next
            t = a + w * i / m
            strip(k, s, t - 0.012, t + 0.012, fl + 0.05, zk, 0.05, 0.015, WOOD_D)
        for f in (0.1, 0.5, 0.9):  # their cross battens
            z = lerp(fl + 0.05, zk, f)
            strip(k, s, a, b, z - 0.025, z + 0.025, 0.055, 0.02, WOOD_L * 0.55)
            if near:
                for i in range(m * 2):
                    nail(k, s.at(a + w * (i + 0.5) / (m * 2), 0.066, z), s.n, 0.008)
    elif kind == 'door':
        tie()
        wall(a, b, mid + 0.08, plate)
        strip(k, s, a, b, 0.25, mid - 0.08, -0.1 + 4 * front, 0.02, BLACK * 1.3)  # the dark doma inside
        # the door: boards on battens, as wide as the doorway, slid half open along the wall
        d = t1 - t0
        l0, l1 = t0 + d / 2, t1 + d / 2
        strip(k, s, l0, l1, 0.27, mid - 0.1, 0.13, 0.05, WOOD_L * 0.75, fine(wood(WOOD_L * 0.75, seed + 9, 0.1, 2, 0.2, -d / 2), 0.1))
        if not far:
            for z in (0.45, (mid + 0.17) / 2, mid - 0.3):
                strip(k, s, l0 + 0.04, l1 - 0.04, z - 0.04, z + 0.04, 0.17, 0.03, WOOD_D)
                if near:
                    for i in range(6):
                        nail(k, s.at(l0 + 0.15 + (d - 0.3) * i / 5, 0.187, z), s.n)
            strip(k, s, l0 + 0.06, l0 + 0.12, 0.95, 1.2, 0.17, 0.03, BLACK * 1.4)  # its pull


def veranda(k, L, D, floor, x0, x1, zk, lod):
    """the engawa along the front's living part (x0 to x1): a board deck at floor height on short posts on stones, a
    stone to step up from; the box the storm shutters are kept in (tobukuro) at its doma end, on the doma's wall"""
    hy = D / 2
    ln, xc = x1 - x0, (x0 + x1) / 2
    if lod == 'near':  # boards along it, a dark seam between
        k.lattice_box((ln, 0.95, 0.08), V((xc, -hy - 0.47, floor)), (round(ln / 0.3), 10, 1), wood(WOOD_L, 4, 0.1, 0, 0.19, -0.475))
    else:
        k.box(WOOD_L, (ln, 0.95, 0.08), V((xc, -hy - 0.47, floor)))
    k.box(WOOD_L * 0.7, (0.85, 0.3, zk + 0.08 - floor), V((x1 + 0.52, -hy - 0.24, (floor + zk + 0.08) / 2)))
    if lod == 'far':
        return
    m = max(1, round(ln / 1.8))
    for i in range(m + 1):
        x = x0 + 0.1 + i * (ln - 0.2) / m
        k.box(WOOD_D, (0.12, 0.12, floor), V((x, -hy - 0.85, floor / 2)))
        k.box(STONE, (0.3, 0.3, 0.12), V((x, -hy - 0.85, 0.05)))
    k.box(STONE * 1.1, (0.8, 0.5, 0.22), V((x0 + ln * 0.3, -hy - 1.35, 0.11)))  # the stepping stone
    k.box(WOOD_D, (0.9, 0.34, 0.05), V((x1 + 0.52, -hy - 0.24, zk + 0.1)))  # its lid
    if lod == 'near':  # its boards
        for i in range(1, 6):
            k.box(WOOD_D, (0.012, 0.31, zk + 0.02 - floor), V((x1 + 0.1 + 0.85 * i / 6, -hy - 0.24, (floor + zk + 0.04) / 2)))



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
    # each run of shoji's paper evenly (its few vertices' occlusion, interpolated, streaked it)
    seen = set()
    for v in bm.verts:
        if v.index in seen or v[k.col][3] <= 0:
            continue
        run, todo = [], [v]
        while todo:
            u = todo.pop()
            if u.index in seen:
                continue
            seen.add(u.index)
            run.append(u.index)
            todo += [e.other_vert(u) for e in u.link_edges if e.other_vert(u)[k.col][3] > 0]
        mean = sum(ao[i] for i in run) / len(run)
        for i in run:
            ao[i] = mean
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


def minka(name, *, L, D, H, pitch, irimoya, seed, lay, doma, ridge, far, near=False):
    """a farmhouse: L x D body, walls H round the bays of `lay` (minka_layout; the doma `doma` long at the +x end),
    under thatch reaching 1.15 m past the walls; ridge: 'logs' (ridge_logs) or 'grass' (ridge_grass)"""
    k = Kit()
    lod = 'far' if far else 'near' if near else 'full'
    floor = 0.55
    top = walls(k, L, D, H, floor, lay, lod, seed)
    veranda(k, L, D, floor, -L / 2, L / 2 - doma, floor + 1.76, lod)
    a, b = L / 2 + 1.15, D / 2 + 1.15
    he = top - 0.25
    xg, rz, zg, surface = roof(k, a, b, he, pitch, irimoya=irimoya, T=0.68, seed=seed, wall=(1.15, top - 0.05), lod=lod, voxel=0.09, target=4400)
    if irimoya:
        # the gable: a dark board triangle set back on the hips, a smoke vent lattice
        for s in (-1, 1):
            x = s * (xg - 0.12)
            z0, z1 = zg - 0.15, rz - 0.25
            w = (z1 - z0) / math.tan(math.radians(pitch))
            k.mesh([V((x, -w, z0)), V((x, w, z0)), V((x, 0, z1))], [(0, 1, 2) if s > 0 else (0, 2, 1)], WOOD_D)
            if not far:
                for j in range(4):
                    yy = -w * 0.4 + j * w * 0.8 / 3
                    k.box(WOOD_L * 0.7, (0.06, 0.05, (z1 - z0) * 0.35), V((x + s * 0.03, yy, z0 + (z1 - z0) * 0.32)))
            if near:  # the vent's cross bars and its frame
                for zz in (0.16, 0.48):
                    k.box(WOOD_L * 0.6, (0.05, w * 0.95, 0.04), V((x + s * 0.035, 0, z0 + (z1 - z0) * zz)))
    if ridge == 'logs':
        ridge_logs(k, -xg, xg, surface, lod)
    else:
        ridge_grass(k, -xg, xg, surface, seed, lod)
    return finish(k, name + suffix(far, near))


def kura(name, *, far, near=False):
    """a storehouse: thick white plaster walls on a grey tiled skirt (namako), two storeys under a tile gable roof, the
    plaster stepped out under the eaves; a deep stepped doorway, its thick plaster doors open, a tiled hood over it"""
    k = Kit()
    L, D, H = 4.6, 3.6, 5.2
    hx, hy = L / 2, D / 2
    k.box(STONE * 0.8, (L + 0.4, D + 0.4, 0.45), V((0, 0, 0.22)))
    if near:
        k.lattice_box((L, D, H), V((0, 0, 0.45 + H / 2)), (14, 11, 16), lambda p, n: plaster(31, H)(p, n) * 1.04, skip=('-z',))
    else:
        k.box(PLASTER * 1.04, (L, D, H), V((0, 0, 0.45 + H / 2)))
    # namako skirt: grey square tiles set diagonally, the white plaster of their joints raised over them in a lattice
    k.box(TILE * 1.4, (L + 0.06, D + 0.06, 1.2), V((0, 0, 0.45 + 0.6)))
    k.box(PLASTER, (L + 0.12, D + 0.12, 0.08), V((0, 0, 1.68)))  # the skirt's coping
    if not far:
        trng = random.Random(41)
        z0, z1, step = 0.47, 1.63, 0.3 * math.sqrt(2)
        for n, half, ln in ((V((0, -1, 0)), hy, L), (V((-1, 0, 0)), hx, D), (V((0, 1, 0)), hy, L), (V((1, 0, 0)), hx, D)):
            s = Side(n, half, ln)
            e = ln / 2 - 0.02
            c1, c2 = -e - z1, z0 - e  # the first joints along t - z = c1 and t + z = c2
            for fam, c0, c9 in ((1, c1, e - z0), (-1, c2, e + z1)):
                c = c0
                while c < c9:
                    lo, hi = (max(z0, -e - c), min(z1, e - c)) if fam > 0 else (max(z0, c - e), min(z1, c + e))
                    if hi - lo > 0.05:
                        t = lambda z: z + c if fam > 0 else c - z
                        pa, pb = s.at(t(lo), 0.04, lo), s.at(t(hi), 0.04, hi)
                        k.beam(PLASTER, pa, pb, 0.04, 0.02, up=n)
                        if near:  # rounded over (namako: sea-cucumber)
                            k.cyl(PLASTER * 1.03, pa + n * 0.012, pb + n * 0.012, 0.02, seg=6)
                    c += step
            if near:  # each tile a shade of its own: a diamond on it between the joints
                for i in range(int((e - z0 - c1) / step) + 1):
                    for j in range(int((e + z1 - c2) / step) + 1):
                        a_, b_ = c1 + (i + 0.5) * step, c2 + (j + 0.5) * step
                        tt, zz = (a_ + b_) / 2, (b_ - a_) / 2
                        if abs(tt) < e - 0.2 and z0 + 0.18 < zz < z1 - 0.18:
                            q = [s.at(tt + dx, 0.032, zz + dz) for dx, dz in ((0, -0.17), (0.17, 0), (0, 0.17), (-0.17, 0))]
                            k.mesh(q, [(0, 1, 2, 3)], TILE * 1.4 * trng.uniform(0.75, 1.2))
    # the door: set in a deep surround stepped in three (jabara), its two thick plaster doors (kannon-biraki) swung
    # open against it, the dark board door behind them studded with iron; a small tiled hood over it
    zd, wd, hd = 0.45, 1.3, 2.1
    for i, (m, d) in enumerate(((0.1, 0.3), (0.2, 0.22), (0.3, 0.14))):
        for x0, x1, za, zb in ((-wd / 2 - m, -wd / 2 - m + 0.1, zd, zd + hd + m), (wd / 2 + m - 0.1, wd / 2 + m, zd, zd + hd + m),
                               (-wd / 2 - m, wd / 2 + m, zd + hd + m - 0.1, zd + hd + m)):
            k.box(PLASTER * (1.02 - 0.03 * i), (x1 - x0, d, zb - za), V(((x0 + x1) / 2, -hy - d / 2 + 0.02, (za + zb) / 2)))
    k.box(WOOD_D, (wd, 0.1, hd), V((0, -hy - 0.05, zd + hd / 2)))
    for s in (-1, 1):  # the plaster doors, open square to the wall at the surround's edge, their edges stepped
        x = s * (wd / 2 + 0.4 + 0.09)
        k.box(PLASTER * 1.02, (0.18, 0.66, hd + 0.1), V((x, -hy - 0.3 - 0.33, zd + hd / 2 + 0.05)))
        if not far:
            k.box(PLASTER * 0.97, (0.06, 0.52, hd - 0.06), V((x - s * 0.12, -hy - 0.3 - 0.33, zd + hd / 2 + 0.05)))
    if near:  # the board door's iron studs and bands
        for x in (-0.45, -0.15, 0.15, 0.45):
            for z in (0.85, 1.45, 2.05):
                nail(k, V((x, -hy - 0.1, z)), V((0, -1, 0)), 0.018)
        for z in (0.75, 2.25):
            k.box(BLACK * 1.4, (1.32, 0.01, 0.07), V((0, -hy - 0.105, z)))
    hz, ha, hb = zd + hd + 0.55, wd / 2 + 0.75, 0.9
    k.mesh([V((-ha, -hy + 0.02, hz)), V((ha, -hy + 0.02, hz)), V((ha, -hy - hb, hz - 0.35)), V((-ha, -hy - hb, hz - 0.35))], [(3, 2, 1, 0)], TILE)
    k.mesh([V((-ha, -hy + 0.02, hz - 0.1)), V((ha, -hy + 0.02, hz - 0.1)), V((ha, -hy - hb, hz - 0.45)), V((-ha, -hy - hb, hz - 0.45))], [(0, 1, 2, 3)], WOOD_D)
    k.box(TILE * 0.8, (2 * ha, 0.12, 0.14), V((0, -hy - hb, hz - 0.4)))
    if not far:
        for i in range(int(2 * ha / 0.25) + 1):
            x = -ha + 0.1 + i * 0.25
            if x < ha - 0.05:
                k.beam(TILE * 0.75, V((x, -hy - hb, hz - 0.31)), V((x, -hy, hz + 0.04)), 0.08, 0.06)
        for s in (-1, 1):  # its brackets
            k.beam(WOOD_D, V((s * (ha - 0.2), -hy, hz - 0.9)), V((s * (ha - 0.2), -hy - hb + 0.1, hz - 0.42)), 0.08, 0.08)
    # the upper window: a stepped plaster frame, its two plaster shutters open flat against the wall
    wz = zd + 3.9
    k.box(BLACK, (0.7, 0.12, 0.7), V((0, -hy - 0.04, wz)))
    for x0, x1, za, zb in ((-0.5, -0.35, wz - 0.5, wz + 0.5), (0.35, 0.5, wz - 0.5, wz + 0.5), (-0.5, 0.5, wz + 0.35, wz + 0.5), (-0.5, 0.5, wz - 0.5, wz - 0.35)):
        k.box(PLASTER, (x1 - x0, 0.16, zb - za), V(((x0 + x1) / 2, -hy - 0.06, (za + zb) / 2)))
    for s in (-1, 1):
        k.box(PLASTER * 0.98, (0.42, 0.1, 0.8), V((s * 0.75, -hy - 0.05, wz)))
    # under the eaves, the plaster stepped out in bands along the long sides
    for i, (dz, d) in enumerate(((0.12, 0.1), (0.27, 0.07), (0.4, 0.04))):
        k.box(PLASTER * (1.03 - 0.02 * i), (L + 2 * d, D + 2 * d, 0.13), V((0, 0, 0.45 + H - dz)))
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
    k.force = K_WOOD
    c = k.mesh(rings[0] + rings[1] + [b], [], LOG_END * shade)
    k.force = None
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
                    k.force = K_WOOD
                    k.cyl(LOG_END * shade, V((x, D / 2 + 0.55, z)), V((x, D / 2 + 0.56, z)), 0.08, seg=5, smooth=False)
                    k.force = None
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
    lod = 'far' if far else 'near' if near else 'full'
    xg, rz, zg, surface = roof(k, L / 2 + 0.7, D / 2 + 0.7, 2.35, 48, irimoya=False, T=0.5, seed=21, wall=(0.7, 2.45), lod=lod,
                               voxel=0.08, target=1500)
    ridge_logs(k, -xg, xg, surface, lod)
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
            minka('minka0', L=12.5, D=7.2, H=2.5, pitch=52, irimoya=True, seed=3, doma=3.6, ridge='logs', far=far, near=near,
                  lay=minka_layout(12.5, 7.2, 3.6, ['shoji'] * 4 + ['amado'], ['earth', 'amado', 'earth', 'earth', 'window'],
                                   ['earth', 'earth', 'window', 'earth'], (-3.0, -1.2))),
            minka('minka1', L=8.8, D=5.8, H=2.35, pitch=50, irimoya=False, seed=8, doma=2.8, ridge='grass', far=far, near=near,
                  lay=minka_layout(8.8, 5.8, 2.8, ['shoji', 'shoji', 'amado'], ['earth', 'amado', 'window'], ['earth', 'window', 'earth'],
                                   (-2.4, -0.8))),
            kura('kura', far=far, near=near),
            koya('koya', far=far, near=near),
            torii('torii', far=far, near=near),
            suisha('suisha', far=far, near=near),
            suisha_wheel('suisha_wheel', far=far, near=near),
        ):
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True, export_attributes=True)
