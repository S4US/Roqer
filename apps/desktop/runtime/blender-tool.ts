import {
  BLENDER_JOB_ID_PATTERN,
  BLENDER_OPERATION,
  BLENDER_TOOL_NAME,
  DEFAULT_BLENDER_JOB_SECONDS,
  MAX_BLENDER_JOB_SECONDS,
  MAX_BLENDER_SCRIPT_CHARACTERS,
  isBlenderJobId,
} from "../shared/blender";
import { MalformedToolCallError } from "./studio-tools";

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
      // Claude Code keeps only a tool description's first 2,048 characters, so
      // how the helpers and staged jobs work is told on `script` and `continue_from`.
      "Build a detailed model in stages, one job per stage, each continuing from the last (see continue_from).",
      "Export into OUTPUT_DIR when the model is ready to upload, for example bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR, 'kart.glb'), export_format='GLB', export_apply=True, use_visible=True), or render a PNG there; a job that exports nothing still returns a preview of its scene. Write nowhere else and fetch nothing from the network.",
      "Roqer does not trust the script's own report: it re-imports each exported .glb/.gltf/.fbx/.obj (or, when nothing was exported, the saved scene), returns its triangles, meshes, materials, size, where its colour lives, its layout (pieces that float or pass into each other) and any smooth shading across hard edges, and attaches four views of it in one preview; a PNG is attached as itself with its pixel size. Look at them before using them.",
      `Each job is irreversible: the user approves it unless they run in Full auto, so make each job a real stage rather than a probe. A failed script returns Blender's traceback. A script may be at most ${MAX_BLENDER_SCRIPT_CHARACTERS.toLocaleString("en-US")} characters: build repeated parts (wheels, bolts, tubes, panels) with loops and functions rather than writing each out.`,
      "To place a model in Studio: upload_asset {action:'upload', filePath, assetType:'Model', displayName}, then insert_asset with the new asset id. Colour models in the script with vertex colours or a packed texture, which Roblox keeps; flat material colours arrive white. An image uploads as a Decal; use its imageId in UI. Before a first job, load roblox-building references/blender.md to model or render an icon; for a visual effect, load roblox-animation-vfx references/vfx-textures.md (particle textures and flipbooks) or vfx-mesh-shapes.md (effect shapes) instead.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          minLength: 1,
          maxLength: MAX_BLENDER_SCRIPT_CHARACTERS,
          description: "The complete Python script, run in background Blender. bpy is imported, OUTPUT_DIR is defined, and roqer helpers place parts by their ends: roqer.box, roqer.box_between, roqer.cylinder_between, roqer.cone_between, roqer.join.",
        },
        continue_from: {
          type: "string",
          pattern: BLENDER_JOB_ID_PATTERN,
          description: "The id of an earlier job in this chat whose saved scene the script starts from, as that job's result gave it. Leave it out to start from an empty scene, as a chat's first job always does: no id stands for an empty scene. Every job whose script finishes saves its scene, and its result lists that scene's objects by name, size and centre. Build a detailed model in stages (for a vehicle: frame, body, running gear, details), each continuing from the last and checked in its preview before the next; fix a stage with a short script that changes the objects already there by name. A job that fails saves nothing; to undo a step, continue from an earlier job.",
        },
        timeout_seconds: {
          type: "number",
          minimum: 5,
          maximum: MAX_BLENDER_JOB_SECONDS,
          description: `How long the script may run before Blender is stopped; default ${DEFAULT_BLENDER_JOB_SECONDS}.`,
        },
        views: {
          type: "array",
          maxItems: MAX_BLENDER_VIEWS,
          description: "Up to 6 extra pictures of the result from angles you choose, each attached after the four-view preview. Use them whenever a problem could hide from the default views: the underside, the back, inside an opening, a close-up of a joint.",
          items: {
            type: "object",
            properties: {
              yaw: { type: "number", description: "Degrees around the model from its front as it will face in Studio: 0 front, 90 its right side, 180 back, 270 its left side. Default 30." },
              pitch: { type: "number", description: "Degrees above the horizon, -89 (from below) to 89 (from above). Default 20." },
              zoom: { type: "number", description: "1 frames the whole model (or the focus object); 2 is twice as close. 0.2 to 20. Default 1." },
              focus: { type: "string", description: "The name of one object to frame instead of the whole model, as the result lists it. Choose a yaw and pitch from the side that object is on, or the rest of the model hides it." },
              label: { type: "string", description: "What this view is for, echoed in the result." },
            },
            additionalProperties: false,
          },
        },
        inspect_file: {
          type: "string",
          description: "The absolute path of a .glb, .gltf, .fbx or .obj file to look at instead of running a script (a project file, another chat's export): Roqer re-imports it, measures it and renders its preview and your views, changing nothing, so it needs no approval. Leave script out when you use it.",
        },
        preview_in_studio: {
          type: "boolean",
          description: "Copy the job's PNGs and flipbook sheets into the user's Roblox Studio install and return an rbxasset:// address for each, so a texture can be seen on a ParticleEmitter, Beam or Decal in Studio before it is uploaded. Use it while a texture is still changing: iterate on previews, and upload only the settled set. The addresses work on this computer only, so replace each with its uploaded id before the work is done.",
        },
      },
      additionalProperties: false,
    },
  };
}

