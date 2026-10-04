# The traveller: a human for the first-person walk, built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/human.py -- <out.glb>
# A man of about 1.65 m (eyes 1.55 m up) on the road in an indigo kasuri kimono hitched to the knee, a narrow obi
# knotted at the back, dark gaiters (kyahan) over his shins, white split-toe tabi on geta, his hair tied back under a
# conical straw hat (sugegasa). Blender: z up, facing -y, his left at +x (glTF: y up, facing +z), feet on z = 0.
# The body's parts are signed distance fields (numpy) meshed by surface nets, pulled onto the surface and decimated to
# a budget: the head (face, ears, lids), the hair and its knot, the hands, the legs in their gaiters and tabi, and the
# kimono as a shell of cloth over a solid (open at the hem, the cuffs and the neck, the V of the collar cut into it), its
# folds displaced into the field, with the collar, the obi and the chest under the V each a mesh of its own (so their
# colours meet at an edge, not across a triangle); the eyeballs, the geta and the hat are built directly. Colours are
# painted per vertex from the same fields after decimation, then ambient occlusion (ray cast over the whole figure)
# darkens them; alpha says which woven pattern the page draws over the cloth (src/walker.js): 1 the kimono's kasuri,
# 0.5 the obi's stripes, 0 none. Skin weights come from the same anatomy (by height and side, the skirt with the legs,
# the sleeves' pouches partly with the chest so their swing is damped).
# Meshes, all skinned to one armature (`human_rig`):
# - `human`: everything below the chest (Z_CUT, the triangles cut along it), with a solid inside the robe under the
#   cut so a camera at the eye looking down sees a chest, not the inside of the robe;
# - `human_head`: the head, the neck, the hat and the robe's shoulders, which the first-person view hides;
# - `human_far`: the whole figure, decimated, for beyond 40 m.
# Clips (in place: the page moves the figure), keyed from the poses computed here: `idle` (4 s: breathing, a slow
# sway), `walk` (1.4 m/s) and `hurry` (2.6 m/s), each one stride long from the left heel's strike, the legs posed by
# inverse kinematics on footholds that travel back at the clip's speed (so the feet don't slide), the hips lowered
# where the legs could not reach.
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

V = Vector


def srgb(h):
    return np.array([((int(h[i:i + 2], 16) / 255 + 0.055) / 1.055) ** 2.4 for i in (1, 3, 5)])


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    t = np.asarray(t)[..., None] if np.ndim(a) else t
    return a + (b - a) * t


# ---------- proportions (m) ----------
SOLE = 0.055          # top of the geta: the tabi's soles
EYE = V((0.0, -0.081, 1.553))   # between the eyes (src/walker.js EYE)
Z_CUT = 1.15          # above: `human_head` (hidden in the first-person view)
HEM = 0.43            # the kimono hitched to just below the knee, as travellers wore it
# joints (left side; mirrored): bone heads and tails
J = {
    'hips': ((0, 0.0, 0.92), (0, 0.0, 1.02)),
    'spine': ((0, 0.0, 1.02), (0, 0.0, 1.16)),
    'chest': ((0, 0.0, 1.16), (0, 0.012, 1.375)),
    'neck': ((0, 0.014, 1.385), (0, 0.004, 1.47)),
    'head': ((0, 0.004, 1.47), (0, 0.004, 1.655)),
    'shoulder_L': ((0.025, 0.004, 1.37), (0.168, 0.022, 1.348)),
    'upper_arm_L': ((0.168, 0.022, 1.348), (0.212, 0.028, 1.06)),
    'forearm_L': ((0.212, 0.028, 1.06), (0.232, -0.008, 0.822)),
    'hand_L': ((0.232, -0.008, 0.822), (0.236, -0.02, 0.66)),
    'thigh_L': ((0.086, 0.0, 0.872), (0.086, -0.006, 0.511)),
    'shin_L': ((0.086, -0.006, 0.511), (0.086, 0.016, 0.121)),
    'foot_L': ((0.086, 0.016, 0.121), (0.09, -0.112, 0.068)),
    'toe_L': ((0.09, -0.112, 0.068), (0.093, -0.17, 0.066)),
}
PARENT = {'hips': None, 'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck', 'shoulder': 'chest',
          'upper_arm': 'shoulder', 'forearm': 'upper_arm', 'hand': 'forearm', 'thigh': 'hips', 'shin': 'thigh',
          'foot': 'shin', 'toe': 'foot'}
for k in list(J):
    if k.endswith('_L'):
        (a, b) = J[k]
        J[k[:-2] + '_R'] = ((-a[0], a[1], a[2]), (-b[0], b[1], b[2]))


def parent_of(name):
    base, side = (name[:-2], name[-2:]) if name[-2:] in ('_L', '_R') else (name, '')
    p = PARENT[base]
    if p is None:
        return None
    return p + side if p + '_L' in J else p


# ---------- signed distance fields (numpy, elementwise over arrays of any shape) ----------
def length3(x, y, z):
    return np.sqrt(x * x + y * y + z * z)


def sphere(p, c, r):
    x, y, z = p
    return length3(x - c[0], y - c[1], z - c[2]) - r


def ellipsoid(p, c, r):
    """close to the true distance near the surface (k0 * (k0 - 1) / k1)"""
    x, y, z = p
    qx, qy, qz = (x - c[0]) / r[0], (y - c[1]) / r[1], (z - c[2]) / r[2]
    k0 = length3(qx, qy, qz)
    k1 = length3(qx / r[0], qy / r[1], qz / r[2])
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def capsule(p, a, b, ra, rb=None):
    """a cone from a to b rounded at both ends (radius ra at a, rb at b)"""
    rb = ra if rb is None else rb
    x, y, z = p
    bax, bay, baz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    pax, pay, paz = x - a[0], y - a[1], z - a[2]
    h = np.clip((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0.0, 1.0)
    return length3(pax - bax * h, pay - bay * h, paz - baz * h) - (ra + (rb - ra) * h)


def rbox(p, c, half, r, rot=None):
    """a box rounded by r; rot: 3x3 rows = the box's axes in world"""
    x, y, z = p[0] - c[0], p[1] - c[1], p[2] - c[2]
    if rot is not None:
        x, y, z = (rot[0][0] * x + rot[0][1] * y + rot[0][2] * z, rot[1][0] * x + rot[1][1] * y + rot[1][2] * z,
                   rot[2][0] * x + rot[2][1] * y + rot[2][2] * z)
    qx, qy, qz = np.abs(x) - half[0] + r, np.abs(y) - half[1] + r, np.abs(z) - half[2] + r
    out = length3(np.maximum(qx, 0), np.maximum(qy, 0), np.maximum(qz, 0))
    return out + np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0.0) - r


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


# ---------- meshing: surface nets over a grid, vertices pulled onto the surface ----------
def surface_nets(fn, lo, hi, h):
    lo, hi = np.array(lo, np.float64), np.array(hi, np.float64)
    n = (np.ceil((hi - lo) / h) + 1).astype(int)
    ax = [lo[i] + h * np.arange(n[i]) for i in range(3)]
    F = np.empty(n, np.float32)
    step = max(1, int(4e6 // (n[0] * n[1])))
    for k0 in range(0, n[2], step):
        X, Y, Z = np.meshgrid(ax[0], ax[1], ax[2][k0:k0 + step], indexing='ij')
        F[:, :, k0:k0 + step] = fn((X, Y, Z))
    nx, ny, nz = n
    cs = (nx - 1, ny - 1, nz - 1)
    sx, sy, sz = np.zeros(cs, np.float32), np.zeros(cs, np.float32), np.zeros(cs, np.float32)
    cnt = np.zeros(cs, np.int16)
    edges = []
    for axis in range(3):
        a = F[tuple(slice(0, -1) if i == axis else slice(None) for i in range(3))]
        b = F[tuple(slice(1, None) if i == axis else slice(None) for i in range(3))]
        m = (a < 0) != (b < 0)
        t = np.where(m, a / np.where(m, a - b, 1.0), 0.0).astype(np.float32)
        edges.append((m, a < 0))
        others = [i for i in range(3) if i != axis]
        for o1 in (0, 1):
            for o2 in (0, 1):
                sl = [slice(None)] * 3
                sl[others[0]] = slice(o1, o1 + cs[others[0]])
                sl[others[1]] = slice(o2, o2 + cs[others[1]])
                mm, tt = m[tuple(sl)], t[tuple(sl)]
                acc = [sx, sy, sz]
                acc[axis] += tt
                acc[others[0]] += o1 * mm
                acc[others[1]] += o2 * mm
                cnt += mm
    act = cnt > 0
    idx = -np.ones(cs, np.int64)
    idx[act] = np.arange(int(act.sum()))
    I, Jj, K = np.nonzero(act)
    c = cnt[act].astype(np.float32)
    verts = lo + h * np.stack([I + sx[act] / c, Jj + sy[act] / c, K + sz[act] / c], 1)
    quads = []
    for axis, (m, inside_lo) in enumerate(edges):
        o = [i for i in range(3) if i != axis]
        sl = [slice(None)] * 3
        sl[o[0]] = slice(1, -1)
        sl[o[1]] = slice(1, -1)
        E = list(np.nonzero(m[tuple(sl)]))
        E[o[0]] += 1
        E[o[1]] += 1
        flip = ~inside_lo[tuple(E)]

        def cell(d0, d1):
            e = list(E)
            e[o[0]] = e[o[0]] - d0
            e[o[1]] = e[o[1]] - d1
            return idx[tuple(e)]
        # counter-clockwise seen from +axis (o[0] x o[1] = axis for x: y,z; y: z,x; z: x,y)
        if axis == 1:
            q = np.stack([cell(1, 1), cell(1, 0), cell(0, 0), cell(0, 1)], 1)
        else:
            q = np.stack([cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)], 1)
        q[flip] = q[flip][:, ::-1]
        quads.append(q)
    quads = np.concatenate(quads)
    quads = quads[(quads >= 0).all(1)]
    # pull the vertices onto the surface (Newton steps along the field's gradient, at most a cell each)
    for _ in range(3):
        verts = project(fn, verts, h)
    return verts, quads


def grad(fn, P, e):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    return np.stack([fn((x + e, y, z)) - fn((x - e, y, z)), fn((x, y + e, z)) - fn((x, y - e, z)),
                     fn((x, y, z + e)) - fn((x, y, z - e))], 1) / (2 * e)


def project(fn, P, h):
    d = fn((P[:, 0], P[:, 1], P[:, 2]))
    g = grad(fn, P, h * 0.25)
    gg = np.maximum((g * g).sum(1), 1e-12)
    s = np.clip(d / gg, -h / np.sqrt(gg), h / np.sqrt(gg))
    return P - g * s[:, None]


def to_mesh(name, verts, quads):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], quads.tolist())
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='BEAUTY')
    bm.to_mesh(me)
    bm.free()
    return me


