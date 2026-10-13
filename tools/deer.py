# The far bank's sika deer (Cervus nippon), a hind, built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/deer.py -- <out.glb>
# A Honshu sika hind of about 1.42 m nose to tail and 0.8 m at the withers: a deep chest and a barrel tucked up
# towards the flank, a rounded rump over muscled haunches, slender legs (the forelegs straight under the shoulders,
# the hind legs angled at the stifle and the hock) on small cloven hooves; a neck rising at about 50 degrees, a short
# wedge of a head with a dark nose, rounded ears set wide and cupped forward, a short tail. The page (src/deer.js)
# plays the same model for the hinds and, smaller, the yearlings. Blender: z up, facing -y, the deer's left at +x
# (glTF: y up, facing +z), the hooves on z = 0.
# The body is one signed distance field (numpy) meshed by surface nets and decimated to a budget, with the meshing
# helpers of tools/human.py; the ears are a finer field of their own. Colours are painted per vertex (the chestnut
# coat, darker along the spine, the pale belly, inner legs, chin and throat, the dark nose, eyes and hooves, the
# ears' dark rims and pale insides), then ambient occlusion (ray cast over the whole deer) darkens them. Alpha is 1 on
# the coat: there the page paints what the vertices can't carry (the rows of white spots, the white rump patch edged
# in black, which flares wider when the deer is alarmed, the tail's black line).
# Meshes, skinned to one armature (`deer_rig`, 27 bones) by Blender's bone-heat weights: `deer` (~7k triangles),
# `deer_far` (~1.6k).
# Clips, keyed from poses computed here: the gaits, cycles in place (`walk`, `trot`, `bound`: the page moves the deer
# by STRIDE per cycle and runs the cycle at its speed), each leg set by inverse kinematics from its hoof's path (on
# the ground for its share of the cycle, sliding back under the body, then lifted forward); the postures, loops
# (`stand`, `graze`, `alert`, `bed`: lying, chewing the cud); and one-shots between them (`down`, `up`: lying down
# front first, rising hind first; `stamp`: a forefoot struck twice; `groom`: the head round to lick the flank).
# Ears and tail are left at rest: the page moves them. Keyed at 30 fps, exported at 15 (the gaits at 30).
import bpy, math, os, sys
import numpy as np
from mathutils import Vector, Quaternion
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from human import srgb, sstep, sphere, capsule, smin, smax, surface_nets, to_mesh, decimate, positions, vertex_normals, top4

V = Vector
FPS = 30
D = math.radians


# ---------- the build ----------
# joints (left side; the right mirrors x): Blender coordinates, metres
J = {
    'pelvis': ((0, 0.42, 0.69), (0, 0.17, 0.71)),
    'spine': ((0, 0.17, 0.71), (0, -0.12, 0.72)),
    'chest': ((0, -0.12, 0.72), (0, -0.31, 0.655)),
    'neck1': ((0, -0.31, 0.655), (0, -0.415, 0.835)),
    'neck2': ((0, -0.415, 0.835), (0, -0.505, 0.995)),
    'head': ((0, -0.505, 0.995), (0, -0.745, 0.925)),
    'ear_L': ((0.04, -0.52, 1.07), (0.14, -0.49, 1.15)),
    'tail': ((0, 0.578, 0.722), (0, 0.615, 0.6)),
    'scap_L': ((0.085, -0.15, 0.77), (0.112, -0.29, 0.555)),
    'humerus_L': ((0.112, -0.29, 0.555), (0.1, -0.205, 0.405)),
    'radius_L': ((0.1, -0.205, 0.405), (0.088, -0.24, 0.215)),
    'mcarp_L': ((0.088, -0.24, 0.215), (0.086, -0.25, 0.062)),
    'fhoof_L': ((0.086, -0.25, 0.062), (0.086, -0.292, 0.004)),
    'femur_L': ((0.1, 0.385, 0.655), (0.115, 0.265, 0.45)),
    'tibia_L': ((0.115, 0.265, 0.45), (0.098, 0.43, 0.29)),
    'mtars_L': ((0.098, 0.43, 0.29), (0.088, 0.405, 0.062)),
    'hhoof_L': ((0.088, 0.405, 0.062), (0.088, 0.363, 0.004)),
}
for b in [n for n in J if n.endswith('_L')]:
    a, c = J[b]
    J[b[:-2] + '_R'] = ((-a[0], a[1], a[2]), (-c[0], c[1], c[2]))
PARENT = {'pelvis': None, 'spine': 'pelvis', 'chest': 'spine', 'neck1': 'chest', 'neck2': 'neck1', 'head': 'neck2',
          'tail': 'pelvis'}
for s in ('_L', '_R'):
    PARENT.update({'ear' + s: 'head', 'scap' + s: 'chest', 'humerus' + s: 'scap' + s, 'radius' + s: 'humerus' + s,
                   'mcarp' + s: 'radius' + s, 'fhoof' + s: 'mcarp' + s, 'femur' + s: 'pelvis', 'tibia' + s: 'femur' + s,
                   'mtars' + s: 'tibia' + s, 'hhoof' + s: 'mtars' + s})
BONES = list(PARENT)
FRONT = ('humerus', 'radius', 'mcarp', 'fhoof')
HIND = ('femur', 'tibia', 'mtars', 'hhoof')


def jt(b, end=0, side=1):
    p = J[b][end]
    return np.array((p[0] * side, p[1], p[2]))


def frame(u, hint=(0.0, 0.0, 1.0)):
    """rows: an orthonormal frame whose second axis is u"""
    u = np.array(u, float)
    u /= np.linalg.norm(u)
    a = np.cross(u, hint)
    a /= np.linalg.norm(a)
    return np.array([a, u, np.cross(a, u)])


