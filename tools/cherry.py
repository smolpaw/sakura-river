# The cherries' trunks, built in Blender from their skeletons (tools/cherry.mjs writes them: the roots and the main
# branches as src/tree.js grows them, see trunkSkeleton). Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/cherry.py -- <out.glb> <skeletons.json>
# Each tree is one mesh `trunkN` in the tree's own frame (Blender: z up; glTF: y up), carrying the skeleton's signature
# (extras.sig) so the page can tell a stale model. The trunk, roots and branches are fused into one surface: balls
# strung along each branch (metaballs, so the forks blend into each other), with ridges twisting up the trunk and
# the limbs' bases, burls, and buttresses into the ground; bark grain along the normal; decimated to a budget.
# Texture coordinates run round and along the branch each face is nearest (the page's bark texture, as on the twigs),
# stored divided by UV_SCALE so they quantize; the shading is in the vertex colours (ambient occlusion, the crown's
# shade, moss low on the trunk and on top of the big limbs, lichen), and the wind's flexibility, from the skeleton,
# halved in their alpha.
import bpy, bmesh, json, math, os, random, sys
from mathutils import Vector, noise
from mathutils.kdtree import KDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, evaluated, tris, vertex_ao

V = Vector
KAPPA, CHAIN = 0.3, 0.696  # balls spaced KAPPA radii apart make a tube CHAIN radii thick (stiffness 2, threshold 0.6)
MOSS, LICHEN = V((0.62, 1.0, 0.5)), V((1.0, 1.0, 0.92))
UV_SCALE = 16


def bl(p):  # three.js (y up) to Blender (z up)
    return V((p[0], -p[2], p[1]))


class Branch:
    """A skeleton branch resampled every `ds` along its length, with parallel-transport frames."""

    def __init__(self, b, ground, ds=0.03):
        pts = [bl(p) for p in b['pts']]
        cum = [0.0]
        for a, c in zip(pts, pts[1:]):
            cum.append(cum[-1] + (c - a).length)
        self.depth, self.length, self.r0 = b['depth'], cum[-1], b['rad'][0]
        self.circ = max(1, round(self.r0 * 7))  # bark texture repeats round it, as on the twigs (tree.js)
        n = max(2, int(self.length / ds) + 1)
        self.s, self.p, self.r, self.f = [], [], [], []
        k = 0
        for i in range(n):
            s = self.length * i / (n - 1)
            while k < len(pts) - 2 and cum[k + 1] < s:
                k += 1
            u = (s - cum[k]) / max(1e-9, cum[k + 1] - cum[k])
            p, r = pts[k].lerp(pts[k + 1], u), lerp(b['rad'][k], b['rad'][k + 1], u)
            if self.depth < 0:
                # a root: thick where it leaves the trunk, diving into the ground within a metre or two
                t = s / self.length
                r *= lerp(1.6, 1.0, t)
                p.z = min(p.z, ground(p) + r * 0.5) - 0.7 * t ** 1.4
            self.s.append(s)
            self.p.append(p)
            self.r.append(r)
            self.f.append(lerp(b['flex'][k], b['flex'][k + 1], u))
        self.t = [(self.p[min(i + 1, n - 1)] - self.p[max(i - 1, 0)]).normalized() for i in range(n)]
        a = V((0, 0, 1)) if abs(self.t[0].z) < 0.9 else V((1, 0, 0))
        self.N = [self.t[0].cross(a).normalized()]
        for i in range(1, n):
            v = self.N[-1] - self.t[i] * self.N[-1].dot(self.t[i])
            self.N.append(v.normalized() if v.length > 1e-6 else self.N[-1])
        self.B = [t.cross(nn) for t, nn in zip(self.t, self.N)]
        self.kd = KDTree(n)
        for i, p in enumerate(self.p):
            self.kd.insert(p, i)
        self.kd.balance()


