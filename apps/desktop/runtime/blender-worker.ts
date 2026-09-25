import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_BLENDER_JOB_SECONDS,
  MAX_BLENDER_JOB_SECONDS,
  MAX_BLENDER_SCRIPT_CHARACTERS,
} from "../shared/blender";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";

/**
 * Runs one model-written Blender script and checks what it made.
 *
 * Each job gets its own folder under Roqer's data folder. The script runs in a
 * background Blender started from factory settings on an empty scene, through
 * a short wrapper of Roqer's own that hands it `OUTPUT_DIR` and reports a
 * failure with its traceback. Nothing the script says about its result is
 * taken on trust: every model file it leaves in `OUTPUT_DIR` is re-imported by
 * a second Blender pass Roqer wrote, which counts its triangles, meshes and
 * materials, measures it, and renders a framed preview the model then sees.
 *
 * The script runs with the user's own permissions; nothing here sandboxes it.
 * That is why the operation is irreversible under the approval policy, why its
 * environment is stripped of anything that looks like a credential, and why a
 * cancelled or overdue job takes Blender's whole process tree down with it.
 */

const MODEL_EXTENSIONS = new Set([".glb", ".gltf", ".fbx", ".obj"]);
const MAX_INSPECTED_MODELS = 3;
const MAX_RENDERED_IMAGES = 4;
/** Roblox stores an uploaded image at most this many pixels a side. */
const MAX_UPLOAD_IMAGE_SIDE = 1024;
/** The inspection re-imports, measures the layout (itself capped at 12 s) and renders four views. */
const INSPECT_TIMEOUT_MS = 45_000;
const MAX_LOG_CHARACTERS = 4_000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Old jobs are cleared once they are this old; a model to upload is uploaded within the day. */
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_KEPT_JOBS = 40;

const DONE_MARKER = "ROQER_SCRIPT_DONE";
const FAILED_MARKER = "ROQER_SCRIPT_FAILED";
const INSPECT_MARKER = "ROQER_INSPECT ";

/**
 * Roqer's modeling helpers, loaded before the model's script as roqer.<name>.
 * They place parts by where they start and end instead of by rotation angles,
 * the direction of which models often get wrong, and keep joined parts
 * flat-shaded in one vertex-colour material. Roqer's own code, not the model's.
 */
export const HELPERS_SCRIPT = String.raw`"""Roqer's modeling helpers, available to every Blender job as roqer.<name>.

Each takes positions in Blender units (studs) and places a part by where it
starts and ends rather than by rotation angles, builds its mesh directly
(no selection or context), and paints it when given a colour.
"""
import bpy, bmesh
from mathutils import Vector

_COLOR_LAYER = "Col"


def _vector(value, name):
    try:
        vector = Vector(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be three numbers, got {value!r}") from None
    if len(vector) != 3:
        raise ValueError(f"{name} must be three numbers, got {value!r}")
    return vector


def _positive(value, name):
    if not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{name} must be a positive number of studs, got {value!r}")
    return float(value)


def paint(obj, rgba):
    """Colour every corner of an object's mesh; the colour travels in the GLB as vertex colour."""
    if len(rgba) == 3:
        rgba = (*rgba, 1.0)
    mesh = obj.data
    layer = mesh.color_attributes.get(_COLOR_LAYER) or mesh.color_attributes.new(_COLOR_LAYER, "BYTE_COLOR", "CORNER")
    for corner in layer.data:
        corner.color = rgba
    mesh.color_attributes.active_color = layer
    return obj


def _object(name, bm, rgba):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if rgba is not None:
        paint(obj, rgba)
    return obj


def _frame(start, end, across):
    """Unit vectors: along start to end, the given width direction made perpendicular, and the third."""
    along = end - start
    if along.length < 1e-6:
        raise ValueError("start and end are the same point")
    along = along.normalized()
    side = across - along * across.dot(along)
    if side.length < 1e-6:
        side = Vector((1, 0, 0)) - along * along.x
        if side.length < 1e-6:
            side = Vector((0, 1, 0)) - along * along.y
    side = side.normalized()
    return along, side, along.cross(side).normalized()


def box(name, size, center, rgba=None):
    """An upright box of the given size (x, y, z), centred on center."""
    size = _vector(size, "size")
    for value, axis in zip(size, "xyz"):
        _positive(value, f"size {axis}")
    half = size / 2
    return box_between(name, _vector(center, "center") - Vector((0, 0, half.z)), _vector(center, "center") + Vector((0, 0, half.z)),
                       width=size.x, thickness=size.y, width_axis=(1, 0, 0), rgba=rgba)


def box_between(name, start, end, width, thickness, width_axis=(1, 0, 0), rgba=None):
    """A box running from start to end, width wide along width_axis and thickness deep across both.

    A leaning seat back runs from its bottom edge to its top edge; a sloping panel from its low
    end to its high end. No rotation angle to get the direction of wrong.
    """
    start, end = _vector(start, "start"), _vector(end, "end")
    width, thickness = _positive(width, "width"), _positive(thickness, "thickness")
    along, side, normal = _frame(start, end, _vector(width_axis, "width_axis"))
    bm = bmesh.new()
    corners = []
    for point in (start, end):
        for s in (-0.5, 0.5):
            for t in (-0.5, 0.5):
                corners.append(bm.verts.new(point + side * (s * width) + normal * (t * thickness)))
    for ids in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        bm.faces.new([corners[i] for i in ids])
    return _object(name, bm, rgba)


def cylinder_between(name, start, end, radius, rgba=None, vertices=12):
    """A cylinder whose end caps sit at start and end: a bar, a pipe, a column, an axle or a wheel."""
    start, end = _vector(start, "start"), _vector(end, "end")
    radius = _positive(radius, "radius")
    if not isinstance(vertices, int) or vertices < 3:
        raise ValueError(f"vertices must be a whole number of at least 3, got {vertices!r}")
    along, side, normal = _frame(start, end, Vector((1, 0, 0)) if abs((end - start).normalized().x) < 0.9 else Vector((0, 1, 0)))
    import math
    bm = bmesh.new()
    rings = []
    for point in (start, end):
        rings.append([bm.verts.new(point + (side * math.cos(2 * math.pi * k / vertices) + normal * math.sin(2 * math.pi * k / vertices)) * radius)
                      for k in range(vertices)])
    for k in range(vertices):
        n = (k + 1) % vertices
        bm.faces.new((rings[0][k], rings[0][n], rings[1][n], rings[1][k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[1])
    return _object(name, bm, rgba)


def vertex_color_material(name="VertexColour"):
    """One material that shows the vertex colours; without it the glTF export leaves them out."""
    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        nodes = material.node_tree.nodes
        colors = nodes.new("ShaderNodeVertexColor")
        colors.layer_name = _COLOR_LAYER
        material.node_tree.links.new(colors.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    return material


def join(name, objects):
    """Join parts that never move apart into one flat-shaded object with the vertex-colour material.

    Keep anything that must move on its own (a wheel, a lid, a door) out of the list and join it separately.
    """
    objects = [obj for obj in objects if obj is not None]
    if not objects:
        raise ValueError("join needs at least one object")
    first = objects[0]
    if len(objects) > 1:
        with bpy.context.temp_override(active_object=first, selected_editable_objects=objects, selected_objects=objects):
            bpy.ops.object.join()
    first.name = name
    first.data.name = name
    first.data.materials.clear()
    first.data.materials.append(vertex_color_material())
    first.data.polygons.foreach_set("use_smooth", [False] * len(first.data.polygons))
    first.data.update()
    return first
`;

