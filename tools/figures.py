# People at work in the landscape, built in Blender with the traveller's machinery (tools/human.py). Run through
# tools/blender.mjs:
#   blender -b --factory-startup -P tools/figures.py -- <out.glb>
# Each figure starts as the traveller's body standing (his head, hands, legs and feet, his kimono's fields), dressed
# in its own clothes, then posed into the attitude it works in by dual-quaternion skinning on his skeleton (sitting,
# bent double), which keeps the volume at the hips and knees that a plain blend of the bones would pinch. That pose is
# the rest pose of its rig: the clips move it a little from there, so the page's linear skinning only bends what moves.
# Colours and ambient occlusion are baked into the vertex colours after posing (so the lap shades the thighs), alpha
# says what the page draws over them (src/figures.js): 1 the kasuri, 0.2 the lantern's paper that glows after dusk,
# 0 nothing. Blender: z up, facing -y, the figure's left at +x (glTF: y up, facing +z).
# - The fisherman: an old man sitting on a flat stone on the river bank, his feet down the bank towards the water (the
#   ground under them on z = 0, the stone's top SEAT above it), in a grey-brown short kimono over dark momohiki and
#   gaiters, a sleeveless padded haori over it, geta, his grey hair under a sedge hat; his right hand holds a bamboo
#   rod out over the water, its line down to a red and white float on the surface (FLOAT forward of his feet, WATER
#   below them, which the page moves to where the river is), his left hand on his knee; a paper lantern hangs from a
#   bamboo stick stuck in the bank at his left (LAMP: its middle). Meshes `fisherman` (~34k triangles) and
#   `fisherman_far` (~6k), skinned to `fisherman_rig`: the traveller's 21 bones, `rod1`..`rod3` along the rod from the
#   right hand, `float` and `base` (the stone and the lantern), the last two roots of their own. Clips: `sit` (10 s
#   loop: breathing, a slow sway, the head turning a little, the rod's tip bobbing, the float riding the ripples and
#   dipping once at a nibble, NIBBLE s in) and `lift` (6 s: he raises the rod, the float swings in under its tip, he
#   catches the line in his left hand and looks at the hook, lets it go and lowers the rod, the float back on the water).
# - The rice planter: a woman bent double in a flooded paddy (her feet SINK under its water, in the mud), in an indigo
#   kasuri jacket with its sleeves held back by a red tasuki cord crossed on her back, a red-brown obi, indigo mompe
#   rolled to the knee, bare legs, a white tenugui over her hair; a bundle of rice seedlings in her left hand, a few in
#   her right fingers. Meshes `planter` (~32k) and `planter_far` (~6k), skinned to `planter_rig` (the 21 bones), the
#   traveller scaled by PLANTER_SCALE. Clips: `plant` (12 s loop: three seedlings pushed into the mud across the row in
#   front of her, PLANT_AT s in, PLANT_SPOTS where, each picked from the bundle, then a step back with each foot, the
#   body STEP back at the end: the page moves her by it as the loop comes round) and `stretch` (5 s: she straightens
#   half way up, a hand to the small of her back, looks round, bends back down).
# The clips are keyed at 30 fps and exported at 15.
import bpy, math, os, sys
import numpy as np
from mathutils import Vector, Matrix, Quaternion

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import human as H
from human import V, srgb, sstep, mix, sphere, ellipsoid, capsule, rbox, smin, smax, rx, ry, rz

BONES = H.BONES
TAU = math.tau


