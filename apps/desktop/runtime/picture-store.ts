import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvidencePictureResult } from "../shared/evidence-picture";
import {
  isEvidenceImage, isEvidencePictureRef, MAX_EVIDENCE_IMAGE_CHARACTERS, type RunEvidence,
} from "../shared/run-events";

/**
 * The picture store: every saved run's previews, as files beside the chats.
 *
 * A preview used to live inside its chat's file, as a data URL. Every save
 * rewrote it, every load parsed it, and the chat file's own bound meant a run
 * could keep only a handful. Here each picture is one file, named by the
 * SHA-256 of its bytes, and the chat keeps only that name. The same picture is
 * stored once, a file is never rewritten, and what is read back is checked to
 * be what was stored.
 *
 * Nothing expires by age, as a chat's history should not. A picture goes when
 * no chat refers to it any more — its chat was deleted — and it is neither
 * held by a run still going nor newer than a short grace, which covers the
 * moment between a run ending and the chat that records it being saved.
 */

export const PICTURE_DIRECTORY = "workspace-pictures";

/** How long an unreferenced picture is kept anyway, for a run that has not been saved yet. */
export const PICTURE_GRACE_MS = 10 * 60 * 1000;

/** A stored picture's bytes: what the largest data URL a run may carry decodes to. */
const MAX_PICTURE_BYTES = Math.ceil(MAX_EVIDENCE_IMAGE_CHARACTERS * 3 / 4);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TEMPORARY = /^[0-9a-f]{64}\.(jpg|png)\.[^.]+\.tmp$/;

type PictureType = "jpg" | "png";

function pictureType(bytes: Uint8Array): PictureType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "png";
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dataUrl(type: PictureType, bytes: Uint8Array): string {
  return `data:image/${type === "png" ? "png" : "jpeg"};base64,${Buffer.from(bytes).toString("base64")}`;
}

export class PictureStore {
  readonly directory: string;
  readonly #now: () => number;
  /** Refs a run still going has stored, counted, so two runs can hold one picture. */
  readonly #held = new Map<string, number>();

  constructor(root: string, now: () => number = Date.now) {
    this.directory = join(root, PICTURE_DIRECTORY);
    this.#now = now;
  }

