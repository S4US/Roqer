import {
  BLENDER_JOB_ID_PATTERN,
  BLENDER_OPERATION,
  BLENDER_TOOL_NAME,
  DEFAULT_BLENDER_JOB_SECONDS,
  MAX_BLENDER_JOB_SECONDS,
  MAX_BLENDER_SCRIPT_CHARACTERS,
  isBlenderJobId,
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
      "The script runs in background Blender with bpy imported, OUTPUT_DIR defined, and roqer helpers that place parts by their ends (roqer.box, roqer.box_between, roqer.cylinder_between, roqer.cone_between, roqer.join). It starts on an empty scene, or, with continue_from set to an earlier job's id, on the scene that job saved: every job whose script finishes saves its scene, and its result lists that scene's objects by name, size and centre. Build a detailed model in stages, one job per stage (for a vehicle: frame, body, running gear, details), each continuing from the last and checked in its preview before the next; fix a stage with a short script that changes the objects already there by name. A job that fails saves nothing; to undo a step, continue from an earlier job.",
      "Export into OUTPUT_DIR when the model is ready to upload, for example bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, 'kart.glb'), export_format='GLB', export_apply=True, use_visible=True), or render a PNG there; a job that exports nothing still returns a preview of its scene. Write nowhere else and fetch nothing from the network.",
      "Roqer does not trust the script's own report: it re-imports each exported .glb/.gltf/.fbx/.obj (or, when nothing was exported, the saved scene), returns its triangles, meshes, materials, size, where its colour lives, its layout (pieces that float or pass into each other) and any smooth shading across hard edges, and attaches four views of it in one preview; a PNG is attached as itself with its pixel size. Look at them before using them.",
      `Each job is irreversible: the user approves it unless they run in Full auto, so make each job a real stage rather than a probe. A failed script returns Blender's traceback. A script may be at most ${MAX_BLENDER_SCRIPT_CHARACTERS.toLocaleString("en-US")} characters: build repeated parts (wheels, bolts, tubes, panels) with loops and functions rather than writing each out.`,
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
        continue_from: {
          type: "string",
          pattern: BLENDER_JOB_ID_PATTERN,
          description: "The id of an earlier job in this chat whose saved scene the script starts from, as that job's result gave it. Omit to start from an empty scene.",
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
  if (record.continue_from !== undefined && record.continue_from !== null) {
    if (!isBlenderJobId(record.continue_from)) {
      throw new Error("blender continue_from must be the id of an earlier job, exactly as that job's result gave it (8 hexadecimal characters).");
    }
    args.continue_from = record.continue_from;
  }
  return { operation: BLENDER_OPERATION, args };
}
