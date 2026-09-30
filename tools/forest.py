# The woods' tree kinds (src/vegetation.js places them), built in Blender. Run through tools/forest.mjs:
#   blender -b --factory-startup -P tools/forest.py -- <out.glb>
# Each kind is one mesh, one unit tall, standing on its origin (Blender: z up; glTF: y up), named as in KINDS.
# Crowns are clusters of foliage clumps fused into one surface (voxel remesh), roughened and decimated to a triangle
# budget; limbs are tapered tubes from the trunk to the clumps. Shading lives in the vertex colours: ambient occlusion
# (ray cast against the whole tree), darker undersides, a little mottling; crown normals are bent out from the crown's
# middle so the light falls softly over it, as on a real crown seen from afar.
import bpy, bmesh, math, random, sys
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

BARK = (0.07, 0.055, 0.045)
V = Vector


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def link(me, name):
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def evaluated(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    return me


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


# ---------- foliage: clumps fused into one surface ----------
# clumps: [(centre, radii)]; voxel: remesh size; amp/freq: leafy roughness along the normal; target: triangles
def foliage(clumps, voxel, amp, freq, target, seed):
    rng = random.Random(seed)
    bm = bmesh.new()
    for c, r in clumps:
        # a clump is a cauliflower: a core and smaller tufts round its upper and outer side
        balls = [(c, V(r) * 0.8)]
        for _ in range(6):
            d = V((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1) + 0.5)).normalized()
            balls.append((c + V((d.x * r[0], d.y * r[1], d.z * r[2])) * 0.62, V(r) * rng.uniform(0.38, 0.5)))
        for bc, br in balls:
            bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0, matrix=Matrix.Translation(bc) @ Matrix.Diagonal((*br, 1.0)))
    me = bpy.data.meshes.new('clumps')
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'clumps')
    rm = ob.modifiers.new('remesh', 'REMESH')
    rm.mode, rm.voxel_size, rm.adaptivity = 'VOXEL', voxel, 0.0
    me = evaluated(ob)
    # roughen: small tufts over the fused surface (two octaves of noise along the normal)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    off = V((seed * 7.3, seed * 3.1, seed * 5.7))
    for v in bm.verts:
        p = v.co * freq + off
        d = noise.noise(p) * 0.65 + noise.noise(p * 2.3) * 0.35
        v.co += v.normal * d * amp
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'crown')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    return evaluated(ob)


# ---------- limbs ----------
def tube(bm, pts, radii, seg):
    n = len(pts)
    u = None
    rings = []
    for j, p in enumerate(pts):
        t = (pts[min(j + 1, n - 1)] - pts[max(j - 1, 0)]).normalized()
        if u is None:
            u = V((1, 0, 0)) if abs(t.z) > 0.9 else V((0, 0, 1))
        u = (u - t * u.dot(t)).normalized()
        w = t.cross(u)
        rings.append([bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * radii[j])
                      for a in (2 * math.pi * i / seg for i in range(seg))])
    for j in range(n - 1):
        for i in range(seg):
            k = (i + 1) % seg
            bm.faces.new((rings[j][i], rings[j][k], rings[j + 1][k], rings[j + 1][i]))
    tip = bm.verts.new(pts[-1] + (pts[-1] - pts[-2]).normalized() * radii[-1])
    for i in range(seg):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % seg], tip))


def limbs(paths, seg=5, twigs=()):
    bm = bmesh.new()
    for (pts, r0, r1), sg in [(p, seg) for p in paths] + [(p, 3) for p in twigs]:
        tube(bm, pts, [lerp(r0, r1, j / (len(pts) - 1)) for j in range(len(pts))], sg)
    me = bpy.data.meshes.new('limbs')
    bm.to_mesh(me)
    bm.free()
    return me


def bend(a, b, sag, rng):
    # a limb from a to b through a slightly raised, wandering middle
    m = (a + b) / 2 + V((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * (b - a).length * 0.08 + V((0, 0, sag))
    return [a, (a + m) / 2 + V((0, 0, sag * 0.3)), m, (m + b) / 2, b]


# ---------- shading and assembly ----------
DIRS = []
for i in range(32):  # cosine-weighted hemisphere about +z (Fibonacci spiral)
    r = math.sqrt((i + 0.5) / 32)
    a = i * 2.399963
    DIRS.append(V((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r)))))