/** Roqer's wrapper around the model's script. */
export const RUNNER_SCRIPT = String.raw`import bpy, os, sys, traceback, types

job_dir = sys.argv[sys.argv.index("--") + 1]
OUTPUT_DIR = os.path.join(job_dir, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
script_path = os.path.join(job_dir, "script.py")
with open(script_path, "r", encoding="utf-8") as handle:
    source = handle.read()
helpers = {"__name__": "roqer"}
with open(os.path.join(job_dir, "roqer_helpers.py"), "r", encoding="utf-8") as handle:
    exec(compile(handle.read(), "roqer_helpers.py", "exec"), helpers)
roqer = types.SimpleNamespace(**{name: value for name, value in helpers.items()
                                 if callable(value) and not name.startswith("_") and getattr(value, "__module__", None) == "roqer"})
namespace = {"__name__": "__main__", "__file__": script_path, "OUTPUT_DIR": OUTPUT_DIR, "bpy": bpy, "roqer": roqer}
try:
    exec(compile(source, script_path, "exec"), namespace)
except BaseException:
    traceback.print_exc()
    print("${FAILED_MARKER}", flush=True)
    sys.exit(1)
print("${DONE_MARKER}", flush=True)
`;

/**
 * Roqer's own check of one exported model: measure it, lay out how its pieces
 * sit against each other, and render four views of it in one preview image.
 */
