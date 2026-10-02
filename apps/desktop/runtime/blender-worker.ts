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
import { articulationOf, describeArticulation, MAX_LISTED_OBJECTS, parseObjects, type Articulation, type InspectedObject } from "./blender-articulation";
import { ANIMATION_SUFFIX, BAKE_SUFFIX, describeBake, describeBakedFile, parseBake } from "./blender-animation";
import { describeSkins, parseSkins, type InspectedSkin } from "./blender-skin";
import { analyzeFlipbook, describeFlipbook, type FlipbookClaim, type FlipbookReport } from "./flipbook-sheet";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";
import { findStudioContentDirectories, stageStudioPreviews, type StudioPreview } from "./studio-preview";
import { isViewableGlb, JOB_RETENTION_MS, MAX_KEPT_JOBS, modelPreviewFileName, pruneJobFolders } from "./model-preview";
import { modelPreviewId } from "../shared/model-preview";

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


def piece(obj, pivot, parent=None):
    """Make an object a moving piece of a creature or a machine, to be rigged in Studio.

    Its origin moves to pivot, the point it turns about (a leg's hip, a jaw's hinge), without
    moving its shape; its mesh is named after it, as Roblox names the MeshPart; and, given
    parent, it hangs from that piece, staying where it is. Call it after join, once per piece.
    """
    from mathutils import Matrix
    pivot = _vector(pivot, "pivot")
    world = obj.matrix_world.copy()
    local = world.inverted() @ pivot
    obj.data.transform(Matrix.Translation(-local))
    obj.data.update()
    placed = world @ Matrix.Translation(local)
    obj.data.name = obj.name
    if parent is not None:
        if parent is obj:
            raise ValueError(f"{obj.name} cannot hang from itself")
        bpy.context.view_layer.update()
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    obj.matrix_world = placed
    bpy.context.view_layer.update()
    return obj


def _quaternion(q):
    """A Blender rotation as [x, y, z, w] in Roblox's axes: a point at (x, y, z) arrives at (-x, z, y)."""
    return [round(-q.x, 6), round(q.z, 6), round(q.y, 6), round(q.w, 6)]


def _studs(vector):
    return [round(-vector.x, 4), round(vector.z, 4), round(vector.y, 4)]


def _joint_name(piece):
    """The joint rig makes for a piece, as Roqer's inspection names them: a leg's for the leg, its knee and ankle after it."""
    if piece == "Head":
        return "Neck"
    for suffix, joint in (("Upper", ""), ("Lower", "Knee"), ("Foot", "Ankle")):
        if piece.endswith(suffix) and len(piece) > len(suffix):
            return piece[:-len(suffix)] + joint
    return piece


_MAX_SAMPLES = 240
_MAX_SECONDS = 60


def export_animation(name, source, rig, start=None, end=None, loop=True, rest_frame=None, root_joint="Root"):
    """Bake what a creature does between two frames into an animation for Studio's animation tool.

    source is the armature of a skinned creature, or the body piece of a creature of moving
    pieces. rig is the path its model has in Studio, such as "game.Workspace.Wolf". Every frame
    from start to end (the scene's own by default) is sampled with constraints and inverse
    kinematics applied, so animate however Blender makes easy. For a loop, make the last frame
    the same pose as the first. A creature of pieces is at rest at rest_frame (start by default);
    an armature's rest is its own. The result names a file to pass to animation as animation_file.
    """
    import json, math, os
    from mathutils import Matrix, Vector
    if not isinstance(name, str) or not name or any(c in name for c in '/\\:*?"<>|'):
        raise ValueError(f"name must be the animation's name, usable as a file name, got {name!r}")
    if not isinstance(rig, str) or not rig.startswith("game."):
        raise ValueError("rig must be the model's path in Studio, such as game.Workspace.Wolf")
    scene = bpy.context.scene
    start = scene.frame_start if start is None else int(start)
    end = scene.frame_end if end is None else int(end)
    if end <= start:
        raise ValueError(f"end ({end}) must be after start ({start})")
    fps = scene.render.fps / scene.render.fps_base
    if (end - start) / fps > _MAX_SECONDS:
        raise ValueError(f"frames {start} to {end} last {(end - start) / fps:.1f} s; an animation lasts at most {_MAX_SECONDS}")
    step = max(1, math.ceil((end - start) / (_MAX_SAMPLES - 1)))
    frames = list(range(start, end, step)) + [end]

    def sample(frame):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        return bpy.context.evaluated_depsgraph_get()

    joints, baked, ignored = [], [], set()
    if source.type == "ARMATURE":
        world = source.matrix_world.copy()
        bones = list(source.data.bones)
        tops = [bone for bone in bones if bone.parent is None]
        rest_world = {bone.name: (world @ bone.matrix_local).to_quaternion() for bone in bones}
        rest_local = {bone.name: (bone.parent.matrix_local.inverted() @ bone.matrix_local) if bone.parent else bone.matrix_local.copy() for bone in bones}
        for bone in bones:
            entry = {"name": bone.name}
            if bone.parent is not None:
                entry["parent"] = bone.parent.name
                entry["offset"] = _studs(world @ bone.head_local - world @ bone.parent.head_local)
            joints.append(entry)
        for frame in frames:
            posed = source.evaluated_get(sample(frame)).pose.bones
            rotations = {}
            for bone in bones:
                pose = posed[bone.name]
                local = (pose.parent.matrix.inverted() @ pose.matrix) if pose.parent else pose.matrix
                basis = rest_local[bone.name].inverted() @ local
                turn = rest_world[bone.name] @ basis.to_quaternion() @ rest_world[bone.name].inverted()
                rotations[bone.name] = _quaternion(turn)
                if bone.parent is not None and basis.to_translation().length > 1e-3:
                    ignored.add(bone.name)
            entry = {"time": round((frame - start) / fps, 5), "rotations": rotations}
            if len(tops) == 1:
                entry["travel"] = _studs(world @ posed[tops[0].name].matrix.to_translation() - world @ tops[0].matrix_local.to_translation())
            baked.append(entry)
    elif source.type == "MESH":
        pieces = []

        def gather(item, parent):
            piece = item if item.type == "MESH" else None
            if piece is not None:
                pieces.append((piece, parent))
            for child in item.children:
                gather(child, piece or parent)

        gather(source, None)
        rest = {piece.name: piece.evaluated_get(sample(start if rest_frame is None else int(rest_frame))).matrix_world.copy() for piece, _ in pieces}
        centre = sum((Vector(corner) for corner in source.bound_box), Vector()) / 8
        body_at = rest[source.name] @ centre
        named = {piece.name: (root_joint if parent is None else _joint_name(piece.data.name)) for piece, parent in pieces}
        for piece, parent in pieces:
            entry = {"name": named[piece.name]}
            if parent is not None:
                entry["parent"] = named[parent.name]
                entry["offset"] = _studs(rest[piece.name].to_translation() - (body_at if parent is source else rest[parent.name].to_translation()))
            joints.append(entry)
        for frame in frames:
            depsgraph = sample(frame)
            now = {piece.name: piece.evaluated_get(depsgraph).matrix_world.copy() for piece, _ in pieces}
            rotations = {}
            for piece, parent in pieces:
                turned, rested = now[piece.name].to_quaternion(), rest[piece.name].to_quaternion()
                if parent is None:
                    turn = turned @ rested.inverted()
                else:
                    above = rest[parent.name].to_quaternion()
                    turn = above @ now[parent.name].to_quaternion().inverted() @ turned @ rested.inverted()
                    slid = (now[parent.name].inverted() @ now[piece.name]).to_translation() - (rest[parent.name].inverted() @ rest[piece.name]).to_translation()
                    if slid.length > 1e-3:
                        ignored.add(piece.name)
                rotations[named[piece.name]] = _quaternion(turn)
            travel = now[source.name] @ centre - body_at
            baked.append({"time": round((frame - start) / fps, 5), "rotations": rotations, "travel": _studs(travel)})
    else:
        raise ValueError(f"{source.name} is a {source.type.lower()}; export_animation takes an armature, or a creature's body piece")
    scene.frame_set(start)

    path = os.path.join(_OUTPUT_DIR, name + ".bake.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"name": name, "rig": rig, "loop": bool(loop), "rootJoint": root_joint, "joints": joints, "frames": baked,
                   "ignoredTravel": sorted(ignored)[:16]}, handle)
    return path


_FLIPBOOK_SIDE = 1024
_FLIPBOOK_GRIDS = (2, 4, 8)
# A sheet larger than this is not attached to the result, so a half-size copy is written to look at.
_FLIPBOOK_PREVIEW_BYTES = 1800 * 1024


def _write_png(path, rgba):
    """Write rows of 8-bit RGBA, top row first, as a PNG."""
    import struct, zlib
    height, width = rgba.shape[0], rgba.shape[1]

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    import numpy
    rows = numpy.zeros((height, width * 4 + 1), dtype=numpy.uint8)
    rows[:, 1:] = rgba.reshape(height, width * 4)
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)))
        handle.write(chunk(b"IDAT", zlib.compress(rows.tobytes(), 9)))
        handle.write(chunk(b"IEND", b""))