def ell(p, c, r, R=None):
    """ellipsoid at c with radii r along the rows of R (near-true distance by the gradient's length)"""
    x, y, z = p[0] - c[0], p[1] - c[1], p[2] - c[2]
    if R is not None:
        x, y, z = (R[0][0] * x + R[0][1] * y + R[0][2] * z, R[1][0] * x + R[1][1] * y + R[1][2] * z,
                   R[2][0] * x + R[2][1] * y + R[2][2] * z)
    qx, qy, qz = x / r[0], y / r[1], z / r[2]
    k0 = np.sqrt(qx * qx + qy * qy + qz * qz)
    k1 = np.sqrt((qx / r[0]) ** 2 + (qy / r[1]) ** 2 + (qz / r[2]) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def flat_capsule(p, a, b, ra, rb, w=0.75):
    """a capsule squeezed from the sides (x) to w of its depth"""
    return capsule((p[0] / w, p[1], p[2]), (a[0] / w, a[1], a[2]), (b[0] / w, b[1], b[2]), ra, rb) * w


def mirror(fn):
    """a left-side field (x > 0) used for both sides"""
    return lambda p: fn((np.abs(p[0]), p[1], p[2]))


def foreleg(p):
    """the left foreleg from the elbow down: forearm, knee (carpus), cannon, fetlock, pastern and the cloven hoof"""
    e, k, f, t = jt('radius_L'), jt('radius_L', 1), jt('mcarp_L', 1), jt('fhoof_L', 1)
    d = capsule(p, e, k, 0.037, 0.022)
    d = smin(d, ell(p, k + (0, -0.002, 0.004), (0.025, 0.027, 0.032)), 0.012)
    d = smin(d, capsule(p, k, f, 0.0175, 0.016), 0.012)
    d = smin(d, ell(p, f + (0, 0.004, 0), (0.019, 0.022, 0.022)), 0.01)
    d = smin(d, capsule(p, f, t + (0, 0.012, 0.016), 0.016, 0.017), 0.008)
    return smin(d, hoof(p, t), 0.006)


def hindleg(p):
    """the left hind leg from the stifle down: gaskin, hock with its point, cannon, fetlock, pastern, hoof"""
    s, h, f, t = jt('tibia_L'), jt('tibia_L', 1), jt('mtars_L', 1), jt('hhoof_L', 1)
    d = capsule(p, s + (0, 0.02, 0), h, 0.06, 0.024)
    d = smin(d, capsule(p, s + (0, 0.07, -0.02), h + (0, 0.025, 0.03), 0.04, 0.014), 0.03)   # the gaskin's muscle behind
    d = smin(d, sphere(p, h, 0.027), 0.01)
    d = smin(d, sphere(p, h + (0, 0.03, 0.012), 0.016), 0.012)                                # the point of the hock
    d = smin(d, capsule(p, h, f, 0.018, 0.016), 0.012)
    d = smin(d, ell(p, f + (0, 0.004, 0), (0.019, 0.022, 0.022)), 0.01)
    d = smin(d, capsule(p, f, t + (0, 0.012, 0.016), 0.016, 0.017), 0.008)
    return smin(d, hoof(p, t), 0.006)


def hoof(p, t):
    """the two claws: a short blunt wedge each side of the cleft, flat below"""
    c = t + (0, 0.012, 0.018)
    d = ell(p, c, (0.024, 0.034, 0.022), frame((0, -0.82, -0.57), (1.0, 0.0, 0.0)))
    cleft = ell(p, (c[0], c[1] - 0.026, c[2] - 0.004), (0.0025, 0.022, 0.03))
    d = smax(d, -cleft, 0.002)
    return smax(d, 0.0015 - p[2], 0.002)


def head(p):
    """the skull, the tapering muzzle, the cheeks, the nose's pad, the eyes' bulge"""
    R = frame((0, -0.95, -0.31))
    d = ell(p, (0, -0.55, 1.018), (0.058, 0.08, 0.06), R)
    d = smin(d, capsule(p, (0, -0.585, 0.995), (0, -0.722, 0.938), 0.046, 0.026), 0.035)
    d = smin(d, ell(p, (0, -0.565, 0.968), (0.048, 0.07, 0.04), R), 0.03)                 # cheeks, the jaw below
    d = smin(d, ell(p, (0, -0.735, 0.935), (0.025, 0.022, 0.024)), 0.012)                 # the nose
    d = smin(d, ell(p, (0, -0.67, 0.92), (0.022, 0.05, 0.016), R), 0.02)                  # the chin
    d = smin(d, ell(p, (0.044, -0.6, 1.03), (0.016, 0.019, 0.015)), 0.012)                # the eye
    d = smin(d, ell(p, (-0.044, -0.6, 1.03), (0.016, 0.019, 0.015)), 0.012)
    return d


def body(p):
    d = ell(p, (0, 0.03, 0.6), (0.148, 0.37, 0.16))                                       # the barrel
    d = smin(d, ell(p, (0, -0.2, 0.62), (0.122, 0.17, 0.19)), 0.07)                       # the chest
    d = smin(d, ell(p, (0, -0.15, 0.735), (0.07, 0.14, 0.065)), 0.05)                     # the withers
    d = smin(d, ell(p, (0, -0.3, 0.55), (0.09, 0.075, 0.12)), 0.05)                       # the breast
    d = smin(d, ell(p, (0, 0.38, 0.655), (0.128, 0.17, 0.14)), 0.07)                      # the hindquarters
    d = smin(d, ell(p, (0, 0.5, 0.675), (0.1, 0.09, 0.095)), 0.06)                        # the rump, sloping to the tail
    # the buttocks: from under the tail down the back of the thigh to the hock
    ham = mirror(lambda q: capsule(q, (0.055, 0.53, 0.62), jt('tibia_L', 1) + (0, 0.035, 0.03), 0.075, 0.022))
    d = smin(d, ham(p), 0.05)
    d = smax(d, -ell(p, (0, 0.24, 0.36), (0.2, 0.17, 0.1)), 0.06)                         # the flank tucked up
    # haunches and shoulders, both sides
    thigh = mirror(lambda q: smin(ell(q, (0.08, 0.34, 0.565), (0.07, 0.15, 0.17), frame((0, -0.5, -0.87))),
                                  capsule(q, jt('femur_L', 1) + (-0.008, 0.01, 0.02), jt('tibia_L') + (0, 0.04, -0.01), 0.055, 0.05), 0.04))
    d = smin(d, thigh(p), 0.04)
    arm = mirror(lambda q: smin(capsule(q, jt('scap_L') + (0, 0, -0.03), jt('humerus_L'), 0.05, 0.06),
                                capsule(q, jt('humerus_L'), jt('radius_L') + (0, 0.01, 0.01), 0.058, 0.042), 0.03))
    d = smin(d, arm(p), 0.035)
    d = smin(d, mirror(foreleg)(p), 0.02)
    d = smin(d, mirror(hindleg)(p), 0.025)
    # the neck: deeper than wide, thick at the shoulders, slender at the throat
    nk = flat_capsule(p, (0, -0.24, 0.64), (0, -0.38, 0.82), 0.14, 0.095, 0.66)
    nk = smin(nk, flat_capsule(p, (0, -0.38, 0.82), (0, -0.49, 0.965), 0.095, 0.064, 0.74), 0.05)
    d = smin(d, nk, 0.08)
    d = smin(d, head(p), 0.04)
    # the tail, flattened
    d = smin(d, flat_capsule(p, (0, 0.575, 0.715), (0, 0.61, 0.615), 0.033, 0.026, 0.6), 0.03)
    return d


def ear(p):
    """the left ear: a rounded leaf cupped forward, at its root on the head"""
    a, b = jt('ear_L'), jt('ear_L', 1)
    u = (b - a) / np.linalg.norm(b - a)
    R = frame(u, (0.35, -1.0, 0.0))               # rows: across the ear, along it, its facing (front: -row 2)
    c = a + u * 0.065
    leaf = ell(p, c, (0.042, 0.07, 0.011), R)
    cup = ell(p, c + R[2] * -0.007 + u * 0.006, (0.034, 0.062, 0.008), R)
    d = smax(leaf, -cup, 0.004)
    return smin(d, capsule(p, a - u * 0.01, a + u * 0.03, 0.018, 0.014), 0.01)


# ---------- colours (linear) ----------
COAT = srgb('#8a5232')        # the summer coat's chestnut
COAT_D = srgb('#5a3420')      # along the spine
DORSAL = srgb('#2e1d13')      # the dark line down the spine
BELLY = srgb('#d4c4a8')       # belly, inner legs, throat
LEG_C = srgb('#7c5a40')       # lower legs, greyer
HOOF = srgb('#1c1714')
NOSE = srgb('#191513')
CHIN = srgb('#e0d6c4')
MUZZLE = srgb('#6e4b33')
EYE = srgb('#0c0a09')
EAR_IN = srgb('#cbbfae')
EAR_RIM = srgb('#2a201a')
FACE = srgb('#7d4f33')


def coat_colour(P, N):
    """per vertex: the coat and the alpha that lets the page paint over it (1 on the coat)"""
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    ax = np.abs(x)
    C = np.tile(COAT, (len(P), 1))
    A = np.ones(len(P))
    # darker over the back; the dark spine line
    top = sstep(0.62, 0.78, z) * sstep(-0.32, -0.2, y) * sstep(0.62, 0.5, y)
    C = C + (COAT_D - C) * (top * sstep(0.09, 0.03, ax) * 0.6)[:, None]
    line = sstep(0.022, 0.008, ax) * sstep(0.7, 0.76, z) * sstep(-0.22, -0.12, y) * sstep(0.58, 0.5, y)
    C = C + (DORSAL - C) * (line * 0.8)[:, None]
    # the pale underside: belly between the legs, the insides of the thighs and forearms
    belly = sstep(-0.2, -0.6, N[:, 2]) * sstep(0.56, 0.46, z) * sstep(-0.3, -0.2, y) * sstep(0.5, 0.4, y)
    inner = sstep(0.0, -0.5, N[:, 0] * np.sign(x)) * sstep(0.6, 0.45, z) * sstep(0.2, 0.3, z)
    C = C + (BELLY - C) * np.maximum(belly * 0.85, inner * 0.6)[:, None]
    # lower legs greyer, the hooves dark
    low = sstep(0.3, 0.18, z) * (1 - sstep(0.09, 0.05, ax) * 0.0)
    C = C + (LEG_C - C) * (low * 0.7)[:, None]
    hoofs = sstep(0.052, 0.04, z)
    C = C + (HOOF - C) * hoofs[:, None]
    A = A * (1 - sstep(0.3, 0.2, z))
    # head: a warm face, the muzzle darker, the dark nose, the pale chin and lips, the throat paler, the eyes
    face = sstep(-0.5, -0.56, y) * sstep(0.88, 0.94, z)
    C = C + (FACE - C) * face[:, None]
    C = C + (MUZZLE - C) * (sstep(-0.66, -0.7, y) * 0.7)[:, None]
    nose = sstep(-0.718, -0.735, y) * sstep(0.925, 0.94, z)
    C = C + (NOSE - C) * nose[:, None]
    lip = sstep(-0.62, -0.68, y) * sstep(0.935, 0.915, z)
    C = C + (CHIN - C) * (lip * 0.9)[:, None]
    throat = sstep(-0.42, -0.5, y) * sstep(0.98, 0.9, z) * sstep(0.5, 0.75, z) * sstep(0.02, 0.0, y + 0.42 - (z - 0.7) * 0.45)
    C = C + (BELLY - C) * (throat * 0.55)[:, None]
    eye = np.exp(-(((ax - 0.054) / 0.008) ** 2 + ((y + 0.6) / 0.012) ** 2 + ((z - 1.031) / 0.01) ** 2))
    C = C + (EYE - C) * np.clip(eye * 1.6, 0, 1)[:, None]
    gland = np.exp(-(((ax - 0.045) / 0.01) ** 2 + ((y + 0.632) / 0.012) ** 2 + ((z - 1.012) / 0.007) ** 2))
    C = C + (EYE - C) * np.clip(gland * 0.9, 0, 1)[:, None]
    A = A * (1 - sstep(-0.52, -0.56, y) * sstep(0.85, 0.9, z))
    return C, A


def ear_colour(P):
    a, b = jt('ear_L'), jt('ear_L', 1)
    u = (b - a) / np.linalg.norm(b - a)
    R = frame(u, (0.35, -1.0, 0.0))
    Q = np.stack([np.abs(P[:, 0]), P[:, 1], P[:, 2]], 1) - (a + u * 0.065)
    q = Q @ R.T
    front = sstep(0.0, -0.004, q[:, 2])
    rim = sstep(0.8, 0.95, np.sqrt((q[:, 0] / 0.042) ** 2 + (q[:, 1] / 0.07) ** 2))
    C = np.tile(FACE, (len(P), 1))
    C = C + (EAR_IN - C) * (front * (1 - rim))[:, None]
    C = C + (EAR_RIM - C) * (rim * sstep(-0.01, 0.03, q[:, 1]))[:, None]
    return C, np.zeros(len(P))


# ---------- assembly ----------
def mesh_part(name, fn, lo, hi, h, target, protect=None):
    verts, quads = surface_nets(fn, lo, hi, h)
    me = to_mesh(name, verts, quads)
    print(f'{name}: {len(quads) * 2} triangles meshed', flush=True)
    return decimate(me, target, protect)


def protect(P):
    """detail kept on the head and the lower legs"""
    return 0.3 * np.maximum(sstep(0.86, 0.92, P[:, 2]) * sstep(-0.48, -0.53, P[:, 1]), sstep(0.32, 0.24, P[:, 2]))


def arrays(me):
    me.calc_loop_triangles()
    P = positions(me)
    T = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get('vertices', T)
    bpy.data.meshes.remove(me)
    return P, T.reshape(-1, 3)


def build(budget, dense=False):
    P, T = arrays(mesh_part('deer', body, (-0.2, -0.79, -0.002), (0.2, 0.7, 1.09), 0.0045, budget['dense'] if dense else budget['body'], protect))
    C, A = coat_colour(P, vertex_normals(P, T))
    parts = [(P, T, C, A, np.full(len(P), 0.12))]
    me = mesh_part('deer_ear', ear, (0.02, -0.57, 1.04), (0.16, -0.45, 1.21), 0.0016, budget['ear'])
    P, T = arrays(me)
    C, A = ear_colour(P)
    parts.append((P, T, C, A, np.full(len(P), 0.03)))
    Pm = P * np.array([-1.0, 1.0, 1.0])
    parts.append((Pm, T[:, ::-1].copy(), C, A, np.full(len(P), 0.03)))
    n, out = 0, {k: [] for k in 'PTCAR'}
    for P, T, C, A, R in parts:
        out['P'].append(P); out['T'].append(T + n); out['C'].append(C); out['A'].append(A); out['R'].append(R)
        n += len(P)
    return {k: np.concatenate(v) for k, v in out.items()}


AO_DIRS = []
for i in range(32):  # cosine-weighted hemisphere about the normal (Fibonacci spiral)
    r = math.sqrt((i + 0.5) / 32)
    a = i * 2.399963
    AO_DIRS.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r))))


