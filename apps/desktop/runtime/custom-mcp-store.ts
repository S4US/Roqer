import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isCustomMcpConnectionView,
  MAX_CUSTOM_MCP_CONNECTIONS,
  normalizeCustomMcpSave,
  normalizeCustomMcpSecretMap,
  type CustomMcpConnection,
  type CustomMcpConnectionView,
  type CustomMcpSave,
} from "../shared/custom-mcp";
import type { SecretProtector } from "./secret-protector";

export type ResolvedCustomMcpConnection = Readonly<{
  connection: CustomMcpConnection;
  environment: Record<string, string>;
  headers: Record<string, string>;
}>;

export class CustomMcpStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomMcpStoreError";
  }
}

export type CustomMcpStoreOptions = Readonly<{ file: string; protector: SecretProtector }>;

type StoredConnection = CustomMcpConnectionView & Readonly<{
  encryptedEnvironment?: string;
  encryptedHeaders?: string;
}>;
type StoredFile = Readonly<{ schemaVersion: 1; connections: readonly StoredConnection[] }>;

const MAX_FILE_BYTES = 512 * 1_024;
const MAX_ENCRYPTED_BYTES = 128 * 1_024;
const EMPTY_FILE: StoredFile = { schemaVersion: 1, connections: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeCiphertext(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCRYPTED_BYTES * 2) return undefined;
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0 || buffer.length > MAX_ENCRYPTED_BYTES || buffer.toString("base64") !== value) return undefined;
  return buffer;
}

function parseStoredFile(value: unknown): StoredFile | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "connections") ||
    value.schemaVersion !== 1 || !Array.isArray(value.connections) || value.connections.length > MAX_CUSTOM_MCP_CONNECTIONS) return undefined;
  const connections: StoredConnection[] = [];
  for (const entry of value.connections) {
    if (!isRecord(entry)) return undefined;
    const { encryptedEnvironment, encryptedHeaders, ...connection } = entry;
    if (!isCustomMcpConnectionView(connection)) return undefined;
    if ((encryptedEnvironment === undefined) !== (connection.environmentKeys.length === 0) ||
      (encryptedHeaders === undefined) !== (connection.headerKeys.length === 0) ||
      (encryptedEnvironment !== undefined && decodeCiphertext(encryptedEnvironment) === undefined) ||
      (encryptedHeaders !== undefined && decodeCiphertext(encryptedHeaders) === undefined)) return undefined;
    connections.push({
      ...connection,
      ...(encryptedEnvironment === undefined ? {} : { encryptedEnvironment: encryptedEnvironment as string }),
      ...(encryptedHeaders === undefined ? {} : { encryptedHeaders: encryptedHeaders as string }),
    });
  }
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length) return undefined;
  return { schemaVersion: 1, connections };
}

function configuration(connection: CustomMcpConnection): CustomMcpConnection {
  return {
    id: connection.id, name: connection.name, enabled: connection.enabled, transport: connection.transport,
    ...(connection.command === undefined ? {} : { command: connection.command }),
    ...(connection.args === undefined ? {} : { args: [...connection.args] }),
    ...(connection.url === undefined ? {} : { url: connection.url }),
  };
}

function view(connection: StoredConnection): CustomMcpConnectionView {
  return { ...configuration(connection), environmentKeys: [...connection.environmentKeys], headerKeys: [...connection.headerKeys] };
}

function destinationChanged(existing: CustomMcpConnection, next: CustomMcpSave): boolean {
  return existing.transport !== next.transport || existing.url !== next.url || existing.command !== next.command ||
    JSON.stringify(existing.args ?? []) !== JSON.stringify(next.args ?? []);
}

/** Main-process configuration persistence. Secret maps are separate encrypted JSON blobs. */
export class CustomMcpStore {
  private readonly file: string;
  private readonly protector: SecretProtector;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;
  private preservedPath: string | undefined;

