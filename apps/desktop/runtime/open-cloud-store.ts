import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isOpenCloudCreator,
  MAX_OPEN_CLOUD_KEY_CHARACTERS,
  normalizeOpenCloudKey,
  type OpenCloudCreator,
  type OpenCloudSave,
} from "../shared/open-cloud";
import type { SecretProtector } from "./secret-protector";

/**
 * The user's Roblox Open Cloud key and creator, kept by the main process.
 *
 * One small file beside the workspace, written atomically. The key is
 * encrypted with the operating system's store before it touches disk and is
 * decrypted only to start the Studio bridge or to check the key with Roblox;
 * the renderer is told only whether one is saved. A file that does not
 * validate is moved aside for diagnosis rather than overwritten.
 */

export class OpenCloudStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCloudStoreError";
  }
}

export type OpenCloudStoreOptions = Readonly<{
  file: string;
  protector: SecretProtector;
  now?: () => Date;
}>;

type StoredFile = Readonly<{ schemaVersion: 1; creator: OpenCloudCreator | null; encryptedApiKey?: string }>;

/** What Settings may show: never the key. */
export type OpenCloudStored = Readonly<{ hasKey: boolean; creator: OpenCloudCreator | null }>;

/** The settings with the key decrypted, for the bridge's environment or one check. */
export type OpenCloudResolved = Readonly<{ apiKey: string | null; creator: OpenCloudCreator | null }>;

const MAX_FILE_BYTES = 32 * 1_024;
const MAX_ENCRYPTED_BYTES = 12 * 1_024;
const EMPTY: StoredFile = { schemaVersion: 1, creator: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeCiphertext(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCRYPTED_BYTES * 2) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > MAX_ENCRYPTED_BYTES || decoded.toString("base64") !== value) return undefined;
  return decoded;
}

function parseStoredFile(value: unknown): StoredFile | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (Object.keys(value).some((key) => !["schemaVersion", "creator", "encryptedApiKey"].includes(key))) return undefined;
  if (value.creator !== null && !isOpenCloudCreator(value.creator)) return undefined;
  if (value.encryptedApiKey !== undefined && decodeCiphertext(value.encryptedApiKey) === undefined) return undefined;
  return {
    schemaVersion: 1,
    creator: value.creator === null ? null : { kind: value.creator.kind, id: value.creator.id },
    ...(value.encryptedApiKey === undefined ? {} : { encryptedApiKey: value.encryptedApiKey as string }),
  };
}

const stored = (file: StoredFile): OpenCloudStored => ({ hasKey: file.encryptedApiKey !== undefined, creator: file.creator });

export class OpenCloudStore {
  private readonly file: string;
  private readonly protector: SecretProtector;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;
  private preservedPath: string | undefined;

  constructor(options: OpenCloudStoreOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The Open Cloud settings path must be absolute.");
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
        this.cached = EMPTY;
        return this.cached;
      }
      throw new OpenCloudStoreError("Your Open Cloud settings could not be read.");
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
      throw new OpenCloudStoreError("Your saved Open Cloud settings are damaged and could not be set aside.");
    }
    this.preservedPath = preserved;
    this.cached = EMPTY;
    return this.cached;
  }

  private async write(next: StoredFile): Promise<void> {
    const contents = `${JSON.stringify(next, null, 2)}\n`;
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
      throw new OpenCloudStoreError("Your Open Cloud settings could not be saved.");
    }
    this.cached = next;
  }

  private encrypt(apiKey: string): string {
    const key = normalizeOpenCloudKey(apiKey);
    if (key === undefined || key.length > MAX_OPEN_CLOUD_KEY_CHARACTERS) {
      throw new OpenCloudStoreError("That is not a valid Open Cloud API key.");
    }
    if (!this.protector.isEncryptionAvailable()) {
      throw new OpenCloudStoreError(
        "This computer has no encrypted storage available, so Roqer cannot keep an Open Cloud key.",
      );
    }
    let ciphertext: Buffer;
    try {
      ciphertext = this.protector.encryptString(key);
    } catch {
      throw new OpenCloudStoreError("The Open Cloud key could not be encrypted.");
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_ENCRYPTED_BYTES) {
      throw new OpenCloudStoreError("The encrypted Open Cloud key is invalid.");
    }
    return ciphertext.toString("base64");
  }

  /** Where a damaged file was moved on this load, once; later calls return undefined. */
  takeDamagedNotice(): string | undefined {
    const preserved = this.preservedPath;
    this.preservedPath = undefined;
    return preserved;
  }

  get(): Promise<OpenCloudStored> {
    return this.enqueue(async () => stored(await this.read()));
  }

  save(save: OpenCloudSave): Promise<OpenCloudStored> {
    return this.enqueue(async () => {
      const current = await this.read();
      const encryptedApiKey = save.apiKey === undefined
        ? current.encryptedApiKey
        : save.apiKey === null ? undefined : this.encrypt(save.apiKey);
      const next: StoredFile = {
        schemaVersion: 1,
        creator: save.creator,
        ...(encryptedApiKey === undefined ? {} : { encryptedApiKey }),
      };
      await this.write(next);
      return stored(next);
    });
  }

  /** The settings with the key decrypted. `apiKey` is null when none is saved. */
  resolve(): Promise<OpenCloudResolved> {
    return this.enqueue(async () => {
      const current = await this.read();
      if (current.encryptedApiKey === undefined) return { apiKey: null, creator: current.creator };
      if (!this.protector.isEncryptionAvailable()) {
        throw new OpenCloudStoreError("Encrypted storage is unavailable, so the saved Open Cloud key cannot be read.");
      }
      const ciphertext = decodeCiphertext(current.encryptedApiKey);
      try {
        if (ciphertext === undefined) throw new Error("undecodable");
        return { apiKey: this.protector.decryptString(ciphertext), creator: current.creator };
      } catch {
        throw new OpenCloudStoreError("The saved Open Cloud key could not be decrypted. Enter it again in Settings.");
      }
    });
  }
}
