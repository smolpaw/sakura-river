# The river's spot-billed ducks (karugamo, Anas zonorhyncha), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/duck.py -- <out.glb>
# A duck of about 0.57 m from the bill's tip to the tail's, afloat: the waterline is z = 0, a third of the body under
# it. The body is a full-breasted boat rising at the stern to the pointed tail; the neck short and thick, the head
# rounded with a steep forehead into the broad flat bill. Blender: z up, facing -y, the bird's left at +x (glTF: y up,
# facing +z).
# The plumage (body, neck, head, tail), the folded wings and the feet are signed distance fields (numpy) meshed by
# surface nets and decimated to a budget, with the meshing helpers of tools/human.py; the spread wings are thin
# cambered sheets built directly. Colours are painted per vertex (the dark brown body and back, the buff head and neck,
# the white-edged tertials and the blue speculum on the folded wing, the black bill's yellow tip, the orange feet; the
# spread wing's brown coverts, blue speculum between white bars and white underwing), then ambient occlusion darkens
# them. Alpha says what the page (src/ducks.js) draws over them: 1 the body's plumage (its pale feather edges, and on
# the head the dark crown, the eye stripe, the cheek stripe and the eye), 0.5 the wings' feathers (their edges), 0
# the bill and the feet.
# The wings have two forms: folded on the back (bone `fold_*`) and spread (`arm_*`, `hand_*`, modelled level). A clip
# shows one and shrinks the other to HIDE into the body: the folded wings on the water, the spread ones in flight and
# as the duck rises to flap. Every clip keys both, so the page's blend of clips (weights summing to 1) never shows the
# spread wings' bind pose.
# Meshes, skinned to one armature (`duck_rig`): `duck` (~6k triangles), `duck_far` (~1.1k).
# Clips (in place), keyed from poses computed here, linear between the keys at 30 fps: `float` (10 s loop: breathing
# and rocking on the water, the head turning to look about, a quick wag of the tail), `paddle` (1 s loop of the feet
# alone, the left and right in turn, the web feathered on the way forward: the page weights it by the speed), `fly`
# (one wing beat, slowed to 1 s so it is sampled finely: the page plays it at the beat's rate; neck stretched out,
# feet tucked back), `dabble` (5 s: up-ending, head under and tail up, the feet paddling to stay down), `preen` (6 s:
# the bill into the folded wing on one side, then the other), `doze` (6 s loop: the head laid back on the shoulders,
# the bill tucked in), `flap` (4 s: rising on the water to beat the wings four times, then settling with a wag and a
# shake of the head). Each one-shot begins and ends in the float's rest pose.
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, Quaternion
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from human import srgb, sstep, sphere, capsule, smin, smax, surface_nets, to_mesh, decimate, positions, vertex_normals, top4
from heron import frame, ell, catmull, keys, rx, ry, rz, make_mesh, far_model

V = Vector
D = math.radians
FPS = 30
HIDE = 0.01   # a hidden wing form's scale (not 0: its normals stay finite)


# ---------- fields ----------
def parts(p):
    """the plumage's components (each a field)"""
    d = {}
    d['torso'] = ell(p, (0, 0.03, 0.035), (0.098, 0.195, 0.068), frame((0, 0.995, 0.1)))
    d['breast'] = ell(p, (0, -0.095, 0.05), (0.082, 0.1, 0.074))
    d['stern'] = ell(p, (0, 0.17, 0.068), (0.052, 0.09, 0.038), frame((0, 0.95, 0.31)))
    d['tail'] = ell(p, (0, 0.237, 0.088), (0.04, 0.058, 0.01), frame((0, 0.96, 0.28)))
    d['neck'] = capsule(p, (0, -0.118, 0.07), (0, -0.148, 0.172), 0.046, 0.03)
    hd = ell(p, (0, -0.166, 0.199), (0.031, 0.049, 0.035), frame((0, -1, 0.12)))
    hd = smin(hd, ell(p, (0, -0.19, 0.19), (0.026, 0.03, 0.026)), 0.012)   # the cheeks, full towards the bill
    d['head'] = hd
    return d


def plumage_sdf(p):
    d = parts(p)
    f = smin(d['torso'], d['breast'], 0.04)
    f = smin(f, d['stern'], 0.03)
    f = smin(f, d['tail'], 0.015)
    f = smin(f, d['neck'], 0.03)
    return smin(f, d['head'], 0.02)


FOLD_C = (0.058, 0.07, 0.083)                     # the left folded wing's centre
FOLD_R = (0.02, 0.165, 0.027)
FOLD_F = frame((-0.1, 0.99, 0.09))               # along it towards the tail, the tips converging over it


