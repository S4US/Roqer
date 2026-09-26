import {
  BLENDER_OPERATION,
  BLENDER_TOOL_NAME,
  DEFAULT_BLENDER_JOB_SECONDS,
  MAX_BLENDER_JOB_SECONDS,
  MAX_BLENDER_SCRIPT_CHARACTERS,
} from "../shared/blender";

type JsonRecord = Record<string, unknown>;

/**
 * The model-facing Blender tool, offered only while the user has turned the
 * worker on. A call becomes one `run_blender_script` operation in the run
 * engine, where it is classified irreversible like `execute_luau`: it asks the
 * user before running outside Full auto, and stopping the run stops Blender.
 */
export function blenderToolDefinition(): Readonly<{ name: typeof BLENDER_TOOL_NAME; description: string; inputSchema: JsonRecord }> {
  return {
    name: BLENDER_TOOL_NAME,
    description: [
      "Run a Python script in the user's local Blender to model a mesh Roblox's own parts cannot make (organic or curved shapes, a hero prop, a vehicle body), or to render a PNG such as an item icon for UI.",
      "The script runs in background Blender on an empty scene with bpy imported, OUTPUT_DIR defined, and roqer helpers that place parts by their ends (roqer.box, roqer.box_between, roqer.cylinder_between, roqer.cone_between, roqer.join). Build with bpy, then export into OUTPUT_DIR, for example bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, 'crate.glb'), export_format='GLB', export_apply=True), or render a PNG there. Write nowhere else and fetch nothing from the network.",
      "Roqer does not trust the script's own report: it re-imports each exported .glb/.gltf/.fbx/.obj, returns its triangles, meshes, materials, size, where its colour lives, its layout (pieces that float or pass into each other) and any smooth shading across hard edges, and attaches four views of it in one preview; a PNG is attached as itself with its pixel size. Look at them before using them.",
      "Each job is irreversible: the user approves it unless they run in Full auto, so write one complete script rather than many small probes. A failed script returns Blender's traceback.",
      "To place a model in Studio: upload_asset {action:'upload', filePath, assetType:'Model', displayName}, then insert_asset with the new asset id. Colour models in the script with vertex colours or a packed texture, which Roblox keeps; flat material colours arrive white. An image uploads as a Decal; use its imageId in UI. Load roblox-building references/blender.md before a first job.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          minLength: 1,
          maxLength: MAX_BLENDER_SCRIPT_CHARACTERS,
          description: "The complete Python script. bpy, OUTPUT_DIR and the roqer helpers are already defined.",
        },
        timeout_seconds: {
          type: "number",
          minimum: 5,
          maximum: MAX_BLENDER_JOB_SECONDS,
          description: `How long the script may run before Blender is stopped; default ${DEFAULT_BLENDER_JOB_SECONDS}.`,
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
  };
}

/** The engine operation for a `blender` call. Throws so every provider reports the same message. */
export function parseBlenderToolInput(value: unknown): { operation: string; args: JsonRecord } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("blender requires an object with a script.");
  }
  const record = value as JsonRecord;
  if (typeof record.script !== "string" || record.script.trim() === "") {
    throw new Error("blender requires script: the complete Python to run.");
  }
  const args: JsonRecord = { script: record.script };
  if (typeof record.timeout_seconds === "number") args.timeout_seconds = record.timeout_seconds;
  return { operation: BLENDER_OPERATION, args };
}
