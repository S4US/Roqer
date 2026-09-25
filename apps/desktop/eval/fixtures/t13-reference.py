"""Renders t13-reference.png, T13's style reference: an original scene in the
blocky stylised look (flat bright colours, red dirt cliffs with a jagged grass
edge, stacked-cube trees, lavender rocks, a pink path, a fence).

    blender --background --python t13-reference.py
"""
import bpy, math, os, random
from mathutils import Vector
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
GRASS, GRASS2, DIRT, PATH = (0.33, 0.82, 0.18, 1), (0.45, 0.9, 0.25, 1), (0.78, 0.26, 0.2, 1), (0.9, 0.45, 0.45, 1)
BARK, LEAF, LEAF2, ROCK, WOOD = (0.42, 0.16, 0.1, 1), (0.36, 0.78, 0.2, 1), (0.5, 0.88, 0.3, 1), (0.6, 0.55, 0.9, 1), (0.5, 0.22, 0.14, 1)
mats = {}
def mat(rgba):
    if rgba not in mats:
        m = bpy.data.materials.new(str(rgba)); m.diffuse_color = rgba; mats[rgba] = m
    return mats[rgba]
def box(size, loc, rgba, rot=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object; o.scale = size; o.rotation_euler[2] = rot
    o.data.materials.append(mat(rgba)); return o
# lower ground and path
box((80, 80, 1), (0, 0, -0.5), GRASS)
for i in range(9):
    box((5, 6, 0.1), (math.sin(i * 0.5) * 3 + 4, -30 + i * 5.5, 0.05), PATH, rot=math.sin(i * 0.5) * 0.3)
# raised plateaus with cliff faces and jagged grass fringe
def plateau(x, y, w, d, h):
    box((w, d, h), (x, y, h / 2), DIRT)
    box((w + 0.6, d + 0.6, 0.8), (x, y, h + 0.1), GRASS)
    for side in (-1, 1):
        t = -w / 2 + 0.8
        while t < w / 2 - 0.5:
            drop = random.choice((0.8, 1.4, 2.0, 1.1))
            box((1.2, 0.5, drop), (x + t, y + side * (d / 2 + 0.05), h - drop / 2), GRASS)
            t += 1.3
    t = -d / 2 + 0.8
    while t < d / 2 - 0.5:
        drop = random.choice((0.8, 1.4, 2.0, 1.1))
        box((0.5, 1.2, drop), (x - w / 2 - 0.05, y + t, h - drop / 2), GRASS)
        t += 1.3
plateau(-14, 8, 16, 26, 5); plateau(10, 22, 30, 14, 8); plateau(-6, 30, 14, 10, 12)
def tree(x, y, z, s):
    box((0.8 * s, 0.8 * s, 3 * s), (x, y, z + 1.5 * s), BARK)
    box((3.4 * s, 3.4 * s, 3 * s), (x, y, z + 4 * s), LEAF, rot=random.random())
    box((2.2 * s, 2.2 * s, 2 * s), (x + 0.3, y - 0.2, z + 6.2 * s), LEAF2, rot=random.random())
for x, y, z, s in ((-18, 0, 5, 1.1), (-10, 14, 5, 0.9), (4, 20, 8, 1.2), (16, 24, 8, 1.0), (-8, 32, 12, 1.1), (18, -6, 0, 1.2), (-22, -18, 0, 1.0), (12, -20, 0, 0.9)):
    tree(x, y, z, s)
for x, y in ((-4, -12), (14, 4), (-16, -6), (8, -28)):
    box((2.2, 2, 1.4), (x, y, 0.7), ROCK, rot=random.random())
for i in range(6):
    box((0.4, 0.4, 1.6), (12 + i * 2.2, -12, 0.8), WOOD)
box((12, 0.3, 0.3), (17.5, -12, 1.2), WOOD)
for i in range(30):
    box((0.3, 0.3, 0.7), (random.uniform(-30, 30), random.uniform(-34, 0), 0.35), GRASS2)
s = bpy.context.scene
cam = bpy.data.objects.new("c", bpy.data.cameras.new("c")); s.collection.objects.link(cam)
cam.location = (18, -38, 20); cam.rotation_euler = (Vector((-2, 8, 4)) - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = 32; s.camera = cam
s.render.engine = "BLENDER_WORKBENCH"; s.display.shading.light = "FLAT"; s.display.shading.show_cavity = True; s.display.shading.cavity_type = "WORLD"; s.display.shading.cavity_ridge_factor = 0.0; s.display.shading.cavity_valley_factor = 1.0; s.display.shading.color_type = "MATERIAL"
s.display.shading.show_shadows = True; s.display.shading.shadow_intensity = 0.25
s.view_settings.view_transform = "Standard"
s.world = bpy.data.worlds.new("w")
s.render.film_transparent = False
s.world.color = (0.55, 0.78, 1.0)
s.render.resolution_x, s.render.resolution_y = 640, 480
s.render.image_settings.file_format = "PNG"
s.render.filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "t13-reference.png")
bpy.ops.render.render(write_still=True)