def decimate(me, target, protect=None):
    """collapse to about `target` triangles; protect(P) -> 0..1 per vertex keeps detail where it is high"""
    ob = bpy.data.objects.new(me.name, me)
    bpy.context.collection.objects.link(ob)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris))
    dec.use_collapse_triangulate = True
    if protect is not None:
        P = np.array([v.co for v in me.vertices])
        w = protect(P)
        vg = ob.vertex_groups.new(name='protect')
        for i, wi in enumerate(w):
            vg.add([i], float(wi), 'REPLACE')
        dec.vertex_group = 'protect'
        dec.vertex_group_factor = 2.0
        dec.invert_vertex_group = True
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    out.name = me.name
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    if 'protect' in out.attributes:
        out.attributes.remove(out.attributes['protect'])
    return out


def sdf_part(name, fn, lo, hi, h, target, protect=None, cull=None):
    """mesh a field in the box lo..hi with cells of h, decimated to `target` triangles; cull(P) -> True where a
    vertex is never seen (faces all of whose vertices are culled go)"""
    verts, quads = surface_nets(fn, lo, hi, h)
    if cull is not None:
        quads = quads[~cull(verts)[quads].all(1)]
    me = to_mesh(name, verts, quads)
    print(f'{name}: {len(quads) * 2} triangles meshed', flush=True)
    return decimate(me, target, protect)


def positions(me):
    P = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', P)
    return P.reshape(-1, 3)


# ---------- palette (linear) ----------
SKIN = srgb('#d6a283')
SKIN_HAND = srgb('#c99274')       # a traveller's hands, browner from the road
LIP = srgb('#b06a5c')
HAIR = srgb('#1a1513')
BROW = srgb('#211915')
SCLERA = srgb('#d9d0c6')
IRIS = srgb('#3b2418')
PUPIL = srgb('#0d0a09')
INDIGO = srgb('#2e3c60')          # the kimono, under its kasuri (drawn by the page)
INDIGO_D = srgb('#202b45')        # its collar
JUBAN = srgb('#c6c8c4')           # the under-kimono's collar
OBI = srgb('#5c3436')             # plum-brown
KYAHAN = srgb('#262d3d')
TABI = srgb('#e6e1d4')
TABI_SOLE = srgb('#8b877e')
KOHAZE = srgb('#a88a4a')
WOOD = srgb('#b48f62')
WOOD_D = srgb('#7a5a3a')
HANAO = srgb('#6f1d24')
STRAW = srgb('#b8a06a')
STRAW_D = srgb('#7d6a42')
CORD = srgb('#3a2c22')


# ---------- the head: skull, face, ears, eyes and lids, neck, hair tied back ----------
EYE_C = (0.0315, -0.0725, 1.554)   # the left eyeball's centre (mirrored)
EYE_R = 0.0122
EAR_C = (0.0775, 0.01, 1.549)
KNOT = (0, 0.1, 1.522)
LIP_UP = ((0, -0.0912, 1.4852), (0.0185, 0.0072, 0.0058))
LIP_LO = ((0, -0.0886, 1.4745), (0.0165, 0.0078, 0.0064))


def head_fields(p):
    x, y, z = p
    X = np.abs(x)
    q = (X, y, z)
    f = {}
    d = ellipsoid(p, (0, 0.008, 1.566), (0.0735, 0.0935, 0.089))                     # cranium
    d = smin(d, ellipsoid(p, (0, -0.03, 1.515), (0.059, 0.066, 0.072)), 0.03)         # face
    d = smin(d, capsule(q, (0.054, 0.0, 1.5), (0.017, -0.064, 1.458), 0.016, 0.013), 0.02)   # jaw
    d = smin(d, ellipsoid(p, (0, -0.07, 1.461), (0.019, 0.017, 0.018)), 0.014)        # chin
    d = smin(d, ellipsoid(q, (0.043, -0.062, 1.532), (0.021, 0.018, 0.015)), 0.016)   # cheekbones
    d = smin(d, ellipsoid(q, (0.04, -0.058, 1.502), (0.02, 0.02, 0.02)), 0.018)      # cheeks
    d = smin(d, capsule(q, (0.011, -0.0855, 1.5745), (0.05, -0.073, 1.5735), 0.0085, 0.0065), 0.01)  # brow ridge
    d = smax(d, -ellipsoid(q, (0.032, -0.083, 1.5545), (0.0195, 0.0135, 0.0125)), 0.006)  # eye sockets
    # nose
    d = smin(d, capsule(p, (0, -0.087, 1.566), (0, -0.1025, 1.522), 0.0062, 0.0088), 0.01)
    d = smin(d, sphere(p, (0, -0.1045, 1.5145), 0.0105), 0.006)
    d = smin(d, sphere(q, (0.0122, -0.0955, 1.5095), 0.0074), 0.005)
    d = smax(d, -ellipsoid(q, (0.0066, -0.1, 1.5035), (0.0034, 0.0042, 0.0021)), 0.0018)
    # mouth: the muzzle, lips, the line between them, the philtrum
    d = smin(d, ellipsoid(p, (0, -0.069, 1.487), (0.03, 0.03, 0.028)), 0.015)
    lips = np.minimum(ellipsoid(p, LIP_UP[0], LIP_UP[1]), ellipsoid(p, LIP_LO[0], LIP_LO[1]))
    d = smin(d, lips, 0.004)
    d = smax(d, -ellipsoid(p, (0, -0.0965, 1.4797), (0.0185, 0.012, 0.001)), 0.0012)
    d = smax(d, -capsule(p, (0, -0.0982, 1.4965), (0, -0.0962, 1.4905), 0.0011), 0.0015)
    # ears: a shell standing out from the head, tilted back, its rim round a bowl, the lobe below
    ex, ey, ez = X - EAR_C[0], y - EAR_C[1], z - EAR_C[2]
    c, s = math.cos(0.22), math.sin(0.22)
    ey, ez = ey * c - ez * s, ey * s + ez * c
    ex = ex - 0.15 * (ey + 0.012)     # the back of the ear stands out further
    ear = ellipsoid((ex, ey, ez), (0, 0.001, 0.0), (0.0075, 0.0172, 0.0265))
    ear = smin(ear, ellipsoid((ex, ey, ez), (-0.001, -0.002, -0.022), (0.006, 0.009, 0.01)), 0.004)
    ear = smax(ear, -ellipsoid((ex, ey, ez), (0.0075, 0.001, 0.003), (0.0045, 0.0115, 0.019)), 0.0025)
    d = smin(d, ear, 0.005)
    # neck (into the collar)
    d = smin(d, capsule(p, (0, 0.016, 1.33), (0, 0.006, 1.49), 0.057, 0.051), 0.025)
    f['skin'] = d
    # eyes: the ball, an upper and a lower lid round it (an almond opening)
    ec = EYE_C
    ball = sphere(q, ec, EYE_R)
    dx = X - ec[0]
    up = smax(sphere(q, ec, EYE_R + 0.0014), (ec[2] + 0.0027 - 11.0 * dx * dx + 0.06 * dx) - z, 0.0012)
    lo = smax(sphere(q, ec, EYE_R + 0.001), z - (ec[2] - 0.0046 + 7.0 * dx * dx), 0.0012)
    lids = np.minimum(up, lo)
    f['ball'] = ball
    d = smin(d, lids, 0.0035)
    # hair: over the skull, its line round the face and ears, drawn back into a knot at the nape; combed grooves
    shell = ellipsoid(p, (0, 0.007, 1.572), (0.0805, 0.1015, 0.0965))
    face_cut = -ellipsoid(p, (0, -0.088, 1.514), (0.07, 0.08, 0.097))
    ear_cut = -ellipsoid(q, (EAR_C[0], EAR_C[1] - 0.004, EAR_C[2] - 0.006), (0.03, 0.021, 0.029))
    nape = 1.5 - z + 0.25 * np.maximum(0, -y) + 0.2 * np.maximum(0, X - 0.03)
    hair = smax(shell, np.maximum(np.maximum(face_cut, ear_cut), nape), 0.006)
    knot = ellipsoid(p, KNOT, (0.025, 0.021, 0.023))
    tie = capsule(p, (-0.019, KNOT[1] - 0.012, KNOT[2] + 0.014), (0.019, KNOT[1] - 0.012, KNOT[2] + 0.014), 0.0055)
    hair = smin(hair, knot, 0.012)
    # combed back to the knot: grooves that converge on it, fading out before they crowd
    dk = np.sqrt((y - KNOT[1]) ** 2 + (z - KNOT[2]) ** 2)
    hair = hair + 0.0005 * np.sin(x / (0.03 + 0.7 * dk) * 200.0) * sstep(0.035, 0.08, dk)
    hair = np.minimum(hair, tie)
    f['hair'] = hair
    f['tie'] = tie
    d = smax(d, 1.335 - z, 0.004)    # the neck's foot, hidden in the robe
    f['d'] = d
    return f


def head_sdf(p):
    return head_fields(p)['d']


def hair_sdf(p):
    return head_fields(p)['hair']


def hair_colour(P):
    f = head_fields((P[:, 0], P[:, 1], P[:, 2]))
    x, z = P[:, 0], P[:, 2]
    col = HAIR * (0.85 + 0.3 * (0.5 + 0.5 * np.sin(x * 900.0 + z * 300.0)))[:, None]
    return np.where((f['tie'] <= f['hair'] + 6e-4)[:, None], srgb('#7a2a26'), col)


