import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isCustomConnection,
  MAX_CUSTOM_API_KEY_CHARACTERS,
  MAX_CUSTOM_CONNECTIONS,
  type CustomConnection,
  type CustomConnectionSave,
  type CustomConnectionView,
} from "../shared/custom-providers";
import type { SecretProtector } from "./secret-protector";

/**
 * The user's own model connections, kept by the main process.
 *
 * One file beside the workspace, written atomically. API keys are encrypted
 * with the operating system's store before they touch disk and are decrypted
 * only to send a request; the renderer never receives one. A file that does
 * not validate is moved aside for diagnosis rather than overwritten, and the
 * user starts again with no connections instead of a half-read list.
 */

export class CustomProviderStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomProviderStoreError";
  }
}

export type CustomProviderStoreOptions = Readonly<{
  file: string;
  protector: SecretProtector;
  now?: () => Date;
}>;

type StoredConnection = CustomConnection & Readonly<{ encryptedApiKey?: string }>;

type StoredFile = Readonly<{ schemaVersion: 1; connections: readonly StoredConnection[] }>;

/** Generous for sixteen connections of thirty-two models each, and small enough to refuse a runaway file. */
const MAX_FILE_BYTES = 512 * 1_024;
const MAX_ENCRYPTED_BYTES = 8 * 1_024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeCiphertext(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCRYPTED_BYTES * 2) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > MAX_ENCRYPTED_BYTES || decoded.toString("base64") !== value) return undefined;
  return decoded;
}

function parseStoredFile(value: unknown): StoredFile | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.connections) ||
    value.connections.length > MAX_CUSTOM_CONNECTIONS) return undefined;
  const connections: StoredConnection[] = [];
  for (const entry of value.connections) {
    if (!isRecord(entry)) return undefined;
    const { encryptedApiKey, ...connection } = entry;
    if (!isCustomConnection(connection)) return undefined;
    if (encryptedApiKey !== undefined && decodeCiphertext(encryptedApiKey) === undefined) return undefined;
    connections.push(encryptedApiKey === undefined
      ? connection
      : { ...connection, encryptedApiKey: encryptedApiKey as string });
  }
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length) return undefined;
  return { schemaVersion: 1, connections };
}

function view(connection: StoredConnection): CustomConnectionView {
  const { encryptedApiKey, ...rest } = connection;
  return { ...rest, hasKey: encryptedApiKey !== undefined };
}

export class CustomProviderStore {
  private readonly file: string;
  private readonly protector: SecretProtector;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;
  /** Where a damaged file was moved to, reported once so the user can be told. */
  private preservedPath: string | undefined;

  constructor(options: CustomProviderStoreOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The custom provider store path must be absolute.");
    this.file = options.file;
    this.protector = options.protector;
    this.now = options.now ?? (() => new Date());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<StoredFile> {
    if (this.cached !== undefined) return this.cached;
    let contents: string;
    try {
      const details = await fs.stat(this.file);
      if (details.size > MAX_FILE_BYTES) return this.preserveDamaged();
      contents = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        this.cached = { schemaVersion: 1, connections: [] };
        return this.cached;
      }
      throw new CustomProviderStoreError("Your model connections could not be read.");
    }
    let parsed: StoredFile | undefined;
    try {
      parsed = parseStoredFile(JSON.parse(contents) as unknown);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) return this.preserveDamaged();
    this.cached = parsed;
    return parsed;
  }

  private async preserveDamaged(): Promise<StoredFile> {
    const preserved = `${this.file}.damaged-${this.now().getTime()}-${randomUUID()}`;
    try {
      await fs.rename(this.file, preserved);
    } catch {
      throw new CustomProviderStoreError("Your saved model connections are damaged and could not be set aside.");
    }
    this.preservedPath = preserved;
    this.cached = { schemaVersion: 1, connections: [] };
    return this.cached;
  }

