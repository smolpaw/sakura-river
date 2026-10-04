# The river boats and the mooring stake (src/boat.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/boat.py -- <out.glb>
# Each kind is one mesh in metres (Blender: z up; glTF: y up):
# - boat: a small flat-bottomed cedar river boat (kawabune, as the takase-bune of Kyoto's canals), 4.5 m long and 1.1 m
#   in the beam, its bow towards +x: a flat bottom that sweeps up into a long, fine, raked bow ending in a stem post,
#   a square stern, slab sides flaring out, each of two broad planks, a rubbing strake under the sheer, a short foredeck
#   and a stern deck, ribs and floor timbers, three thwarts whose ends show through the sides, loose floor boards over
#   a little water in the bilge, a bamboo pushing pole (sao) resting on a thwart and the transom, the sculling oar (ro)
#   shipped along the starboard side by its peg, a coil of straw rope on the floor boards. Its origin is on the bottom
#   amidships; it floats with the waterline WATERLINE above it (src/boat.js). `boat_far`: the hull, the thwarts, pole
#   and oar with few vertices. `boat_mask`: the hull's inside, flat, a little above the waterline (the page keeps the
#   river's surface out of the hull with it).
# - stake: a weathered mooring stake standing on its origin at ground level, sunk 0.4 m, the mooring rope's turns
#   round it ROPE_Z up (the page draws the rope from there to the boat).
# Silvered cedar above the waterline, darker and wet below it, a band of green algae at it; shading in the vertex
# colours (ambient occlusion by ray casting). Alpha 0: nothing glows (the page draws them with the lamps' material).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import lerp, link, smoothstep, tris
from village import Kit, srgb
from lamps import finish

V = Vector
WATERLINE = 0.07   # the waterline's height above the bottom afloat (src/boat.js WATERLINE)
ROPE_Z = 0.62      # the mooring rope's turns on the stake, above the ground (src/boat.js)

SILVER = srgb('#a39b8e')   # cedar silvered by sun and rain
BROWN = srgb('#6b5745')    # cedar where it is less weathered
INSIDE = srgb('#6a5948')
FLOOR = srgb('#463a2e')
WET = srgb('#2f2a22')      # below the waterline
ALGAE = srgb('#5e7030')
WORN = srgb('#a1968a')     # the gunwale's top, worn pale by hands
BILGE = srgb('#22251d')
BAMBOO = srgb('#9a8f6e')
OAR = srgb('#6e5a44')
ROPE = srgb('#8a7752')
IRON = srgb('#2a2522')

XS, XB, X_DECK = -2.2, 2.3, 1.45   # stern, bow tip, the foredeck's aft edge
T_SIDE, T_BOTTOM = 0.028, 0.035


def zb(x):
    """the bottom's height: flat, a little rise at the stern, sweeping up into the raked bow"""
    bow = max(0.0, (x - 0.55) / (XB - 0.55))
    return 0.09 * smoothstep(-1.5, XS, x) + 0.42 * bow ** 2


def zg(x):
    """the sheer: rising to the bow, a little at the stern"""
    return 0.40 + 0.30 * smoothstep(0.3, XB, x) ** 1.5 + 0.06 * smoothstep(-1.2, XS, x)


def hb(x):
    """the bottom's half width"""
    return (0.41 - 0.07 * smoothstep(-0.8, XS, x)) * (1 - 0.9 * smoothstep(0.2, XB, x) ** 1.15)


def hg(x):
    """the sheer's half width (half the beam)"""
    return (0.55 - 0.08 * smoothstep(-0.9, XS, x)) * (1 - 0.92 * smoothstep(-0.1, XB, x) ** 1.5)


def side_pt(x, t, s, inner=False):
    """a point on the side (s: 1 port, -1 starboard) from the chine (t 0) to the sheer (t 1), bellied a little"""
    b, g = hb(x), hg(x)
    z0 = zb(x)
    if inner:
        b, g, z0 = b - T_SIDE * 1.3, g - T_SIDE, z0 + T_BOTTOM
    y = lerp(b, g, t) + 0.018 * math.sin(math.pi * t) * smoothstep(XB, 1.2, x)
    return V((x, s * y, lerp(z0, zg(x), t)))


