import type { OpenCloudCheck, OpenCloudCreator } from "../shared/open-cloud";
import type { OpenCloudResolved } from "./open-cloud-store";

/**
 * Open Cloud for the bridge Roqer starts, and a check of the key with Roblox.
 *
 * The Studio bridge reads its Open Cloud key and creator from its environment
 * when it starts (`ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_CREATOR_USER_ID`,
 * `ROBLOX_CREATOR_GROUP_ID`). Roqer supplies them there rather than on the
 * command line, where any process on the machine could list them.
 */

const KEY_VARIABLE = "ROBLOX_OPEN_CLOUD_API_KEY";
const USER_VARIABLE = "ROBLOX_CREATOR_USER_ID";
const GROUP_VARIABLE = "ROBLOX_CREATOR_GROUP_ID";

/**
 * The environment for a bridge Roqer starts. Saved settings win over whatever
 * Roqer itself was launched with; with nothing saved, an inherited value (a
 * developer's own shell) is left as it was.
 */
export function bridgeEnvironment(base: NodeJS.ProcessEnv, settings: OpenCloudResolved | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (settings?.apiKey) env[KEY_VARIABLE] = settings.apiKey;
  if (settings?.creator) {
    // Exactly one creator: the bridge prefers a group, so an inherited group ID
    // would silently outrank a user the person chose in Settings.
    delete env[USER_VARIABLE];
    delete env[GROUP_VARIABLE];
    env[settings.creator.kind === "group" ? GROUP_VARIABLE : USER_VARIABLE] = settings.creator.id;
  }
  return env;
}

export const INTROSPECT_URL = "https://apis.roblox.com/api-keys/v1/introspect";
const CHECK_TIMEOUT_MS = 15_000;
const MAX_DETAIL_CHARACTERS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((entry) => typeof entry === "string" || typeof entry === "number" ? [String(entry)] : []) : [];

function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return undefined;
}

/** Roblox's words, bounded, with the key taken out should they ever repeat it. */
function detailOf(body: string, apiKey: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const message = parsed.message ?? parsed.detail ?? parsed.error ??
        (Array.isArray(parsed.errors) && isRecord(parsed.errors[0]) ? parsed.errors[0].message : undefined);
      if (typeof message === "string") detail = message;
    }
  } catch {
    // Plain text is its own detail.
  }
  return detail.split(apiKey).join("[key]").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARACTERS);
}

export class OpenCloudCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCloudCheckError";
  }
}

export type OpenCloudCheckOptions = Readonly<{
  apiKey: string;
  creator: OpenCloudCreator | null;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
}>;

/**
 * Ask Roblox what this key may do, and whether that includes publishing assets
 * as the configured creator. Nothing is created or changed. Throws only when
 * Roblox could not be asked; a key Roblox refuses is a result, not an error.
 */
export async function checkOpenCloudKey(options: OpenCloudCheckOptions): Promise<OpenCloudCheck> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CHECK_TIMEOUT_MS);
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(INTROSPECT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: options.apiKey }),
      signal: controller.signal,
    });
    body = await response.text();
  } catch (error) {
    throw new OpenCloudCheckError(controller.signal.aborted
      ? "Roblox did not answer the key check in time. Try again."
      : "Roqer could not reach Roblox to check the key. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) throw new OpenCloudCheckError("Roblox is limiting requests right now. Try the check again in a minute.");
  if (response.status >= 500) throw new OpenCloudCheckError(`Roblox could not check the key (status ${response.status}). Try again later.`);
  if (!response.ok) {
    const detail = detailOf(body, options.apiKey);
    return {
      checkedAt,
      canUpload: false,
      message: `Roblox did not accept this key${detail ? `: ${detail}` : ""}. Copy it again from the Creator Dashboard.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) throw new OpenCloudCheckError("Roblox answered the key check with something Roqer could not read.");

  const keyName = typeof parsed.name === "string" ? parsed.name.slice(0, 200) : undefined;
  const authorizedUserId = idOf(parsed.authorizedUserId);
  const expiresAt = typeof parsed.expirationTimeUtc === "string" ? parsed.expirationTimeUtc.slice(0, 64) : undefined;
  const asset = (Array.isArray(parsed.scopes) ? parsed.scopes : [])
    .filter(isRecord)
    .filter((scope) => scope.name === "asset");
  const operations = new Set(asset.flatMap((scope) => strings(scope.operations)));
  const canRead = operations.has("read");
  const canWrite = operations.has("write");
  const facts = {
    checkedAt,
    ...(keyName === undefined ? {} : { keyName }),
    ...(authorizedUserId === undefined ? {} : { authorizedUserId }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    canRead,
    canWrite,
  };
  const result = (canUpload: boolean, message: string): OpenCloudCheck => ({ ...facts, canUpload, message });

  if (parsed.enabled === false) return result(false, "This key is disabled. Enable it in the Creator Dashboard, or use another key.");
  if (parsed.expired === true) return result(false, "This key has expired. Create a new one in the Creator Dashboard.");
  if (!canWrite) {
    return result(false, "This key cannot publish assets. Add the Assets API with Write access to it in the Creator Dashboard.");
  }
  if (options.creator === null) {
    return result(false, authorizedUserId === undefined
      ? "The key can publish assets. Choose the Roblox user or group uploads are published as."
      : `The key can publish assets. Choose who uploads are published as; the key belongs to user ${authorizedUserId}.`);
  }
  // A scope may list the users and groups it covers. When it lists none, Roblox
  // has not narrowed it, and the upload itself is the final word.
  const listed = options.creator.kind === "group"
    ? asset.flatMap((scope) => strings(scope.groupIds))
    : asset.flatMap((scope) => strings(scope.userIds));
  const narrowed = asset.some((scope) => Array.isArray(options.creator!.kind === "group" ? scope.groupIds : scope.userIds));
  if (narrowed && !listed.includes("*") && !listed.includes(options.creator.id)) {
    return result(false, `This key cannot publish as ${options.creator.kind} ${options.creator.id}. Add that ${options.creator.kind} to the key's Assets access, or choose another creator.`);
  }
  return result(true, `Uploads will be published as ${options.creator.kind} ${options.creator.id}.`);
}
