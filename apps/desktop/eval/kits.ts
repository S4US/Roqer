/**
 * Can a whole kit set be made in one Blender job and uploaded once?
 *
 * Turning Blender on is meant to make every visual piece of a map a Blender
 * model. One job and one upload per piece would cost two approvals and a
 * moderation wait each, so the plan is one job and one upload for the whole
 * set, split into templates in Studio. That only works if Roblox keeps the
 * pieces of one file apart. This probe uploads three vertex-coloured pieces in
 * one GLB, twice: once sharing one material, once with a material each, because
 * Roblox has split imports by material before. It reads back how many MeshParts
 * arrived, which piece each is, its colours, its size, and where it sits.
 */

import type { GlbSummary } from "./colors";
import { VERTEX_COLORS_LUAU } from "./probe-luau";

export type KitPiece = Readonly<{
  name: string;
  /** Size in studs as Roblox reports it (Blender X, Z, Y). */
  size: readonly [number, number, number];
  /** Centre X in the Blender scene; the pieces are laid out along X. */
  x: number;
}>;

/** The pieces, with the size the script below gives each one. */
export const KIT_PIECES: readonly KitPiece[] = [
  { name: "KitCliff", size: [8.4, 6.5, 4.4], x: -10 },
  { name: "KitTree", size: [4, 9.25, 4], x: 0 },
  { name: "KitRock", size: [2.5, 2.5, 2.5], x: 10 },
];

export type KitVariant = Readonly<{
  id: "shared" | "separate";
  file: string;
  displayName: string;
  description: string;
  position: Readonly<{ x: number; y: number; z: number }>;
}>;

export const KIT_VARIANTS: readonly KitVariant[] = [
  {
    id: "shared", file: "kits-shared-material.glb", displayName: "Roqer kit probe: shared material",
    description: "three pieces sharing one vertex-colour material", position: { x: 0, y: 8, z: 90 },
  },
  {
    id: "separate", file: "kits-own-materials.glb", displayName: "Roqer kit probe: a material each",
    description: "three pieces with a material each", position: { x: 0, y: 8, z: 115 },
  },
];

/** Blender job script: three kit pieces, exported twice (shared material, then a material each). */
export const KIT_PROBE_SCRIPT = `
import bpy, os

GRASS, DIRT = (0.35, 0.85, 0.2, 1), (0.8, 0.3, 0.2, 1)
BARK, LEAF, LEAF_TOP = (0.45, 0.2, 0.12, 1), (0.3, 0.75, 0.2, 1), (0.45, 0.9, 0.3, 1)
ROCK, ROCK_TOP = (0.55, 0.5, 0.8, 1), (0.7, 0.66, 0.92, 1)

def box(name, size, location, colour):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    attribute = obj.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for corner in attribute.data:
        corner.color = colour
    obj.data.color_attributes.active_color = attribute
    return obj

def join(name, parts):
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    parts[0].name = name
    parts[0].data.name = name
    return parts[0]

# A cliff section: dirt block, a grass cap that overhangs it, and grass teeth
# hanging down the front face. 8.4 x 4.4 across, 6.5 tall.
cliff = join("KitCliff", [
    box("Dirt", (8, 4, 6), (-10, 0, 3), DIRT),
    box("Cap", (8.4, 4.4, 1), (-10, 0, 6), GRASS),
    *[box("Tooth", (1.4, 0.4, height), (-10 - 3.2 + index * 1.6, -2.0, 5.5 - height / 2), GRASS)
      for index, height in enumerate((1.2, 0.6, 1.8, 0.9, 1.4))],
])

# A stacked-cube tree: trunk, canopy, and a lighter top cube. 4 across, 9.25 tall.
tree = join("KitTree", [
    box("Trunk", (1, 1, 3), (0, 0, 1.5), BARK),
    box("Canopy", (4, 4, 4), (0, 0, 5), LEAF),
    box("Top", (2.5, 2.5, 2.5), (0, 0, 8), LEAF_TOP),
])

# A bevelled rock with a lighter top face. 2.5 on every side.
rock = box("KitRock", (2.5, 2.5, 2.5), (10, 0, 1.25), ROCK)
rock.data.name = "KitRock"
for polygon in rock.data.polygons:
    if polygon.normal.z > 0.5:
        for loop in polygon.loop_indices:
            rock.data.color_attributes["Col"].data[loop].color = ROCK_TOP
bevel = rock.modifiers.new("Bevel", "BEVEL")
bevel.width = 0.2
bevel.segments = 2

def paint_material(name):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    colors = nodes.new("ShaderNodeVertexColor")
    colors.layer_name = "Col"
    material.node_tree.links.new(colors.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    return material

pieces = (cliff, tree, rock)

def export(name):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, name), export_format="GLB", export_apply=True)

shared = paint_material("KitPaint")
for piece in pieces:
    piece.data.materials.clear()
    piece.data.materials.append(shared)
export("${KIT_VARIANTS[0].file}")

for piece in pieces:
    piece.data.materials.clear()
    piece.data.materials.append(paint_material(piece.name + "Paint"))
export("${KIT_VARIANTS[1].file}")
`.trimStart();