def stations(far):
    """x along the hull: from the stern to the foredeck's edge, then to the bow tip, closer together forwards"""
    n1, n2 = (6, 4) if far else (15, 9)
    a = [lerp(XS, X_DECK, 1 - (1 - i / n1) ** 1.2) for i in range(n1 + 1)]
    b = [lerp(X_DECK, XB, 1 - (1 - i / n2) ** 1.4) for i in range(1, n2 + 1)]
    return a + b, n1


def cedar(seed):
    """the planks' colour at p (inside: on the hull's inner face; plank: which plank, each a shade of its own):
    silvered above the water, streaked along the grain, wet and dark below the waterline, algae at it"""
    off = V((seed * 3.1, seed * 1.7, seed * 2.3))

    def col(p, inside=False, plank=0):
        g = noise.noise(V((p.x * 0.9, p.z * 7 + plank * 3.1, 0.5)) + off) * 0.7 + noise.noise(V((p.x * 3.3, p.z * 13, plank * 1.9)) + off) * 0.3
        weather = smoothstep(-0.35, 0.45, noise.noise(V((p.x * 0.45, plank * 2.7, p.z * 2)) + off))
        if inside:
            c = INSIDE.lerp(SILVER, 0.25 + 0.35 * weather) * (0.9 + 0.25 * g)
            return c.lerp(FLOOR, smoothstep(0.16, 0.06, p.z) * 0.8)
        c = BROWN.lerp(SILVER, 0.45 + 0.45 * weather) * (0.88 + 0.28 * g) * (0.93 + 0.08 * ((plank * 7 + seed) % 3))
        alg = smoothstep(WATERLINE + 0.09, WATERLINE + 0.015, p.z) * (0.75 + 0.25 * noise.noise(V((p.x * 2.2, p.z * 9, 4.2)) + off))
        c = c.lerp(ALGAE * (0.9 + 0.2 * g), min(1.0, alg))
        return c.lerp(WET * (0.9 + 0.2 * g), smoothstep(WATERLINE + 0.01, WATERLINE - 0.04, p.z))
    return col


def orient(f, want):
    """face f turned to face `want` (a direction, or a function of the face's centre giving one)"""
    f.normal_update()
    w = want(f.calc_center_median()) if callable(want) else want
    if f.normal.dot(w) < 0:
        f.normal_flip()
    return f


def grid(k, pts, want, smooth=True):
    """a patch of quads over rows of points (pts[j][i]: (position, colour)), each facing `want`"""
    vs = []
    for row in pts:
        r = []
        for p, c in row:
            v = k.bm.verts.new(p)
            v[k.col] = (*c, 0.0)
            r.append(v)
        vs.append(r)
    for j in range(len(vs) - 1):
        for i in range(len(vs[j]) - 1):
            orient(k.bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i])), want).smooth = smooth
    return vs


def poly(k, pts, want):
    """one flat face over pts (position, colour), facing `want`"""
    vs = []
    for p, cc in pts:
        v = k.bm.verts.new(p)
        v[k.col] = (*cc, 0.0)
        vs.append(v)
    orient(k.bm.faces.new(vs), want)
    return vs