def fold_sdf(p):
    """the left folded wing: a long flattened lens along the side of the back"""
    return ell(p, FOLD_C, FOLD_R, FOLD_F)


BILL = ((0, -0.205, 0.196), (0, -0.266, 0.181))   # the bill's base and tip


def bill_sdf(p):
    """broad and flat, its sides nearly parallel, the tip rounded, the culmen dipping a little"""
    x, y, z = p
    a, b = BILL
    t = np.clip((y - a[1]) / (b[1] - a[1]), 0.0, 1.0)
    zc = a[2] + (b[2] - a[2]) * t - 0.002 * np.sin(math.pi * t)
    h = 0.0115 * (1 - t) ** 0.9 + 0.0035                 # half height
    w = (0.0115 + 0.0015 * t) * np.sqrt(np.clip(1 - ((t - 0.8) / 0.2).clip(0, None) ** 2, 0.04, 1))  # half width
    q = np.sqrt((x / w) ** 2 + ((z - zc) / h) ** 2)
    return np.maximum((q - 1.0) * np.minimum(w, h), np.maximum(y - (a[1] + 0.014), b[1] - y))


ANKLE = (0.05, 0.085, -0.072)


def foot_sdf(p):
    """the left foot: the tarsus down from the belly, three toes forward and the web between them"""
    f = capsule(p, (0.045, 0.07, -0.01), ANKLE, 0.0075, 0.0058)
    tips = []
    for ang, ln in ((-0.38, 0.05), (0.0, 0.058), (0.38, 0.048)):
        tip = (ANKLE[0] + math.sin(ang) * ln, ANKLE[1] - math.cos(ang) * ln, ANKLE[2] - 0.004)
        tips.append(tip)
        f = smin(f, capsule(p, ANKLE, tip, 0.004, 0.0022), 0.003)
    # the web: a thin fan between the outer toes
    web = ell(p, (ANKLE[0], ANKLE[1] - 0.03, ANKLE[2] - 0.003), (0.024, 0.032, 0.0018))
    web = smax(web, (p[1] - ANKLE[1]) - 0.0 + 0.004, 0.004)
    return smin(f, web, 0.003)


# ---------- the spread wing (left; built directly) ----------
# stations from the root out: [x, leading edge y, trailing edge y, thickness]; the wrist at about WRIST
SPREAD = [(0.04, -0.072, 0.074, 0.03), (0.12, -0.08, 0.08, 0.02), (0.2, -0.078, 0.068, 0.013), (0.27, -0.066, 0.058, 0.009),
          (0.34, -0.046, 0.052, 0.006), (0.40, -0.02, 0.044, 0.004), (0.445, 0.01, 0.034, 0.003), (0.462, 0.03, 0.03, 0.002)]
WRIST = 0.2
WING_Z = 0.1


def spread_wing():
    """the left wing, spread level: a cambered sheet, thick at the leading edge, closed round it; returns P, T and
    per vertex (span x, chord v 0 front .. 1 back, top 1 / bottom 0)"""
    st = catmull([s for s in SPREAD], 3)
    NV = 12
    P, S = [], []
    for x, yl, yt, th in st:
        for top in (1, 0):
            for j in range(NV + 1):
                v = j / NV    # the same chord stations top and bottom, met at the edges
                y = yl + (yt - yl) * v
                bulge = math.sin(math.pi * v) * (1 - v) ** 0.5
                z = WING_Z + th * (0.65 if top else -0.3) * bulge
                P.append((x, y, z))
                S.append((x, v, top))
    P, S = np.array(P), np.array(S)
    ring, o = 2 * (NV + 1), NV + 1
    T = []
    for i in range(len(st) - 1):
        a, b = i * ring, (i + 1) * ring
        for j in range(NV):
            # the top facing up, the bottom down
            T += [(a + j, b + j, a + j + 1), (a + j + 1, b + j, b + j + 1)]
            T += [(a + o + j, a + o + j + 1, b + o + j), (a + o + j + 1, b + o + j + 1, b + o + j)]
    T = np.array(T)
    # weld the top and bottom along the leading and trailing edges
    remap = np.arange(len(P))
    for i in range(len(st)):
        base = i * ring
        remap[base + NV + 1] = base           # leading edge
        remap[base + 2 * NV + 1] = base + NV  # trailing edge
    T = remap[T]
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]
    return P, T, S


