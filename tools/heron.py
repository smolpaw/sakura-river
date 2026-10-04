# The river's grey heron (aosagi, Ardea cinerea) and the paddies' little egrets (kosagi, Egretta garzetta), built in
# Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/heron.py -- <out.glb>
# A heron of about 0.93 m standing, its neck drawn up in an S, the head held level on it with the dagger bill: the
# body a teardrop tilted tail-down with the wings folded along its sides (their primaries crossed over the short
# tail), the neck a chain of rounded cones, the plumes hanging from its foot over the breast, a slim head, the bill
# its own mesh; long legs bent back at the ankle, three toes forward and one back. Blender: z up, facing -y, the
# bird's left at +x (glTF: y up, facing +z), the feet on z = 0.
# The plumage and the legs are signed distance fields (numpy) meshed by surface nets and decimated to a budget, with
# the meshing helpers of tools/human.py; the bill and the black crest plumes are built directly. Colours are painted
# per vertex from the same fields (the grey back and wings, the darker flight feathers, the black flank stripe and
# shoulder, the white neck and head, the yellow bill, the dark legs), then ambient occlusion (ray cast over the whole
# bird) darkens them; alpha is 1 on the plumage, 0 on the bill and legs: on the plumage the page (src/heron.js) draws
# the marks finer than the vertices can carry (the eye stripe and the eye, the streaks down the neck's front).
# The egret is the same bird slimmer, its neck thinner, all white, the bill and legs black and the feet yellow, built
# on the heron's skeleton so it plays the heron's clips (the page scales it to about 0.6 m).
# Meshes, all skinned to one armature (`heron_rig`): `heron` (~7.8k triangles), `heron_far` (~1.5k), `egret`
# (~3.9k), `egret_far` (~0.9k).
# Clips (in place but for the stalk), keyed from poses computed here, each beginning and ending in the rest pose so the
# page can fade between them anywhere: `idle` (10 s loop: breathing, the neck swaying, the head turning slowly to look
# about), `stalk` (6 s: the neck reaches forward and down, one slow step with each foot, STALK m forward, a freeze,
# the neck drawn back), `preen` (5 s: the head down to the breast, nibbling there on one side then the other, back up).
# The feet stay planted by inverse kinematics while the body moves. Keyed at 30 fps, exported at 15.
import bpy, math, os, sys
import numpy as np
from mathutils import Vector, Quaternion
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from human import srgb, sstep, sphere, capsule, smin, surface_nets, to_mesh, decimate, positions, vertex_normals, top4

V = Vector
FPS = 30
STALK = 0.17   # m: the stalk's step forward (src/heron.js moves the bird on by as much when it ends)


# ---------- fields ----------
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