def bake_ao(m):
    """occlusion by ray casting over the whole deer, blurred over the triangles, into the colours; the ground below
    occludes too"""
    P, T = m['P'], m['T']
    N = vertex_normals(P, T)
    bvh = BVHTree.FromPolygons(P.tolist(), T.tolist())
    ao = np.empty(len(P))
    for i in range(len(P)):
        n = V(N[i])
        t = V((1, 0, 0)) if abs(n.x) < 0.9 else V((0, 1, 0))
        b1 = n.cross(t).normalized()
        b2 = n.cross(b1)
        o = V(P[i]) + n * 0.001
        reach = m['R'][i]
        hit = 0
        for d in AO_DIRS:
            r = b1 * d[0] + b2 * d[1] + n * d[2]
            if bvh.ray_cast(o, r, reach)[0] is not None or (r.z < 0 and o.z + r.z * reach < 0):
                hit += 1
        ao[i] = 1 - hit / len(AO_DIRS)
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    for _ in range(2):
        s, c = ao.copy(), np.ones(len(P))
        np.add.at(s, E[:, 0], ao[E[:, 1]])
        np.add.at(c, E[:, 0], 1)
        np.add.at(s, E[:, 1], ao[E[:, 0]])
        np.add.at(c, E[:, 1], 1)
        ao = s / c
    up = 0.5 + 0.5 * N[:, 2]
    m['C'] = m['C'] * ((0.45 + 0.55 * ao) * (0.84 + 0.16 * up))[:, None]