def balls_of(br, rng, off):
    """The balls along one branch (and its ridges, burls and buttresses), as (centre, radius)."""
    out = []
    thick = br.depth <= 1
    i = 0
    while i < len(br.p):
        s, p, r = br.s[i], br.p[i], br.r[i]
        if br.depth > 0:
            r *= 1 + 0.2 * math.exp(-s / (br.r0 * 2.5))  # the collar where it leaves its parent
        if br.depth == 0:
            r *= 1 + 0.18 * smoothstep(0.6, 1.0, s / br.length)  # swelling where the limbs fork off
        # knobbly: the radius wanders a little along the branch
        r *= 1 + 0.07 * noise.noise(V((s * 1.3, br.depth * 7.1, 0)) + off)
        out.append((p, r / CHAIN))
        # ridges twisting up the trunk and along the limbs' first metres, swelling and fading: a lobed, fluted section
        if thick and r > 0.12:
            fade = 1.0 if br.depth == 0 else smoothstep(br.length * 0.6, 0.0, s)
            nr = 6 if br.depth == 0 else 4
            for k in range(nr):
                a = k * math.tau / nr + s * (0.55 if br.depth == 0 else 0.25) + 0.5 * noise.noise(V((k * 3.3, s * 0.6, 1)) + off)
                d = br.N[i] * math.cos(a) + br.B[i] * math.sin(a)
                rr = r * (0.36 + 0.2 * noise.noise(V((k * 5.1, s * 0.9, 2)) + off)) * fade
                if rr > 0.02:
                    out.append((p + d * r * 0.72, rr / CHAIN))
        i += max(1, int(KAPPA * (r / CHAIN) / 0.03))
    # burls on the trunk and the limbs' lower halves
    nb = {0: 8, 1: 3}.get(br.depth, 0)
    for _ in range(nb):
        i = rng.randrange(int(len(br.p) * (0.15 if br.depth == 0 else 0.05)), int(len(br.p) * (0.9 if br.depth == 0 else 0.5)))
        a = rng.uniform(0, math.tau)
        d = br.N[i] * math.cos(a) + br.B[i] * math.sin(a)
        r = br.r[i]
        out.append((br.p[i] + d * r * 0.9, r * rng.uniform(0.3, 0.5) / CHAIN))
    return out


def buttresses(trunk, rng, ground, n):
    """Flared ridges from low on the trunk out into the ground."""
    out = []
    base = next(i for i, p in enumerate(trunk.p) if p.z - ground(p) > -0.1)
    c, r = trunk.p[base], trunk.r[base]
    a0 = rng.uniform(0, math.tau)
    for k in range(n):
        a = a0 + k * math.tau / n + rng.uniform(-0.3, 0.3)
        d = V((math.cos(a), math.sin(a), 0))
        top, length = rng.uniform(0.6, 1.0), r * rng.uniform(1.6, 2.4)
        for j in range(12):
            t = j / 11
            q = c + d * (r * 0.5 + length * t)
            q.z = ground(q) + lerp(top, -0.05, t ** 0.7)
            out.append((q, r * lerp(0.42, 0.12, t) / CHAIN))
    return out


def ground_of(g):
    n, step, h = g['n'], g['step'], g['h']
    w = 2 * n + 1

    def at(p):  # Blender (x, y) is three's (x, -z)
        fx, fz = p.x / step + n, -p.y / step + n
        i, j = max(0, min(w - 2, int(fx))), max(0, min(w - 2, int(fz)))
        u, v = min(1, max(0, fx - i)), min(1, max(0, fz - j))
        return lerp(lerp(h[j * w + i], h[j * w + i + 1], u), lerp(h[(j + 1) * w + i], h[(j + 1) * w + i + 1], u), v)
    return at