def catmull(pts, n):
    """n points along a centripetal-ish Catmull-Rom through pts (ends extended)"""
    P = [np.array(p, float) for p in pts]
    P = [2 * P[0] - P[1]] + P + [2 * P[-1] - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return np.array(out)


# the bird's build; the egret's differs (KINDS)
BODY_PITCH = math.radians(32)          # the body's long axis, tail down
NECK_PTS = [(0, -0.06, 0.62), (0, -0.132, 0.69), (0, -0.127, 0.765), (0, -0.086, 0.83), (0, -0.1, 0.882), (0, -0.138, 0.903)]
NECK = catmull(NECK_PTS, 6)            # the neck's centre line, base to the back of the head
EYE = (0.0175, -0.163, 0.912)          # the left eye (mirrored)
BILL = ((0, -0.176, 0.9015), (0, -0.305, 0.8865))   # the bill's base and tip
HIP = (0.036, 0.016, 0.43)             # where the left leg leaves the belly (the tibia's head)
KNEE = (0.034, 0.036, 0.205)            # the ankle (intertarsal joint), bent back
FOOT = (0.032, 0.0, 0.016)              # the foot
KINDS = {
    'heron': dict(w=1.0, neck=1.0, bill=1.0, leg=1.0, crest=True),
    'egret': dict(w=0.84, neck=0.78, bill=0.72, leg=0.9, crest=False),
}


def neck_radius(t, k):
    """the neck's radius from its base (t 0) to the head (t 1)"""
    return k['neck'] * (0.037 - 0.018 * sstep(0.0, 0.7, t) + 0.002 * sstep(0.85, 1.0, t))


def body_frame():
    return frame((0.0, math.cos(BODY_PITCH), -math.sin(BODY_PITCH)), (0.0, 0.0, 1.0))


def wing_frame(s):
    """the left (s 1) or right (s -1) folded wing: along its length towards the tail, converging over it"""
    psi = math.radians(5.5)
    th = BODY_PITCH + math.radians(3)
    return frame((-s * math.sin(psi), math.cos(psi) * math.cos(th), -math.cos(psi) * math.sin(th)), (0.0, 0.0, 1.0))


RB = body_frame()
RW = {1: wing_frame(1), -1: wing_frame(-1)}
WING_C = lambda s, k: (s * 0.056 * k['w'], 0.075, 0.53)
WING_R = lambda k: (0.026 * k['w'], 0.205, 0.078)


def parts(p, k):
    """the plumage's components (each a field): torso, breast, belly, tail, wings, neck, plumes, head"""
    w = k['w']
    d = {}
    d['torso'] = ell(p, (0, 0.035, 0.53), (0.078 * w, 0.18, 0.09), RB)
    d['breast'] = ell(p, (0, -0.065, 0.6), (0.063 * w, 0.065, 0.075))
    d['belly'] = ell(p, (0, 0.03, 0.465), (0.06 * w, 0.09, 0.055))
    d['tail'] = ell(p, (0, 0.215, 0.425), (0.035 * w, 0.06, 0.014), frame((0, 0.92, -0.39)))
    d['wing'] = np.minimum(ell(p, WING_C(1, k), WING_R(k), RW[1]), ell(p, WING_C(-1, k), WING_R(k), RW[-1]))
    nk = np.full(np.shape(p[0]), 1e3)
    n = len(NECK)
    for i in range(n - 1):
        nk = np.minimum(nk, capsule(p, NECK[i], NECK[i + 1], neck_radius(i / (n - 1), k), neck_radius((i + 1) / (n - 1), k)))
    d['neck'] = nk
    # the long plumes hanging from the neck's foot over the breast
    d['plumes'] = ell(p, (0, -0.112, 0.64), (0.03 * k['neck'], 0.075, 0.028), frame((0, -0.3, -0.95), (1.0, 0.0, 0.0)))
    hd = ell(p, (0, -0.142, 0.905), (0.021 * k['neck'], 0.044, 0.025), frame((0, -1, -0.12)))
    hd = smin(hd, capsule(p, (0, -0.15, 0.904), BILL[0], 0.018 * k['bill'] + 0.003, 0.0105 * k['bill']), 0.008)
    d['head'] = hd
    return d


def plumage_sdf(k):
    def fn(p):
        d = parts(p, k)
        body = smin(smin(d['torso'], d['breast'], 0.03), d['belly'], 0.03)
        body = smin(body, d['tail'], 0.02)
        body = smin(body, d['wing'], 0.012)
        neck = smin(d['neck'], d['plumes'], 0.025)
        f = smin(body, neck, 0.03)
        return smin(f, d['head'], 0.012)
    return fn


def bill_sdf(k):
    """the dagger: a cone from the base to the tip, flattened from the sides, the culmen a little convex"""
    def fn(p):
        x, y, z = p
        a, b = BILL
        t = np.clip((y - a[1]) / (b[1] - a[1]), 0.0, 1.0)
        zc = a[2] + (b[2] - a[2]) * t + 0.0025 * np.sin(math.pi * t) * k['bill']
        h = (0.0105 * (1 - t) ** 0.85 + 0.0006) * k['bill']    # half height
        wd = h * 0.72                                       # half width
        q = np.sqrt((x / wd) ** 2 + ((z - zc) / h) ** 2)
        return np.maximum((q - 1.0) * np.minimum(wd, h), np.maximum(y - (a[1] + 0.012), b[1] - y))
    return fn


def leg_sdf(k):
    """the left leg: the bare tibia from the belly to the ankle, the tarsus, three toes forward and one back"""
    r = 0.0088 * k['leg']

    def fn(p):
        f = capsule(p, HIP, KNEE, r * 1.05, r * 0.95)
        f = smin(f, sphere(p, KNEE, r * 1.22), 0.006)
        f = smin(f, capsule(p, KNEE, FOOT, r * 0.92, r * 0.85), 0.006)
        base = (FOOT[0], FOOT[1], 0.009)
        for ang, ln in ((-0.42, 0.082), (0.0, 0.098), (0.42, 0.078)):
            tip = (FOOT[0] + math.sin(ang) * ln, FOOT[1] - math.cos(ang) * ln, 0.004)
            f = smin(f, capsule(p, base, tip, r * 0.62, r * 0.3), 0.005)
        f = smin(f, capsule(p, base, (FOOT[0] - 0.004, FOOT[1] + 0.048, 0.006), r * 0.55, r * 0.3), 0.005)
        return f
    return fn


def crest():
    """two black plumes trailing from the nape (tubes, directly)"""
    import bmesh
    bm = bmesh.new()
    for (dx, ln, droop) in ((0.0035, 0.115, 0.022), (-0.003, 0.095, 0.03)):
        pts = catmull([(dx, -0.128, 0.918), (dx * 1.5, -0.085, 0.917), (dx * 2, -0.04, 0.913 - droop * 0.4), (dx * 2.2, -0.128 + ln, 0.912 - droop)], 4)
        rings = []
        for i, c in enumerate(pts):
            t = i / (len(pts) - 1)
            rr = 0.0055 * (1 - t) + 0.001
            tan = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
            R = frame(tan, (0.0, 0.0, 1.0))
            ring = []
            for j in range(6):
                a = j / 6 * math.tau
                off = R[0] * math.cos(a) * rr * 0.8 + R[2] * math.sin(a) * rr * 0.55
                ring.append(bm.verts.new(V(c + off)))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for j in range(6):
                bm.faces.new((a[j], a[(j + 1) % 6], b[(j + 1) % 6], b[j]))
        bm.faces.new(rings[-1][::-1])
    me = bpy.data.meshes.new('crest')
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    return me


# ---------- colours (linear) ----------
GREY = srgb('#c0c4c7')       # back and wing coverts
GREY_D = srgb('#868b91')     # secondaries
SLATE = srgb('#363a40')      # primaries
BLACK = srgb('#16171a')
WHITE = srgb('#e4e4df')
NECK_C = srgb('#c9cbcb')     # the neck's back and sides
BELLY = srgb('#d2d2cd')
PLUME = srgb('#cfd0cd')
BILL_C = srgb('#d6a43a')
BILL_D = srgb('#9a7a3a')
LEG_C = srgb('#5b5241')
LEG_T = srgb('#8a7a4e')      # the tibia, paler
E_WHITE = srgb('#e8e5dc')
E_BLACK = srgb('#141414')
E_FOOT = srgb('#c8a832')


def soft_pick(dists, k=0.006):
    """weights of each component by how near its surface the point is"""
    D = np.stack(dists)
    w = np.exp(-(D - D.min(0)) / k)
    return w / w.sum(0)


def plumage_colour(kind, k):
    def fn(P):
        p = (P[:, 0], P[:, 1], P[:, 2])
        x, y, z = p
        d = parts(p, k)
        if kind == 'egret':
            return np.tile(E_WHITE, (len(P), 1)), np.ones(len(P))
        names = ['torso', 'breast', 'belly', 'tail', 'wing', 'neck', 'plumes', 'head']
        W = soft_pick([d[n] for n in names])
        # body: grey over the back, pale below, a black stripe along the flank under the wing's front edge
        body = np.tile(BELLY, (len(P), 1))
        back = sstep(0.49, 0.6, z + 0.25 * (y - 0.03)) * sstep(0.05, 0.02, np.abs(x) - 0.01)
        body = body + (GREY - body) * back[:, None]
        flank = sstep(0.03, 0.045, np.abs(x)) * sstep(0.45, 0.48, z) * sstep(0.62, 0.58, z) * sstep(0.07, 0.0, y)
        body = body + (BLACK - body) * flank[:, None]
        # wings: coverts grey, the shoulder black, the secondaries darker, the primaries slate at the tips
        q = np.einsum('ij,nj->ni', RW[1], np.stack([np.abs(x) - WING_C(1, k)[0], y - 0.07, z - 0.522], 1))
        along = q[:, 1] / WING_R(k)[1]   # -1 front .. 1 tip
        low = q[:, 2] / WING_R(k)[2]     # -1 lower edge .. 1 top
        wing = np.tile(GREY, (len(P), 1))
        wing = wing + (GREY_D - wing) * (sstep(0.0, 0.35, along) * sstep(0.3, -0.4, low))[:, None]
        wing = wing + (SLATE - wing) * np.maximum(sstep(0.42, 0.62, along), sstep(0.2, 0.4, along) * sstep(-0.2, -0.6, low))[:, None]
        wing = wing + (BLACK - wing) * (sstep(-0.25, -0.4, along) * sstep(0.35, 0.1, low))[:, None]
        tail = np.tile(GREY_D, (len(P), 1))
        # neck: pale grey behind, white down the front
        front = sstep(0.0, -0.012, y - np.interp(z, NECK[:, 2], NECK[:, 1]))
        neck = np.tile(NECK_C, (len(P), 1)) + (WHITE - NECK_C) * front[:, None]
        plumes = np.tile(PLUME, (len(P), 1))
        head = np.tile(WHITE, (len(P), 1))
        stripe = sstep(0.006, 0.011, np.abs(x)) * sstep(EYE[2] - 0.004, EYE[2], z) * sstep(EYE[1] - 0.006, EYE[1] + 0.002, y)
        stripe = np.maximum(stripe, sstep(-0.13, -0.115, y) * sstep(0.895, 0.905, z))
        head = head + (BLACK - head) * stripe[:, None]
        C = sum(W[i][:, None] * c for i, c in enumerate([body, body, body, tail, wing, neck, plumes, head]))
        return C, np.ones(len(P))
    return fn


def bill_colour(kind, k):
    def fn(P):
        if kind == 'egret':
            return np.tile(E_BLACK, (len(P), 1)), np.zeros(len(P))
        top = sstep(0.0, 0.004, P[:, 2] - (BILL[0][2] + (BILL[1][2] - BILL[0][2]) * np.clip((P[:, 1] - BILL[0][1]) / (BILL[1][1] - BILL[0][1]), 0, 1)))
        base = sstep(-0.24, -0.19, -P[:, 1] * 1.0)
        C = BILL_C + (BILL_D - BILL_C) * (top * 0.5 * (1 - base))[:, None]
        return C, np.zeros(len(P))
    return fn


def leg_colour(kind, k):
    def fn(P):
        if kind == 'egret':
            C = E_BLACK + (E_FOOT - E_BLACK) * sstep(0.03, 0.012, P[:, 2])[:, None]
            return C, np.zeros(len(P))
        C = LEG_C + (LEG_T - LEG_C) * sstep(0.26, 0.36, P[:, 2])[:, None]
        return C, np.zeros(len(P))
    return fn


# ---------- skeleton ----------
def neck_point(t):
    """the point a share t of the way along the neck's centre line"""
    seg = np.linalg.norm(np.diff(NECK, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    u = t * s[-1]
    i = min(np.searchsorted(s, u) - 1, len(seg) - 1)
    i = max(i, 0)
    f = (u - s[i]) / seg[i]
    return tuple(NECK[i] + (NECK[i + 1] - NECK[i]) * f)


N1, N2, N3, N4 = neck_point(0.0), neck_point(0.34), neck_point(0.66), neck_point(0.93)
J = {
    'body': ((0, 0.02, 0.47), (0, -0.06, 0.6)),
    'neck1': (N1, N2),
    'neck2': (N2, N3),
    'neck3': (N3, N4),
    'head': (N4, BILL[1]),
    'tibia_L': (HIP, KNEE),
    'tarsus_L': (KNEE, FOOT),
    'toes_L': (FOOT, (FOOT[0], FOOT[1] - 0.08, 0.006)),
}
for b in ('tibia', 'tarsus', 'toes'):
    a, c = J[b + '_L']
    J[b + '_R'] = ((-a[0], a[1], a[2]), (-c[0], c[1], c[2]))
BONES = ['body', 'neck1', 'neck2', 'neck3', 'head', 'tibia_L', 'tarsus_L', 'toes_L', 'tibia_R', 'tarsus_R', 'toes_R']
PARENT = {'body': None, 'neck1': 'body', 'neck2': 'neck1', 'neck3': 'neck2', 'head': 'neck3',
          'tibia_L': 'body', 'tarsus_L': 'tibia_L', 'toes_L': 'tarsus_L', 'tibia_R': 'body', 'tarsus_R': 'tibia_R', 'toes_R': 'tarsus_R'}


def chain_weights(P):
    """the plumage: along the spine (tail, hip, breast, then the neck's centre line to the bill's tip), each vertex by
    the nearest point on it, blended across the joints"""
    line = np.array([(0, 0.25, 0.41), (0, 0.03, 0.48), (0, -0.04, 0.58)] + [tuple(q) for q in NECK] + [BILL[0], BILL[1]])
    seg = line[1:] - line[:-1]
    ln = np.linalg.norm(seg, axis=1)
    s0 = np.concatenate([[0], np.cumsum(ln)])
    best = np.full(len(P), 1e9)
    u = np.zeros(len(P))
    for i in range(len(seg)):
        t = np.clip(((P - line[i]) @ seg[i]) / (ln[i] ** 2), 0, 1)
        d = np.linalg.norm(P - (line[i] + t[:, None] * seg[i]), axis=1)
        m = d < best
        best[m] = d[m]
        u[m] = s0[i] + t[m] * ln[i]

    def at(q):   # arc length of a point on the line
        return s0[3 + int(np.argmin(np.linalg.norm(NECK - np.array(q), axis=1)))]
    joints = [at(N1) + 0.01, at(N2), at(N3), at(N4)]
    names = ['body', 'neck1', 'neck2', 'neck3', 'head']
    W = {n: np.zeros(len(P)) for n in names}
    bw = 0.014
    # piecewise: a ramp of width 2 bw across each joint
    prev = np.ones(len(P))
    for j, n in enumerate(names[:-1]):
        nxt = sstep(joints[j] - bw, joints[j] + bw, u)
        W[n] = prev - nxt
        prev = nxt
    W['head'] = prev
    return W


def leg_weights(side):
    s = '_L' if side > 0 else '_R'

    def fn(P):
        z = P[:, 2]
        body = sstep(0.37, 0.43, z)
        tib = sstep(KNEE[2] - 0.012, KNEE[2] + 0.012, z) - body
        toes = sstep(0.03, 0.012, z) * sstep(FOOT[1] + 0.012, FOOT[1] - 0.012, P[:, 1])
        tar = 1 - body - tib - toes
        return {'body': body, 'tibia' + s: tib, 'tarsus' + s: np.clip(tar, 0, 1), 'toes' + s: toes}
    return fn


def const_weights(b):
    return lambda P: {b: np.ones(len(P))}


# ---------- assembly ----------
class Part:
    def __init__(self, me, colour, weights, reach):
        me.calc_loop_triangles()
        P = positions(me)
        T = np.empty(len(me.loop_triangles) * 3, np.int64)
        me.loop_triangles.foreach_get('vertices', T)
        bpy.data.meshes.remove(me)
        self.P, self.T = P, T.reshape(-1, 3)
        self.col, self.alpha = colour(P)
        self.W = np.zeros((len(P), len(BONES)))
        for b, w in weights(P).items():
            self.W[:, BONES.index(b)] += w
        self.reach = np.full(len(P), reach)

    def mirrored(self):
        o = Part.__new__(Part)
        o.P = self.P * np.array([-1.0, 1.0, 1.0])
        o.T = self.T[:, ::-1].copy()
        o.col, o.alpha, o.reach = self.col, self.alpha, self.reach
        o.W = np.zeros_like(self.W)
        for j, b in enumerate(BONES):
            o.W[:, BONES.index(b[:-2] + ('_R' if b.endswith('_L') else '_L') if b[-2:] in ('_L', '_R') else b)] = self.W[:, j]
        return o


def sdf_part(name, fn, lo, hi, h, target, protect=None):
    verts, quads = surface_nets(fn, lo, hi, h)
    me = to_mesh(name, verts, quads)
    print(f'{name}: {len(quads) * 2} triangles meshed', flush=True)
    return decimate(me, target, protect)


def head_protect(P):
    return sstep(0.84, 0.88, P[:, 2]) * sstep(-0.08, -0.12, P[:, 1])


def build(kind, budget):
    k = KINDS[kind]
    out = []
    me = sdf_part(kind, plumage_sdf(k), (-0.105, -0.2, 0.355), (0.105, 0.305, 0.945), 0.0024, budget['plumage'], head_protect if kind == 'heron' else None)
    out.append(Part(me, plumage_colour(kind, k), chain_weights, 0.09))
    me = sdf_part(kind + '_bill', bill_sdf(k), (-0.012, -0.31, 0.87), (0.012, -0.16, 0.92), 0.0008, budget['bill'])
    out.append(Part(me, bill_colour(kind, k), const_weights('head'), 0.02))
    me = sdf_part(kind + '_leg', leg_sdf(k), (0.0, -0.11, -0.01), (0.08, 0.075, 0.445), 0.0013, budget['leg'])
    leg = Part(me, leg_colour(kind, k), leg_weights(1), 0.05)
    out += [leg, leg.mirrored()]
    if k['crest']:
        out.append(Part(crest(), lambda P: (np.tile(BLACK, (len(P), 1)), np.ones(len(P))), const_weights('head'), 0.02))
    return out


def join(parts):
    n = 0
    P, T, C, A, W, R = [], [], [], [], [], []
    for p in parts:
        P.append(p.P)
        T.append(p.T + n)
        C.append(p.col)
        A.append(p.alpha)
        W.append(p.W)
        R.append(p.reach)
        n += len(p.P)
    return {'P': np.concatenate(P), 'T': np.concatenate(T), 'C': np.concatenate(C), 'A': np.concatenate(A),
            'W': np.concatenate(W), 'R': np.concatenate(R)}


AO_DIRS = []
for i in range(32):  # cosine-weighted hemisphere about +z (Fibonacci spiral)
    r = math.sqrt((i + 0.5) / 32)
    a = i * 2.399963
    AO_DIRS.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r))))


