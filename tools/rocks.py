# The boulders along the river's banks and in its shallows, and the stones at its edge (src/vegetation.js rocksData
# places them), built in Blender. Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/rocks.py -- <out.glb>
# A boulder is one mesh about 2.5 wide, 2 deep and 1.2 tall round its origin, its base where it sits in the ground
# (Blender: z up; glTF: y up). The boulders are photogrammetry scans from Poly Haven (CC0, README.md Models),
# downloaded once into tools/.model-cache/ and simplified to each level's triangles from the full scan. The stone at
# the water's edge (and in the village's walls) is modelled here: granite rounded by the water, with a broad face where
# it split. Shading in the vertex colours: each stone its own grey, mottled by the scan's own light and dark (the
# modelled stone by noise), the scan's occlusion, lichen on what faces the sky, moss in patches on top, ambient
# occlusion in the hollows and under the base. Each also has a `_near` model for the Ultra tier, from more of the
# scan's triangles (the modelled stone: a finer sphere, grained and pitted, shaded as the full one, forest.py
# colour_at).
import bpy, bmesh, json, math, os, random, sys, urllib.request
import numpy as np
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import smoothstep, lerp, link, evaluated, tris, vertex_ao, colour_at

V = Vector
GREYS = [(0.34, 0.33, 0.31), (0.3, 0.3, 0.29), (0.37, 0.35, 0.32), (0.28, 0.28, 0.28), (0.33, 0.31, 0.29)]
LICHEN, MOSS = (0.5, 0.5, 0.42), (0.1, 0.16, 0.045)


def smin(a, b, k):
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


def stone(name, seed, target, *, splits, lumps, moss, grey, ref=None):
    rng = random.Random(seed)
    off = V((seed * 3.7, seed * 1.3, seed * 5.9))
    # the faces it split along: planes cutting the ball, their edges rounded off by the smooth minimum
    planes = []
    for _ in range(splits):
        n = V((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 0.6))).normalized()
        planes.append((n, rng.uniform(0.62, 0.85)))
    sx, sy = 1 + rng.uniform(-0.3, 0.3), 1 + rng.uniform(-0.25, 0.25)
    # the near model's grain and chips: fine bumps, and small pits where flakes came away
    grain = lambda d: 0.004 * noise.noise(d * 45 + off) + 0.002 * noise.noise(d * 90 + off)
    pit = lambda d: smoothstep(0.45, 0.7, noise.noise(d * 28 + off * 1.7))
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=6 if ref else 5, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized()
        r = 1 + lumps * (0.24 * noise.noise(d * 1.1 + off) + 0.09 * noise.noise(d * 2.4 + off * 1.3))
        for n, pd in planes:
            c = d.dot(n)
            if c > 0.05:
                r = smin(r, pd / c, 0.12)
        r += 0.035 * noise.noise(d * 4 + off) + 0.015 * noise.noise(d * 9 + off) + 0.006 * noise.noise(d * 19 + off)
        if ref:
            r += grain(d) - 0.008 * pit(d)
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
    full_at = ref and colour_at(ref)
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
        full = ref and full_at(p)
        if full:
            # the full model's shading, and the fine detail: speckled grain, pits in shadow, lichen in small rosettes
            d = V((p.x / (1.25 * sx), p.y / (1.05 * sy), p.z / 0.72)).normalized()
            c = V(full[:3]) * (0.92 + 0.16 * noise.noise(p * 9 + off)) * (1 - 0.3 * pit(d))
            c = c.lerp(V(LICHEN) * 0.9, 0.3 * smoothstep(0.5, 0.65, noise.noise(p * 11 + off * 3)) * smoothstep(0.0, 0.6, n.z))
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


# ---------- the scanned boulders ----------
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.model-cache', 'scans')
AREA, TALL, BASE = 2.25, 1.3, -0.38  # the boulder's footprint (the square root of its box's, m at scale 1), its tallest, and where its base sits


