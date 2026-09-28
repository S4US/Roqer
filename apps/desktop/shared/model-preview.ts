/**
 * A Blender job's 3D preview: the GLB Roqer's own inspection exported from
 * the model it measured, handed to the renderer by an opaque id.
 *
 * The id names a job and which of its inspected models, never a path, so the
 * renderer can ask for a preview but cannot name a file.
 */

/** The job's 8-hex-digit id, a dash, and the model's position among the job's inspected models. */
const MODEL_PREVIEW_ID = /^[0-9a-f]{8}-[0-9]$/;

export function isModelPreviewId(value: unknown): value is string {
  return typeof value === "string" && MODEL_PREVIEW_ID.test(value);
}

export function modelPreviewId(jobId: string, index: number): string {
  return `${jobId}-${index}`;
}

/**
 * The largest preview the main process hands over. A model past it is still
 * inspected and shown as its still image; only the 3D view is skipped.
 */
export const MAX_MODEL_PREVIEW_BYTES = 24 * 1024 * 1024;

export type ModelPreviewFailure =
  /** The job folder or its preview is gone: job folders are kept for seven days, and at most forty. */
  | "expired"
  /** The file is not a self-contained GLB Roqer made, or is larger than it hands over. */
  | "invalid"
  /** This window may not ask. */
  | "refused";

export type ModelPreviewResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: ModelPreviewFailure };

export function isModelPreviewResult(value: unknown): value is ModelPreviewResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return record.bytes instanceof Uint8Array && record.bytes.byteLength <= MAX_MODEL_PREVIEW_BYTES;
  return record.ok === false && (record.reason === "expired" || record.reason === "invalid" || record.reason === "refused");
}

/**
 * What Roqer's inspection measured about the model, kept as the Blender
 * evidence's metadata under these labels: the viewer shows them over the model.
 */
export const MODEL_SIZE_LABEL = "Size";
export const MODEL_TRIANGLES_LABEL = "Triangles";
export const MODEL_OBJECTS_LABEL = "Objects";