def bake_ao(m):
    """occlusion by ray casting over the whole bird, blurred over the triangles, into the colours; the sky above
    weighs more than the water below"""
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
    up = 0.5 + 0.5 * N[:, 2]
    m['C'] = m['C'] * ((0.5 + 0.5 * ao) * (0.86 + 0.14 * up))[:, None]


def make_mesh(name, m):
    me = bpy.data.meshes.new(name)
    me.from_pydata(m['P'].tolist(), [], m['T'].tolist())
    me.validate()
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', np.concatenate([m['C'], m['A'][:, None]], 1).ravel())
    me.color_attributes.active_color = ca
    return me


def far_model(name, m, target):
    """the whole bird decimated; weights and colours from the nearest vertex of the full model"""
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
    return {'P': P, 'T': T.reshape(-1, 3), 'C': m['C'][near], 'A': m['A'][near], 'W': m['W'][near], 'R': m['R'][near]}


def make_rig():
    arm = bpy.data.armatures.new('heron_rig')
    rig = bpy.data.objects.new('heron_rig', arm)
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


# ---------- clips ----------
def rx(a):
    return Quaternion((1, 0, 0), a)


def ry(a):
    return Quaternion((0, 1, 0), a)


def rz(a):
    return Quaternion((0, 0, 1), a)


