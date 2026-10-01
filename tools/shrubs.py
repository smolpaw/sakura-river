# The shrubs (src/vegetation.js shrubData places them), built in Blender like the woods' crowns (tools/forest.py).
# Run through tools/blender.mjs:
#   blender -b --factory-startup -P tools/shrubs.py -- <out.glb>
# Each kind is one mesh, one unit tall, standing on its origin (Blender: z up; glTF: y up), in three levels as the
# woods' trees (`name`, `name_far`, `name_dist`): a mound of leafy clumps fused into one surface, no wood showing.
# Azaleas (tsutsuji) dense and rounded, one kind in its April bloom of magenta, one of white; kerria (yamabuki), a
# looser, taller arching mound with yellow flowers; dwarf bamboo (sasa), low and bright, flat-topped, along the
# woods' edges. Shading in the vertex colours, how much is in flower in their alpha.
import bpy, math, os, random, sys
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forest import foliage, assemble, tris, smoothstep, lerp, LEVELS, CROWN, VOXEL

V = Vector


def mound(name, seed, *, ex, n, size, flat, col, target, flowers=None, arch=0.0, rough=(0.012, 16), level=0):
    """clumps over a dome ex wide (each way) and one unit tall, the upper side favoured; flowers: (kind, share of the
    surface); arch: the outer clumps droop (kerria's arching canes); rough: the leafy roughness (amplitude, frequency)"""
    rng = random.Random(seed)
    clumps, tries = [], 0
    while len(clumps) < n and tries < 20000:
        tries += 1
        d = V((rng.gauss(0, 1), rng.gauss(0, 1), abs(rng.gauss(0, 1)) + 0.15)).normalized()
        depth = rng.uniform(0.6, 0.95)
        r = math.hypot(d.x, d.y) * depth
        p = V((d.x * ex * depth, d.y * ex * depth, 0.5 + (d.z * depth - 0.15) * 0.62 - arch * r * r))
        s = size * rng.uniform(0.75, 1.2)
        if any((p - c).length < 0.62 * (s + q[0]) for c, q in clumps):
            continue
        clumps.append((p, (s, s, s * flat)))
    for _ in range(n // 4):  # a core, so it is solid to the ground
        clumps.append((V((rng.uniform(-0.35, 0.35) * ex, rng.uniform(-0.35, 0.35) * ex, rng.uniform(0.2, 0.5))), (size,) * 2 + (size * flat,)))
    me = foliage(clumps, VOXEL[level] * 0.009, rough[0], rough[1], target * CROWN[level], seed)
    me = assemble(name + LEVELS[level], [(me, col)], None, lambda p: V((0, 0, 0.15)), 0.7, 0.45, 0.25, None, 0.45)
    # flowers: the page breaks them into small spots (materials.js shrubMaterial); here only how much of the surface
    # round each vertex is in flower (more on what faces up and out) and which kind, packed into the colour's alpha
    # as (kind + share) / 4: kind 1 magenta, 2 white, 3 yellow; 0 none
    ca = me.color_attributes['Color']
    for i, v in enumerate(me.vertices):
        c = ca.data[i].color
        a = 0.0
        if flowers:
            kind, share = flowers
            out = (v.co - V((0, 0, 0.15))).normalized()
            a = (kind + min(0.98, share * lerp(0.35, 1.5, smoothstep(-0.4, 0.6, out.z)))) / 4
        ca.data[i].color = (c[0], c[1], c[2], a)
    return me


KINDS = {
    'azalea': lambda level: mound('azalea', 11, ex=0.8, n=80, size=0.15, flat=0.85, col=(0.05, 0.11, 0.035), target=2400,
                                  flowers=(1, 0.45), level=level),
    'azalea_w': lambda level: mound('azalea_w', 12, ex=0.75, n=75, size=0.155, flat=0.85, col=(0.055, 0.12, 0.04), target=2400,
                                    flowers=(2, 0.38), level=level),
    'kerria': lambda level: mound('kerria', 13, ex=0.6, n=60, size=0.13, flat=1.1, col=(0.1, 0.2, 0.05), target=2000,
                                  flowers=(3, 0.2), arch=0.35, level=level),
    'sasa': lambda level: mound('sasa', 14, ex=1.2, n=90, size=0.17, flat=0.6, col=(0.13, 0.24, 0.06), target=1800, level=level),
}

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for kind in KINDS:
        for level in range(len(LEVELS)):
            me = KINDS[kind](level)
            print(f'{me.name}: {tris(me)} triangles, {len(me.vertices)} vertices')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                              export_texcoords=False, export_yup=True)