def trunk(t, seed, res, target):
    rng = random.Random(seed)
    off = V((seed * 3.7, seed * 1.9, seed * 5.3))
    ground = ground_of(t['ground'])
    brs = [Branch(b, ground) for b in t['branches']]
    balls = []
    for br in brs:
        balls += balls_of(br, rng, off)
    balls += buttresses(brs[0], rng, ground, 5 if not t['small'] else 4)

    mb = bpy.data.metaballs.new(t['name'] + 'mb')
    mb.resolution = mb.render_resolution = res
    mb.threshold = 0.6
    for c, r in balls:
        e = mb.elements.new()
        e.co, e.radius, e.stiffness = c, r, 2.0
    ob = bpy.data.objects.new(t['name'] + 'mb', mb)
    bpy.context.collection.objects.link(ob)
    me = evaluated(ob)
    bpy.data.metaballs.remove(mb)

    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    # what lies well under the ground is never seen
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z - ground(v.co) < -0.3], context='VERTS')
    # the skeleton sample nearest each point's surface: which branch it is on, where along and round it
    samples = [(bi, i) for bi, br in enumerate(brs) for i in range(len(br.p))]
    kd = KDTree(len(samples))
    for k, (bi, i) in enumerate(samples):
        kd.insert(brs[bi].p[i], k)
    kd.balance()

    def nearest(p):
        best, bk = 1e9, 0
        for _, k, d in kd.find_n(p, 24):
            bi, i = samples[k]
            if d - brs[bi].r[i] < best:
                best, bk = d - brs[bi].r[i], k
        return samples[bk]

    # bark grain: shallow plates and fissures along each branch, deeper on the trunk
    bm.normal_update()
    for v in bm.verts:
        bi, i = nearest(v.co)
        br = brs[bi]
        q = v.co - br.p[i]
        a = math.atan2(q.dot(br.B[i]), q.dot(br.N[i]))
        ring = a * br.r[i]  # distance round the branch
        amp = 0.016 if br.depth == 0 else 0.009 if br.depth == 1 else 0.005
        g = noise.noise(V((ring * 7, br.s[i] * 1.6, bi * 3.1)) + off) + 0.5 * noise.noise(V((ring * 16, br.s[i] * 4, bi * 3.1)) + off)
        v.co += v.normal * g * amp

    me = bpy.data.meshes.new(t['name'] + 'hi')
    bm.to_mesh(me)
    bm.free()
    ob = link(me, t['name'] + 'hi')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    me = evaluated(ob)

    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, 1.2)
    cc, ce = bl(t['canopy']['center']), t['canopy']['ext']
    ce = V((ce[0], ce[2], ce[1]))
    flex, cols = [], []
    for v in bm.verts:
        bi, i = nearest(v.co)
        br = brs[bi]
        p, n = v.co, v.normal
        flex.append(br.f[i])
        hg = p.z - ground(p)
        q = V(((p.x - cc.x) / ce.x, (p.y - cc.y) / ce.y, (p.z - cc.z) / ce.z)).length
        # the crown's shade and the ground's, as on the twigs (tree.js), and the hollows' from ray casting
        shade = lerp(0.7, 1.0, smoothstep(0.2, 1.05, q)) * lerp(0.7, 1.0, smoothstep(-0.2, 1.2, hg)) * lerp(0.45, 1.0, ao[v.index])
        c = V((1, 1, 1))
        # moss low on the trunk and roots, and in patches on top of the big limbs
        m = smoothstep(1.4, 0.0, hg) * max(0.0, min(1.0, 0.4 + n.z * 0.4 + 0.5 * noise.noise(p * 1.7 + off)))
        if br.depth in (0, 1):
            m = max(m, smoothstep(0.55, 0.9, n.z) * smoothstep(0.1, 0.5, noise.noise(p * 1.1 + off * 1.3)) * 0.8)
        c = c.lerp(MOSS, m)
        # grey-green lichen rosettes on the older bark
        if br.depth <= 1:
            c = c.lerp(LICHEN, smoothstep(0.45, 0.65, noise.noise(p * 4.5 + off * 2)) * 0.6)
        cols.append(c * shade)
    for f in bm.faces:
        f.smooth = True
    uvl = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        bi, _ = nearest(f.calc_center_median())
        br = brs[bi]
        uv = []
        for l in f.loops:
            _, i, _ = br.kd.find(l.vert.co)
            q = l.vert.co - br.p[i]
            a = math.atan2(q.dot(br.B[i]), q.dot(br.N[i])) % math.tau
            # along the branch past its nearest sample too: beyond its ends the bark runs on instead of fanning out
            uv.append([a / math.tau * br.circ, (br.s[i] + q.dot(br.t[i])) * 0.9])
        us = [u for u, _ in uv]
        if max(us) - min(us) > br.circ / 2:  # the face straddles the seam: take it round the same way
            for x in uv:
                if x[0] < br.circ / 2:
                    x[0] += br.circ
        for l, x in zip(f.loops, uv):
            l[uvl].uv = (x[0] / UV_SCALE, (x[1] + 2) / UV_SCALE)  # + 2: within [0, 1] below the trunk's start too
    me = bpy.data.meshes.new(t['name'])
    bm.to_mesh(me)
    bm.free()
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, flex[i] / 2)
    me.color_attributes.active_color = ca
    ob = link(me, t['name'])
    ob['sig'] = t['sig']
    return me