# ---------- colours (linear) ----------
BROWN = srgb('#46331f')      # the flanks
BACK = srgb('#33261a')       # the back, the rump
BREAST = srgb('#5a4430')
BELLY = srgb('#4b3a29')
TAILC = srgb('#1d1610')
BUFF = srgb('#d5c6a3')       # the face and the throat
NECKC = srgb('#b8a582')
WING = srgb('#3e2e21')       # the folded wing, the coverts
PRIM = srgb('#261d16')       # the primaries
TERT = srgb('#e2ddd0')       # the tertials' white edges
SPEC = srgb('#2a3f97')       # the speculum
SPEC_W = srgb('#e9e6de')     # its white bars
UNDER = srgb('#e6e3dc')      # the underwing's coverts
UNDER_F = srgb('#9c9893')    # its flight feathers from below
BILL_C = srgb('#1c1b1a')
BILL_T = srgb('#e2b726')
FOOT_C = srgb('#e0662a')


def soft_pick(dists, k=0.006):
    D_ = np.stack(dists)
    w = np.exp(-(D_ - D_.min(0)) / k)
    return w / w.sum(0)


def plumage_colour(P):
    p = (P[:, 0], P[:, 1], P[:, 2])
    x, y, z = p
    d = parts(p)
    names = ['torso', 'breast', 'stern', 'tail', 'neck', 'head']
    W = soft_pick([d[n] for n in names])
    n = len(P)
    # the body: darker over the back, warmer on the breast
    body = np.tile(BROWN, (n, 1))
    body = body + (BREAST - body) * (sstep(-0.05, -0.15, y) * sstep(0.0, 0.05, z))[:, None]
    body = body + (BELLY - body) * sstep(0.01, -0.02, z)[:, None]
    body = body + (BACK - body) * (sstep(0.075, 0.1, z) * sstep(0.05, 0.02, np.abs(x)))[:, None]
    stern = np.tile(BACK, (n, 1)) + (TAILC - BACK) * sstep(0.15, 0.22, y)[:, None]
    tail = np.tile(TAILC, (n, 1))
    # the neck: buff at the throat, browner down towards the breast and up the back of the neck
    neck = np.tile(NECKC, (n, 1)) + (BUFF - NECKC) * sstep(0.1, 0.16, z)[:, None]
    neck = neck + (BREAST - neck) * sstep(0.1, 0.075, z)[:, None]
    head = np.tile(BUFF, (n, 1))
    C = sum(W[i][:, None] * c for i, c in enumerate([body, body, stern, tail, neck, head]))
    return C, np.ones(n)


def fold_colour(P):
    """the folded wing: brown; the tertials' white edges along its lower rear edge, a little of the blue speculum
    under them, the primaries dark at the tip"""
    q = (P - np.array(FOLD_C)) * np.array([1.0, 1.0, 1.0])
    q = q @ FOLD_F.T
    along = q[:, 1] / FOLD_R[1]      # -1 front .. 1 tip
    up = q[:, 2] / FOLD_R[2]         # -1 lower edge .. 1 top
    out = q[:, 0] / FOLD_R[0]        # -1 in .. 1 out
    C = np.tile(WING, (len(P), 1))
    C = C + (PRIM - C) * sstep(0.55, 0.8, along)[:, None]
    tert = sstep(0.0, 0.12, along) * sstep(0.62, 0.5, along) * sstep(0.35, 0.1, up) * sstep(-0.3, 0.1, out)
    C = C + (TERT - C) * tert[:, None]
    spec = sstep(-0.35, -0.2, along) * sstep(0.1, 0.0, along) * sstep(-0.1, -0.35, up) * sstep(0.0, 0.4, out)
    C = C + (SPEC - C) * spec[:, None]
    return C, np.full(len(P), 0.5)


def spread_colour(S):
    x, v, top = S[:, 0], S[:, 1], S[:, 2]
    n = len(S)
    prim = sstep(WRIST - 0.02, WRIST + 0.03, x)
    # above: brown coverts; on the secondaries the speculum between two white bars, a white trailing edge; the
    # primaries dark
    up = np.tile(WING, (n, 1))
    feathers = sstep(0.38, 0.46, v)
    spec = feathers * (1 - prim) * sstep(0.03, 0.06, x)
    up = up + (SPEC - up) * spec[:, None]
    bar1 = sstep(0.36, 0.4, v) * sstep(0.46, 0.42, v) * (1 - prim) * sstep(0.03, 0.06, x)
    bar2 = sstep(0.9, 0.95, v) * (1 - prim) * sstep(0.03, 0.06, x)
    up = up + (SPEC_W - up) * np.maximum(bar1, bar2)[:, None]
    up = up + (PRIM - up) * (prim * feathers)[:, None]
    up = up + (PRIM * 1.15 - up) * (prim * (1 - feathers) * 0.6)[:, None]
    # below: white coverts, the flight feathers grey
    lo = np.tile(UNDER, (n, 1)) + (UNDER_F - UNDER) * sstep(0.4, 0.55, v)[:, None]
    lo = lo + (UNDER_F * 0.8 - lo) * (prim * sstep(0.3, 0.5, v))[:, None]
    C = np.where(top[:, None] > 0.5, up, lo)
    return C, np.full(n, 0.5)