export const MAX_BLENDER_VIEWS = 6;

export type BlenderView = { yaw: number; pitch: number; zoom: number; focus?: string; label?: string };

/** The views a call asked for, checked and filled in with their defaults. */
export function parseBlenderViews(value: unknown): BlenderView[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BLENDER_VIEWS) {
    throw new MalformedToolCallError(`blender views must be a list of at most ${MAX_BLENDER_VIEWS} angles.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MalformedToolCallError(`blender views[${index}] must be an object {yaw, pitch, zoom, focus}.`);
    }
    const view = entry as JsonRecord;
    const number = (key: string, fallback: number, low: number, high: number) => {
      const raw = view[key];
      if (raw === undefined || raw === null) return fallback;
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new MalformedToolCallError(`blender views[${index}].${key} must be a number.`);
      return Math.min(Math.max(raw, low), high);
    };
    const yaw = number("yaw", 30, -720, 720);
    return {
      yaw: ((yaw % 360) + 360) % 360,
      pitch: number("pitch", 20, -89, 89),
      zoom: number("zoom", 1, 0.2, 20),
      ...(typeof view.focus === "string" && view.focus.trim() !== "" ? { focus: view.focus.trim().slice(0, 120) } : {}),
      ...(typeof view.label === "string" && view.label.trim() !== "" ? { label: view.label.trim().slice(0, 80) } : {}),
    };
  });
}

/** The engine operation for a `blender` call. Throws so every provider reports the same message. */
export function parseBlenderToolInput(value: unknown): { operation: string; args: JsonRecord } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedToolCallError("blender requires an object with a script.");
  }
  const record = value as JsonRecord;
  const views = parseBlenderViews(record.views);
  if (typeof record.inspect_file === "string" && record.inspect_file.trim() !== "") {
    if (record.script !== undefined && record.script !== null && record.script !== "") {
      throw new MalformedToolCallError("blender takes either script or inspect_file, not both: inspect_file looks at a model without running anything.");
    }
    return { operation: BLENDER_OPERATION, args: { inspect_file: record.inspect_file.trim(), ...(views.length > 0 ? { views } : {}) } };
  }
  if (typeof record.script !== "string" || record.script.trim() === "") {
    throw new MalformedToolCallError("blender requires script: the complete Python to run, or inspect_file: a model file to look at.");
  }
  const args: JsonRecord = { script: record.script, ...(views.length > 0 ? { views } : {}) };
  if (typeof record.timeout_seconds === "number") args.timeout_seconds = record.timeout_seconds;
  if (record.preview_in_studio !== undefined && record.preview_in_studio !== null) {
    if (typeof record.preview_in_studio !== "boolean") {
      throw new MalformedToolCallError("blender preview_in_studio must be true or false.");
    }
    if (record.preview_in_studio) args.preview_in_studio = true;
  }
  if (record.continue_from !== undefined && record.continue_from !== null) {
    if (!isBlenderJobId(record.continue_from)) {
      throw new MalformedToolCallError("blender continue_from must be the id of an earlier job, exactly as that job's result gave it (8 hexadecimal characters).");
    }
    args.continue_from = record.continue_from;
  }
  return { operation: BLENDER_OPERATION, args };
}
