/** Renderer-safe MCP configuration. Secret values travel only in save requests. */
export type CustomMcpConnection = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: readonly string[];
  url?: string;
}>;

export type CustomMcpConnectionView = CustomMcpConnection & Readonly<{
  environmentKeys: readonly string[];
  headerKeys: readonly string[];
}>;

/** Omitted secrets keep their saved value; null clears them; a map replaces them. */
export type CustomMcpSave = Omit<CustomMcpConnection, "id"> & Readonly<{
  id?: string;
  environment?: Record<string, string> | null;
  headers?: Record<string, string> | null;
}>;

export type CustomMcpSettingsResult =
  | Readonly<{ ok: true; connections: readonly CustomMcpConnectionView[] }>
  | Readonly<{ ok: false; message: string }>;

export type CustomMcpCheckResult =
  | Readonly<{ ok: true; tools: number; message: string }>
  | Readonly<{ ok: false; message: string }>;

export const MAX_CUSTOM_MCP_CONNECTIONS = 16;
export const MAX_CUSTOM_MCP_NAME_CHARACTERS = 60;
export const MAX_CUSTOM_MCP_COMMAND_CHARACTERS = 1_024;
export const MAX_CUSTOM_MCP_URL_CHARACTERS = 2_048;
export const MAX_CUSTOM_MCP_ARGUMENTS = 64;
export const MAX_CUSTOM_MCP_ARGUMENT_CHARACTERS = 2_048;
export const MAX_CUSTOM_MCP_SECRET_KEYS = 32;
export const MAX_CUSTOM_MCP_SECRET_VALUE_CHARACTERS = 4_096;
export const MAX_CUSTOM_MCP_SECRET_CHARACTERS = 16_384;

const CONFIG_KEYS = ["id", "name", "enabled", "transport", "command", "args", "url"];
const SAVE_KEYS = [...CONFIG_KEYS, "environment", "headers"];
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).every((key) => allowed.includes(key));
}

function hasControlCharacters(value: string, allowTab = false): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 0x20 && !(allowTab && code === 9)) || code === 0x7f;
  });
}

export function isCustomMcpConnectionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
}

function isSecretKey(key: string, kind: "environment" | "headers"): boolean {
  return !PROTOTYPE_KEYS.has(key.toLowerCase()) && (kind === "environment" ? ENVIRONMENT_KEY : HEADER_KEY).test(key);
}

function isSecretKeyList(value: unknown, kind: "environment" | "headers"): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_MCP_SECRET_KEYS) return false;
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string" || !isSecretKey(key, kind)) return false;
    const identity = kind === "headers" ? key.toLowerCase() : key;
    if (seen.has(identity)) return false;
    seen.add(identity);
  }
  return true;
}

/** Validate and copy a map before encrypting or using decrypted saved secrets. */
export function normalizeCustomMcpSecretMap(value: unknown, kind: "environment" | "headers"): Record<string, string> {
  if (!isRecord(value) || !isSecretKeyList(Object.keys(value), kind) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`The ${kind} secret names are not valid (up to ${MAX_CUSTOM_MCP_SECRET_KEYS} names).`);
  }
  let characters = 0;
  const entries: [string, string][] = [];
  for (const [key, secret] of Object.entries(value)) {
    if (typeof secret !== "string" || secret.length > MAX_CUSTOM_MCP_SECRET_VALUE_CHARACTERS || secret.includes("\0") ||
      (kind === "headers" && hasControlCharacters(secret, true))) {
      throw new Error(`A ${kind} secret value is not valid or is too long.`);
    }
    characters += key.length + secret.length;
    if (characters > MAX_CUSTOM_MCP_SECRET_CHARACTERS) throw new Error(`The ${kind} secrets are too large.`);
    entries.push([key, secret]);
  }
  return Object.fromEntries(entries);
}

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || hasControlCharacters(value)) {
    throw new Error("Enter a valid MCP endpoint URL.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_CUSTOM_MCP_URL_CHARACTERS) throw new Error("That MCP URL is too long.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That MCP URL is not a valid address.");
  }
  if (url.username !== "" || url.password !== "") throw new Error("Put credentials in headers, not in the MCP URL.");
  if (trimmed.includes("#")) throw new Error("The MCP URL cannot contain a fragment.");
  const host = url.hostname.toLowerCase();
  const octets = host.split(".");
  const loopback = host === "localhost" || host === "[::1]" ||
    (octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use HTTPS for MCP endpoints. HTTP is allowed only on this computer's loopback address.");
  }
  if (url.href.length > MAX_CUSTOM_MCP_URL_CHARACTERS) throw new Error("That MCP URL is too long.");
  return url.href;
}

