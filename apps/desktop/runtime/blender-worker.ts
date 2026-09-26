import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_BLENDER_JOB_SECONDS,
  isBlenderJobId,
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
/** How many of a scene's objects the result names; the rest are counted. */
const MAX_LISTED_SCENE_OBJECTS = 60;
const MAX_SCENE_OBJECTS = 120;

const DONE_MARKER = "ROQER_SCRIPT_DONE";
const FAILED_MARKER = "ROQER_SCRIPT_FAILED";
const BASE_FAILED_MARKER = "ROQER_BASE_SCENE_FAILED";
const SCENE_SAVED_MARKER = "ROQER_SCENE_SAVED";
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


def _tube(name, start, end, radii, rgba, vertices):
    """A closed round solid from start to end with the given radius at each end; a radius of 0 is a point."""
    start, end = _vector(start, "start"), _vector(end, "end")
    if not isinstance(vertices, int) or vertices < 3:
        raise ValueError(f"vertices must be a whole number of at least 3, got {vertices!r}")
    along, side, normal = _frame(start, end, Vector((1, 0, 0)) if abs((end - start).normalized().x) < 0.9 else Vector((0, 1, 0)))
    import math
    bm = bmesh.new()
    rings = []
    for point, radius in zip((start, end), radii):
        if radius == 0:
            rings.append([bm.verts.new(point)])
            continue
        rings.append([bm.verts.new(point + (side * math.cos(2 * math.pi * k / vertices) + normal * math.sin(2 * math.pi * k / vertices)) * radius)
                      for k in range(vertices)])
    first, last = rings
    for k in range(vertices):
        n = (k + 1) % vertices
        if len(first) == 1:
            bm.faces.new((first[0], last[n], last[k]))
        elif len(last) == 1:
            bm.faces.new((first[k], first[n], last[0]))
        else:
            bm.faces.new((first[k], first[n], last[n], last[k]))
    if len(first) > 1:
        bm.faces.new(list(reversed(first)))
    if len(last) > 1:
        bm.faces.new(last)
    return _object(name, bm, rgba)


def cylinder_between(name, start, end, radius, rgba=None, vertices=12):
    """A cylinder whose end caps sit at start and end: a bar, a pipe, a column, an axle or a wheel."""
    radius = _positive(radius, "radius")
    return _tube(name, start, end, (radius, radius), rgba, vertices)


def cone_between(name, start, end, start_radius, end_radius=0.0, rgba=None, vertices=12):
    """A cone or taper from start to end: start_radius across at start, end_radius at end, 0 for a point.

    Each radius belongs to the end it is named for, so a boost flame runs from the exhaust
    (its wide end) to its tip (0), a spike from its base to its point, a funnel from its
    mouth to its spout. No rotation angle to get the direction of wrong.
    """
    radii = []
    for value, label in ((start_radius, "start_radius"), (end_radius, "end_radius")):
        if not isinstance(value, (int, float)) or value < 0:
            raise ValueError(f"{label} must be a number of studs, 0 or more, got {value!r}")
        radii.append(float(value))
    if radii == [0.0, 0.0]:
        raise ValueError("start_radius and end_radius cannot both be 0")
    return _tube(name, start, end, radii, rgba, vertices)


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

/**
 * Roqer's wrapper around the model's script.
 *
 * A job starts from an empty scene, or, when the call names an earlier job in
 * `continue_from`, from the scene that job saved. Only a script that finishes
 * saves its scene, so a failed job leaves nothing behind to build on and the
 * next attempt starts again from the last one that worked. Every saved scene is
 * its own file, never overwritten, so any earlier step can be gone back to.
 *
 * Beside the scene it writes a list of what the scene holds -- each object's
 * name, size, centre and triangles -- so the model building on it reads what
 * exists instead of remembering it. The list goes to a file rather than to
 * Blender's output, which is kept only in part.
 */
