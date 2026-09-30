# The bamboo groves' stands (src/vegetation.js bambooData places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/bamboo.py -- <out.glb>
# A stand is one mesh, one unit tall, standing on its origin (Blender: z up; glTF: y up): a clump of moso culms, from
# fresh green (young) to yellowed grey (old), leaning a little and arching over at the top under sprays of leaves that
# droop along short branches from their upper half (foliage clumps fused into one surface, as the woods' crowns are).
# Shading in the vertex colours: ambient occlusion over the whole stand, the sprays' undersides darker.
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, tris, foliage, tube, vertex_ao, LEVELS, VOXEL

V = Vector
CULM, YOUNG, OLD = (0.3, 0.34, 0.12), (0.2, 0.32, 0.08), (0.42, 0.4, 0.24)
LEAF = (0.17, 0.27, 0.05)
CROWN = (1, 0.22, 0.07)  # the sprays' triangles per level (far culms lose their nodes and a side too)


def stand(name, seed, level, target):
    rng = random.Random(seed)
    culms, clumps = [], []
    for i in range(14):
        a, r = rng.uniform(0, math.tau), 0.13 * math.sqrt(rng.random())
        base = V((math.cos(a) * r, math.sin(a) * r, -0.03))
        out = V((math.cos(a), math.sin(a), 0)) * rng.uniform(0.02, 0.07) + V((rng.gauss(0, 0.02), rng.gauss(0, 0.02), 0))
        h, arch = rng.uniform(0.78, 1.0), rng.uniform(0.06, 0.14)
        side = out.normalized() if out.length > 1e-4 else V((1, 0, 0))
        # up with a lean, the top third arching over the way it leans
        path = lambda t, base=base, out=out, h=h, arch=arch, side=side: base + V((0, 0, h * t)) + out * t + side * arch * t ** 3 - V((0, 0, arch * 0.5 * t ** 4))
        culms.append((path, rng.uniform(0.0045, 0.007) * h, rng.random()))
        # branches from the upper half, each a spray of leaves drooping along it: a chain of small clumps, lower and
        # smaller towards its tip, overlapping those of the branches round it into one ragged canopy
        for k in range((10, 8, 6)[level]):
            t = rng.uniform(0.5, 1.0)
            p = path(t)
            b = rng.uniform(0, math.tau)
            L = rng.uniform(0.04, 0.08) * (1.25 - t * 0.5)
            s0 = rng.uniform(0.016, 0.022) * (1.4 if level else 1.0)
            for j in range(3 if level < 2 else 2):
                f = (j + 1) / 3
                s = s0 * (1.15 - 0.3 * f)
                q = p + V((math.cos(b), math.sin(b), 0)) * L * f - V((0, 0, L * 0.45 * f * f))
                clumps.append((q, (s * 1.3, s * 1.3, s * 0.55)))
    crown = foliage(clumps, VOXEL[level] * 0.007, 0.008, 60, target * CROWN[level], seed)
    bm = bmesh.new()
    rings = (14, 8, 5)[level]
    age = bm.verts.layers.float.new('age')
    for path, r, a in culms:
        n0 = len(bm.verts)
        pts = [path(j / rings * 0.97) for j in range(rings + 1)]
        tube(bm, pts, [r * lerp(1.0, 0.45, j / rings) for j in range(rings + 1)], (6, 4, 3)[level])
        bm.verts.ensure_lookup_table()
        for v in bm.verts[n0:]:
            v[age] = a
    ages = [v[age] for v in bm.verts]
    bm.verts.layers.float.remove(age)
    culm = bpy.data.meshes.new('culms')
    bm.to_mesh(culm)
    bm.free()

    # assembly: sprays and culms in one mesh, occlusion over both, colours by part
    bm = bmesh.new()
    part = bm.verts.layers.int.new('part')
    culm_age = bm.verts.layers.float.new('age')
    for me, k in ((crown, 0), (culm, 1)):
        n0 = len(bm.verts)
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        for i, v in enumerate(bm.verts[n0:]):
            v[part] = k
            v[culm_age] = ages[i] if k else 0.0
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, 0.12, lambda a, b: a[part] == b[part])
    cols, nors = [], []
    for v in bm.verts:
        n, a = v.normal, ao[v.index]
        if v[part]:
            # each culm its own age: young ones fresh green, old ones yellowed and grey with bloom; darker low down
            g = v[culm_age]
            c = V(CULM).lerp(V(OLD), smoothstep(0.5, 1.0, g)).lerp(V(YOUNG), smoothstep(0.3, 0.0, g))
            c = c * lerp(0.7, 1.0, smoothstep(0.0, 0.4, v.co.z)) * lerp(0.5, 1.0, a)
            nors.append(n.copy())
        else:
            c = V(LEAF) * lerp(0.4, 1.0, a) * lerp(0.6, 1.0, smoothstep(-0.6, 0.6, n.z)) * (0.85 + 0.3 * noise.noise(v.co * 12 + V((2.2, 0, 0))))
            nors.append(n.lerp(V((0, 0, 1)), 0.35).normalized())  # the sprays lit softly, as one mass
        cols.append(c)
    bm.verts.layers.int.remove(part)
    bm.verts.layers.float.remove(culm_age)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()
    me.normals_split_custom_set_from_vertices(nors)
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    link(me, name)
    return me


# two stands, each in three levels (as the woods' trees: `bambooN`, `bambooN_far`, `bambooN_dist`)
KINDS = ['bamboo0', 'bamboo1']
TARGET = 2600

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for i, kind in enumerate(KINDS):
        for level in range(len(LEVELS)):
            me = stand(kind + LEVELS[level], 21 + i, level, TARGET)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