def vertex_ao(bm, reach, same=lambda a, b: True):
    """Ambient occlusion per vertex of a triangulated bmesh (normals updated, verts indexed): rays over the hemisphere
    about each vertex's normal, then blurred twice over the neighbours that are `same` part (decimated meshes are
    coarse, and raw per-vertex occlusion shows their facets)."""
    bvh = BVHTree.FromBMesh(bm)
    ao = []
    for v in bm.verts:
        n = v.normal
        t = V((1, 0, 0)) if abs(n.x) < 0.9 else V((0, 1, 0))
        b1 = n.cross(t).normalized()
        b2 = n.cross(b1)
        o = v.co + n * 0.002
        hit = sum(1 for d in DIRS if bvh.ray_cast(o, (b1 * d.x + b2 * d.y + n * d.z), reach)[0] is not None)
        ao.append(1 - hit / len(DIRS))
    for _ in range(2):
        ao = [(ao[v.index] + sum(ao[e.other_vert(v).index] for e in v.link_edges if same(e.other_vert(v), v)))
              / (1 + sum(1 for e in v.link_edges if same(e.other_vert(v), v))) for v in bm.verts]
    return ao


def assemble(name, crowns, bark, mid, soft, low, ao_reach, mottle=None, ao_min=0.4):
    """crowns: [(mesh, colour)]; bark: mesh or None; mid(p): the point a crown point bulges out from; ao_min: the
    crown's shade in full occlusion."""
    bm = bmesh.new()
    kind = bm.verts.layers.int.new('kind')  # -1 bark, else index into crowns
    parts = [(me, i) for i, (me, _) in enumerate(crowns)] + ([(bark, -1)] if bark else [])
    for me, k in parts:
        n0 = len(bm.verts)
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        for v in bm.verts[n0:]:
            v[kind] = k
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, ao_reach, lambda a, b: a[kind] == b[kind])
    cols, nors = [], []
    for v in bm.verts:
        n, a, k = v.normal, ao[v.index], v[kind]
        if k < 0:
            c = [x * lerp(0.45, 1.0, a) for x in BARK]
            nors.append(n.copy())
        else:
            out = (v.co - mid(v.co)).normalized()
            shade = lerp(ao_min, 1.0, a) * lerp(low, 1.0, smoothstep(-0.7, 0.6, out.z))
            base = crowns[k][1]
            vary = 0.9 + 0.2 * noise.noise(v.co * 9.0 + V((3.1, 7.7, 1.3)))
            c = [x * shade * vary for x in base]
            if mottle:
                f = mottle[1] * smoothstep(0.1, 0.5, noise.noise(v.co * 14 + V((4, 0, 0))))
                c = [c[i] * lerp(1.0, mottle[0][i] / base[i], f) for i in range(3)]
            nors.append(n.lerp(out, soft).normalized())
        cols.append(c)
    bm.verts.layers.int.remove(kind)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()  # decimation leaves the odd duplicate face (vertices stay, so nors and cols still line up)
    me.normals_split_custom_set_from_vertices(nors)
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    link(me, name)
    return me


# ---------- the kinds ----------
def conifer(name, seed, *, w, base, n, taper, droop, size, col, target, level=0):
    """sugi / hinoki: a straight trunk under a crown of tufts, spiralling up, each tier widest at its foot."""
    rng = random.Random(seed)
    R = lambda t: w * (0.55 + 0.45 * smoothstep(0, 0.12, t)) * (1 - t) ** taper
    if level:  # fewer, bigger tufts: a small budget keeps their tiers only if there are few of them
        n, size = int(n * 0.4), size * 1.3
    clumps, smin = [], (0.018, 0.035, 0.035)[level]
    for i in range(n):
        t = (i + rng.random() * 0.8) / n
        z = base + t * (0.96 - base)
        a = i * 2.399963 + rng.uniform(-0.3, 0.3)
        r = R(t)
        d = r * rng.uniform(0.35, 0.7)
        s = max(smin, r * size * rng.uniform(0.8, 1.15))
        clumps.append((V((math.cos(a) * d, math.sin(a) * d, z)), (s, s, s * droop)))
    # the leader, reaching down into the top tier; the lighter levels' is a solid spire, as their small tufts at the
    # top decimate to floating shards
    clumps.append((V((0, 0, 0.95)), (0.016, 0.016, 0.06)) if not level else (V((0, 0, 0.88)), (smin, smin, 0.1)))
    crown = foliage(clumps, (0.0065, 0.0065, 0.014)[level], 0.005, 18, target * (1, 0.25, 0.09)[level], seed)
    bark = limbs([([V((0, 0, -0.04)), V((0, 0, base + 0.1)), V((0, 0, 0.84))], 0.024, 0.006)], (6, 4, 3)[level])
    return assemble(name + LEVELS[level], [(crown, col)], bark, lambda p: V((0, 0, p.z - 0.5 * math.hypot(p.x, p.y))), 0.75, 0.5, 0.12)


