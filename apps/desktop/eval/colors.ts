/**
 * Does colour made in Blender survive a Roblox Model upload?
 *
 * The barrel and the cart both arrived white: Roblox makes one MeshPart per
 * material slot and keeps no flat material colour, so the agent paints each
 * part in Studio. Two other carriers might survive, and the guidance should not
 * guess which: an image texture packed into the GLB, and per-vertex colours.
 * This probe uploads one cube coloured only by each, inserts them, and reads
 * back what Roblox kept. It drives no model, so it costs two uploads, not a run.
 */

import { VERTEX_COLORS_LUAU } from "./probe-luau";

/** Blender job script: two 4-stud cubes, one coloured only by a packed texture, one only by vertex colours. */
export const COLOR_PROBE_SCRIPT = `
import bpy, os

# Four unmistakable colours, so "kept" and "lost" cannot be confused with shading.
RED, GREEN, BLUE, YELLOW = (0.9, 0.1, 0.1, 1), (0.1, 0.8, 0.2, 1), (0.1, 0.25, 0.9, 1), (0.95, 0.85, 0.1, 1)

def export(obj, name):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, name), export_format="GLB",
                              use_selection=True, export_apply=True)

# 1. A cube whose colour comes only from an image texture packed into the GLB.
size = 64
image = bpy.data.images.new("ColorProbeQuadrants", size, size)
pixels = []
for y in range(size):
    for x in range(size):
        pixels.extend(RED if x < size // 2 and y < size // 2 else GREEN if y < size // 2
                      else BLUE if x < size // 2 else YELLOW)
image.pixels[:] = pixels
image.pack()
textured = bpy.data.materials.new("ColorProbeTexture")
textured.use_nodes = True
nodes = textured.node_tree.nodes
node = nodes.new("ShaderNodeTexImage")
node.image = image
textured.node_tree.links.new(node.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 2))
cube = bpy.context.active_object
cube.name = "TexturedCube"
cube.data.materials.append(textured)
export(cube, "textured-cube.glb")

# 2. A cube whose colour comes only from per-corner vertex colours, one colour per side.
bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 2))
vcube = bpy.context.active_object
vcube.name = "VertexCube"
attribute = vcube.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
for polygon in vcube.data.polygons:
    n = polygon.normal
    colour = RED if n.z > 0.5 else BLUE if n.z < -0.5 else GREEN if abs(n.x) > 0.5 else YELLOW
    for loop in polygon.loop_indices:
        attribute.data[loop].color = colour
vcube.data.color_attributes.active_color = attribute
painted = bpy.data.materials.new("ColorProbeVertex")
painted.use_nodes = True
vnodes = painted.node_tree.nodes
vnode = vnodes.new("ShaderNodeVertexColor")
vnode.layer_name = "Col"
painted.node_tree.links.new(vnode.outputs["Color"], vnodes["Principled BSDF"].inputs["Base Color"])
vcube.data.materials.append(painted)
export(vcube, "vertex-cube.glb")
`.trimStart();

export const COLOR_PROBE_ROOT = "game.Workspace.WorkbenchColorProbe";

export type ColorCase = Readonly<{
  id: "texture" | "vertex";
  file: string;
  displayName: string;
  /** Where the uploaded model is inserted, beside the other case. */
  position: Readonly<{ x: number; y: number; z: number }>;
}>;

export const COLOR_CASES: readonly ColorCase[] = [
  { id: "texture", file: "textured-cube.glb", displayName: "Roqer colour probe: texture", position: { x: -6, y: 5, z: 60 } },
  { id: "vertex", file: "vertex-cube.glb", displayName: "Roqer colour probe: vertex colours", position: { x: 6, y: 5, z: 60 } },
];

export type GlbSummary = Readonly<{ attributes: readonly string[]; images: number; baseColorTextures: number; meshes: number; materials: number }>;

/**
 * What a GLB actually carries, from its JSON chunk. Uploading a file that never
 * had the colour in it would test the exporter, not Roblox, so this is checked
 * before anything is published.
 */
export function readGlbSummary(bytes: Buffer): GlbSummary {
  if (bytes.length < 20 || bytes.toString("latin1", 0, 4) !== "glTF") throw new Error("not a GLB file");
  const length = bytes.readUInt32LE(12);
  if (bytes.toString("latin1", 16, 20) !== "JSON" || 20 + length > bytes.length) throw new Error("GLB has no JSON chunk");
  const document = JSON.parse(bytes.toString("utf8", 20, 20 + length)) as {
    meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, unknown> }> }>;
    images?: unknown[];
    materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: unknown } }>;
  };
  const attributes = new Set<string>();
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const name of Object.keys(primitive.attributes ?? {})) attributes.add(name);
    }
  }
  return {
    attributes: [...attributes].sort(),
    images: document.images?.length ?? 0,
    baseColorTextures: (document.materials ?? []).filter((material) => material.pbrMetallicRoughness?.baseColorTexture !== undefined).length,
    meshes: document.meshes?.length ?? 0,
    materials: document.materials?.length ?? 0,
  };
}