D = math.radians


class Rest:
    def __init__(self, rig):
        self.h, self.r, self.d = {}, {}, {}
        for b in rig.data.bones:
            self.h[b.name] = b.head_local.copy()
            self.r[b.name] = b.matrix_local.to_quaternion()
            self.d[b.name] = (b.tail_local - b.head_local).normalized()
        self.L1 = (V(KNEE) - V(HIP)).length
        self.L2 = (V(FOOT) - V(KNEE)).length


def leg_ik(rest, Q, Tr, s, A, toe):
    """tibia, tarsus and toes rotations putting the foot on A, the ankle bent back; toe: the toes' pitch (rad, down)"""
    Qb = Q['body']
    H = Tr + rest.h['body'] + Qb @ (rest.h['tibia' + s] - rest.h['body'])
    L1, L2 = rest.L1, rest.L2
    dv = A - H
    d = min(max(dv.length, abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4)
    dr = dv.normalized()
    pole = Qb @ V((0, 1, 0))
    pp = (pole - dr * pole.dot(dr)).normalized()
    a = (L1 * L1 - L2 * L2 + d * d) / (2 * d)
    K = H + dr * a + pp * math.sqrt(max(L1 * L1 - a * a, 0.0))
    Q['tibia' + s] = rest.d['tibia' + s].rotation_difference((Qb.inverted() @ (K - H)).normalized())
    Wt = Qb @ Q['tibia' + s]
    Q['tarsus' + s] = rest.d['tarsus' + s].rotation_difference((Wt.inverted() @ (A - K)).normalized())
    Ws = Wt @ Q['tarsus' + s]
    Q['toes' + s] = Ws.inverted() @ rx(toe)


def keys(t, pts):
    """eased between (time, value) keys"""
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0)
            return v0 + (v1 - v0) * u * u * (3 - 2 * u)
    return pts[-1][1]


