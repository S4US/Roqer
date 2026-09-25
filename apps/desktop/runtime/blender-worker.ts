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
const INSPECT_TIMEOUT_MS = 30_000;
const MAX_LOG_CHARACTERS = 4_000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Old jobs are cleared once they are this old; a model to upload is uploaded within the day. */
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_KEPT_JOBS = 40;

const DONE_MARKER = "ROQER_SCRIPT_DONE";
const FAILED_MARKER = "ROQER_SCRIPT_FAILED";
const INSPECT_MARKER = "ROQER_INSPECT ";

/** Roqer's wrapper around the model's script. */
export const RUNNER_SCRIPT = String.raw`import bpy, os, sys, traceback

job_dir = sys.argv[sys.argv.index("--") + 1]
OUTPUT_DIR = os.path.join(job_dir, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
script_path = os.path.join(job_dir, "script.py")
with open(script_path, "r", encoding="utf-8") as handle:
    source = handle.read()
namespace = {"__name__": "__main__", "__file__": script_path, "OUTPUT_DIR": OUTPUT_DIR, "bpy": bpy}
try:
    exec(compile(source, script_path, "exec"), namespace)
except BaseException:
    traceback.print_exc()
    print("${FAILED_MARKER}", flush=True)
    sys.exit(1)
print("${DONE_MARKER}", flush=True)
`;

/** Roqer's own check of one exported model: measure it, then render a framed preview. */
export const INSPECT_SCRIPT = String.raw`import bpy, os, sys, json, math
from mathutils import Vector

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
if meshes:
    size = high - low
    stats["size"] = [round(size.x, 4), round(size.y, 4), round(size.z, 4)]
    stats["min"] = [round(low.x, 4), round(low.y, 4), round(low.z, 4)]
    # Workbench draws a material's viewport colour, which importers leave grey;
    # copy each principled base colour across so the preview shows real colours.
    for material in bpy.data.materials:
        if material.use_nodes and material.node_tree is not None:
            for node in material.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    material.diffuse_color = tuple(node.inputs["Base Color"].default_value)
                    break
    center = (low + high) / 2
    radius = max(size.length / 2, 0.01)
    camera = bpy.data.objects.new("RoqerPreviewCamera", bpy.data.cameras.new("RoqerPreviewCamera"))
    scene.collection.objects.link(camera)
    direction = Vector((1.0, -1.2, 0.8)).normalized()
    distance = radius / math.sin(camera.data.angle / 2) * 1.1
    camera.location = center + direction * distance
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.clip_end = distance * 4
    scene.camera = camera
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = {"vertex": "VERTEX", "texture": "TEXTURE"}.get(color_source, "MATERIAL")
    scene.render.resolution_x = 512
    scene.render.resolution_y = 384
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = preview_path
    try:
        bpy.ops.render.render(write_still=True)
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
  inspectionError?: string;
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
          ? "A preview render of each model is attached. Check its shape and colours against the request before uploading."
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
  return `- ${file.path} (${Math.max(1, Math.round(file.bytes / 1024))} KB): ${facts}${file.colorSource === undefined ? "" : `; ${COLOR_SOURCE_NOTES[file.colorSource]}`}${pieces}`;
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
