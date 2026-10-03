import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isClipId,
  MAX_CLIP_FRAMES,
  selectionProblem,
  type ClipSelection,
} from "../shared/reference-clip";
import type { ClipAnalysis, ClipPhase, CropBox } from "./clip-analysis";

/**
 * The frames Roqer read from each reference clip, kept on disk with the chat.
 *
 * A clip is read once, when the user chooses the part to send, and the frames
 * go into `pending/` under a fresh id. The run that sends it moves them into
 * its chat's folder, where every later run in the chat can look at them again
 * (`reference_clip`, and `capture_moments` comparing against them); the
 * original video is never needed after that, and is never copied.
 *
 * Like Blender's job folders, clips are kept by age rather than by reference:
 * they are working material for the agent, and the chat itself keeps its own
 * small preview. A clip unused for `CLIP_RETENTION_MS`, or past the newest
 * `MAX_KEPT_CLIPS`, is cleared, and a run that asks for it is told so. A chat's
 * folder is named by a hash of the chat's id, so it carries no id of its own.
 *
 * Every name inside the store is Roqer's own: ids are checked against their
 * pattern before they touch a path, and a frame's file is named by its place.
 */

export const CLIP_DIRECTORY = "reference-clips";
export const CLIP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_KEPT_CLIPS = 40;
/** How long frames read for a message that was never sent are kept. */
export const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;

const PENDING = "pending";
const MANIFEST = "manifest.json";
const SCOPE_PATTERN = /^[0-9a-f]{32}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
/** A stored frame's largest size: a 1280-pixel JPEG is far below it. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** The folder name for a chat's clips. */
export function clipScope(chatId: string): string {
  return createHash("sha256").update(`reference-clips:${chatId}`).digest("hex").slice(0, 32);
}

/** What the store keeps about one clip beside its frames. */
export type ClipManifest = Readonly<{
  version: 1;
  id: string;
  /** The attached file's name, as the user named it: data, never instructions. */
  name: string;
  /** The whole clip's length, in seconds. */
  duration: number;
  /** The stored frames' size, in pixels. */
  width: number;
  height: number;
  selection: ClipSelection;
  /** Each stored frame's time in the clip, ascending; frame `i` is file `frameFileName(i)`. */
  frames: readonly number[];
  analysis: ClipAnalysis;
  createdAt: string;
}>;