FEET = {'_L': V(FOOT), '_R': V((-FOOT[0], FOOT[1], FOOT[2]))}


def idle_pose(t):
    """10 s: three breaths, the neck swaying, the head turning to look about and down at the water"""
    Q = {b: Quaternion() for b in BONES}
    w = math.tau * t / 10.0
    breath = math.sin(3 * w)
    look = keys(t, [(0, 0), (1.2, 0), (2.4, 26), (4.4, 26), (5.4, -4), (6.3, -4), (7.4, -30), (8.8, -30), (10, 0)])
    down = keys(t, [(0, 0), (2.4, 0), (3.2, 9), (4.2, 9), (4.8, 0), (7.6, 0), (8.2, 6), (8.8, 0), (10, 0)])
    Q['body'] = rx(D(0.5) * breath) @ rz(D(1.5) * math.sin(w))
    Tr = V((0.0, 0.0, 0.002 * breath))
    Q['neck1'] = rx(D(1.5) * math.sin(2 * w)) @ ry(D(1.0) * math.sin(w))
    Q['neck2'] = rx(-D(2.0) * math.sin(2 * w + 0.5) + D(2.0) * math.sin(0.5)) @ rz(D(look * 0.15))
    Q['neck3'] = rz(D(look * 0.35)) @ rx(D(down * 0.4))
    Q['head'] = rz(D(look * 0.5)) @ rx(D(down * 0.6) + D(1.0) * math.sin(4 * w)) @ ry(D(look * 0.12))
    return Q, Tr, {s: (FEET[s], 0.0) for s in FEET}


