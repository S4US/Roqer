import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isModelPreviewId, MAX_MODEL_PREVIEW_BYTES, modelPreviewId, type ModelPreviewResult,
} from "../shared/model-preview";

/** How long a job folder is kept, and how many at most: Blender jobs and animation previews alike. */
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_KEPT_JOBS = 40;

/**
 * The GLB Roqer's inspection exported for a job's model: its file name inside
 * the job folder, from the model's position alone, so no name the script
 * chose ever becomes part of a path.
 */
export function modelPreviewFileName(index: number): string {
  return `model-preview-${index}.glb`;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** Extensions the viewer has no decoder for; a file that requires one is not shown. */
const UNSUPPORTED_EXTENSIONS = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A reference that stays inside the file: absent (the GLB's own buffer) or a data URI. */
const isEmbedded = (uri: unknown) => uri === undefined || (typeof uri === "string" && uri.startsWith("data:"));

/**
 * Whether bytes are a self-contained binary glTF the viewer can show: the
 * header and chunks are well formed, and nothing it needs lives outside it.
 * The renderer parses what passes, so a file that would make it fetch
 * anything, or that it cannot decode, is refused here.
 */
export function inspectGlb(bytes: Uint8Array): { ok: true } | { ok: false; problem: string } {
  if (bytes.byteLength > MAX_MODEL_PREVIEW_BYTES) return { ok: false, problem: "larger than a preview may be" };
  if (bytes.byteLength < 20) return { ok: false, problem: "too short to be a GLB" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return { ok: false, problem: "not a GLB" };
  if (view.getUint32(4, true) !== 2) return { ok: false, problem: "not glTF 2.0" };
  if (view.getUint32(8, true) !== bytes.byteLength) return { ok: false, problem: "its length does not match its header" };

  let offset = 12;
  let json: unknown;
  let binaryChunks = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return { ok: false, problem: "a chunk header runs past the end" };
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) return { ok: false, problem: "a chunk runs past the end" };
    if (offset === 12) {
      if (type !== CHUNK_JSON) return { ok: false, problem: "its first chunk is not JSON" };
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, start + length)));
      } catch {
        return { ok: false, problem: "its JSON chunk does not parse" };
      }
    } else if (type === CHUNK_BIN) {
      binaryChunks += 1;
    }
    offset = start + length;
  }
  if (binaryChunks > 1) return { ok: false, problem: "it has more than one binary chunk" };
  if (!isRecord(json) || !isRecord(json.asset) || typeof json.asset.version !== "string" || !json.asset.version.startsWith("2")) {
    return { ok: false, problem: "its JSON is not a glTF 2.0 asset" };
  }
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  const images = Array.isArray(json.images) ? json.images : [];
  if (![...buffers, ...images].every((entry) => isRecord(entry) && isEmbedded(entry.uri))) {
    return { ok: false, problem: "it refers to a file outside itself" };
  }
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const unsupported = required.find((name) => typeof name === "string" && UNSUPPORTED_EXTENSIONS.has(name));
  if (unsupported !== undefined) return { ok: false, problem: `it needs ${String(unsupported)}, which the viewer cannot decode` };
  return { ok: true };
}

/**
 * A preview file's bytes when the viewer may be handed them; why not,
 * otherwise. The inspection writes it as a new file, so a link in its place
 * is not the preview, wherever it points.
 */
async function readViewableGlb(file: string): Promise<Uint8Array | "missing" | "invalid"> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (stat === undefined) return "missing";
  if (!stat.isFile() || stat.size > MAX_MODEL_PREVIEW_BYTES) return "invalid";
  const buffer = await fs.readFile(file).catch(() => undefined);
  if (buffer === undefined) return "missing";
  // A copy of its own: a view could share memory with other data, and a
  // structured clone sends the whole of what it views.
  const bytes = new Uint8Array(buffer);
  return inspectGlb(bytes).ok ? bytes : "invalid";
}

/** Whether the file at a path is a preview the viewer may be handed. */
export async function isViewableGlb(file: string): Promise<boolean> {
  return typeof await readViewableGlb(file) !== "string";
}

/** A job folder's name: its start time, then its id, as the Blender worker names them. */
function jobFolderName(started: number, jobId: string): string {
  return `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${jobId}`;
}

/**
 * Keep a 3D preview that a tool returned, such as an animation's box rig, and
 * return the id the viewer asks for it by; undefined when the bytes are not a
 * self-contained GLB the viewer can show.
 *
 * It goes in a job folder of its own beside Blender's, so it is served,
 * checked again, and expired exactly as a Blender preview is: after seven
 * days, or once forty newer job folders exist.
 */
export async function storeModelPreview(jobsRoot: string, base64: string, now: number = Date.now()): Promise<string | undefined> {
  if (base64.length === 0 || base64.length > Math.ceil(MAX_MODEL_PREVIEW_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return undefined;
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (!inspectGlb(bytes).ok) return undefined;
  const jobId = randomBytes(4).toString("hex");
  const directory = path.join(jobsRoot, jobFolderName(now, jobId));
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, modelPreviewFileName(0)), bytes, { flag: "wx" });
  } catch {
    return undefined;
  }
  await pruneJobFolders(jobsRoot, now, directory);
  return modelPreviewId(jobId, 0);
}

/** Clear job folders past their retention, oldest first, always keeping `keep`. */
export async function pruneJobFolders(jobsRoot: string, now: number, keep?: string): Promise<void> {
  const entries = await fs.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const jobs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const cutoff = now - JOB_RETENTION_MS;
  for (const [index, name] of jobs.entries()) {
    const directory = path.join(jobsRoot, name);
    if (directory === keep) continue;
    const tooMany = index < jobs.length - MAX_KEPT_JOBS;
    const modified = (await fs.stat(directory).catch(() => undefined))?.mtimeMs ?? 0;
    if (tooMany || modified < cutoff) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The preview a renderer asked for by id, read afresh and checked again.
 *
 * The id names a job and a model index; the job's folder is found by its id
 * among the job folders, and the file by the index alone. A folder that has
 * been cleared since reads as expired.
 */
export async function readModelPreview(jobsRoot: string, id: unknown): Promise<ModelPreviewResult> {
  if (!isModelPreviewId(id)) return { ok: false, reason: "invalid" };
  const jobId = id.slice(0, 8);
  const index = Number(id.slice(9));
  const folders = await fs.readdir(jobsRoot).catch(() => [] as string[]);
  const folder = folders.find((name) => name.endsWith(`-${jobId}`));
  if (folder === undefined) return { ok: false, reason: "expired" };
  const result = await readViewableGlb(path.join(jobsRoot, folder, modelPreviewFileName(index)));
  if (result === "missing") return { ok: false, reason: "expired" };
  if (result === "invalid") return { ok: false, reason: "invalid" };
  return { ok: true, bytes: result };
}