def hull(k, far):
    col = cedar(4)
    xs, n1 = stations(far)
    # the side's rows: closer round the waterline (the algae's band) and at the seam between its two planks
    rows = [0, 0.18, 0.3, 1] if far else [0, 0.13, 0.22, 0.31, 0.47, 0.5, 0.53, 0.76, 1]
    seam = lambda t: 0.0 if far else smoothstep(0.03, 0.0, abs(t - 0.5))
    plank = lambda t: 0 if t < 0.5 else 1
    for s in (1, -1):
        pts = [[(side_pt(x, t, s), col(side_pt(x, t, s), plank=plank(t) + (2 if s < 0 else 0)) * (1 - 0.5 * seam(t))) for t in rows] for x in xs]
        grid(k, pts, V((0, s, -0.3)))
    # the bottom (its own vertices: a sharp chine)
    ys = [-1, 0, 1] if far else [-1, -0.5, 0, 0.5, 1]
    pts = [[(V((x, hb(x) * u, zb(x))), col(V((x, hb(x) * u, zb(x))), plank=5) * 0.8) for u in ys] for x in xs]
    grid(k, pts, lambda c: V((max(0.0, c.x - 0.5), 0, -1)))
    # inside, from the stern to the foredeck (the stern's first station a board's thickness in)
    xi = [XS + T_SIDE * 1.2] + xs[1:n1 + 1]
    irows = [0, 1] if far else [0, 0.35, 0.7, 1]
    for s in (1, -1):
        pts = [[(side_pt(x, t, s, True), col(side_pt(x, t, s, True), True)) for t in irows] for x in xi]
        grid(k, pts, V((0, -s, 0.3)))
    ib = lambda x: hb(x) - T_SIDE * 1.3
    pts = [[(V((x, ib(x) * u, zb(x) + T_BOTTOM)), col(V((x, ib(x) * u, zb(x) + T_BOTTOM)), True)) for u in ys] for x in xi]
    grid(k, pts, V((0, 0, 1)))
    # the gunwales' tops, worn pale
    for s in (1, -1):
        pts = [[(side_pt(xo, 1, s), WORN * 0.9), (side_pt(x, 1, s, True), WORN * 0.8)] for xo, x in zip(xs, xi)]
        grid(k, pts, V((0, 0, 1)), smooth=False)
    # the transom: the stern's outer and inner faces and its top
    ring = lambda x, inner: ([side_pt(x, t, 1, inner) for t in reversed(irows if inner else rows)]
                             + [side_pt(x, t, -1, inner) for t in (irows if inner else rows)])
    poly(k, [(p, col(p, plank=6) * 0.9) for p in ring(XS, False)], V((-1, 0, 0)))
    poly(k, [(p, col(p, True)) for p in ring(xi[0], True)], V((1, 0, 0)))
    poly(k, [(side_pt(XS, 1, 1), WORN * 0.85), (side_pt(xi[0], 1, 1, True), WORN * 0.85),
             (side_pt(xi[0], 1, -1, True), WORN * 0.85), (side_pt(XS, 1, -1), WORN * 0.85)], V((0, 0, 1)))
    # the foredeck's bulkhead (seen from inside) and the foredeck over the bow to the tip
    poly(k, [(p, col(p, True) * 0.85) for p in ring(X_DECK, True)], V((-1, 0, 0)))
    deck = [side_pt(X_DECK, 1, 1, True)] + [side_pt(x, 1, 1) for x in xs[n1:]] + [side_pt(x, 1, -1) for x in reversed(xs[n1:])] + [side_pt(X_DECK, 1, -1, True)]
    poly(k, [(p, WORN.lerp(SILVER, 0.5) * 0.8) for p in deck], V((0, 0, 1)))
    # the bow's tip, closed, and the stem post up its face
    poly(k, [(p, col(p, plank=7)) for p in ring(XB, False)], V((1, 0, 0)))
    k.beam(SILVER * 0.7, V((XB - 0.02, 0, zb(XB) - 0.01)), V((XB + 0.06, 0, zg(XB) + 0.12)), 0.07, 0.06, up=V((0, 1, 0)))
    # the rubbing strake under the sheer, along both sides: a bar of three faces against the planks
    if not far:
        for s in (1, -1):
            axis = [side_pt(x, 0.9, s) for x in xs[:-1]]
            prof = [(-0.032, 0.0), (-0.032, 0.026), (0.032, 0.026), (0.032, 0.0)]  # (up the side, out)
            vs = []
            for j, p in enumerate(axis):
                t = (axis[min(j + 1, len(axis) - 1)] - axis[max(j - 1, 0)]).normalized()
                up = (side_pt(p.x, 1, s) - side_pt(p.x, 0, s)).normalized()
                out = t.cross(up).normalized()
                if out.y * s < 0:
                    out = -out
                c = col(p, plank=9) * 0.82
                r = []
                for a, b in prof:
                    v = k.bm.verts.new(p + up * a + out * b)
                    v[k.col] = (*c, 0.0)
                    r.append(v)
                vs.append((r, p + out * 0.013))
            for j in range(len(vs) - 1):
                for i in range(3):
                    (r0, c0), (r1, _) = vs[j], vs[j + 1]
                    orient(k.bm.faces.new((r0[i], r0[i + 1], r1[i + 1], r1[i])), lambda c, c0=c0: c - c0).smooth = False
            for (r, _), d in ((vs[0], -1), (vs[-1], 1)):
                orient(k.bm.faces.new(r), V((d, 0, 0)))