def fetch(asset):
    """The scan's glTF (1k textures) in the cache, downloaded with its buffer and textures the first time."""
    d = os.path.join(CACHE, asset)
    get = lambda url: urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'sakura-river tools/rocks.py'}))
    files = json.load(get(f'https://api.polyhaven.com/files/{asset}'))['gltf']['1k']['gltf']
    gltf = os.path.join(d, os.path.basename(files['url']))
    for rel, f in [(os.path.basename(files['url']), files)] + list(files['include'].items()):
        dst = os.path.join(d, rel)
        if not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with get(f['url']) as r, open(dst, 'wb') as w:
                w.write(r.read())
    return gltf


def load_scan(asset, part):
    """The scan as one mesh object, fitted to a boulder's size (AREA, TALL) round the origin, its base at BASE, and
    its colour and occlusion maps; `part`: which of its loose pieces, largest first, when it holds several stones."""
    gltf = fetch(asset)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=gltf)
    obs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # (some scans come as loose triangles, which the decimation cannot collapse: weld their shared corners)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(ob.data)
    bm.free()
    if part is not None:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='LOOSE')
        bpy.ops.object.mode_set(mode='OBJECT')
        pieces = sorted(bpy.context.selected_objects, key=lambda o: -len(o.data.vertices))
        ob = pieces[part]
        for o in pieces:
            if o is not ob:
                bpy.data.objects.remove(o)
    me = ob.data
    lo = [min(v.co[i] for v in me.vertices) for i in range(3)]
    hi = [max(v.co[i] for v in me.vertices) for i in range(3)]
    s = min(AREA / math.sqrt((hi[0] - lo[0]) * (hi[1] - lo[1])), TALL / (hi[2] - lo[2]))
    # (the longer way across along x, as the modelled boulders lie)
    turn = hi[1] - lo[1] > hi[0] - lo[0]
    for v in me.vertices:
        x, y, z = (v.co.x - (lo[0] + hi[0]) / 2) * s, (v.co.y - (lo[1] + hi[1]) / 2) * s, (v.co.z - lo[2]) * s + BASE
        v.co = V((-y, x, z)) if turn else V((x, y, z))
    tex = {k: bpy.data.images.load(os.path.join(os.path.dirname(gltf), 'textures', f'{asset}_{k}_1k.jpg')) for k in ('diff', 'arm')}
    return ob, tex


def pixels(img, size):
    """An image's pixels shrunk to size x size (the area a vertex of a coarse model stands for), as an array [y, x, c]."""
    c = img.copy()
    c.scale(size, size)
    a = np.array(c.pixels[:], dtype=np.float32).reshape(size, size, 4)
    bpy.data.images.remove(c)
    return a