def eyes():
    """the eyeballs: spheres turned to look ahead, rings at the pupil's and the iris's edges so they stay sharp"""
    k = Kit()
    seg = 18
    rings = [(0.0, PUPIL), (0.2, PUPIL), (0.215, IRIS), (0.44, IRIS), (0.46, SCLERA), (0.8, SCLERA), (1.2, SCLERA),
             (1.6, SCLERA), (2.1, SCLERA), (math.pi, SCLERA)]
    for side in (1, -1):
        c = V((side * EYE_C[0], EYE_C[1], EYE_C[2]))
        verts, cols, faces = [], [], []
        for a, col in rings:
            for i in range(seg):
                b = math.tau * i / seg
                verts.append(c + V((math.sin(a) * math.cos(b), -math.cos(a), math.sin(a) * math.sin(b))) * EYE_R)
                cols.append(col)
        for j in range(len(rings) - 1):
            for i in range(seg):
                a0, a1 = j * seg + i, j * seg + (i + 1) % seg
                faces.append((a0, a1, a1 + seg, a0 + seg))
        k.add(verts, faces, np.array(cols), smooth=True)
    return k.mesh('eyes')


def head_protect(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    X = np.abs(x)
    face = sstep(-0.05, -0.08, y) * sstep(1.45, 1.47, z) * sstep(1.6, 1.585, z) * sstep(0.065, 0.05, X)
    eyes = sstep(0.03, 0.015, np.sqrt((X - EYE_C[0]) ** 2 + (z - EYE_C[2]) ** 2)) * sstep(-0.06, -0.075, y)
    return np.maximum(face * 0.55, eyes)


def head_colour(P):
    f = head_fields((P[:, 0], P[:, 1], P[:, 2]))
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    X = np.abs(x)
    n = len(P)
    col = np.tile(SKIN, (n, 1))
    # warmer cheeks, ears and nose tip; the neck a little darker
    blush = sstep(0.03, 0.0, np.sqrt((X - 0.042) ** 2 + (z - 1.522) ** 2)) * sstep(-0.05, -0.075, y)
    col = mix(col, srgb('#d48a76'), 0.35 * blush)
    col = mix(col, srgb('#cf8a72'), 0.4 * sstep(0.068, 0.078, X) * sstep(-0.01, 0.0, y))
    col = mix(col, srgb('#d39078'), 0.3 * sstep(0.012, 0.0, np.sqrt(x ** 2 + (y + 0.11) ** 2 + (z - 1.515) ** 2)))
    col = mix(col, SKIN * 0.86, sstep(1.45, 1.4, z))
    # lips
    lip = sstep(0.004, 0.0, np.minimum(ellipsoid((x, y, z), *LIP_UP), ellipsoid((x, y, z), *LIP_LO))) \
        * sstep(-0.084, -0.09, y)
    col = mix(col, LIP, 0.8 * lip)
    # brows: arched, thicker inside, thinning out
    t = np.clip((X - 0.012) / 0.04, 0, 1)
    bz = 1.5765 + 0.004 * np.sin(t * math.pi * 0.85) - 0.002 * t
    bw = 0.0042 - 0.002 * t
    brow = sstep(bw, bw * 0.4, np.abs(z - bz)) * sstep(0.008, 0.013, X) * sstep(0.056, 0.048, X) * sstep(-0.065, -0.075, y)
    col = mix(col, BROW, 0.88 * brow)
    # the lash line along the upper lid's rim; a soft shadow over the lids
    ec = np.array(EYE_C)
    lash = sstep(0.0025, 0.0005, f['ball']) * sstep(EYE_C[2] - 0.001, EYE_C[2] + 0.003, z)
    col = mix(col, HAIR, 0.85 * lash)
    lid = sstep(0.02, 0.008, np.sqrt((X - ec[0]) ** 2 + (z - ec[2] - 0.004) ** 2))
    col = mix(col, SKIN * 0.8, 0.25 * lid)
    # under the hair's edge, darker
    col = mix(col, col * 0.7, sstep(0.004, 0.0, f['hair']))
    return col


# ---------- the hands (left; the right mirrors it), with the forearm up into the sleeve ----------
def hand_frame():
    """wrist, and the hand's axes: u along the fingers, v towards the thumb (forward), w towards the palm (inward)"""
    w0, w1 = V(J['hand_L'][0]), V(J['hand_L'][1])
    u = (w1 - w0).normalized()
    v = V((0, -1, 0))
    v = (v - u * v.dot(u)).normalized()
    return w0, u, v, u.cross(v)


HAND = hand_frame()
# fingers: base along the knuckles (a, b), spread (rad), lengths of the three bones, radius at base and tip, curl
# of each joint (rad, towards the palm): relaxed, the little finger curled most
FINGERS = [
    (0.094, 0.0245, 0.07, (0.04, 0.024, 0.02), 0.0088, 0.0068, (0.16, 0.38, 0.22)),
    (0.097, 0.0083, 0.0, (0.045, 0.028, 0.021), 0.009, 0.007, (0.2, 0.45, 0.25)),
    (0.094, -0.0083, -0.07, (0.042, 0.027, 0.02), 0.0085, 0.0066, (0.24, 0.52, 0.28)),
    (0.087, -0.024, -0.16, (0.033, 0.019, 0.018), 0.0075, 0.006, (0.3, 0.6, 0.3)),
]
THUMB = [((0.016, 0.02, 0.006), 0.0125), ((0.05, 0.043, 0.02), 0.0108), ((0.074, 0.053, 0.03), 0.0095), ((0.093, 0.056, 0.036), 0.0078)]


def finger_joints(fingers=None):
    """each finger's joints in the hand's frame (FINGERS by default; another figure's grip: its own list)"""
    out = []
    for a0, b0, spread, lens, r0, r1, curl in fingers or FINGERS:
        pts = [np.array((a0, b0, 0.0))]
        ang = 0.0
        for L, c in zip(lens, curl):
            ang += c
            d = np.array((math.cos(ang) * math.cos(spread), math.cos(ang) * math.sin(spread), math.sin(ang)))
            pts.append(pts[-1] + d * L)
        out.append((pts, r0, r1))
    return out


FINGER_JOINTS = finger_joints()


def hand_local(p):
    w0, u, v, w = HAND
    x, y, z = p[0] - w0.x, p[1] - w0.y, p[2] - w0.z
    return (x * u.x + y * u.y + z * u.z, x * v.x + y * v.y + z * v.z, x * w.x + y * w.y + z * w.z)


def hand_fields(p, joints=None, arm=0.25):
    """left hand; p in world (x >= 0 side). joints: finger_joints() of another grip; arm: how far the forearm
    reaches up from the wrist (m)"""
    q = hand_local(p)
    a, b, c = q
    f = {}
    palm = rbox(q, (0.05, 0.002, 0.0), (0.048, 0.039, 0.0128), 0.011)
    palm = smin(palm, ellipsoid(q, (0.036, 0.022, 0.009), (0.03, 0.016, 0.012)), 0.01)      # the thumb's mound
    palm = smin(palm, ellipsoid(q, (0.047, -0.025, 0.006), (0.035, 0.012, 0.01)), 0.01)
    fingers = None
    for pts, r0, r1 in joints or FINGER_JOINTS:
        n = len(pts) - 1
        for i in range(n):
            ra, rb = r0 + (r1 - r0) * i / n, r0 + (r1 - r0) * (i + 1) / n
            e = capsule(q, pts[i], pts[i + 1], ra, rb)
            fingers = e if fingers is None else np.minimum(fingers, e)
    thumb = None
    for (pa, ra), (pb, rb) in zip(THUMB[:-1], THUMB[1:]):
        e = capsule(q, pa, pb, ra, rb)
        thumb = e if thumb is None else np.minimum(thumb, e)
    d = smin(palm, fingers, 0.007)
    d = smin(d, thumb, 0.01)
    arm = capsule((a, b, c * 1.25), (-arm, 0, 0), (0.004, 0, 0), 0.033 + 0.03 * max(0.0, arm - 0.25), 0.0245)
    d = smin(d, arm, 0.016)
    f['d'] = d
    f['q'] = q
    return f


def hand_sdf(p):
    return hand_fields(p)['d']


def hand_colour(P, joints=None, arm=0.25):
    f = hand_fields((P[:, 0], P[:, 1], P[:, 2]), joints, arm)
    a, b, c = f['q']
    col = np.tile(SKIN_HAND, (len(P), 1))
    col = mix(col, SKIN_HAND * np.array([1.08, 1.0, 0.95]), 0.6 * sstep(0.0, 0.012, c))          # paler palms
    col = mix(col, srgb('#b97a62'), 0.35 * sstep(0.008, 0.0, np.abs(a - 0.098)) * sstep(0.0, -0.008, c))   # knuckles
    # nails: the backs of the finger tips
    nail = np.zeros(len(P))
    for pts, r0, r1 in joints or FINGER_JOINTS:
        tip, d = pts[-1], pts[-1] - pts[-2]
        d = d / np.linalg.norm(d)
        rel = np.stack([a - tip[0], b - tip[1], c - tip[2]], 1)
        along = rel @ d
        back = rel[:, 2] - along * d[2]
        nail = np.maximum(nail, sstep(-0.014, -0.009, along) * sstep(0.0, -0.004, back) * sstep(0.004, 0.0, along))
    col = mix(col, srgb('#d8b0a0'), 0.7 * nail)
    return col


# ---------- the legs (left): knee and shin in a gaiter (kyahan), the foot in a split-toe tabi ----------
TOE_OUT = math.radians(4)


def foot_local(p):
    """origin at the left ankle; fx outward, fy forward, fz up"""
    A = J['foot_L'][0]
    x, y, z = p[0] - A[0], p[1] - A[1], p[2] - A[2]
    c, s = math.cos(TOE_OUT), math.sin(TOE_OUT)
    return (x * c + y * s, x * s - y * c, z)


def leg_fields(p, use_gaiter=True):
    """the left leg; use_gaiter: the kyahan wrapped round the shin (else the bare shin)"""
    x, y, z = p
    K, A = J['shin_L'][0], J['shin_L'][1]
    f = {}
    leg = capsule(p, (K[0], 0.0, 0.66), K, 0.054, 0.046)
    leg = smin(leg, sphere(p, (K[0], K[1] - 0.004, K[2]), 0.043), 0.02)
    leg = smin(leg, capsule(p, K, A, 0.043, 0.028), 0.02)
    leg = smin(leg, ellipsoid(p, (K[0] + 0.004, 0.026, 0.395), (0.041, 0.04, 0.09)), 0.03)   # calf
    q = foot_local(p)
    fx, fy, fz = q
    foot = sphere(q, (0, 0, 0), 0.029)
    foot = smin(foot, sphere((np.abs(fx), fy, fz), (0.025, 0.0, -0.004), 0.012), 0.008)     # the ankle bones
    foot = smin(foot, ellipsoid(q, (0.0, -0.038, -0.034), (0.029, 0.037, 0.035)), 0.015)    # heel
    foot = smin(foot, rbox(q, (0.002, 0.048, -0.04), (0.037, 0.075, 0.026), 0.021), 0.02)   # the foot's body
    foot = smin(foot, capsule(q, (0, 0.0, -0.002), (0, 0.1, -0.032), 0.027, 0.02), 0.02)    # instep
    foot = smin(foot, ellipsoid(q, (0.003, 0.112, -0.046), (0.044, 0.03, 0.021)), 0.015)    # ball
    big = capsule(q, (-0.022, 0.12, -0.047), (-0.022, 0.172, -0.05), 0.0145, 0.0125)
    toes = rbox(q, (0.014, 0.146, -0.049), (0.024, 0.024, 0.0145), 0.012)
    foot = smin(foot, np.minimum(big, toes), 0.012)
    d = smin(leg, foot, 0.02)
    d = smax(d, SOLE - z, 0.002)
    # the gaiter: wrapped cloth a little proud of the shin, in soft bands, tied under the knee
    band = 0.0012 * (0.5 + 0.5 * np.cos(z * math.tau / 0.032))
    gaiter = smax(leg - 0.006 + band, np.maximum(0.15 - z, z - 0.47), 0.004)
    tie = smax(leg - 0.0085, np.abs(z - 0.452) - 0.0045, 0.002)
    gaiter = np.minimum(gaiter, tie)
    f['gaiter'], f['tie'], f['bare'] = gaiter, tie, d
    if not use_gaiter:
        gaiter = tie = np.full_like(d, 1.0)
        f['gaiter'], f['tie'] = gaiter, tie
    d = np.minimum(d, gaiter)
    d = smax(d, z - 0.64, 0.01)     # the thigh, up into the kimono
    f['d'] = d
    f['q'] = q
    return f


def leg_sdf(p):
    return leg_fields(p)['d']


def leg_colour(P):
    f = leg_fields((P[:, 0], P[:, 1], P[:, 2]))
    z = P[:, 2]
    col = np.tile(SKIN_HAND * 0.95, (len(P), 1))
    on_g = (f['gaiter'] <= f['d'] + 6e-4)
    col = np.where(on_g[:, None], KYAHAN * (0.92 + 0.16 * (0.5 + 0.5 * np.cos(z * math.tau / 0.032)))[:, None], col)
    col = np.where((f['tie'] <= f['d'] + 6e-4)[:, None], srgb('#b7ad97'), col)
    tabi = (~on_g) & (z < 0.2)
    col = np.where(tabi[:, None], TABI, col)
    col = np.where((tabi & (z < SOLE + 0.0025))[:, None], TABI_SOLE, col)
    return col


# ---------- direct geometry: geta, hat ----------
class Kit:
    """parts into one bmesh, a colour per vertex"""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Color')

    def add(self, verts, faces, col, smooth=False):
        vs = [self.bm.verts.new(p) for p in verts]
        cols = [col] * len(vs) if np.ndim(col) == 1 else col
        for v, c in zip(vs, cols):
            v[self.col] = (c[0], c[1], c[2], 0.0)
        for f in faces:
            try:
                self.bm.faces.new([vs[i] for i in f]).smooth = smooth
            except ValueError:
                pass
        return vs

    def tube(self, pts, r, col, seg=8):
        n = len(pts)
        verts, faces = [], []
        u = None
        for j, p in enumerate(pts):
            t = (pts[min(j + 1, n - 1)] - pts[max(j - 1, 0)]).normalized()
            if u is None:
                u = V((1, 0, 0)) if abs(t.x) < 0.9 else V((0, 1, 0))
            u = (u - t * u.dot(t)).normalized()
            w = t.cross(u)
            verts += [p + (u * math.cos(a) + w * math.sin(a)) * r for a in (math.tau * i / seg for i in range(seg))]
        for j in range(n - 1):
            for i in range(seg):
                k = (i + 1) % seg
                faces.append((j * seg + i, j * seg + k, (j + 1) * seg + k, (j + 1) * seg + i))
        faces += [tuple(reversed(range(seg))), tuple(range((n - 1) * seg, n * seg))]
        return self.add(verts, faces, col, smooth=True)

    def mesh(self, name):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        return me


def foot_matrix():
    """the left foot's frame (foot_local's inverse): origin at the ankle, x outward, y forward, z up"""
    A = V(J['foot_L'][0])
    c, s = math.cos(TOE_OUT), math.sin(TOE_OUT)
    return Matrix(((c, s, 0, A.x), (s, -c, 0, A.y), (0, 0, 1, A.z), (0, 0, 0, 1)))


# the geta in the foot's frame: deck from `back` to `front` (m forward of the ankle), half width `w`; the teeth
# across it at `teeth`; the clips rock on the teeth's outer edges (PIVOTS)
GETA = {'back': -0.055, 'front': 0.185, 'w': 0.052, 'teeth': (0.0, 0.13), 'tooth': 0.016, 'deck': 0.017}
PIVOTS = (GETA['teeth'][0] - GETA['tooth'] / 2, GETA['teeth'][1] + GETA['tooth'] / 2)


def geta():
    """the left geta and its thong, in world"""
    k = Kit()
    m = foot_matrix()
    A = J['foot_L'][0][2]
    zt, zd = SOLE - A - GETA['deck'], SOLE - A          # deck bottom and top in the foot's frame
    zb = -A                                             # the ground
    g0, g1, w = GETA['back'], GETA['front'], GETA['w']
    # the deck, its corners rounded off, the grain in its colour
    ring = []
    for i in range(28):
        t = (i + 0.5) / 28 * math.tau
        cx = (w - 0.012) * (1 if math.cos(t) > 0 else -1)
        cy = g1 - 0.016 if math.sin(t) > 0 else g0 + 0.016
        ring.append((cx + 0.012 * math.cos(t), cy + 0.016 * math.sin(t)))
    n = len(ring)
    verts = [m @ V((x, y, zt)) for x, y in ring] + [m @ V((x, y, zd)) for x, y in ring]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    cols = [WOOD * (0.9 + 0.12 * math.sin(x * 260.0)) for x, y in ring] * 2
    k.add(verts, faces, np.array(cols))
    # teeth: boards across, a little narrower at the foot
    for ty in GETA['teeth']:
        t2 = GETA['tooth'] / 2
        p = [V((x * (0.94 if z == zb else 1.0), y, z)) for z in (zb, zt) for y in (ty - t2, ty + t2) for x in (-w + 0.004, w - 0.004)]
        k.add([m @ q for q in p], [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)], WOOD_D)

    # the thong (hanao): from the hole between the big toe and the rest, up over the foot to each side
    def on_foot(q, lift):
        P = np.array([[q.x, q.y, q.z]])
        for _ in range(4):
            P = project(lambda pp: leg_sdf(pp) - lift, P, 0.004)
        return V(P[0])
    front = m @ V((-0.006, 0.152, zd))
    crev = on_foot(m @ V((-0.006, 0.135, zd + 0.02)), 0.0085)
    for side in (1, -1):
        pts = [front, crev]
        for fx, fy, fz in ((0.008, 0.123, 0.03), (0.02, 0.105, 0.033), (0.032, 0.091, 0.026), (0.042, 0.08, 0.015), (0.048, 0.074, 0.005)):
            pts.append(on_foot(m @ V((side * fx, fy, zd + fz)), 0.0085))
        pts.append(m @ V((side * 0.049, 0.072, zd - 0.002)))
        k.tube(pts, 0.006, HANAO, seg=7)
    return k.mesh('geta_L')