  private async write(next: StoredFile): Promise<void> {
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
      throw new CustomProviderStoreError("Too many model connections to save.");
    }
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.file);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new CustomProviderStoreError("Your model connections could not be saved.");
    }
    this.cached = next;
  }

  private encrypt(apiKey: string): string {
    if (apiKey.length === 0 || apiKey.length > MAX_CUSTOM_API_KEY_CHARACTERS) {
      throw new CustomProviderStoreError("That API key is not valid.");
    }
    if (!this.protector.isEncryptionAvailable()) {
      throw new CustomProviderStoreError(
        "This computer has no encrypted storage available, so Roqer cannot keep an API key. Connections without a key still work.",
      );
    }
    let ciphertext: Buffer;
    try {
      ciphertext = this.protector.encryptString(apiKey);
    } catch {
      throw new CustomProviderStoreError("The API key could not be encrypted.");
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_ENCRYPTED_BYTES) {
      throw new CustomProviderStoreError("The encrypted API key is invalid.");
    }
    return ciphertext.toString("base64");
  }

  /** Where a damaged file was moved on this load, once; later calls return undefined. */
  takeDamagedNotice(): string | undefined {
    const preserved = this.preservedPath;
    this.preservedPath = undefined;
    return preserved;
  }

  list(): Promise<CustomConnectionView[]> {
    return this.enqueue(async () => (await this.read()).connections.map(view));
  }

  /** Create a connection, or update the one `save.id` names. */
  save(save: CustomConnectionSave): Promise<CustomConnectionView[]> {
    return this.enqueue(async () => {
      const current = await this.read();
      const existing = save.id === undefined
        ? undefined
        : current.connections.find((connection) => connection.id === save.id);
      if (save.id !== undefined && existing === undefined) {
        throw new CustomProviderStoreError("That connection no longer exists.");
      }
      if (existing === undefined && current.connections.length >= MAX_CUSTOM_CONNECTIONS) {
        throw new CustomProviderStoreError(`You can have up to ${MAX_CUSTOM_CONNECTIONS} connections.`);
      }
      // A saved key belongs to the server it was entered for. Keeping it while
      // the address moves to another server would send it there on the next
      // request, and the renderer asking for that is not proof the user did.
      if (existing?.encryptedApiKey !== undefined && save.apiKey === undefined &&
        new URL(existing.baseUrl).origin !== new URL(save.baseUrl).origin) {
        throw new CustomProviderStoreError(
          "The address now points to a different server. Enter the API key again, or remove it, to save.",
        );
      }
      const encryptedApiKey = save.apiKey === undefined
        ? existing?.encryptedApiKey
        : save.apiKey === null ? undefined : this.encrypt(save.apiKey);
      const connection: StoredConnection = {
        id: existing?.id ?? `conn-${randomBytes(6).toString("hex").slice(0, 8)}`,
        name: save.name,
        format: save.format,
        baseUrl: save.baseUrl,
        models: save.models.map((model) => ({ ...model })),
        ...(encryptedApiKey === undefined ? {} : { encryptedApiKey }),
      };
      const connections = existing === undefined
        ? [...current.connections, connection]
        : current.connections.map((entry) => entry.id === existing.id ? connection : entry);
      await this.write({ schemaVersion: 1, connections });
      return connections.map(view);
    });
  }

  remove(id: string): Promise<CustomConnectionView[]> {
    return this.enqueue(async () => {
      const current = await this.read();
      const connections = current.connections.filter((connection) => connection.id !== id);
      if (connections.length !== current.connections.length) await this.write({ schemaVersion: 1, connections });
      return connections.map(view);
    });
  }

  /**
   * A connection with its key decrypted, for the one request about to be made.
   * `apiKey` is null for a connection saved without one.
   */
  resolve(id: string): Promise<{ connection: CustomConnection; apiKey: string | null } | undefined> {
    return this.enqueue(async () => {
      const stored = (await this.read()).connections.find((connection) => connection.id === id);
      if (stored === undefined) return undefined;
      const { encryptedApiKey, ...connection } = stored;
      if (encryptedApiKey === undefined) return { connection, apiKey: null };
      if (!this.protector.isEncryptionAvailable()) {
        throw new CustomProviderStoreError("Encrypted storage is unavailable, so the saved API key cannot be read.");
      }
      const ciphertext = decodeCiphertext(encryptedApiKey);
      let apiKey: string;
      try {
        if (ciphertext === undefined) throw new Error("undecodable");
        apiKey = this.protector.decryptString(ciphertext);
      } catch {
        throw new CustomProviderStoreError(
          `The API key saved for ${connection.name} could not be decrypted. Enter it again in Settings.`,
        );
      }
      return { connection, apiKey };
    });
  }
}