/** Check untrusted IPC payloads field by field without including secret values in errors. */
export function normalizeCustomMcpSave(value: unknown): CustomMcpSave {
  if (!isRecord(value) || !hasOnlyKeys(value, SAVE_KEYS)) throw new Error("The MCP connection is not valid.");
  if (value.id !== undefined && !isCustomMcpConnectionId(value.id)) throw new Error("The MCP connection id is not valid.");
  if (typeof value.name !== "string" || value.name.trim().length === 0 ||
    value.name.length > MAX_CUSTOM_MCP_NAME_CHARACTERS || hasControlCharacters(value.name)) {
    throw new Error(`Give the MCP connection a name of up to ${MAX_CUSTOM_MCP_NAME_CHARACTERS} characters.`);
  }
  if (typeof value.enabled !== "boolean") throw new Error("Choose whether the MCP connection is enabled.");
  if (value.transport !== "stdio" && value.transport !== "http") throw new Error("Choose stdio or HTTP for the MCP transport.");
  let destination: Pick<CustomMcpSave, "command" | "args" | "url">;
  if (value.transport === "stdio") {
    if (value.url !== undefined) throw new Error("A stdio MCP connection cannot also have an HTTP URL.");
    if (typeof value.command !== "string" || value.command.trim().length === 0 ||
      value.command.length > MAX_CUSTOM_MCP_COMMAND_CHARACTERS || hasControlCharacters(value.command)) {
      throw new Error("Enter a valid, nonempty MCP executable command.");
    }
    const args: unknown = value.args === undefined ? [] : value.args;
    if (!Array.isArray(args) || args.length > MAX_CUSTOM_MCP_ARGUMENTS ||
      !Array.from(args).every((arg: unknown) => typeof arg === "string" && arg.length <= MAX_CUSTOM_MCP_ARGUMENT_CHARACTERS && !arg.includes("\0")) ||
      args.reduce((total: number, arg: string) => total + arg.length, 0) > 32_768) {
      throw new Error("MCP arguments must be a bounded array of strings without null characters.");
    }
    destination = { command: value.command.trim(), args: [...args] as string[] };
  } else {
    if (value.command !== undefined || value.args !== undefined) throw new Error("An HTTP MCP connection cannot also have a command or arguments.");
    destination = { url: normalizeHttpUrl(value.url) };
  }
  return {
    ...(value.id === undefined ? {} : { id: value.id as string }),
    name: value.name.trim(), enabled: value.enabled, transport: value.transport, ...destination,
    ...(value.environment === undefined ? {} : {
      environment: value.environment === null ? null : normalizeCustomMcpSecretMap(value.environment, "environment"),
    }),
    ...(value.headers === undefined ? {} : {
      headers: value.headers === null ? null : normalizeCustomMcpSecretMap(value.headers, "headers"),
    }),
  };
}

export function isCustomMcpConnection(value: unknown): value is CustomMcpConnection {
  if (!isRecord(value) || !hasOnlyKeys(value, CONFIG_KEYS) || !isCustomMcpConnectionId(value.id)) return false;
  try {
    const normalized = normalizeCustomMcpSave(value);
    return normalized.name === value.name && normalized.command === value.command && normalized.url === value.url;
  } catch {
    return false;
  }
}

export function isCustomMcpConnectionView(value: unknown): value is CustomMcpConnectionView {
  if (!isRecord(value) || !hasOnlyKeys(value, [...CONFIG_KEYS, "environmentKeys", "headerKeys"]) ||
    !isSecretKeyList(value.environmentKeys, "environment") || !isSecretKeyList(value.headerKeys, "headers")) return false;
  const connection = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "environmentKeys" && key !== "headerKeys"));
  return isCustomMcpConnection(connection);
}

function isMessage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096;
}

export function isCustomMcpSettingsResult(value: unknown): value is CustomMcpSettingsResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return hasOnlyKeys(value, ["ok", "message"]) && isMessage(value.message);
  return value.ok === true && hasOnlyKeys(value, ["ok", "connections"]) && Array.isArray(value.connections) &&
    value.connections.length <= MAX_CUSTOM_MCP_CONNECTIONS && Array.from(value.connections).every(isCustomMcpConnectionView) &&
    new Set(value.connections.map((connection: CustomMcpConnectionView) => connection.id)).size === value.connections.length;
}

export function isCustomMcpCheckResult(value: unknown): value is CustomMcpCheckResult {
  if (!isRecord(value) || !isMessage(value.message)) return false;
  if (value.ok === false) return hasOnlyKeys(value, ["ok", "message"]);
  return value.ok === true && hasOnlyKeys(value, ["ok", "tools", "message"]) &&
    Number.isSafeInteger(value.tools) && (value.tools as number) >= 0;
}