KASA = {'r': 0.25, 'h': 0.12, 'apex': V((0.0, 0.012, 1.722)), 'tilt': math.radians(-11)}


def kasa():
    """a sugegasa: a shallow cone of sedge, ribbed, two rings of stitching near the rim, a knob at the top, a
    headband ring under it; tilted back off the brow"""
    k = Kit()
    R, Hh = KASA['r'], KASA['h']
    seg = 96
    radii = [0.0, 0.03, 0.07, 0.11, 0.15, 0.185, 0.2, 0.215, 0.235, R]
    m = Matrix.Translation(KASA['apex']) @ Matrix.Rotation(KASA['tilt'], 4, 'X')
    top, bot = [], []
    for r in radii:
        for i in range(seg):
            a = math.tau * i / seg
            rib = 0.0012 * (1 if i % 2 else -1) * min(1, r / 0.05)
            z = -Hh * r / R + rib
            top.append(m @ V((r * math.cos(a), r * math.sin(a), z)))
            bot.append(m @ V((r * math.cos(a), r * math.sin(a), z - 0.007 + 0.003 * (r / R))))
    nr = len(radii)
    faces = []
    off = nr * seg
    for j in range(nr - 1):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            faces.append((a, a + seg, b + seg, b))
            faces.append((off + a, off + b, off + b + seg, off + a + seg))
    for i in range(seg):
        a, b = (nr - 1) * seg + i, (nr - 1) * seg + (i + 1) % seg
        faces.append((a, b, off + b, off + a))
    cols = []
    for side in (0, 1):
        for r in radii:
            for i in range(seg):
                c = STRAW * (0.88 + 0.16 * (i % 2)) * (1.0 - 0.12 * (r < 0.04))
                if r in (0.2, 0.235):
                    c = STRAW_D
                cols.append(c * (0.8 if side else 1.0))
    k.add(top + bot, faces, np.array(cols), smooth=True)
    # the knob and the headband
    k.tube([m @ V((0, 0, -0.004)), m @ V((0, 0, 0.012))], 0.012, STRAW_D, seg=10)
    k.tube([m @ V((0, 0, -0.055)), m @ V((0, 0, -0.035))], 0.074, srgb('#5a4630'), seg=20)
    return k.mesh('kasa')