export const RUNNER_SCRIPT = String.raw`import bpy, json, numpy, os, sys, traceback, types

args = sys.argv[sys.argv.index("--") + 1:]
job_dir = args[0]
base_scene = args[1] if len(args) > 1 else ""
OUTPUT_DIR = os.path.join(job_dir, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)
try:
    if base_scene:
        bpy.ops.wm.open_mainfile(filepath=base_scene, load_ui=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
except BaseException:
    traceback.print_exc()
    print("${BASE_FAILED_MARKER}", flush=True)
    sys.exit(1)
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

GEOMETRY = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
MAX_SCENE_OBJECTS = 120


def measured(values):
    return [round(float(value), 3) for value in values]


def scene_contents():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    entries, triangles = [], 0
    for item in bpy.context.scene.objects:
        if item.type not in GEOMETRY and item.type != "EMPTY":
            continue
        entry = {"name": item.name, "type": item.type.lower()}
        if item.parent is not None:
            entry["parent"] = item.parent.name
        if not item.visible_get():
            entry["hidden"] = True
        if item.type == "EMPTY":
            if numpy.isfinite(numpy.array(item.matrix_world.translation)).all():
                entry["center"] = measured(item.matrix_world.translation)
        else:
            # Measured from the evaluated mesh itself: a curve's own bounding
            # box describes its control points, not the tube they become.
            evaluated = item.evaluated_get(depsgraph)
            try:
                mesh = evaluated.to_mesh()
                points = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float64)
                mesh.vertices.foreach_get("co", points)
                points = points.reshape(-1, 3)
                # A vertex at NaN is what fails a glTF export, and it would
                # also turn every measurement below, and this file, into NaN.
                finite = numpy.isfinite(points).all(axis=1)
                if not finite.all():
                    entry["invalid"] = int((~finite).sum())
                    entry["invalidFrom"] = "geometry"
                    if item.type == "MESH" and item.modifiers:
                        source = numpy.empty(len(item.data.vertices) * 3, dtype=numpy.float64)
                        item.data.vertices.foreach_get("co", source)
                        if numpy.isfinite(source).all():
                            entry["invalidFrom"] = "modifiers"
                    points = points[finite]
                if len(points) > 0:
                    world = numpy.array(evaluated.matrix_world)
                    points = points @ world[:3, :3].T + world[:3, 3]
                    low, high = points.min(axis=0), points.max(axis=0)
                    if numpy.isfinite(low).all() and numpy.isfinite(high).all():
                        entry["size"] = measured(high - low)
                        entry["center"] = measured((low + high) / 2)
                mesh.calc_loop_triangles()
                entry["triangles"] = len(mesh.loop_triangles)
                triangles += entry["triangles"]
                evaluated.to_mesh_clear()
            except Exception:
                pass
            materials = [slot.material.name for slot in item.material_slots if slot.material is not None]
            if materials:
                entry["materials"] = materials[:4]
            modifiers = [modifier.type.lower() for modifier in item.modifiers]
            if modifiers:
                entry["modifiers"] = modifiers[:4]
        entries.append(entry)
    return {"objects": entries[:MAX_SCENE_OBJECTS], "count": len(entries), "triangles": triangles}


try:
    # Blender leaves data nothing uses out of a saved file, so a material made
    # now for a later stage would be gone when that stage continues from here.
    for block in (*bpy.data.materials, *bpy.data.node_groups):
        if block.users == 0 and block.library is None:
            block.use_fake_user = True
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(job_dir, "scene.blend"), compress=True, copy=True)
    print("${SCENE_SAVED_MARKER}", flush=True)
    listing = json.dumps(scene_contents(), allow_nan=False)
    with open(os.path.join(job_dir, "scene.json"), "w", encoding="utf-8") as handle:
        handle.write(listing)
except BaseException:
    traceback.print_exc()
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
extension = os.path.splitext(model_path)[1].lower()
if extension == ".blend":
    # A job's own saved scene, measured as it would export: what is hidden is
    # left out, and every modifier, curve and text is baked into the mesh it
    # becomes, so a mirrored half counts as the whole and a curve tube counts at all.
    bpy.ops.wm.open_mainfile(filepath=model_path, load_ui=False)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    baked = []
    for item in list(bpy.context.scene.objects):
        if item.type not in ("MESH", "CURVE", "SURFACE", "META", "FONT"):
            continue
        if not item.visible_get() or item.hide_render:
            item.hide_render = True
            continue
        baked.append((item, bpy.data.meshes.new_from_object(item.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)))
    for item, mesh in baked:
        if item.type == "MESH":
            item.modifiers.clear()
            item.data = mesh
        else:
            name = item.name
            item.name = name + " (source)"
            item.hide_render = True
            stand_in = bpy.data.objects.new(name, mesh)
            stand_in.matrix_world = item.matrix_world
            bpy.context.scene.collection.objects.link(stand_in)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if extension in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=model_path)
    elif extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=model_path)
    elif extension == ".obj":
        bpy.ops.wm.obj_import(filepath=model_path)

scene = bpy.context.scene
meshes = [item for item in scene.objects if item.type == "MESH" and not item.hide_render]
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

    touching_objects, attached, overlaps, complete = set(), set(), {}, True
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
            attached.update((i, j))
            key = tuple(sorted((a.owner, b.owner)))
            if depth > TOUCH and depth > overlaps.get(key, (0,))[0]:
                overlaps[key] = (depth, a, b)

    loose = []
    for owner in dict.fromkeys(piece.owner for piece in pieces):
        groups, held = {}, set()
        for i, piece in enumerate(pieces):
            if piece.owner == owner:
                groups.setdefault(find(i), []).append(piece)
                if i in attached:
                    held.add(find(i))
        # A group held by another object is attached, not loose: one object
        # may hold two separate lamps, each fixed to the body.
        ordered = sorted(groups.items(), key=lambda entry: sum(len(p.faces) for p in entry[1]), reverse=True)
        ordered = [group for root, group in ordered[:1]] + [group for root, group in ordered[1:] if root not in held]
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
  /**
   * Whose jobs this worker may continue from: the chat, in the app. A job's
   * saved scene is found by its id, and only a job made under the same scope is
   * found, so one chat never builds on another's model.
   */
  scope?: string;
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
  /** Pieces that touch nothing, in their own object or any other: almost always a gap to close. */
  loose: ReadonlyArray<PieceBox & Readonly<{ object: string; pieces: number; gap: number }>>;
  looseCount: number;
  /** Objects that touch no other object: expected in a kit set, a gap in one assembled model. */
  isolated: ReadonlyArray<Readonly<{ object: string; gap: number; nearest: string | null }>>;
  isolatedCount: number;
  /** Separate objects that pass into each other, deepest first, with the deepest piece of the first. */
  overlaps: ReadonlyArray<Readonly<{ objects: readonly [string, string]; depth: number; piece: PieceBox }>>;
  overlapCount: number;
}>;

/** One object in a saved scene, as the runner listed it, in Blender coordinates. */
export type SceneObject = Readonly<{
  name: string;
  type: string;
  parent?: string;
  hidden?: boolean;
  size?: readonly number[];
  center?: readonly number[];
  triangles?: number;
  materials?: readonly string[];
  modifiers?: readonly string[];
  /** Vertices at NaN or infinite positions, which a glTF export fails on. */
  invalid?: number;
  /** Whether those came from the object's modifiers or its own geometry. */
  invalidFrom?: "modifiers" | "geometry";
}>;

/** What a job's saved scene holds, so the next job's author reads it instead of recalling it. */
export type SceneContents = Readonly<{
  objects: readonly SceneObject[];
  /** Objects in the scene, including any past the listed ones. */
  count: number;
  triangles: number;
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
  private readonly scope: string;

  constructor(private readonly options: BlenderWorkerOptions) {
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.jobsRoot)) {
      throw new Error("The Blender executable and job folder must be absolute paths.");
    }
    this.spawn = options.spawn ?? defaultSpawn;
    this.killTree = options.killTree ?? defaultKillTree;
    this.now = options.now ?? Date.now;
    this.scope = options.scope ?? "";
  }

  /** The scene an earlier job of this scope saved, found by the job's id. */
  private async savedScene(id: string): Promise<Readonly<{ directory: string; scene: string }> | undefined> {
    const entries = await fs.readdir(this.options.jobsRoot).catch(() => [] as string[]);
    const name = entries.find((entry) => entry.endsWith(`-${id}`));
    if (name === undefined) return undefined;
    const directory = path.join(this.options.jobsRoot, name);
    let record: unknown;
    try {
      record = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(record) || record.id !== id || record.scope !== this.scope) return undefined;
    const scene = path.join(directory, "scene.blend");
    return (await fs.stat(scene).catch(() => undefined))?.isFile() === true ? { directory, scene } : undefined;
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

    const continueFrom = args.continue_from;
    if (continueFrom !== undefined && !isBlenderJobId(continueFrom)) {
      return failure("continue_from must be the id of an earlier job, exactly as that job's result gave it.", "invalid_arguments", started, this.now);
    }
    const base = continueFrom === undefined ? undefined : await this.savedScene(continueFrom);
    if (continueFrom !== undefined && base === undefined) {
      return failure(
        `There is no saved scene from job ${continueFrom} in this chat. A job saves its scene only when its script finishes, and job folders are cleared after ${JOB_RETENTION_MS / 86_400_000} days or once ${MAX_KEPT_JOBS} newer jobs exist. Continue from a later job that worked, or start from an empty scene without continue_from.`,
        "scene_not_found",
        started,
        this.now,
      );
    }

    await this.prune(base?.directory).catch(() => undefined);
    const jobId = randomBytes(4).toString("hex");
    const jobDirectory = path.join(this.options.jobsRoot, `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${jobId}`);
    const outputDirectory = path.join(jobDirectory, "output");
    try {
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(
        path.join(jobDirectory, "job.json"),
        JSON.stringify({ id: jobId, scope: this.scope, ...(continueFrom === undefined ? {} : { continuedFrom: continueFrom }) }),
        "utf8",
      );
      await fs.writeFile(path.join(jobDirectory, "script.py"), script, "utf8");
      await fs.writeFile(path.join(jobDirectory, "roqer_runner.py"), RUNNER_SCRIPT, "utf8");
      await fs.writeFile(path.join(jobDirectory, "roqer_helpers.py"), HELPERS_SCRIPT, "utf8");
      await fs.writeFile(path.join(jobDirectory, "roqer_inspect.py"), INSPECT_SCRIPT, "utf8");
    } catch {
      return failure("Roqer could not prepare a folder for the Blender job.", "job_setup_failed", started, this.now);
    }

    const run = await this.runBlender(
      [
        "--background", "--factory-startup", "--python-exit-code", "1", "--python", path.join(jobDirectory, "roqer_runner.py"),
        "--", jobDirectory, ...(base === undefined ? [] : [base.scene]),
      ],
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
    if (run.output.includes(BASE_FAILED_MARKER)) {
      return failure(`Blender could not open the scene job ${String(continueFrom)} saved, so the script did not run. Continue from another job, or start from an empty scene. The end of Blender's output:\n${log}`, "scene_not_opened", started, this.now, { jobDirectory, log });
    }
    if (run.exitCode !== 0 || run.output.includes(FAILED_MARKER) || !run.output.includes(DONE_MARKER)) {
      return failure(
        `The script failed in Blender (exit ${run.exitCode ?? "unknown"}), so nothing was saved${continueFrom === undefined ? "" : `; the scene of job ${continueFrom} is unchanged`}. The end of Blender's output:\n${log}`,
        "script_failed",
        started,
        this.now,
        { jobDirectory, log },
      );
    }
    const sceneFile = path.join(jobDirectory, "scene.blend");
    const sceneSaved = run.output.includes(SCENE_SAVED_MARKER) && (await fs.stat(sceneFile).catch(() => undefined))?.isFile() === true;
    const contents = sceneSaved ? await readSceneContents(path.join(jobDirectory, "scene.json")) : undefined;

    let entries: string[];
    try {
      entries = (await fs.readdir(outputDirectory)).sort();
    } catch {
      entries = [];
    }
    const models = entries.filter((name) => MODEL_EXTENSIONS.has(path.extname(name).toLowerCase()));
    const renders = entries.filter((name) => path.extname(name).toLowerCase() === ".png");
    const others = entries.filter((name) => !models.includes(name) && !renders.includes(name));
    if (models.length === 0 && renders.length === 0 && !sceneSaved) {
      return failure(
        `The script finished but left no model (.glb, .gltf, .fbx or .obj) or PNG image in OUTPUT_DIR. Export the model there, for example bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "model.glb"), export_format="GLB", export_apply=True, use_visible=True), or render the image there.${others.length > 0 ? ` It left: ${others.join(", ")}.` : ""}`,
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
    // Nothing exported, so the scene itself is what the model is to look at:
    // it is inspected the same way, measured as it would export.
    const inspectScene = models.length === 0 && renders.length === 0 && sceneSaved;
    const inspected = inspectScene
      ? [{ name: "scene.blend", filePath: sceneFile }]
      : models.slice(0, MAX_INSPECTED_MODELS).map((name) => ({ name, filePath: path.join(outputDirectory, name) }));
    for (const { name, filePath } of inspected) {
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
    const lines = [`Blender job ${jobId} finished in ${(durationMs / 1000).toFixed(1)} s.`];
    if (inspectScene) {
      lines.push(
        "Nothing was exported, so Roqer checked the scene this job saved, measured as it would export (modifiers applied, curves as the meshes they become, hidden objects left out):",
        ...files.map(describeFile),
        previews > 0
          ? "A preview is attached: four views in one image. Top left, the side seen from +X (+Y to the right); top right, the top seen from above (+Y up the image); bottom left and right, three-quarter views from the +X -Y and -X +Y corners. Check it against the request before building on it."
          : "No preview could be rendered; judge the scene by the numbers above.",
        "In Studio a point at Blender (x, y, z) arrives at (-x, z, y): Blender -Y becomes Roblox's forward (-Z, the LookVector), so a front modeled toward +Y arrives facing backwards.",
      );
    } else if (files.length > 0) {
      lines.push(
        "Roqer re-imported each exported model and checked it:",
        ...files.map(describeFile),
        ...(models.length > MAX_INSPECTED_MODELS ? [`${models.length - MAX_INSPECTED_MODELS} more model files were not inspected.`] : []),
        previews > 0
          ? "A preview of each model is attached: four views in one image. Top left, the side seen from +X (+Y to the right); top right, the top seen from above (+Y up the image); bottom left and right, three-quarter views from the +X -Y and -X +Y corners. Check its shape and colours in every view against the request, and close any gap or overlap listed above that the design does not intend, before uploading."
          : "No preview could be rendered; judge the model by the numbers above.",
        "In Studio a point at Blender (x, y, z) arrives at (-x, z, y): Blender -Y becomes Roblox's forward (-Z, the LookVector), so a front modeled toward +Y arrives facing backwards.",
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
    lines.push(...describeScene(jobId, continueFrom, contents, sceneSaved, inspectScene));
    return {
      ok: true,
      data: {
        jobId,
        ...(continueFrom === undefined ? {} : { continuedFrom: continueFrom }),
        jobDirectory, outputDirectory, files, images: rendered, otherFiles: others, log,
        scene: sceneSaved ? { path: sceneFile, ...(contents === undefined ? {} : { contents }) } : null,
      },
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

  /**
   * Clear job folders past their retention, oldest first, keeping the newest
   * few, and always keeping `keep`: the job this one continues from.
   */
  private async prune(keep?: string): Promise<void> {
    const entries = await fs.readdir(this.options.jobsRoot, { withFileTypes: true }).catch(() => []);
    const jobs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const [index, name] of jobs.entries()) {
      const directory = path.join(this.options.jobsRoot, name);
      if (directory === keep) continue;
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
        .map((entry) => `in ${entry.object}, ${entry.pieces > 1 ? `${entry.pieces} pieces spanning ` : "a piece "}${box(entry)}, ${studs(entry.gap)} from the rest of ${entry.object}`)
        .join("; ");
      lines.push(`${layout.looseCount === 1 ? "1 piece group attached to nothing" : `${layout.looseCount} piece groups attached to nothing`}, usually a gap to close${shown === "" ? "" : `: ${shown}${more(layout.loose.length, layout.looseCount)}`}`);
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

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const texts = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter(isText).slice(0, 4) : undefined;

/** The runner's list of a saved scene, keeping only well-formed entries: it is data, not trusted structure. */
export async function readSceneContents(file: string): Promise<SceneContents | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.objects)) return undefined;
  const objects = value.objects.slice(0, MAX_SCENE_OBJECTS).filter(isRecord).flatMap((entry): SceneObject[] => {
    if (!isText(entry.name) || !isText(entry.type)) return [];
    const materials = texts(entry.materials);
    const modifiers = texts(entry.modifiers);
    return [{
      name: entry.name,
      type: entry.type,
      ...(isText(entry.parent) ? { parent: entry.parent } : {}),
      ...(entry.hidden === true ? { hidden: true } : {}),
      ...(isVector(entry.size) ? { size: entry.size } : {}),
      ...(isVector(entry.center) ? { center: entry.center } : {}),
      ...(isNumber(entry.triangles) ? { triangles: Math.floor(entry.triangles) } : {}),
      ...(materials !== undefined && materials.length > 0 ? { materials } : {}),
      ...(modifiers !== undefined && modifiers.length > 0 ? { modifiers } : {}),
      ...(isNumber(entry.invalid) && entry.invalid >= 1 ? {
        invalid: Math.floor(entry.invalid),
        invalidFrom: entry.invalidFrom === "modifiers" ? "modifiers" : "geometry",
      } as const : {}),
    }];
  });
  return {
    objects,
    count: Math.max(count(value.count, objects.length), objects.length),
    triangles: count(value.triangles, 0),
  };
}

function describeSceneObject(object: SceneObject): string {
  const facts = [
    ...(object.size === undefined ? [] : [object.size.map(studs).join(" × ")]),
    ...(object.center === undefined ? [] : [`at (${object.center.map(studs).join(", ")})`]),
  ].join(" ");
  const details = [
    ...(object.triangles === undefined ? [] : [`${object.triangles} triangles`]),
    ...(object.parent === undefined ? [] : [`child of ${object.parent}`]),
    ...(object.materials === undefined ? [] : [`materials ${object.materials.join(", ")}`]),
    ...(object.modifiers === undefined ? [] : [`modifiers ${object.modifiers.join(", ")}`]),
    ...(object.hidden === true ? ["hidden"] : []),
    ...(object.invalid === undefined ? [] : [`${object.invalid} vertices at invalid (NaN) positions, left out of its size`]),
  ];
  return `- ${object.name} (${object.type})${facts === "" ? "" : `: ${facts}`}${details.length === 0 ? "" : `; ${details.join("; ")}`}`;
}

/**
 * Objects with vertices at NaN positions. The glTF exporter fails on them with
 * an error that names no object ("cannot convert float NaN to integer"), so a
 * model hunting for the cause spends jobs on it; name them before it exports.
 */
function describeInvalidGeometry(objects: readonly SceneObject[]): string[] {
  const invalid = objects.filter((object) => object.invalid !== undefined);
  if (invalid.length === 0) return [];
  const named = invalid.slice(0, 6).map((object) => `${object.name} (${object.invalid} vertices, made by ${object.invalidFrom === "modifiers"
    ? `its modifiers${object.modifiers === undefined ? "" : `: ${object.modifiers.join(", ")}`}`
    : "its own geometry"})`);
  const advice = [
    ...(invalid.some((object) => object.invalidFrom === "modifiers")
      ? ["A bevel makes these where the mesh has overlapping vertices: merge them before the modifier runs (bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)), or remove the modifier."]
      : []),
    ...(invalid.some((object) => object.invalidFrom === "geometry")
      ? ["Where the object's own geometry holds them, the script computed those positions as NaN (a 0/0, or a value that overflowed): find that calculation."]
      : []),
  ];
  return [`Invalid geometry, which a glTF export fails on ("cannot convert float NaN to integer"): ${named.join("; ")}${more(named.length, invalid.length)}. ${advice.join(" ")}`];
}

const SIDE_SWAPS: ReadonlyMap<string, string> = new Map([
  ["L", "R"], ["R", "L"], ["l", "r"], ["r", "l"],
  ["Left", "Right"], ["Right", "Left"], ["left", "right"], ["right", "left"], ["LEFT", "RIGHT"], ["RIGHT", "LEFT"],
]);

/**
 * The name of the object on the other side, for a name that marks exactly one
 * side as its own word: `Wheel_L`, `Hand.L`, `Front_Left_Wheel`. A name that
 * marks none, or two, has no other side (`Leftover`, `L_Arm_R`).
 */
export function otherSideName(name: string): string | undefined {
  const words = name.split(/([_.\-\s]+)/);
  const sides = words.flatMap((word, index) => index % 2 === 0 && SIDE_SWAPS.has(word) ? [index] : []);
  if (sides.length !== 1) return undefined;
  return words.map((word, index) => index === sides[0] ? SIDE_SWAPS.get(word) : word).join("");
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Left and right pairs that do not mirror each other. A mirrored part is placed
 * by a sign the script flips, and a flip it forgets puts both parts on one side
 * or in one place: a go-kart kept both front fenders on its left wheel for ten
 * jobs while every listing showed the same centre for both. The centre plane is
 * where most pairs meet, so one misplaced pair does not move it.
 */
function describeUnmirroredPairs(objects: readonly SceneObject[]): string[] {
  type Placed = SceneObject & { center: readonly number[] };
  const placed = new Map(objects.flatMap((object): Array<[string, Placed]> =>
    object.center !== undefined && object.hidden !== true ? [[object.name, object as Placed]] : []));
  const pairs = [...placed.values()].flatMap((object): Array<[Placed, Placed]> => {
    const other = otherSideName(object.name);
    const partner = other === undefined ? undefined : placed.get(other);
    return partner !== undefined && object.name < partner.name ? [[object, partner]] : [];
  });
  if (pairs.length === 0) return [];
  const tolerance = ([first, second]: [Placed, Placed]) =>
    Math.max(0.05, 0.1 * Math.max(...(first.size ?? [0]), ...(second.size ?? [0])));
  const spreadAlong = (axis: number) => pairs.filter(([first, second]) =>
    Math.abs(first.center[axis] - second.center[axis]) > Math.abs(first.center[1 - axis] - second.center[1 - axis])).length;
  const axis = spreadAlong(1) > spreadAlong(0) ? 1 : 0;
  const apart = pairs.filter((pair) => Math.abs(pair[0].center[axis] - pair[1].center[axis]) > tolerance(pair));
  const plane = apart.length === 0 ? 0 : median(apart.map(([first, second]) => (first.center[axis] + second.center[axis]) / 2));
  const at = (object: Placed) => `(${object.center.map(studs).join(", ")})`;
  const problems = pairs.flatMap((pair): string[] => {
    const [first, second] = pair;
    const limit = tolerance(pair);
    if (Math.hypot(...first.center.map((value, index) => value - second.center[index])) <= limit) {
      return [`${first.name} and ${second.name} are in the same place, at ${at(first)}`];
    }
    const offsets = [first.center[axis] - plane, second.center[axis] - plane];
    if (offsets[0] * offsets[1] > 0 && Math.min(Math.abs(offsets[0]), Math.abs(offsets[1])) > limit) {
      return [`${first.name} at ${at(first)} and ${second.name} at ${at(second)} are on the same side`];
    }
    const mirrored = Math.abs(offsets[0] + offsets[1]) <= limit &&
      [0, 1, 2].every((index) => index === axis || Math.abs(first.center[index] - second.center[index]) <= limit);
    return mirrored ? [] : [`${first.name} at ${at(first)} and ${second.name} at ${at(second)} do not mirror each other`];
  });
  if (problems.length === 0) return [];
  return [`Left and right pairs that do not mirror across the model's centre (${axis === 0 ? "X" : "Y"} = ${studs(plane)}): ${problems.slice(0, 6).join("; ")}${more(Math.min(problems.length, 6), problems.length)}. If a pair should mirror, one of the two is misplaced: check the sign the script placed it with.`];
}

/**
 * What the model needs to build on this job: its id, what the scene now holds
 * by name, and how to continue from it. Said on every job, because the next
 * job's author may be reading it after the turns that built it were folded away.
 */
function describeScene(
  jobId: string,
  continuedFrom: unknown,
  contents: SceneContents | undefined,
  saved: boolean,
  inspected: boolean,
): string[] {
  if (!saved) {
    return [`This job's scene could not be saved, so no later job can continue from it${typeof continuedFrom === "string" ? `; job ${continuedFrom}'s scene is unchanged` : ""}.`];
  }
  const lines = [
    `Scene saved as job ${jobId}${typeof continuedFrom === "string" ? `, continuing job ${continuedFrom}` : ""}${contents === undefined ? ". Roqer could not read the list of its objects this time, so check the scene by name in the next script instead." : `: ${contents.count} object${contents.count === 1 ? "" : "s"}, ${contents.triangles} triangles. Sizes and centres in studs, in Blender coordinates (X, Y, Z up):`}`,
  ];
  if (contents !== undefined) {
    const listed = contents.objects.slice(0, MAX_LISTED_SCENE_OBJECTS);
    lines.push(...listed.map(describeSceneObject));
    if (contents.count > listed.length) lines.push(`- and ${contents.count - listed.length} more objects`);
    const hidden = contents.objects.filter((object) => object.hidden === true).map((object) => object.name);
    if (hidden.length > 0) {
      lines.push(`Hidden objects (${hidden.slice(0, 8).join(", ")}${hidden.length > 8 ? ", and more" : ""}) are ${inspected ? "not in this preview, but an" : "in the scene, and an"} export includes them unless it passes use_visible=True: delete them, or export with use_visible=True, before uploading.`);
    }
    lines.push(...describeInvalidGeometry(contents.objects), ...describeUnmirroredPairs(contents.objects));
  }
  lines.push(
    `To build on this scene, call blender again with continue_from: '${jobId}'. The script then starts with these objects loaded, by these names, instead of an empty scene, and can change them as well as add to them. A job that fails saves nothing; to undo a step, continue from an earlier job instead.`,
  );
  if (inspected) lines.push("Export into OUTPUT_DIR once the model is ready to upload; that job can be one that only exports, continuing from this one.");
  return lines;
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
