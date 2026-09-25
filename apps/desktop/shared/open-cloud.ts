/**
 * The user's Roblox Open Cloud settings, as the main process and the renderer
 * both see them.
 *
 * The API key itself never crosses to the renderer: it goes in once, on save,
 * and comes back only as `hasKey`. The main process keeps it encrypted, hands
 * it to the Studio bridge Roqer starts, and uses it to check the key with
 * Roblox. The model never sees it; `upload_asset` simply works or reports why
 * not.
 */

/** Who an upload is published as. Roblox takes exactly one of the two. */
export type OpenCloudCreator = Readonly<{ kind: "user" | "group"; id: string }>;

/**
 * What a check of the saved key with Roblox found. `canUpload` is the answer a
 * user wants; the rest says why.
 */
export type OpenCloudCheck = Readonly<{
  checkedAt: string;
  /** The key is valid, enabled, not expired, and allows asset writes for the configured creator. */
  canUpload: boolean;
  /** One sentence for the user. */
  message: string;
  keyName?: string;
  /** The Roblox user who created the key; a sensible creator when none is set. */
  authorizedUserId?: string;
  expiresAt?: string;
  canRead?: boolean;
  canWrite?: boolean;
}>;

/**
 * Whether the bridge Roqer talks to is using these settings.
 * - `roqer`: Roqer started it with the saved settings.
 * - `restart-pending`: saved, and it restarts with them when the current run ends.
 * - `adopted`: another program started the bridge, so it uses its own environment.
 * - `none`: no bridge is running yet; the next one Roqer starts uses them.
 */
export type OpenCloudBridgeUse = "roqer" | "restart-pending" | "adopted" | "none";

export type OpenCloudSettingsView = Readonly<{
  hasKey: boolean;
  creator: OpenCloudCreator | null;
  bridge: OpenCloudBridgeUse;
  /** Set once after the saved file was damaged and moved aside. */
  damagedNotice?: string;
}>;

/**
 * A save from Settings. `apiKey` absent keeps the saved key, `null` removes it,
 * and a string replaces it; `creator` is always the whole new value.
 */
export type OpenCloudSave = Readonly<{ apiKey?: string | null; creator: OpenCloudCreator | null }>;

export type OpenCloudSettingsResult =
  | Readonly<{ ok: true; settings: OpenCloudSettingsView }>
  | Readonly<{ ok: false; message: string }>;

export type OpenCloudCheckResult =
  | Readonly<{ ok: true; check: OpenCloudCheck }>
  | Readonly<{ ok: false; message: string }>;

/** Roblox keys run to a few hundred characters; this bounds what is kept, not what is typical. */
export const MAX_OPEN_CLOUD_KEY_CHARACTERS = 4_096;

const CREATOR_ID = /^[1-9][0-9]{0,18}$/;
const KEY_CHARACTERS = /^[\x21-\x7e]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isOpenCloudCreator(value: unknown): value is OpenCloudCreator {
  return isRecord(value) && (value.kind === "user" || value.kind === "group") &&
    typeof value.id === "string" && CREATOR_ID.test(value.id) && Object.keys(value).length === 2;
}

/** A key as typed: surrounding whitespace dropped, anything else unusual refused. */
export function normalizeOpenCloudKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OPEN_CLOUD_KEY_CHARACTERS || !KEY_CHARACTERS.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

const BRIDGE_USES: readonly OpenCloudBridgeUse[] = ["roqer", "restart-pending", "adopted", "none"];
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";

function isOpenCloudSettingsView(value: unknown): value is OpenCloudSettingsView {
  return isRecord(value) && typeof value.hasKey === "boolean" &&
    (value.creator === null || isOpenCloudCreator(value.creator)) &&
    BRIDGE_USES.includes(value.bridge as OpenCloudBridgeUse) && optionalString(value.damagedNotice);
}

function isOpenCloudCheck(value: unknown): value is OpenCloudCheck {
  return isRecord(value) && typeof value.checkedAt === "string" && typeof value.canUpload === "boolean" &&
    typeof value.message === "string" && optionalString(value.keyName) && optionalString(value.authorizedUserId) &&
    optionalString(value.expiresAt) && optionalBoolean(value.canRead) && optionalBoolean(value.canWrite);
}

const isFailure = (value: Record<string, unknown>) => value.ok === false && typeof value.message === "string";

export function isOpenCloudSettingsResult(value: unknown): value is OpenCloudSettingsResult {
  return isRecord(value) && (isFailure(value) || (value.ok === true && isOpenCloudSettingsView(value.settings)));
}

export function isOpenCloudCheckResult(value: unknown): value is OpenCloudCheckResult {
  return isRecord(value) && (isFailure(value) || (value.ok === true && isOpenCloudCheck(value.check)));
}

/** Validates a save from the renderer; returns a message the user can act on when it fails. */
export function parseOpenCloudSave(value: unknown): { save: OpenCloudSave } | { message: string } {
  if (!isRecord(value)) return { message: "The Open Cloud settings are not valid." };
  const unknownField = Object.keys(value).find((key) => key !== "apiKey" && key !== "creator");
  if (unknownField !== undefined) return { message: "The Open Cloud settings are not valid." };
  let apiKey: string | null | undefined;
  if (value.apiKey === null) apiKey = null;
  else if (typeof value.apiKey === "string") {
    apiKey = normalizeOpenCloudKey(value.apiKey);
    if (apiKey === undefined) return { message: "That does not look like an Open Cloud API key. Paste the whole key." };
  } else if (value.apiKey !== undefined) return { message: "The Open Cloud settings are not valid." };
  let creator: OpenCloudCreator | null;
  if (value.creator === null) creator = null;
  else if (isOpenCloudCreator(value.creator)) creator = { kind: value.creator.kind, id: value.creator.id };
  else if (isRecord(value.creator) && typeof value.creator.id === "string") {
    return { message: "A Roblox user or group ID is a number, such as 123456789." };
  } else return { message: "The Open Cloud settings are not valid." };
  return { save: { ...(apiKey === undefined ? {} : { apiKey }), creator } };
}
