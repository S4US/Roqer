/**
 * Connections to a model endpoint the user runs or pays for themselves.
 *
 * A connection is an API format, a base URL, an optional API key, and the
 * models the user chose to use through it. Roqer sells no inference here: the
 * requests go from this computer straight to the endpoint the user named.
 *
 * Everything in this file is safe to show the renderer. The API key is not:
 * it lives encrypted in the main process, and the renderer only ever learns
 * whether one is saved (`hasKey`) or sends a new one to replace it.
 */

export const CUSTOM_API_FORMATS = ["openai", "anthropic"] as const;
export type CustomApiFormat = typeof CUSTOM_API_FORMATS[number];

export const MAX_CUSTOM_CONNECTIONS = 16;
export const MAX_CUSTOM_MODELS = 32;
export const MAX_CUSTOM_NAME_CHARACTERS = 60;
export const MAX_CUSTOM_MODEL_ID_CHARACTERS = 80;
export const MAX_CUSTOM_BASE_URL_CHARACTERS = 300;
export const MAX_CUSTOM_API_KEY_CHARACTERS = 1_024;
/** Below this the instructions and tool schemas alone do not fit. */
export const MIN_CUSTOM_CONTEXT_WINDOW = 16_000;
export const MAX_CUSTOM_CONTEXT_WINDOW = 10_000_000;
export const MIN_CUSTOM_MAX_OUTPUT = 1_024;
export const MAX_CUSTOM_MAX_OUTPUT = 128_000;
/**
 * The output cap sent to an Anthropic endpoint when the model sets none;
 * Anthropic requires one. A turn has to hold the model's thinking and a whole
 * builder script written as a tool call, which for a 900-line UI builder is
 * about 10,000 tokens. 8,192 was too small: with thinking taking its share, a
 * turn had about a thousand tokens left to answer in. Current Claude models
 * accept this much; an older one that does not says so, and the user sets a
 * lower max output for it in Settings.
 */
export const DEFAULT_ANTHROPIC_MAX_OUTPUT = 32_000;

export type CustomModel = Readonly<{
  /** The id the endpoint knows the model by, e.g. `deepseek/deepseek-chat` or `qwen2.5-coder:32b`. */
  id: string;
  displayName: string;
  /** Whether the model accepts images. When false, screenshots and attachments are not sent to it. */
  images: boolean;
  /** Whether the model takes a reasoning effort. When false, none is sent. */
  reasoning: boolean;
  /** Tokens the model can hold, when the user knows it. Bounds how much tool output a run carries. */
  contextWindow?: number;
  /** Largest answer to ask for in one turn, when the user knows it. */
  maxOutputTokens?: number;
}>;

export type CustomConnection = Readonly<{
  id: string;
  name: string;
  format: CustomApiFormat;
  /** The API base, e.g. `https://openrouter.ai/api/v1`, without a trailing slash. */
  baseUrl: string;
  models: readonly CustomModel[];
}>;

/** A connection as the renderer sees it. */
export type CustomConnectionView = CustomConnection & Readonly<{ hasKey: boolean }>;

/**
 * A connection the renderer asks to create or update.
 *
 * `apiKey` is three-valued so an edit that does not touch the key never has to
 * carry it: absent keeps the saved key, `null` removes it, a string replaces it.
 */
export type CustomConnectionSave = Readonly<{
  id?: string;
  name: string;
  format: CustomApiFormat;
  baseUrl: string;
  models: readonly CustomModel[];
  apiKey?: string | null;
}>;

export type CustomConnectionsResult =
  | Readonly<{ ok: true; connections: readonly CustomConnectionView[] }>
  | Readonly<{ ok: false; message: string }>;

export type CustomModelTestResult = Readonly<{ ok: boolean; message: string }>;

export type CustomModelImportResult =
  | Readonly<{ ok: true; modelIds: readonly string[] }>
  | Readonly<{ ok: false; message: string }>;

const CONNECTION_ID = /^conn-[a-z0-9]{8}$/;
/** Printable, no whitespace: every id a real endpoint uses fits, and nothing that could split a header or a path. */
const MODEL_ID = new RegExp(`^[\\x21-\\x7e]{1,${MAX_CUSTOM_MODEL_ID_CHARACTERS}}$`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isDisplayText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CUSTOM_NAME_CHARACTERS &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

export function isCustomConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID.test(value);
}

export function isCustomModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

export function isCustomApiFormat(value: unknown): value is CustomApiFormat {
  return CUSTOM_API_FORMATS.includes(value as CustomApiFormat);
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host.endsWith(".local")) return true;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = octets.map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * The base URL as it will be stored, or why it cannot be.
 *
 * HTTPS anywhere. Plain HTTP only for this computer and the private network,
 * because that is where a local model server lives, and anywhere else it would
 * send the prompt and the API key across the internet unencrypted.
 */
export function normalizeCustomBaseUrl(value: unknown): { ok: true; baseUrl: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: "Enter the endpoint's base URL." };
  const trimmed = value.trim();
  if (trimmed.length > MAX_CUSTOM_BASE_URL_CHARACTERS) return { ok: false, message: "That base URL is too long." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "That base URL is not a valid address." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "Put the API key in its own field, not in the URL." };
  }
  if (url.search !== "" || url.hash !== "") return { ok: false, message: "The base URL cannot have a query or a fragment." };
  if (url.protocol === "http:") {
    if (!isLoopbackOrPrivateHost(url.hostname)) {
      return { ok: false, message: "Use HTTPS. Plain HTTP is only allowed for this computer or your local network." };
    }
  } else if (url.protocol !== "https:") {
    return { ok: false, message: "The base URL must start with https:// or, for a local server, http://." };
  }
  return { ok: true, baseUrl: url.href.replace(/\/+$/, "") };
}