def stalk_pose(t):
    """6 s: the neck reaches forward and down; one slow step with the right foot, one with the left, STALK m on;
    a freeze; the neck drawn back"""
    Q = {b: Quaternion() for b in BONES}
    hunt = keys(t, [(0, 0), (0.9, 1), (5.0, 1), (6.0, 0)])
    Q['neck1'] = rx(D(24) * hunt)
    Q['neck2'] = rx(-D(30) * hunt)
    Q['neck3'] = rx(D(4) * hunt)
    Q['head'] = rx(D(22) * hunt)
    go = keys(t, [(0, 0), (0.8, 0), (2.6, 0.5), (4.2, 1.0), (6, 1.0)])
    lean = keys(t, [(0, 0), (1.0, 1), (4.2, 1), (5.2, 0), (6, 0)])
    Q['body'] = rx(D(7) * lean)
    Tr = V((0.0, -STALK * go, -0.012 * lean))
    feet = {}
    for s, (t0, t1) in (('_R', (0.9, 2.5)), ('_L', (2.6, 4.2))):
        u = min(max((t - t0) / (t1 - t0), 0.0), 1.0)
        e = u * u * (3 - 2 * u)
        lift = math.sin(math.pi * u)
        f = FEET[s] + V((0.0, -STALK * e, 0.075 * lift))
        feet[s] = (f, D(55) * lift)
    return Q, Tr, feet


