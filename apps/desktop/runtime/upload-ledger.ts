import path from "node:path";

import {
  DEFAULT_LISTED_UPLOADS, describeLedgerAsset, matchesUploadQuery, MAX_LISTED_UPLOADS, MAX_UPLOAD_QUERY_CHARS,
  type LedgerAsset, type LedgerCreator,
} from "../shared/asset-ledger";
import { LIST_UPLOADS_OPERATION } from "../shared/gateway-operations";
import { hashFile, type AssetLedger } from "./asset-ledger";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";

/**
 * The ledger beside the upload path, and the agent's way of reading it.
 *
 * Every `upload_asset` of a run goes through here, on its way to the bridge
 * and back. Before the upload, the file is hashed, and a file whose exact
 * bytes this account already uploaded as this type is answered from the
 * ledger: the asset exists, uploading it again would only spend a moderation
 * and make a duplicate. After the upload, what Roblox said is written down.
 * A later status check fills in what it learns. `list_uploads` is the
 * agent's read of the same file.
 */

/** What the ledger needs to know about the run an upload belongs to. */
export type LedgerRunContext = Readonly<{
  chatId?: string;
  projectId?: string;
  runId?: string;
  /** Who uploads publish as right now, as Settings has it; undefined when unknown. */
  creator: () => Promise<LedgerCreator | undefined>;
  now?: () => Date;
}>;

/** The part of the store this module uses, so it can be tested with a fake. */
export type LedgerLike = Pick<AssetLedger, "record" | "update" | "findByHash" | "list">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const DIGITS = /^[1-9][0-9]{0,18}$/;

/** What an `upload_asset` result says, read the way the result cards read it. */
export function uploadReport(outcome: McpToolOutcome): {
  assetId?: string; imageId?: string | null; moderationState?: string; operationId?: string; complete: boolean; failed: boolean;
} {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const response = isRecord(data.response) ? data.response : {};
  const failed = !outcome.ok || isRecord(data.error) || typeof data.error === "string";
  const assetId = text(data.asset_id) ?? text(response.assetId);
  const moderation = isRecord(response.moderationResult) ? text(response.moderationResult.moderationState) : undefined;
  return {
    ...(assetId !== undefined && DIGITS.test(assetId) ? { assetId } : {}),
    ...("imageId" in data || "imageId" in response ? { imageId: text(data.imageId) ?? text(response.imageId) ?? null } : {}),
    ...(text(data.moderation_state) ?? moderation ? { moderationState: text(data.moderation_state) ?? moderation } : {}),
    ...(text(data.operation_id) ? { operationId: text(data.operation_id) } : {}),
    complete: data.status === "complete" || data.done === true,
    failed,
  };
}

/** The outcome an upload gets when its exact bytes are already on Roblox. */
export function alreadyUploadedOutcome(known: LedgerAsset): McpToolOutcome {
  const when = known.uploadedAt.slice(0, 10);
  const moderation = known.moderationState ? `, moderation ${known.moderationState}` : "";
  const image = known.imageId ? `, imageId ${known.imageId}` : "";
  return {
    ok: true,
    data: {
      status: "already_uploaded",
      asset_id: known.assetId,
      assetId: known.assetId,
      assetType: known.assetType,
      displayName: known.displayName,
      ...(known.imageId === undefined ? {} : { imageId: known.imageId }),
      ...(known.moderationState === undefined ? {} : { moderation_state: known.moderationState }),
      uploadedAt: known.uploadedAt,
      note: "Not uploaded again: a file with exactly these bytes was uploaded before. Use the asset id above; a changed file uploads as a new asset.",
    },
    text: `Not uploaded again: these exact bytes went to Roblox on ${when} as ${known.assetType} asset ${known.assetId}${image}${moderation}. Use rbxassetid://${known.assetId}; a changed file uploads as a new asset.`,
    httpStatus: 200,
    durationMs: 0,
  };
}

/**
 * One `upload_asset` call, answered from the ledger when it can be, recorded
 * when it went through. Never refuses or alters an upload the ledger cannot
 * speak to: an unreadable file simply uploads as before.
 */
