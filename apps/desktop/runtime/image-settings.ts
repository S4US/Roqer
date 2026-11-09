import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_IMAGE_BASE_URL, DEFAULT_IMAGE_MODEL, isImageQuality, isImageSourceKind, MAX_IMAGE_KEY_CHARACTERS, MAX_IMAGE_MODEL_CHARS,
  type ImageQuality, type ImageSettingsSave, type ImageSettingsView, type ImageSourceKind, defaultImageBaseUrl, imageSourceLabel, imageSourceNeedsKey,
} from "../shared/image-generation";
import type { SecretProtector } from "./secret-protector";

/**
 * The image tool's settings, kept by the main process: whether it is on,
 * which server and model answer, and the key, encrypted with the operating
 * system's store before it touches disk and decrypted only to make a request.
 * The renderer is told only whether a key is saved. A file that does not
 * validate is moved aside for diagnosis rather than overwritten.
 */

export class ImageSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageSettingsError";
  }
}

export type ImageSettingsOptions = Readonly<{
  file: string;
  protector: SecretProtector;
  now?: () => Date;
}>;

type StoredFile = Readonly<{
  schemaVersion: 1;
  enabled: boolean;
  source: ImageSourceKind;
  baseUrl: string;
  model: string;
  quality: ImageQuality;
  encryptedApiKey?: string;
}>;

/** The settings with the key decrypted, for one request. */
export type ImageSourceSettings = Readonly<{
  source: ImageSourceKind;
  baseUrl: string;
  model: string;
  quality: ImageQuality;
  apiKey: string | null;
}>;

const MAX_FILE_BYTES = 32 * 1_024;
const MAX_ENCRYPTED_BYTES = 12 * 1_024;
const EMPTY: StoredFile = { schemaVersion: 1, enabled: false, source: "openai", baseUrl: DEFAULT_IMAGE_BASE_URL, model: DEFAULT_IMAGE_MODEL, quality: "medium" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeCiphertext(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCRYPTED_BYTES * 2) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > MAX_ENCRYPTED_BYTES || decoded.toString("base64") !== value) return undefined;
  return decoded;
}

/** An http(s) address with a path and no query, as OpenAI-shaped servers are reached. */
export function normalizeImageBaseUrl(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return undefined;
  return trimmed;
}

function parseStoredFile(value: unknown): StoredFile | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (typeof value.enabled !== "boolean" || !isImageSourceKind(value.source) || !isImageQuality(value.quality)) return undefined;
  if (typeof value.baseUrl !== "string" || normalizeImageBaseUrl(value.baseUrl) !== value.baseUrl) return undefined;
  if (typeof value.model !== "string" || value.model === "" || value.model.length > MAX_IMAGE_MODEL_CHARS) return undefined;
  if (value.encryptedApiKey !== undefined && decodeCiphertext(value.encryptedApiKey) === undefined) return undefined;
  return {
    schemaVersion: 1, enabled: value.enabled, source: value.source, baseUrl: value.baseUrl, model: value.model, quality: value.quality,
    ...(value.encryptedApiKey === undefined ? {} : { encryptedApiKey: value.encryptedApiKey as string }),
  };
}

function view(file: StoredFile, damagedNotice?: string): ImageSettingsView {
  const hasKey = file.encryptedApiKey !== undefined;
  const needsKey = imageSourceNeedsKey(file.source) && !hasKey;
  const state = needsKey ? "missing" : file.enabled ? "ready" : "off";
  const where = file.source === "openai-compatible" ? `the server at ${file.baseUrl}` : imageSourceLabel(file.source);
  const message = state === "missing"
    ? `${imageSourceLabel(file.source)} needs an API key${file.source === "openai" ? " with image access" : ""}; save one to turn the tool on.`
    : state === "ready"
      ? `On: the agent can ask ${where} for images with ${file.model}, after an approval outside Full auto.`
      : `Off. When on, the agent can ask ${where} for images with ${file.model}.`;
  return {
    enabled: file.enabled && !needsKey, source: file.source, baseUrl: file.baseUrl, model: file.model, hasKey, quality: file.quality, state, message,
    ...(damagedNotice === undefined ? {} : { damagedNotice }),
  };
}

