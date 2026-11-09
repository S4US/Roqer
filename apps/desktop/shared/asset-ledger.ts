/**
 * The ledger of what Roqer uploaded to Roblox, as the main process, the chat
 * window and the agent all see it.
 *
 * An upload is irreversible and moderated, and until now its record lived in
 * one run of one chat: the same barrel went up twice, and last week's sword
 * could not be found by name. The ledger is one file in Roqer's data folder,
 * written by the main process from the uploads it watched go through the
 * bridge, never from anything the model or the window said. It keeps what is
 * needed to find an asset again and to know it is the same file: the id, the
 * type, the name, the hash of the bytes, and where it came from. Never the
 * file's path: a path is the one thing here a shared export has no use for.
 */

import type { StudioActionResult } from "./studio-status";

export type LedgerCreator = Readonly<{ kind: "user" | "group"; id: string }>;

export type LedgerAsset = Readonly<{
  /** Roblox's id, as digits. */
  assetId: string;
  assetType: string;
  displayName: string;
  /** For a Decal, the id an ImageLabel or ParticleEmitter uses; null while Roblox has not said yet. */
  imageId?: string | null;
  moderationState?: string;
  /** The upload's Open Cloud operation, which a later status check names. */
  operationId?: string;
  /** Who it was published as, when Roqer knew. */
  creator?: LedgerCreator;
  /** SHA-256 of the file's bytes, so the same file is known again. */
  sha256?: string;
  bytes?: number;
  /** The file's name alone, never its path. */
  fileName?: string;
  uploadedAt: string;
  chatId?: string;
  projectId?: string;
  runId?: string;
}>;

/** Enough for a long life of uploads; the oldest beyond it go. */
export const MAX_LEDGER_ASSETS = 5_000;
export const MAX_LEDGER_NAME_CHARS = 120;
export const MAX_LEDGER_TYPE_CHARS = 40;
/** How many rows one `list_uploads` call returns at most, and its default. */
export const MAX_LISTED_UPLOADS = 50;
export const DEFAULT_LISTED_UPLOADS = 20;
export const MAX_UPLOAD_QUERY_CHARS = 100;

const DIGITS = /^[1-9][0-9]{0,18}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown, max: number): boolean =>
  value === undefined || (typeof value === "string" && value.length <= max);

export function isLedgerCreator(value: unknown): value is LedgerCreator {
  return isRecord(value) && (value.kind === "user" || value.kind === "group") && typeof value.id === "string" && DIGITS.test(value.id);
}

export function isLedgerAsset(value: unknown): value is LedgerAsset {
  return isRecord(value) &&
    typeof value.assetId === "string" && DIGITS.test(value.assetId) &&
    typeof value.assetType === "string" && value.assetType !== "" && value.assetType.length <= MAX_LEDGER_TYPE_CHARS &&
    typeof value.displayName === "string" && value.displayName.length <= MAX_LEDGER_NAME_CHARS &&
    (value.imageId === undefined || value.imageId === null || (typeof value.imageId === "string" && DIGITS.test(value.imageId))) &&
    optionalString(value.moderationState, 40) &&
    optionalString(value.operationId, 200) &&
    (value.creator === undefined || isLedgerCreator(value.creator)) &&
    (value.sha256 === undefined || (typeof value.sha256 === "string" && SHA256.test(value.sha256))) &&
    (value.bytes === undefined || (Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0)) &&
    optionalString(value.fileName, 260) &&
    typeof value.uploadedAt === "string" && ISO_DATE.test(value.uploadedAt) &&
    optionalString(value.chatId, 1_000) && optionalString(value.projectId, 1_000) && optionalString(value.runId, 200);
}

export type AssetLedgerView = Readonly<{
  /** Newest first. */
  assets: readonly LedgerAsset[];
  /** Set once after the saved file was damaged and moved aside, or when a newer Roqer wrote it. */
  notice?: string;
}>;

export type AssetLedgerResult =
  | Readonly<{ ok: true; ledger: AssetLedgerView }>
  | Readonly<{ ok: false; message: string }>;

export type AssetThumbnailResult =
  | Readonly<{ ok: true; dataUrl: string }>
  | Readonly<{ ok: false; message: string }>;

/** What the window asks the main process to do with one asset, against one place. */
export type AssetInsertRequest = Readonly<{ endpoint: string; assetId: string; instanceId: string | null }>;
export type AssetThumbnailRequest = Readonly<{ endpoint: string; assetId: string }>;

export function isAssetLedgerResult(value: unknown): value is AssetLedgerResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.message === "string";
  return value.ok === true && isRecord(value.ledger) && Array.isArray(value.ledger.assets) &&
    value.ledger.assets.length <= MAX_LEDGER_ASSETS && value.ledger.assets.every(isLedgerAsset) &&
    (value.ledger.notice === undefined || typeof value.ledger.notice === "string");
}

/** A thumbnail is a small PNG or JPEG; a bound well above what Roblox serves at 150 pixels. */
export const MAX_THUMBNAIL_CHARACTERS = 400 * 1024;

export function isAssetThumbnailResult(value: unknown): value is AssetThumbnailResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.message === "string";
  return value.ok === true && typeof value.dataUrl === "string" && value.dataUrl.length <= MAX_THUMBNAIL_CHARACTERS &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl);
}

export function isAssetInsertRequest(value: unknown): value is AssetInsertRequest {
  return isRecord(value) && typeof value.endpoint === "string" && value.endpoint !== "" &&
    typeof value.assetId === "string" && DIGITS.test(value.assetId) &&
    (value.instanceId === null || (typeof value.instanceId === "string" && value.instanceId.length <= 200));
}

export function isAssetThumbnailRequest(value: unknown): value is AssetThumbnailRequest {
  return isRecord(value) && typeof value.endpoint === "string" && value.endpoint !== "" &&
    typeof value.assetId === "string" && DIGITS.test(value.assetId);
}

export type { StudioActionResult as AssetActionResult };

/** Whether an asset answers a search by name, id or type, case-insensitively. */
export function matchesUploadQuery(asset: LedgerAsset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return asset.displayName.toLowerCase().includes(needle) ||
    asset.assetId === needle ||
    asset.imageId === needle ||
    asset.assetType.toLowerCase() === needle ||
    (asset.fileName ?? "").toLowerCase().includes(needle);
}

/** The Creator Hub page for an asset. */
export function ledgerAssetUrl(asset: LedgerAsset): string {
  return `https://create.roblox.com/store/asset/${asset.assetId}`;
}

/** One line of an asset for the model: everything it needs to use or reuse the asset. */
export function describeLedgerAsset(asset: LedgerAsset): string {
  const parts = [
    `rbxassetid://${asset.assetId}`,
    asset.assetType,
    `“${asset.displayName}”`,
    ...(asset.imageId ? [`imageId ${asset.imageId}`] : []),
    ...(asset.moderationState ? [`moderation ${asset.moderationState}`] : []),
    `uploaded ${asset.uploadedAt.slice(0, 10)}`,
    ...(asset.fileName ? [`from ${asset.fileName}`] : []),
  ];
  return parts.join(" · ");
}
