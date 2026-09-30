# The boulders along the river's banks and in its shallows, and the stones at its edge (src/vegetation.js rocksData
# places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/rocks.py -- <out.glb>
# A boulder is one mesh about 2.5 wide, 2.1 deep and 1.4 tall round its origin, its base flattened where it sits in the
# ground (Blender: z up; glTF: y up). River boulders: granite rounded by the water, some with the broad faces where
# they split, rounded off at the edges; lumpy, grained. Shading in the vertex colours: each stone its own grey,
# mottled, lichen on what faces the sky, moss in patches on top, ambient occlusion in the hollows and under the base.
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, evaluated, tris, vertex_ao

V = Vector
GREYS = [(0.34, 0.33, 0.31), (0.3, 0.3, 0.29), (0.37, 0.35, 0.32), (0.28, 0.28, 0.28), (0.33, 0.31, 0.29)]
LICHEN, MOSS = (0.5, 0.5, 0.42), (0.1, 0.16, 0.045)


def smin(a, b, k):
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


def stone(name, seed, target, *, splits, lumps, moss, grey):
    rng = random.Random(seed)
    off = V((seed * 3.7, seed * 1.3, seed * 5.9))
    # the faces it split along: planes cutting the ball, their edges rounded off by the smooth minimum
    planes = []
    for _ in range(splits):
        n = V((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 0.6))).normalized()
        planes.append((n, rng.uniform(0.62, 0.85)))
    sx, sy = 1 + rng.uniform(-0.3, 0.3), 1 + rng.uniform(-0.25, 0.25)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=5, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized()
        r = 1 + lumps * (0.24 * noise.noise(d * 1.1 + off) + 0.09 * noise.noise(d * 2.4 + off * 1.3))
        for n, pd in planes:
            c = d.dot(n)
            if c > 0.05:
                r = smin(r, pd / c, 0.12)
        r += 0.035 * noise.noise(d * 4 + off) + 0.015 * noise.noise(d * 9 + off) + 0.006 * noise.noise(d * 19 + off)
        p = d * r
        p = V((p.x * 1.25 * sx, p.y * 1.05 * sy, p.z * 0.72))
        if p.z < -0.18:
            p.z = -0.18 + (p.z + 0.18) * 0.35  # the base sits flat in the ground
        v.co = p
    me = bpy.data.meshes.new('ball')
    bm.to_mesh(me)
    bm.free()
    ob = link(me, 'ball')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    me = evaluated(ob)

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, 0.5)
    # how far each vertex stands out of its neighbours along the normal: edges catch the light, hollows hold dirt
    bulge = [sum((v.co - e.other_vert(v).co).dot(v.normal) for e in v.link_edges) / max(1, len(v.link_edges)) for v in bm.verts]
    bulge = [sum([bulge[v.index]] + [bulge[e.other_vert(v).index] for e in v.link_edges]) / (1 + len(v.link_edges)) for v in bm.verts]
    cols = []
    for v in bm.verts:
        p, n, a = v.co, v.normal, ao[v.index]
        edge = max(-1.0, min(1.0, bulge[v.index] / 0.02))
        c = V(grey) * (0.86 + 0.16 * noise.noise(p * 2.2 + off) + 0.1 * noise.noise(p * 6.5 + off))
        # pale lichen rosettes on what faces the sky
        lich = smoothstep(0.35, 0.55, noise.noise(p * 5.5 + off * 2)) * smoothstep(-0.1, 0.5, n.z)
        c = c.lerp(V(LICHEN), lich * 0.35)
        # moss in patches over the top and in its hollows
        m = smoothstep(0.35, 0.75, n.z + 0.5 * noise.noise(p * 1.6 + off * 0.7) + 0.2 * noise.noise(p * 7 + off)) * moss
        c = c.lerp(V(MOSS) * (0.8 + 0.4 * noise.noise(p * 9 + off)), m)
        c *= lerp(0.5, 1.0, a) * lerp(0.6, 1.0, smoothstep(-0.2, 0.25, p.z)) * (1 + 0.3 * edge if edge > 0 else 1 + 0.45 * edge)
        cols.append(c)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate()
    ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    me.color_attributes.active_color = ca
    link(me, name)
    return me


# five boulders, each near (`rockN`) and far (`rockN_far`), and one stone for the pebbles at the water's edge
KINDS = [f'rock{i}' for i in range(5)]
TARGET, FAR = 1200, 0.25
# split faces, lumpiness, moss
LOOKS = [(3, 0.8, 0.6), (1, 1.0, 0.7), (4, 0.6, 0.4), (0, 1.1, 0.8), (2, 0.9, 0.55)]

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for i, kind in enumerate(KINDS):
        s, l, m = LOOKS[i]
        for far in (False, True):
            me = stone(kind + ('_far' if far else ''), 31 + i, TARGET * (FAR if far else 1), splits=s, lumps=l, moss=m, grey=GREYS[i])
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    me = stone('pebble', 61, 90, splits=1, lumps=0.6, moss=0.15, grey=(0.46, 0.44, 0.41))
    print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