export class ImageSettings {
  private readonly file: string;
  private readonly protector: SecretProtector;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;
  private preservedPath: string | undefined;

  constructor(options: ImageSettingsOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The image settings path must be absolute.");
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
      throw new ImageSettingsError("Your image settings could not be read.");
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
      throw new ImageSettingsError("Your saved image settings are damaged and could not be set aside.");
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
      throw new ImageSettingsError("Your image settings could not be saved.");
    }
    this.cached = next;
  }

  private encrypt(apiKey: string): string {
    const key = apiKey.trim();
    if (key === "" || key.length > MAX_IMAGE_KEY_CHARACTERS || !/^[\x21-\x7e]+$/.test(key)) {
      throw new ImageSettingsError("That is not a valid API key.");
    }
    if (!this.protector.isEncryptionAvailable()) {
      throw new ImageSettingsError("This computer has no encrypted storage available, so Roqer cannot keep an image API key.");
    }
    let ciphertext: Buffer;
    try {
      ciphertext = this.protector.encryptString(key);
    } catch {
      throw new ImageSettingsError("The API key could not be encrypted.");
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_ENCRYPTED_BYTES) throw new ImageSettingsError("The encrypted API key is invalid.");
    return ciphertext.toString("base64");
  }

  /** Where a damaged file was moved on this load, once; later calls return undefined. */
  takeDamagedNotice(): string | undefined {
    const preserved = this.preservedPath;
    this.preservedPath = undefined;
    return preserved;
  }

  get(): Promise<ImageSettingsView> {
    return this.enqueue(async () => view(await this.read()));
  }

  save(save: ImageSettingsSave): Promise<ImageSettingsView> {
    return this.enqueue(async () => {
      const current = await this.read();
      const source = save.source ?? current.source;
      // A change of source without an address takes the new source's own
      // address; a compatible server keeps whatever was there to edit.
      const rawBaseUrl = save.baseUrl ?? (save.source !== undefined && save.source !== current.source
        ? (defaultImageBaseUrl(source) ?? current.baseUrl)
        : current.baseUrl);
      const baseUrl = normalizeImageBaseUrl(rawBaseUrl);
      if (baseUrl === undefined) throw new ImageSettingsError("The server address must be an http or https address, such as https://api.openai.com/v1.");
      const model = (save.model ?? current.model).trim();
      if (model === "" || model.length > MAX_IMAGE_MODEL_CHARS) throw new ImageSettingsError("Name the image model, such as gpt-image-1.");
      const encryptedApiKey = save.apiKey === undefined
        ? current.encryptedApiKey
        : save.apiKey === null ? undefined : this.encrypt(save.apiKey);
      const next: StoredFile = {
        schemaVersion: 1,
        enabled: save.enabled ?? current.enabled,
        source,
        baseUrl,
        model,
        quality: save.quality ?? current.quality,
        ...(encryptedApiKey === undefined ? {} : { encryptedApiKey }),
      };
      await this.write(next);
      return view(next);
    });
  }

  /** The settings with the key decrypted. `apiKey` is null when none is saved. */
  resolved(): Promise<ImageSourceSettings> {
    return this.enqueue(async () => {
      const current = await this.read();
      let apiKey: string | null = null;
      if (current.encryptedApiKey !== undefined) {
        const ciphertext = decodeCiphertext(current.encryptedApiKey);
        if (ciphertext === undefined) throw new ImageSettingsError("The saved API key is damaged; enter it again.");
        try {
          apiKey = this.protector.decryptString(ciphertext);
        } catch {
          throw new ImageSettingsError("The saved API key could not be decrypted; enter it again.");
        }
      }
      return { source: current.source, baseUrl: current.baseUrl, model: current.model, quality: current.quality, apiKey };
    });
  }

  /** The source to call, when the tool is on and can be called; otherwise undefined. */
  async ready(): Promise<ImageSourceSettings | undefined> {
    const current = await this.get();
    if (current.state !== "ready") return undefined;
    return this.resolved();
  }
}
