import path from "node:path";
import { timeoutForTool } from "../shared/mcp-tools";
import type { SendToStudioResult } from "../shared/project-files";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";
import { uploadedAsset } from "./upload-assets";

/**
 * One click from a model file to the user's place: upload it to Roblox as a
 * Model, wait for Roblox to finish processing it, and insert it into the
 * connected place.
 *
 * The user asked for this by clicking, having looked at the model first, so it
 * does not go through a run's approvals.
 */

type Caller = (tool: string, args: Record<string, unknown>, options?: McpCallOptions) => Promise<McpToolOutcome>;

const POLL_MS = 2_000;
/** How long Roblox may take to process an upload before the click gives up waiting. */
const PROCESSING_WAIT_MS = 90_000;
const MAX_DISPLAY_NAME = 50;

export function displayNameFor(fileName: string): string {
  const base = path.parse(fileName).name.replace(/[_-]+/g, " ").trim() || "Model";
  return base.slice(0, MAX_DISPLAY_NAME);
}

export async function sendModelToStudio(
  call: Caller,
  request: { filePath: string; displayName: string; instanceId: string | null },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SendToStudioResult> {
  const uploadRequest = { filePath: request.filePath, assetType: "Model" as const, displayName: request.displayName.slice(0, MAX_DISPLAY_NAME) };
  const outcome = await call("upload_asset", { action: "upload", ...uploadRequest }, { timeoutMs: timeoutForTool("upload_asset") });
  let asset = uploadedAsset(uploadRequest, outcome);
  if (asset.status === "failed") {
    const reason = asset.error ?? "the upload failed";
    const keyHint = /api[ _-]?key|open ?cloud|creator|unauthori[sz]ed|401|403/i.test(reason)
      ? " Check the Open Cloud key and creator in Settings → Open Cloud."
      : "";
    return { ok: false, message: `Roblox did not take the upload: ${reason}.${keyHint}` };
  }
  const deadline = Date.now() + PROCESSING_WAIT_MS;
  while (asset.assetId === undefined && asset.operationId !== undefined && Date.now() < deadline) {
    await wait(POLL_MS);
    const status = await call("upload_asset", { action: "status", operationId: asset.operationId }, { timeoutMs: 20_000 });
    const next = uploadedAsset(uploadRequest, status);
    if (next.status === "failed") return { ok: false, message: `Roblox could not process the model: ${next.error ?? "unknown error"}.` };
    asset = { ...next, operationId: next.operationId ?? asset.operationId };
  }
  if (asset.assetId === undefined) {
    return { ok: false, message: "Roblox is still processing the upload. Try Send to Studio again in a minute." };
  }
  const inserted = await call("insert_asset", {
    assetId: Number(asset.assetId),
    ...(request.instanceId === null ? {} : { instance_id: request.instanceId }),
  }, { timeoutMs: timeoutForTool("insert_asset") });
  if (!inserted.ok) {
    return {
      ok: false,
      assetId: asset.assetId,
      message: `Uploaded as asset ${asset.assetId}, but Studio could not insert it: ${inserted.message ?? inserted.text ?? "unknown error"}. Is the place open with the Roqer plugin running?`,
    };
  }
  return {
    ok: true,
    assetId: asset.assetId,
    message: `Uploaded as asset ${asset.assetId} and inserted into the place's Workspace.${asset.moderationState && asset.moderationState !== "Approved" ? ` Roblox moderation: ${asset.moderationState}.` : ""}`,
  };
}