# ---------- the kimono: a shell of cloth over a solid robe and its sleeves, the collar and the obi on it ----------
T_CLOTH = 0.011
# the robe's body by height: half width, half depth, centre (y); cinched by the obi, bloused a little above it
TORSO = np.array([
    (0.40, 0.18, 0.150, 0.0), (0.60, 0.173, 0.140, 0.0), (0.80, 0.169, 0.132, 0.006), (0.92, 0.163, 0.127, 0.008),
    (1.00, 0.156, 0.12, 0.006), (1.06, 0.159, 0.122, 0.0), (1.15, 0.155, 0.118, -0.004), (1.25, 0.16, 0.115, -0.004),
    (1.33, 0.172, 0.106, 0.0), (1.45, 0.172, 0.1, 0.004)])
ARM_X = ((0.88, 0.238), (1.06, 0.222), (1.348, 0.178))   # the sleeve's middle follows the hanging arm (z, x)
# the collar's V on the chest: its inner edges meet at V_TIP; the left panel's collar runs on down over the right
# panel to the obi, and its edge (okumi) on down the skirt
V_TIP = (-0.006, 1.245)
V_TOP = 1.40
V_HALF = 0.05             # the V's half width at V_TOP
COLLAR_W = 0.022          # the collar band's half width
NECK_RING = [(0.0, 0.086, 1.432), (0.036, 0.077, 1.429), (0.06, 0.05, 1.424), (0.073, 0.014, 1.415), (0.069, -0.026, 1.4)]
OKUMI = ((0.40, -0.068), (0.9, -0.086), (1.0, -0.084), (1.25, V_TIP[0] + COLLAR_W))   # the left panel's edge (z, x)
OBI_W = 0.047


def v_edge(z, side):
    """x of the V's inner edge at height z (side +1: the wearer's left)"""
    return V_TIP[0] + side * (z - V_TIP[1]) * V_HALF / (V_TOP - V_TIP[1])


def ell2(x, y, a, b):
    k0 = np.sqrt((x / a) ** 2 + (y / b) ** 2)
    k1 = np.sqrt((x / (a * a)) ** 2 + (y / (b * b)) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def torso_plain(p):
    x, y, z = p
    a = np.interp(z, TORSO[:, 0], TORSO[:, 1])
    b = np.interp(z, TORSO[:, 0], TORSO[:, 2])
    cy = np.interp(z, TORSO[:, 0], TORSO[:, 3])
    d = ell2(x, y - cy, a, b)
    top = 1.428 - 0.3 * np.maximum(0.0, np.abs(x) - 0.06)    # the shoulders' slope
    return smax(d, z - top, 0.03), cy


def sleeve_field(p):
    x, y, z = p
    X = np.abs(x)
    zs = [q[0] for q in ARM_X]
    xs = np.interp(z, zs, [q[1] for q in ARM_X]) + 0.004
    # its outline seen from the side, rounded, the back corner most; full round the arm, thin over the pouch
    y0, y1, z0, z1, r = -0.068, 0.155, 0.89, 1.33, 0.07
    yy, zz = y - (y0 + y1) / 2, z - (z0 + z1) / 2
    r = r + 0.03 * sstep(0.0, 0.1, y) * sstep(1.1, 0.95, z)
    qy = np.abs(yy) - (y1 - y0) / 2 + r
    qz = np.abs(zz) - (z1 - z0) / 2 + r
    d2 = np.sqrt(np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2) + np.minimum(np.maximum(qy, qz), 0) - r
    th = 0.049 - 0.022 * sstep(0.02, 0.13, y)
    d = smax(d2, np.abs(X - xs) - th, 0.03)
    # the shoulder: the sleeve's top over the arm, rounding into the robe's
    d = smin(d, capsule((X, y, z), (0.12, 0.018, 1.362), (0.212, 0.026, 1.09), 0.052, 0.048), 0.03)
    # its folds: draped down from the arm across the pouch
    d = d + 0.003 * np.sin(48.0 * (z + 0.55 * y) + 2.0 * np.sin(11.0 * y + 3.0 * z)) * sstep(0.02, 0.07, y) * sstep(1.25, 1.1, z)
    d = d + 0.0018 * np.sin(70.0 * z + 9.0 * y) * sstep(0.0, -0.04, y) * sstep(1.2, 1.05, z)
    return d


def ribbon(p, pts, nrm, hw, ht):
    """a flat band along a polyline, `hw` wide either side, `ht` thick either side of it, lying across nrm"""
    x, y, z = p
    out = None
    for i in range(len(pts) - 1):
        a, b = np.array(pts[i]), np.array(pts[i + 1])
        ba = b - a
        L = np.linalg.norm(ba)
        t = ba / L
        ox, oy, oz = x - a[0], y - a[1], z - a[2]
        along = ox * t[0] + oy * t[1] + oz * t[2]
        h = np.clip(along / L, 0.0, 1.0)
        n = [nrm[i][k] + (nrm[i + 1][k] - nrm[i][k]) * h for k in range(3)]
        nl = np.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
        n = [c / nl for c in n]
        w = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]]
        rx, ry, rz = ox - ba[0] * h, oy - ba[1] * h, oz - ba[2] * h
        on = rx * n[0] + ry * n[1] + rz * n[2]
        ow = rx * w[0] + ry * w[1] + rz * w[2]
        ot = rx * t[0] + ry * t[1] + rz * t[2]
        qn, qw = np.abs(on) - ht, np.abs(ow) - hw
        e = np.sqrt(np.maximum(qn, 0) ** 2 + np.maximum(qw, 0) ** 2 + ot * ot) + np.minimum(np.maximum(qn, qw), 0)
        out = e if out is None else np.minimum(out, e)
    return out


def collar_path(side, lift):
    """the collar's middle line and the band's normals: round the back of the neck (radial), then down the front
    beside the V (on the robe); the left panel's (side +1) on across the chest to the obi"""
    pts, nrm = [], []
    for q in NECK_RING:
        q = (side * q[0], q[1], q[2])
        pts.append(np.array(q))
        n = np.array((q[0], q[1] - 0.012, 0.0))
        nrm.append(n / np.linalg.norm(n))
    zf = [1.37, 1.33, 1.29, V_TIP[1]]
    front = [(v_edge(z, side) + side * COLLAR_W, -0.1, z) for z in zf]
    if side > 0:
        front += [(V_TIP[0] - 0.006, -0.12, 1.2), (-0.04, -0.124, 1.13), (-0.062, -0.126, 1.06), (-0.07, -0.126, 0.97)]
    else:
        front += [(V_TIP[0] + 0.02, -0.12, 1.215)]
    tp = lambda pp: torso_plain(pp)[0]
    P = np.array(front, np.float64)
    for _ in range(6):
        P = project(tp, P, 0.01)
    g = grad(tp, P, 0.002)
    g /= np.linalg.norm(g, axis=1)[:, None]
    for q, n in zip(P, g):
        pts.append(q + n * (0.004 + lift))
        nrm.append(n)
    return pts, nrm


COLLARS = None


def vee(p):
    """> 0 inside the collar's V (on the chest, in front)"""
    x, y, z = p
    return np.minimum(np.minimum(v_edge(z, 1) - x, x - v_edge(z, -1)), -0.02 - y)


def kimono_fields(p):
    global COLLARS
    if COLLARS is None:
        COLLARS = (collar_path(1, 0.004), collar_path(-1, 0.0))
    x, y, z = p
    X = np.abs(x)
    f = {}
    torso, cy = torso_plain(p)
    plain = torso
    # folds: vertical ones over the skirt, most at the back; the cloth bloused over the obi; the back seam
    th = np.arctan2(x, y - cy)
    skirt = sstep(0.95, 0.55, z)
    back = 0.55 + 0.45 * sstep(-0.5, 0.3, np.cos(th))
    torso = torso + (0.0065 * skirt + 0.0012) * back * (np.sin(9.0 * th + 1.2 * np.sin(3.0 * th + 6.0 * z) + 0.6)
                                                      + 0.45 * np.sin(16.0 * th + 2.0 + 4.0 * z))
    torso = torso - 0.004 * sstep(1.0, 1.04, z) * sstep(1.12, 1.05, z)
    torso = torso + 0.0014 * np.sin(z * 140.0 + 2.0 * th) * sstep(1.0, 1.03, z) * sstep(1.2, 1.08, z)
    torso = torso + 0.0015 * np.exp(-(x / 0.004) ** 2) * (y > cy)
    # the right panel under the left one's edge, down the front
    xe = np.interp(z, [q[0] for q in OKUMI], [q[1] for q in OKUMI])
    torso = torso + 0.004 * sstep(xe + 0.0015, xe - 0.0015, x) * sstep(-0.04, -0.08, y - cy) * sstep(1.26, 1.22, z)
    sleeve = sleeve_field(p)
    outer = smin(torso, sleeve, 0.006 + 0.012 * sstep(1.2, 1.32, z))
    # the V open on the chest
    v = vee(p)
    outer = smax(outer, v, 0.003)
    f['torso'], f['sleeve'], f['outer'] = torso, sleeve, outer
    shell = np.maximum(outer, -(outer + T_CLOTH))
    shell = smax(shell, HEM - z, 0.003)
    cuff = capsule((X, y, z), (0.213, 0.027, 1.02), (0.242, -0.016, 0.72), 0.045)
    shell = np.maximum(shell, -cuff)
    neck = capsule(p, (0, 0.014, 1.36), (0, 0.006, 1.6), 0.064)
    shell = smax(shell, -neck, 0.003)
    # under the V: the under-kimono's collar along its edges, the chest between, a little back from the robe
    under = smax(plain + 0.008, -(v + 0.015), 0.003)
    under = smax(under, z - 1.43, 0.004)
    f['under'] = under
    # the obi: a narrow band low on the hips, lower at the front, knotted at the back
    zo = 0.94 + 0.05 * sstep(-0.12, 0.12, y)
    obi = smax(plain - 0.0095, np.abs(z - zo) - OBI_W, 0.003)
    obi = smax(obi, -(plain + 0.02), 0.002)
    a1, a2 = math.radians(10), math.radians(-35)
    knot = rbox(p, (0.012, 0.142, 0.99), (0.062, 0.017, 0.028), 0.012,
                ((math.cos(a1), 0, -math.sin(a1)), (0, 1, 0), (math.sin(a1), 0, math.cos(a1))))
    tail = rbox(p, (0.052, 0.138, 0.952), (0.04, 0.008, 0.02), 0.007,
                ((math.cos(a2), 0, -math.sin(a2)), (0, 1, 0), (math.sin(a2), 0, math.cos(a2))))
    obi = np.minimum(obi, smin(knot, tail, 0.005))
    f['obi'] = obi
    (pl, nl), (pr, nr) = COLLARS
    collar = np.minimum(ribbon(p, pl, nl, COLLAR_W, 0.006), ribbon(p, pr, nr, COLLAR_W, 0.006))
    f['collar'] = collar
    f['shell'] = shell
    # under the cut where the first-person view hides the shoulders: a solid chest, so the eye looking down sees
    # the robe's top, not into it
    inside = np.minimum(plain + 0.014, sleeve + 0.014)
    dome = 0.6 * (np.minimum(np.abs(x), 0.12) ** 2 + (y + 0.01) ** 2)     # rounded over the chest, level over the sleeves
    f['chest'] = smax(inside, np.maximum(z - (Z_CUT - 0.004) + dome, 1.0 - z), 0.015)
    return f