  /**
   * Store a preview and return its ref; undefined when it is not a bounded PNG
   * or JPEG data URL, or the file could not be written. Storing a picture that
   * is already there only marks it fresh, so a clean-up running at the same
   * moment keeps it.
   */
  async put(url: string): Promise<string | undefined> {
    if (!isEvidenceImage(url)) return undefined;
    const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    const type = pictureType(bytes);
    if (type === undefined || bytes.length > MAX_PICTURE_BYTES) return undefined;
    const ref = `${sha256(bytes)}.${type}`;
    const path = join(this.directory, ref);
    try {
      if ((await this.read(ref)).ok) {
        const moment = new Date(this.#now());
        await utimes(path, moment, moment);
        return ref;
      }
      await mkdir(this.directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return ref;
    } catch {
      return undefined;
    }
  }

  /**
   * A stored picture, read afresh and checked: a file (never a link), no larger
   * than a preview may be, of the type its name says, whose bytes hash to its
   * name. The ref is the only thing that picks the file.
   */
  async read(ref: unknown): Promise<EvidencePictureResult> {
    if (!isEvidencePictureRef(ref)) return { ok: false, reason: "invalid" };
    const path = join(this.directory, ref);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return { ok: false, reason: "missing" };
    if (!info.isFile() || info.size > MAX_PICTURE_BYTES) return { ok: false, reason: "invalid" };
    const bytes = await readFile(path).catch(() => undefined);
    if (bytes === undefined) return { ok: false, reason: "missing" };
    const type = pictureType(bytes);
    if (type === undefined || `${sha256(bytes)}.${type}` !== ref) return { ok: false, reason: "invalid" };
    const url = dataUrl(type, bytes);
    return isEvidenceImage(url) ? { ok: true, dataUrl: url } : { ok: false, reason: "invalid" };
  }

  /** Keep these pictures through any clean-up until they are released: a run is still going. */
  hold(refs: Iterable<string>): void {
    for (const ref of refs) this.#held.set(ref, (this.#held.get(ref) ?? 0) + 1);
  }

  release(refs: Iterable<string>): void {
    for (const ref of refs) {
      const count = (this.#held.get(ref) ?? 0) - 1;
      if (count > 0) this.#held.set(ref, count);
      else this.#held.delete(ref);
    }
  }

  /**
   * Remove every stored picture no chat refers to, unless a run holds it or it
   * is newer than the grace; and any write left half-done. Returns how many
   * pictures it removed. Failing to remove one is left for the next time.
   */
  async collect(referenced: ReadonlySet<string>): Promise<number> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const cutoff = this.#now() - PICTURE_GRACE_MS;
    let removed = 0;
    for (const name of names) {
      const picture = isEvidencePictureRef(name);
      if (!picture && !TEMPORARY.test(name)) continue;
      if (picture && (referenced.has(name) || this.#held.has(name))) continue;
      const path = join(this.directory, name);
      const info = await lstat(path).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.mtimeMs >= cutoff) continue;
      try {
        await unlink(path);
        if (picture) removed += 1;
      } catch { /* Left for the next clean-up. */ }
    }
    return removed;
  }
}

/** Every chat's runs' evidence, in a workspace shaped like a saved one. */
type EvidenceHolder = { projects: ReadonlyArray<{ chats: ReadonlyArray<{ messages: ReadonlyArray<{ run?: { evidence: readonly RunEvidence[] } }> }> }> };

/** The pictures a workspace's chats refer to. */
export function pictureRefs(state: EvidenceHolder): Set<string> {
  const refs = new Set<string>();
  for (const project of state.projects) for (const chat of project.chats) for (const message of chat.messages) {
    for (const evidence of message.run?.evidence ?? []) if (isEvidencePictureRef(evidence.imageRef)) refs.add(evidence.imageRef);
  }
  return refs;
}

/**
 * Rewrite every saved run's evidence through `change`, sharing every object it
 * leaves alone, so an unchanged chat stays the same object and encodes the same.
 */
async function mapEvidence<T extends EvidenceHolder>(
  state: T,
  change: (evidence: RunEvidence) => Promise<RunEvidence>,
): Promise<T> {
  let changed = false;
  const projects = [];
  for (const project of state.projects) {
    const chats = [];
    for (const chat of project.chats) {
      const messages = [];
      for (const message of chat.messages) {
        const run = message.run;
        if (run === undefined) { messages.push(message); continue; }
        const evidence = [];
        let runChanged = false;
        for (const item of run.evidence) {
          const next = await change(item);
          runChanged ||= next !== item;
          evidence.push(next);
        }
        changed ||= runChanged;
        messages.push(runChanged ? { ...message, run: { ...run, evidence } } : message);
      }
      chats.push(messages.every((message, index) => message === chat.messages[index]) ? chat : { ...chat, messages });
    }
    projects.push(chats.every((chat, index) => chat === project.chats[index]) ? project : { ...project, chats });
  }
  return changed ? { ...state, projects } as T : state;
}

/**
 * Move every saved picture still inline in a chat into the store, leaving its
 * ref. A picture the store could not take stays inline, as it was, so nothing
 * is lost when the disk refuses. Returns the state unchanged, the same object,
 * when there was nothing to move.
 */
export function storeInlinePictures<T extends EvidenceHolder>(state: T, store: PictureStore): Promise<T> {
  return mapEvidence(state, async (evidence) => {
    if (evidence.imageDataUrl === undefined) return evidence;
    const ref = await store.put(evidence.imageDataUrl);
    if (ref === undefined) return evidence;
    const moved: RunEvidence = { ...evidence, imageRef: ref };
    delete moved.imageDataUrl;
    return moved;
  });
}

/**
 * Put every stored picture back inline, for a copy of the workspace that must
 * stand on its own, such as an export. A picture no longer in the store keeps
 * its ref, which says one was taken.
 */
export function inlineStoredPictures<T extends EvidenceHolder>(state: T, store: PictureStore): Promise<T> {
  return mapEvidence(state, async (evidence) => {
    if (evidence.imageRef === undefined || evidence.imageDataUrl !== undefined) return evidence;
    const picture = await store.read(evidence.imageRef);
    if (!picture.ok) return evidence;
    const inline: RunEvidence = { ...evidence, imageDataUrl: picture.dataUrl };
    delete inline.imageRef;
    return inline;
  });
}