def ease(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def lerpv(a, b, t):
    return a + (b - a) * t


# ---------- posing: forward kinematics on the traveller's skeleton, dual-quaternion skinning ----------
def fk(Q, T, heads, bones, parent):
    """skinning matrices per bone (armature space): its move, then Q about its head, after its parent's (as Blender
    poses a bone keyed by tools/human.py key_clips)"""
    S = {}
    for b in bones:
        h = Vector(heads[b])
        m = Matrix.Translation(Vector(T.get(b, (0, 0, 0))) + h) @ Q.get(b, Quaternion()).to_matrix().to_4x4() @ Matrix.Translation(-h)
        p = parent(b)
        S[b] = S[p] @ m if p else m
    return S


def wrot(Q, b, parent):
    """a bone's rotation in the armature's axes (its own and its parents')"""
    chain = []
    while b:
        chain.append(b)
        b = parent(b)
    r = Quaternion()
    for c in reversed(chain):
        r = r @ Q.get(c, Quaternion())
    return r


def dqs(P, W, S, bones):
    """the vertices P (weights W over bones) moved by the bones' matrices S, blended as dual quaternions"""
    W = H.top4(W)
    qs = [S[b].to_quaternion().normalized() for b in bones]
    QR = np.array([[q.w, q.x, q.y, q.z] for q in qs])
    QD = []
    for b, q in zip(bones, qs):
        t = S[b].translation
        d = Quaternion((0.0, t.x, t.y, t.z)) @ q
        QD.append([0.5 * d.w, 0.5 * d.x, 0.5 * d.y, 0.5 * d.z])
    QD = np.array(QD)
    dom = W.argmax(1)
    sgn = np.where((QR[None] * QR[dom][:, None]).sum(2) < 0, -1.0, 1.0)
    Ws = W * sgn
    br, bd = Ws @ QR, Ws @ QD
    n = np.linalg.norm(br, axis=1)[:, None]
    br, bd = br / n, bd / n
    w, r = br[:, :1], br[:, 1:]
    dw, dv = bd[:, :1], bd[:, 1:]
    return P + 2 * np.cross(r, np.cross(r, P) + w * P) + 2 * (w * dv - dw * r + np.cross(r, dv))


class Canon:
    """the traveller's skeleton standing (the shape tools/human.py's Rest gives a rig), for posing"""

    def __init__(self, joints, bones):
        self.h = {b: Vector(joints[b][0]) for b in bones}
        self.d = {b: (Vector(joints[b][1]) - Vector(joints[b][0])).normalized() for b in bones}
        fit(self)


def fit(rest):
    """the leg's lengths from the skeleton itself (Rest takes them from the traveller's)"""
    rest.L1 = (rest.h['shin_L'] - rest.h['thigh_L']).length
    rest.L2 = (rest.h['foot_L'] - rest.h['shin_L']).length
    return rest


def arm_ik(rest, Q, T, s, target, pole, hand_rot, parent, bones):
    """upper arm and forearm rotations putting the wrist on target (as near as it reaches), the elbow towards pole,
    the hand turned by hand_rot from its rest (armature axes)"""
    S = fk(Q, T, rest.h, bones, parent)
    Wp = wrot(Q, 'shoulder' + s, parent)
    A = S['shoulder' + s] @ rest.h['upper_arm' + s]
    L1 = (rest.h['forearm' + s] - rest.h['upper_arm' + s]).length
    L2 = (rest.h['hand' + s] - rest.h['forearm' + s]).length
    dv = target - A
    d = min(max(dv.length, abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4)
    dr = dv.normalized()
    pp = (pole - dr * pole.dot(dr)).normalized()
    a = (L1 * L1 - L2 * L2 + d * d) / (2 * d)
    E = A + dr * a + pp * math.sqrt(max(L1 * L1 - a * a, 0.0))
    W2 = E + (target - E).normalized() * L2
    Q['upper_arm' + s] = rest.d['upper_arm' + s].rotation_difference(Wp.inverted() @ (E - A).normalized())
    Wu = Wp @ Q['upper_arm' + s]
    Q['forearm' + s] = rest.d['forearm' + s].rotation_difference(Wu.inverted() @ (W2 - E).normalized())
    Wf = Wu @ Q['forearm' + s]
    Q['hand' + s] = Wf.inverted() @ hand_rot
    return (W2 - target).length


def frame_rot(a0, b0, a1, b1):
    """the rotation taking the direction a0 onto a1 and b0 (square to a0) onto b1 (made square to a1)"""
    def basis(a, b):
        a = a.normalized()
        b = (b - a * b.dot(a)).normalized()
        return Matrix((a, b, a.cross(b))).transposed()
    return (basis(a1, b1) @ basis(a0, b0).transposed()).to_quaternion()


def hand_axes(side):
    """the hand's frame (human.py HAND): wrist, u along the fingers, v to the thumb, w to the palm; side -1 mirrors"""
    w0, u, v, w = H.HAND
    return (Vector((w0.x * side, w0.y, w0.z)), Vector((u.x * side, u.y, u.z)), Vector((v.x * side, v.y, v.z)),
            Vector((w.x * side, w.y, w.z)))


# ---------- parts: weights, mirrored copies, dictionaries ----------
def part_of(m, bones):
    """a joined dictionary back as a Part"""
    p = H.Part.__new__(H.Part)
    p.P, p.T, p.S, p.col, p.alpha, p.reach, p.W, p.bones = m['P'], m['T'], m['S'], m['C'], m['A'], m['R'], m['W'], bones
    return p


def tinted(colour, k):
    def f(P):
        out = colour(P)
        if isinstance(out, tuple):
            return out[0] * k, out[1]
        return out * k
    return f


def noise3(P, f, seed=0.0):
    """a cheap smooth noise from sines (-1..1)"""
    x, y, z = P[:, 0] * f, P[:, 1] * f, P[:, 2] * f
    return (np.sin(x * 1.7 + seed + np.sin(y * 2.3 + 1.1)) * np.sin(y * 1.3 - seed + np.sin(z * 1.9 + 2.0))
            * np.sin(z * 1.5 + 0.7 * seed + np.sin(x * 2.1 + 0.3)))


# ---------- shared pieces of the body ----------
def grip_fingers(curl, spread=1.0):
    """FINGERS with each joint's curl scaled (a fist round a rod or a bundle) and the spread narrowed"""
    out = []
    for a0, b0, sp, lens, r0, r1, c in H.FINGERS:
        out.append((a0, b0, sp * spread, lens, r0, r1, tuple(ci * k for ci, k in zip(c, curl))))
    return H.finger_joints(out)


def head_parts(bones, skin_k, hair_col):
    parts = []
    me = H.sdf_part('head', H.head_sdf, (-0.1, -0.125, 1.32), (0.1, 0.13, 1.66), 0.0017, 5500, H.head_protect)
    parts.append(H.Part(me, tinted(H.head_colour, skin_k), H.head_weights, 0.05, bones=bones))
    me = H.sdf_part('hair', H.hair_sdf, (-0.09, -0.1, 1.47), (0.09, 0.13, 1.675), 0.002, 1300)

    def hair_colour(P):
        x, z = P[:, 0], P[:, 2]
        return hair_col * (0.85 + 0.3 * (0.5 + 0.5 * np.sin(x * 900.0 + z * 300.0)))[:, None]
    parts.append(H.Part(me, hair_colour, H.head_weights, 0.04, bones=bones))
    parts.append(H.Part(H.eyes(), None, H.const_weights('head'), 0.02, smooth=None, bones=bones))
    return parts


def hand_part(bones, joints, arm=0.25, k=1.0, target=1500):
    fn = lambda p: H.hand_fields(p, joints, arm)['d']
    me = H.sdf_part('hand', fn, (0.14, -0.1, 0.6), (0.31, 0.09, 1.15), 0.0016, target)
    return H.Part(me, tinted(lambda P: H.hand_colour(P, joints, arm), k), lambda P: H.hand_weights(P, 1), 0.04, bones=bones)


# ---------- the fisherman ----------
F_BONES = BONES + ['base', 'float', 'rod1', 'rod2', 'rod3']
F_PARENT = {'base': None, 'float': None, 'rod1': 'hand_R', 'rod2': 'rod1', 'rod3': 'rod2'}


def f_parent(b):
    return F_PARENT[b] if b in F_PARENT else H.parent_of(b)


SEAT = 0.40            # the stone's top above the ground under his feet (m)
F_HEM = 0.60           # his short kimono's hem (standing)
FLOAT = 3.45           # the float: this far forward of his feet (m) ...
FLOAT_SIDE = -0.45     # ... and to his right (downstream when he faces across the river from its west bank)
WATER = -1.37          # ... on water this far below his feet; the page moves it to the river's surface
LAMP = V((0.5, 0.2, 0.47))   # the lantern's middle
NIBBLE = 6.2           # s into `sit`: the float dips
KIMONO_F = srgb('#7d6d5a')   # grey-brown cotton
KIMONO_FI = srgb('#4f453a')
VEST = srgb('#352c25')
MOMOHIKI = srgb('#262b38')
OBI_F = srgb('#3a2f27')
HAIR_GREY = srgb('#8e8a84')
SKIN_K = np.array([0.93, 0.88, 0.84])   # weathered
STONE = srgb('#8a8780')
BAMBOO = srgb('#9a8a5a')
ROD_C = srgb('#b39a62')
ROD_NODE = srgb('#6e5a34')
LINE = srgb('#d6d2c6')
PAPER = srgb('#e8dcc0')


def fisher_robe(p):
    f = H.kimono_fields(p)
    return smax(f['shell'], F_HEM - p[2], 0.003)


def fisher_robe_colour(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    f = H.kimono_fields((x, y, z))
    inner = f['outer'] < -H.T_CLOTH * 0.5
    col = np.where(inner[:, None], KIMONO_FI, KIMONO_F)
    # a fine stripe woven into it, the hem worn paler
    col = col * (0.94 + 0.06 * np.sign(np.sin(x * 260.0 + y * 40.0)))[:, None]
    col = mix(col, col * np.array([1.18, 1.12, 1.02]), 0.6 * sstep(F_HEM + 0.04, F_HEM, z))
    return col, np.zeros(len(P))


def fisher_robe_hidden(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    f = H.kimono_fields((x, y, z))
    inner = f['outer'] < -H.T_CLOTH * 0.5
    cuff = capsule((np.abs(x), y, z), (0.213, 0.027, 1.02), (0.242, -0.016, 0.72), 0.045)
    return inner & (z > F_HEM + 0.1) & (z < 1.33) & (cuff > 0.05)


def vest_field(p):
    """the sleeveless haori (sodenashi): a padded shell over the kimono's body to the hips, open down the front along
    its collar, round armholes where the sleeves come out"""
    x, y, z = p
    X = np.abs(x)
    plain, cy = H.torso_plain(p)
    outer = plain - 0.017 - 0.004 * sstep(1.25, 1.0, z) * sstep(0.0, 0.1, y - cy)   # bloused a little at the back
    shell = np.maximum(outer, -(outer + 0.01))
    shell = smax(shell, 0.83 - z, 0.004)
    hole = capsule((X, y, z), (0.215, 0.025, 1.36), (0.215, 0.025, 1.04), 0.085)
    shell = smax(shell, -hole, 0.008)
    neck = capsule(p, (0, 0.016, 1.36), (0, 0.006, 1.6), 0.078)
    shell = smax(shell, -neck, 0.004)
    # open in front: the V of the kimono's collar and on down to the hem, a hand wide
    vt = H.V_TIP[1]
    w = 0.055 + np.maximum(0.0, z - vt) * (H.V_HALF + 0.04) / (H.V_TOP - vt)
    opening = np.minimum(w - np.abs(x - H.V_TIP[0]), (cy - 0.03) - y)
    return smax(shell, opening, 0.004)


def vest_colour(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    col = np.tile(VEST, (len(P), 1)) * (0.92 + 0.1 * (0.5 + 0.5 * noise3(P, 40.0)))[:, None]
    # its edges bound in a lighter cloth
    plain, cy = H.torso_plain((x, y, z))
    vt = H.V_TIP[1]
    w = 0.055 + np.maximum(0.0, z - vt) * (H.V_HALF + 0.04) / (H.V_TOP - vt)
    edge = sstep(0.018, 0.008, np.abs(x - H.V_TIP[0]) - w) * (y < cy)
    col = mix(col, srgb('#5b4c3f'), 0.8 * edge)
    return col, np.zeros(len(P))


def fisher_leg_colour(P):
    f = H.leg_fields((P[:, 0], P[:, 1], P[:, 2]))
    z = P[:, 2]
    col = np.tile(MOMOHIKI, (len(P), 1))
    on_g = f['gaiter'] <= f['d'] + 6e-4
    col = np.where(on_g[:, None], H.KYAHAN * (0.92 + 0.16 * (0.5 + 0.5 * np.cos(z * math.tau / 0.032)))[:, None], col)
    col = np.where((f['tie'] <= f['d'] + 6e-4)[:, None], srgb('#9c927c'), col)
    tabi = (~on_g) & (z < 0.2)
    col = np.where(tabi[:, None], H.TABI * 0.92, col)
    col = np.where((tabi & (z < H.SOLE + 0.0025))[:, None], H.TABI_SOLE, col)
    return col


def fisher_body(bones):
    parts = head_parts(bones, SKIN_K, HAIR_GREY)
    # his right hand round the rod, the left open on his knee
    left = hand_part(bones, None, k=SKIN_K)
    right = hand_part(bones, grip_fingers((2.6, 2.3, 2.2), 0.6), k=SKIN_K)
    parts += [left, right.mirrored()]
    me = H.sdf_part('leg', lambda p: H.leg_fields(p)['d'], (0.0, -0.16, 0.0), (0.17, 0.1, 0.66), 0.0024, 1600)
    leg = H.Part(me, fisher_leg_colour, lambda P: H.leg_weights(P, 1), 0.12, bones=bones)
    shoe = H.Part(H.geta(), None, H.const_weights('foot_L'), 0.04, smooth=None, bones=bones)
    for p in (leg, shoe):
        parts += [p, p.mirrored()]
    me = H.sdf_part('robe', fisher_robe, (-0.3, -0.165, F_HEM - 0.01), (0.3, 0.24, 1.475), 0.0032, 8500, H.robe_protect,
                    fisher_robe_hidden)
    parts.append(H.Part(me, fisher_robe_colour, H.kimono_weights, 0.2, bones=bones))
    me = H.sdf_part('collar', H.collar_sdf, (-0.11, -0.15, 0.94), (0.11, 0.11, 1.47), 0.0024, 1000)
    parts.append(H.Part(me, H.flat(KIMONO_F * 0.6), H.kimono_weights, 0.06, bones=bones))
    me = H.sdf_part('obi', H.obi_sdf, (-0.19, -0.16, 0.86), (0.19, 0.18, 1.04), 0.0028, 900)
    parts.append(H.Part(me, H.flat(OBI_F), H.kimono_weights, 0.08, bones=bones))
    me = H.sdf_part('under', H.under_sdf, (-0.08, -0.14, 1.2), (0.08, -0.04, 1.45), 0.0022, 400)
    parts.append(H.Part(me, tinted(H.under_colour, SKIN_K), H.kimono_weights, 0.05, bones=bones))
    me = H.sdf_part('vest', vest_field, (-0.24, -0.16, 0.81), (0.24, 0.2, 1.47), 0.0032, 3200)
    parts.append(H.Part(me, vest_colour, H.torso_weights, 0.15, bones=bones))
    parts.append(H.Part(H.kasa(), None, H.const_weights('head'), 0.08, smooth=None, bones=bones))
    return parts


ROD_DIR_H = (0.55, 0.83)     # the rod's line across his right fist: along the fingers, towards the thumb
ROD_GRIP = (0.106, 0.031)    # where it passes through the fist (hand frame: along the fingers, towards the palm)


def fisher_pose(rest):
    """sitting on the stone, leaning forward a little, the rod out over the water in his right hand"""
    Q = {b: Quaternion() for b in BONES}
    Tr = V((0.0, 0.075, -0.415))
    Q['hips'] = rx(-0.14)
    Q['spine'] = rx(0.3)
    Q['chest'] = rx(0.24) @ rz(0.04)
    Q['neck'] = rx(-0.04) @ rz(-0.04)
    Q['head'] = rx(0.1) @ rz(-0.06)
    for s, side in (('_L', 1), ('_R', -1)):
        A = V((side * 0.15, H.ANKLE_Y - 0.43, H.ANKLE_Z))
        H.leg_ik(rest, Q, Tr, s, A, 0.0)
        Q['shoulder' + s] = rx(0.06) @ ry(-side * 0.04)
    T = {'hips': Tr}
    # the right hand over the knee, the rod forward, a little to his left, 27 degrees up
    rod = V((0.13, -1.0, 0.52)).normalized()
    _, u, v, w = hand_axes(-1)
    d_h = (u * ROD_DIR_H[0] + v * ROD_DIR_H[1]).normalized()
    R = frame_rot(d_h, w, rod, V((1.0, 0.0, 0.35)))
    G = V((-0.155, -0.43, 0.585))
    off = u * ROD_GRIP[0] + w * ROD_GRIP[1]
    arm_ik(rest, Q, T, '_R', G - R @ off, V((-1.0, 0.6, -0.4)), R, H.parent_of, BONES)
    # the left hand on his knee, the fingers over it
    w0, u, v, w = hand_axes(1)
    RL = frame_rot(u, w, V((0.05, -0.55, -1.0)), V((-0.35, 0.3, -1.0)))
    arm_ik(rest, Q, T, '_L', V((0.15, -0.37, 0.625)), V((1.0, 0.5, -0.3)), RL, H.parent_of, BONES)
    return Q, T, {'rod': rod, 'grip': G}


def seat_stone(bones):
    """a flat river stone bedded in the bank, its top SEAT up, under his seat"""
    c = (0.0, 0.1, SEAT - 0.3)

    def fn(p):
        x, y, z = p
        d = rbox(p, c, (0.29, 0.25, 0.3), 0.09)
        d = smax(d, z - SEAT - 0.012 * (1 - ((x / 0.3) ** 2 + ((y - 0.1) / 0.26) ** 2)), 0.05)   # a worn, slightly domed top
        P = np.stack([x, y, z], -1).reshape(-1, 3)
        return d + 0.012 * noise3(P, 9.0, 1.0).reshape(np.shape(x)) + 0.004 * noise3(P, 31.0, 2.0).reshape(np.shape(x))

    def colour(P):
        n = noise3(P, 23.0, 3.0)
        col = STONE * (0.82 + 0.18 * (0.5 + 0.5 * noise3(P, 60.0, 5.0)))[:, None]
        col = mix(col, srgb('#a9a48e'), 0.5 * sstep(0.3, 0.6, n))                               # lichen
        col = mix(col, srgb('#4c5530'), 0.7 * sstep(SEAT - 0.18, SEAT - 0.32, P[:, 2]))          # moss low down
        return col
    me = H.sdf_part('stone', fn, (-0.36, -0.2, -0.25), (0.36, 0.4, SEAT + 0.03), 0.008, 700)
    return H.Part(me, colour, H.const_weights('base'), 0.15, bones=bones)


def rod_parts(bones, G, rod, seg=8, ring=0.05):
    """the bamboo rod through his fist, its butt under his forearm, bowing down a little under its own weight and the
    line's; its three bones; the line from its tip to the float, the float on the water"""
    k = H.Kit()
    L0, L1 = 0.33, 3.32
    pts, rads, cols = [], [], []
    n = int((L0 + L1) / ring)
    side = rod.cross(V((0, 0, 1))).normalized()
    up = side.cross(rod).normalized()
    for i in range(n + 1):
        s = -L0 + (L0 + L1) * i / n
        sag = 0.035 * max(0.0, s) ** 2 / L1
        pts.append(G + rod * s - up * sag)
        t = (s + L0) / (L0 + L1)
        rads.append(0.0115 * (1 - t) + 0.0022 * t)
    rings = []
    for j, (p, r) in enumerate(zip(pts, rads)):
        node = abs(((j * ring) % 0.27) - 0.135) > 0.115
        rings.append((p, r * (1.12 if node else 1.0), ROD_NODE if node else ROD_C * (0.92 + 0.08 * math.sin(j * 1.7))))
    verts, vc, faces = [], [], []
    for j, (p, r, c) in enumerate(rings):
        t = (pts[min(j + 1, n)] - pts[max(j - 1, 0)]).normalized()
        a1 = t.cross(V((0, 0, 1))).normalized()
        a2 = a1.cross(t)
        for i in range(seg):
            a = TAU * i / seg
            verts.append(p + (a1 * math.cos(a) + a2 * math.sin(a)) * r)
            vc.append(c)
    for j in range(n):
        for i in range(seg):
            a0, a1_ = j * seg + i, j * seg + (i + 1) % seg
            faces.append((a0, a1_, a1_ + seg, a0 + seg))
    faces += [tuple(reversed(range(seg))), tuple(range(n * seg, (n + 1) * seg))]
    k.add(verts, faces, np.array(vc), smooth=True)
    tip = pts[-1]
    rodme = k.mesh('rod')
    # bones along it: rod1 to a third, rod2 to two thirds, rod3 to the tip
    marks = [G + rod * 0.0, G + rod * 1.05 - up * 0.035 * 1.05 ** 2 / L1, G + rod * 2.2 - up * 0.035 * 2.2 ** 2 / L1, tip]
    joints = {'rod1': (marks[0], marks[1]), 'rod2': (marks[1], marks[2]), 'rod3': (marks[2], marks[3])}

    def rod_w(P):
        s = (P - np.array(G)) @ np.array(rod)
        w2 = sstep(0.85, 1.25, s)
        w3 = sstep(2.0, 2.4, s)
        return {'rod1': 1 - w2, 'rod2': w2 * (1 - w3), 'rod3': w3}
    parts = [H.Part(rodme, None, rod_w, 0.03, smooth=None, bones=bones)]
    # the float: a slim red-topped float half in the water
    F = V((FLOAT_SIDE, -FLOAT, WATER))
    k = H.Kit()
    prof = [(0.0, -0.035), (0.004, -0.03), (0.007, -0.012), (0.0085, 0.0), (0.0075, 0.012), (0.004, 0.03), (0.0012, 0.045)]
    verts, vc, faces = [], [], []
    for j, (r, z) in enumerate(prof):
        for i in range(8):
            a = TAU * i / 8
            verts.append(F + V((r * math.cos(a), r * math.sin(a), z)))
            vc.append(srgb('#c23a2a') if z > 0.004 else srgb('#e8e4da'))
    for j in range(len(prof) - 1):
        for i in range(8):
            a0, a1_ = j * 8 + i, j * 8 + (i + 1) % 8
            faces.append((a0, a1_, a1_ + 8, a0 + 8))
    k.add(verts, faces, np.array(vc), smooth=True)
    parts.append(H.Part(k.mesh('float'), None, H.const_weights('float'), 0.01, smooth=None, bones=bones))
    joints['float'] = (F, F + V((0, 0, 0.05)))
    # the line: a thin strand from the tip to the float's top, each end on its own bone, so it runs straight between
    # them however they move
    k = H.Kit()
    top = F + V((0, 0, 0.045))
    t = (top - tip).normalized()
    a1 = t.cross(V((1, 0, 0))).normalized()
    a2 = t.cross(a1)
    r = 0.0024
    verts = [p + (a1 * math.cos(a) + a2 * math.sin(a)) * r for p in (tip, top) for a in (TAU * i / 4 for i in range(4))]
    faces = [(i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i) for i in range(4)]
    k.add(verts, faces, LINE)
    line = H.Part(k.mesh('line'), None, lambda P: {'rod3': (P[:, 2] > (tip.z + top.z) / 2).astype(float),
                                                    'float': (P[:, 2] <= (tip.z + top.z) / 2).astype(float)}, 0.0,
                  smooth=None, bones=bones)
    parts.append(line)
    return parts, joints, tip


# ---------- the rice planter ----------
P_BONES = BONES
PLANTER_SCALE = 0.93
SINK = 0.13            # her feet this far under the paddy's water, in the mud
STEP = 0.27            # the row's spacing: how far back she steps each loop (m, after scaling)
JACKET = srgb('#2c3a5c')
JACKET_I = srgb('#252c40')
MOMPE = srgb('#26304a')
OBI_P = srgb('#7a3428')
TASUKI = srgb('#b8302a')
TENUGUI = srgb('#e6e3da')
SKIN_P = np.array([1.0, 0.97, 0.95])
SEEDLING = srgb('#7db040')
SEEDLING_D = srgb('#4d7a2a')
MUD = srgb('#4a3a2a')
P_HEM = 0.73


def jacket_fields(p):
    x, y, z = p
    X = np.abs(x)
    torso, cy = H.torso_plain(p)
    th = np.arctan2(x, y - cy)
    plain = torso
    torso = torso + 0.0016 * np.sin(9.0 * th + 1.2 * np.sin(3.0 * th + 6.0 * z) + 0.6) * sstep(1.05, 0.85, z)
    torso = torso + 0.0014 * np.sin(z * 140.0 + 2.0 * th) * sstep(1.0, 1.03, z) * sstep(1.2, 1.08, z)
    # narrow work sleeves, pushed up and gathered above the elbow by the tasuki
    sleeve = capsule((X, y, z), (0.15, 0.014, 1.355), (0.212, 0.026, 1.115), 0.062, 0.056)
    sleeve = sleeve - 0.0025 * np.sin(z * 120.0 + 7.0 * y) * sstep(1.3, 1.2, z)
    rim = np.sqrt((np.sqrt((X - 0.211) ** 2 + (y - 0.026) ** 2) - 0.052) ** 2 + (z - 1.125) ** 2) - 0.014
    sleeve = smax(sleeve, 1.11 - z + 0.12 * (X - 0.21), 0.01)
    sleeve = np.minimum(sleeve, rim)
    outer = smin(torso, sleeve, 0.02)
    v = H.vee(p)
    outer = smax(outer, v, 0.003)
    shell = np.maximum(outer, -(outer + H.T_CLOTH))
    shell = smax(shell, P_HEM - z, 0.003)
    arm = capsule((X, y, z), (0.213, 0.027, 1.14), (0.236, -0.01, 0.8), 0.044)
    shell = np.maximum(shell, -arm)
    neck = capsule(p, (0, 0.014, 1.36), (0, 0.006, 1.6), 0.064)
    shell = smax(shell, -neck, 0.003)
    return {'shell': shell, 'outer': outer, 'torso': torso, 'sleeve': sleeve, 'plain': plain}


def jacket_sdf(p):
    return jacket_fields(p)['shell']


def jacket_colour(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    f = jacket_fields((x, y, z))
    inner = f['outer'] < -H.T_CLOTH * 0.5
    col = np.where(inner[:, None], JACKET_I, JACKET)
    col = mix(col, col * np.array([1.12, 1.08, 1.0]), 0.5 * sstep(P_HEM + 0.03, P_HEM, z))
    return col, np.where(inner, 0.0, 1.0)


def jacket_hidden(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    f = jacket_fields((x, y, z))
    inner = f['outer'] < -H.T_CLOTH * 0.5
    arm = capsule((np.abs(x), y, z), (0.213, 0.027, 1.14), (0.236, -0.01, 0.8), 0.044)
    return inner & (z > P_HEM + 0.08) & (z < 1.33) & (arm > 0.04)


def jacket_weights(P):
    f = jacket_fields((P[:, 0], P[:, 1], P[:, 2]))
    s = sstep(-0.012, 0.012, f['torso'] - f['sleeve'])
    a = H.torso_weights(P)
    z = P[:, 2]
    sh = 0.45 * sstep(1.27, 1.37, z)
    fore = 0.35 * sstep(1.16, 1.1, z)
    b = H.side_bones({'upper_arm': (1 - sh) * (1 - fore), 'forearm': (1 - sh) * fore, 'shoulder': sh}, P[:, 0],
                     (P[:, 0] > 0).astype(float))
    out = {}
    for k in set(a) | set(b):
        out[k] = a.get(k, 0) * (1 - s) + b.get(k, 0) * s
    return out


def mompe_field(p):
    """baggy work trousers: a loose tube down each leg, full over the seat, rolled up to below the knee"""
    x, y, z = p
    X = np.abs(x)
    leg = capsule((X, y, z), (0.09, 0.004, 0.86), (0.088, -0.004, 0.43), 0.08, 0.064)
    seat = ellipsoid(p, (0, 0.01, 0.89), (0.165, 0.128, 0.14))
    d = smin(leg, seat, 0.04)
    th = np.arctan2(X - 0.088, y)
    d = d + 0.0045 * np.sin(11.0 * th + 7.0 * z + 1.3 * np.sin(5.0 * th)) * sstep(0.84, 0.55, z)
    d = smax(d, z - 1.0, 0.01)
    d = smax(d, 0.425 - z, 0.006)
    r = np.sqrt((X - 0.088) ** 2 + (y + 0.004) ** 2)
    cuff = np.sqrt((r - 0.066) ** 2 + ((z - 0.432) * 0.8) ** 2) - 0.017
    return np.minimum(d, cuff)


def mompe_colour(P):
    col = np.tile(MOMPE, (len(P), 1)) * (0.9 + 0.12 * (0.5 + 0.5 * noise3(P, 35.0, 4.0)))[:, None]
    col = mix(col, col * np.array([1.25, 1.18, 1.05]), sstep(0.47, 0.44, P[:, 2]))    # the rolled cuff's inside, paler
    col = mix(col, MUD, 0.55 * sstep(0.5, 0.42, P[:, 2]) * (0.5 + 0.5 * noise3(P, 50.0, 1.0)))  # splashed with mud
    return col, np.zeros(len(P))


def mompe_weights(P):
    x, z = P[:, 0], P[:, 2]
    hip = sstep(0.8, 0.97, z)
    left = sstep(-0.06, 0.06, x)
    out = {'hips': hip}
    for wl, k in ((H.leg_weights(P, 1), left), (H.leg_weights(P, -1), 1 - left)):
        for b, v in wl.items():
            out[b] = out.get(b, 0) + v * (1 - hip) * k
    return out


def bare_leg_colour(P):
    z = P[:, 2]
    col = np.tile(H.SKIN_HAND * SKIN_P * 0.97, (len(P), 1))
    return mix(col, MUD, 0.85 * sstep(0.16, 0.07, z))


def tenugui_field(p):
    """the white hand towel over her hair (anesan-kaburi): over the crown from above the brow to the nape, its corners
    tucked in a knot at the back"""
    x, y, z = p
    cap = ellipsoid(p, (0, 0.007, 1.575), (0.0875, 0.109, 0.102))
    below = (1.598 - 0.62 * (y + 0.075) - 0.25 * np.maximum(0.0, np.abs(x) - 0.06)) - z
    d = smax(cap, below, 0.004)
    knot = ellipsoid(p, (0, 0.104, 1.6), (0.032, 0.02, 0.022))
    tails = ellipsoid(p, (0, 0.112, 1.565), (0.04, 0.012, 0.03))
    return smin(d, np.minimum(knot, tails), 0.01)


def tenugui_colour(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    col = np.tile(TENUGUI, (len(P), 1)) * (0.93 + 0.07 * (0.5 + 0.5 * noise3(P, 90.0)))[:, None]
    edge = 1.598 - 0.62 * (y + 0.075) - 0.25 * np.maximum(0.0, np.abs(x) - 0.06)
    stripe = sstep(0.012, 0.006, np.abs(z - edge - 0.013))
    return mix(col, srgb('#3b4f7a'), 0.75 * stripe)


def tasuki_path():
    """the cord's middle line on the jacket: over each shoulder and crossed on the back, under each arm"""
    pts = []
    for s in (1, -1):
        pts += [(s * 0.115, -0.095, 1.36), (s * 0.14, -0.035, 1.425), (s * 0.13, 0.055, 1.405), (s * 0.06, 0.112, 1.33),
                (0.0, 0.124, 1.27), (-s * 0.08, 0.118, 1.22), (-s * 0.15, 0.085, 1.2), (-s * 0.195, 0.03, 1.215),
                (-s * 0.2, -0.04, 1.25), (-s * 0.16, -0.09, 1.3)]
    pts.append(pts[0])
    return pts


def tasuki(bones):
    outer = lambda pp: jacket_fields(pp)['outer']
    P = np.array(tasuki_path(), np.float64)
    # many points along it, pulled onto the cloth and lifted off it by the cord's thickness
    fine = []
    for a, b in zip(P[:-1], P[1:]):
        for t in np.linspace(0, 1, 6, endpoint=False):
            fine.append(a + (b - a) * t)
    fine = np.array(fine)
    for _ in range(6):
        fine = H.project(outer, fine, 0.01)
    g = H.grad(outer, fine, 0.002)
    g /= np.linalg.norm(g, axis=1)[:, None]
    fine = fine + g * 0.009
    k = H.Kit()
    pts = [V(q) for q in fine] + [V(fine[0])]
    k.tube(pts, 0.008, TASUKI, seg=6)
    return H.Part(k.mesh('tasuki'), None, jacket_weights, 0.03, smooth=None, bones=bones)


def bundle(bones, side, n_blades, length, roots=True):
    """seedlings held in a hand (side 1 left, -1 right): blades fanning out of the fist on the thumb side, the roots
    and their mud below it, tied with straw"""
    w0, u, v, w = hand_axes(side)
    g = w0 + u * 0.1 + w * 0.032
    rng = np.random.default_rng(7 if side > 0 else 11)
    k = H.Kit()
    for i in range(n_blades):
        a = rng.uniform(0, TAU)
        rr = rng.uniform(0, 0.012)
        base = g + (u * math.cos(a) + w * math.sin(a)) * rr - v * 0.01
        spread = (u * math.cos(a) + w * math.sin(a)) * rng.uniform(0.08, 0.3)
        d = (v + spread).normalized()
        L = length * rng.uniform(0.75, 1.1)
        droop = V((0, 0, -1)) * rng.uniform(0.0, 0.25)
        pts = [base, base + d * L * 0.5 + droop * L * 0.08, base + d * L + droop * L * 0.3]
        c = SEEDLING * rng.uniform(0.85, 1.15) if i % 3 else SEEDLING_D
        verts, faces = [], []
        for j, p in enumerate(pts):
            wdt = 0.0042 * (1 - j / 3)
            side_v = d.cross(V((0.3, 0.2, 1.0))).normalized()
            nrm = side_v.cross(d).normalized()
            verts += [p + side_v * wdt, p - side_v * wdt, p + nrm * wdt * 0.6]
        for j in range(len(pts) - 1):
            for a0, a1 in ((0, 1), (1, 2), (2, 0)):
                faces.append((j * 3 + a0, j * 3 + a1, j * 3 + 3 + a1, j * 3 + 3 + a0))
        k.add(verts, faces, c)
    if roots:
        k.tube([g - v * 0.018, g - v * 0.05], 0.019, MUD, seg=8)
        k.tube([g - v * 0.0, g + v * 0.008], 0.0155, srgb('#b59a5c'), seg=8)
    hand = 'hand_L' if side > 0 else 'hand_R'
    return H.Part(k.mesh('bundle'), None, H.const_weights(hand), 0.03, smooth=None, bones=bones)


def planter_body(bones):
    parts = head_parts(bones, SKIN_P, H.HAIR)
    me = H.sdf_part('tenugui', tenugui_field, (-0.1, -0.11, 1.48), (0.1, 0.14, 1.69), 0.002, 1500)
    parts.append(H.Part(me, tenugui_colour, H.head_weights, 0.04, bones=bones))
    # bare forearms out of the pushed-up sleeves; the left fist round the bundle, the right pinching a few seedlings
    left = hand_part(bones, grip_fingers((2.2, 2.0, 1.8), 0.7), arm=0.3, k=SKIN_P, target=1600)
    right = hand_part(bones, grip_fingers((1.3, 1.2, 1.1), 0.8), arm=0.3, k=SKIN_P, target=1600)
    parts += [left, right.mirrored()]
    me = H.sdf_part('leg', lambda p: H.leg_fields(p, use_gaiter=False)['d'], (0.0, -0.16, 0.0), (0.17, 0.1, 0.66), 0.0024, 1500)
    leg = H.Part(me, bare_leg_colour, lambda P: H.leg_weights(P, 1), 0.12, bones=bones)
    parts += [leg, leg.mirrored()]
    me = H.sdf_part('mompe', mompe_field, (-0.29, -0.2, 0.39), (0.29, 0.2, 1.02), 0.0032, 4200)
    parts.append(H.Part(me, mompe_colour, mompe_weights, 0.15, bones=bones))
    me = H.sdf_part('jacket', jacket_sdf, (-0.3, -0.165, P_HEM - 0.01), (0.3, 0.24, 1.475), 0.0032, 8000, H.robe_protect,
                    jacket_hidden)
    parts.append(H.Part(me, jacket_colour, jacket_weights, 0.2, bones=bones))
    me = H.sdf_part('collar', H.collar_sdf, (-0.11, -0.15, 0.94), (0.11, 0.11, 1.47), 0.0024, 1000)
    parts.append(H.Part(me, H.flat(H.INDIGO_D), H.kimono_weights, 0.06, bones=bones))
    me = H.sdf_part('obi', H.obi_sdf, (-0.19, -0.16, 0.86), (0.19, 0.18, 1.04), 0.0028, 900)
    parts.append(H.Part(me, H.flat(OBI_P), H.kimono_weights, 0.08, bones=bones))
    me = H.sdf_part('under', H.under_sdf, (-0.08, -0.14, 1.2), (0.08, -0.04, 1.45), 0.0022, 400)
    parts.append(H.Part(me, tinted(H.under_colour, SKIN_P), H.kimono_weights, 0.05, bones=bones))
    parts.append(tasuki(bones))
    parts.append(bundle(bones, 1, 48, 0.25))
    parts.append(bundle(bones, -1, 5, 0.14, roots=False))
    return parts


def planter_pose(rest):
    """bent double over the water, the back nearly level, looking at the water ahead; the left forearm on her thigh
    with the bundle, the right hand hanging to the water"""
    Q = {b: Quaternion() for b in BONES}
    Tr = V((0.0, 0.2, -0.24))
    Q['hips'] = rx(1.05)
    Q['spine'] = rx(0.34) @ rz(0.03)
    Q['chest'] = rx(0.2)
    Q['neck'] = rx(-0.38)
    Q['head'] = rx(-0.5) @ rz(-0.08)
    feet = {'_L': V((0.125, H.ANKLE_Y - 0.06, H.ANKLE_Z)), '_R': V((-0.13, H.ANKLE_Y + 0.1, H.ANKLE_Z))}
    for s in ('_L', '_R'):
        H.leg_ik(rest, Q, Tr, s, feet[s], 0.0)
    T = {'hips': Tr}
    for s, side in (('_L', 1), ('_R', -1)):
        Q['shoulder' + s] = rx(0.35) @ ry(-side * 0.05)
    w0, u, v, w = hand_axes(1)
    RL = frame_rot(u, v, V((-0.25, -0.5, -1.0)), V((-0.9, -0.2, 0.25)))
    arm_ik(rest, Q, T, '_L', V((0.11, -0.36, 0.36)), V((1.0, 0.6, 0.2)), RL, H.parent_of, BONES)
    _, u, v, w = hand_axes(-1)
    RR = frame_rot(u, w, V((0.1, -0.35, -1.0)), V((1.0, 0.0, 0.1)))
    arm_ik(rest, Q, T, '_R', V((-0.04, -0.47, 0.32)), V((-1.0, 0.7, 0.3)), RR, H.parent_of, BONES)
    return Q, T, {}




def lantern_part(bones):
    """a paper lantern (chochin) hung from a bamboo stick stuck in the bank at his left, its paper glowing after dusk
    (alpha 0.2)"""
    k = H.Kit()
    foot, top, hook = V((0.62, 0.3, -0.2)), V((0.6, 0.27, 0.78)), V((LAMP.x, LAMP.y, 0.73))
    k.tube([foot, top], 0.009, BAMBOO * 0.9, seg=6)
    k.tube([top, top + (hook - top) * 0.5 + V((0, 0, 0.015)), hook], 0.006, BAMBOO * 0.8, seg=5)
    k.tube([hook, V((LAMP.x, LAMP.y, LAMP.z + 0.12))], 0.0018, H.CORD, seg=4)
    c, hh, r = LAMP, 0.1, 0.068
    seg, rings = 16, 9
    verts, cols, faces = [], [], []
    for j in range(rings):
        t = j / (rings - 1)
        z = c.z - hh + 2 * hh * t
        rr = r * (0.78 + 0.22 * math.sin(math.pi * t)) * (0.97 if j % 2 else 1.0)
        for i in range(seg):
            a = TAU * i / seg
            verts.append(V((c.x + rr * math.cos(a), c.y + rr * math.sin(a), z)))
            cols.append(PAPER * (0.85 if j % 2 else 1.0))
    for j in range(rings - 1):
        for i in range(seg):
            a0, a1 = j * seg + i, j * seg + (i + 1) % seg
            faces.append((a0, a1, a1 + seg, a0 + seg))
    vs = k.add(verts, faces, np.array(cols), smooth=True)
    for v in vs:
        cc = v[k.col]
        v[k.col] = (cc[0], cc[1], cc[2], 0.2)
    for z0, z1 in ((c.z + hh - 0.004, c.z + hh + 0.018), (c.z - hh - 0.018, c.z - hh + 0.004)):
        k.tube([V((c.x, c.y, z0)), V((c.x, c.y, z1))], r * 0.8, srgb('#231d19'), seg=12)
    return H.Part(k.mesh('lantern'), None, H.const_weights('base'), 0.06, smooth=None, bones=bones)


# ---------- clips ----------
FPS = H.FPS


def frames(n):
    return [(f, f / FPS) for f in range(n + 1)]


def fisher_clips(J, S0):
    tip0, F0 = J['rod3'][1], J['float'][0]
    line = (tip0 - F0).length
    head0 = J['head'][0]
    w0, u, v, w = hand_axes(1)
    grip_off = u * 0.085 + w * 0.03
    grip_l = S0['hand_L'] @ (w0 + grip_off)      # where his left fingers close (rest)

    def sit(rest):
        fit(rest)
        out = []
        n = 10 * FPS
        for f, _ in frames(n):
            t = (f % n) / FPS
            w_ = TAU * (f % n) / n
            Q = {b: Quaternion() for b in F_BONES}
            breath = 0.5 + 0.5 * math.sin(3 * w_)
            nib = math.exp(-((t - NIBBLE) / 0.22) ** 2)
            look = math.exp(-((t - NIBBLE - 0.6) / 0.9) ** 2)
            Q['hips'] = rz(0.012 * math.sin(w_ + 0.5))
            Q['spine'] = rx(0.012 * math.sin(w_))
            Q['chest'] = rx(-0.022 * breath)
            Q['neck'] = rz(0.03 * math.sin(2 * w_ + 1.0))
            Q['head'] = rz(0.07 * math.sin(w_ + 1.3)) @ rx(0.02 * math.sin(2 * w_) + 0.07 * look)
            for s, sg in (('_L', 1), ('_R', -1)):
                Q['shoulder' + s] = ry(-sg * 0.015 * breath)
            Q['hand_R'] = rx(0.03 * nib)
            Q['rod2'] = rx(0.01 * math.sin(4 * w_) + 0.004 * math.sin(9 * w_ + 1))
            Q['rod3'] = rx(0.022 * math.sin(4 * w_ + 0.5) + 0.008 * math.sin(11 * w_) + 0.05 * nib)
            Tf = V((0.012 * math.sin(2 * w_), 0.01 * math.sin(w_), 0.004 * math.sin(6 * w_) - 0.022 * nib))
            out.append((Q, {'hips': V((0, 0, -0.002 * breath)), 'float': Tf}))
        return out

    def lift(rest):
        fit(rest)
        out = []
        n = 6 * FPS
        q_hand = S0['hand_L'].to_quaternion()
        for f, t in frames(n):
            Q = {b: Quaternion() for b in F_BONES}
            # the rod up, back a little further, held; swung forward to cast, down to rest
            e = 1.0 * ease(t / 1.1) + 0.3 * ease((t - 1.1) / 0.9) - 0.75 * ease((t - 3.7) / 0.5) - 0.55 * ease((t - 4.2) / 1.4)
            look = ease((t - 1.8) / 0.5) - ease((t - 3.6) / 0.5)
            reach = ease((t - 1.3) / 0.9) - ease((t - 3.7) / 0.8)
            Q['chest'] = rx(-0.05 * e)
            Q['neck'] = rx(0.12 * look) @ rz(0.1 * look)
            Q['head'] = rx(0.22 * look) @ rz(0.12 * look)
            Q['upper_arm_R'] = rx(-0.17 * e)
            Q['forearm_R'] = rx(-0.19 * e)
            Q['hand_R'] = rx(-0.13 * e)
            Q['rod3'] = rx(0.04 * ease((t - 3.75) / 0.25) * (1 - ease((t - 4.0) / 0.4)))
            T = {'hips': V((0, 0, 0))}
            # his left hand out to catch the line in front of his chin, back to his knee
            C = head0 + V((0.07, -0.3, -0.2)) + V((0.01 * math.sin(t * 5.0), 0, 0.008 * math.sin(t * 3.0))) * look
            RL = Quaternion().slerp(rx(-0.9) @ rz(0.5), reach)
            target = lerpv(rest.h['hand_L'], C - RL @ (q_hand @ grip_off), reach)
            arm_ik(rest, Q, T, '_L', target, V((1.0, 0.4, -0.5)), RL, f_parent, F_BONES)
            S = fk(Q, T, rest.h, F_BONES, f_parent)
            tip = S['rod3'] @ tip0
            hang = tip - V((0, 0, line))
            hand = S['hand_L'] @ grip_l
            if t < 0.5:
                F = F0.copy()
            elif t < 1.6:
                k = ease((t - 0.5) / 1.1)
                F = lerpv(F0, hang, k) + V((0, 0, 0.25 * math.sin(math.pi * k)))
            elif t < 2.2:
                F = lerpv(hang, hand, ease((t - 1.6) / 0.6))
            elif t < 3.6:
                F = hand
            elif t < 4.0:
                F = lerpv(hand, hang, ease((t - 3.6) / 0.4))
            elif t < 5.0:
                k = ease((t - 4.0) / 1.0)
                F = lerpv(hang, F0, k) + V((0, 0, 0.35 * math.sin(math.pi * k)))
            else:
                F = F0 + V((0, 0, 0.012 * math.sin((t - 5.0) * 12.0) * (6.0 - t)))
            T['float'] = F - F0
            out.append((Q, T))
        return out
    return [('sit', sit), ('lift', lift)]


PLANT_X = (0.19, 0.0, -0.19)   # the row's three seedlings, across in front of her (m, her left +)
PLANT_AT = tuple(2.6 * k + 1.95 for k in range(3))   # s into `plant`: each pushed into the mud


def planter_clips(J, S0, s):
    fl, fr = J['foot_L'][0], J['foot_R'][0]
    mid = (fl + fr) * 0.5
    row = mid.y - 0.43 * s
    w0, u, v, w = hand_axes(1)
    grip_l = (S0['hand_L'] @ (w0 + u * 0.1 + w * 0.032)) * s
    reach = 0.165 * s           # wrist to the finger tips
    spots = [V((x, row, SINK - 0.035)) for x in PLANT_X]
    back = V((0, STEP, 0))

    def body_move(t):
        return back * ease((t - 7.9) / 2.6)

    def plant(rest):
        fit(rest)
        out = []
        n = 12 * FPS
        wrist0 = rest.h['hand_R']
        for f, t in frames(n):
            Q = {b: Quaternion() for b in P_BONES}
            o = body_move(t)
            T = {'hips': o + V((0, 0, -0.012 * math.sin(math.pi * ease((t - 7.9) / 2.6))))}
            k = min(2, int(t // 2.6))
            tk = t - 2.6 * k
            sway = PLANT_X[k] / 0.19 if t < 7.8 else 0.0
            Q['spine'] = rz(0.03 * sway * ease(tk / 0.9))
            Q['head'] = rz(0.1 * sway * ease(tk / 0.9)) @ rx(0.04 * math.sin(TAU * t / 12.0))
            Q['chest'] = rx(0.015 * math.sin(TAU * 3 * t / 12.0))
            for side in ('_L', '_R'):
                foot = fl if side == '_L' else fr
                t0 = 7.8 if side == '_R' else 9.2
                q = ease((t - t0) / 1.2)
                A = foot + back * q + V((0, 0, 0.09 * math.sin(math.pi * min(1.0, max(0.0, (t - t0) / 1.2)))))
                H.leg_ik(rest, Q, T['hips'], side, A, 0.0)
            S = fk(Q, T, rest.h, P_BONES, H.parent_of)
            pick = S['hand_L'] @ grip_l + V((-0.05, -0.035, 0.1))
            if t < 7.8:
                prev = wrist0 if k == 0 else spots[k - 1] + V((0, 0, reach + 0.14))
                spot = spots[k]
                hover = spot + V((0, 0, reach + 0.1))
                push = spot + V((0, 0, reach))
                up = spot + V((0, 0, reach + 0.14))
                if tk < 0.6:
                    W = lerpv(prev, pick, ease(tk / 0.6))
                elif tk < 0.9:
                    W = pick + V((0.0, 0.0, 0.01 * math.sin((tk - 0.6) * 20)))
                elif tk < 1.6:
                    W = lerpv(pick, hover, ease((tk - 0.9) / 0.7))
                elif tk < 1.95:
                    W = lerpv(hover, push, ease((tk - 1.6) / 0.35))
                elif tk < 2.1:
                    W = push
                else:
                    W = lerpv(push, up, ease((tk - 2.1) / 0.5))
            else:
                W = lerpv(spots[2] + V((0, 0, reach + 0.14)), wrist0 + o, ease((t - 7.8) / 1.6))
            arm_ik(rest, Q, T, '_R', W, V((-1.0, 0.7, 0.3)), Quaternion(), H.parent_of, P_BONES)
            out.append((Q, T))
        return out

    def stretch(rest):
        fit(rest)
        out = []
        n = 5 * FPS
        back_pt = (S0['spine'] @ V((0.0, 0.17, 1.02))) * s
        for f, t in frames(n):
            Q = {b: Quaternion() for b in P_BONES}
            e = ease(t / 1.4) - ease((t - 3.8) / 1.2)
            T = {'hips': V((0, -0.05 * e, 0.06 * e))}
            Q['hips'] = rx(-0.5 * e)
            Q['spine'] = rx(-0.22 * e)
            Q['chest'] = rx(-0.12 * e) @ rx(-0.03 * math.sin(math.pi * min(1, max(0, (t - 1.2) / 2.6))))
            turn = math.sin(TAU * min(1.0, max(0.0, (t - 1.5) / 2.3))) * e
            Q['neck'] = rx(0.3 * e) @ rz(0.2 * turn)
            Q['head'] = rx(0.35 * e) @ rz(0.35 * turn)
            for side in ('_L', '_R'):
                H.leg_ik(rest, Q, T['hips'], side, J['foot' + side][0], 0.0)
            S = fk(Q, T, rest.h, P_BONES, H.parent_of)
            hb = S['spine'] @ back_pt
            RR = Quaternion().slerp(rz(-1.2) @ rx(1.2), e)
            W = lerpv(rest.h['hand_R'], hb + V((-0.05, 0.03, 0.0)), e)
            arm_ik(rest, Q, T, '_R', W, V((-1.0, 0.8, -0.2)), RR, H.parent_of, P_BONES)
            # the left arm with the bundle hangs from the shoulder as she straightens
            sh = S['shoulder_L'] @ rest.h['upper_arm_L']
            WL = lerpv(rest.h['hand_L'], sh + V((0.03, -0.12, -0.42)), e)
            arm_ik(rest, Q, T, '_L', WL, V((1.0, 0.6, 0.0)), Quaternion(), H.parent_of, P_BONES)
            out.append((Q, T))
        return out
    return [('plant', plant), ('stretch', stretch)], spots


# ---------- assembly ----------
def posed_joints(S, bones):
    return {b: (S[b] @ Vector(H.J[b][0]), S[b] @ Vector(H.J[b][1])) for b in bones}


def build_figure(body, pose, bones, extras=None, scale=1.0):
    """the figure posed from the traveller's standing body: its vertices skinned by dual quaternions into the pose,
    its joints there; extras(S, info) adds parts built in the posed figure's space (and their bones' joints)"""
    full = H.join(body)
    canon = Canon(H.J, BONES)
    Q, T, info = pose(canon)
    S = fk(Q, T, canon.h, BONES, H.parent_of)
    for b in bones:
        S.setdefault(b, Matrix.Identity(4))
    full['P'] = dqs(full['P'], full['W'], S, bones)
    joints = posed_joints(S, BONES)
    if extras:
        parts, ej = extras(S, info)
        joints.update(ej)
        full = H.join([part_of(full, bones)] + parts)
    if scale != 1.0:
        full['P'] = full['P'] * scale
        joints = {b: (h * scale, t * scale) for b, (h, t) in joints.items()}
    H.bake_ao(full)
    return full, joints, S


def finish(name, full, joints, bones, parent, clips, far_tris):
    """the far model, the rig, both meshes bound to it, the clips"""
    far = H.far_model(full, far_tris, name + '_far')
    rig = H.make_rig(name + '_rig', bones, joints, parent)
    H.bind(rig, name, full, bones)
    H.bind(rig, name + '_far', far, bones)
    H.key_clips(rig, clips, bones)
    return rig


def fisher_extras(S, info):
    parts, joints, tip = rod_parts(F_BONES, info['grip'], info['rod'])
    parts += [seat_stone(F_BONES), lantern_part(F_BONES)]
    joints['base'] = (V((0, 0, 0)), V((0, 0, 0.1)))
    return parts, joints


def build(which=('fisherman', 'planter')):
    if 'fisherman' in which:
        full, joints, S = build_figure(fisher_body(F_BONES), fisher_pose, F_BONES, fisher_extras)
        finish('fisherman', full, joints, F_BONES, f_parent, fisher_clips(joints, S), 6000)
    if 'planter' in which:
        full, joints, S = build_figure(planter_body(P_BONES), planter_pose, P_BONES, scale=PLANTER_SCALE)
        clips, spots = planter_clips(joints, S, PLANTER_SCALE)
        finish('planter', full, joints, P_BONES, H.parent_of, clips, 6000)
        print('planter spots (Blender x, y, z):', [tuple(round(c, 4) for c in p) for p in spots], 'at', PLANT_AT, flush=True)


def main(out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    build()
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_normals=True, export_yup=True, export_skins=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_step=2, export_optimize_animation_size=False)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1])