/** Why a case's file cannot test what it is meant to, or undefined when it can. */
export function glbProblem(colorCase: ColorCase, summary: GlbSummary): string | undefined {
  if (colorCase.id === "texture" && (summary.images === 0 || summary.baseColorTextures === 0)) {
    return `${colorCase.file} has no packed base-colour texture`;
  }
  if (colorCase.id === "vertex" && !summary.attributes.includes("COLOR_0")) {
    return `${colorCase.file} has no COLOR_0 vertex colours (attributes: ${summary.attributes.join(", ") || "none"})`;
  }
  return undefined;
}

/** Luau that makes an empty holder for each case, replacing a previous probe. */
export const COLOR_PROBE_SEED = `
local old = workspace:FindFirstChild("WorkbenchColorProbe")
if old then old:Destroy() end
local root = Instance.new("Model")
root.Name = "WorkbenchColorProbe"
${COLOR_CASES.map((colorCase) => `local ${colorCase.id} = Instance.new("Model")
${colorCase.id}.Name = "${colorCase.id}"
${colorCase.id}.Parent = root`).join("\n")}
root.Parent = workspace
return { ok = true }
`.trim();

/**
 * Luau that reports, for each case, every part and appearance object Roblox
 * made from the upload. Vertex colours are not a property: they are read from
 * the mesh through EditableMesh, which Studio may refuse; the error is reported
 * and the screenshot has to decide.
 */
export const COLOR_PROBE_READBACK = `
${VERTEX_COLORS_LUAU}
local root = workspace:FindFirstChild("WorkbenchColorProbe")
if not root then return { found = false } end
local function read(object, property)
  local ok, value = pcall(function() return object[property] end)
  if not ok or value == nil then return nil end
  if typeof(value) == "Content" then
    local okUri, uri = pcall(function() return value.Uri end)
    return okUri and uri or tostring(value)
  end
  return tostring(value)
end
local cases = {}
for _, holder in ipairs(root:GetChildren()) do
  local items = {}
  for _, item in ipairs(holder:GetDescendants()) do
    if #items >= 20 then break end
    if item:IsA("BasePart") then
      local entry = { class = item.ClassName, name = item.Name, color = rgb(item.Color), material = item.Material.Name }
      if item:IsA("MeshPart") then
        entry.meshId = read(item, "MeshId")
        entry.textureId = read(item, "TextureID")
        entry.vertex = vertexColors(entry.meshId)
      end
      table.insert(items, entry)
    elseif item:IsA("SurfaceAppearance") then
      table.insert(items, { class = item.ClassName, name = item.Name, parent = item.Parent.Name,
        colorMap = read(item, "ColorMap"), colorMapContent = read(item, "ColorMapContent") })
    elseif item:IsA("Decal") then
      table.insert(items, { class = item.ClassName, name = item.Name, parent = item.Parent.Name, texture = read(item, "Texture") })
    end
  end
  cases[holder.Name] = items
end
return { found = true, cases = cases }
`.trim();

export type ColorFinding = Readonly<{
  id: ColorCase["id"];
  /** kept: Roblox holds the colour; dropped: it does not; unknown: the probe could not tell. */
  result: "kept" | "dropped" | "unknown";
  detail: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** One case's verdict from the readback of its holder. */
export function judgeColorCase(id: ColorCase["id"], items: unknown): ColorFinding {
  const entries = Array.isArray(items) ? items.filter(isRecord) : [];
  const meshParts = entries.filter((entry) => entry.class === "MeshPart");
  if (meshParts.length === 0) {
    return { id, result: "unknown", detail: `the upload produced no MeshPart (${entries.map((entry) => text(entry.class)).join(", ") || "nothing"})` };
  }
  if (id === "texture") {
    const textured = meshParts.filter((part) => text(part.textureId) !== "");
    const surfaces = entries.filter((entry) => entry.class === "SurfaceAppearance"
      && (text(entry.colorMap) !== "" || text(entry.colorMapContent) !== ""));
    if (textured.length > 0) return { id, result: "kept", detail: `MeshPart.TextureID is ${text(textured[0].textureId)}` };
    if (surfaces.length > 0) {
      return { id, result: "kept", detail: `SurfaceAppearance colour map ${text(surfaces[0].colorMap) || text(surfaces[0].colorMapContent)}` };
    }
    return { id, result: "dropped", detail: `${meshParts.length} MeshPart(s), no TextureID and no SurfaceAppearance colour map` };
  }
  const reads = meshParts.map((part) => (isRecord(part.vertex) ? part.vertex : {}));
  const coloured = reads.find((read) => typeof read.distinct === "number" && read.distinct >= 2);
  if (coloured) {
    const sample = Array.isArray(coloured.sample) ? coloured.sample.join(" | ") : "";
    return { id, result: "kept", detail: `the mesh holds ${String(coloured.distinct)} distinct vertex colours (${sample})` };
  }
  const failed = reads.find((read) => typeof read.error === "string");
  if (failed) return { id, result: "unknown", detail: `EditableMesh could not read the mesh: ${text(failed.error)}; judge by the screenshot` };
  return { id, result: "dropped", detail: "the mesh holds at most one vertex colour" };
}

export function judgeColorProbe(readback: unknown): ColorFinding[] {
  const cases = isRecord(readback) && isRecord(readback.cases) ? readback.cases : {};
  return COLOR_CASES.map((colorCase) => judgeColorCase(colorCase.id, cases[colorCase.id]));
}