export function isCustomModel(value: unknown): value is CustomModel {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ["id", "displayName", "images", "reasoning", "contextWindow", "maxOutputTokens"])) return false;
  return isCustomModelId(value.id) && isDisplayText(value.displayName) &&
    typeof value.images === "boolean" && typeof value.reasoning === "boolean" &&
    (value.contextWindow === undefined ||
      isBoundedInteger(value.contextWindow, MIN_CUSTOM_CONTEXT_WINDOW, MAX_CUSTOM_CONTEXT_WINDOW)) &&
    (value.maxOutputTokens === undefined ||
      isBoundedInteger(value.maxOutputTokens, MIN_CUSTOM_MAX_OUTPUT, MAX_CUSTOM_MAX_OUTPUT));
}

function isModelList(value: unknown): value is CustomModel[] {
  return Array.isArray(value) && value.length <= MAX_CUSTOM_MODELS && value.every(isCustomModel) &&
    new Set(value.map((model) => model.id)).size === value.length;
}

export function isCustomConnection(value: unknown): value is CustomConnection {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "name", "format", "baseUrl", "models"])) return false;
  const url = normalizeCustomBaseUrl(value.baseUrl);
  return isCustomConnectionId(value.id) && isDisplayText(value.name) && isCustomApiFormat(value.format) &&
    url.ok && url.baseUrl === value.baseUrl && isModelList(value.models);
}

export function isCustomConnectionView(value: unknown): value is CustomConnectionView {
  if (!isRecord(value) || typeof value.hasKey !== "boolean") return false;
  const connection = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "hasKey"));
  return isCustomConnection(connection);
}

export function isCustomConnectionsResult(value: unknown): value is CustomConnectionsResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.message === "string";
  return Array.isArray(value.connections) && value.connections.length <= MAX_CUSTOM_CONNECTIONS &&
    value.connections.every(isCustomConnectionView);
}

export function isCustomModelTestResult(value: unknown): value is CustomModelTestResult {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string";
}

export function isCustomModelImportResult(value: unknown): value is CustomModelImportResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.message === "string";
  return Array.isArray(value.modelIds) && value.modelIds.every(isCustomModelId);
}

/**
 * A save request from the renderer, checked field by field so the message
 * says which field is wrong. The base URL comes back normalized.
 */
export function parseCustomConnectionSave(value: unknown):
  { ok: true; save: CustomConnectionSave } | { ok: false; message: string } {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "format", "baseUrl", "models", "apiKey"])) {
    return { ok: false, message: "The connection was not valid." };
  }
  if (value.id !== undefined && !isCustomConnectionId(value.id)) return { ok: false, message: "The connection was not valid." };
  if (!isDisplayText(value.name)) {
    return { ok: false, message: `Give the connection a name of up to ${MAX_CUSTOM_NAME_CHARACTERS} characters.` };
  }
  if (!isCustomApiFormat(value.format)) return { ok: false, message: "Choose the endpoint's API format." };
  const url = normalizeCustomBaseUrl(value.baseUrl);
  if (!url.ok) return url;
  if (!Array.isArray(value.models) || value.models.length > MAX_CUSTOM_MODELS) {
    return { ok: false, message: `A connection can have up to ${MAX_CUSTOM_MODELS} models.` };
  }
  for (const model of value.models) {
    if (!isCustomModel(model)) {
      const id = isRecord(model) && typeof model.id === "string" ? ` "${model.id.slice(0, MAX_CUSTOM_MODEL_ID_CHARACTERS)}"` : "";
      return {
        ok: false,
        message: `Model${id} is not valid: it needs an id without spaces, a name, and, if given, a context window of at least ${MIN_CUSTOM_CONTEXT_WINDOW.toLocaleString("en-US")} tokens.`,
      };
    }
  }
  if (new Set(value.models.map((model) => (model as CustomModel).id)).size !== value.models.length) {
    return { ok: false, message: "Each model id can only be added once per connection." };
  }
  if (value.apiKey !== undefined && value.apiKey !== null) {
    if (typeof value.apiKey !== "string" || value.apiKey.trim().length === 0 ||
      value.apiKey.length > MAX_CUSTOM_API_KEY_CHARACTERS || /[\s]/.test(value.apiKey.trim())) {
      return { ok: false, message: "That API key is not valid." };
    }
  }
  return {
    ok: true,
    save: {
      ...(value.id === undefined ? {} : { id: value.id }),
      name: value.name.trim(),
      format: value.format,
      baseUrl: url.baseUrl,
      models: value.models as CustomModel[],
      ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey === null ? null : value.apiKey.trim() }),
    },
  };
}

/**
 * One custom model as the model picker names it: the connection and the
 * model's own id, joined at the first colon. A connection id never contains
 * one, so a model id that does (`qwen2.5-coder:32b`) still splits correctly.
 */
export function customModelKey(connectionId: string, modelId: string): string {
  return `${connectionId}:${modelId}`;
}

export function parseCustomModelKey(value: unknown): { connectionId: string; modelId: string } | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const connectionId = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  return isCustomConnectionId(connectionId) && isCustomModelId(modelId) ? { connectionId, modelId } : null;
}
