# The riverside's lamps (src/lanterns.js places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/lamps.py -- <out.glb>
# Each kind is one mesh in metres standing on its origin at ground level (Blender: z up; glTF: y up), with a lighter
# `<kind>_far` model:
# - post: a weathered cedar post for the festival lanterns' ropes round the cherries, sunk 0.4 m, the rope tied
#   round it 2.55 m up (lanterns.js ROPE) under a small cap;
# - bonbori: a paper lamp on a wooden post on a stone footing, as along riverside paths at night cherry viewings: a
#   hexagonal shade of white washi with a red band on a dark frame, under a little hexagonal roof, its light 1.76 m up;
# - kagaribi: a fire basket of iron bands on three crossed iron legs, split pine stacked in it over glowing coals (the
#   page adds the flames, 1.55 m up).
# Shading in the vertex colours (ambient occlusion by ray casting); alpha: how much a part glows after dusk (the
# paper, lit from inside; the coals).
import bpy, bmesh, math, os, random, sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import lerp, link, tris, vertex_ao
from village import Kit, srgb

V = Vector
CEDAR = srgb('#5c4636')      # weathered post
CEDAR_D = srgb('#2e231b')
ROPE = srgb('#a08a5e')       # straw rope
STONE = srgb('#7d776c')
PAPER = srgb('#f1ead6')
RED = srgb('#b8261a')
IRON = srgb('#26221f')
CHAR = srgb('#1b1612')       # charred pine
PINE = srgb('#8a6a45')       # split faces not yet burnt
COAL = srgb('#ff6a1c')


def finish(k, name, ao_reach=0.5):
    """AO into the colours of what does not glow; one mesh named `name`"""
    bm = k.bm
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, ao_reach)
    for v in bm.verts:
        c = v[k.col]
        a = 1.0 if c[3] > 0 else lerp(0.45, 1.0, ao[v.index])
        v[k.col] = (c[0] * a, c[1] * a, c[2] * a, c[3])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()
    me.color_attributes.active_color = me.color_attributes['Color']
    link(me, name)
    return me


def glowing(k, vs, g=1.0):
    """what Kit just made glows g after dusk"""
    for v in vs:
        c = v[k.col]
        v[k.col] = (c[0], c[1], c[2], g)


def post(far):
    k = Kit()
    rng = random.Random(3)
    k.box(CEDAR, (0.12, 0.12, 3.2), V((0, 0, 1.2)))
    if not far:
        # weathering: darker grain streaks down two faces, a split near the top
        for i in range(5):
            x = rng.uniform(-0.045, 0.045)
            k.box(CEDAR_D, (0.012, 0.125, rng.uniform(0.6, 1.6)), V((x, 0, rng.uniform(0.6, 2.0))))
        # the rope's turns round the post, and its knot
        k.cyl(ROPE, V((0, 0, 2.5)), V((0, 0, 2.6)), 0.085, seg=8)
        k.cyl(ROPE, V((0.06, 0, 2.55)), V((0.16, 0, 2.48)), 0.03, seg=5)
    # a cap against the rain: a low pyramid of board
    k.mesh([V((-0.1, -0.1, 2.8)), V((0.1, -0.1, 2.8)), V((0.1, 0.1, 2.8)), V((-0.1, 0.1, 2.8)), V((0, 0, 2.9))],
           [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)], CEDAR_D)
    return finish(k, 'post' + ('_far' if far else ''))