def preen_pose(t):
    """5 s: the head down to the breast, nibbling at the left side then the right, back up"""
    Q = {b: Quaternion() for b in BONES}
    dip = keys(t, [(0, 0), (1.1, 1), (3.7, 1), (5.0, 0)])
    side = keys(t, [(0, 0), (1.1, 1), (2.2, 1), (2.6, -1), (3.6, -1), (4.2, 0), (5, 0)])
    nib = math.sin(math.tau * 2.2 * t) * sstep(1.0, 1.3, t) * sstep(3.7, 3.4, t)
    Q['neck1'] = rx(D(PREEN[0]) * dip) @ rz(D(10) * side * dip)
    Q['neck2'] = rx(D(PREEN[1]) * dip)
    Q['neck3'] = rx(D(PREEN[2]) * dip) @ rz(D(25) * side * dip)
    Q['head'] = rx(D(PREEN[3]) * dip + D(6) * nib) @ rz(D(20) * side * dip + D(5) * nib)
    Q['body'] = rx(D(4) * dip)
    return Q, Tr0(), {s: (FEET[s], 0.0) for s in FEET}


def Tr0():
    return V((0.0, 0.0, 0.0))


PREEN = None   # neck1, neck2, neck3, head pitch (deg) with the bill in the breast's plumes: fit_preen sets it