export const KIT_PROBE_ROOT = "game.Workspace.WorkbenchKitProbe";

export const KIT_PROBE_SEED = `
local old = workspace:FindFirstChild("WorkbenchKitProbe")
if old then old:Destroy() end
local root = Instance.new("Model")
root.Name = "WorkbenchKitProbe"
${KIT_VARIANTS.map((variant) => `local ${variant.id} = Instance.new("Model")
${variant.id}.Name = "${variant.id}"
${variant.id}.Parent = root`).join("\n")}
root.Parent = workspace
return { ok = true }
`.trim();

/** Luau reporting every instance each upload produced, with each MeshPart's size, position and colours. */
export const KIT_PROBE_READBACK = `
${VERTEX_COLORS_LUAU}
local root = workspace:FindFirstChild("WorkbenchKitProbe")
if not root then return { found = false } end
local function r(n) return math.floor(n * 100 + 0.5) / 100 end
local variants = {}
for _, holder in ipairs(root:GetChildren()) do
  local items = {}
  for _, item in ipairs(holder:GetDescendants()) do
    if #items >= 40 then break end
    local entry = { class = item.ClassName, name = item.Name, parent = item.Parent and item.Parent.Name or nil }
    if item:IsA("BasePart") then
      entry.size = { r(item.Size.X), r(item.Size.Y), r(item.Size.Z) }
      entry.position = { r(item.Position.X), r(item.Position.Y), r(item.Position.Z) }
      entry.color = rgb(item.Color)
    end
    if item:IsA("MeshPart") then entry.vertex = vertexColors(item.MeshId) end
    table.insert(items, entry)
  end
  variants[holder.Name] = items
end
return { found = true, variants = variants }
`.trim();

export type KitPieceFinding = Readonly<{
  piece: string;
  /** The MeshPart that is this piece, when exactly one is. */
  part?: string;
  /** How it was recognised: by its name, or, when Roblox renamed it, by its size. */
  matchedBy?: "name" | "size";
  coloured: "yes" | "no" | "unknown";
  sizeMatches: boolean;
  size?: readonly number[];
}>;

