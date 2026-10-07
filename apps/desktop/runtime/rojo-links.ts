import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isPlaceInstanceId } from "../shared/rojo";

/**
 * Which Rojo projects are linked to which published places, and which project
 * files were used recently.
 *
 * Modeled on `BlenderSettings`: one small JSON file in the app's data folder,
 * atomic temp-file-and-rename writes at mode 0o600, read with a size cap and
 * full shape validation. Unlike Blender's switch-and-a-path, a hand-edited or
 * truncated links file is not something to silently discard in place -- it is
 * renamed aside to `<file>.damaged-<timestamp>` so the broken copy survives
 * for a bug report, and the store continues from empty.
 *
 * Only `place:<id>` ids are ever written here: an unpublished `anon:<uuid>`
 * place's link lives only in `RojoConnection`'s memory for the Studio session.
 */

export type RojoLink = Readonly<{ instanceId: string; projectFile: string; linkedAt: string }>;
export type RojoLinksSnapshot = Readonly<{ links: readonly RojoLink[]; recent: readonly string[] }>;

const MAX_LINKS = 200;
const MAX_RECENT = 5;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 4_096;

type StoredFile = Readonly<{ version: 1; links: readonly RojoLink[]; recent: readonly string[] }>;

const EMPTY: StoredFile = { version: 1, links: [], recent: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH;
}

function parseLink(value: unknown): RojoLink | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.instanceId !== "string" || !isPlaceInstanceId(value.instanceId)) return undefined;
  if (!isProjectFilePath(value.projectFile)) return undefined;
  if (typeof value.linkedAt !== "string" || Number.isNaN(Date.parse(value.linkedAt))) return undefined;
  return { instanceId: value.instanceId, projectFile: value.projectFile, linkedAt: value.linkedAt };
}

/** Undefined means the file is damaged: wrong shape, wrong version, or an entry that does not parse. */
function parseStored(value: unknown): StoredFile | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1 || !Array.isArray(value.links) || !Array.isArray(value.recent)) return undefined;
  const links: RojoLink[] = [];
  for (const entry of value.links) {
    const parsed = parseLink(entry);
    if (parsed === undefined) return undefined;
    links.push(parsed);
  }
  const recent: string[] = [];
  for (const entry of value.recent) {
    if (!isProjectFilePath(entry)) return undefined;
    recent.push(entry);
  }
  // A hand-edited file that is otherwise well-formed but over the limits is
  // trimmed rather than treated as damaged -- the newest entries are kept.
  return { version: 1, links: links.slice(-MAX_LINKS), recent: recent.slice(0, MAX_RECENT) };
}

export type RojoLinksStoreOptions = Readonly<{ file: string }>;

export class RojoLinksStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;

  constructor(options: RojoLinksStoreOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The Rojo links path must be absolute.");
    this.file = options.file;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async setAside(): Promise<void> {
    const target = `${this.file}.damaged-${Date.now()}`;
    await fs.rename(this.file, target);
  }

  private async read(): Promise<StoredFile> {
    if (this.cached !== undefined) return this.cached;
    let parsed: StoredFile | undefined;
    try {
      const details = await fs.stat(this.file);
      if (details.size <= MAX_FILE_BYTES) {
        parsed = parseStored(JSON.parse(await fs.readFile(this.file, "utf8")) as unknown);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        this.cached = EMPTY;
        return this.cached;
      }
      parsed = undefined;
    }
    if (parsed === undefined) {
      // Keeps the broken file around (best effort) instead of losing it, but
      // never lets a rename failure stop the store from starting fresh.
      await this.setAside().catch(() => undefined);
      this.cached = EMPTY;
      return this.cached;
    }
    this.cached = parsed;
    return this.cached;
  }

  private async write(next: StoredFile): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.file);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("The Rojo links could not be saved.");
    }
    this.cached = next;
  }

  get(): Promise<RojoLinksSnapshot> {
    return this.enqueue(async () => {
      const current = await this.read();
      return { links: current.links, recent: current.recent };
    });
  }

  /** A no-op for an unpublished (`anon:<uuid>`) instance id: only published places are remembered. */
  remember(instanceId: string, projectFile: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isPlaceInstanceId(instanceId) || !isProjectFilePath(projectFile)) return;
      const current = await this.read();
      const linkedAt = new Date().toISOString();
      // Core refuses to link one project to two places, so an earlier entry
      // for this project under a *different* instance is already stale --
      // drop it too, or the store would claim two places hold the same link.
      const links = [
        ...current.links.filter((link) => link.instanceId !== instanceId && link.projectFile !== projectFile),
        { instanceId, projectFile, linkedAt },
      ].slice(-MAX_LINKS);
      await this.write({ version: 1, links, recent: current.recent });
    });
  }

  /** Removing a link that is not there is not an error -- the end state is the same. */
  forget(instanceId: string): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.read();
      const links = current.links.filter((link) => link.instanceId !== instanceId);
      if (links.length === current.links.length) return;
      await this.write({ version: 1, links, recent: current.recent });
    });
  }

  /** Moves `projectFile` to the front of the recent list, deduplicated, capped at 5. */
  touchRecent(projectFile: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isProjectFilePath(projectFile)) return;
      const current = await this.read();
      const recent = [projectFile, ...current.recent.filter((entry) => entry !== projectFile)].slice(0, MAX_RECENT);
      await this.write({ version: 1, links: current.links, recent });
    });
  }
}