export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(3, "0")}.jpg`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isOptionalTime = (value: unknown) => value === undefined || isFiniteNumber(value);
const HEX_COLOR = /^#[0-9A-F]{6}$/;

function isCropBox(value: unknown): value is CropBox {
  if (!isRecord(value)) return false;
  const { x, y, width, height } = value;
  return [x, y, width, height].every((part) => isFiniteNumber(part) && part >= 0 && part <= 1) &&
    (width as number) > 0 && (height as number) > 0;
}

function isPhase(value: unknown): value is ClipPhase {
  return isRecord(value) &&
    (value.name === "build-up" || value.name === "peak" || value.name === "fade") &&
    isFiniteNumber(value.from) && isFiniteNumber(value.to) &&
    Array.isArray(value.colors) && value.colors.length <= 8 &&
    value.colors.every((color) => isRecord(color) && typeof color.hex === "string" && HEX_COLOR.test(color.hex) && isFiniteNumber(color.share));
}

/** An analysis as a manifest holds it: the shape `analyseClip` returns, checked. */
export function isClipAnalysis(value: unknown): value is ClipAnalysis {
  if (!isRecord(value) || typeof value.active !== "boolean" || typeof value.cameraMoves !== "boolean") return false;
  if (![value.onset, value.peak, value.half, value.end].every(isOptionalTime)) return false;
  if (value.brightness !== undefined && !(isRecord(value.brightness) && [value.brightness.time, value.brightness.level, value.brightness.before].every(isFiniteNumber))) return false;
  if (value.area !== undefined && !(isRecord(value.area) && [value.area.largest, value.area.time, value.area.atOnset].every(isFiniteNumber))) return false;
  if (value.crop !== undefined && !isCropBox(value.crop)) return false;
  return Array.isArray(value.phases) && value.phases.length <= 3 && value.phases.every(isPhase);
}

export function isClipManifest(value: unknown): value is ClipManifest {
  if (!isRecord(value) || value.version !== 1 || !isClipId(value.id)) return false;
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 260) return false;
  if (!isFiniteNumber(value.duration) || value.duration <= 0) return false;
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || (value.width as number) < 1 || (value.height as number) < 1) return false;
  if (selectionProblem(value.selection, value.duration) !== undefined) return false;
  const frames = value.frames;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_CLIP_FRAMES) return false;
  if (!frames.every((time, index) => isFiniteNumber(time) && (index === 0 || time > (frames[index - 1] as number)))) return false;
  return isClipAnalysis(value.analysis) && typeof value.createdAt === "string";
}

/** A clip to store: its manifest less what the store assigns, and its frames as JPEG bytes. */
export type NewClip = Readonly<{
  name: string;
  duration: number;
  width: number;
  height: number;
  selection: ClipSelection;
  frames: readonly Readonly<{ time: number; jpeg: Buffer }>[];
  analysis: ClipAnalysis;
}>;

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export class ClipStore {
  readonly directory: string;
  readonly #now: () => number;

  constructor(root: string, now: () => number = Date.now) {
    this.directory = path.join(root, CLIP_DIRECTORY);
    this.#now = now;
  }

  #pending(id: string): string {
    if (!isClipId(id)) throw new Error("That is not a clip id.");
    return path.join(this.directory, PENDING, id);
  }

  #scoped(scope: string, id?: string): string {
    if (!SCOPE_PATTERN.test(scope)) throw new Error("That is not a chat's clip folder.");
    if (id === undefined) return path.join(this.directory, scope);
    if (!isClipId(id)) throw new Error("That is not a clip id.");
    return path.join(this.directory, scope, id);
  }

  /**
   * Store a clip's frames under a fresh id, not yet in any chat. Written into
   * a temporary folder and renamed, so a half-written clip never has an id.
   */
  async createPending(clip: NewClip): Promise<ClipManifest> {
    const id = randomBytes(6).toString("hex");
    const manifest: ClipManifest = {
      version: 1,
      id,
      name: clip.name,
      duration: clip.duration,
      width: clip.width,
      height: clip.height,
      selection: clip.selection,
      frames: clip.frames.map((frame) => frame.time),
      analysis: clip.analysis,
      createdAt: new Date(this.#now()).toISOString(),
    };
    if (!isClipManifest(manifest)) throw new Error("The clip's frames could not be stored: its description was not valid.");
    if (!clip.frames.every((frame) => isJpeg(frame.jpeg) && frame.jpeg.length <= MAX_FRAME_BYTES)) {
      throw new Error("The clip's frames could not be stored: a frame was not a JPEG.");
    }
    const target = this.#pending(id);
    const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.mkdir(temporary, { recursive: true });
    try {
      for (const [index, frame] of clip.frames.entries()) {
        await fs.writeFile(path.join(temporary, frameFileName(index)), frame.jpeg);
      }
      await fs.writeFile(path.join(temporary, MANIFEST), JSON.stringify(manifest), "utf8");
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return manifest;
  }

  /** Forget frames read for a message that will not be sent. */
  async discardPending(id: string): Promise<void> {
    if (!isClipId(id)) return;
    await fs.rm(this.#pending(id), { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Move a pending clip into a chat. Adopting a clip the chat already holds is
   * not an error, so a run that starts twice from one message is harmless.
   */
  async adopt(id: string, scope: string): Promise<ClipManifest> {
    const target = this.#scoped(scope, id);
    const existing = await this.#readManifest(target);
    if (existing === undefined) {
      await fs.mkdir(this.#scoped(scope), { recursive: true });
      try {
        await fs.rename(this.#pending(id), target);
      } catch {
        throw new Error("The clip's frames are gone. Remove the clip and attach it again.");
      }
    }
    await this.#touch(target);
    const manifest = existing ?? await this.#readManifest(target);
    if (manifest === undefined) throw new Error("The clip's frames are damaged. Remove the clip and attach it again.");
    return manifest;
  }

  /** The clips a chat holds, newest first. */
  async list(scope: string): Promise<ClipManifest[]> {
    const folder = this.#scoped(scope);
    const names = await fs.readdir(folder).catch(() => [] as string[]);
    const manifests: { manifest: ClipManifest; modified: number }[] = [];
    for (const name of names.filter((entry) => isClipId(entry))) {
      const directory = path.join(folder, name);
      const manifest = await this.#readManifest(directory);
      if (manifest === undefined || manifest.id !== name) continue;
      const modified = (await fs.stat(directory).catch(() => undefined))?.mtimeMs ?? 0;
      manifests.push({ manifest, modified });
    }
    return manifests.sort((a, b) => b.modified - a.modified).map((entry) => entry.manifest);
  }

  /** One of a chat's clips, marked as used; undefined when it is not there. */
  async read(scope: string, id: string): Promise<ClipManifest | undefined> {
    if (!isClipId(id)) return undefined;
    const directory = this.#scoped(scope, id);
    const manifest = await this.#readManifest(directory);
    if (manifest === undefined || manifest.id !== id) return undefined;
    await this.#touch(directory);
    return manifest;
  }

  /** A pending clip's manifest, for a run about to adopt it. */
  async readPending(id: string): Promise<ClipManifest | undefined> {
    if (!isClipId(id)) return undefined;
    const manifest = await this.#readManifest(this.#pending(id));
    return manifest?.id === id ? manifest : undefined;
  }

  /** One stored frame's JPEG bytes. */
  async frame(scope: string, manifest: ClipManifest, index: number): Promise<Buffer> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.frames.length) throw new Error("That frame is not in the clip.");
    const bytes = await fs.readFile(path.join(this.#scoped(scope, manifest.id), frameFileName(index)));
    if (!isJpeg(bytes) || bytes.length > MAX_FRAME_BYTES) throw new Error("A stored frame of the clip is damaged.");
    return bytes;
  }

  /** A pending clip's frame, for the attachment's own sheets before the run adopts it. */
  async pendingFrame(manifest: ClipManifest, index: number): Promise<Buffer> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.frames.length) throw new Error("That frame is not in the clip.");
    const bytes = await fs.readFile(path.join(this.#pending(manifest.id), frameFileName(index)));
    if (!isJpeg(bytes) || bytes.length > MAX_FRAME_BYTES) throw new Error("A stored frame of the clip is damaged.");
    return bytes;
  }

  /**
   * Clear what has expired: pending clips a day old, kept clips unused for
   * `CLIP_RETENTION_MS`, and the oldest past `MAX_KEPT_CLIPS`, then any chat
   * folder left empty. Failures are skipped, to be tried again next time.
   */
  async prune(): Promise<void> {
    const now = this.#now();
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    const kept: { directory: string; modified: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(this.directory, entry.name);
      if (entry.name === PENDING) {
        for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
          const directory = path.join(folder, name);
          const modified = (await fs.stat(directory).catch(() => undefined))?.mtimeMs ?? 0;
          if (modified < now - PENDING_RETENTION_MS) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        continue;
      }
      if (!SCOPE_PATTERN.test(entry.name)) continue;
      for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
        const directory = path.join(folder, name);
        const modified = (await fs.stat(directory).catch(() => undefined))?.mtimeMs ?? 0;
        if (!isClipId(name) || modified < now - CLIP_RETENTION_MS) {
          await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        } else {
          kept.push({ directory, modified });
        }
      }
    }
    kept.sort((a, b) => b.modified - a.modified);
    for (const { directory } of kept.slice(MAX_KEPT_CLIPS)) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SCOPE_PATTERN.test(entry.name)) continue;
      const folder = path.join(this.directory, entry.name);
      if ((await fs.readdir(folder).catch(() => ["?"])).length === 0) await fs.rmdir(folder).catch(() => undefined);
    }
  }

  async #readManifest(directory: string): Promise<ClipManifest | undefined> {
    try {
      const file = path.join(directory, MANIFEST);
      const stat = await fs.stat(file);
      if (stat.size > MAX_MANIFEST_BYTES) return undefined;
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      return isClipManifest(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async #touch(directory: string): Promise<void> {
    const now = new Date(this.#now());
    await fs.utimes(directory, now, now).catch(() => undefined);
  }
}