def scanned(name, src, tex, target, *, grey, moss, size):
    """A boulder from the scan `src` (load_scan), simplified to `target` triangles and shaded in its vertex colours:
    our grey for the stone (each its own), its light and dark and its occlusion from the scan's maps (shrunk to `size`
    pixels across), lichen and moss as on the modelled stones."""
    me = src.data.copy()
    ob = link(me, name + '_tmp')
    dec = ob.modifiers.new('decimate', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, tris(me)))
    dec.use_collapse_triangulate = True
    me = evaluated(ob)
    diff, arm = pixels(tex['diff'], size), pixels(tex['arm'], size)
    lum = lambda a: 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    srgb = lambda c: np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    dl = lum(srgb(diff[..., :3]))
    mean = float(dl.mean())
    uv = me.uv_layers.active.data
    acc = [[0.0, 0.0, 0] for _ in me.vertices]  # per vertex: the scan's brightness against its mean, its occlusion
    for poly in me.polygons:
        for li in poly.loop_indices:
            u, v = uv[li].uv
            x, y = int(u % 1.0 * (size - 1) + 0.5), int(v % 1.0 * (size - 1) + 0.5)
            a = acc[me.loops[li].vertex_index]
            a[0] += dl[y, x] / mean; a[1] += arm[y, x, 0]; a[2] += 1
    off = V((len(name) * 3.7, 1.3, 5.9))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.verts.index_update()
    ao = vertex_ao(bm, 0.5)
    cols = []
    for v in bm.verts:
        p, n, a = v.co, v.normal, ao[v.index]
        k = acc[v.index]
        rel, occ = (k[0] / k[2], k[1] / k[2]) if k[2] else (1.0, 1.0)
        c = V(grey) * max(0.45, min(1.7, rel ** 0.9)) * lerp(0.6, 1.0, occ)
        lich = smoothstep(0.35, 0.55, noise.noise(p * 5.5 + off * 2)) * smoothstep(-0.1, 0.5, n.z)
        c = c.lerp(V(LICHEN), lich * 0.3)
        m = smoothstep(0.35, 0.75, n.z + 0.5 * noise.noise(p * 1.6 + off * 0.7) + 0.2 * noise.noise(p * 7 + off)) * moss
        c = c.lerp(V(MOSS) * (0.8 + 0.4 * noise.noise(p * 9 + off)), m)
        c *= lerp(0.65, 1.0, a) * lerp(0.6, 1.0, smoothstep(BASE + 0.15, BASE + 0.6, p.z))
        cols.append(c)
    for f in bm.faces:
        f.smooth = True
    out = bpy.data.meshes.new(name)
    bm.to_mesh(out)
    bm.free()
    out.validate()
    while out.uv_layers:
        out.uv_layers.remove(out.uv_layers[0])
    out.materials.clear()
    ca = out.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(cols):
        ca.data[i].color = (*c, 1.0)
    out.color_attributes.active_color = ca
    link(out, name)
    return out


# five boulders, each full (`rockN`), far (`rockN_far`) and near (`rockN_near`), and one stone for the pebbles at the
# water's edge (and the village's stone walls, with a far one), and its near one
KINDS = [f'rock{i}' for i in range(5)]
TARGET, FAR, NEAR = 1200, 0.25, 4
# the scan (Poly Haven asset, which loose piece of it or None) and moss
SCANS = [('namaqualand_boulder_04', None, 0.6), ('namaqualand_boulder_06', None, 0.7), ('namaqualand_boulder_05', None, 0.4),
         ('boulder_01', None, 0.8), ('namaqualand_boulders_01', 0, 0.55)]

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    full = {}
    scans = []
    for i, kind in enumerate(KINDS):
        asset, part, m = SCANS[i]
        src, tex = load_scan(asset, part)
        src.hide_set(True)
        scans.append((src, tex))
        for far in (False, True):
            me = scanned(kind + ('_far' if far else ''), src, tex, TARGET * (FAR if far else 1), grey=GREYS[i], moss=m, size=32 if far else 64)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    me = full['pebble'] = stone('pebble', 61, 90, splits=1, lumps=0.6, moss=0.15, grey=(0.46, 0.44, 0.41))
    print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    # the same stone, lighter, for the farmhouses' stone walls seen from further off
    me = stone('pebble_far', 61, 24, splits=1, lumps=0.6, moss=0.15, grey=(0.46, 0.44, 0.41))
    print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    # the near models (the Ultra tier's, which tools/blender.mjs puts in public/models/): the same stones on a finer
    # sphere, grained and chipped, shaded as the full ones (forest.py colour_at)
    for i, kind in enumerate(KINDS):
        src, tex = scans[i]
        me = scanned(kind + '_near', src, tex, TARGET * NEAR, grey=GREYS[i], moss=SCANS[i][2], size=256)
        print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    for src, _ in scans:
        bpy.data.objects.remove(src)
    for o in [o for o in bpy.data.objects if o.type != 'MESH' or o.name.endswith('_tmp')]:
        bpy.data.objects.remove(o)
    me = stone('pebble_near', 61, 360, splits=1, lumps=0.6, moss=0.15, grey=(0.46, 0.44, 0.41), ref=full['pebble'])
    print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