def bill_colour(P):
    t = np.clip((P[:, 1] - BILL[0][1]) / (BILL[1][1] - BILL[0][1]), 0, 1)
    C = BILL_C + (BILL_T - BILL_C) * sstep(0.62, 0.72, t)[:, None]
    # the nail: dark, on the tip's top
    nail = sstep(0.9, 0.95, t) * sstep(BILL[1][2] - 0.001, BILL[1][2] + 0.002, P[:, 2])
    C = C + (BILL_C * 1.5 - C) * nail[:, None]
    return C, np.zeros(len(P))


def foot_colour(P):
    return np.tile(FOOT_C, (len(P), 1)), np.zeros(len(P))


# ---------- skeleton ----------
J = {
    'body': ((0, 0.04, 0.03), (0, -0.09, 0.05)),
    'tail': ((0, 0.15, 0.068), (0, 0.28, 0.09)),
    'neck1': ((0, -0.118, 0.08), (0, -0.135, 0.13)),
    'neck2': ((0, -0.135, 0.13), (0, -0.15, 0.18)),
    'head': ((0, -0.15, 0.18), BILL[1]),
    'fold_L': ((0.04, -0.03, 0.07), (0.05, 0.22, 0.095)),
    'arm_L': ((0.035, -0.055, WING_Z), (WRIST, -0.07, WING_Z)),
    'hand_L': ((WRIST, -0.07, WING_Z), (0.46, 0.03, WING_Z)),
    'leg_L': ((0.045, 0.07, 0.0), ANKLE),
    'foot_L': (ANKLE, (0.05, 0.03, -0.076)),
}
for b in [k for k in J if k.endswith('_L')]:
    a, c = J[b]
    J[b[:-2] + '_R'] = ((-a[0], a[1], a[2]), (-c[0], c[1], c[2]))
BONES = ['body', 'tail', 'neck1', 'neck2', 'head', 'fold_L', 'arm_L', 'hand_L', 'leg_L', 'foot_L',
         'fold_R', 'arm_R', 'hand_R', 'leg_R', 'foot_R']
PARENT = {'body': None, 'tail': 'body', 'neck1': 'body', 'neck2': 'neck1', 'head': 'neck2'}
for s in ('_L', '_R'):
    PARENT.update({'fold' + s: 'body', 'arm' + s: 'body', 'hand' + s: 'arm' + s, 'leg' + s: 'body', 'foot' + s: 'leg' + s})


def chain_weights(P):
    """the plumage: along the spine (the tail's tip, the body, up the neck to the bill), each vertex by the nearest
    point on it, blended across the joints"""
    line = np.array([(0, 0.28, 0.09), (0, 0.15, 0.068), (0, 0.03, 0.035), (0, -0.09, 0.05), (0, -0.118, 0.075),
                     (0, -0.135, 0.13), (0, -0.15, 0.18), (0, -0.168, 0.198), BILL[0]])
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
    # joints (arc length from the tail's tip): tail | body at the tail's root, body | neck1 a little up the neck,
    # then the neck's bones' heads; each blended over twice its width
    joints = [(s0[1] + 0.01, 0.03), (s0[4] + 0.012, 0.02), (s0[5], 0.015), (s0[6], 0.012)]
    names = ['tail', 'body', 'neck1', 'neck2', 'head']
    past = [np.ones(len(P))] + [sstep(j - w, j + w, u) for j, w in joints] + [np.zeros(len(P))]  # beyond each joint
    return {n: past[i] - past[i + 1] for i, n in enumerate(names)}


# ---------- assembly ----------
class Part:
    def __init__(self, P, T, colour, weights, ao=True, reach=0.06):
        self.P, self.T = P, T
        self.col, self.alpha = colour
        self.W = np.zeros((len(P), len(BONES)))
        for b, w in weights.items():
            self.W[:, BONES.index(b)] += w
        self.ao = np.full(len(P), ao)
        self.reach = np.full(len(P), reach)

    def mirrored(self):
        o = Part.__new__(Part)
        o.P = self.P * np.array([-1.0, 1.0, 1.0])
        o.T = self.T[:, ::-1].copy()
        o.col, o.alpha, o.ao, o.reach = self.col, self.alpha, self.ao, self.reach
        o.W = np.zeros_like(self.W)
        for j, b in enumerate(BONES):
            m = b[:-2] + ('_R' if b.endswith('_L') else '_L') if b[-2:] in ('_L', '_R') else b
            o.W[:, BONES.index(m)] = self.W[:, j]
        return o


