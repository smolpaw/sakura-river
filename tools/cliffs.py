# The rock walls of the gorge above the bridge (src/cliffs.js places them), built in Blender. Run through
# tools/blender.mjs:
#   blender -b --factory-startup -P tools/cliffs.py -- <out.glb>
# Each wall is one mesh, one unit tall and 1.2 wide (x), its face towards -y (glTF: +z) leaning back as the gorge's
# sides do, its body running back into the hill (buried faces removed). It is bedded rock: layers of blocks split by
# joints, a softer layer weathered back here and there, fused into one surface (voxel remesh), roughened and decimated.
# Shading in the vertex colours: each bed its own tint, ambient occlusion in the joints, moss on the ledges and over
# the rim, dark streaks where water runs down from the ledges.
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, evaluated, tris, vertex_ao

V = Vector
LEAN = 0.24  # the face's run back per unit of height
BEDS = [(0.5, 0.46, 0.41), (0.42, 0.4, 0.37), (0.54, 0.49, 0.43), (0.46, 0.43, 0.4)]
MOSS, RIM = (0.07, 0.13, 0.035), (0.12, 0.2, 0.05)


def cliff(name, seed, target, sharp):
    rng = random.Random(seed)
    bm = bmesh.new()
    beds, z = [], -0.14
    while z < 1.0:
        top = min(1.0, z + rng.uniform(0.1, 0.3))
        beds.append((z, top))
        z = top
    # vertical joints run through several beds; each bed drops some of them (taller blocks) and shifts the rest a little
    joints, x = [], -0.72
    while x < 0.72:
        x += rng.uniform(0.07, 0.2)
        joints.append(x)
    off = V((seed * 5.1, seed * 2.3, seed * 7.9))
    for z0, z1 in beds:
        recess = 0.025 if rng.random() < 0.25 else 0.0  # a softer bed, weathered back into a groove
        cuts = [-0.72] + [j + rng.uniform(-0.015, 0.015) for j in joints if rng.random() < 0.75] + [0.74]
        for x, x1 in zip(cuts, cuts[1:]):
            if x1 - x < 0.03:
                continue
            xm, zm = (x + x1) / 2, (z0 + z1) / 2
            # the face bulges and hollows broadly, in ribs and fissures that run up it (the same offset up a column);
            # the wall's ends turn back into the hill so walls can overlap
            f = LEAN * zm + recess + 0.04 * noise.noise(V((xm * 1.6, zm * 1.3, 0)) + off) \
                + 0.03 * noise.noise(V((xm * 9, zm * 0.8, 0)) + off) + rng.uniform(-0.008, 0.008) + min(0.1, max(0.0, abs(xm) - 0.36) * 0.5)
            back = 0.62 - 0.3 * zm  # the body thins upwards, so none of it reaches the turf behind the rim
            if back - f < 0.05:
                continue
            size = V((x1 - x - 0.008, back - f, z1 - z0 - 0.007))
            m = Matrix.Translation(V((xm, (f + back) / 2, zm))) @ Matrix.Rotation(rng.uniform(-0.03, 0.03), 4, 'Y') @ Matrix.Diagonal((*size, 1.0))
            # a broken block: each corner pulled in or out a little, so no face is square
            cube = bmesh.ops.create_cube(bm, size=1.0, matrix=m)['verts']
            for v in cube:
                v.co += V((rng.uniform(-1, 1) * size.x * 0.12, rng.uniform(-0.01, 0.01), rng.uniform(-1, 1) * size.z * 0.06))
    me = bpy.data.meshes.new('blocks')
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'blocks')
    rm = ob.modifiers.new('remesh', 'REMESH')
    rm.mode, rm.voxel_size, rm.adaptivity = 'VOXEL', 0.007, 0.0
    me = evaluated(ob)
    bm = bmesh.new()
    bm.from_mesh(me)
    # buried: what faces back into the hill, the underside
    bm.normal_update()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.normal.y > 0.8 and f.calc_center_median().y > 0.3) or f.calc_center_median().z < -0.1], context='FACES')
    # weathering: edges rounded, broad bulges and a little grain along the normal
    bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    for v in bm.verts:
        p = v.co + off
        v.co += v.normal * (noise.noise(p * 5) * 0.014 + noise.noise(p * 11) * 0.008 + noise.noise(p * 24) * 0.003)
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'wall')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    me = evaluated(ob)

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, 0.12)
    tint = [rng.choice(BEDS) for _ in beds]
    cols = []
    for v in bm.verts:
        p, n, a = v.co, v.normal, ao[v.index]
        k = next((i for i, (z0, z1) in enumerate(beds) if p.z < z1), len(beds) - 1)
        c = V(tint[k]) * (0.88 + 0.24 * noise.noise(p * 11 + V((1.7, 0, 0))))
        # water stains running down the face under the ledges
        streak = smoothstep(0.2, 0.6, noise.noise(V((p.x * 26, p.y * 26, p.z * 1.6)) + off))
        c *= lerp(1.0, 0.62, streak * (1 - smoothstep(0.3, 0.7, n.z)))
        # moss where the rock faces up, and over the rim where the turf takes over
        moss = smoothstep(0.55, 0.9, n.z + 0.35 * noise.noise(p * 14 + V((0, 3.3, 0)))) * smoothstep(0.05, 0.2, p.z)
        c = c.lerp(V(MOSS), moss * 0.7)
        c = c.lerp(V(RIM), smoothstep(0.93, 1.0, p.z) * smoothstep(0.2, 0.6, n.z))
        cols.append(c * lerp(0.4, 1.0, a))
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()
    if sharp:
        me.set_sharp_from_angle(angle=math.radians(50))  # the blocks' edges stay crisp
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    link(me, name)
    return me


# three walls, each in two levels: `cliffN` near the camera, `cliffN_far` with FAR of its triangles (cliffs.js)
FAR = 0.2
TARGET = 2000
KINDS = [f'cliff{i}' for i in range(3)]

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for i, kind in enumerate(KINDS):
        for far in (False, True):
            me = cliff(kind + ('_far' if far else ''), 11 + i, TARGET * (FAR if far else 1), not far)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
