import { MAX_UPLOADS, UPLOAD_ASSETS_OPERATION } from "../shared/gateway-operations";
import { timeoutForTool } from "../shared/mcp-tools";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";

/**
 * `upload_assets`: several files uploaded to Roblox in one call.
 *
 * A finished set of effect textures is six to eight files, and each
 * `upload_asset` was a model call of its own: the explosion run spent eight
 * calls in a row on them, each re-reading the whole conversation to send one
 * path. Here the model sends the list, and Roqer makes the same `upload_asset`
 * calls itself, one after another, through the same bridge.
 *
 * The uploads are independent, not one transaction: a file that fails does
 * not undo the ones before it, which are already on Roblox. So every file is
 * reported, the uploaded ones with their ids, so a retry sends only what
 * failed rather than uploading the rest a second time.
 */

const ASSET_TYPES = ["Audio", "Decal", "Model", "Animation", "Video"] as const;
const MAX_DISPLAY_NAME = 50;
/** Milliseconds of the call's budget one upload is allowed, the bridge's own worst case. */
const PER_UPLOAD_MS = timeoutForTool("upload_asset");

export type UploadRequest = Readonly<{
  filePath: string;
  assetType: typeof ASSET_TYPES[number];
  displayName: string;
  description?: string;
}>;

/** One file's outcome, in the few fields the model and the change card use. */
export type UploadedAsset = {
  filePath: string;
  displayName: string;
  assetType: string;
  status: "complete" | "processing" | "failed" | "not uploaded";
  assetId?: string;
  /** For a Decal, what ImageLabel.Image and ParticleEmitter.Texture use. */
  imageId?: string | null;
  decalId?: string | null;
  moderationState?: string;
  operationId?: string;
  error?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The list of uploads, checked as a whole before any is sent, or why it cannot run. */
export function parseUploadAssets(args: Record<string, unknown>): UploadRequest[] | string {
  const { uploads } = args;
  if (!Array.isArray(uploads) || uploads.length === 0 || uploads.length > MAX_UPLOADS) {
    return `uploads must list 1-${MAX_UPLOADS} files, each {filePath, assetType, displayName, description?}.`;
  }
  const requests: UploadRequest[] = [];
  const paths = new Set<string>();
  for (const [index, entry] of uploads.entries()) {
    const where = `uploads[${index}]`;
    if (!isRecord(entry)) return `${where} must be an object {filePath, assetType, displayName}.`;
    const filePath = text(entry.filePath);
    const displayName = text(entry.displayName);
    if (filePath === undefined) return `${where}.filePath must be the file's absolute path.`;
    if (paths.has(filePath)) return `${where} uploads ${filePath} a second time; list each file once.`;
    if (!ASSET_TYPES.includes(entry.assetType as UploadRequest["assetType"])) return `${where}.assetType must be one of ${ASSET_TYPES.join(", ")}.`;
    if (displayName === undefined || displayName.length > MAX_DISPLAY_NAME) return `${where}.displayName must be 1-${MAX_DISPLAY_NAME} characters.`;
    if (entry.description !== undefined && typeof entry.description !== "string") return `${where}.description must be text.`;
    paths.add(filePath);
    requests.push({
      filePath,
      assetType: entry.assetType as UploadRequest["assetType"],
      displayName,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    });
  }
  return requests;
}

/** What one `upload_asset` outcome comes to, read the way a single upload's change card reads it. */
function uploaded(request: UploadRequest, outcome: McpToolOutcome): UploadedAsset {
  const base = { filePath: request.filePath, displayName: request.displayName, assetType: request.assetType };
  const data = isRecord(outcome.data) ? outcome.data : {};
  const response = isRecord(data.response) ? data.response : {};
  const failedWith = !outcome.ok
    ? outcome.message || text(data.error) || outcome.text || "the upload failed"
    : isRecord(data.error) ? text(data.error.message) ?? "Roblox reported an error" : undefined;
  if (failedWith !== undefined) return { ...base, status: "failed", error: failedWith.slice(0, 300) };
  const status = data.status === "complete" || data.done === true ? "complete" : "processing";
  const moderation = isRecord(response.moderationResult) ? text(response.moderationResult.moderationState) : undefined;
  return {
    ...base,
    status,
    ...(text(data.asset_id) ?? text(response.assetId) ? { assetId: text(data.asset_id) ?? text(response.assetId) } : {}),
    ...("imageId" in data || "imageId" in response ? { imageId: text(data.imageId) ?? text(response.imageId) ?? null } : {}),
    ...("decalId" in data || "decalId" in response ? { decalId: text(data.decalId) ?? text(response.decalId) ?? null } : {}),
    ...(text(data.moderation_state) ?? moderation ? { moderationState: text(data.moderation_state) ?? moderation } : {}),
    ...(text(data.operation_id) ? { operationId: text(data.operation_id) } : {}),
  };
}

function line(asset: UploadedAsset): string {
  const name = `${asset.displayName} (${asset.filePath})`;
  if (asset.status === "failed") return `- ${name}: failed: ${asset.error}`;
  if (asset.status === "not uploaded") return `- ${name}: not uploaded, because this call's time ran out first`;
  const ids = [
    asset.assetId === undefined ? undefined : `asset ${asset.assetId}`,
    asset.imageId ? `imageId ${asset.imageId}` : undefined,
  ].filter((part): part is string => part !== undefined).join(", ");
  const pending = asset.status === "processing" || (asset.assetType === "Decal" && !asset.imageId);
  const check = pending && asset.operationId !== undefined
    ? `; still processing: check it with upload_asset {action: 'status', operationId: '${asset.operationId}'}`
    : "";
  return `- ${name}: ${asset.status}${ids === "" ? "" : `, ${ids}`}${asset.moderationState ? `, moderation ${asset.moderationState}` : ""}${check}`;
}

export async function uploadAssets(
  args: Record<string, unknown>,
  options: McpCallOptions,
  studio: StudioCaller,
): Promise<McpToolOutcome> {
  const started = Date.now();
  const requests = parseUploadAssets(args);
  if (typeof requests === "string") {
    return { ok: false, data: undefined, text: `${UPLOAD_ASSETS_OPERATION} was not run: ${requests}`, httpStatus: 200, durationMs: Date.now() - started };
  }

  // Each upload is started only while a whole one still fits in this call's budget.
  const deadline = started + (options.timeoutMs ?? timeoutForTool(UPLOAD_ASSETS_OPERATION));
  const results: UploadedAsset[] = [];
  for (const request of requests) {
    if (options.signal?.aborted) throw new Error("Run was cancelled.");
    if (Date.now() + PER_UPLOAD_MS > deadline) {
      results.push({ filePath: request.filePath, displayName: request.displayName, assetType: request.assetType, status: "not uploaded" });
      continue;
    }
    const uploadArgs = { action: "upload", ...request };
    const outcome = await studio("upload_asset", uploadArgs, { signal: options.signal, timeoutMs: PER_UPLOAD_MS });
    results.push(uploaded(request, outcome));
  }

  const done = results.filter((asset) => asset.status === "complete" || asset.status === "processing").length;
  const decals = results.some((asset) => asset.assetType === "Decal" && asset.imageId);
  const lines = [
    `Uploaded ${done} of ${results.length} files.${done < results.length ? " The uploaded ones are on Roblox already: retry only the others." : ""}`,
    ...results.map(line),
    ...(decals ? ["Use a Decal's imageId (rbxassetid://<imageId>) in Texture and Image properties, never its decalId."] : []),
  ];
  return {
    ok: done === results.length,
    data: { uploads: results },
    text: lines.join("\n"),
    httpStatus: 200,
    durationMs: Date.now() - started,
  };
}