def arrays(me):
    me.calc_loop_triangles()
    P = positions(me)
    T = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get('vertices', T)
    bpy.data.meshes.remove(me)
    return P, T.reshape(-1, 3)


def sdf_mesh(name, fn, lo, hi, h, target, protect=None):
    verts, quads = surface_nets(fn, lo, hi, h)
    me = to_mesh(name, verts, quads)
    print(f'{name}: {len(quads) * 2} triangles meshed', flush=True)
    return arrays(decimate(me, target, protect))


def build(budget):
    out = []
    P, T = sdf_mesh('duck', plumage_sdf, (-0.11, -0.22, -0.045), (0.11, 0.3, 0.24), 0.0022, budget['plumage'])
    out.append(Part(P, T, plumage_colour(P), chain_weights(P), reach=0.07))
    P, T = sdf_mesh('duck_fold', fold_sdf, (0.02, -0.12, 0.03), (0.11, 0.24, 0.125), 0.002, budget['fold'])
    fold = Part(P, T, fold_colour(P), {'fold_L': np.ones(len(P))}, reach=0.04)
    out += [fold, fold.mirrored()]
    P, T = sdf_mesh('duck_bill', bill_sdf, (-0.016, -0.272, 0.172), (0.016, -0.2, 0.212), 0.0008, budget['bill'])
    out.append(Part(P, T, bill_colour(P), {'head': np.ones(len(P))}, reach=0.02))
    P, T = sdf_mesh('duck_foot', foot_sdf, (0.015, 0.02, -0.085), (0.085, 0.09, 0.0), 0.0012, budget['foot'])
    k = sstep(ANKLE[1] - 0.002, ANKLE[1] - 0.012, P[:, 1]) * sstep(-0.058, -0.068, P[:, 2])  # the toes and the web
    foot = Part(P, T, foot_colour(P), {'leg_L': 1 - k, 'foot_L': k}, reach=0.02)
    out += [foot, foot.mirrored()]
    P, T, S = spread_wing()
    h = sstep(WRIST - 0.03, WRIST + 0.03, P[:, 0])
    wing = Part(P, T, spread_colour(S), {'arm_L': 1 - h, 'hand_L': h}, ao=False)
    out += [wing, wing.mirrored()]
    return out


def join(parts):
    n = 0
    acc = {k: [] for k in 'PTCAWRO'}
    for p in parts:
        acc['P'].append(p.P); acc['T'].append(p.T + n); acc['C'].append(p.col); acc['A'].append(p.alpha)
        acc['W'].append(p.W); acc['R'].append(p.reach); acc['O'].append(p.ao)
        n += len(p.P)
    return {k: np.concatenate(v) for k, v in acc.items()}


AO_DIRS = []
for i in range(32):  # cosine-weighted hemisphere about the normal (Fibonacci spiral)
    r = math.sqrt((i + 0.5) / 32)
    a = i * 2.399963
    AO_DIRS.append((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r))))


def bake_ao(m):
    """occlusion by ray casting over the duck as it floats (the spread wings neither cast nor take it: on the water
    they are hidden), blurred over the triangles, into the colours"""
    P, T, O = m['P'], m['T'], m['O']
    N = vertex_normals(P, T)
    solid = O[T].all(1)
    bvh = BVHTree.FromPolygons(P.tolist(), T[solid].tolist())
    ao = np.ones(len(P))
    for i in np.nonzero(O)[0]:
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
    ao = np.where(O, ao, 1.0)
    up = 0.5 + 0.5 * N[:, 2]
    m['C'] = m['C'] * ((0.5 + 0.5 * ao) * np.where(O, 0.86 + 0.14 * up, 1.0))[:, None]


def make_rig():
    arm = bpy.data.armatures.new('duck_rig')
    rig = bpy.data.objects.new('duck_rig', arm)
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


# ---------- poses ----------
# A pose: Q (each bone's rotation in the armature's axes, relative to its parent), Tr (the body's offset), S (the
# wing forms' scales, or None: not keyed). Mirror: the right side's rotation of a left one.
class Rest:
    def __init__(self, rig):
        self.h, self.r = {}, {}
        for b in rig.data.bones:
            self.h[b.name] = b.head_local.copy()
            self.r[b.name] = b.matrix_local.to_quaternion()


def ident():
    return {b: Quaternion() for b in BONES}


def mirror(q):
    """the rotation mirrored across the bird's middle (x -> -x)"""
    return Quaternion((q.w, q.x, -q.y, -q.z))


def folded():
    return {'fold_L': 1.0, 'fold_R': 1.0, 'arm_L': HIDE, 'arm_R': HIDE}


def spread(k):
    """the wings' forms a share k of the way from folded to spread"""
    a, f = HIDE + (1 - HIDE) * k, 1 - (1 - HIDE) * k
    return {'fold_L': f, 'fold_R': f, 'arm_L': a, 'arm_R': a}