export async function ledgerAwareUpload(
  args: Record<string, unknown>,
  options: McpCallOptions,
  studio: StudioCaller,
  ledger: LedgerLike,
  context: LedgerRunContext,
): Promise<McpToolOutcome> {
  if (args.action === "status") {
    const outcome = await studio("upload_asset", args, options);
    if (outcome.ok) {
      const report = uploadReport(outcome);
      const operationId = typeof args.operationId === "string" ? args.operationId : report.operationId;
      if (operationId !== undefined && !report.failed) {
        await ledger.update({ operationId }, {
          ...(report.assetId === undefined ? {} : { assetId: report.assetId }),
          ...(report.imageId === undefined ? {} : { imageId: report.imageId }),
          ...(report.moderationState === undefined ? {} : { moderationState: report.moderationState }),
        }).catch(() => undefined);
      }
    }
    return outcome;
  }

  const filePath = typeof args.filePath === "string" ? args.filePath : undefined;
  const assetType = typeof args.assetType === "string" ? args.assetType : undefined;
  const file = filePath === undefined ? undefined : await hashFile(filePath);
  const creator = await context.creator().catch(() => undefined);
  if (file !== undefined && assetType !== undefined) {
    const known = await ledger.findByHash(file.sha256, assetType, creator).catch(() => undefined);
    // A rejected upload may be tried again: the user may have changed what
    // Roblox objected to without changing the bytes, such as the name.
    if (known !== undefined && known.moderationState !== "Rejected") return alreadyUploadedOutcome(known);
  }

  const outcome = await studio("upload_asset", args, options);
  if (!outcome.ok) return outcome;
  const report = uploadReport(outcome);
  if (report.failed || report.assetId === undefined || assetType === undefined) return outcome;
  const displayName = typeof args.displayName === "string" ? args.displayName.slice(0, 120) : "";
  const row: LedgerAsset = {
    assetId: report.assetId,
    assetType: assetType.slice(0, 40),
    displayName,
    ...(report.imageId === undefined ? {} : { imageId: report.imageId }),
    ...(report.moderationState === undefined ? {} : { moderationState: report.moderationState }),
    ...(report.operationId === undefined ? {} : { operationId: report.operationId }),
    ...(creator === undefined ? {} : { creator }),
    ...(file === undefined ? {} : { sha256: file.sha256, bytes: file.bytes }),
    ...(filePath === undefined ? {} : { fileName: path.basename(filePath).slice(0, 260) }),
    uploadedAt: (context.now ?? (() => new Date()))().toISOString(),
    ...(context.chatId === undefined ? {} : { chatId: context.chatId }),
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  };
  await ledger.record(row).catch(() => undefined);
  return outcome;
}

/** `list_uploads`: what this computer already uploaded, newest first, for the agent. */
export async function listUploads(args: Record<string, unknown>, ledger: LedgerLike): Promise<McpToolOutcome> {
  const started = Date.now();
  const refuse = (message: string): McpToolOutcome => ({
    ok: false, data: undefined, text: `${LIST_UPLOADS_OPERATION} was not run: ${message}`, httpStatus: 200, durationMs: Date.now() - started,
  });
  const query = args.query === undefined ? "" : args.query;
  if (typeof query !== "string" || query.length > MAX_UPLOAD_QUERY_CHARS) return refuse(`query must be a string of at most ${MAX_UPLOAD_QUERY_CHARS} characters.`);
  const assetType = args.assetType;
  if (assetType !== undefined && (typeof assetType !== "string" || assetType.length > 40)) return refuse("assetType must be a short string such as Decal or Model.");
  const limit = args.limit === undefined ? DEFAULT_LISTED_UPLOADS : args.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LISTED_UPLOADS) return refuse(`limit must be a whole number from 1 to ${MAX_LISTED_UPLOADS}.`);

  const all = await ledger.list();
  const matching = all.filter((asset) =>
    (assetType === undefined || asset.assetType.toLowerCase() === (assetType as string).toLowerCase()) &&
    matchesUploadQuery(asset, query));
  const shown = matching.slice(0, limit as number);
  const header = all.length === 0
    ? "Nothing has been uploaded from this computer yet."
    : matching.length === 0
      ? `No upload matches${query === "" ? "" : ` “${query}”`}${assetType === undefined ? "" : ` of type ${assetType}`}; ${all.length} recorded in all.`
      : `${shown.length} of ${matching.length} matching upload${matching.length === 1 ? "" : "s"}, newest first (${all.length} recorded in all). Reuse an id rather than uploading the same file again.`;
  return {
    ok: true,
    data: {
      total: all.length,
      matching: matching.length,
      uploads: shown.map((asset) => ({
        assetId: asset.assetId, assetType: asset.assetType, displayName: asset.displayName,
        ...(asset.imageId === undefined ? {} : { imageId: asset.imageId }),
        ...(asset.moderationState === undefined ? {} : { moderationState: asset.moderationState }),
        uploadedAt: asset.uploadedAt,
        ...(asset.fileName === undefined ? {} : { fileName: asset.fileName }),
      })),
    },
    text: [header, ...shown.map((asset) => `- ${describeLedgerAsset(asset)}`)].join("\n"),
    httpStatus: 200,
    durationMs: Date.now() - started,
  };
}