def robe_sdf(p):
    return kimono_fields(p)['shell']


def collar_sdf(p):
    return kimono_fields(p)['collar']


def obi_sdf(p):
    return kimono_fields(p)['obi']


def under_sdf(p):
    return kimono_fields(p)['under']


def chest_sdf(p):
    return kimono_fields(p)['chest']


def kimono_hidden(P):
    """the shell's inside that nothing can see: away from the hem, the cuffs and the neck"""
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    f = kimono_fields((x, y, z))
    inner = f['outer'] < -T_CLOTH * 0.5
    cuff = capsule((np.abs(x), y, z), (0.213, 0.027, 1.02), (0.242, -0.016, 0.72), 0.045)
    return inner & (z > HEM + 0.1) & (z < 1.33) & (cuff > 0.05)


def robe_colour(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    f = kimono_fields((x, y, z))
    inner = f['outer'] < -T_CLOTH * 0.5
    col = np.where(inner[:, None], srgb('#2a3044'), INDIGO)
    # the hem a little worn and dusty
    col = mix(col, col * np.array([1.15, 1.08, 0.95]), 0.5 * sstep(HEM + 0.03, HEM, z))
    return col, np.where(inner, 0.0, 1.0)


def under_colour(P):
    v = vee((P[:, 0], P[:, 1], P[:, 2]))
    return mix(np.tile(SKIN * 0.92, (len(P), 1)), JUBAN, sstep(0.008, 0.004, v))


def flat(c, alpha=0.0):
    return lambda P: (np.tile(c, (len(P), 1)), np.full(len(P), alpha))


def robe_protect(P):
    """the robe's edges round the V and at the hem"""
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    return np.clip(sstep(0.01, 0.0, np.abs(vee((x, y, z)))) * sstep(1.22, 1.25, z) + sstep(HEM + 0.01, HEM, z), 0, 1) * 0.6


# ---------- skin weights (rest positions -> {bone: weight}) ----------
def side_bones(w, x, sideL):
    """split a left-side weight set into _L where sideL, _R otherwise"""
    out = {}
    for k, v in w.items():
        if k in PARENT and k not in ('hips', 'spine', 'chest', 'neck', 'head'):
            out[k + '_L'] = out.get(k + '_L', 0) + v * sideL
            out[k + '_R'] = out.get(k + '_R', 0) + v * (1 - sideL)
        else:
            out[k] = out.get(k, 0) + v
    return out


def torso_weights(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    X = np.abs(x)
    hips = sstep(1.06, 0.96, z)
    chest = sstep(1.12, 1.24, z)
    spine = np.clip(1 - hips - chest, 0, 1)
    sh = sstep(0.1, 0.17, X) * sstep(1.26, 1.34, z) * 0.6
    neck = 0.4 * sstep(1.39, 1.44, z) * sstep(0.09, 0.06, X)
    chest = chest * (1 - sh) * (1 - neck)
    # the skirt goes with the legs, each side with its own, more of it lower down
    legs = 0.95 * sstep(0.86, 0.55, z)
    left = sstep(-0.07, 0.07, x)
    w = {'hips': hips * (1 - legs), 'spine': spine, 'chest': chest, 'neck': neck,
         'thigh': hips * legs, 'shoulder': sh}
    return side_bones(w, x, np.where(w['thigh'] > 0, left, (x > 0).astype(float)))


def sleeve_weights(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    fore = sstep(1.12, 0.98, z) * (1 - 0.7 * sstep(0.03, 0.09, y))
    # the pouch hangs from the shoulder: some of it stays with the chest, so the swing reaches it damped
    damp = np.clip(0.35 * sstep(0.04, 0.18, y) + 0.25 * sstep(1.25, 1.36, z), 0, 0.6)
    sh = 0.4 * sstep(1.28, 1.36, z)
    arm = 1 - damp
    w = {'forearm': arm * fore * (1 - sh), 'upper_arm': arm * (1 - fore) * (1 - sh), 'shoulder': arm * sh, 'chest': damp}
    return side_bones(w, x, (x > 0).astype(float))


def kimono_weights(P):
    f = kimono_fields((P[:, 0], P[:, 1], P[:, 2]))
    s = sstep(-0.012, 0.012, f['torso'] - f['sleeve'])
    a, b = torso_weights(P), sleeve_weights(P)
    out = {}
    for k in set(a) | set(b):
        out[k] = a.get(k, 0) * (1 - s) + b.get(k, 0) * s
    return out


def head_weights(P):
    y, z = P[:, 1], P[:, 2]
    head = np.maximum(sstep(1.445, 1.49, z), sstep(-0.03, -0.05, y) * sstep(1.43, 1.45, z))
    chest = sstep(1.40, 1.35, z) * (1 - head)
    return {'head': head, 'chest': chest, 'neck': np.clip(1 - head - chest, 0, 1)}


def hand_weights(P, side):
    a, b, c = hand_local((P[:, 0] * side, P[:, 1], P[:, 2]))
    hand = sstep(-0.02, 0.012, a)
    upper = 0.3 * sstep(-0.18, -0.25, a)
    s = '_L' if side > 0 else '_R'
    return {'hand' + s: hand, 'forearm' + s: (1 - hand) * (1 - upper), 'upper_arm' + s: (1 - hand) * upper}


def leg_weights(P, side):
    x, y, z = P[:, 0] * side, P[:, 1], P[:, 2]
    fx, fy, fz = foot_local((x, y, z))
    thigh = sstep(0.47, 0.56, z)
    foot = sstep(0.16, 0.11, z) * (1 - thigh)
    toe = 0.5 * sstep(0.105, 0.13, fy) * foot
    s = '_L' if side > 0 else '_R'
    return {'thigh' + s: thigh, 'shin' + s: np.clip(1 - thigh - foot, 0, 1), 'foot' + s: foot - toe, 'toe' + s: toe}


def const_weights(bone):
    return lambda P: {bone: np.ones(len(P))}


# ---------- assembly ----------
BONES = ['hips', 'spine', 'chest', 'neck', 'head'] + [b + s for s in ('_L', '_R') for b in
                                                      ('shoulder', 'upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'toe')]


class Part:
    """one piece of the figure as arrays: vertices, triangles, smooth flags, colour, pattern (alpha), weights, the
    reach of its ambient occlusion"""

    def __init__(self, me, colour, weights, reach, smooth=True, bones=None):
        bones = bones or BONES
        self.bones = bones
        me.calc_loop_triangles()
        P = positions(me)
        T = np.empty(len(me.loop_triangles) * 3, np.int64)
        me.loop_triangles.foreach_get('vertices', T)
        T = T.reshape(-1, 3)
        if smooth is None:   # from the mesh's own faces
            ps = np.empty(len(me.polygons), bool)
            me.polygons.foreach_get('use_smooth', ps)
            pi = np.empty(len(me.loop_triangles), np.int64)
            me.loop_triangles.foreach_get('polygon_index', pi)
            S = ps[pi]
        else:
            S = np.full(len(T), smooth)
        if colour is None:   # from the mesh's colour layer
            c = np.empty(len(P) * 4)
            me.color_attributes['Color'].data.foreach_get('color', c)
            c = c.reshape(-1, 4)
            col, alpha = c[:, :3], c[:, 3]
        else:
            out = colour(P)
            col, alpha = out if isinstance(out, tuple) else (out, np.zeros(len(P)))
        W = weights(P)
        bpy.data.meshes.remove(me)
        self.P, self.T, self.S, self.col, self.alpha = P, T, S, col, alpha
        self.W = np.zeros((len(P), len(bones)))
        for k, v in W.items():
            self.W[:, bones.index(k)] += v
        self.reach = np.full(len(P), reach)

    def mirrored(self):
        """the right side's part from the left's"""
        o = Part.__new__(Part)
        o.P = self.P * np.array([-1.0, 1.0, 1.0])
        o.T = self.T[:, ::-1].copy()
        o.S, o.col, o.alpha, o.reach, o.bones = self.S, self.col, self.alpha, self.reach, self.bones
        o.W = np.zeros_like(self.W)
        for j, b in enumerate(self.bones):
            o.W[:, self.bones.index(b[:-2] + {'_L': '_R', '_R': '_L'}[b[-2:]] if b[-2:] in ('_L', '_R') else b)] = self.W[:, j]
        return o


def build_parts():
    parts = []
    me = sdf_part('head', head_sdf, (-0.1, -0.125, 1.32), (0.1, 0.13, 1.66), 0.0016, 7000, head_protect)
    parts.append(Part(me, head_colour, head_weights, 0.05))
    me = sdf_part('hair', hair_sdf, (-0.09, -0.1, 1.47), (0.09, 0.13, 1.675), 0.0016, 2400)
    parts.append(Part(me, hair_colour, head_weights, 0.04))
    parts.append(Part(eyes(), None, const_weights('head'), 0.02, smooth=None))
    me = sdf_part('hand', hand_sdf, (0.14, -0.09, 0.6), (0.31, 0.08, 1.1), 0.0016, 1700)
    hand = Part(me, hand_colour, lambda P: hand_weights(P, 1), 0.04)
    me = sdf_part('leg', leg_sdf, (0.0, -0.16, 0.0), (0.17, 0.1, 0.66), 0.0022, 1900)
    leg = Part(me, leg_colour, lambda P: leg_weights(P, 1), 0.12)
    shoe = Part(geta(), None, const_weights('foot_L'), 0.04, smooth=None)
    for p in (hand, leg, shoe):
        parts += [p, p.mirrored()]
    me = sdf_part('robe', robe_sdf, (-0.3, -0.165, HEM - 0.01), (0.3, 0.24, 1.475), 0.003, 11500, robe_protect, kimono_hidden)
    parts.append(Part(me, robe_colour, kimono_weights, 0.22))
    me = sdf_part('collar', collar_sdf, (-0.11, -0.15, 0.94), (0.11, 0.11, 1.47), 0.0022, 1300)
    parts.append(Part(me, flat(INDIGO_D), kimono_weights, 0.06))
    me = sdf_part('obi', obi_sdf, (-0.19, -0.16, 0.86), (0.19, 0.18, 1.04), 0.0025, 1500)
    parts.append(Part(me, flat(OBI, 0.5), kimono_weights, 0.08))
    me = sdf_part('under', under_sdf, (-0.08, -0.14, 1.2), (0.08, -0.04, 1.45), 0.002, 500)
    parts.append(Part(me, under_colour, kimono_weights, 0.05))
    me = sdf_part('chest', chest_sdf, (-0.3, -0.14, 0.98), (0.3, 0.2, Z_CUT + 0.01), 0.006, 500)
    parts.append(Part(me, flat(INDIGO * 0.6, 1.0), kimono_weights, 0.0))
    me = kasa()
    parts.append(Part(me, None, const_weights('head'), 0.08, smooth=None))
    return parts


def join(parts):
    P, T, S, C, A, W, R = [], [], [], [], [], [], []
    n = 0
    for p in parts:
        P.append(p.P)
        T.append(p.T + n)
        S.append(p.S)
        C.append(p.col)
        A.append(p.alpha)
        W.append(p.W)
        R.append(p.reach)
        n += len(p.P)
    return {'P': np.concatenate(P), 'T': np.concatenate(T), 'S': np.concatenate(S), 'C': np.concatenate(C),
            'A': np.concatenate(A), 'W': np.concatenate(W), 'R': np.concatenate(R)}


def vertex_normals(P, T):
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, T[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]


AO_DIRS = []
for i in range(24):  # cosine-weighted hemisphere about +z (Fibonacci spiral)
    r = math.sqrt((i + 0.5) / 24)
    a = i * 2.399963
    AO_DIRS.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r))))


def bake_ao(m):
    """occlusion by ray casting over the whole figure (each vertex its part's reach), blurred over the triangles,
    into the colours"""
    P, T = m['P'], m['T']
    N = vertex_normals(P, T)
    bvh = BVHTree.FromPolygons(P.tolist(), T.tolist())
    ao = np.empty(len(P))
    for i in range(len(P)):
        n = V(N[i])
        t = V((1, 0, 0)) if abs(n.x) < 0.9 else V((0, 1, 0))
        b1 = n.cross(t).normalized()
        b2 = n.cross(b1)
        o = V(P[i]) + n * 0.0015
        reach = m['R'][i]
        hit = sum(1 for d in AO_DIRS if bvh.ray_cast(o, b1 * d[0] + b2 * d[1] + n * d[2], reach)[0] is not None)
        ao[i] = 1 - hit / len(AO_DIRS)
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    for _ in range(2):
        s, c = ao.copy(), np.ones(len(P))
        np.add.at(s, E[:, 0], ao[E[:, 1]])
        np.add.at(c, E[:, 0], 1)
        np.add.at(s, E[:, 1], ao[E[:, 0]])
        np.add.at(c, E[:, 1], 1)
        ao = s / c
    m['C'] = m['C'] * (0.38 + 0.62 * ao)[:, None]


def top4(W):
    W = np.clip(W, 0, None)
    if W.shape[1] > 4:
        cut = np.sort(W, axis=1)[:, -4][:, None]
        W = np.where(W >= cut, W, 0)
    return W / np.maximum(W.sum(1), 1e-9)[:, None]


def subset(m, tri_mask):
    """the triangles in tri_mask and the vertices they use"""
    T = m['T'][tri_mask]
    used = np.unique(T)
    remap = -np.ones(len(m['P']), np.int64)
    remap[used] = np.arange(len(used))
    out = {k: m[k][used] for k in ('P', 'C', 'A', 'W', 'R')}
    out['T'] = remap[T]
    out['S'] = m['S'][tri_mask]
    return out


def cut_at(m, z0):
    """split the triangles crossing the plane z = z0 along it (new vertices interpolated), so the first-person cut
    is a clean line"""
    P = m['P']
    above = P[:, 2] > z0
    T = m['T']
    side = above[T]
    cross = side.any(1) & ~side.all(1)
    keys = ('P', 'C', 'A', 'W', 'R')
    extra = {k: [] for k in keys}
    cache = {}
    n = len(P)

    def mid(a, b):
        k = (min(a, b), max(a, b))
        if k not in cache:
            t = (z0 - P[a, 2]) / (P[b, 2] - P[a, 2])
            for key in keys:
                extra[key].append(m[key][a] + (m[key][b] - m[key][a]) * t)
            cache[k] = n + len(cache)
        return cache[k]
    tris, smooth = [], []
    for t, s, sm in zip(T[cross], side[cross], m['S'][cross]):
        i = [j for j in range(3) if s[j] != s[(j + 1) % 3] and s[j] != s[(j + 2) % 3]][0]  # the lone vertex
        l, p, q = t[i], t[(i + 1) % 3], t[(i + 2) % 3]
        a, b = mid(l, p), mid(l, q)
        tris += [(l, a, b), (a, p, q), (a, q, b)]
        smooth += [sm] * 3
    out = {k: np.concatenate([m[k], np.array(extra[k]).reshape((-1,) + m[k].shape[1:])]) for k in keys}
    out['T'] = np.concatenate([T[~cross], np.array(tris, np.int64).reshape(-1, 3)])
    out['S'] = np.concatenate([m['S'][~cross], np.array(smooth, bool)])
    return out


def make_mesh(name, m):
    me = bpy.data.meshes.new(name)
    me.from_pydata(m['P'].tolist(), [], m['T'].tolist())
    me.validate()
    me.polygons.foreach_set('use_smooth', m['S'].astype(bool))
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', np.concatenate([m['C'], m['A'][:, None]], 1).ravel())
    me.color_attributes.active_color = ca
    return me


def far_model(m, target, name='human_far'):
    """the whole figure decimated; weights and colours from the nearest vertex of the full model"""
    from mathutils.kdtree import KDTree
    me = decimate(make_mesh(name, m), target)
    P = positions(me)
    kd = KDTree(len(m['P']))
    for i, p in enumerate(m['P']):
        kd.insert(p, i)
    kd.balance()
    near = np.array([kd.find(p)[1] for p in P])
    me.calc_loop_triangles()
    T = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get('vertices', T)
    out = {'P': P, 'T': T.reshape(-1, 3), 'S': np.ones(len(T) // 3, bool), 'C': m['C'][near], 'A': m['A'][near],
           'W': m['W'][near], 'R': m['R'][near]}
    bpy.data.meshes.remove(me)
    return out


# ---------- armature ----------
def make_rig(name='human_rig', bones=None, joints=None, parent=None):
    """the armature: bones (BONES) at joints (J: name -> (head, tail)), each under parent(name) (parent_of)"""
    bones, joints, parent = bones or BONES, joints or J, parent or parent_of
    arm = bpy.data.armatures.new(name)
    rig = bpy.data.objects.new(name, arm)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name in bones:
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = joints[name]
        eb.roll = 0.0
        p = parent(name)
        if p:
            eb.parent = arm.edit_bones[p]
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def bind(rig, name, m, bones=None):
    me = make_mesh(name, m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    W = top4(m['W'])
    for j, b in enumerate(bones or BONES):
        vg = ob.vertex_groups.new(name=b)
        for i in np.nonzero(W[:, j] > 1e-4)[0]:
            vg.add([int(i)], float(W[i, j]), 'REPLACE')
    ob.parent = rig
    ob.modifiers.new('rig', 'ARMATURE').object = rig
    print(f'{name}: {len(m["T"])} triangles, {len(m["P"])} vertices', flush=True)
    return ob


# ---------- clips ----------
FPS = 30
# speed (m/s), frames per stride, share of the stride a foot is down, lift of the foot in the swing (m), the geta's
# pitch at the heel's strike and the toe's push-off, the pelvis's turn, list and sway, the body's lean, the arms'
# swing, the elbows' bend (rest, more as the arm comes forward), how much lower the hips ride
CLIPS = {
    'walk': dict(v=1.4, frames=28, beta=0.6, lift=0.065, hs=12, to=32, yaw=5, roll=3, sway=0.016, lean=3, arm=13,
                 elbow=(12, 10), crouch=0.012),
    'hurry': dict(v=2.6, frames=18, beta=0.56, lift=0.085, hs=14, to=38, yaw=7, roll=3.5, sway=0.012, lean=8, arm=18,
                  elbow=(32, 14), crouch=0.026),
}
IDLE_FRAMES = 120
ANKLE_Z = J['foot_L'][0][2]
ANKLE_Y = J['foot_L'][0][1]
F_CENTRE = -0.07          # the planted geta's travel under the hip is centred this far back of it (m)


def rx(a):
    return Quaternion((1, 0, 0), a)


def ry(a):
    return Quaternion((0, 1, 0), a)


def rz(a):
    return Quaternion((0, 0, 1), a)


def planted(fa, pitch):
    """(forward, height) of the ankle of a geta whose flat position puts the ankle at fa, rocked by pitch (toes
    up +) on its back tooth's heel edge, or (toes down) on its front tooth's toe edge"""
    piv = fa + (PIVOTS[0] if pitch >= 0 else PIVOTS[1])
    rf, rzz = fa - piv, ANKLE_Z
    c, s = math.cos(pitch), math.sin(pitch)
    return piv + rf * c - rzz * s, rf * s + rzz * c


def foot_target(c, side, ph):
    """the ankle's target (clip space) and the geta's pitch for one foot at phase ph of the stride"""
    T = c['frames'] / FPS
    beta, v = c['beta'], c['v']
    D = v * T * beta
    f0 = D / 2 + F_CENTRE
    hs, to = math.radians(c['hs']), math.radians(c['to'])
    s = (ph - (0.0 if side > 0 else 0.5)) % 1.0
    if s < beta:
        u = s / beta
        pitch = hs * (1 - float(sstep(0, 0.18, u))) - to * float(sstep(0.55, 1.0, u))
        f, z = planted(f0 - v * T * s, pitch)
    else:
        u = (s - beta) / (1 - beta)
        f_a, z_a = planted(f0 - D, -to)
        f_b, z_b = planted(f0, hs)
        m = -v * T * (1 - beta) * 0.5      # leaving and meeting the ground at half its speed
        h00, h10, h01, h11 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
        f = h00 * f_a + h10 * m + h01 * f_b + h11 * m
        z = z_a + (z_b - z_a) * u + c['lift'] * math.sin(math.pi * u ** 0.85)
        pitch = -to + (hs + to) * float(sstep(0.0, 0.75, u))
    return V((side * J['foot_L'][0][0], ANKLE_Y - f, z)), pitch


class Rest:
    def __init__(self, rig):
        self.h, self.r, self.d = {}, {}, {}
        for b in rig.data.bones:
            self.h[b.name] = b.head_local.copy()
            self.r[b.name] = b.matrix_local.to_quaternion()
            self.d[b.name] = (b.tail_local - b.head_local).normalized()
        self.L1 = (V(J['thigh_L'][1]) - V(J['thigh_L'][0])).length
        self.L2 = (V(J['shin_L'][1]) - V(J['shin_L'][0])).length


def hip_joint(rest, Tr, Qh, s):
    return Tr + rest.h['hips'] + Qh @ (rest.h['thigh' + s] - rest.h['hips'])


def leg_ik(rest, Q, Tr, s, A, pitch):
    """thigh, shin and foot rotations putting the ankle on A (as near as it reaches) with the geta pitched"""
    Qh = Q['hips']
    H = hip_joint(rest, Tr, Qh, s)
    L1, L2 = rest.L1, rest.L2
    dv = A - H
    d = min(max(dv.length, abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4)
    dr = dv.normalized()
    pole = Qh @ V((0, -1, 0))
    pp = (pole - dr * pole.dot(dr)).normalized()
    a = (L1 * L1 - L2 * L2 + d * d) / (2 * d)
    K = H + dr * a + pp * math.sqrt(max(L1 * L1 - a * a, 0.0))
    A2 = K + (A - K).normalized() * L2
    Q['thigh' + s] = rest.d['thigh' + s].rotation_difference((Qh.inverted() @ (K - H)).normalized())
    Wt = Qh @ Q['thigh' + s]
    Q['shin' + s] = rest.d['shin' + s].rotation_difference((Wt.inverted() @ (A2 - K)).normalized())
    Ws = Wt @ Q['shin' + s]
    Q['foot' + s] = Ws.inverted() @ rx(-pitch)
    return (A2 - A).length


def max_drop(rest, Tr, Qh, s, A):
    """how high the hips may ride (their translation's z) for this leg to reach A, nearly straight"""
    H = hip_joint(rest, Tr, Qh, s)
    dh2 = (A.x - H.x) ** 2 + (A.y - H.y) ** 2
    Lr = 0.993 * (rest.L1 + rest.L2)
    return Tr.z + (A.z + math.sqrt(max(Lr * Lr - dh2, 0.0)) - H.z)


def gait_pose(rest, c, ph, dz):
    """the bones' rotations (armature axes, about each bone's head, after its parent's) and the hips' move"""
    Q = {b: Quaternion() for b in BONES}
    w = math.tau * ph
    yaw, roll = -math.radians(c['yaw']) * math.cos(w), -math.radians(c['roll']) * math.sin(w)
    Q['hips'] = rz(yaw) @ ry(roll)
    Tr = V((c['sway'] * math.sin(w), 0.0, dz))
    lean = math.radians(c['lean'])
    turn = -1.6 * yaw                      # the shoulders turn against the hips
    Q['spine'] = rz(turn * 0.5) @ rx(lean * 0.5)
    Q['chest'] = rz(turn * 0.5) @ ry(-roll * 0.7) @ rx(lean * 0.5)
    face = -(yaw + turn)                   # the head keeps looking ahead
    bob = math.sin(2 * w)
    Q['neck'] = rz(face * 0.5) @ rx(-lean * 0.4)
    Q['head'] = rz(face * 0.5) @ rx(-lean * 0.45 + math.radians(1.2) * bob)
    arm, (e0, e1) = math.radians(c['arm']), c['elbow']
    for s, sg in (('_L', 1), ('_R', -1)):
        sw = sg * math.cos(w - 0.25)        # +1: the arm back (its leg forward); a little behind the legs
        Q['shoulder' + s] = rx(arm * 0.12 * sw)
        Q['upper_arm' + s] = rx(arm * sw)
        flex = math.radians(e0 + e1 * (0.5 - 0.5 * sw))
        Q['forearm' + s] = rx(-flex)
        Q['hand' + s] = rx(-math.radians(6) - flex * 0.15)
    return Q, Tr


def idle_pose(rest, ph):
    Q = {b: Quaternion() for b in BONES}
    w = math.tau * ph
    breath = 0.5 + 0.5 * math.sin(w)      # one slow breath per loop
    sway = math.sin(w)
    Q['hips'] = rz(math.radians(1.2) * math.sin(w + 0.7)) @ ry(math.radians(0.8) * sway)
    Tr = V((0.007 * sway, 0.0, -0.008 - 0.002 * math.cos(2 * w)))
    Q['spine'] = rx(math.radians(1.0)) @ ry(-math.radians(0.5) * sway)
    Q['chest'] = rx(math.radians(0.8) - math.radians(1.0) * breath) @ ry(-math.radians(0.4) * sway)
    Q['neck'] = rz(math.radians(2.0) * math.sin(w + 1.0))
    Q['head'] = rz(math.radians(3.0) * math.sin(w + 1.3)) @ rx(math.radians(1.5) * math.sin(2 * w + 0.4) - math.radians(1.0))
    for s, sg in (('_L', 1), ('_R', -1)):
        Q['shoulder' + s] = ry(-sg * math.radians(1.2) * breath)
        Q['upper_arm' + s] = rx(math.radians(1.5) * math.sin(w + 0.5)) @ ry(-sg * math.radians(1.0))
        Q['forearm' + s] = rx(-math.radians(8))
        Q['hand' + s] = rx(-math.radians(6))
    return Q, Tr


def clip_frames(rest, name):
    """per frame: {bone: rotation}, hips' move"""
    if name == 'idle':
        out = []
        for f in range(IDLE_FRAMES + 1):
            Q, Tr = idle_pose(rest, f / IDLE_FRAMES)
            for s, side in (('_L', 1), ('_R', -1)):
                leg_ik(rest, Q, Tr, s, V((side * J['foot_L'][0][0], ANKLE_Y, ANKLE_Z)), 0.0)
            out.append((Q, Tr))
        return out
    c = CLIPS[name]
    n = c['frames']
    # the hips ride as high as both legs reach (smoothed), and a little lower
    dz = []
    for f in range(n):
        ph = f / n
        Q, Tr = gait_pose(rest, c, ph, 0.0)
        lim = -c['crouch']
        for s, side in (('_L', 1), ('_R', -1)):
            A, _ = foot_target(c, side, ph)
            lim = min(lim, max_drop(rest, Tr, Q['hips'], s, A))
        dz.append(lim)
    raw = np.array(dz)
    sm = raw.copy()
    for _ in range(3):
        sm = 0.25 * np.roll(sm, 1) + 0.5 * sm + 0.25 * np.roll(sm, -1)
    sm = np.minimum(sm - 0.003, raw)
    out, miss, clear = [], 0.0, 1.0
    for f in range(n + 1):
        ph = (f % n) / n
        Q, Tr = gait_pose(rest, c, ph, float(sm[f % n]))
        for s, side in (('_L', 1), ('_R', -1)):
            A, pitch = foot_target(c, side, ph)
            miss = max(miss, leg_ik(rest, Q, Tr, s, A, pitch))
            # the geta's teeth above the ground in the swing
            for pv in PIVOTS:
                tip = A + rx(-pitch) @ V((0, -pv, -ANKLE_Z))
                clear = min(clear, tip.z)
        out.append((Q, Tr))
    print(f'{name}: {n} frames ({n / FPS:.3f} s), stride {c["v"] * n / FPS:.3f} m, hips {raw.min():.3f}..{raw.max():.3f}, '
          f'ankle misses by {miss * 1000:.1f} mm at most, lowest tooth {clear * 1000:.1f} mm', flush=True)
    return out


def key_clips(rig, clips=None, bones=None):
    """key each clip as an action on the rig: clips [(name, frames(rest))], frames a list of (Q, T) per frame, Q the
    bones' rotations (armature axes, about each bone's head, after its parent's), T the hips' move or {bone: move}
    (the traveller's idle, walk and hurry by default)"""
    rest = Rest(rig)
    bones = bones or BONES
    if clips is None:
        clips = [(n, lambda r, n=n: clip_frames(r, n)) for n in ('idle', 'walk', 'hurry')]
    rig.animation_data_create()
    for b in rig.pose.bones:
        b.rotation_mode = 'QUATERNION'
    actions = []
    for name, frames in clips:
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        prev = {}
        for f, (Q, Tr) in enumerate(frames(rest)):
            for b in bones:
                r = rest.r[b]
                q = r.inverted() @ Q[b] @ r
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q
                pb = rig.pose.bones[b]
                pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f, group=b)
            for b, t in (Tr.items() if isinstance(Tr, dict) else (('hips', Tr),)):
                pb = rig.pose.bones[b]
                pb.location = rest.r[b].inverted() @ t
                pb.keyframe_insert('location', frame=f, group=b)
        actions.append(act)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
    for b in rig.pose.bones:
        b.rotation_quaternion = Quaternion()
        b.location = V()
    return actions


def main(out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    full = join(build_parts())
    bake_ao(full)
    far = far_model(full, 6000)
    full = cut_at(full, Z_CUT)
    up = full['P'][full['T']].mean(1)[:, 2] > Z_CUT
    body, head = subset(full, ~up), subset(full, up)
    rig = make_rig()
    for name, m in (('human', body), ('human_head', head), ('human_far', far)):
        bind(rig, name, m)
    key_clips(rig)
    export(out)


def export(out):
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_normals=True, export_yup=True, export_skins=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_step=1, export_optimize_animation_size=False)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