def wings(Q, up, hand, sweep=0.0):
    """the spread wings raised by `up` (rad) at the shoulder, the hand by `hand` more, swept forward by `sweep`"""
    Q['arm_L'] = ry(-up) @ rz(-sweep)
    Q['hand_L'] = ry(-hand)
    Q['arm_R'] = mirror(Q['arm_L'])
    Q['hand_R'] = mirror(Q['hand_L'])


def look(Q, yaw, pitch=0.0):
    """the head turned by yaw (deg, to the left), pitched down by pitch, spread over the neck"""
    Q['neck1'] = Q['neck1'] @ rz(D(yaw * 0.2))
    Q['neck2'] = Q['neck2'] @ rz(D(yaw * 0.35)) @ rx(D(pitch * 0.3))
    Q['head'] = Q['head'] @ rz(D(yaw * 0.45)) @ rx(D(pitch * 0.7))


def wag(t, t0, dur=0.6, hz=6.0, amp=20.0):
    """a quick wag of the tail from t0 (deg)"""
    u = (t - t0) / dur
    if u <= 0 or u >= 1:
        return 0.0
    return amp * math.sin(math.tau * hz * dur * u) * math.sin(math.pi * u)


def float_pose(t):
    """10 s: breathing and rocking on the water, the head turning to look about and down at the water, a wag"""
    Q = ident()
    w = math.tau * t / 10.0
    breath = math.sin(3 * w)
    Q['body'] = rx(D(1.2) * math.sin(w)) @ ry(D(1.8) * math.sin(2 * w + 1.0))
    Tr = V((0.0, 0.0, 0.002 * breath))
    yaw = keys(t, [(0, 0), (1.4, 0), (2.2, 38), (3.9, 38), (4.7, -8), (5.8, -8), (6.6, -42), (8.3, -42), (9.2, 0), (10, 0)])
    down = keys(t, [(0, 0), (4.7, 0), (5.2, 18), (5.8, 18), (6.4, 0), (10, 0)])
    look(Q, yaw, down)
    Q['neck2'] = Q['neck2'] @ rx(D(2.5) * math.sin(2 * w))
    Q['tail'] = rz(D(wag(t, 7.0)))
    return Q, Tr, folded()


def paddle_pose(t):
    """1 s: the feet in turn, a stroke back with the web spread, forward again with it feathered"""
    Q = ident()
    for s, ph in (('_L', 0.0), ('_R', 0.5)):
        u = (t + ph) % 1.0
        swing = -30 + 72 * sstep(0.0, 0.45, u) - 72 * sstep(0.5, 1.0, u)
        back = math.sin(math.pi * min(1.0, max(0.0, (u - 0.45) / 0.55)))
        Q['leg' + s] = rx(D(swing))
        roll = D(65) * back
        Q['foot' + s] = rx(-D(25) * (1 - back)) @ ry(roll if s == '_L' else -roll)
    return Q, V(), None


def fly_pose(t):
    """one beat in 1 s (the page plays it at the beat's rate): the downstroke a little quicker than the up, the hand
    lagging the arm; the neck stretched out, the head level, the feet tucked back under the tail"""
    Q = ident()
    u = t % 1.0
    ph = math.tau * u
    up = 0.1 + 0.7 * math.cos(ph + 0.25 * math.sin(ph))
    hand = 0.05 + 0.35 * math.cos(ph - 0.75)
    wings(Q, up, hand, sweep=0.12 * math.sin(ph))
    Q['body'] = rx(D(2) * math.cos(ph))
    Q['neck1'] = rx(D(55))
    Q['neck2'] = rx(D(32))
    Q['head'] = rx(-D(85) - D(2) * math.cos(ph))
    for s in ('_L', '_R'):
        Q['leg' + s] = rx(D(80))
        Q['foot' + s] = rx(D(100))
    Q['tail'] = rx(-D(4))
    return Q, V(), spread(1.0)


def kicks(Q, t, k, hz=2.4, amp=35):
    for s, ph in (('_L', 0.0), ('_R', math.pi)):
        Q['leg' + s] = Q['leg' + s] @ rx(D(amp) * k * math.sin(math.tau * hz * t + ph))
        Q['foot' + s] = Q['foot' + s] @ rx(-D(20) * k)