def broadleaf(name, seed, *, cz, ex, ez, fork, n, size, gap, col, target, low=0.4, n_limbs=4, mottle=None, flat=1.0, soft=0.85, ao_min=0.4, level=0):
    """A short trunk forking into limbs that carry clumps of leaves (or blossom) round an ellipsoidal crown."""
    rng = random.Random(seed)
    clumps = []
    tries = 0
    while len(clumps) < n and tries < 20000:
        tries += 1
        # a point in the crown's shell, the upper side favoured, none hanging far below
        d = V((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
        if d.z < -0.55:
            continue
        depth = rng.uniform(0.55, 0.95)
        p = V((d.x * ex * depth, d.y * ex * depth, cz + d.z * ez * depth))
        s = size * rng.uniform(0.75, 1.2)
        if any((p - c).length < gap * (s + r[0]) for c, r in clumps):
            continue
        clumps.append((p, (s, s, s * flat)))
    # a few clumps inside to close the crown where it would look hollow
    for _ in range(n // 5):
        p = V((rng.uniform(-0.5, 0.5) * ex, rng.uniform(-0.5, 0.5) * ex, cz + rng.uniform(-0.1, 0.35) * ez))
        clumps.append((p, (size * 0.9,) * 2 + (size * 0.9 * flat,)))
    crown = foliage(clumps, VOXEL[level] * 0.008, 0.01, 14, target * CROWN[level], seed)
    # limbs: the trunk forks at `fork` into n_limbs, each carrying the clumps on its side, twigs to each clump
    top = V((rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02), fork))
    paths, twigs = [([V((0, 0, -0.04)), V((0.005, 0, fork * 0.5)), top], 0.03, 0.022)], []
    phase = rng.random() * math.tau
    for L in range(n_limbs):
        a0 = phase + math.tau * L / n_limbs
        mine = [c for c, _ in clumps if (math.atan2(c.y, c.x) - a0 + math.pi) % math.tau - math.pi < math.pi / n_limbs
                and (math.atan2(c.y, c.x) - a0 + math.pi) % math.tau - math.pi >= -math.pi / n_limbs]
        if not mine:
            continue
        g = sum(mine, V()) / len(mine)
        end = top.lerp(g, 0.6)
        paths.append((bend(top, end, 0.02, rng), 0.019, 0.011))
        for c in mine:
            if not level and (c - end).length > 0.05 and c.z < cz + 0.15 * ez:  # twigs only where they can show, under the crown
                twigs.append(([end, end.lerp(c, 0.5) + V((0, 0, 0.02)), end.lerp(c, 0.85)], 0.009, 0.004))
    bark = limbs(paths, (5, 4, 3)[level], twigs)
    return assemble(name + LEVELS[level], [(crown, col)], bark, lambda p: V((0, 0, cz)), soft, low, 0.18, mottle, ao_min)


def pine(name, seed, *, col, target, level=0):
    """A black pine leaning out over a drop (+x): a crooked trunk, its limbs holding thick cloud-shaped pads of
    needles in tiers, ragged at their edges and flatter underneath, as the gardeners' pines are pruned."""
    rng = random.Random(seed)
    trunk = [V(a) for a in [(0, 0, -0.04), (0.04, 0.02, 0.2), (0.15, -0.03, 0.38), (0.33, 0.03, 0.5), (0.52, 0, 0.57), (0.7, 0.04, 0.6), (0.84, 0.02, 0.63)]]
    # pad centres (x, y, z) and radius: along the trunk and out over the drop, a crown on top
    pads = [(0.88, 0.02, 0.68, 0.19), (0.66, -0.2, 0.66, 0.16), (0.56, 0.22, 0.7, 0.15), (0.42, -0.16, 0.6, 0.14),
            (0.3, 0.18, 0.56, 0.13), (0.18, -0.12, 0.44, 0.1), (0.7, 0.12, 0.84, 0.15), (0.46, -0.04, 0.86, 0.15),
            (0.26, 0.04, 0.74, 0.12), (0.58, 0.02, 1.0, 0.12), (0.98, -0.12, 0.6, 0.11)]
    clumps, paths = [], [(trunk, 0.04, 0.014)]
    for x, y, z, s in pads:
        c = V((x, y, z))
        for i in range(9):  # a ragged ring of tufts
            a = i * math.tau / 9 + rng.uniform(-0.25, 0.25)
            d = s * rng.uniform(0.5, 0.75)
            q = s * rng.uniform(0.32, 0.42)
            clumps.append((c + V((math.cos(a) * d, math.sin(a) * d, rng.uniform(-0.2, 0.05) * s)), (q, q, q * 0.55)))
        for i in range(3):  # the pad's domed middle
            a = rng.uniform(0, math.tau)
            d = s * rng.uniform(0, 0.3)
            clumps.append((c + V((math.cos(a) * d, math.sin(a) * d, s * 0.12)), (s * 0.45, s * 0.45, s * 0.26)))
        src = min(trunk[1:], key=lambda p: (p - (c - V((0.14, 0, 0.2)))).length)  # limbs rise out of the trunk
        if (src - c).length > 0.05:
            m = src.lerp(c, 0.5) + V((0, 0, rng.uniform(-0.02, 0.04)))
            paths.append(([src, m, c - V((0, 0, 0.03))], 0.014, 0.007))
    crown = foliage(clumps, VOXEL[level] * 0.006, 0.006, 30, target * CROWN[level], seed)
    bark = limbs(paths, (6, 4, 3)[level])
    # pads bulge from just under their own middle
    mids = [V((x, y, z - 0.08)) for x, y, z, _ in pads]
    return assemble(name + LEVELS[level], [(crown, col)], bark, lambda p: min(mids, key=lambda m: (m - p).length), 0.75, 0.35, 0.12)


# Each kind comes in three levels (lods.js switches them by distance): `name` for the trees near the camera, `name_far`
# with a fifth of the crown's triangles (conifers: a quarter, from fewer tufts), the twigs left out and coarser limbs,
# and `name_dist` for the far hills with 6% of them (conifers: 9%) on three-sided limbs, fused on a coarser grid first
# (VOXEL) so that so few triangles still make a clean shape instead of shards.
LEVELS = ('', '_far', '_dist')
CROWN = (1, 0.2, 0.06)
VOXEL = (1, 1, 2)
KINDS = {
    'sugi': lambda level: conifer('sugi', 1, w=0.16, base=0.12, n=70, taper=0.85, droop=0.8, size=0.55, col=(0.045, 0.085, 0.05), target=1400, level=level),
    'hinoki': lambda level: conifer('hinoki', 2, w=0.25, base=0.08, n=60, taper=0.7, droop=0.55, size=0.6, col=(0.06, 0.11, 0.05), target=1600, level=level),
    'konara': lambda level: broadleaf('konara', 3, cz=0.62, ex=0.44, ez=0.36, fork=0.3, n=22, size=0.14, gap=0.75, col=(0.19, 0.3, 0.06), target=3000, level=level),
    'kashi': lambda level: broadleaf('kashi', 4, cz=0.6, ex=0.46, ez=0.38, fork=0.26, n=30, size=0.15, gap=0.55, col=(0.07, 0.13, 0.045), target=2600, level=level),
    'cherry': lambda level: broadleaf('cherry', 5, cz=0.6, ex=0.62, ez=0.34, fork=0.22, n=55, size=0.09, gap=0.6, col=(1.0, 0.7, 0.74), target=7000,
                                    low=0.75, n_limbs=5, mottle=((0.6, 0.3, 0.22), 0.35), flat=0.8, soft=0.7, ao_min=0.72, level=level),  # light shade: the blossom glows (forestMaterial)
    'pine': lambda level: pine('pine', 6, col=(0.05, 0.095, 0.045), target=5000, level=level),
}

if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    out = args[0]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for kind in args[1:] or KINDS:
        for level in range(len(LEVELS)):
            me = KINDS[kind](level)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