  constructor(options: CustomMcpStoreOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The custom MCP store path must be absolute.");
    this.file = options.file;
    this.protector = options.protector;
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
      if ((await fs.stat(this.file)).size > MAX_FILE_BYTES) return this.preserveDamaged();
      contents = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        this.cached = EMPTY_FILE;
        return this.cached;
      }
      throw new CustomMcpStoreError("Your MCP connections could not be read.");
    }
    let parsed: StoredFile | undefined;
    try {
      parsed = Buffer.byteLength(contents) > MAX_FILE_BYTES ? undefined : parseStoredFile(JSON.parse(contents) as unknown);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) return this.preserveDamaged();
    this.cached = parsed;
    return parsed;
  }

  private async preserveDamaged(): Promise<StoredFile> {
    const preserved = `${this.file}.damaged-${Date.now()}-${randomUUID()}`;
    try {
      await fs.rename(this.file, preserved);
    } catch {
      throw new CustomMcpStoreError("Your saved MCP connections are damaged and could not be set aside.");
    }
    this.preservedPath = preserved;
    this.cached = EMPTY_FILE;
    return this.cached;
  }

  private async write(next: StoredFile): Promise<void> {
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new CustomMcpStoreError("Your MCP connections are too large to save.");
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
      throw new CustomMcpStoreError("Your MCP connections could not be saved.");
    }
    this.cached = next;
  }

  private encrypt(secrets: Record<string, string>): string | undefined {
    if (Object.keys(secrets).length === 0) return undefined;
    if (!this.protector.isEncryptionAvailable()) {
      throw new CustomMcpStoreError("This computer has no encrypted storage available, so Roqer cannot keep MCP secrets.");
    }
    let ciphertext: Buffer;
    try {
      ciphertext = this.protector.encryptString(JSON.stringify(secrets));
    } catch {
      throw new CustomMcpStoreError("The MCP secrets could not be encrypted.");
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_ENCRYPTED_BYTES) throw new CustomMcpStoreError("The encrypted MCP secrets are invalid.");
    return ciphertext.toString("base64");
  }

  private decrypt(connection: StoredConnection, kind: "environment" | "headers"): Record<string, string> {
    const encrypted = kind === "environment" ? connection.encryptedEnvironment : connection.encryptedHeaders;
    if (encrypted === undefined) return {};
    if (!this.protector.isEncryptionAvailable()) {
      throw new CustomMcpStoreError("Encrypted storage is unavailable, so the saved MCP secrets cannot be read.");
    }
    try {
      const ciphertext = decodeCiphertext(encrypted);
      if (ciphertext === undefined) throw new Error("invalid ciphertext");
      const secrets = normalizeCustomMcpSecretMap(JSON.parse(this.protector.decryptString(ciphertext)) as unknown, kind);
      const names = kind === "environment" ? connection.environmentKeys : connection.headerKeys;
      if (JSON.stringify(Object.keys(secrets).sort()) !== JSON.stringify([...names].sort())) throw new Error("secret names changed");
      return secrets;
    } catch {
      throw new CustomMcpStoreError(`The secrets saved for ${connection.name} could not be decrypted. Enter them again in Settings.`);
    }
  }

  private resolved(connection: StoredConnection): ResolvedCustomMcpConnection {
    return { connection: configuration(connection), environment: this.decrypt(connection, "environment"), headers: this.decrypt(connection, "headers") };
  }

  /** Path of a damaged original moved aside on this load, reported once. */
  takeDamagedNotice(): string | undefined {
    const preserved = this.preservedPath;
    this.preservedPath = undefined;
    return preserved;
  }

  list(): Promise<CustomMcpConnectionView[]> {
    return this.enqueue(async () => (await this.read()).connections.map(view));
  }

  save(payload: unknown): Promise<CustomMcpConnectionView[]> {
    // Copy the untrusted request before it can be changed while waiting in the write queue.
    let save: CustomMcpSave;
    try {
      save = normalizeCustomMcpSave(payload);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      const current = await this.read();
      const existing = save.id === undefined ? undefined : current.connections.find((connection) => connection.id === save.id);
      if (save.id !== undefined && existing === undefined) throw new CustomMcpStoreError("That MCP connection no longer exists.");
      if (existing === undefined && current.connections.length >= MAX_CUSTOM_MCP_CONNECTIONS) {
        throw new CustomMcpStoreError(`You can have up to ${MAX_CUSTOM_MCP_CONNECTIONS} MCP connections.`);
      }
      if (existing !== undefined && destinationChanged(existing, save) &&
        ((existing.encryptedEnvironment !== undefined && save.environment === undefined) ||
          (existing.encryptedHeaders !== undefined && save.headers === undefined))) {
        throw new CustomMcpStoreError("The MCP destination changed. Enter its secrets again, or clear them, before saving.");
      }
      const encryptedEnvironment = save.environment === undefined ? existing?.encryptedEnvironment : this.encrypt(save.environment ?? {});
      const encryptedHeaders = save.headers === undefined ? existing?.encryptedHeaders : this.encrypt(save.headers ?? {});
      const environmentKeys = save.environment === undefined ? [...(existing?.environmentKeys ?? [])] : Object.keys(save.environment ?? {});
      const headerKeys = save.headers === undefined ? [...(existing?.headerKeys ?? [])] : Object.keys(save.headers ?? {});
      let id = existing?.id;
      if (id === undefined) {
        do { id = `mcp-${randomBytes(4).toString("hex")}`; }
        while (current.connections.some((connection) => connection.id === id));
      }
      const connection: StoredConnection = {
        ...configuration({ ...save, id }), environmentKeys, headerKeys,
        ...(encryptedEnvironment === undefined ? {} : { encryptedEnvironment }),
        ...(encryptedHeaders === undefined ? {} : { encryptedHeaders }),
      };
      const connections = existing === undefined ? [...current.connections, connection] :
        current.connections.map((entry) => entry.id === existing.id ? connection : entry);
      await this.write({ schemaVersion: 1, connections });
      return connections.map(view);
    });
  }

  remove(id: string): Promise<CustomMcpConnectionView[]> {
    return this.enqueue(async () => {
      const current = await this.read();
      const connections = current.connections.filter((connection) => connection.id !== id);
      if (connections.length !== current.connections.length) await this.write({ schemaVersion: 1, connections });
      return connections.map(view);
    });
  }

  /** Disabled connections still resolve so Settings can check them. */
  resolve(id: string): Promise<ResolvedCustomMcpConnection | undefined> {
    return this.enqueue(async () => {
      const connection = (await this.read()).connections.find((entry) => entry.id === id);
      return connection === undefined ? undefined : this.resolved(connection);
    });
  }

  snapshot(): Promise<ResolvedCustomMcpConnection[]> {
    return this.enqueue(async () => (await this.read()).connections.filter((connection) => connection.enabled).map((connection) => this.resolved(connection)));
  }
}