def srgb(h):
    return V([((int(h[i:i + 2], 16) / 255 + 0.055) / 1.055) ** 2.4 for i in (1, 3, 5)])


# the flower the page draws near the camera in place of its painted card (tree.js paintFlowerAtlas; the same colours):
# a Somei Yoshino flower in the card's frame (three.js: facing +z, about 0.42 across its petals' tips as on the card,
# cupped towards +z): five broad petals notched at the tip, pink at the base, fading to white; the red cup at the
# centre with its stamens, the anthers yellow. Vertex colours only.
PETAL = [srgb('#e0708f'), srgb('#f8bfd1'), srgb('#ffe6ee'), srgb('#fff4f7')]
CUP, FILAMENT, ANTHER = srgb('#b8325c'), srgb('#fae8ee'), srgb('#f2c14e')


def flower():
    rng = random.Random(5)
    verts, faces, cols = [], [], []

    def vert(p, c):  # p in the card's frame (three.js axes)
        verts.append(bl(p))
        cols.append(c)
        return len(verts) - 1

    cup = lambda r: 0.55 * r * r  # the petals curve up out of the cup
    A = (0.0, 0.3, 0.62, 1.0)
    for k in range(5):
        th = k * math.tau / 5 + rng.uniform(-0.08, 0.08)
        L, W = rng.uniform(0.34, 0.37), rng.uniform(0.15, 0.17)
        lift = 0.004 * (k % 2)  # alternate petals sit a hair apart where they overlap
        ids = []
        for a in A:
            row = []
            for b in (-1.0, 0.0, 1.0):
                # broad obovate outline, narrow at the claw; the notch: the middle of the tip falls short
                w = W * (0.28 + 0.72 * smoothstep(0.0, 0.62, a)) * (1 - 0.3 * smoothstep(0.8, 1.0, a))
                aa = a * (1 - (0.11 if b == 0 and a == 1.0 else 0.0))
                r = 0.05 + L * aa
                x, y = r, w * b
                z = cup(r) + 0.04 * b * b * a + lift  # edges curl up a little
                c, s = math.cos(th), math.sin(th)
                t = aa
                col = PETAL[0].lerp(PETAL[1], smoothstep(0.0, 0.3, t)).lerp(PETAL[2], smoothstep(0.25, 0.7, t)).lerp(PETAL[3], smoothstep(0.7, 1.0, t))
                row.append(vert((x * c - y * s, x * s + y * c, z), col))
            ids.append(row)
        for i in range(len(A) - 1):
            for j in range(2):
                faces.append((ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]))
    # the cup: a shallow cone in the middle
    rim = [vert((0.075 * math.cos(a), 0.075 * math.sin(a), 0.012), CUP * 0.85) for a in (i * math.tau / 6 for i in range(6))]
    mid = vert((0, 0, -0.01), CUP * 0.6)
    for i in range(6):
        faces.append((mid, rim[i], rim[(i + 1) % 6]))
    # stamens: thin blades out of the cup, each with its anther
    for i in range(12):
        a = i * math.tau / 12 + rng.uniform(-0.15, 0.15)
        l = rng.uniform(0.12, 0.17)
        d = V((math.cos(a), math.sin(a), 0))
        root, tip = d * 0.03 + V((0, 0, 0.01)), d * l * 0.75 + V((0, 0, l * 0.62))
        side = V((-d.y, d.x, 0)) * 0.006
        f0, f1 = vert(tuple(root - side), FILAMENT), vert(tuple(root + side), FILAMENT)
        t0 = vert(tuple(tip - side * 2.2), ANTHER)
        t1 = vert(tuple(tip + side * 2.2), ANTHER)
        faces.append((f0, f1, t1, t0))
    me = bpy.data.meshes.new('flower')
    me.from_pydata(verts, [], faces)
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    bm.normal_update()
    # normals face the open side (+z in the card's frame, -y here) so the petals light like the cards
    for f in bm.faces:
        if f.normal.y > 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    link(me, 'flower')
    return me


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]
    out, data = argv[0], json.load(open(argv[1]))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for k, t in enumerate(data):
        me = trunk(t, 17 + k, 0.02 if not t['small'] else 0.03, 1500 if t['small'] else 18000)
        print(f"{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices")
    me = flower()
    print(f"{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices")
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=True, export_normals=True, export_extras=True,
                              export_yup=True)