def fk_tip(rest, Q, Tr):
    """the bill's tip with the pose Q (rotations per bone in the armature's axes, relative to the parent)"""
    Wq = {}
    pos = {}
    for b in BONES:
        p = PARENT[b]
        if p is None:
            Wq[b] = Q[b]
            pos[b] = rest.h[b] + Tr
        else:
            Wq[b] = Wq[p] @ Q[b]
            pos[b] = pos[p] + Wq[p] @ (rest.h[b] - rest.h[p])
    return pos['head'] + Wq['head'] @ (V(BILL[1]) - rest.h['head']), Wq['head'] @ V((0, -1, 0))


def fit_preen(rest):
    """the neck's bend that puts the bill's tip on the plumes over the breast, pointing down and back, with the least
    bending: a coarse search, then a finer one round its best"""
    goal = V((0.0, -0.135, 0.655))

    def cost(a):
        Q = {n: Quaternion() for n in BONES}
        Q['body'] = rx(D(4))
        Q['neck1'], Q['neck2'], Q['neck3'], Q['head'] = rx(D(a[0])), rx(D(a[1])), rx(D(a[2])), rx(D(a[3]))
        tip, fwd = fk_tip(rest, Q, Tr0())
        return (tip - goal).length ** 2 * 3000 + 0.2 * (1 - max(0, -fwd.z)) + 1e-5 * sum(x * x for x in a)
    best, arg = 1e9, None
    for a in range(0, 91, 10):
        for b in range(-90, 61, 10):
            for c in range(-30, 91, 10):
                for d in range(0, 121, 15):
                    q = cost((a, b, c, d))
                    if q < best:
                        best, arg = q, (a, b, c, d)
    a0 = arg
    for a in range(-8, 9, 2):
        for b in range(-8, 9, 2):
            for c in range(-8, 9, 2):
                for d in range(-12, 13, 4):
                    x = (a0[0] + a, a0[1] + b, a0[2] + c, a0[3] + d)
                    q = cost(x)
                    if q < best:
                        best, arg = q, x
    print('preen bend', arg, 'cost', round(best, 4), flush=True)
    return list(arg)


CLIPS = {'idle': (idle_pose, 10.0), 'stalk': (stalk_pose, 6.0), 'preen': (preen_pose, 5.0)}


def key_clips(rig):
    global PREEN
    rest = Rest(rig)
    PREEN = fit_preen(rest)
    rig.animation_data_create()
    for b in rig.pose.bones:
        b.rotation_mode = 'QUATERNION'
    for name, (pose, dur) in CLIPS.items():
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        prev = {}
        n = int(round(dur * FPS))
        for f in range(n + 1):
            Q, Tr, feet = pose(f / FPS)
            for s, (A, toe) in feet.items():
                leg_ik(rest, Q, Tr, s, A, toe)
            for b in BONES:
                r = rest.r[b]
                q = r.inverted() @ Q[b] @ r
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q
                pb = rig.pose.bones[b]
                pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f, group=b)
            pb = rig.pose.bones['body']
            pb.location = rest.r['body'].inverted() @ Tr
            pb.keyframe_insert('location', frame=f, group='body')
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
        print(f'{name}: {n} frames', flush=True)
    for b in rig.pose.bones:
        b.rotation_quaternion = Quaternion()
        b.location = V()


BUDGET = {
    'heron': dict(plumage=6200, bill=420, leg=440, far=1500),
    'egret': dict(plumage=3200, bill=200, leg=260, far=900),
}


def main(out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    models = {}
    for kind in ('heron', 'egret'):
        m = join(build(kind, BUDGET[kind]))
        bake_ao(m)
        models[kind] = m
        models[kind + '_far'] = far_model(kind + '_far', m, BUDGET[kind]['far'])
    rig = make_rig()
    for name, m in models.items():
        bind(rig, name, m)
    key_clips(rig)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_normals=True, export_yup=True, export_skins=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_step=2, export_optimize_animation_size=False)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