def make_mesh(name, m):
    me = bpy.data.meshes.new(name)
    me.from_pydata(m['P'].tolist(), [], m['T'].tolist())
    me.validate()
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', np.concatenate([m['C'], m['A'][:, None]], 1).ravel())
    me.color_attributes.active_color = ca
    return me


def make_rig():
    arm = bpy.data.armatures.new('deer_rig')
    rig = bpy.data.objects.new('deer_rig', arm)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name in BONES:
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = J[name]
        eb.roll = 0.0
        if PARENT[name]:
            eb.parent = arm.edit_bones[PARENT[name]]
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def heat_weights(rig, m, d):
    """Blender's bone-heat weights, worked out on a denser model d (smoother) and carried to m by the nearest of its
    vertices; the ears go wholly to their bones"""
    W = dense_weights(rig, d)
    kd = KDTree(len(d['P']))
    for i, p in enumerate(d['P']):
        kd.insert(p, i)
    kd.balance()
    W = np.array([sum(W[j] / max(dist, 1e-4) for _, j, dist in kd.find_n(p, 3)) for p in m['P']])
    W /= W.sum(1, keepdims=True)
    ears = (m['A'] == 0) & (m['P'][:, 2] > 1.04)
    for s, sign in (('_L', 1), ('_R', -1)):
        k = ears & (m['P'][:, 0] * sign > 0)
        W[k] = 0
        W[k, BONES.index('ear' + s)] = 1
    return W


def dense_weights(rig, m):
    me = make_mesh('heat', m)
    ob = bpy.data.objects.new('heat', me)
    bpy.context.collection.objects.link(ob)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    W = np.zeros((len(m['P']), len(BONES)))
    for vg in ob.vertex_groups:
        if vg.name not in BONES:
            continue
        j = BONES.index(vg.name)
        for v in me.vertices:
            for g in v.groups:
                if g.group == vg.index:
                    W[v.index, j] = g.weight
    empty = W.sum(1) < 1e-6
    print(f'heat weights: {int(empty.sum())} vertices without a bone', flush=True)
    # smoothed over the surface a little: softer creases at the joints
    T = m['T']
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    for _ in range(4):
        S, c = W.copy(), np.ones(len(W))
        np.add.at(S, E[:, 0], W[E[:, 1]])
        np.add.at(c, E[:, 0], 1)
        np.add.at(S, E[:, 1], W[E[:, 0]])
        np.add.at(c, E[:, 1], 1)
        W = S / c[:, None]
    # anything left over: the nearest weighted vertex's
    if empty.any():
        kd = KDTree(int((~empty).sum()))
        idx = np.nonzero(~empty)[0]
        for i, j in enumerate(idx):
            kd.insert(m['P'][j], i)
        kd.balance()
        for i in np.nonzero(empty)[0]:
            W[i] = W[idx[kd.find(m['P'][i])[1]]]
    W /= W.sum(1, keepdims=True)
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return W