def thwarts(k, far):
    """three thwarts through the sides, their ends showing outside; ribs and floor timbers between"""
    for x in (-1.25, -0.05, 1.0):
        z = zg(x) - 0.07
        t = (z - zb(x)) / (zg(x) - zb(x))
        y = side_pt(x, t, 1).y + 0.035
        k.box(BROWN.lerp(SILVER, 0.4) * 0.85, (0.13, 2 * y, 0.065), V((x, 0, z)))
    if far:
        return
    for x in (-1.85, -0.65, 0.45):
        for s in (1, -1):
            a, b = side_pt(x, 0.02, s, True), side_pt(x, 0.97, s, True)
            a.y -= s * 0.012; b.y -= s * 0.012
            k.beam(INSIDE * 0.75, a, b, 0.026, 0.055, up=V((1, 0, 0)))
        y = hb(x) - T_SIDE * 1.3
        k.beam(FLOOR * 0.9, V((x, -y, zb(x) + T_BOTTOM + 0.014)), V((x, y, zb(x) + T_BOTTOM + 0.014)), 0.06, 0.028)
    # the stern deck the sculler stands on
    x0, x1 = XS + T_SIDE * 1.2, -1.82
    z = zg(-2.0) - 0.04
    w = 2 * (side_pt(-1.9, 0.9, 1, True).y)
    k.box(WORN.lerp(BROWN, 0.5) * 0.85, (x1 - x0, w, 0.03), V(((x0 + x1) / 2, 0, z)))


def bilge(k, far):
    """a little water in the bilge, loose floor boards over it"""
    zw = zb(0) + T_BOTTOM + 0.022
    xs = [-1.55, -1.0, -0.4, 0.2, 0.75] if not far else [-1.55, 0.75]
    pts = []
    for x in xs:
        t = 0.06
        y = side_pt(x, t, 1, True).y
        pts.append([(V((x, -y, zw)), BILGE), (V((x, y, zw)), BILGE * 1.1)])
    grid(k, pts, V((0, 0, 1)), smooth=False)
    if far:
        return
    rng = random.Random(5)
    for y, x0, x1 in ((-0.2, -1.6, 0.85), (0.0, -1.5, 0.95), (0.2, -1.65, 0.7)):
        k.box(FLOOR.lerp(SILVER, 0.3) * rng.uniform(0.85, 1.05), (x1 - x0, 0.17, 0.018), V(((x0 + x1) / 2, y + rng.uniform(-0.02, 0.02), zb(0) + T_BOTTOM + 0.04)), rz=rng.uniform(-0.02, 0.02))


def gear(k, far):
    """the pole resting on the forward thwart and the transom, the oar shipped along the starboard side on the thwarts
    and the stern deck, its peg, the coil of rope on the floor boards"""
    seg = 4 if far else 6
    # the sao: bamboo, its nodes in darker rings, its foot out over the stern
    a, b = V((1.4, 0.31, zg(1.0) - 0.0375 + 0.022)), V((-2.2, 0.33, zg(XS) + 0.022))
    b = a + (b - a) * (4.3 / (b - a).length)
    k.cyl(BAMBOO, a, b, 0.022, seg=seg)
    if not far:
        for i in range(1, 11):
            p = a.lerp(b, i / 11)
            d = (b - a).normalized() * 0.008
            k.cyl(BAMBOO * 0.6, p - d, p + d, 0.0245, seg=seg, cap=False)
    # the ro: its blade lying flat on the two forward thwarts, the loom bent up from it onto the stern deck
    blade0 = V((-0.2, -0.3, zg(-0.05) - 0.0375 + 0.016))
    blade1 = V((1.35, -0.27, zg(1.0) - 0.0375 + 0.016))
    grip = V((-2.25, -0.32, zg(-2.0) - 0.04 + 0.015 + 0.03))
    k.beam(OAR * 1.05, blade0, blade1, 0.15, 0.028)
    k.cyl(OAR, grip, blade0 + V((0.06, 0, 0.012)), 0.027, seg=seg)
    if not far:
        k.cyl(OAR * 0.8, grip, grip + V((0, 0, 0.16)), 0.017, seg=5)  # the handle's grip (tsuku)
        # the peg (rogui) on the stern deck the oar pivots on in use
        k.cyl(IRON, V((-2.0, -0.1, zg(-2.0) - 0.03)), V((-2.0, -0.1, zg(-2.0) + 0.05)), 0.018, seg=6)
        # the coil of rope on the floor boards
        pts = []
        c = V((0.68, 0.1, zb(0) + T_BOTTOM + 0.049))
        for i in range(38):
            u = i / 37
            ang = u * math.tau * 3.2
            r = lerp(0.07, 0.19, u)
            pts.append(c + V((math.cos(ang) * r, math.sin(ang) * r, 0.014 + 0.016 * math.sin(u * math.pi * 3.2) ** 2)))
        k.tube(pts, [0.014] * len(pts), 5, lambda p, al, ar: (ROPE * (0.8 + 0.3 * (0.5 + 0.5 * math.cos(ar * math.tau))), 0.0))
        # the peg through the stem the bow line is tied to (src/boat.js BOW_PEG)
        k.cyl(IRON, V((XB - 0.1, -0.06, zg(XB) - 0.05)), V((XB - 0.1, 0.06, zg(XB) - 0.05)), 0.016, seg=6)