export const INSPECT_SCRIPT = String.raw`import bpy, bmesh, os, sys, json, math, time
from mathutils import Vector
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index("--") + 1:]
model_path, preview_path = args[0], args[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
extension = os.path.splitext(model_path)[1].lower()
if extension in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=model_path)
elif extension == ".fbx":
    bpy.ops.import_scene.fbx(filepath=model_path)
elif extension == ".obj":
    bpy.ops.wm.obj_import(filepath=model_path)

scene = bpy.context.scene
meshes = [item for item in scene.objects if item.type == "MESH"]
depsgraph = bpy.context.evaluated_depsgraph_get()
triangles = 0
materials = set()
low = Vector((math.inf, math.inf, math.inf))
high = Vector((-math.inf, -math.inf, -math.inf))
for item in meshes:
    evaluated = item.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    evaluated.to_mesh_clear()
    for corner in item.bound_box:
        point = item.matrix_world @ Vector(corner)
        low = Vector(map(min, low, point))
        high = Vector(map(max, high, point))
    for slot in item.material_slots:
        if slot.material is not None:
            materials.add(slot.material.name)

# Where the colour lives decides both what Roblox shows and how to preview it:
# a packed image texture and vertex colours survive upload, a flat material
# colour does not (every such MeshPart arrives white).
textured = any(
    node.type == "TEX_IMAGE" and node.image is not None
    for material in bpy.data.materials if material.use_nodes and material.node_tree is not None
    for node in material.node_tree.nodes
)
vertex_colored = any(len(item.data.color_attributes) > 0 for item in meshes)
color_source = "vertex" if vertex_colored else "texture" if textured else "material"
# Each object's own name and size, so a kit set exported as one file can be told
# apart after upload: Roblox keeps one MeshPart per object, named after it.
objects = []
for item in meshes[:16]:
    corners = [item.matrix_world @ Vector(corner) for corner in item.bound_box]
    lo = Vector(map(min, *corners))
    hi = Vector(map(max, *corners))
    # Roblox axes: X, then Blender's up (Z) as Y, then Blender's Y as Z.
    objects.append({"name": item.name, "size": [round(hi.x - lo.x, 2), round(hi.z - lo.z, 2), round(hi.y - lo.y, 2)]})
stats = {"meshes": len(meshes), "triangles": triangles, "materials": sorted(materials)[:32], "preview": False,
         "colorSource": color_source, "objects": objects}

# Smooth shading across hard edges: a corner whose normal leans far from its
# face's is shaded as if the edge were rounded, which makes boxes and panels
# look puffy. A genuinely curved surface bends each corner only slightly.
smooth = []
for item in meshes:
    mesh = item.data
    if hasattr(mesh, "corner_normals"):
        normals = [corner.vector for corner in mesh.corner_normals]
    else:
        mesh.calc_normals_split()
        normals = [loop.normal for loop in mesh.loops]
    if not normals:
        continue
    bent = sum(1 for poly in mesh.polygons for i in poly.loop_indices if normals[i].dot(poly.normal) < 0.9)
    share = bent / len(normals)
    if share > 0.2:
        smooth.append({"object": item.name, "share": round(share, 2)})
stats["smoothShaded"] = smooth[:8]

# Layout: how the model's pieces sit against each other, in the script's own
# Blender coordinates. A script usually joins many primitives into one object,
# so each object is split back into its loose pieces (after welding the
# vertices the exporter split for flat shading) and the pieces are compared.
TOUCH = 0.03
MAX_PIECES = 300
MAX_SAMPLES = 400
LAYOUT_SECONDS = 12.0
RAYS = [Vector(d).normalized() for d in ((0.5773, 0.5774, 0.5775), (-0.31, 0.83, 0.46), (0.71, -0.2, 0.67))]
r2 = lambda value: round(value, 2)


class Piece:
    def __init__(self, owner, verts, faces, edges, closed):
        self.owner, self.verts, self.faces, self.closed = owner, verts, faces, closed
        self.tree = BVHTree.FromPolygons(verts, faces)
        self.low = Vector(map(min, *verts))
        self.high = Vector(map(max, *verts))
        length = sum((verts[b] - verts[a]).length for a, b in edges)
        step = max(0.08, length / MAX_SAMPLES)
        samples = list(verts)
        for a, b in edges:
            count = int((verts[b] - verts[a]).length / step)
            samples.extend(verts[a].lerp(verts[b], k / (count + 1)) for k in range(1, count + 1))
        samples.extend(sum((verts[i] for i in face), Vector()) / len(face) for face in faces)
        self.samples = samples[:MAX_SAMPLES * 3]

    def describe(self, low=None, high=None):
        low, high = low or self.low, high or self.high
        size, centre = high - low, (low + high) / 2
        return {"size": [r2(size.x), r2(size.y), r2(size.z)], "center": [r2(centre.x), r2(centre.y), r2(centre.z)]}


def split_pieces(item):
    bm = bmesh.new()
    bm.from_mesh(item.data)
    bm.transform(item.matrix_world)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.faces.ensure_lookup_table()
    seen, pieces = set(), []
    for face in bm.faces:
        if face.index in seen:
            continue
        seen.add(face.index)
        stack, part = [face], []
        while stack:
            current = stack.pop()
            part.append(current)
            for edge in current.edges:
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        edges = {edge for current in part for edge in current.edges}
        index, verts, faces = {}, [], []
        for current in part:
            ids = []
            for vert in current.verts:
                if vert.index not in index:
                    index[vert.index] = len(verts)
                    verts.append(vert.co.copy())
                ids.append(index[vert.index])
            faces.append(ids)
        pairs = [(index[edge.verts[0].index], index[edge.verts[1].index]) for edge in edges]
        pieces.append(Piece(item.name, verts, faces, pairs, all(len(edge.link_faces) == 2 for edge in edges)))
    bm.free()
    return pieces


def inside(point, piece):
    """Ray parity over three skew directions; only a closed piece has an inside."""
    if not piece.closed or any(point[i] < piece.low[i] - 1e-6 or point[i] > piece.high[i] + 1e-6 for i in range(3)):
        return False
    votes = 0
    for direction in RAYS:
        hits, origin = 0, point
        while hits < 64:
            location = piece.tree.ray_cast(origin, direction)[0]
            if location is None:
                break
            hits += 1
            origin = location + direction * 1e-5
        votes += hits % 2
    return votes >= 2


def box_gap(a, b):
    return max(0.0, max(max(a.low[i] - b.high[i], b.low[i] - a.high[i]) for i in range(3)))


def relate(a, b):
    """The gap between two pieces (0 when they touch) and how far one passes into the other."""
    if box_gap(a, b) > TOUCH:
        return math.inf, 0.0
    gap, depth = (0.0 if a.tree.overlap(b.tree) else math.inf), 0.0
    for first, second in ((a, b), (b, a)):
        for point in first.samples:
            if inside(point, second):
                gap = 0.0
                depth = max(depth, second.tree.find_nearest(point)[3])
            elif gap > 0:
                gap = min(gap, second.tree.find_nearest(point)[3])
    return gap, depth


def nearest(group, candidates):
    """The smallest gap from a group of pieces to any candidate, checking the closest few by bounds."""
    best = (math.inf, None)
    for piece in group:
        for other in sorted(candidates, key=lambda c: box_gap(piece, c))[:4]:
            gap = min(other.tree.find_nearest(point)[3] for point in piece.samples)
            if gap < best[0]:
                best = (gap, other)
    return best


def layout_facts():
    started = time.monotonic()
    pieces = [piece for item in meshes for piece in split_pieces(item)]
    if len(pieces) > MAX_PIECES:
        return {"pieces": len(pieces), "skipped": f"more than {MAX_PIECES} separate pieces"}
    parent = list(range(len(pieces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    touching_objects, overlaps, complete = set(), {}, True
    for i in range(len(pieces)):
        if time.monotonic() - started > LAYOUT_SECONDS:
            complete = False
            break
        for j in range(i + 1, len(pieces)):
            a, b = pieces[i], pieces[j]
            gap, depth = relate(a, b)
            if gap > TOUCH:
                continue
            if a.owner == b.owner:
                parent[find(i)] = find(j)
                continue
            touching_objects.update((a.owner, b.owner))
            key = tuple(sorted((a.owner, b.owner)))
            if depth > TOUCH and depth > overlaps.get(key, (0,))[0]:
                overlaps[key] = (depth, a, b)

    loose = []
    for owner in dict.fromkeys(piece.owner for piece in pieces):
        groups = {}
        for i, piece in enumerate(pieces):
            if piece.owner == owner:
                groups.setdefault(find(i), []).append(piece)
        ordered = sorted(groups.values(), key=lambda group: sum(len(p.faces) for p in group), reverse=True)
        for group in ordered[1:]:
            rest = [p for other in ordered if other is not group for p in other]
            gap, _ = nearest(group, rest)
            low = Vector(map(min, *[p.low for p in group])) if len(group) > 1 else group[0].low
            high = Vector(map(max, *[p.high for p in group])) if len(group) > 1 else group[0].high
            loose.append({"object": owner, "pieces": len(group), **group[0].describe(low, high), "gap": r2(gap)})

    isolated = []
    owners = list(dict.fromkeys(piece.owner for piece in pieces))
    if len(owners) > 1:
        for owner in owners:
            if owner in touching_objects:
                continue
            gap, other = nearest([p for p in pieces if p.owner == owner], [p for p in pieces if p.owner != owner])
            isolated.append({"object": owner, "gap": r2(gap), "nearest": other.owner if other is not None else None})

    crossing = sorted(overlaps.values(), key=lambda entry: entry[0], reverse=True)
    return {
        "pieces": len(pieces),
        "complete": complete,
        "loose": sorted(loose, key=lambda entry: -entry["gap"])[:8],
        "looseCount": len(loose),
        "isolated": isolated[:8],
        "isolatedCount": len(isolated),
        "overlaps": [{"objects": [a.owner, b.owner], "depth": r2(depth), "piece": {"object": a.owner, **a.describe()}}
                     for depth, a, b in crossing[:8]],
        "overlapCount": len(crossing),
    }


# Four views in one image, so a mistake one angle hides shows in another and no
# view depends on which way the model faces: side and top (orthographic), then
# two opposite three-quarter views.
PANEL_W, PANEL_H = 512, 384
VIEWS = [("ORTHO", (1.0, 0.0, 0.0)), ("ORTHO", (0.0, 0.0, 1.0)), ("PERSP", (1.0, -1.2, 0.8)), ("PERSP", (-1.0, 1.2, 0.8))]


def render_views(size, center):
    import numpy
    world = bpy.data.worlds.new("RoqerPreviewWorld")
    world.color = (0.93, 0.93, 0.93)
    scene.world = world
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = {"vertex": "VERTEX", "texture": "TEXTURE"}.get(color_source, "MATERIAL")
    shading.show_object_outline = True
    shading.object_outline_color = (0.05, 0.05, 0.05)
    scene.render.resolution_x = PANEL_W
    scene.render.resolution_y = PANEL_H
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    camera = bpy.data.objects.new("RoqerPreviewCamera", bpy.data.cameras.new("RoqerPreviewCamera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    radius = max(size.length / 2, 0.01)
    sheet = numpy.ones((PANEL_H * 2, PANEL_W * 2, 4), dtype=numpy.float32)
    for index, (kind, toward) in enumerate(VIEWS):
        direction = Vector(toward).normalized()
        camera.data.type = kind
        if kind == "ORTHO":
            across = (size.y, size.z) if direction.x else (size.x, size.y)
            camera.data.ortho_scale = max(across[0], across[1] * PANEL_W / PANEL_H, 0.01) * 1.12
            distance = radius * 2 + 1
        else:
            distance = radius / math.sin(camera.data.angle / 2) * 1.05
        camera.location = center + direction * distance
        camera.data.clip_end = distance * 4
        camera.rotation_euler = (0, 0, 0) if direction.z > 0.99 else (-direction).to_track_quat("-Z", "Y").to_euler()
        path = f"{preview_path}.{index}.png"
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(path)
        pixels = numpy.empty(PANEL_W * PANEL_H * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        os.remove(path)
        # Image rows run bottom to top: the first row of views sits in the upper half.
        row = PANEL_H if index < 2 else 0
        column = PANEL_W * (index % 2)
        sheet[row:row + PANEL_H, column:column + PANEL_W] = pixels.reshape(PANEL_H, PANEL_W, 4)
    sheet[PANEL_H - 1:PANEL_H + 1, :, :3] = 0.55
    sheet[:, PANEL_W - 1:PANEL_W + 1, :3] = 0.55
    sheet[:, :, 3] = 1.0
    output = bpy.data.images.new("RoqerPreview", PANEL_W * 2, PANEL_H * 2, alpha=True)
    output.pixels.foreach_set(sheet.ravel())
    output.filepath_raw = preview_path
    output.file_format = "PNG"
    output.save()


if meshes:
    size = high - low
    stats["size"] = [round(size.x, 4), round(size.y, 4), round(size.z, 4)]
    stats["min"] = [round(low.x, 4), round(low.y, 4), round(low.z, 4)]
    try:
        stats["layout"] = layout_facts()
    except Exception as error:
        stats["layout"] = {"skipped": str(error)[:200]}
    # Workbench draws a material's viewport colour, which importers leave grey;
    # copy each principled base colour across so the preview shows real colours.
    for material in bpy.data.materials:
        if material.use_nodes and material.node_tree is not None:
            for node in material.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    material.diffuse_color = tuple(node.inputs["Base Color"].default_value)
                    break
    try:
        render_views(size, (low + high) / 2)
        stats["preview"] = os.path.exists(preview_path)
    except Exception as error:
        stats["previewError"] = str(error)[:200]
print("${INSPECT_MARKER}" + json.dumps(stats), flush=True)
`;