def far_model(name, m, target):
    """the whole deer decimated; weights and colours from the nearest vertex of the full model"""
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
    bpy.data.meshes.remove(me)
    return {'P': P, 'T': T.reshape(-1, 3), 'C': m['C'][near], 'A': m['A'][near], 'W': m['W'][near]}


def bind(rig, name, m):
    me = make_mesh(name, m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    W = top4(m['W'])
    for j, b in enumerate(BONES):
        vg = ob.vertex_groups.new(name=b)
        for i in np.nonzero(W[:, j] > 1e-4)[0]:
            vg.add([int(i)], float(W[i, j]), 'REPLACE')
    ob.parent = rig
    ob.modifiers.new('rig', 'ARMATURE').object = rig
    print(f'{name}: {len(m["T"])} triangles, {len(m["P"])} vertices', flush=True)
    return ob


# ---------- poses ----------
def rx(a):
    return Quaternion((1, 0, 0), a)


def ry(a):
    return Quaternion((0, 1, 0), a)


def rz(a):
    return Quaternion((0, 0, 1), a)


class Rest:
    def __init__(self, rig):
        self.h, self.r, self.d, self.t = {}, {}, {}, {}
        for b in rig.data.bones:
            self.h[b.name] = b.head_local.copy()
            self.t[b.name] = b.tail_local.copy()
            self.r[b.name] = b.matrix_local.to_quaternion()
            self.d[b.name] = (b.tail_local - b.head_local).normalized()


def fk(rest, Q, Tr):
    """world (armature) rotations and head positions of every bone for the pose Q (rotations about each bone's head
    in the armature's axes, relative to its parent) and the root's offset Tr"""
    W, P = {}, {}
    for b in BONES:
        p = PARENT[b]
        if p is None:
            W[b], P[b] = Q[b], rest.h[b] + Tr
        else:
            W[b] = W[p] @ Q[b]
            P[b] = P[p] + W[p] @ (rest.h[b] - rest.h[p])
    return W, P


def ident():
    return {b: Quaternion() for b in BONES}


def solve2(o, t, a, b, sign):
    """2D two-bone: from o towards t with lengths a, b; the joint off the line to the side sign (+1: rotate the
    first bone counter-clockwise in (y, z)); returns the two unit directions"""
    d = t - o
    L = max(min(np.linalg.norm(d), a + b - 1e-5), abs(a - b) + 1e-5)
    d = d / max(np.linalg.norm(d), 1e-9)
    al = math.acos(max(-1.0, min(1.0, (a * a + L * L - b * b) / (2 * a * L))))
    c, s = math.cos(sign * al), math.sin(sign * al)
    u = np.array((d[0] * c - d[1] * s, d[0] * s + d[1] * c))
    j = o + u * a
    v = (o + d * L - j) / b
    return u, v


def rot2(v, a):
    c, s = math.cos(a), math.sin(a)
    return np.array((v[0] * c - v[1] * s, v[0] * s + v[1] * c))


def yz(v):
    return np.array((v.y, v.z))


class Leg:
    """a leg's lengths and its bend in the rest pose, in the deer's side plane (y, z)"""
    def __init__(self, rest, s, front):
        self.s, self.front = s, front
        names = [n + s for n in (FRONT if front else HIND)]
        self.names = names
        H = [rest.h[n] for n in names] + [rest.t[names[-1]]]
        self.L = [(H[i + 1] - H[i]).length for i in range(4)]
        self.x = [h.x for h in H]
        seg = [yz(H[i + 1] - H[i]) / self.L[i] for i in range(4)]
        self.hoof = seg[3]                                  # the pastern and hoof's direction standing
        self.fet = H[3]                                     # the fetlock standing
        ang = lambda a, b: math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])
        if front:
            # elbow bend: humerus vs (radius + cannon) as one piece
            low = (H[3] - H[1])
            self.sign = 1 if ang(seg[0], yz(low) / low.length) < 0 else -1
            self.rest_flex = ang(seg[1], seg[2])
        else:
            # the thigh (femur) follows the hip-to-fetlock line only partly (HIP_SHARE of its turn): the big muscles
            # round it fold less; the hock does the rest
            self.femur = seg[0]
            self.reach0 = yz(H[3] - H[0])
            self.sign = 1 if ang(seg[1], seg[2]) < 0 else -1
        self.ang = ang


def set_leg(rest, Q, Tr, leg, fet, flex=0.0, curl=0.0):
    """rotations of the leg's bones putting its fetlock on `fet` (a Vector); flex: the forefoot's knee (carpus)
    bent back (rad); curl: the hoof turned back under (rad)"""
    W, P = fk(rest, Q, Tr)
    top = P[leg.names[0]]
    o, t = yz(top), np.array((fet.y, fet.z))
    if leg.front:
        L1, L2, L3 = leg.L[:3]
        c = leg.rest_flex + flex
        lowv = np.array((L2, 0.0)) + L3 * np.array((math.cos(c), math.sin(c)))
        lv, beta = float(np.linalg.norm(lowv)), math.atan2(lowv[1], lowv[0])
        u, w = solve2(o, t, L1, lv, -leg.sign)
        dirs = [u, rot2(w, -beta), rot2(rot2(w, -beta), c)]
    else:
        L1, L2, L3 = leg.L[:3]
        u = rot2(leg.femur, HIP_SHARE * leg.ang(leg.reach0, t - o))
        v, w = solve2(o + u * L1, t, L2, L3, -leg.sign)
        dirs = [u, v, w]
    dirs.append(rot2(leg.hoof, curl))
    # bone by bone: the world direction each must point, as a rotation from its rest direction relative to its parent
    parent = PARENT[leg.names[0]]
    Wp = W[parent]
    for n, d2, i in zip(leg.names, dirs, range(4)):
        dx = (leg.x[i + 1] - leg.x[i]) / leg.L[i]
        d = V((dx, d2[0], d2[1])).normalized()
        Wb = rest.d[n].rotation_difference(d)
        Q[n] = Wp.inverted() @ Wb
        Wp = Wb


def keys(t, pts):
    """eased between (time, value) keys"""
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0)
            return v0 + (v1 - v0) * u * u * (3 - 2 * u)
    return pts[-1][1]