def dabble_pose(t):
    """5 s: up-ending, the head and breast under, the tail up, the feet paddling to stay down; back up"""
    Q = ident()
    tip = keys(t, [(0, 0), (0.7, 1), (3.9, 1), (4.7, 0), (5, 0)])
    hold = sstep(0.5, 0.9, t) * sstep(4.1, 3.7, t)
    Q['body'] = rx(D(102) * tip + D(5) * hold * math.sin(math.tau * 0.7 * t))
    Tr = V((0.0, -0.035 * tip, -0.025 * tip))
    Q['neck1'] = rx(D(38) * tip)
    Q['neck2'] = rx(D(22) * tip)
    Q['head'] = rx(D(10) * tip + D(8) * hold * math.sin(math.tau * 1.3 * t))
    Q['tail'] = rx(-D(18) * tip) @ rz(D(wag(t, 4.35, amp=16)))
    kicks(Q, t, hold)
    return Q, Tr, folded()


PREEN = None   # neck1, neck2, head: (yaw, pitch) each, with the bill in the left folded wing (fit_neck sets it)
DOZE = None    # the same with the head laid back on the shoulders, the bill tucked in


def neck_pose(Q, a, k=1.0, side=1):
    """the neck's bend a (deg: neck1 yaw, pitch, neck2 yaw, pitch, head yaw, pitch) a share k of the way, to the left
    (side 1) or right"""
    Q['neck1'] = Q['neck1'] @ rz(D(a[0] * k * side)) @ rx(D(a[1] * k))
    Q['neck2'] = Q['neck2'] @ rz(D(a[2] * k * side)) @ rx(D(a[3] * k))
    Q['head'] = Q['head'] @ rz(D(a[4] * k * side)) @ rx(D(a[5] * k))


def preen_pose(t):
    """6 s: the bill into the left folded wing, nibbling along it, over to the right, back up"""
    Q = ident()
    side = keys(t, [(0, 0), (1.0, 1), (2.6, 1), (3.1, 0), (3.6, -1), (5.2, -1), (6, 0)])
    k = abs(side)
    neck_pose(Q, PREEN, k, 1 if side >= 0 else -1)
    nib = math.sin(math.tau * 2.6 * t) * sstep(0.9, 1.2, k)
    Q['head'] = Q['head'] @ rx(D(7) * nib) @ rz(D(5) * nib)
    Q['body'] = ry(D(4) * side)
    Q['tail'] = rz(D(wag(t, 5.3, amp=14)))
    return Q, V(), folded()


def doze_pose(t):
    """6 s: the head laid back on the shoulders, the bill tucked into the back's feathers; breathing"""
    Q = ident()
    w = math.tau * t / 6.0
    neck_pose(Q, DOZE)
    Q['body'] = rx(D(1.0) * math.sin(w)) @ ry(D(1.2) * math.sin(2 * w))
    Q['head'] = Q['head'] @ rx(D(1.5) * math.sin(2 * w))
    return Q, V((0.0, 0.0, 0.0015 * math.sin(2 * w))), folded()


def flap_pose(t):
    """4 s: rising up on the water onto the tail, the wings opened and beaten four times, settling, a wag and a shake
    of the head"""
    Q = ident()
    rise = keys(t, [(0, 0), (0.5, 1), (2.4, 1), (3.0, 0), (4, 0)])
    open_ = keys(t, [(0, 0), (0.32, 0), (0.55, 1), (2.35, 1), (2.65, 0), (4, 0)])
    Q['body'] = rx(-D(52) * rise)
    Tr = V((0.0, 0.02 * rise, 0.075 * rise))
    beat = sstep(0.55, 0.75, t) * sstep(2.3, 2.1, t)
    ph = math.tau * 2.3 * (t - 0.55)
    up = 0.4 * open_ + beat * 0.95 * math.cos(ph)
    hand = 0.25 * open_ + beat * 0.5 * math.cos(ph - 0.8)
    wings(Q, up, hand, sweep=0.15 * beat * math.sin(ph))
    Q['neck1'] = rx(-D(10) * rise)
    Q['neck2'] = rx(D(14) * rise)
    shake = math.sin(math.tau * 7.0 * (t - 3.1)) * sstep(3.05, 3.15, t) * sstep(3.6, 3.45, t)
    Q['head'] = rx(D(42) * rise) @ rz(D(28) * shake)
    Q['tail'] = rx(-D(10) * rise) @ rz(D(wag(t, 3.2, amp=22)))
    kicks(Q, t, rise * 0.8, hz=2.8, amp=30)
    return Q, Tr, spread(open_)


def fk(rest, Q, Tr):
    """each bone's world rotation and head with the pose Q"""
    Wq, pos = {}, {}
    for b in BONES:
        p = PARENT[b]
        if p is None:
            Wq[b] = Q[b]
            pos[b] = rest.h[b] + Tr
        else:
            Wq[b] = Wq[p] @ Q[b]
            pos[b] = pos[p] + Wq[p] @ (rest.h[b] - rest.h[p])
    return Wq, pos