export type KitVariantFinding = Readonly<{
  id: KitVariant["id"];
  /** separate: one MeshPart per piece; merged: fewer parts than pieces; other: anything else. */
  result: "separate" | "merged" | "other";
  meshParts: number;
  pieces: readonly KitPieceFinding[];
  /** Whether the pieces kept their spacing along X, so a layout made in Blender survives. */
  layoutKept: boolean | undefined;
  detail: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const numbers = (value: unknown) => (Array.isArray(value) && value.every((entry) => typeof entry === "number") ? value as number[] : undefined);

/** Roblox sizes a mesh to its bounds, so a size within a tenth of a stud either way is the same piece. */
const SIZE_TOLERANCE = 0.1;
const sameSize = (size: readonly number[] | undefined, expected: readonly number[]) =>
  size !== undefined && size.length === 3 && size.every((value, axis) => Math.abs(value - expected[axis]) <= SIZE_TOLERANCE);

export function judgeKitVariant(id: KitVariant["id"], items: unknown): KitVariantFinding {
  const meshParts = (Array.isArray(items) ? items.filter(isRecord) : []).filter((entry) => entry.class === "MeshPart");
  const positionsX: Array<number | undefined> = [];
  const pieces = KIT_PIECES.map((piece): KitPieceFinding => {
    const byName = meshParts.filter((part) => typeof part.name === "string" && part.name.toLowerCase().startsWith(piece.name.toLowerCase()));
    const bySize = meshParts.filter((part) => sameSize(numbers(part.size), piece.size));
    const matchedBy = byName.length === 1 ? "name" : bySize.length === 1 ? "size" : undefined;
    const part = matchedBy === "name" ? byName[0] : matchedBy === "size" ? bySize[0] : undefined;
    if (part === undefined || matchedBy === undefined) {
      positionsX.push(undefined);
      return { piece: piece.name, coloured: "unknown", sizeMatches: false };
    }
    positionsX.push(numbers(part.position)?.[0]);
    const size = numbers(part.size);
    const vertex = isRecord(part.vertex) ? part.vertex : {};
    return {
      piece: piece.name,
      part: String(part.name),
      matchedBy,
      coloured: typeof vertex.distinct === "number" ? (vertex.distinct >= 2 ? "yes" : "no") : "unknown",
      sizeMatches: sameSize(size, piece.size),
      ...(size === undefined ? {} : { size }),
    };
  });
  const found = pieces.filter((piece) => piece.part !== undefined);
  const result = found.length === KIT_PIECES.length && meshParts.length === KIT_PIECES.length
    ? "separate"
    : meshParts.length > 0 && meshParts.length < KIT_PIECES.length ? "merged" : "other";

  let layoutKept: boolean | undefined;
  if (found.length === KIT_PIECES.length && positionsX.every((x) => x !== undefined)) {
    const origin = positionsX[0]! - KIT_PIECES[0].x;
    layoutKept = positionsX.every((x, index) => Math.abs(x! - origin - KIT_PIECES[index].x) <= SIZE_TOLERANCE);
  }
  const detail = result === "separate"
    ? `${meshParts.length} MeshParts, one per piece; coloured: ${pieces.map((piece) => `${piece.piece} ${piece.coloured}`).join(", ")}; `
      + `sizes ${pieces.every((piece) => piece.sizeMatches) ? "as modelled" : "differ from the model"}; `
      + `layout ${layoutKept === true ? "kept" : "not kept"}`
    : `${meshParts.length} MeshPart(s) for ${KIT_PIECES.length} pieces: ${meshParts.map((part) => String(part.name)).join(", ") || "none"}`;
  return {
    id, result, meshParts: meshParts.length, layoutKept, detail,
    pieces,
  };
}

export function judgeKitProbe(readback: unknown): KitVariantFinding[] {
  const variants = isRecord(readback) && isRecord(readback.variants) ? readback.variants : {};
  return KIT_VARIANTS.map((variant) => judgeKitVariant(variant.id, variants[variant.id]));
}

/** The one-line answer the probe exists for. */
export function kitProbeAnswer(findings: readonly KitVariantFinding[]): string {
  const works = (finding: KitVariantFinding) =>
    finding.result === "separate" && finding.pieces.every((piece) => piece.coloured !== "no" && piece.sizeMatches);
  const shared = findings.find((finding) => finding.id === "shared");
  const separate = findings.find((finding) => finding.id === "separate");
  if (shared !== undefined && works(shared)) return "One upload carries a whole kit set, even with one shared material.";
  if (separate !== undefined && works(separate)) return "One upload carries a whole kit set if each piece has its own material.";
  return "One upload does not carry a kit set intact; upload each piece on its own.";
}

/** Why a variant's file cannot test what it is meant to, or undefined when it can. */
export function kitFileProblem(variant: KitVariant, summary: GlbSummary): string | undefined {
  if (summary.meshes !== KIT_PIECES.length) return `${variant.file} holds ${summary.meshes} meshes, not ${KIT_PIECES.length}`;
  if (!summary.attributes.includes("COLOR_0")) return `${variant.file} has no COLOR_0 vertex colours`;
  const materials = variant.id === "shared" ? 1 : KIT_PIECES.length;
  if (summary.materials !== materials) return `${variant.file} has ${summary.materials} materials, not ${materials}`;
  return undefined;
}