def boat(level):
    far = level == '_far'
    k = Kit()
    hull(k, far)
    thwarts(k, far)
    bilge(k, far)
    gear(k, far)
    return finish(k, 'boat' + level, 0.6)


def mask():
    """the hull's inside a little above the waterline, flat: the page draws it into the depth buffer only, so the river's
    surface is not drawn over the floor inside the hull"""
    k = Kit()
    zm = WATERLINE + 0.035
    xs, n1 = stations(False)
    rows = []
    for x in [XS + T_SIDE * 1.2] + xs[1:n1 + 1]:
        z0 = zb(x) + T_BOTTOM
        if z0 > zm - 0.005:
            continue
        t = (zm - z0) / (zg(x) - z0)
        rows.append([(side_pt(x, t, 1, True), BILGE), (side_pt(x, t, -1, True), BILGE)])
    grid(k, rows, V((0, 0, 1)), smooth=False)
    bm = k.bm
    bmesh.ops.triangulate(bm, faces=bm.faces)
    me = bpy.data.meshes.new('boat_mask')
    bm.to_mesh(me)
    bm.free()
    link(me, 'boat_mask')
    return me


def stake():
    k = Kit()
    rng = random.Random(8)
    col = cedar(9)
    # a round stake, sunk 0.4 m, leaning a little, its top split and darkened
    seg, top = 7, 0.92
    rows = [-0.4, 0.0, 0.3, 0.5, 0.7, top]
    rings = []
    for z in rows:
        r = 0.05 * (1 - 0.06 * (z / top))
        rr = []
        for i in range(seg):
            a = math.tau * i / seg
            p = V((math.cos(a) * r, math.sin(a) * r, z))
            v = k.bm.verts.new(p)
            c = BROWN.lerp(SILVER, 0.5 + 0.3 * noise.noise(p * 9)) * (0.6 if z <= 0.05 else 1.0)
            v[k.col] = (*c, 0.0)
            rr.append(v)
        rings.append(rr)
    for j in range(len(rings) - 1):
        for i in range(seg):
            k.bm.faces.new((rings[j][i], rings[j][(i + 1) % seg], rings[j + 1][(i + 1) % seg], rings[j + 1][i])).smooth = True
    capc = k.bm.verts.new(V((0.0, 0.0, top + 0.02)))
    capc[k.col] = (*(BROWN * 0.6), 0.0)
    for i in range(seg):
        k.bm.faces.new((rings[-1][i], rings[-1][(i + 1) % seg], capc))
    k.box(BROWN * 0.35, (0.1, 0.008, 0.12), V((0.0, 0.0, top - 0.04)))  # the split down from its top
    # the rope's turns round it, and the line leaving towards the boat (+x)
    pts = []
    turns, per = 2.6, 12
    for i in range(int(turns * per) + 1):
        a = math.tau * i / per
        pts.append(V((math.cos(a) * 0.064, math.sin(a) * 0.064, ROPE_Z - 0.05 + 0.08 * i / (turns * per))))
    pts.append(V((0.12, 0.0, ROPE_Z + 0.005)))
    pts.append(V((0.18, 0.0, ROPE_Z - 0.01)))
    k.tube(pts, [0.015] * len(pts), 5, lambda p, al, ar: (ROPE * (0.75 + 0.35 * (0.5 + 0.5 * math.cos(ar * math.tau))), 0.0))
    return finish(k, 'stake', 0.25)


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for me in (boat(''), boat('_far'), mask(), stake()):
        print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