def fit_neck(rest, goal, tuck):
    """the neck's bend putting the bill's tip on goal (on the left side of the back), the head clear of the body:
    random starts, then a shrinking coordinate search; tuck: the bill pointing back along the back"""
    goal = V(goal)
    head_c = V((0, -0.166, 0.199)) - rest.h['head']
    tip_r = V(BILL[1]) - rest.h['head']
    base_r = V(BILL[0]) - rest.h['head']

    def cost(a):
        Q = ident()
        neck_pose(Q, a)
        Wq, pos = fk(rest, Q, V())
        tip = pos['head'] + Wq['head'] @ tip_r
        c = pos['head'] + Wq['head'] @ head_c
        base = pos['head'] + Wq['head'] @ base_r
        # the head and the bill's base clear of the body and the folded wings
        body = lambda q: min(float(plumage_sdf_body(q)), float(fold_sdf((np.array(q[0]), np.array(q[1]), np.array(q[2])))),
                             float(fold_sdf((np.array(-q[0]), np.array(q[1]), np.array(q[2])))))
        pen = max(0.0, 0.028 - body(c)) ** 2 * 4e4 + max(0.0, 0.004 - body(base)) ** 2 * 4e4
        bill = (tip - base).normalized()
        point = (1 - bill.dot(V((0, 1, -0.2)).normalized())) * 0.002 if tuck else 0.0
        return (tip - goal).length ** 2 * 3000 + pen + point + 1e-6 * sum(x * x for x in a)
    rng = np.random.default_rng(7)
    lim = np.array([150, 60, 150, 90, 120, 90])
    best, arg = 1e9, None
    for _ in range(600):
        a = rng.uniform(-1, 1, 6) * lim
        a[0] = abs(a[0]); a[2] = abs(a[2])
        q = cost(a)
        if q < best:
            best, arg = q, a
    step = 16.0
    while step > 0.5:
        better = False
        for i in range(6):
            for sgn in (1, -1):
                a = arg.copy()
                a[i] += sgn * step
                q = cost(a)
                if q < best:
                    best, arg, better = q, a, True
        if not better:
            step *= 0.5
    print('neck bend', [round(float(x), 1) for x in arg], 'cost', round(best, 5), flush=True)
    return [float(x) for x in arg]


def plumage_sdf_body(q):
    """the body alone (no neck or head): what the head must stay out of"""
    p = (np.array(q[0]), np.array(q[1]), np.array(q[2]))
    d = parts(p)
    f = smin(smin(d['torso'], d['breast'], 0.04), d['stern'], 0.03)
    return f


CLIPS = {'float': (float_pose, 10.0), 'paddle': (paddle_pose, 1.0), 'fly': (fly_pose, 1.0), 'dabble': (dabble_pose, 5.0),
         'preen': (preen_pose, 6.0), 'doze': (doze_pose, 6.0), 'flap': (flap_pose, 4.0)}
LOOPS = ('float', 'paddle', 'fly', 'doze')


def linear(act):
    """linear between the keys (tools/blender.mjs's resample() drops the samples on a straight line)"""
    curves = list(getattr(act, 'fcurves', None) or [])
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves += list(bag.fcurves)
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def key_clips(rig):
    global PREEN, DOZE
    rest = Rest(rig)
    PREEN = fit_neck(rest, (0.072, 0.07, 0.112), False)
    DOZE = fit_neck(rest, (0.045, 0.06, 0.112), True)
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
            Q, Tr, S = pose((f % n if name in LOOPS else f) / FPS)
            for b in BONES:
                r = rest.r[b]
                q = r.inverted() @ Q[b] @ r
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q
                pb = rig.pose.bones[b]
                pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f, group=b)
            for b, s in (S or {}).items():
                pb = rig.pose.bones[b]
                pb.scale = (s, s, s)
                pb.keyframe_insert('scale', frame=f, group=b)
            pb = rig.pose.bones['body']
            pb.location = rest.r['body'].inverted() @ Tr
            pb.keyframe_insert('location', frame=f, group='body')
        linear(act)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
        print(f'{name}: {n} frames', flush=True)
    for b in rig.pose.bones:
        b.rotation_quaternion = Quaternion()
        b.location = V()
        b.scale = (1, 1, 1)


BUDGET = dict(plumage=4200, fold=420, bill=280, foot=180, far=1100)


def main(out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    m = join(build(BUDGET))
    bake_ao(m)
    far = far_model('duck_far', m, BUDGET['far'])
    rig = make_rig()
    bind(rig, 'duck', m)
    bind(rig, 'duck_far', far)
    key_clips(rig)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_normals=True, export_yup=True, export_skins=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_step=1, export_optimize_animation_size=False)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