def bonbori(far):
    k = Kit()
    k.box(STONE, (0.34, 0.34, 0.26), V((0, 0, 0.03)))
    k.box(CEDAR, (0.085, 0.085, 1.45), V((0, 0, 0.16 + 0.72)))
    k.box(CEDAR_D, (0.3, 0.3, 0.035), V((0, 0, 1.52)))
    # the shade: washi on a hexagonal frame, a red band round its foot
    z0, z1, r = 1.54, 1.98, 0.19
    glowing(k, k.cyl(PAPER, V((0, 0, z0)), V((0, 0, z1)), r, seg=6, r2=r * 1.06, smooth=False, cap=False))
    glowing(k, k.cyl(RED, V((0, 0, z0)), V((0, 0, z0 + 0.075)), r * 1.012, seg=6, r2=r * 1.022, smooth=False, cap=False))
    if not far:
        for i in range(6):
            a = 2 * math.pi * i / 6
            c, s = math.cos(a), math.sin(a)
            k.beam(CEDAR_D, V((c * r * 1.01, s * r * 1.01, z0)), V((c * r * 1.07, s * r * 1.07, z1)), 0.022, 0.022)
        for z, rr in ((z0, r), (z1, r * 1.06)):
            k.cyl(CEDAR_D, V((0, 0, z - 0.012)), V((0, 0, z + 0.012)), rr * 1.08, seg=6, smooth=False)
        # the paper's inner face, seen through the open top's lip
        glowing(k, k.cyl(PAPER, V((0, 0, z1 - 0.01)), V((0, 0, z1)), r * 1.0, seg=6, smooth=False, cap=True))
    # a hexagonal roof, its eaves a little turned up, a round knob
    k.cyl(CEDAR_D, V((0, 0, 1.99)), V((0, 0, 2.03)), 0.3, seg=6, r2=0.29, smooth=False)
    k.cyl(CEDAR_D, V((0, 0, 2.03)), V((0, 0, 2.17)), 0.27, seg=6, r2=0.03, smooth=False)
    k.cyl(CEDAR_D, V((0, 0, 2.16)), V((0, 0, 2.23)), 0.035, seg=6, r2=0.015)
    return finish(k, 'bonbori' + ('_far' if far else ''))


def kagaribi(far):
    k = Kit()
    rng = random.Random(7)
    seg = 5 if far else 7
    # three legs splayed on the ground, crossing under the basket
    for i in range(3):
        a = 2 * math.pi * i / 3
        c, s = math.cos(a), math.sin(a)
        k.cyl(IRON, V((c * 0.62, s * 0.62, -0.05)), V((-c * 0.16, -s * 0.16, 1.32)), 0.022, seg=seg)
    k.cyl(IRON, V((0, 0, 1.06)), V((0, 0, 1.11)), 0.1, seg=10, smooth=False)
    # the basket: rings of iron band, bars flaring out from its foot to its lip
    zb, zt, rb, rt = 1.22, 1.68, 0.15, 0.34
    for z, rr in ((zb, rb), ((zb + zt) / 2, (rb + rt) / 2), (zt, rt)):
        if far and z != zt:
            continue
        k.cyl(IRON, V((0, 0, z - 0.02)), V((0, 0, z + 0.02)), rr + 0.012, seg=12, smooth=False, cap=False)
    for i in range(6 if far else 12):
        a = 2 * math.pi * i / (6 if far else 12)
        c, s = math.cos(a), math.sin(a)
        k.cyl(IRON, V((c * rb, s * rb, zb)), V((c * rt, s * rt, zt + 0.04)), 0.011, seg=4)
    k.cyl(IRON, V((0, 0, zb - 0.03)), V((0, 0, zb)), rb, seg=10, smooth=False)
    # glowing coals in its foot, split pine stacked crosswise over them, charred, the odd fresh split face
    k.mesh([V((math.cos(2 * math.pi * i / 10) * rb * 1.2, math.sin(2 * math.pi * i / 10) * rb * 1.2, zb + 0.08 + rng.uniform(0, 0.03)))
            for i in range(10)] + [V((0, 0, zb + 0.13))], [(i, (i + 1) % 10, 10) for i in range(10)], COAL, glow=1.0)
    for layer in range(1 if far else 3):
        z = zb + 0.16 + layer * 0.11
        a0 = layer * math.pi / 3 + rng.uniform(-0.2, 0.2)
        for j in (-1, 0, 1):
            a = a0 + j * 0.05
            c, s = math.cos(a), math.sin(a)
            off = V((-s, c, 0)) * j * 0.08
            half = 0.16 + layer * 0.07
            p0 = V((c * half, s * half, z)) + off
            p1 = V((-c * half, -s * half, z + rng.uniform(-0.03, 0.05))) + off
            k.beam(CHAR if rng.random() < 0.75 else PINE, p0, p1, 0.06, 0.05)
    return finish(k, 'kagaribi' + ('_far' if far else ''), 0.3)


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for far in (False, True):
        for me in (post(far), bonbori(far), kagaribi(far)):
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
