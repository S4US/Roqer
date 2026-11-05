import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isLedgerAsset, MAX_LEDGER_ASSETS, type LedgerAsset, type LedgerCreator,
} from "../shared/asset-ledger";

/**
 * The asset ledger on disk: one JSON file in Roqer's data folder, written
 * atomically, validated on load, with a damaged file set aside for diagnosis
 * rather than overwritten, and a file a newer Roqer wrote read but never
 * written over.
 */

export class AssetLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetLedgerError";
  }
}

export type AssetLedgerOptions = Readonly<{
  file: string;
  now?: () => Date;
}>;

type StoredFile = Readonly<{ schemaVersion: 1; assets: readonly LedgerAsset[] }>;

/** Generous: five thousand rows of a few hundred bytes. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const EMPTY: StoredFile = { schemaVersion: 1, assets: [] };
/** Files larger than this are not hashed: a hash is for telling uploads apart, and an upload is not this large. */
export const MAX_HASHED_FILE_BYTES = 512 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseStoredFile(value: unknown): StoredFile | "newer" | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) return undefined;
  if ((value.schemaVersion as number) > 1) return "newer";
  if (value.schemaVersion !== 1 || !Array.isArray(value.assets)) return undefined;
  // A row this build cannot read costs the row, never the ledger.
  const assets = value.assets.filter(isLedgerAsset).slice(-MAX_LEDGER_ASSETS);
  return { schemaVersion: 1, assets };
}

/** Where an upload's row matches a later report of it. */
export type LedgerMatch = Readonly<{ operationId?: string; assetId?: string }>;

export type LedgerPatch = Readonly<Partial<Pick<LedgerAsset, "assetId" | "imageId" | "moderationState">>>;

export class AssetLedger {
  private readonly file: string;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;
  private newer = false;
  private preservedPath: string | undefined;

  constructor(options: AssetLedgerOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The asset ledger path must be absolute.");
    this.file = options.file;
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
      throw new AssetLedgerError("Your upload ledger could not be read.");
    }
    let parsed: StoredFile | "newer" | undefined;
    try {
      parsed = parseStoredFile(JSON.parse(contents) as unknown);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) return this.preserveDamaged();
    if (parsed === "newer") {
      // Listed as nothing and never written: a newer Roqer's rows are its own.
      this.newer = true;
      this.cached = EMPTY;
      return this.cached;
    }
    this.cached = parsed;
    return parsed;
  }

  private async preserveDamaged(): Promise<StoredFile> {
    const preserved = `${this.file}.damaged-${this.now().getTime()}-${randomUUID()}`;
    try {
      await fs.rename(this.file, preserved);
    } catch {
      throw new AssetLedgerError("Your upload ledger is damaged and could not be set aside.");
    }
    this.preservedPath = preserved;
    this.cached = EMPTY;
    return this.cached;
  }

  private async write(next: StoredFile): Promise<void> {
    if (this.newer) return;
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
      throw new AssetLedgerError("Your upload ledger could not be saved.");
    }
    this.cached = next;
  }

  /** A one-time note for Settings: where a damaged file went, or that a newer Roqer owns the file. */
  takeNotice(): string | undefined {
    if (this.newer) return "A newer Roqer wrote the upload ledger, so this version lists nothing and adds nothing to it.";
    const preserved = this.preservedPath;
    this.preservedPath = undefined;
    return preserved === undefined ? undefined : `The saved upload ledger was damaged and moved to ${preserved}.`;
  }

  /** Every recorded upload, newest first. */
  list(): Promise<LedgerAsset[]> {
    return this.enqueue(async () => [...(await this.read()).assets].reverse());
  }

  /** Add an upload. A row for the same asset id replaces the earlier one. */
  record(asset: LedgerAsset): Promise<void> {
    return this.enqueue(async () => {
      if (!isLedgerAsset(asset)) throw new AssetLedgerError("That upload record is not valid.");
      const current = await this.read();
      const kept = current.assets.filter((entry) => entry.assetId !== asset.assetId);
      await this.write({ schemaVersion: 1, assets: [...kept, asset].slice(-MAX_LEDGER_ASSETS) });
    });
  }

  /** Fill in what a later report said about an upload: its asset id once processed, its moderation, a Decal's image id. */
  update(match: LedgerMatch, patch: LedgerPatch): Promise<boolean> {
    return this.enqueue(async () => {
      const current = await this.read();
      const index = current.assets.findIndex((entry) =>
        (match.operationId !== undefined && entry.operationId === match.operationId) ||
        (match.assetId !== undefined && entry.assetId === match.assetId));
      if (index < 0) return false;
      const next = { ...current.assets[index], ...stripUndefined(patch) };
      if (!isLedgerAsset(next)) return false;
      const assets = [...current.assets];
      assets[index] = next;
      await this.write({ schemaVersion: 1, assets });
      return true;
    });
  }

  /** The newest upload of exactly these bytes, as this type, by this creator; undefined when there is none. */
  findByHash(sha256: string, assetType: string, creator: LedgerCreator | undefined): Promise<LedgerAsset | undefined> {
    return this.enqueue(async () => {
      const assets = (await this.read()).assets;
      for (let index = assets.length - 1; index >= 0; index -= 1) {
        const entry = assets[index];
        if (entry.sha256 !== sha256 || entry.assetType !== assetType) continue;
        if (!sameCreator(entry.creator, creator)) continue;
        return entry;
      }
      return undefined;
    });
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/** The creator an upload was published as must match: a user's asset is not a group's. Two unknown creators match. */
function sameCreator(a: LedgerCreator | undefined, b: LedgerCreator | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

/** The SHA-256 and size of a file, streamed; undefined for a path that is not a readable file within the bound. */
export async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number } | undefined> {
  if (typeof filePath !== "string" || filePath === "" || !path.isAbsolute(filePath)) return undefined;
  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    info = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size > MAX_HASHED_FILE_BYTES) return undefined;
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  } catch {
    return undefined;
  }
  return { sha256: hash.digest("hex"), bytes: info.size };
}