def flipbook(name, grid=4, mode="alpha", start=None, end=None, loop=False, padding=4):
    """Render the scene's animation through its camera into one particle flipbook sheet.

    The sheet is 1024 x 1024, the size seen playing as a flipbook in Roblox. grid is 2, 4 or
    8: 4, 16 or 64 frames. Frames from start to end (the scene's own by default) are sampled
    evenly to fill every cell, because Roblox plays every cell; a shorter animation holds some
    frames for two cells. The scene is rendered as it is, so any material, simulation or
    compositor setup shows in the sheet. mode "alpha" renders on a
    transparent film, for smoke, dust and anything that darkens (LightEmission 0); "additive"
    renders on black, for fire, energy and glows (LightEmission 1). Each frame is rendered
    padding pixels inside its cell, so frames cannot run into each other. loop says the last
    frame leads back into the first, as for a burning fire; leave it False for a burst that plays
    once. The scene's render engine is used: Eevee or Workbench render a 64-frame sheet in
    seconds, Cycles can take minutes. Colour is rendered with the Standard view transform, so
    glows stay bright. Writes <name>.flipbook.png to OUTPUT_DIR, which Roqer checks.
    """
    import json, os, time, numpy
    if not isinstance(name, str) or not name or any(c in name for c in '/\\:*?"<>|.'):
        raise ValueError(f"name must be the sheet's name, usable as a file name without dots, got {name!r}")
    if grid not in _FLIPBOOK_GRIDS:
        raise ValueError(f"grid must be 2, 4 or 8 (Roblox's Grid2x2, Grid4x4 and Grid8x8), got {grid!r}")
    if mode not in ("alpha", "additive"):
        raise ValueError(f'mode must be "alpha" (transparent film, LightEmission 0) or "additive" (black background, LightEmission 1), got {mode!r}')
    cell = _FLIPBOOK_SIDE // grid
    if not isinstance(padding, int) or padding < 0 or padding > cell // 8:
        raise ValueError(f"padding must be a whole number of pixels from 0 to {cell // 8} for a {grid} x {grid} grid, got {padding!r}")
    scene = bpy.context.scene
    if scene.camera is None:
        raise ValueError("the scene has no camera; add one and set scene.camera, framed so the whole effect stays in view")
    start = scene.frame_start if start is None else int(start)
    end = scene.frame_end if end is None else int(end)
    cells = grid * grid
    span = end - start + (0 if loop else 1)
    if end <= start:
        raise ValueError(f"end ({end}) must be after start ({start})")
    if span < cells:
        print(f"roqer.flipbook: frames {start} to {end} give {span} distinct frames for {cells} cells, so some frames are held "
              f"for two cells; a longer animation or a smaller grid avoids the holds", flush=True)
    if loop:
        frames = [start + round((end - start) * i / cells) for i in range(cells)]
    else:
        frames = [start + round((end - start) * i / (cells - 1)) for i in range(cells)]

    render = scene.render
    view = scene.view_settings
    saved = {
        "resolution_x": render.resolution_x, "resolution_y": render.resolution_y,
        "resolution_percentage": render.resolution_percentage, "film_transparent": render.film_transparent,
        "filepath": render.filepath, "file_format": render.image_settings.file_format,
        "color_mode": render.image_settings.color_mode, "view_transform": view.view_transform,
        "look": view.look, "world": scene.world, "frame": scene.frame_current,
    }
    inner = cell - 2 * padding
    frames_dir = os.path.join(os.path.dirname(_OUTPUT_DIR), "flipbook-frames", name)
    os.makedirs(frames_dir, exist_ok=True)
    seconds = []
    sheet = numpy.zeros((_FLIPBOOK_SIDE, _FLIPBOOK_SIDE, 4), dtype=numpy.uint8)
    if mode == "additive":
        sheet[:, :, 3] = 255
    black = None
    try:
        render.resolution_x = render.resolution_y = inner
        render.resolution_percentage = 100
        render.image_settings.file_format = "PNG"
        view.view_transform = "Standard"
        view.look = "None"
        if mode == "alpha":
            render.film_transparent = True
            render.image_settings.color_mode = "RGBA"
        else:
            render.film_transparent = False
            render.image_settings.color_mode = "RGB"
            black = bpy.data.worlds.new("RoqerFlipbookBlack")
            black.color = (0.0, 0.0, 0.0)
            if black.node_tree is not None:
                for node in black.node_tree.nodes:
                    if node.type == "BACKGROUND":
                        node.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
                        node.inputs["Strength"].default_value = 0.0
            scene.world = black
        for index, frame in enumerate(frames):
            scene.frame_set(frame)
            path = os.path.join(frames_dir, f"{index:02d}.png")
            render.filepath = path
            began = time.perf_counter()
            bpy.ops.render.render(write_still=True)
            seconds.append(round(time.perf_counter() - began, 3))
            image = bpy.data.images.load(path, check_existing=False)
            try:
                width, height = image.size
                if (width, height) != (inner, inner):
                    raise RuntimeError(f"frame {frame} rendered at {width} x {height}, not {inner} x {inner}")
                pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
                image.pixels.foreach_get(pixels)
            finally:
                bpy.data.images.remove(image)
            # Blender keeps rows bottom first; the sheet is written top first.
            frame_rgba = numpy.flipud((numpy.clip(pixels, 0.0, 1.0) * 255.0 + 0.5).astype(numpy.uint8).reshape(height, width, 4))
            if mode == "additive":
                frame_rgba[:, :, 3] = 255
            row, column = divmod(index, grid)
            top, left = row * cell + padding, column * cell + padding
            sheet[top:top + inner, left:left + inner] = frame_rgba
    finally:
        render.resolution_x, render.resolution_y = saved["resolution_x"], saved["resolution_y"]
        render.resolution_percentage = saved["resolution_percentage"]
        render.film_transparent = saved["film_transparent"]
        render.filepath = saved["filepath"]
        render.image_settings.file_format = saved["file_format"]
        render.image_settings.color_mode = saved["color_mode"]
        view.view_transform, view.look = saved["view_transform"], saved["look"]
        scene.world = saved["world"]
        if black is not None:
            bpy.data.worlds.remove(black)
        scene.frame_set(saved["frame"])

    fps = render.fps / render.fps_base
    return _write_flipbook(name, sheet, {"name": name, "grid": grid, "mode": mode, "padding": padding, "loop": bool(loop),
                                         "fps": round(cells / ((frames[-1] - frames[0] + (frames[1] - frames[0] if loop else 0)) / fps), 3) if frames[-1] > frames[0] else None,
                                         "frames": frames, "engine": render.engine, "renderSeconds": seconds})


def _check_name(name):
    if not isinstance(name, str) or not name or any(c in name for c in '/\\:*?"<>|.'):
        raise ValueError(f"name must be usable as a file name without dots, got {name!r}")