def sm(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


HIP_SHARE = 0.55

# gaits: cycle (s), stride (m: ground covered per cycle), share of the cycle each hoof is down, each leg's phase,
# the hoof's lift (m), the forefoot's knee bend in the swing, the body's rise and fall, pitching, the neck's nod
GAITS = {
    'walk': dict(T=1.05, S=0.84, duty=0.66, ph={'LH': 0.0, 'LF': 0.25, 'RH': 0.5, 'RF': 0.75}, lift=0.07, flex=1.45,
                 bob=0.008, pitch=0.6, nod=3.5, spine=0.0),
    'trot': dict(T=0.6, S=1.32, duty=0.42, ph={'LH': 0.0, 'RF': 0.02, 'RH': 0.5, 'LF': 0.52}, lift=0.11, flex=1.9,
                 bob=0.02, pitch=1.2, nod=2.0, spine=0.0),
    'bound': dict(T=0.44, S=2.6, duty=0.26, ph={'LH': 0.0, 'RH': 0.07, 'LF': 0.5, 'RF': 0.58}, lift=0.2, flex=2.3,
                  bob=0.07, pitch=7.0, nod=8.0, spine=9.0),
}
LEGS = {'LF': ('_L', True), 'RF': ('_R', True), 'LH': ('_L', False), 'RH': ('_R', False)}


def base_upper(Q, neck=0.0, head=0.0, yaw=0.0):
    """the neck raised (neck < 0) or lowered, the head pitched; yaw: turned to the left"""
    Q['neck1'] = rx(D(neck * 0.55)) @ rz(D(yaw * 0.35))
    Q['neck2'] = rx(D(neck * 0.45)) @ rz(D(yaw * 0.35))
    Q['head'] = rx(D(head)) @ rz(D(yaw * 0.3))


def gait_pose(name):
    g = GAITS[name]

    def pose(rest, t):
        Q = ident()
        ph = t / g['T']
        w = math.tau * ph
        # the body: two dips a cycle at the walk and trot, one bound's rock in the run
        if name == 'bound':
            rise = g['bob'] * math.sin(w - 0.6)
            pitch = g['pitch'] * math.sin(w + 0.9)
            flexs = g['spine'] * math.sin(w + 0.3)
        else:
            rise = g['bob'] * math.cos(2 * w)
            pitch = g['pitch'] * math.sin(2 * w)
            flexs = 0.0
        Tr = V((0, 0, rise - (0.012 if name != 'walk' else 0.0)))
        Q['pelvis'] = rx(D(pitch)) @ ry(D(1.2 if name == 'walk' else 0.6) * math.sin(w))
        Q['spine'] = rx(D(-flexs * 0.5))
        Q['chest'] = rx(D(-flexs * 0.5))
        # the head nods with the forefeet; held lower and forward in the run
        lower = {'walk': 4.0, 'trot': 8.0, 'bound': 18.0}[name]
        nod = g['nod'] * math.sin(2 * w + (0.4 if name == 'walk' else 0.0)) if name != 'bound' else g['nod'] * math.sin(w + 2.4)
        base_upper(Q, neck=lower + nod * 0.6, head=-lower * 0.6 + nod * 0.4)
        Q['tail'] = rx(D(-25.0 if name == 'bound' else 0.0))
        for k, (s, front) in LEGS.items():
            leg = LEG[k]
            p = (ph + g['ph'][k]) % 1.0
            sweep = g['S'] * g['duty']
            base = leg.fet.copy()
            if p < g['duty']:
                u = p / g['duty']
                dy = sweep * (u - 0.5)               # the planted hoof slides back under the body (+y)
                flex, curl = 0.0, 0.0
                fet = V((base.x, base.y + dy, base.z))
            else:
                u = (p - g['duty']) / (1 - g['duty'])
                e = sm(u)
                dy = sweep * (0.5 - e)
                arc = math.sin(math.pi * u)
                lift = g['lift'] * arc ** (0.8 if front else 1.0)
                flex = g['flex'] * math.sin(math.pi * min(1.0, u * 1.15)) ** 0.7 if front else 0.0
                curl = D(70 if front else 45) * math.sin(math.pi * u) ** 0.8
                fet = V((base.x, base.y + dy, base.z + lift))
            # the run reaches further: the forefeet strike ahead, the hind feet land under the chest
            if name == 'bound':
                fet.y += (-0.12 if front else -0.1)
            set_leg(rest, Q, Tr, leg, fet, flex, curl)
        return Q, Tr
    return pose


def leg_rest(rest, Q, Tr, dy=None, dz=None):
    """every leg standing (its fetlock where it stands, moved by dy, dz per leg key)"""
    for k, leg in LEG.items():
        f = leg.fet.copy()
        if dy and k in dy:
            f.y += dy[k]
        if dz and k in dz:
            f.z += dz[k]
        set_leg(rest, Q, Tr, leg, f)


def breathe(t, Q, amp=0.6, T=4.0):
    b = math.sin(math.tau * t / T)
    Q['spine'] = Q['spine'] @ rx(D(amp * 0.4 * b))
    Q['chest'] = Q['chest'] @ rx(D(-amp * 0.3 * b))
    return b


def stand_pose(rest, t):
    """8 s: standing easy, chewing, the head shifting a little, the weight on all four"""
    Q = ident()
    Tr = V((0, 0, 0))
    breathe(t, Q)
    w = math.tau * t / 8.0
    chew = math.sin(math.tau * t * 1.6) * 0.8
    base_upper(Q, neck=6 + 3 * math.sin(w), head=-4 + chew, yaw=6 * math.sin(w + 1.0))
    leg_rest(rest, Q, Tr)
    return Q, Tr


GRAZE = None    # neck1, neck2, head pitch (deg) that put the muzzle on the grass: fit_graze sets it


def graze_pose(rest, t):
    """6 s: muzzle in the grass, cropping: a tug and a small lift of the head with each bite, sweeping slowly to one
    side and back; one forefoot a little ahead"""
    Q = ident()
    Tr = V((0, 0, -0.02))
    graze_body(Q)
    breathe(t, Q, 0.4)
    w = math.tau * t / 6.0
    bite = max(0.0, math.sin(math.tau * t * 1.5)) ** 3
    sweep = 9 * math.sin(w)
    Q['neck1'] = rx(D(GRAZE[0])) @ rz(D(sweep * 0.5))
    Q['neck2'] = rx(D(GRAZE[1])) @ rz(D(sweep * 0.3))
    Q['head'] = rx(D(GRAZE[2] - 6 * bite)) @ rz(D(sweep * 0.4)) @ ry(D(4 * bite))
    leg_rest(rest, Q, Tr, dy={'LF': -0.15, 'RF': -0.06, 'LH': 0.03, 'RH': -0.02})
    return Q, Tr


def alert_pose(rest, t):
    """4 s: head up high, the neck straight, still; only breathing"""
    Q = ident()
    Tr = V((0, 0, 0.008))
    breathe(t, Q, 0.8, 2.0)
    base_upper(Q, neck=-22, head=10 + 1.0 * math.sin(math.tau * t / 4.0))
    Q['pelvis'] = rx(D(-1.0))
    leg_rest(rest, Q, Tr)
    return Q, Tr


# lying: the belly on the ground, the forelegs folded under the chest, the hind legs tucked to the left
BED_TR = V((0, 0, -0.39))


def bed_legs(rest, Q, Tr, k=1.0):
    """the legs folded as the deer lies (k 1), or partly"""
    for key, leg in LEG.items():
        f = leg.fet.copy()
        if leg.front:
            f = f.lerp(V((leg.fet.x * 0.85, -0.05, 0.035 + 0.39 * (1 - k) * 0)), k)
            set_leg(rest, Q, Tr, leg, f, flex=D(150) * k, curl=D(60) * k)
        else:
            side = 1 if key == 'LH' else 0.4
            f = f.lerp(V((leg.fet.x + 0.1 * side, -0.02 + 0.05 * (1 - side), 0.035)), k)
            set_leg(rest, Q, Tr, leg, f, curl=D(40) * k)


def bed_pose(rest, t):
    """10 s: lying, chewing the cud: the jaw working, a swallow, the head turning slowly"""
    Q = ident()
    Tr = BED_TR.copy()
    breathe(t, Q, 1.0, 3.3)
    w = math.tau * t / 10.0
    chew = math.sin(math.tau * t * 1.3) * (0.6 + 0.4 * math.sin(w))
    Q['pelvis'] = ry(D(-8)) @ rx(D(2))
    Q['spine'] = Q['spine'] @ ry(D(4))
    base_upper(Q, neck=-4 + 2 * math.sin(w), head=2 + chew, yaw=10 * math.sin(w + 0.5))
    bed_legs(rest, Q, Tr)
    return Q, Tr


def down_pose(rest, t):
    """3.6 s: from standing, down on the front knees, then the hindquarters lowered and folded, settling"""
    Q = ident()
    front = sm(t / 1.6)
    hind = sm((t - 1.1) / 1.9)
    Tr = V((0, 0, BED_TR.z * hind))
    # the chest goes down first: the body pitched nose-down, then level again
    pitch = 13 * front * (1 - hind)
    Q['pelvis'] = rx(D(pitch)) @ ry(D(-8 * hind))
    Q['spine'] = ry(D(4 * hind))
    base_upper(Q, neck=6 - 10 * front * (1 - hind) - 10 * hind, head=-4 + 6 * front)
    # forelegs: kneeling on the knees, then folded fully
    for key, leg in LEG.items():
        if leg.front:
            kneel = V((leg.fet.x, leg.fet.y + 0.17 * front, 0.035 + 0.03 * front))
            f = kneel.lerp(V((leg.fet.x * 0.85, -0.05, 0.035)), hind)
            set_leg(rest, Q, Tr, leg, f, flex=D(150) * front, curl=D(60) * front)
        else:
            side = 1 if key == 'LH' else 0.4
            f = leg.fet.lerp(V((leg.fet.x + 0.1 * side, -0.02 + 0.05 * (1 - side), 0.035)), hind)
            set_leg(rest, Q, Tr, leg, f, curl=D(40) * hind)
    return Q, Tr


def up_pose(rest, t):
    """2.4 s: rising hind end first (the hind legs straightened under, on the front knees), then the forelegs"""
    Q = ident()
    hind = sm(t / 1.1)
    front = sm((t - 0.9) / 1.3)
    Tr = V((0, 0, BED_TR.z * (1 - hind)))
    pitch = 16 * hind * (1 - front)
    Q['pelvis'] = rx(D(pitch)) @ ry(D(-8 * (1 - hind)))
    Q['spine'] = ry(D(4 * (1 - hind)))
    base_upper(Q, neck=-4 + 10 * hind * (1 - front) + 10 * front, head=2 - 6 * front)
    for key, leg in LEG.items():
        if leg.front:
            folded = V((leg.fet.x * 0.85, -0.05, 0.035))
            kneel = V((leg.fet.x, leg.fet.y + 0.17, 0.065))
            f = folded.lerp(kneel, hind).lerp(leg.fet, front)
            set_leg(rest, Q, Tr, leg, f, flex=D(150) * (1 - front), curl=D(60) * (1 - front))
        else:
            side = 1 if key == 'LH' else 0.4
            f = V((leg.fet.x + 0.1 * side, -0.02 + 0.05 * (1 - side), 0.035)).lerp(leg.fet, hind)
            set_leg(rest, Q, Tr, leg, f, curl=D(40) * (1 - hind))
    return Q, Tr


def stamp_pose(rest, t):
    """1.8 s: head high, the left forefoot lifted and struck down hard, twice"""
    Q = ident()
    Tr = V((0, 0, 0.008))
    base_upper(Q, neck=-22, head=10)
    lift = 0.0
    for t0 in (0.25, 0.95):
        u = (t - t0) / 0.55
        if 0 <= u <= 1:
            lift = math.sin(math.pi * u ** 0.7) if u < 0.75 else math.sin(math.pi * 0.75 ** 0.7) * (1 - (u - 0.75) / 0.25)
    flex = D(80) * lift
    Q['pelvis'] = rx(D(-1.0 - 2 * lift))
    leg_rest(rest, Q, Tr, dz={'LF': 0.1 * lift}, dy={'LF': -0.02 * lift})
    set_leg(rest, Q, Tr, LEG['LF'], V((LEG['LF'].fet.x, LEG['LF'].fet.y - 0.02 * lift, LEG['LF'].fet.z + 0.1 * lift)), flex, D(30) * lift)
    return Q, Tr


GROOM = None


def groom_pose(rest, t):
    """5 s: the head turned round to the left flank, licking it in short strokes, back"""
    Q = ident()
    Tr = V((0, 0, 0))
    k = keys(t, [(0, 0), (1.2, 1), (3.9, 1), (5.0, 0)])
    lick = math.sin(math.tau * t * 2.0) * sstep(1.1, 1.4, t) * sstep(3.9, 3.6, t)
    Q['spine'] = rz(D(6 * k))
    Q['chest'] = rz(D(8 * k))
    Q['neck1'] = rx(D(GROOM[0] * k)) @ rz(D(GROOM[1] * k))
    Q['neck2'] = rx(D(GROOM[2] * k)) @ rz(D(GROOM[3] * k))
    Q['head'] = rx(D(GROOM[4] * k + 5 * lick)) @ rz(D(GROOM[5] * k)) @ ry(D(GROOM[6] * k))
    leg_rest(rest, Q, Tr, dy={'LF': -0.03 * k})
    return Q, Tr


def muzzle(rest, Q, Tr):
    W, P = fk(rest, Q, Tr)
    return P['head'] + W['head'] @ (V((0, -0.738, 0.918)) - rest.h['head'])


def graze_body(Q, k=1.0):
    """grazing: the forequarters lowered a little (the chest pitched down), more weight forward"""
    Q['pelvis'] = rx(D(GRAZE_PITCH * k))
    Q['chest'] = rx(D(GRAZE_PITCH * 0.6 * k))


GRAZE_PITCH = 6.0


def fit_graze(rest):
    """the neck's bend that puts the muzzle on the grass in front of the forefeet, the head pointing down, with the
    least bending"""
    goal = V((0.0, -0.64, 0.035))
    best, arg = 1e9, None
    for a in range(0, 121, 4):
        for b in range(-20, 81, 4):
            for c in range(-40, 81, 5):
                Q = ident()
                graze_body(Q)
                Q['neck1'], Q['neck2'], Q['head'] = rx(D(a)), rx(D(b)), rx(D(c))
                W, P = fk(rest, Q, V((0, 0, -0.02)))
                down = (W['head'] @ V((0, -1, 0))).z
                q = (muzzle(rest, Q, V((0, 0, -0.02))) - goal).length ** 2 * 2000 + 0.3 * max(0, down + 0.75) + 1e-5 * (a * a + b * b + c * c) / 100
                if q < best:
                    best, arg = q, (a, b, c)
    print('graze bend', arg, 'cost', round(best, 4), flush=True)
    return list(arg)


def fit_groom(rest):
    """neck and head angles that bring the muzzle round to the left flank"""
    goal = V((0.135, -0.14, 0.66))
    best, arg = 1e9, None
    import random
    rnd = random.Random(3)
    cur = [10, 30, 0, 35, 20, 30, 10]
    lo = [-20, 0, -30, 0, -30, 0, -30]
    hi = [40, 60, 40, 70, 60, 70, 40]
    for it in range(8000):
        a = [min(h, max(l, c + rnd.gauss(0, 12 if it < 4000 else 3))) for c, l, h in zip(cur, lo, hi)] if it else cur
        Q = ident()
        Q['spine'], Q['chest'] = rz(D(6)), rz(D(8))
        Q['neck1'] = rx(D(a[0])) @ rz(D(a[1]))
        Q['neck2'] = rx(D(a[2])) @ rz(D(a[3]))
        Q['head'] = rx(D(a[4])) @ rz(D(a[5])) @ ry(D(a[6]))
        q = (muzzle(rest, Q, V()) - goal).length ** 2 * 2000 + 2e-5 * sum(x * x for x in a)
        if q < best:
            best, arg, cur = q, a, a
    print('groom bend', [round(x) for x in arg], 'cost', round(best, 4), flush=True)
    return arg


CLIPS = {
    'walk': (gait_pose('walk'), GAITS['walk']['T'], 1),
    'trot': (gait_pose('trot'), GAITS['trot']['T'], 1),
    'bound': (gait_pose('bound'), GAITS['bound']['T'], 1),
    'stand': (stand_pose, 8.0, 3),
    'graze': (graze_pose, 6.0, 2),
    'alert': (alert_pose, 4.0, 3),
    'bed': (bed_pose, 10.0, 3),
    'down': (down_pose, 3.6, 2),
    'up': (up_pose, 2.4, 2),
    'stamp': (stamp_pose, 1.8, 1),
    'groom': (groom_pose, 5.0, 2),
}
LEG = {}


def linear(act):
    """linear between the keys: the exporter samples every frame, and tools/blender.mjs's resample() then drops the
    samples that lie on the straight line between keys"""
    curves = list(getattr(act, 'fcurves', None) or [])
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves += list(bag.fcurves)
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def key_clips(rig):
    global GRAZE, GROOM
    rest = Rest(rig)
    for k, (s, front) in LEGS.items():
        LEG[k] = Leg(rest, s, front)
    GRAZE = fit_graze(rest)
    GROOM = fit_groom(rest)
    rig.animation_data_create()
    for b in rig.pose.bones:
        b.rotation_mode = 'QUATERNION'
    for name, (pose, dur, step) in CLIPS.items():
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        prev = {}
        n = int(round(dur * FPS))
        frames = list(range(0, n + 1, step))
        if frames[-1] != n:
            frames.append(n)
        for f in frames:
            Q, Tr = pose(rest, (f % n if name in GAITS else f) / FPS)
            for b in BONES:
                r = rest.r[b]
                q = r.inverted() @ Q[b] @ r
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q
                pb = rig.pose.bones[b]
                pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f, group=b)
            pb = rig.pose.bones['pelvis']
            pb.location = rest.r['pelvis'].inverted() @ Tr
            pb.keyframe_insert('location', frame=f, group='pelvis')
        linear(act)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
        print(f'{name}: {n} frames', flush=True)
    for b in rig.pose.bones:
        b.rotation_quaternion = Quaternion()
        b.location = V()


BUDGET = dict(body=6600, dense=40000, ear=260, far=1600)


def main(out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    m = build(BUDGET)
    bake_ao(m)
    rig = make_rig()
    m['W'] = heat_weights(rig, m, build(BUDGET, dense=True))
    far = far_model('deer_far', m, BUDGET['far'])
    bind(rig, 'deer', m)
    bind(rig, 'deer_far', far)
    key_clips(rig)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_normals=True, export_yup=True, export_skins=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_step=1, export_optimize_animation_size=False)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