export type SpawnProcess = (command: string, args: readonly string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => ChildProcess;

export type BlenderWorkerOptions = Readonly<{
  executable: string;
  /** Where job folders are made; one per job. */
  jobsRoot: string;
  spawn?: SpawnProcess;
  /** Stops a process and everything it started. */
  killTree?: (child: ChildProcess) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}>;

type ProcessResult = Readonly<{
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
}>;

export type InspectedFile = Readonly<{
  name: string;
  path: string;
  bytes: number;
  meshes?: number;
  triangles?: number;
  materials?: readonly string[];
  /** In Blender units, which an uploaded Model arrives in as studs. */
  size?: readonly number[];
  /**
   * Where the model's colour lives. "texture" and "vertex" survive a Roblox
   * upload; "material" arrives white and is painted in Studio.
   */
  colorSource?: "texture" | "vertex" | "material";
  /** Each mesh object's name and size in studs (Roblox axes), for splitting a kit set. */
  objects?: ReadonlyArray<Readonly<{ name: string; size: readonly number[] }>>;
  /** Where the model's lowest point sits, in Blender units: 0 stands it on the ground. */
  bottom?: number;
  /** How the model's pieces sit against each other, in the script's Blender coordinates. */
  layout?: LayoutFacts;
  /** Objects shaded smooth across hard edges, with the share of their corners bent that way. */
  smoothShaded?: ReadonlyArray<Readonly<{ object: string; share: number }>>;
  inspectionError?: string;
}>;

/** A piece or group of pieces, by its size and centre in Blender coordinates (X, Y, Z up). */
export type PieceBox = Readonly<{ size: readonly number[]; center: readonly number[] }>;

/**
 * Facts about how an exported model's pieces sit, measured by Roqer's own
 * inspection. A script usually joins many primitives into one object, so each
 * object is split back into its loose pieces before they are compared.
 */
export type LayoutFacts = Readonly<{
  pieces: number;
  /** Why the layout was not measured, when it was not. */
  skipped?: string;
  /** False when the time cap stopped the comparison early. */
  complete?: boolean;
  /** Pieces that touch nothing else in their own object: almost always a gap to close. */
  loose: ReadonlyArray<PieceBox & Readonly<{ object: string; pieces: number; gap: number }>>;
  looseCount: number;
  /** Objects that touch no other object: expected in a kit set, a gap in one assembled model. */
  isolated: ReadonlyArray<Readonly<{ object: string; gap: number; nearest: string | null }>>;
  isolatedCount: number;
  /** Separate objects that pass into each other, deepest first, with the deepest piece of the first. */
  overlaps: ReadonlyArray<Readonly<{ objects: readonly [string, string]; depth: number; piece: PieceBox }>>;
  overlapCount: number;
}>;

export type RenderedImage = Readonly<{
  name: string;
  path: string;
  bytes: number;
  width?: number;
  height?: number;
  error?: string;
}>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's pixel size from its IHDR chunk, or undefined if the bytes are not a PNG. */
export function readPngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

const defaultSpawn: SpawnProcess = (command, args, options) => nodeSpawn(command, [...args], {
  cwd: options.cwd,
  env: options.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
});

function defaultKillTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Blender can start helpers of its own; /T takes the whole tree.
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * The environment a model-written script may see: the machine's ordinary
 * variables, without anything that names a credential or a Roqer setting.
 */
export function scriptEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|ROBLOSECURITY/i.test(name)) continue;
    if (/^(ROBLOX_|WORKBENCH_|ROQER_|ELECTRON_)/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

const tail = (text: string, limit = MAX_LOG_CHARACTERS) => text.length <= limit ? text : `…${text.slice(text.length - limit)}`;

function failure(message: string, errorCode: string, started: number, now: () => number, data?: unknown): McpToolOutcome {
  return { ok: false, data, text: message, httpStatus: 200, errorCode, message, durationMs: now() - started };
}

export class BlenderWorker {
  private readonly spawn: SpawnProcess;
  private readonly killTree: (child: ChildProcess) => void;
  private readonly now: () => number;

  constructor(private readonly options: BlenderWorkerOptions) {
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.jobsRoot)) {
      throw new Error("The Blender executable and job folder must be absolute paths.");
    }
    this.spawn = options.spawn ?? defaultSpawn;
    this.killTree = options.killTree ?? defaultKillTree;
    this.now = options.now ?? Date.now;
  }

  /** Run a script the engine has already approved. Never throws for the script's own failures. */
  async run(args: Record<string, unknown>, call: McpCallOptions = {}): Promise<McpToolOutcome> {
    const started = this.now();
    const script = args.script;
    if (typeof script !== "string" || script.trim() === "") {
      return failure("blender needs a script: the Python to run.", "invalid_arguments", started, this.now);
    }
    if (script.length > MAX_BLENDER_SCRIPT_CHARACTERS) {
      return failure(`The script is longer than ${MAX_BLENDER_SCRIPT_CHARACTERS} characters. Split the work into smaller jobs.`, "invalid_arguments", started, this.now);
    }
    const requested = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
      ? args.timeout_seconds
      : DEFAULT_BLENDER_JOB_SECONDS;
    const seconds = Math.min(Math.max(Math.round(requested), 5), MAX_BLENDER_JOB_SECONDS);

    await this.prune().catch(() => undefined);
    const jobDirectory = path.join(this.options.jobsRoot, `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
    const outputDirectory = path.join(jobDirectory, "output");
    try {
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(path.join(jobDirectory, "script.py"), script, "utf8");
      await fs.writeFile(path.join(jobDirectory, "roqer_runner.py"), RUNNER_SCRIPT, "utf8");
      await fs.writeFile(path.join(jobDirectory, "roqer_helpers.py"), HELPERS_SCRIPT, "utf8");
      await fs.writeFile(path.join(jobDirectory, "roqer_inspect.py"), INSPECT_SCRIPT, "utf8");
    } catch {
      return failure("Roqer could not prepare a folder for the Blender job.", "job_setup_failed", started, this.now);
    }

    const run = await this.runBlender(
      ["--background", "--factory-startup", "--python-exit-code", "1", "--python", path.join(jobDirectory, "roqer_runner.py"), "--", jobDirectory],
      jobDirectory,
      seconds * 1000,
      call,
    );
    const log = tail(run.output);
    if (run.cancelled) return failure("The Blender job was stopped with the run.", "cancelled", started, this.now);
    if (run.spawnError !== undefined) {
      return failure(`Blender could not be started: ${run.spawnError}. Check the Blender setting in Roqer's Settings.`, "blender_unavailable", started, this.now);
    }
    if (run.timedOut) {
      return failure(`The script ran past ${seconds} seconds and Blender was stopped. Simplify the geometry or raise timeout_seconds (at most ${MAX_BLENDER_JOB_SECONDS}).`, "timeout", started, this.now, { jobDirectory, log });
    }
    if (run.exitCode !== 0 || run.output.includes(FAILED_MARKER) || !run.output.includes(DONE_MARKER)) {
      return failure(`The script failed in Blender (exit ${run.exitCode ?? "unknown"}). The end of Blender's output:\n${log}`, "script_failed", started, this.now, { jobDirectory, log });
    }

    let entries: string[];
    try {
      entries = (await fs.readdir(outputDirectory)).sort();
    } catch {
      entries = [];
    }
    const models = entries.filter((name) => MODEL_EXTENSIONS.has(path.extname(name).toLowerCase()));
    const renders = entries.filter((name) => path.extname(name).toLowerCase() === ".png");
    const others = entries.filter((name) => !models.includes(name) && !renders.includes(name));
    if (models.length === 0 && renders.length === 0) {
      return failure(
        `The script finished but left no model (.glb, .gltf, .fbx or .obj) or PNG image in OUTPUT_DIR. Export the model there, for example bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "model.glb"), export_format="GLB", export_apply=True), or render the image there.${others.length > 0 ? ` It left: ${others.join(", ")}.` : ""}`,
        "no_model_exported",
        started,
        this.now,
        { jobDirectory, outputDirectory, log },
      );
    }

    const files: InspectedFile[] = [];
    const images: McpToolImage[] = [];
    // A render is shown as itself: the image is the result, so there is nothing
    // to re-import. Its size is read from the file, not from the script.
    const rendered: RenderedImage[] = [];
    const renderImages: McpToolImage[] = [];
    for (const name of renders.slice(0, MAX_RENDERED_IMAGES)) {
      const filePath = path.join(outputDirectory, name);
      const bytes = await fs.readFile(filePath).catch(() => undefined);
      const header = bytes === undefined ? undefined : readPngSize(bytes);
      if (bytes === undefined || header === undefined) {
        rendered.push({ name, path: filePath, bytes: bytes?.length ?? 0, error: "Not a readable PNG." });
        continue;
      }
      rendered.push({ name, path: filePath, bytes: bytes.length, width: header.width, height: header.height });
      if (bytes.length <= MAX_PREVIEW_BYTES) renderImages.push({ data: bytes.toString("base64"), mediaType: "image/png" });
    }
    for (const name of models.slice(0, MAX_INSPECTED_MODELS)) {
      const filePath = path.join(outputDirectory, name);
      const bytes = (await fs.stat(filePath).catch(() => undefined))?.size ?? 0;
      const preview = path.join(jobDirectory, `preview-${path.parse(name).name}.png`);
      const inspection = await this.runBlender(
        ["--background", "--factory-startup", "--python", path.join(jobDirectory, "roqer_inspect.py"), "--", filePath, preview],
        jobDirectory,
        INSPECT_TIMEOUT_MS,
        call,
      );
      if (inspection.cancelled) return failure("The Blender job was stopped with the run.", "cancelled", started, this.now);
      const line = inspection.output.split(/\r?\n/).find((entry) => entry.startsWith(INSPECT_MARKER));
      let stats: Record<string, unknown> | undefined;
      try {
        stats = line === undefined ? undefined : JSON.parse(line.slice(INSPECT_MARKER.length)) as Record<string, unknown>;
      } catch {
        stats = undefined;
      }
      if (stats === undefined) {
        files.push({ name, path: filePath, bytes, inspectionError: inspection.timedOut ? "Inspection timed out." : "Roqer could not re-import this file in Blender." });
        continue;
      }
      files.push({
        name,
        path: filePath,
        bytes,
        meshes: typeof stats.meshes === "number" ? stats.meshes : undefined,
        triangles: typeof stats.triangles === "number" ? stats.triangles : undefined,
        materials: Array.isArray(stats.materials) ? stats.materials.filter((entry): entry is string => typeof entry === "string") : undefined,
        size: Array.isArray(stats.size) ? stats.size.filter((entry): entry is number => typeof entry === "number") : undefined,
        colorSource: stats.colorSource === "texture" || stats.colorSource === "vertex" || stats.colorSource === "material" ? stats.colorSource : undefined,
        objects: Array.isArray(stats.objects) ? stats.objects.flatMap((entry: unknown) => {
          const object = entry as { name?: unknown; size?: unknown };
          return typeof object.name === "string" && Array.isArray(object.size) && object.size.every((value) => typeof value === "number")
            ? [{ name: object.name, size: object.size as number[] }]
            : [];
        }) : undefined,
        bottom: Array.isArray(stats.min) && typeof stats.min[2] === "number" ? stats.min[2] : undefined,
        layout: parseLayout(stats.layout),
        smoothShaded: Array.isArray(stats.smoothShaded)
          ? stats.smoothShaded.slice(0, MAX_LAYOUT_ENTRIES).flatMap((entry: unknown) => isRecord(entry) && typeof entry.object === "string" && isNumber(entry.share)
            ? [{ object: entry.object, share: entry.share }]
            : [])
          : undefined,
      });
      if (stats.preview === true) {
        const png = await fs.readFile(preview).catch(() => undefined);
        if (png !== undefined && png.length <= MAX_PREVIEW_BYTES) images.push({ data: png.toString("base64"), mediaType: "image/png" });
      }
    }

    const previews = images.length;
    images.push(...renderImages);
    const durationMs = this.now() - started;
    const lines = [`Blender job finished in ${(durationMs / 1000).toFixed(1)} s.`];
    if (files.length > 0) {
      lines.push(
        "Roqer re-imported each exported model and checked it:",
        ...files.map(describeFile),
        ...(models.length > MAX_INSPECTED_MODELS ? [`${models.length - MAX_INSPECTED_MODELS} more model files were not inspected.`] : []),
        previews > 0
          ? "A preview of each model is attached: four views in one image. Top left, the side seen from +X (+Y to the right); top right, the top seen from above (+Y up the image); bottom left and right, three-quarter views from the +X -Y and -X +Y corners. Check its shape and colours in every view against the request, and close any gap or overlap listed above that the design does not intend, before uploading."
          : "No preview could be rendered; judge the model by the numbers above.",
        "To use a model in Studio: upload_asset {action: 'upload', filePath: <its path>, assetType: 'Model', displayName}, then insert_asset with the returned asset id, then read the inserted model's size back and scale it in Studio if needed.",
      );
    }
    if (rendered.length > 0) {
      lines.push(
        "Images it rendered (attached after any model previews; look at each before using it):",
        ...rendered.map(describeImage),
        ...(renders.length > MAX_RENDERED_IMAGES ? [`${renders.length - MAX_RENDERED_IMAGES} more PNG files were not read.`] : []),
        "To use an image in UI: upload_asset {action: 'upload', filePath: <its path>, assetType: 'Decal', displayName}, then set ImageLabel.Image to rbxassetid://<imageId from that result>. The decalId does not display in an ImageLabel; if imageId is null, check the upload again with action 'status'.",
      );
    }
    return {
      ok: true,
      data: { jobDirectory, outputDirectory, files, images: rendered, otherFiles: others, log },
      text: lines.join("\n"),
      ...(images.length > 0 ? { images } : {}),
      httpStatus: 200,
      durationMs,
    };
  }

  private runBlender(args: readonly string[], cwd: string, timeoutMs: number, call: McpCallOptions): Promise<ProcessResult> {
    return new Promise((resolve) => {
      if (call.signal?.aborted) {
        resolve({ exitCode: null, output: "", timedOut: false, cancelled: true });
        return;
      }
      let child: ChildProcess;
      try {
        child = this.spawn(this.options.executable, args, { cwd, env: scriptEnvironment(this.options.env ?? process.env) });
      } catch (error) {
        resolve({ exitCode: null, output: "", timedOut: false, cancelled: false, spawnError: error instanceof Error ? error.message : String(error) });
        return;
      }
      let output = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const collect = (chunk: Buffer | string) => {
        output = tail(output + chunk.toString(), MAX_LOG_CHARACTERS * 4);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const stop = () => this.killTree(child);
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = () => {
        cancelled = true;
        stop();
      };
      call.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        call.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      child.once("error", (error) => finish({ exitCode: null, output, timedOut, cancelled, spawnError: error.message }));
      child.once("close", (code) => finish({ exitCode: code, output, timedOut, cancelled }));
    });
  }

  /** Clear job folders past their retention, oldest first, keeping the newest few. */
  private async prune(): Promise<void> {
    const entries = await fs.readdir(this.options.jobsRoot, { withFileTypes: true }).catch(() => []);
    const jobs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const [index, name] of jobs.entries()) {
      const directory = path.join(this.options.jobsRoot, name);
      const tooMany = index < jobs.length - MAX_KEPT_JOBS;
      const modified = (await fs.stat(directory).catch(() => undefined))?.mtimeMs ?? 0;
      if (tooMany || modified < cutoff) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const COLOR_SOURCE_NOTES: Readonly<Record<NonNullable<InspectedFile["colorSource"]>, string>> = {
  vertex: "coloured by vertex colours, which Roblox keeps: leave the MeshParts' Color white",
  texture: "coloured by a packed texture, which Roblox keeps as TextureID: leave the MeshParts' Color white",
  material: "coloured by flat material colours only, which arrive white: set Color and Material on each MeshPart after insert",
};

function describeFile(file: InspectedFile): string {
  const size = file.size !== undefined && file.size.length === 3 ? `, ${file.size.map((value) => value.toFixed(2)).join(" × ")} Blender units` : "";
  const facts = file.inspectionError !== undefined
    ? file.inspectionError
    : `${file.triangles ?? "?"} triangles, ${file.meshes ?? "?"} mesh${file.meshes === 1 ? "" : "es"}, ${file.materials?.length ?? 0} material${file.materials?.length === 1 ? "" : "s"}${size}`;
  const pieces = file.objects !== undefined && file.objects.length > 1
    ? `\n  objects, each arriving as its own MeshPart named after it: ${file.objects.map((object) => `${object.name} ${object.size.map((value) => value.toFixed(2)).join(" × ")}`).join("; ")}`
    : "";
  const layout = file.inspectionError === undefined ? describeLayout(file.layout, file.bottom) : "";
  const shading = file.smoothShaded !== undefined && file.smoothShaded.length > 0
    ? `\n  shading: smooth across hard edges on ${file.smoothShaded.map((entry) => `${entry.object} (${Math.round(entry.share * 100)}% of corners)`).join(", ")}, which makes boxes and panels look puffy in Roblox. Unless the object is meant to look rounded, remove shade_smooth; roqer.join keeps what it joins flat.`
    : "";
  return `- ${file.path} (${Math.max(1, Math.round(file.bytes / 1024))} KB): ${facts}${file.colorSource === undefined ? "" : `; ${COLOR_SOURCE_NOTES[file.colorSource]}`}${pieces}${layout}${shading}`;
}

const MAX_LAYOUT_ENTRIES = 8;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3 && value.every(isNumber);
const count = (value: unknown, fallback: number) => isNumber(value) && value >= 0 ? Math.floor(value) : fallback;

function parseBox(value: unknown): PieceBox | undefined {
  return isRecord(value) && isVector(value.size) && isVector(value.center) ? { size: value.size, center: value.center } : undefined;
}

/** The inspection's layout facts, keeping only well-formed entries: its output is data, not trusted structure. */
export function parseLayout(value: unknown): LayoutFacts | undefined {
  if (!isRecord(value) || !isNumber(value.pieces)) return undefined;
  const list = (entries: unknown) => Array.isArray(entries) ? entries.slice(0, MAX_LAYOUT_ENTRIES).filter(isRecord) : [];
  const loose = list(value.loose).flatMap((entry) => {
    const box = parseBox(entry);
    return box !== undefined && typeof entry.object === "string" && isNumber(entry.gap)
      ? [{ ...box, object: entry.object, pieces: count(entry.pieces, 1), gap: entry.gap }]
      : [];
  });
  const isolated = list(value.isolated).flatMap((entry) => typeof entry.object === "string" && isNumber(entry.gap)
    ? [{ object: entry.object, gap: entry.gap, nearest: typeof entry.nearest === "string" ? entry.nearest : null }]
    : []);
  const overlaps = list(value.overlaps).flatMap((entry) => {
    const piece = parseBox(entry.piece);
    const objects = entry.objects;
    return piece !== undefined && isNumber(entry.depth) && Array.isArray(objects) && objects.length === 2 &&
      typeof objects[0] === "string" && typeof objects[1] === "string"
      ? [{ objects: [objects[0], objects[1]] as const, depth: entry.depth, piece }]
      : [];
  });
  return {
    pieces: count(value.pieces, 0),
    ...(typeof value.skipped === "string" ? { skipped: value.skipped.slice(0, 200) } : {}),
    ...(typeof value.complete === "boolean" ? { complete: value.complete } : {}),
    loose,
    looseCount: Math.max(count(value.looseCount, loose.length), loose.length),
    isolated,
    isolatedCount: Math.max(count(value.isolatedCount, isolated.length), isolated.length),
    overlaps,
    overlapCount: Math.max(count(value.overlapCount, overlaps.length), overlaps.length),
  };
}

const studs = (value: number) => value.toFixed(2);
const box = (piece: PieceBox) =>
  `${piece.size.map(studs).join(" × ")} at (${piece.center.map(studs).join(", ")})`;
const more = (shown: number, total: number) => total > shown ? `; and ${total - shown} more` : "";

/**
 * The layout in the script's own coordinates, so each fact maps back to the
 * line that placed the piece. Facts, not verdicts: a kit set is meant to be
 * apart, and a piece may be meant to sit inside another.
 */
function describeLayout(layout: LayoutFacts | undefined, bottom: number | undefined): string {
  const lines: string[] = [];
  if (bottom !== undefined) lines.push(`lowest point at Z ${studs(bottom)}${Math.abs(bottom) > 0.05 ? "; 0 stands it on the ground" : ""}`);
  if (layout !== undefined && layout.skipped !== undefined) {
    lines.push(`layout not measured (${layout.skipped}); judge it from the preview`);
  } else if (layout !== undefined) {
    if (layout.looseCount > 0) {
      const shown = layout.loose
        .map((entry) => `in ${entry.object}, ${entry.pieces > 1 ? `${entry.pieces} pieces spanning ` : "a piece "}${box(entry)}, ${studs(entry.gap)} from the rest`)
        .join("; ");
      lines.push(`${layout.looseCount === 1 ? "1 piece group touching nothing else in its own object" : `${layout.looseCount} piece groups touching nothing else in their own object`}, usually a gap to close${shown === "" ? "" : `: ${shown}${more(layout.loose.length, layout.looseCount)}`}`);
    }
    if (layout.isolatedCount > 0) {
      lines.push(`${layout.isolatedCount === 1 ? "an object" : `${layout.isolatedCount} objects`} touching no other object (right for a kit set of separate pieces, a gap in one assembled model): ${layout.isolated
        .map((entry) => `${entry.object}${entry.nearest === null ? "" : `, ${studs(entry.gap)} from ${entry.nearest}`}`)
        .join("; ")}${more(layout.isolated.length, layout.isolatedCount)}`);
    }
    if (layout.overlapCount > 0) {
      lines.push(`separate objects passing into each other (fine where one is meant to sit inside the other, wrong for a part that must move freely): ${layout.overlaps
        .map((entry) => `${entry.objects[0]} and ${entry.objects[1]} by ${studs(entry.depth)}, deepest at the ${entry.objects[0]} piece ${box(entry.piece)}`)
        .join("; ")}${more(layout.overlaps.length, layout.overlapCount)}`);
    }
    if (layout.looseCount === 0 && layout.isolatedCount === 0 && layout.overlapCount === 0) {
      lines.push(layout.pieces === 1 ? "one piece" : `all ${layout.pieces} pieces connected, and no separate objects pass into each other`);
    }
    if (layout.complete === false) lines.push("the comparison stopped at its time limit, so pieces may be missing from these facts");
  }
  return lines.length === 0 ? "" : `\n  layout, in the script's Blender coordinates (X, Y, Z up; sizes and positions in studs): ${lines.map((line) => line[0].toUpperCase() + line.slice(1)).join(". ")}.`;
}

function describeImage(image: RenderedImage): string {
  const kilobytes = `${Math.max(1, Math.round(image.bytes / 1024))} KB`;
  if (image.error !== undefined || image.width === undefined || image.height === undefined) {
    return `- ${image.path} (${kilobytes}): ${image.error ?? "Not a readable PNG."}`;
  }
  const notes = [
    ...(Math.max(image.width, image.height) > MAX_UPLOAD_IMAGE_SIDE ? [`Roblox keeps at most ${MAX_UPLOAD_IMAGE_SIDE} pixels a side, so render it smaller`] : []),
    ...(image.bytes > MAX_PREVIEW_BYTES ? ["too large to attach"] : []),
  ];
  return `- ${image.path} (${kilobytes}): ${image.width} × ${image.height} pixels${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`;
}