def _write_flipbook(name, sheet, note):
    """Write a packed sheet and the note Roqer checks it against, plus a half-size copy when the sheet is too big to attach."""
    import json, os, numpy
    path = os.path.join(_OUTPUT_DIR, name + ".flipbook.png")
    _write_png(path, sheet)
    if os.path.getsize(path) > _FLIPBOOK_PREVIEW_BYTES:
        half = sheet.reshape(_FLIPBOOK_SIDE // 2, 2, _FLIPBOOK_SIDE // 2, 2, 4).mean(axis=(1, 3))
        _write_png(os.path.join(_OUTPUT_DIR, name + ".flipbook-preview.png"), (half + 0.5).astype(numpy.uint8))
    with open(os.path.join(_OUTPUT_DIR, name + ".flipbook.json"), "w", encoding="utf-8") as handle:
        json.dump(note, handle)
    return path


# 2D texture drawing with numpy, for the hard-edged, stylised shapes most Roblox
# VFX textures are: a shape built from coordinates, broken up by noise, cut
# with a hard edge, and eaten away over the frames. Images are float arrays,
# row 0 at the top. tex_coords runs -1..1 with x to the right and y up.

def tex_coords(size=256):
    """Return (x, y): two size x size float arrays running -1..1 across the image, x to the right and y up."""
    import numpy
    size = _texture_size(size)
    steps = (numpy.arange(size, dtype=numpy.float32) + 0.5) / size * 2.0 - 1.0
    return numpy.tile(steps, (size, 1)), numpy.tile(-steps[:, None], (1, size))


def tex_polar(x, y):
    """Return (r, angle) for coordinates x, y: distance from the centre, and the angle in radians from +x, counterclockwise, -pi..pi."""
    import numpy
    return numpy.hypot(x, y), numpy.arctan2(y, x)


def _texture_size(size):
    if not isinstance(size, int) or size < 8 or size > 2048:
        raise ValueError(f"size must be a whole number of pixels from 8 to 2048, got {size!r}")
    return size


def tex_noise(size=256, scale=4, octaves=4, seed=0):
    """Smooth fractal noise in 0..1 that tiles. scale is how many blobs fit across the image at the coarsest octave; each further octave adds detail at twice the frequency and half the strength."""
    import numpy
    size = _texture_size(size)
    if not isinstance(octaves, int) or octaves < 1 or octaves > 8:
        raise ValueError(f"octaves must be a whole number from 1 to 8, got {octaves!r}")
    rng = numpy.random.default_rng(seed)
    total = numpy.zeros((size, size), dtype=numpy.float32)
    weight = 0.0
    for octave in range(octaves):
        frequency = max(1, int(round(scale))) * 2 ** octave
        lattice = rng.random((frequency, frequency), dtype=numpy.float32)
        at = numpy.arange(size, dtype=numpy.float32) * frequency / size
        low = numpy.floor(at).astype(int)
        f = at - low
        f = f * f * (3.0 - 2.0 * f)
        low %= frequency
        high = (low + 1) % frequency
        top = lattice[numpy.ix_(low, low)] * (1 - f)[None, :] + lattice[numpy.ix_(low, high)] * f[None, :]
        bottom = lattice[numpy.ix_(high, low)] * (1 - f)[None, :] + lattice[numpy.ix_(high, high)] * f[None, :]
        amplitude = 0.5 ** octave
        total += (top * (1 - f)[:, None] + bottom * f[:, None]) * amplitude
        weight += amplitude
    return total / weight


def tex_cells(size=256, cells=8, seed=0):
    """Cellular (Voronoi) noise that tiles: cells x cells jittered points. Returns (near, edge): the distance to the nearest point and the gap between the nearest and second-nearest, both in cell widths. edge is 0 on the borders between cells, so tex_edge(edge, 0.05) draws the cracks, and near < radius draws round blobs."""
    import numpy
    size = _texture_size(size)
    if not isinstance(cells, int) or cells < 1 or cells > 64:
        raise ValueError(f"cells must be a whole number from 1 to 64, got {cells!r}")
    rng = numpy.random.default_rng(seed)
    jitter = rng.random((cells, cells, 2), dtype=numpy.float32)
    at = (numpy.arange(size, dtype=numpy.float32) + 0.5) * cells / size
    px, py = numpy.meshgrid(at, at)
    cx, cy = numpy.floor(px).astype(int), numpy.floor(py).astype(int)
    first = numpy.full((size, size), 9.0, dtype=numpy.float32)
    second = numpy.full((size, size), 9.0, dtype=numpy.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nx, ny = cx + dx, cy + dy
            point = jitter[ny % cells, nx % cells]
            d = numpy.hypot(px - (nx + point[..., 0]), py - (ny + point[..., 1]))
            second = numpy.where(d < first, first, numpy.minimum(second, d))
            first = numpy.minimum(first, d)
    return first, second - first


def tex_sample(image, u, v):
    """Look a 2D image up at u, v (0..1 across and down the image), wrapping and blending between pixels. Scroll, stretch or warp noise per frame with it, as in tex_sample(noise, x * 0.5 + t, y * 0.5)."""
    import numpy
    image = numpy.asarray(image, dtype=numpy.float32)
    height, width = image.shape[:2]
    x = (numpy.asarray(u, dtype=numpy.float32) % 1.0) * width - 0.5
    y = (numpy.asarray(v, dtype=numpy.float32) % 1.0) * height - 0.5
    x0, y0 = numpy.floor(x).astype(int), numpy.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    x0, y0 = x0 % width, y0 % height
    x1, y1 = (x0 + 1) % width, (y0 + 1) % height
    return (image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x1] * fx * (1 - fy)
            + image[y1, x0] * (1 - fx) * fy + image[y1, x1] * fx * fy)


def tex_edge(value, at=0.0, soft=0.01):
    """0 below at and 1 above it, blended over soft: the hard, cel-shaded edge. Keep soft near 0.01 for a crisp silhouette; raise it for a glow."""
    import numpy
    soft = max(float(soft), 1e-5)
    t = numpy.clip((numpy.asarray(value, dtype=numpy.float32) - (at - soft)) / (2 * soft), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def tex_ease(t, power=3.0):
    """Ease out: fast at first, then slow, as a burst grows. t is clamped to 0..1."""
    import numpy
    return 1.0 - (1.0 - numpy.clip(t, 0.0, 1.0)) ** power


_WARP_NOISE = {}


def tex_curve(points, samples=64, closed=False):
    """A smooth curve through control points (Catmull-Rom), as an (n, 2) array of x, y in tex_coords units. closed=True joins the last point back to the first. Feed it to tex_stroke."""
    import numpy
    p = numpy.asarray(points, dtype=numpy.float32)
    if p.ndim != 2 or p.shape[1] != 2 or len(p) < 2:
        raise ValueError("points must be at least two (x, y) pairs")
    if not isinstance(samples, int) or samples < 4 or samples > 1024:
        raise ValueError(f"samples must be a whole number from 4 to 1024, got {samples!r}")
    if closed:
        p = numpy.concatenate([p[-1:], p, p[:2]])
    else:
        p = numpy.concatenate([p[:1] * 2 - p[1:2], p, p[-1:] * 2 - p[-2:-1]])
    spans = len(p) - 3
    out = []
    for i in range(spans):
        p0, p1, p2, p3 = p[i], p[i + 1], p[i + 2], p[i + 3]
        t = numpy.linspace(0, 1, max(2, samples // spans), endpoint=(i == spans - 1))[:, None]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t ** 2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return numpy.concatenate(out)


def tex_stroke(x, y, path, width=0.08, start=0.0, end=1.0):
    """A stroke along a path, the way a brush draws it: positive inside, about the distance to its edge, so tex_edge cuts it.

    path is an (n, 2) array of points in tex_coords units; tex_curve makes a smooth one. width is
    the full width: a number, a list of widths spread evenly from head to tail, or a function of u
    (0 at the head, 1 at the tail). Tapering it gives the thick-to-thin pen pressure of a drawn
    claw, crescent, wisp or crack. Only the part from start to end (0 to 1 along the path) is drawn:
    raise end over the frames to draw the stroke on, and start to erase it from the head. Combine
    strokes and shapes with numpy.maximum (union) or numpy.minimum (intersection; subtract one with
    numpy.minimum(a, -b)).
    """
    import numpy
    path = numpy.asarray(path, dtype=numpy.float32)
    if path.ndim != 2 or path.shape[1] != 2 or len(path) < 2:
        raise ValueError("path must be at least two (x, y) points, as tex_curve returns")
    if len(path) > 2048:
        raise ValueError(f"path has {len(path)} points; use at most 2048 (fewer tex_curve samples)")
    seg = numpy.linalg.norm(numpy.diff(path, axis=0), axis=1)
    along = numpy.concatenate([[0.0], numpy.cumsum(seg)])
    along = along / max(float(along[-1]), 1e-6)
    if callable(width):
        def profile(u):
            return numpy.asarray(width(u), dtype=numpy.float32)
    elif numpy.ndim(width) == 0:
        def profile(u):
            return numpy.full_like(u, float(width))
    else:
        keys = numpy.asarray(width, dtype=numpy.float32)

        def profile(u):
            return numpy.interp(u, numpy.linspace(0, 1, len(keys)), keys).astype(numpy.float32)
    field = numpy.full(numpy.shape(x), -1.0, dtype=numpy.float32)
    for i in range(len(path) - 1):
        a, b = path[i], path[i + 1]
        d = b - a
        length2 = max(float(d @ d), 1e-12)
        t = numpy.clip(((x - a[0]) * d[0] + (y - a[1]) * d[1]) / length2, 0.0, 1.0)
        u = along[i] + (along[i + 1] - along[i]) * t
        inside = profile(u) * 0.5 - numpy.hypot(x - (a[0] + d[0] * t), y - (a[1] + d[1] * t))
        field = numpy.maximum(field, numpy.where((u >= start) & (u <= end), inside, -1.0))
    return field


def tex_warp(x, y, amount=0.1, scale=3, seed=0, t=0.0):
    """x, y pushed around by smooth noise. Shapes drawn with the warped coordinates come out lopsided and organic instead of geometric; t drifts the noise to animate it."""
    import numpy
    key = (int(scale), int(seed))
    if key not in _WARP_NOISE:
        _WARP_NOISE[key] = (tex_noise(256, scale, 3, seed), tex_noise(256, scale, 3, seed + 101))
    nx, ny = _WARP_NOISE[key]
    u, v = x * 0.5 + 0.5 + t, y * 0.5 + 0.5
    return x + (tex_sample(nx, u, v) - 0.5) * 2 * amount, y + (tex_sample(ny, u, v) - 0.5) * 2 * amount


def tex_blob(x, y, radius=0.5, lumps=6, roughness=0.5, seed=0, centre=(0.0, 0.0)):
    """A lumpy, asymmetric blob: overlapping circles scattered around a centre. Positive inside; tex_edge cuts it. More lumps and roughness give more lobes and overhangs."""
    import numpy
    rng = numpy.random.default_rng(seed)
    field = numpy.full(numpy.shape(x), -1.0, dtype=numpy.float32)
    for _ in range(max(1, int(lumps))):
        angle = rng.uniform(0, 2 * numpy.pi)
        reach = rng.uniform(0, radius * roughness * 1.6)
        r = radius * rng.uniform(1 - min(roughness, 0.9), 1.0) * 0.75
        cx, cy = centre[0] + numpy.cos(angle) * reach, centre[1] + numpy.sin(angle) * reach
        field = numpy.maximum(field, r - numpy.hypot(x - cx, y - cy))
    return field


def _drawn_rgba(result, size, mode, where):
    """A drawing function's result as size x size x 4 floats: alpha alone, (alpha, value), or RGB / RGBA."""
    import numpy
    if isinstance(result, tuple):
        if len(result) != 2:
            raise ValueError(f"{where} returned a tuple of {len(result)}; return alpha, (alpha, value) or an RGBA array")
        alpha = numpy.asarray(result[0], dtype=numpy.float32)
        value = numpy.broadcast_to(numpy.asarray(result[1], dtype=numpy.float32), (size, size))
        if alpha.shape != (size, size):
            raise ValueError(f"{where} returned alpha shaped {alpha.shape}; it must be {size} x {size}")
        rgba = numpy.stack([value, value, value, alpha], axis=-1)
    else:
        array = numpy.asarray(result, dtype=numpy.float32)
        if array.shape == (size, size):
            rgba = numpy.stack([numpy.ones_like(array)] * 3 + [array], axis=-1)
        elif array.shape == (size, size, 4):
            rgba = array
        elif array.shape == (size, size, 3):
            rgba = numpy.concatenate([array, numpy.ones((size, size, 1), dtype=numpy.float32)], axis=-1)
        else:
            raise ValueError(f"{where} returned an array shaped {array.shape}; it must be {size} x {size} (alpha), or {size} x {size} x 3 or 4")
    rgba = numpy.clip(numpy.nan_to_num(rgba), 0.0, 1.0)
    if mode == "additive":
        rgba = numpy.concatenate([rgba[..., :3] * rgba[..., 3:4], numpy.ones((size, size, 1), dtype=numpy.float32)], axis=-1)
    return (rgba * 255.0 + 0.5).astype(numpy.uint8)


def draw_flipbook(name, frame, grid=4, loop=False, fps=None, mode="alpha", padding=4):
    """Draw a particle flipbook frame by frame with numpy and pack it into a 1024 x 1024 sheet Roqer checks.

    frame(t, size) draws one frame size pixels square. t runs from 0 at the first frame to 1 at
    the last (to just under 1 for a loop, whose last frame leads back to the first). It returns
    alpha (a size x size array, 0..1) for a white shape, or (alpha, value) where value is the grey
    level (a number or an array), or an RGB or RGBA array. White shapes are usual: the particle's
    Color tints them, and value lets two tones in one shape take one colour. grid is 2, 4 or 8
    (4, 16 or 64 frames); 4 is what most studied artists' sheets use. fps is the speed the frames
    are meant to play at, used to suggest the Lifetime or framerate. mode "alpha" keeps a
    transparent background (LightEmission 0 or below); "additive" bakes alpha onto black for
    LightEmission 1. padding pixels around each frame stay empty. Writes <name>.flipbook.png.
    """
    import numpy
    _check_name(name)
    if not callable(frame):
        raise ValueError("frame must be a function frame(t, size) that returns the frame's alpha, (alpha, value) or an RGBA array")
    if grid not in _FLIPBOOK_GRIDS:
        raise ValueError(f"grid must be 2, 4 or 8 (Roblox's Grid2x2, Grid4x4 and Grid8x8), got {grid!r}")
    if mode not in ("alpha", "additive"):
        raise ValueError(f'mode must be "alpha" or "additive", got {mode!r}')
    cell = _FLIPBOOK_SIDE // grid
    if not isinstance(padding, int) or padding < 0 or padding > cell // 8:
        raise ValueError(f"padding must be a whole number of pixels from 0 to {cell // 8} for a {grid} x {grid} grid, got {padding!r}")
    if fps is not None and (not isinstance(fps, (int, float)) or fps <= 0):
        raise ValueError(f"fps must be a positive number or None, got {fps!r}")
    cells = grid * grid
    inner = cell - 2 * padding
    sheet = numpy.zeros((_FLIPBOOK_SIDE, _FLIPBOOK_SIDE, 4), dtype=numpy.uint8)
    if mode == "additive":
        sheet[:, :, 3] = 255
    for index in range(cells):
        t = index / cells if loop else index / (cells - 1)
        where = f"frame(t={t:.3f}, size={inner})"
        drawn = _drawn_rgba(frame(t, inner), inner, mode, where)
        row, column = divmod(index, grid)
        top, left = row * cell + padding, column * cell + padding
        sheet[top:top + inner, left:left + inner] = drawn
    return _write_flipbook(name, sheet, {"name": name, "grid": grid, "mode": mode, "padding": padding, "loop": bool(loop),
                                         "fps": float(fps) if fps is not None else None, "drawn": True})


def draw_texture(name, image, size=512, mode="alpha"):
    """Draw one texture with numpy and write it as <name>.png. image is an array, or a function image(size) returning one: alpha, (alpha, value) or RGB / RGBA, as for draw_flipbook. mode "alpha" keeps transparency; "additive" bakes it onto black."""
    import os
    _check_name(name)
    size = _texture_size(size)
    if mode not in ("alpha", "additive"):
        raise ValueError(f'mode must be "alpha" or "additive", got {mode!r}')
    drawn = _drawn_rgba(image(size) if callable(image) else image, size, mode, "image")
    path = os.path.join(_OUTPUT_DIR, name + ".png")
    _write_png(path, drawn)
    return path


# VFX shapes. Each is one open sheet of quads with a UV map laid out the same
# way: U runs along the sweep (0 at the start, 1 at the end), V runs across it
# (0 inside or at the bottom, 1 outside or at the top). A texture whose alpha
# fades along U then fades a slash toward its tail, and one that fades across V
# softens a ring's edges. Shapes face Roblox's forward: Blender -Y.
_MAX_VFX_SEGMENTS = 256


def _segments(value, name, low):
    if not isinstance(value, int) or value < low or value > _MAX_VFX_SEGMENTS:
        raise ValueError(f"{name} must be a whole number from {low} to {_MAX_VFX_SEGMENTS}, got {value!r}")
    return value


def vfx_surface(name, point, columns=32, rows=1, rgba=None):
    """Any shape you can describe as a function: a sheet of columns x rows quads, where point(u, v)
    gives the position (three numbers, in studs) of each grid corner for u and v from 0 to 1, and
    the corner's UV is (u, v). Corners that land on the same spot are merged, so closed loops and
    poles need no special care. The named vfx_ shapes are built with it; use it for anything they
    do not cover: a jagged shockwave (vary the radius with u), a forked lightning card, petals, a
    wobbling wave, a spiked burst.
    """
    if not callable(point):
        raise ValueError("point must be a function point(u, v) returning (x, y, z) in studs")
    columns = _segments(columns, "columns", 1)
    rows = _segments(rows, "rows", 1)
    return _strip(name, columns, rows, lambda u, v: _vector(point(u, v), "point(u, v)"), rgba)


def _strip(name, columns, rows, point, rgba):
    """A grid of columns x rows quads at point(u, v), with UVs (u, v); u and v run 0 to 1."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    grid = [[bm.verts.new(point(c / columns, r / rows)) for r in range(rows + 1)] for c in range(columns + 1)]
    for c in range(columns):
        for r in range(rows):
            corners = [(c, r), (c + 1, r), (c + 1, r + 1), (c, r + 1)]
            face = bm.faces.new([grid[i][j] for i, j in corners])
            for loop, (i, j) in zip(face.loops, corners):
                loop[uv].uv = (i / columns, j / rows)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    obj = _object(name, bm, rgba)
    return obj


def _around(angle):
    """Unit direction at angle radians from Blender -Y (Roblox's forward), turning toward +X."""
    import math
    return Vector((math.sin(angle), -math.cos(angle), 0.0))


def vfx_arc(name, radius, width, sweep=160, segments=32, taper=True, rgba=None):
    """A flat crescent card for a slash, lying in the horizontal plane around the origin.

    It sweeps sweep degrees centred on forward (Blender -Y), from radius - width to radius.
    With taper the band is widest in the middle and comes to a point at both ends: a crescent.
    U runs along the sweep from its start (+X side) to its end (-X side), V from the inner edge
    to the outer. Roll or tilt the MeshPart in Studio for a diagonal swing, and set DoubleSided.
    """
    import math
    radius, width = _positive(radius, "radius"), _positive(width, "width")
    if width >= radius:
        raise ValueError(f"width ({width}) must be less than radius ({radius}): the band runs from radius - width to radius")
    if not isinstance(sweep, (int, float)) or not 10 <= sweep <= 350:
        raise ValueError(f"sweep must be 10 to 350 degrees, got {sweep!r}")
    segments = _segments(segments, "segments", 4)
    half = math.radians(sweep) / 2

    def point(u, v):
        across = math.sin(math.pi * u) if taper else 1.0
        inner = radius - width * max(across, 0.02)
        return _around(half - 2 * half * u) * (inner + (radius - inner) * v)

    return _strip(name, segments, 1 if not taper else 2, point, rgba)


def vfx_ring(name, radius, width=0.5, height=0.0, top_radius=None, segments=48, rgba=None):
    """A shockwave ring around the vertical axis.

    With height 0 it is a flat band on the ground from radius - width to radius. With a height
    it is a wall from radius at the bottom to top_radius (radius by default) at the top: flare
    the top outward for a blast wave. U runs once around, V across the band or up the wall.
    """
    import math
    radius = _positive(radius, "radius")
    segments = _segments(segments, "segments", 8)
    if not isinstance(height, (int, float)) or height < 0:
        raise ValueError(f"height must be 0 (a flat band) or a positive number of studs, got {height!r}")
    if height == 0:
        width = _positive(width, "width")
        if width >= radius:
            raise ValueError(f"width ({width}) must be less than radius ({radius})")
        return _strip(name, segments, 1, lambda u, v: _around(2 * math.pi * u) * (radius - width + width * v), rgba)
    top = radius if top_radius is None else _positive(top_radius, "top_radius")
    return _strip(name, segments, 1, lambda u, v: _around(2 * math.pi * u) * (radius + (top - radius) * v) + Vector((0, 0, height * v)), rgba)


def vfx_cone(name, radius, height, tip_radius=0.0, segments=32, rgba=None):
    """An open cone shell from a base of radius at the origin up to tip_radius at height.

    Point it with the MeshPart's orientation in Studio: up the axis for a burst, along the
    LookVector for a muzzle blast. U runs around, V from the base to the tip.
    """
    import math
    radius, height = _positive(radius, "radius"), _positive(height, "height")
    if not isinstance(tip_radius, (int, float)) or tip_radius < 0:
        raise ValueError(f"tip_radius must be 0 (a point) or a positive number of studs, got {tip_radius!r}")
    segments = _segments(segments, "segments", 8)
    return _strip(name, segments, 4,
                  lambda u, v: _around(2 * math.pi * u) * (radius + (max(tip_radius, 0.001) - radius) * v) + Vector((0, 0, height * v)), rgba)


def vfx_swirl(name, radius, height, width, turns=1.5, top_radius=None, segments=96, rgba=None):
    """A ribbon spiralling up around the vertical axis: a tornado, an aura, a charge-up.

    It turns the given number of times while rising from 0 to height, its radius going from radius to
    top_radius (radius by default), and the ribbon is width tall. U runs along the ribbon from
    the bottom end, V across it from its lower edge.
    """
    import math
    radius, height, width = _positive(radius, "radius"), _positive(height, "height"), _positive(width, "width")
    if not isinstance(turns, (int, float)) or not 0.1 <= turns <= 8:
        raise ValueError(f"turns must be 0.1 to 8, got {turns!r}")
    top = radius if top_radius is None else _positive(top_radius, "top_radius")
    segments = _segments(segments, "segments", 8)

    def point(u, v):
        return _around(2 * math.pi * turns * u) * (radius + (top - radius) * u) + Vector((0, 0, height * u + width * (v - 0.5)))

    return _strip(name, segments, 1, point, rgba)


def vfx_shell(name, radius, segments=32, rings=16, dome=False, rgba=None):
    """A sphere, or with dome a half sphere standing on the ground, as one shell: a barrier,
    a blast bubble, a shield. U runs around, V from the bottom (the equator for a dome) to the top.
    """
    import math
    radius = _positive(radius, "radius")
    segments = _segments(segments, "segments", 8)
    rings = _segments(rings, "rings", 2)

    def point(u, v):
        polar = (math.pi / 2) * (1 - v) if dome else math.pi * (1 - v)
        return _around(2 * math.pi * u) * (radius * math.sin(polar)) + Vector((0, 0, radius * math.cos(polar)))

    return _strip(name, segments, rings, point, rgba)


_MAX_INFLUENCES = 4
# The share of a chain's first bone, either side of its head, over which a part's weight passes to the bone above.
_ROOT_BLEND = 0.25


def bind(obj, bones):
    """Say which bones a part follows, before it is joined and skinned.

    bones is one bone's name, for a part that moves rigidly with it (a paw with its foot bone),
    or a list of names, for a part that bends between them (a tail along its tail bones).
    roqer.skin weights each of its vertices among those bones only. A part that is not bound
    is weighted among every bone, by which lie nearest.
    """
    names = [bones] if isinstance(bones, str) else list(bones)
    if not names or not all(isinstance(name, str) and name for name in names):
        raise ValueError(f"bones must be a bone's name or a list of names, got {bones!r}")
    indices = [vertex.index for vertex in obj.data.vertices]
    for name in names:
        group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
        group.add(indices, 1.0, "REPLACE")
    return obj


def _segment_distance(point, head, tail):
    along = tail - head
    length = along.length_squared
    share = 0.0 if length < 1e-12 else max(0.0, min(1.0, (point - head).dot(along) / length))
    return (point - (head + along * share)).length


def skin(obj, bones, name="Armature"):
    """Skin one mesh to an armature, so it bends at its bones when animated in Studio.

    bones lists (name, head, tail) or (name, head, tail, parent): each bone runs from head to
    tail in studs, a parent before its children. obj is the whole creature as one object, joined
    with roqer.join. Every vertex is weighted to the bones nearest it, blending where two meet,
    at most four a vertex and summing to 1; a part bound with roqer.bind keeps to its own bones.
    Returns the armature. Export both: the upload keeps the bones and the weights.
    """
    if obj.type != "MESH":
        raise ValueError(f"{obj.name} is a {obj.type.lower()}, not a mesh")
    entries = []
    seen = set()
    for entry in bones:
        if len(entry) not in (3, 4):
            raise ValueError(f"a bone is (name, head, tail) or (name, head, tail, parent), got {entry!r}")
        bone_name, head, tail = entry[0], _vector(entry[1], "head"), _vector(entry[2], "tail")
        parent = entry[3] if len(entry) == 4 else None
        if not isinstance(bone_name, str) or not bone_name or bone_name in seen:
            raise ValueError(f"each bone needs a name of its own, got {bone_name!r}")
        if (tail - head).length < 1e-4:
            raise ValueError(f"{bone_name}'s head and tail are the same point")
        if parent is not None and parent not in seen:
            raise ValueError(f"{bone_name}'s parent {parent!r} must come before it in the list")
        seen.add(bone_name)
        entries.append((bone_name, head, tail, parent))
    if not entries:
        raise ValueError("skin needs at least one bone")
    unknown = sorted(group.name for group in obj.vertex_groups if group.name not in seen)
    if unknown:
        raise ValueError(f"parts are bound to bones that are not in the list: {', '.join(unknown)}")

    data = bpy.data.armatures.new(name)
    armature = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    with bpy.context.temp_override(active_object=armature, object=armature, selected_objects=[armature], selected_editable_objects=[armature]):
        bpy.ops.object.mode_set(mode="EDIT")
        made = {}
        for bone_name, head, tail, parent in entries:
            bone = data.edit_bones.new(bone_name)
            bone.head, bone.tail = head, tail
            if parent is not None:
                bone.parent = made[parent]
            made[bone_name] = bone
        bpy.ops.object.mode_set(mode="OBJECT")

    # Which bones each vertex may follow: those its part was bound to, or all of them.
    bound = {}
    for vertex in obj.data.vertices:
        names = [obj.vertex_groups[item.group].name for item in vertex.groups if item.weight > 0]
        if names:
            bound[vertex.index] = set(names)
    for group in list(obj.vertex_groups):
        obj.vertex_groups.remove(group)
    groups = {bone_name: obj.vertex_groups.new(name=bone_name) for bone_name, _, _, _ in entries}
    world = obj.matrix_world
    for vertex in obj.data.vertices:
        point = world @ vertex.co
        allowed = bound.get(vertex.index)
        near = sorted(
            (_segment_distance(point, head, tail), bone_name)
            for bone_name, head, tail, _ in entries if allowed is None or bone_name in allowed
        )[:_MAX_INFLUENCES]
        # Nearness to the fourth power: a vertex midway between two bones is shared, one
        # beside a bone is almost wholly its own.
        raw = [(1.0 / max(distance, 1e-4) ** 4, bone_name) for distance, bone_name in near]
        most = max(weight for weight, _ in raw)
        kept = [(weight, bone_name) for weight, bone_name in raw if weight >= most * 0.05]
        total = sum(weight for weight, _ in kept)
        shares = {bone_name: weight / total for weight, bone_name in kept}
        # Where a part that bends along several bones runs up into what it hangs from, as a
        # thigh into the rump or a tail's root into the back, it stays with that: around the
        # first bone's head its weight passes to that bone's parent, so the top of a leg does
        # not swing out of the body as the leg turns. A part bound to one bone stays rigid.
        if allowed is not None and len(allowed) > 1:
            for bone_name, head, tail, parent in entries:
                if bone_name not in shares or parent is None or parent in allowed:
                    continue
                along = (tail - head).normalized()
                margin = _ROOT_BLEND * (tail - head).length
                up = max(0.0, min(1.0, 0.5 - (point - head).dot(along) / (2 * margin)))
                if up > 0:
                    shares[parent] = shares.get(parent, 0.0) + shares[bone_name] * up
                    shares[bone_name] *= 1 - up
            ranked = sorted(((weight, bone_name) for bone_name, weight in shares.items() if weight > 1e-4), reverse=True)[:_MAX_INFLUENCES]
            total = sum(weight for weight, _ in ranked)
            shares = {bone_name: weight / total for weight, bone_name in ranked}
        for bone_name, weight in shares.items():
            if weight > 0:
                groups[bone_name].add([vertex.index], weight, "REPLACE")

    for modifier in list(obj.modifiers):
        if modifier.type == "ARMATURE":
            obj.modifiers.remove(modifier)
    obj.modifiers.new(name, "ARMATURE").object = armature
    obj.parent = armature
    obj.matrix_parent_inverse = armature.matrix_world.inverted()
    obj.data.name = obj.name
    bpy.context.view_layer.update()
    return armature
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
helpers = {"__name__": "roqer", "_OUTPUT_DIR": OUTPUT_DIR}
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
model_preview_path = args[2] if len(args) > 2 else None
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
# The glTF importer draws each bone as a shape object of its own, which is no part of the model.
armatures = [item for item in scene.objects if item.type == "ARMATURE"]
for shape in {bone.custom_shape for item in armatures for bone in item.pose.bones if bone.custom_shape is not None}:
    for bone in [bone for item in armatures for bone in item.pose.bones if bone.custom_shape is shape]:
        bone.custom_shape = None
    bpy.data.objects.remove(shape, do_unlink=True)
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
mesh_set = set(meshes)
r3 = lambda vector: [round(vector.x, 3), round(vector.y, 3), round(vector.z, 3)]
for item in meshes[:48]:
    corners = [item.matrix_world @ Vector(corner) for corner in item.bound_box]
    lo = Vector(map(min, *corners))
    hi = Vector(map(max, *corners))
    # Roblox axes: X, then Blender's up (Z) as Y, then Blender's Y as Z.
    entry = {"name": item.name, "size": [round(hi.x - lo.x, 2), round(hi.z - lo.z, 2), round(hi.y - lo.y, 2)]}
    # For a model of moving pieces: where the object's origin is, which is
    # where it turns; its box; the mesh object it hangs from; and its mesh's
    # own name, which is what Roblox names the MeshPart. In Blender coordinates.
    entry["origin"] = r3(item.matrix_world.translation)
    entry["low"], entry["high"] = r3(lo), r3(hi)
    entry["mesh"] = item.data.name
    entry["materials"] = sum(1 for slot in item.material_slots if slot.material is not None)
    parent = item.parent
    while parent is not None and parent not in mesh_set:
        parent = parent.parent
    if parent is not None:
        entry["parent"] = parent.name
    objects.append(entry)
stats = {"meshes": len(meshes), "triangles": triangles, "materials": sorted(materials)[:32], "preview": False,
         "colorSource": color_source, "objects": objects}

# Skins: each armature's bones, head and tail in Blender coordinates, and for
# each mesh that follows it how its vertices are weighted, which is what Roblox
# keeps of it: a vertex no bone holds stays behind, and one held by more than
# four keeps the four largest.
skins = []
for armature in armatures[:4]:
    names = {bone.name for bone in armature.data.bones}
    entry = {"armature": armature.name, "boneCount": len(armature.data.bones), "bones": [], "meshes": []}
    for bone in list(armature.data.bones)[:96]:
        listed = {"name": bone.name, "head": r3(armature.matrix_world @ bone.head_local), "tail": r3(armature.matrix_world @ bone.tail_local)}
        if bone.parent is not None:
            listed["parent"] = bone.parent.name
        entry["bones"].append(listed)
    for item in meshes:
        # A saved scene's modifiers were baked away above; there the mesh is still the armature's child.
        follows = any(modifier.type == "ARMATURE" and modifier.object is armature for modifier in item.modifiers)
        if not follows and not (item.parent is armature and len(item.vertex_groups) > 0):
            continue
        group_names = {group.index: group.name for group in item.vertex_groups}
        unweighted = over = most = 0
        for vertex in item.data.vertices:
            held = sum(1 for group in vertex.groups if group.weight > 1e-4 and group_names.get(group.group) in names)
            most = max(most, held)
            if held == 0:
                unweighted += 1
            elif held > 4:
                over += 1
        entry["meshes"].append({"name": item.name, "mesh": item.data.name, "vertices": len(item.data.vertices),
                                "unweighted": unweighted, "overFour": over, "mostInfluences": most,
                                "materials": sum(1 for slot in item.material_slots if slot.material is not None)})
    skins.append(entry)
if skins:
    stats["skins"] = skins

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

# UVs, as they arrived: a texture (TextureID) needs them, and a VFX texture that
# fades along a sweep needs them laid out along it.
import numpy
uv_low, uv_high, without_uv, with_uv = [1e9, 1e9], [-1e9, -1e9], [], 0
for item in meshes:
    layer = item.data.uv_layers.active
    if layer is None or len(layer.data) == 0:
        without_uv.append(item.name)
        continue
    with_uv += 1
    coords = numpy.empty(len(layer.data) * 2, dtype=numpy.float32)
    layer.data.foreach_get("uv", coords)
    coords = coords.reshape(-1, 2)
    uv_low = [min(uv_low[i], float(coords[:, i].min())) for i in range(2)]
    uv_high = [max(uv_high[i], float(coords[:, i].max())) for i in range(2)]
stats["uv"] = {"meshes": with_uv, "without": without_uv[:8], "withoutCount": len(without_uv)}
if with_uv:
    stats["uv"]["low"] = [round(value, 3) for value in uv_low]
    stats["uv"]["high"] = [round(value, 3) for value in uv_high]

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
    # The model as measured, as one self-contained GLB for the 3D view in
    # Roqer's chat: the same meshes, modifiers applied, hidden objects left
    # out, images packed in. Draco stays off, so the viewer needs no decoder.
    if model_preview_path:
        try:
            # Studio shows the vertex colours a glTF file stores as sRGB, where
            # glTF and Blender mean them as linear, so the same colour looks
            # darker in Studio than in Blender. The preview stores the colour
            # Studio will show, so a viewer that follows glTF shows it too. FBX
            # and OBJ files store sRGB, which their importers have already
            # undone. A saved scene is taken as it would export to glTF.
            if extension not in (".fbx", ".obj"):
                import numpy
                converted = set()
                for item in meshes:
                    if item.data.as_pointer() in converted:
                        continue
                    converted.add(item.data.as_pointer())
                    for layer in item.data.color_attributes:
                        values = numpy.empty(len(layer.data) * 4, dtype=numpy.float32)
                        layer.data.foreach_get("color", values)
                        rgb = values.reshape(-1, 4)[:, :3]
                        rgb[:] = numpy.where(rgb <= 0.04045, rgb / 12.92, ((numpy.maximum(rgb, 0.04045) + 0.055) / 1.055) ** 2.4)
                        layer.data.foreach_set("color", values)
            # Studio takes an FBX file's vertex colours whatever its materials
            # say, and ignores a material's own colour, but Blender exports
            # only colours a material uses: wire each plain base colour to them.
            if extension == ".fbx":
                for item in meshes:
                    layer = item.data.color_attributes.active_color
                    if layer is None:
                        continue
                    for slot in item.material_slots:
                        material = slot.material
                        if material is None or not material.use_nodes or material.node_tree is None:
                            continue
                        bsdf = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
                        if bsdf is None or bsdf.inputs["Base Color"].is_linked:
                            continue
                        colors = material.node_tree.nodes.new("ShaderNodeVertexColor")
                        colors.layer_name = layer.name
                        material.node_tree.links.new(colors.outputs["Color"], bsdf.inputs["Base Color"])
            for item in scene.objects:
                try:
                    item.select_set(item in meshes)
                except Exception:
                    pass
            options = {"filepath": model_preview_path, "export_format": "GLB", "use_selection": True,
                       "export_apply": True, "export_cameras": False, "export_lights": False,
                       "export_animations": False, "export_draco_mesh_compression_enable": False}
            try:
                bpy.ops.export_scene.gltf(**options)
            except TypeError:
                # An option this Blender does not know: the plain export, which
                # still selects, embeds and leaves Draco off by default.
                bpy.ops.export_scene.gltf(filepath=model_preview_path, export_format="GLB", use_selection=True)
            stats["model3d"] = os.path.exists(model_preview_path)
        except Exception as error:
            stats["model3dError"] = str(error)[:200]
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
  /** The Studio installs a job's textures are previewed in when it asks; found on this computer by default. */
  studioContentDirectories?: () => Promise<string[]>;
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
  objects?: readonly InspectedObject[];
  /** For a model whose objects hang from one another: its pieces as `rig` joints, and what would rig badly. */
  articulation?: Articulation;
  /** For a skinned model: its armature's bones and how each mesh that follows them is weighted. */
  skins?: readonly InspectedSkin[];
  /** Where the model's lowest point sits, in Blender units: 0 stands it on the ground. */
  bottom?: number;
  /** How the model's pieces sit against each other, in the script's Blender coordinates. */
  layout?: LayoutFacts;
  /** Objects shaded smooth across hard edges, with the share of their corners bent that way. */
  smoothShaded?: ReadonlyArray<Readonly<{ object: string; share: number }>>;
  uv?: InspectedUv;
  inspectionError?: string;
}>;

/** Which meshes arrived with UVs, and the range they span. */
export type InspectedUv = Readonly<{ meshes: number; without: readonly string[]; withoutCount: number; low?: readonly number[]; high?: readonly number[] }>;

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
    return name === undefined ? undefined : this.savedSceneIn(name, id);
  }

  private async savedSceneIn(name: string, id: string): Promise<Readonly<{ directory: string; scene: string }> | undefined> {
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

  /** The ids of this scope's jobs that saved a scene, newest first. Folder names start with the job's start time. */
  private async savedJobIds(): Promise<string[]> {
    const entries = (await fs.readdir(this.options.jobsRoot).catch(() => [] as string[])).sort().reverse();
    const ids: string[] = [];
    for (const name of entries) {
      const id = name.slice(name.lastIndexOf("-") + 1);
      if (isBlenderJobId(id) && await this.savedSceneIn(name, id) !== undefined) ids.push(id);
    }
    return ids;
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

    const requestedBase = args.continue_from;
    if (requestedBase !== undefined && !isBlenderJobId(requestedBase)) {
      return failure("continue_from must be the id of an earlier job, exactly as that job's result gave it.", "invalid_arguments", started, this.now);
    }
    let continueFrom = requestedBase;
    let notContinued: string | undefined;
    const base = continueFrom === undefined ? undefined : await this.savedScene(continueFrom);
    if (continueFrom !== undefined && base === undefined) {
      const saved = await this.savedJobIds();
      if (saved.length > 0) {
        // Picking one of these for the model would be a guess about which
        // stage it meant, so it is told what exists and chooses.
        return failure(
          `There is no saved scene from job ${continueFrom} in this chat. This chat's saved scenes, newest first: ${saved.slice(0, 5).join(", ")}. Continue from one of those, or leave continue_from out to start from an empty scene. A job saves its scene only when its script finishes, and job folders are cleared after ${JOB_RETENTION_MS / 86_400_000} days or once ${MAX_KEPT_JOBS} newer jobs exist.`,
          "scene_not_found",
          started,
          this.now,
          { savedJobs: saved.slice(0, 5) },
        );
      }
      // With no saved scene in this chat an empty scene is the only one the
      // script can start from. A model's first job sometimes names a
      // placeholder such as 00000000 for "nothing yet", and refusing it only
      // had the same script sent back until the run gave up. The result says
      // plainly that nothing was continued.
      notContinued = `Job ${continueFrom} was not continued: this chat has no saved Blender scene yet, so the script ran on an empty scene. No id stands for an empty scene; leave continue_from out for a chat's first job.`;
      continueFrom = undefined;
    }
    const beforeFailure = notContinued === undefined ? "" : `${notContinued} `;

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
      return failure(`${beforeFailure}The script ran past ${seconds} seconds and Blender was stopped. Simplify the geometry or raise timeout_seconds (at most ${MAX_BLENDER_JOB_SECONDS}).`, "timeout", started, this.now, { jobDirectory, log });
    }
    if (run.output.includes(BASE_FAILED_MARKER)) {
      return failure(`Blender could not open the scene job ${String(continueFrom)} saved, so the script did not run. Continue from another job, or start from an empty scene. The end of Blender's output:\n${log}`, "scene_not_opened", started, this.now, { jobDirectory, log });
    }
    if (run.exitCode !== 0 || run.output.includes(FAILED_MARKER) || !run.output.includes(DONE_MARKER)) {
      return failure(
        `${beforeFailure}The script failed in Blender (exit ${run.exitCode ?? "unknown"}), so nothing was saved${continueFrom === undefined ? "" : `; the scene of job ${continueFrom} is unchanged`}. The end of Blender's output:\n${log}`,
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
    const flipbookFiles = entries.filter((name) => isFlipbookFile(name));
    const sheets = flipbookFiles.filter((name) => name.toLowerCase().endsWith(FLIPBOOK_SUFFIX));
    const renders = entries.filter((name) => path.extname(name).toLowerCase() === ".png" && !flipbookFiles.includes(name));
    // Animations roqer.export_animation baked: each becomes a pose description beside it.
    const animations: BakedAnimation[] = [];
    for (const name of entries.filter((entry) => entry.toLowerCase().endsWith(BAKE_SUFFIX)).slice(0, MAX_BAKED_ANIMATIONS)) {
      animations.push(await convertBake(outputDirectory, name));
    }
    const others = entries.filter((name) => !models.includes(name) && !renders.includes(name) && !flipbookFiles.includes(name) && !name.toLowerCase().endsWith(BAKE_SUFFIX));
    if (models.length === 0 && renders.length === 0 && sheets.length === 0 && !sceneSaved) {
      return failure(
        `${beforeFailure}The script finished but left no model (.glb, .gltf, .fbx or .obj) or PNG image in OUTPUT_DIR. Export the model there, for example bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, "model.glb"), export_format="GLB", export_apply=True, use_visible=True), or render the image there.${others.length > 0 ? ` It left: ${others.join(", ")}.` : ""}`,
        "no_model_exported",
        started,
        this.now,
        { jobDirectory, outputDirectory, log },
      );
    }

    const files: InspectedFile[] = [];
    const images: McpToolImage[] = [];
    // The model the first preview pictures, which the chat shows, with its 3D preview when kept.
    let pictured: McpToolOutcome["pictured"];
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
    // A flipbook sheet is checked from its own pixels; the note the script
    // wrote beside it is only what it claims to have made.
    const flipbooks: CheckedFlipbook[] = [];
    const flipbookImages: McpToolImage[] = [];
    for (const name of sheets.slice(0, MAX_FLIPBOOKS)) {
      const checked = await checkFlipbook(outputDirectory, name);
      flipbooks.push(checked);
      if (checked.image !== undefined) flipbookImages.push(checked.image);
    }
    // Nothing exported, so the scene itself is what the model is to look at:
    // it is inspected the same way, measured as it would export.
    const inspectScene = models.length === 0 && renders.length === 0 && sheets.length === 0 && sceneSaved;
    const inspected = inspectScene
      ? [{ name: "scene.blend", filePath: sceneFile }]
      : models.slice(0, MAX_INSPECTED_MODELS).map((name) => ({ name, filePath: path.join(outputDirectory, name) }));
    for (const [index, { name, filePath }] of inspected.entries()) {
      const bytes = (await fs.stat(filePath).catch(() => undefined))?.size ?? 0;
      const preview = path.join(jobDirectory, `preview-${path.parse(name).name}.png`);
      // Only the model the chat will picture needs a 3D preview: the first
      // whose preview is kept, so each model is exported until one is.
      const modelPreview = images.length === 0 ? path.join(jobDirectory, modelPreviewFileName(index)) : undefined;
      // Written fresh by the inspection, never over anything already there.
      if (modelPreview !== undefined) await fs.rm(modelPreview, { force: true }).catch(() => undefined);
      const inspection = await this.runBlender(
        ["--background", "--factory-startup", "--python", path.join(jobDirectory, "roqer_inspect.py"), "--", filePath, preview, ...(modelPreview === undefined ? [] : [modelPreview])],
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
        if (modelPreview !== undefined) await fs.rm(modelPreview, { force: true }).catch(() => undefined);
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
        objects: parseObjects(stats.objects),
        articulation: articulationOf(parseObjects(stats.objects) ?? []),
        skins: parseSkins(stats.skins),
        bottom: Array.isArray(stats.min) && typeof stats.min[2] === "number" ? stats.min[2] : undefined,
        layout: parseLayout(stats.layout),
        smoothShaded: Array.isArray(stats.smoothShaded)
          ? stats.smoothShaded.slice(0, MAX_LAYOUT_ENTRIES).flatMap((entry: unknown) => isRecord(entry) && typeof entry.object === "string" && isNumber(entry.share)
            ? [{ object: entry.object, share: entry.share }]
            : [])
          : undefined,
        uv: parseUv(stats.uv),
      });
      if (stats.preview === true) {
        const png = await fs.readFile(preview).catch(() => undefined);
        if (png !== undefined && png.length <= MAX_PREVIEW_BYTES) images.push({ data: png.toString("base64"), mediaType: "image/png" });
      }
      if (modelPreview !== undefined) {
        // Kept only for the model the first preview pictures, and only when it
        // is a self-contained GLB the viewer can show; anything else is
        // removed, so no id can lead the renderer to it.
        const shown = images.length === 1;
        const kept = shown && stats.model3d === true && await isViewableGlb(modelPreview);
        if (!kept) await fs.rm(modelPreview, { force: true }).catch(() => undefined);
        if (shown) pictured = { name, ...(kept ? { modelPreviewId: modelPreviewId(jobId, index) } : {}) };
      }
    }

    const previews = images.length;
    images.push(...renderImages, ...flipbookImages);
    const durationMs = this.now() - started;
    const lines = [`Blender job ${jobId} finished in ${(durationMs / 1000).toFixed(1)} s.`, ...(notContinued === undefined ? [] : [notContinued])];
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
    if (flipbooks.length > 0) {
      lines.push(
        "Flipbook sheets it made, checked by Roqer from their pixels (attached after any renders, in this order):",
        ...flipbooks.flatMap((flipbook) => flipbook.lines),
        ...(sheets.length > MAX_FLIPBOOKS ? [`${sheets.length - MAX_FLIPBOOKS} more flipbook sheets were not checked.`] : []),
        "To use a sheet: fix every problem first, then upload_asset {action: 'upload', filePath: <its path>, assetType: 'Decal', displayName}, set ParticleEmitter.Texture to rbxassetid://<imageId from that result>, and apply the settings listed. Confirm it plays by holding one particle at a few ages (TimeScale 0) and taking screenshots: each should show one frame, not the whole grid. Do not go by FlipbookIncompatible: Studio shows its size message even for a sheet that plays.",
      );
    }
    // Textures shown in Studio before any upload, when the job asked for it.
    let studioPreviews: StudioPreview[] = [];
    if (args.preview_in_studio === true) {
      const textures = [
        ...flipbooks.map((flipbook) => ({ name: flipbook.name, path: flipbook.path })),
        ...rendered.filter((image) => image.error === undefined).map((image) => ({ name: image.name, path: image.path })),
      ].slice(0, MAX_STUDIO_PREVIEWS);
      try {
        const installs = await (this.options.studioContentDirectories ?? (() => findStudioContentDirectories(this.options.env ?? process.env)))();
        studioPreviews = await stageStudioPreviews(textures, jobId, installs, this.now());
        if (textures.length === 0) {
          lines.push("Nothing to preview in Studio: the job made no PNG or flipbook sheet.");
        } else if (installs.length === 0) {
          lines.push("No Roblox Studio install was found to preview in (previews work with Studio on Windows). Upload the textures to see them in Studio.");
        } else {
          lines.push(
            "Previews in Studio, before any upload. Each address works on this computer only:",
            ...studioPreviews.map((preview) => `- ${preview.name}: ${preview.uri}`),
            "Set ParticleEmitter.Texture (or a Beam's or Decal's Texture) to an address to see the texture in Studio as players would. Studio keeps a file's first image for the session, so a redrawn texture comes from a new job with new addresses. Players and other computers see nothing at these addresses: once the textures are settled, upload them (upload_asset as Decal) and replace every rbxasset://textures/roqer-preview/ address with rbxassetid://<imageId>.",
          );
        }
      } catch (error) {
        lines.push(`The textures could not be copied into Studio for a preview: ${error instanceof Error ? error.message : String(error)}. Upload them to see them in Studio.`);
      }
    }
    if (animations.length > 0) {
      lines.push(
        "Animations it baked, each sampled frame by frame and kept as the keys its joints need:",
        ...animations.map((animation) => animation.line),
        ...(animations.some((animation) => animation.path !== undefined)
          ? ["To use one: animation {action: 'check', animation_file: <its path>}, with locomotion: true for a gait, then build with the same animation_file and a parent. Its rig is the model path the script gave; the model must be rigged in Studio first, and be the one this scene was uploaded as."]
          : []),
      );
    }
    lines.push(...describeScene(jobId, continueFrom, contents, sceneSaved, inspectScene));
    return {
      ok: true,
      data: {
        jobId,
        ...(continueFrom === undefined ? {} : { continuedFrom: continueFrom }),
        jobDirectory, outputDirectory, files, images: rendered, otherFiles: others, log,
        ...(flipbooks.length > 0 ? { flipbooks: flipbooks.map(({ name, path: sheetPath, report }) => ({ name, path: sheetPath, ...(report === undefined ? {} : { report }) })) } : {}),
        ...(animations.length > 0 ? { animations: animations.flatMap((animation) => animation.path === undefined ? [] : [{ name: animation.name, path: animation.path }]) } : {}),
        ...(studioPreviews.length > 0 ? { studioPreviews } : {}),
        scene: sceneSaved ? { path: sceneFile, ...(contents === undefined ? {} : { contents }) } : null,
      },
      text: lines.join("\n"),
      ...(images.length > 0 ? { images } : {}),
      ...(pictured === undefined ? {} : { pictured }),
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
    await pruneJobFolders(this.options.jobsRoot, this.now(), keep);
  }
}

const MAX_FLIPBOOKS = 4;
/** The most textures one job previews in Studio: its checked sheets and rendered images. */
const MAX_STUDIO_PREVIEWS = 8;
const FLIPBOOK_SUFFIX = ".flipbook.png";
const FLIPBOOK_NOTE_SUFFIX = ".flipbook.json";
const FLIPBOOK_PREVIEW_SUFFIX = ".flipbook-preview.png";
const MAX_FLIPBOOK_NOTE_BYTES = 64 * 1024;

/** A sheet roqer.flipbook writes, its note, or the half-size copy it writes to look at. */
function isFlipbookFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(FLIPBOOK_SUFFIX) || lower.endsWith(FLIPBOOK_NOTE_SUFFIX) || lower.endsWith(FLIPBOOK_PREVIEW_SUFFIX);
}

type CheckedFlipbook = Readonly<{ name: string; path: string; report?: FlipbookReport; image?: McpToolImage; lines: readonly string[] }>;

/** The note beside a sheet, kept only where each value has the expected type: it is the script's claim. */
async function readFlipbookNote(file: string): Promise<{ claim: FlipbookClaim; renderSeconds?: number[]; engine?: string }> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat === undefined || stat.size > MAX_FLIPBOOK_NOTE_BYTES) return { claim: {} };
  let note: unknown;
  try {
    note = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return { claim: {} };
  }
  if (!isRecord(note)) return { claim: {} };
  const seconds = Array.isArray(note.renderSeconds) ? note.renderSeconds.filter(isNumber).slice(0, 64) : undefined;
  return {
    claim: {
      ...(isNumber(note.grid) ? { grid: note.grid } : {}),
      ...(typeof note.mode === "string" ? { mode: note.mode } : {}),
      ...(isNumber(note.padding) ? { padding: note.padding } : {}),
      ...(typeof note.loop === "boolean" ? { loop: note.loop } : {}),
      ...(isNumber(note.fps) && note.fps > 0 ? { fps: note.fps } : {}),
    },
    ...(seconds === undefined || seconds.length === 0 ? {} : { renderSeconds: seconds }),
    ...(typeof note.engine === "string" && note.engine.length <= 40 ? { engine: note.engine } : {}),
  };
}

async function checkFlipbook(directory: string, name: string): Promise<CheckedFlipbook> {
  const sheetPath = path.join(directory, name);
  const stem = name.slice(0, -FLIPBOOK_SUFFIX.length);
  const { claim, renderSeconds, engine } = await readFlipbookNote(path.join(directory, stem + FLIPBOOK_NOTE_SUFFIX));
  const bytes = await fs.readFile(sheetPath).catch(() => undefined);
  if (bytes === undefined) return { name, path: sheetPath, lines: [`- ${name}: Roqer could not read it.`] };
  let report: FlipbookReport;
  try {
    report = analyzeFlipbook(bytes, claim);
  } catch (error) {
    return { name, path: sheetPath, lines: [`- ${name}: not a sheet Roqer can read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const lines = describeFlipbook(name, report);
  if (renderSeconds !== undefined) {
    const total = renderSeconds.reduce((sum, value) => sum + value, 0);
    lines.push(`  The script's note says ${renderSeconds.length} frames rendered in ${total.toFixed(1)} s${engine === undefined ? "" : ` with ${engine}`} (${(total / renderSeconds.length).toFixed(2)} s a frame).`);
  }
  // The sheet itself when it fits in the result, otherwise the half-size copy written beside it.
  let image: McpToolImage | undefined;
  if (bytes.length <= MAX_PREVIEW_BYTES) {
    image = { data: bytes.toString("base64"), mediaType: "image/png" };
  } else {
    const preview = await fs.readFile(path.join(directory, stem + FLIPBOOK_PREVIEW_SUFFIX)).catch(() => undefined);
    if (preview !== undefined && preview.length <= MAX_PREVIEW_BYTES && readPngSize(preview) !== undefined) {
      image = { data: preview.toString("base64"), mediaType: "image/png" };
      lines.push("  The sheet is too large to attach, so a half-size copy of it is attached instead; the checks above read the full sheet.");
    } else {
      lines.push("  The sheet is too large to attach; judge it by the numbers above.");
    }
  }
  return { name, path: sheetPath, report, ...(image === undefined ? {} : { image }), lines };
}

const MAX_BAKED_ANIMATIONS = 8;
const MAX_BAKE_BYTES = 16 * 1024 * 1024;

type BakedAnimation = Readonly<{ name: string; line: string; path?: string }>;

/**
 * One bake the script left in its output folder, turned into a pose
 * description beside it. The bake is removed either way: it is only the
 * script's samples, and the description is what the animation tool takes.
 */
async function convertBake(directory: string, file: string): Promise<BakedAnimation> {
  const source = path.join(directory, file);
  const name = file.slice(0, -BAKE_SUFFIX.length);
  const refuse = (why: string): BakedAnimation => ({ name, line: `- ${name} could not be used: ${why}.` });
  try {
    if ((await fs.stat(source)).size > MAX_BAKE_BYTES) return refuse("its bake is too large");
    const raw: unknown = JSON.parse(await fs.readFile(source, "utf8"));
    const bake = parseBake(raw);
    if (typeof bake === "string") return refuse(bake);
    const baked = describeBake(bake);
    if (baked.joints === 0) return refuse("nothing moves between its first frame and its last");
    const target = path.join(directory, `${name}${ANIMATION_SUFFIX}`);
    await fs.writeFile(target, JSON.stringify(baked.description));
    const ignored = isRecord(raw) && Array.isArray(raw.ignoredTravel) ? raw.ignoredTravel.filter((entry): entry is string => typeof entry === "string").slice(0, 8) : [];
    const note = ignored.length > 0 ? `; ${ignored.join(", ")} also slid from ${ignored.length === 1 ? "its" : "their"} joint, which only the body's own joint can do, so that part was left out` : "";
    return { name, path: target, line: `${describeBakedFile(target, baked)}${note}` };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  } finally {
    await fs.rm(source, { force: true }).catch(() => undefined);
  }
}

const COLOR_SOURCE_NOTES: Readonly<Record<NonNullable<InspectedFile["colorSource"]>, string>> = {
  vertex: "coloured by vertex colours, which Roblox keeps: leave the MeshParts' Color white",
  texture: "coloured by a packed texture, which Roblox keeps as TextureID: leave the MeshParts' Color white",
  material: "coloured by flat material colours only, which arrive white: set Color and Material on each MeshPart after insert",
};

function parseUv(value: unknown): InspectedUv | undefined {
  if (!isRecord(value) || !isNumber(value.meshes) || !isNumber(value.withoutCount)) return undefined;
  const pair = (entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every(isNumber) ? entry as number[] : undefined;
  const low = pair(value.low);
  const high = pair(value.high);
  return {
    meshes: count(value.meshes, 0),
    without: Array.isArray(value.without) ? value.without.filter((name): name is string => typeof name === "string").slice(0, 8) : [],
    withoutCount: count(value.withoutCount, 0),
    ...(low !== undefined && high !== undefined ? { low, high } : {}),
  };
}

/** The UV line: only worth saying when some mesh has UVs, so a texture can be meant. */
function describeUv(uv: InspectedUv | undefined): string {
  if (uv === undefined || uv.meshes === 0) return "";
  const span = uv.low !== undefined && uv.high !== undefined
    ? `, spanning U ${uv.low[0].toFixed(2)} to ${uv.high[0].toFixed(2)} and V ${uv.low[1].toFixed(2)} to ${uv.high[1].toFixed(2)}`
    : "";
  const outside = uv.low !== undefined && uv.high !== undefined && (Math.min(...uv.low) < -0.001 || Math.max(...uv.high) > 1.001)
    ? "; outside 0 to 1 a texture repeats"
    : "";
  const missing = uv.withoutCount > 0
    ? `; no UVs on ${uv.without.join(", ")}${more(uv.without.length, uv.withoutCount)}, where a texture shows as one flat colour`
    : "";
  return `\n  UVs on ${uv.meshes} mesh${uv.meshes === 1 ? "" : "es"}${span}${outside}${missing}.`;
}

function describeFile(file: InspectedFile): string {
  const size = file.size !== undefined && file.size.length === 3 ? `, ${file.size.map((value) => value.toFixed(2)).join(" × ")} Blender units` : "";
  const facts = file.inspectionError !== undefined
    ? file.inspectionError
    : `${file.triangles ?? "?"} triangles, ${file.meshes ?? "?"} mesh${file.meshes === 1 ? "" : "es"}, ${file.materials?.length ?? 0} material${file.materials?.length === 1 ? "" : "s"}${size}`;
  const listed = file.objects?.slice(0, MAX_LISTED_OBJECTS) ?? [];
  const pieces = file.objects !== undefined && file.objects.length > 1
    ? `\n  objects, each arriving as its own MeshPart named after it: ${listed.map((object) => `${object.name} ${object.size.map((value) => value.toFixed(2)).join(" × ")}`).join("; ")}${more(listed.length, file.objects.length)}`
    : "";
  const articulated = file.inspectionError === undefined ? `${describeArticulation(file.articulation)}${describeSkins(file.skins, file.bottom)}` : "";
  const layout = file.inspectionError === undefined ? describeLayout(file.layout, file.bottom, file.articulation) : "";
  const shading = file.smoothShaded !== undefined && file.smoothShaded.length > 0
    ? `\n  shading: smooth across hard edges on ${file.smoothShaded.map((entry) => `${entry.object} (${Math.round(entry.share * 100)}% of corners)`).join(", ")}, which makes boxes and panels look puffy in Roblox. Unless the object is meant to look rounded, remove shade_smooth; roqer.join keeps what it joins flat.`
    : "";
  const uv = file.inspectionError === undefined ? describeUv(file.uv) : "";
  return `- ${file.path} (${Math.max(1, Math.round(file.bytes / 1024))} KB): ${facts}${file.colorSource === undefined ? "" : `; ${COLOR_SOURCE_NOTES[file.colorSource]}`}${pieces}${layout}${shading}${uv}${articulated}`;
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
function describeLayout(layout: LayoutFacts | undefined, bottom: number | undefined, articulation?: Articulation): string {
  // A moving piece is meant to pass into the piece it hangs from, at their
  // joint, so that a turn opens no gap: those overlaps are not findings.
  const jointed = new Set((articulation?.joints ?? []).flatMap((joint) => [`${joint.part}\n${joint.parent}`, `${joint.parent}\n${joint.part}`]));
  if (layout !== undefined && jointed.size > 0) {
    const kept = layout.overlaps.filter((entry) => !jointed.has(entry.objects.join("\n")));
    // Past the listed ones nothing is known, so only what was listed is taken off the count.
    layout = { ...layout, overlaps: kept, overlapCount: layout.overlapCount - (layout.overlaps.length - kept.length) };
  }
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
      lines.push(layout.pieces === 1 ? "one piece" : jointed.size > 0
        ? `all ${layout.pieces} pieces connected, and separate objects pass into each other only where one hangs from the other`
        : `all ${layout.pieces} pieces connected, and no separate objects pass into each other`);
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
