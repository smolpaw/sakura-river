# The woods' tree kinds (src/vegetation.js places them), built in Blender. Run through tools/forest.mjs:
#   blender -b --factory-startup -P tools/forest.py -- <out.glb>
# Each kind is one mesh, one unit tall, standing on its origin (Blender: z up; glTF: y up), named as in KINDS.
# Crowns are clusters of foliage clumps fused into one surface (voxel remesh), roughened and decimated to a triangle
# budget; limbs are tapered tubes from the trunk to the clumps. Shading lives in the vertex colours: ambient occlusion
# (ray cast against the whole tree), darker undersides, a little mottling; crown normals are bent out from the crown's
# middle so the light falls softly over it, as on a real crown seen from afar.
import bpy, bmesh, bisect, itertools, math, random, sys
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

BARK = (0.07, 0.055, 0.045)
V = Vector


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def clamp(x, a, b):
    return min(b, max(a, x))


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
    balls = []
    for c, r in clumps:
        # a clump is a cauliflower: a core and smaller tufts round its upper and outer side
        balls.append((c, V(r) * 0.8))
        for _ in range(6):
            d = V((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1) + 0.5)).normalized()
            balls.append((c + V((d.x * r[0], d.y * r[1], d.z * r[2])) * 0.62, V(r) * rng.uniform(0.38, 0.5)))
    # one icosphere, copied scaled to each ball (adding each to one bmesh slows as it grows)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    bm.verts.index_update()
    ico, faces = [v.co.copy() for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    verts, polys = [], []
    for bc, br in balls:
        o = len(verts)
        verts += [V((bc.x + p.x * br.x, bc.y + p.y * br.y, bc.z + p.z * br.z)) for p in ico]
        polys += [[o + i for i in f] for f in faces]
    me = bpy.data.meshes.new('clumps')
    me.from_pydata(verts, [], polys)
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


def colour_at(me, use=None):
    """The colour of mesh `me` (its 'Color' point attribute) at the point of its surface nearest p: f(p, reach) ->
    (r, g, b, a), or None beyond reach. A near model (`<kind>_near`, the Ultra tier's) takes its full model's shading
    so, and adds only the fine detail its own vertices can carry: the full model's occlusion and colour come from far
    fewer vertices, and computed afresh on the finer surface they would differ, which shows when the levels switch."""
    cos = [v.co.copy() for v in me.vertices]
    tri = [(p.vertices[0], p.vertices[i], p.vertices[i + 1]) for p in me.polygons for i in range(1, len(p.vertices) - 1)]
    tri = [t for t in tri if not use or all(use(j) for j in t)]  # (use: which vertices' surface counts)
    bvh = BVHTree.FromPolygons(cos, tri)
    col = [tuple(d.color) for d in me.color_attributes['Color'].data]

    def f(p, reach=0.1):
        loc, nrm, i, d = bvh.find_nearest(p, reach)
        if loc is None:
            return None
        a, b, c = (cos[j] for j in tri[i])
        e0, e1, e2 = b - a, c - a, loc - a
        d00, d01, d11, d20, d21 = e0.dot(e0), e0.dot(e1), e1.dot(e1), e2.dot(e0), e2.dot(e1)
        den = d00 * d11 - d01 * d01 or 1e-12
        wb, wc = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
        wb, wc = clamp(wb, 0, 1), clamp(wc, 0, 1)
        wa = max(0.0, 1 - wb - wc)
        return tuple(wa * x + wb * y + wc * z for x, y, z in zip(col[tri[i][0]], col[tri[i][1]], col[tri[i][2]]))
    return f


def with_leaves(me, n, size, seed, *, shape=(1.0, 0.45), lift=(0.3, 0.9), where=lambda p, nrm, t: True, tint=(0.85, 1.2),
                shade=None):
    """Mesh `me` (smooth, custom normals set per vertex, a 'Color' point attribute) with n leaves added over its
    surface (spread by area, on the triangles `where(centre, normal, vertex indices)` allows): each a pointed blade
    `size` long (times 0.75..1.3; shape: length and width as parts of it) rooted on the surface, pointing a random way
    along it and lifted out of it by `lift` (radians), its two faces back to back. Each takes the colour under it (or
    shade(p) -> rgba), tinted by `tint`, and the surface's normal, so the leaves light as the mass they stand on and
    only add the broken edge and flicker of real foliage. Returns a new mesh in its place (same name, same object)."""
    rng = random.Random(seed)
    cos = [v.co.copy() for v in me.vertices]
    nors = [V((0, 0, 0)) for _ in me.vertices]
    for loop in me.loops:
        nors[loop.vertex_index] = V(me.corner_normals[loop.index].vector)
    corner = [V(c.vector) for c in me.corner_normals]  # kept per corner: sharp edges stay sharp
    ca = me.color_attributes['Color']
    cols = [tuple(d.color) for d in ca.data]
    polys = [tuple(p.vertices) for p in me.polygons]
    tri = [(p[0], p[i], p[i + 1]) for p in polys for i in range(1, len(p) - 1)]
    ok = [t for t in tri if where(sum((cos[j] for j in t), V()) / 3, (cos[t[1]] - cos[t[0]]).cross(cos[t[2]] - cos[t[0]]).normalized(), t)]
    cum = list(itertools.accumulate(((cos[b] - cos[a]).cross(cos[c] - cos[a])).length / 2 for a, b, c in ok))
    for _ in range(n if ok else 0):
        a, b, c = ok[bisect.bisect_left(cum, rng.random() * cum[-1])]
        u, w = rng.random(), rng.random()
        if u + w > 1:
            u, w = 1 - u, 1 - w
        p = cos[a] + (cos[b] - cos[a]) * u + (cos[c] - cos[a]) * w
        nrm = (nors[a] * (1 - u - w) + nors[b] * u + nors[c] * w).normalized()
        col = shade(p) if shade else tuple(x * (1 - u - w) + y * u + z * w for x, y, z in zip(cols[a], cols[b], cols[c]))
        k = rng.uniform(*tint)
        col = (col[0] * k, col[1] * k, col[2] * k, col[3])
        t = Matrix.Rotation(rng.uniform(0, math.tau), 3, nrm) @ nrm.orthogonal().normalized()
        up = rng.uniform(*lift)
        d = t * math.cos(up) + nrm * math.sin(up)  # along the blade
        s = size * rng.uniform(0.75, 1.3)
        side = d.cross(nrm).normalized() * s * shape[1] / 2
        root = p - nrm * s * 0.05
        quad = [root, root + d * s * 0.45 + side, root + d * s * shape[0], root + d * s * 0.45 - side]
        o = len(cos)
        cos += quad + quad  # the back face on vertices of its own
        nors += [nrm] * 8
        cols += [col] * 8
        polys += [(o, o + 1, o + 2), (o, o + 2, o + 3), (o + 4, o + 6, o + 5), (o + 4, o + 7, o + 6)]
    out = bpy.data.meshes.new(me.name)
    out.from_pydata(cos, [], polys)
    for p in out.polygons:
        p.use_smooth = True
    out.normals_split_custom_set(corner + [nors[l.vertex_index] for l in out.loops[len(corner):]])
    oc = out.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        oc.data[i].color = c
    out.color_attributes.active_color = oc
    # in place of `me` on its object
    for ob in bpy.data.objects:
        if ob.data == me:
            ob.data = out
    name = me.name
    bpy.data.meshes.remove(me)
    out.name = name
    return out


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


def leaf_cards(name, bm, kind, base, mid, soft, low, ao_reach, ao_min, *, n, size, cell, seed, width=None):
    """Leaf cards over the crown (the near model only): n small quads scattered over its surface by area, facing out
    with a random turn and tilt, a few sunk into it and some standing proud of it, so the crown's edge is leaves, not
    a hull. UVs into the leaf atlas's cell `cell` (2x2: 0 broadleaf, 1 sugi/hinoki, 2 pine, 3 blossom; the page paints
    it, vegetation.js paintLeafAtlas); shaded as the crown's surface (occlusion from the card's middle) and lit with
    the crown's bent normal, so they sit in it."""
    rng = random.Random(seed)
    bvh = BVHTree.FromBMesh(bm)
    faces = [f for f in bm.faces if f.verts[0][kind] >= 0]
    cum = list(itertools.accumulate(f.calc_area() for f in faces))
    u0, v0 = (cell % 2) * 0.5, 1 - (cell // 2) * 0.5  # Blender's v runs up; the canvas's rows down
    verts, polys, uvs, cols, nors = [], [], [], [], []
    for _ in range(n):
        f = faces[bisect.bisect_left(cum, rng.random() * cum[-1])]
        a, b = rng.random(), rng.random()
        if a + b > 1:
            a, b = 1 - a, 1 - b
        p0, p1, p2 = (v.co for v in f.verts)
        p = p0 + (p1 - p0) * a + (p2 - p0) * b
        out = (p - mid(p)).normalized()
        nrm = f.normal.lerp(out, 0.5).normalized()
        s = size * rng.uniform(0.75, 1.3)
        out_by = rng.uniform(-0.1, 0.6)
        if width:
            s = min(s, max(0.25 * size, width(p.z) * 0.7))
            out_by = rng.uniform(-0.3, 0.2)
        c = p + nrm * s * out_by
        t = Matrix.Rotation(rng.uniform(0, math.tau), 3, nrm) @ nrm.orthogonal().normalized()
        w = Matrix.Rotation(rng.uniform(-0.75, 0.75), 3, t) @ nrm.cross(t)
        o = p + nrm * 0.004  # shaded as the crown's surface under it (a card sunk into it would read black)
        hit = sum(1 for d in DIRS if bvh.ray_cast(o, (t * d.x + nrm.cross(t) * d.y + nrm * d.z), ao_reach)[0] is not None)
        shade = lerp(ao_min, 1.0, 1 - hit / len(DIRS)) * lerp(low, 1.0, smoothstep(-0.7, 0.6, out.z))
        vary = 0.85 + 0.3 * rng.random()
        col = [x * shade * vary for x in base]
        nor = nrm.lerp(out, soft).normalized()
        flip = rng.random() < 0.5
        k = len(verts)
        for i, (x, y) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            verts.append(c + t * (x * s) + w * (y * s))
            uvs.append((u0 + ((-x if flip else x) * 0.5 + 0.5) * 0.5, v0 - (0.5 - y * 0.5) * 0.5))
            cols.append(col)
            nors.append(nor)
        polys.append((k, k + 1, k + 2, k + 3))
    me = bpy.data.meshes.new(name + '_leaves')
    me.from_pydata(verts, [], polys)
    me.validate()
    uv = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        uv.data[loop.index].uv = uvs[loop.vertex_index]
    for poly in me.polygons:
        poly.use_smooth = True
    me.normals_split_custom_set_from_vertices(nors)
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    link(me, name + '_leaves')
    print(f'{name}_leaves: {len(polys) * 2} triangles')


def assemble(name, crowns, bark, mid, soft, low, ao_reach, mottle=None, ao_min=0.4, cards=None):
    """crowns: [(mesh, colour)]; bark: mesh or None; mid(p): the point a crown point bulges out from; ao_min: the
    crown's shade in full occlusion; cards: leaf_cards' settings, for the near model."""
    bm = bmesh.new()
    kind = bm.verts.layers.int.new('kind')  # -1 bark, else index into crowns
    parts = [(me, i) for i, (me, _) in enumerate(crowns)] + ([(bark, -1)] if bark else [])
    n_crown = sum(len(me.vertices) for me, _ in crowns)
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
    if cards:
        leaf_cards(name, bm, kind, crowns[0][1], mid, soft, low, ao_reach, ao_min, **cards)
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
    me['n_crown'] = n_crown  # (the crowns' vertices come first: near_refine tells them from the bark so)
    link(me, name)
    return me


# ---------- the near models (the Ultra tier's `<kind>_near`) ----------
# The full model's crown fused on a finer grid, shaded as the full one (colour_at), with leaves standing out of it;
# the trunk and limbs rounder and longer-ringed, their bark split into plates by fissures.
NEAR = dict(voxel=0.6, crown=3.0, seg=10, step=0.012, leaves=0.5, leaf=0.016)  # leaves: per full model's triangle


def fissures(p):
    """how deep in a bark fissure p is (0..1): plates split along the trunk, a little twisted"""
    return smoothstep(-0.05, -0.35, noise.noise(V((p.x * 140 + p.z * 6, p.y * 140, p.z * 14)) + V((5.3, 1.1, 7.7))))


def near_limbs(paths, twigs=()):
    """limbs() for a near model: the paths' points closer together (rings every NEAR['step']), rounder tubes,
    the bark's fissures cut into them"""
    def dense(pts):
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            n = max(1, math.ceil((b - a).length / NEAR['step']))
            out += [a.lerp(b, i / n) for i in range(1, n + 1)]
        return out
    me = limbs([(dense(pts), r0, r1) for pts, r0, r1 in paths], NEAR['seg'], [(dense(pts), r0, r1) for pts, r0, r1 in twigs])
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    for v in bm.verts:
        v.co -= v.normal * 0.0012 * fissures(v.co)
    bm.to_mesh(me)
    bm.free()
    return me


def near_refine(me, full, seed, leaf_shape=(1.0, 0.45)):
    """a near model `me` (assemble()d) shaded as the full model `full`: the crown's colour looked up on the full
    crown, the bark's on the full bark, then the fine detail added (the crown's flicker of light and shade, the bark's
    fissures dark), and leaves over the crown"""
    n = me['n_crown']
    looks = (colour_at(full, lambda j: j < full['n_crown']), colour_at(full, lambda j: j >= full['n_crown']))
    ca = me.color_attributes['Color']
    for i, v in enumerate(me.vertices):
        bark = i >= n
        f = looks[bark](v.co, 0.02)
        if not f:
            continue
        k = (1 - 0.45 * fissures(v.co)) if bark else 0.92 + 0.16 * noise.noise(v.co * 60 + V((seed, 0, 0)))
        ca.data[i].color = (f[0] * k, f[1] * k, f[2] * k, f[3])
    return with_leaves(me, int(NEAR['leaves'] * tris(full)), NEAR['leaf'], seed + 500, shape=leaf_shape, where=lambda p, nrm, t: max(t) < n)


# ---------- the kinds ----------
def conifer(name, seed, *, w, base, n, taper, droop, size, col, target, level=0, leaves=(420, 0.045), near=None):
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
    crown = foliage(clumps, (0.0065, 0.0065, 0.014)[level] * (NEAR['voxel'] if near else 1), 0.005, 18,
                    target * (1, 0.25, 0.09)[level] * (NEAR['crown'] if near else 1), seed)
    trunk = [([V((0, 0, -0.04)), V((0, 0, base + 0.1)), V((0, 0, 0.84))], 0.024, 0.006)]
    bark = near_limbs(trunk) if near else limbs(trunk, (6, 4, 3)[level])
    me = assemble(name + ('_near' if near else LEVELS[level]), [(crown, col)], bark, lambda p: V((0, 0, p.z - 0.5 * math.hypot(p.x, p.y))), 0.75, 0.5, 0.12,
                  cards=None if level or near else dict(n=leaves[0], size=leaves[1], cell=1, seed=seed, width=lambda z: R(clamp((z - base) / (0.96 - base), 0, 1))))
    return near_refine(me, near, seed, (1.0, 0.3)) if near else me


def broadleaf(name, seed, *, cz, ex, ez, fork, n, size, gap, col, target, low=0.4, n_limbs=4, mottle=None, flat=1.0, soft=0.85, ao_min=0.4, level=0,
              leaves=(500, 0.075), cell=0, near=None):
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
    crown = foliage(clumps, VOXEL[level] * 0.008 * (NEAR['voxel'] if near else 1), 0.01, 14, target * CROWN[level] * (NEAR['crown'] if near else 1), seed)
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
    bark = near_limbs(paths, twigs) if near else limbs(paths, (5, 4, 3)[level], twigs)
    me = assemble(name + ('_near' if near else LEVELS[level]), [(crown, col)], bark, lambda p: V((0, 0, cz)), soft, low, 0.18, mottle, ao_min,
                  cards=None if level or near else dict(n=leaves[0], size=leaves[1], cell=cell, seed=seed))
    return near_refine(me, near, seed) if near else me


def pine(name, seed, *, col, target, level=0, leaves=(450, 0.06), near=None):
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
    crown = foliage(clumps, VOXEL[level] * 0.006 * (NEAR['voxel'] if near else 1), 0.006, 30, target * CROWN[level] * (NEAR['crown'] if near else 1), seed)
    bark = near_limbs(paths) if near else limbs(paths, (6, 4, 3)[level])
    # pads bulge from just under their own middle
    mids = [V((x, y, z - 0.08)) for x, y, z, _ in pads]
    me = assemble(name + ('_near' if near else LEVELS[level]), [(crown, col)], bark, lambda p: min(mids, key=lambda m: (m - p).length), 0.75, 0.35, 0.12,
                  cards=None if level or near else dict(n=leaves[0], size=leaves[1], cell=2, seed=seed))
    return near_refine(me, near, seed, (1.0, 0.2)) if near else me


# Each kind comes in three levels (lods.js switches them by distance): `name` for the trees near the camera, `name_far`
# with a fifth of the crown's triangles (conifers: a quarter, from fewer tufts), the twigs left out and coarser limbs,
# and `name_dist` for the far hills with 6% of them (conifers: 9%) on three-sided limbs, fused on a coarser grid first
# (VOXEL) so that so few triangles still make a clean shape instead of shards. For the Ultra tier a fourth, `name_near`
# (built from `name` after it: near_refine), goes in front of them all.
LEVELS = ('', '_far', '_dist')
CROWN = (1, 0.2, 0.06)
VOXEL = (1, 1, 2)
KINDS = {
    'sugi': lambda level, near=None: conifer('sugi', 1, w=0.16, base=0.12, n=70, taper=0.85, droop=0.8, size=0.55, col=(0.045, 0.085, 0.05), target=1400, level=level, near=near),
    'hinoki': lambda level, near=None: conifer('hinoki', 2, w=0.25, base=0.08, n=60, taper=0.7, droop=0.55, size=0.6, col=(0.06, 0.11, 0.05), target=1600, level=level, near=near),
    'konara': lambda level, near=None: broadleaf('konara', 3, cz=0.62, ex=0.44, ez=0.36, fork=0.3, n=22, size=0.14, gap=0.75, col=(0.19, 0.3, 0.06), target=3000, level=level, near=near),
    'kashi': lambda level, near=None: broadleaf('kashi', 4, cz=0.6, ex=0.46, ez=0.38, fork=0.26, n=30, size=0.15, gap=0.55, col=(0.07, 0.13, 0.045), target=2600, level=level, near=near),
    'cherry': lambda level, near=None: broadleaf('cherry', 5, cz=0.6, ex=0.62, ez=0.34, fork=0.22, n=55, size=0.09, gap=0.6, col=(1.0, 0.7, 0.74), target=7000,
                                    low=0.75, n_limbs=5, mottle=((0.6, 0.3, 0.22), 0.35), flat=0.8, soft=0.7, ao_min=0.72, level=level, near=near,
                                    leaves=(900, 0.075), cell=3),  # light shade: the blossom glows (forestMaterial)
    'pine': lambda level, near=None: pine('pine', 6, col=(0.05, 0.095, 0.045), target=5000, level=level, near=near),
}

if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    out = args[0]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    full = {}
    for kind in args[1:] or KINDS:
        for level in range(len(LEVELS)):
            me = KINDS[kind](level)
            full.setdefault(kind, me)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    for kind in full:  # the near models (the Ultra tier's, which tools/blender.mjs puts in public/models/)
        me = KINDS[kind](0, full[kind])
        print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=True, export_yup=True)
