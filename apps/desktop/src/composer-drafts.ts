import type { PastedBlock } from "./composer-text";
import type { AssetAttachment } from "./model";

/**
 * What was being written in a chat when the person left it: the typed text,
 * the long pastes folded out of it, and the files attached to it.
 *
 * Moving to another chat used to clear the box and let go of the attached
 * files, so a half-written message, and any screenshot pasted into it, was
 * gone on return. Drafts are kept per chat for as long as the window is open,
 * and the files they hold stay registered with the main process until the
 * draft is sent, emptied, or its chat is deleted.
 */
export type ComposerDraft = Readonly<{
  text: string;
  pastedBlocks: readonly PastedBlock[];
  attachments: readonly AssetAttachment[];
}>;

export const EMPTY_DRAFT: ComposerDraft = { text: "", pastedBlocks: [], attachments: [] };

/** A chat's key, or, before a chat exists, its project's. */
export function draftKey(projectId: string, chatId: string | null): string {
  return chatId === null ? `project:${projectId}` : `chat:${chatId}`;
}

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.text.trim() === "" && draft.pastedBlocks.length === 0 && draft.attachments.length === 0;
}

export class ComposerDrafts {
  private readonly drafts = new Map<string, ComposerDraft>();

  /** Keep a draft for when its chat is opened again. An empty one is simply forgotten. */
  put(key: string, draft: ComposerDraft): void {
    if (isEmptyDraft(draft)) this.drafts.delete(key);
    else this.drafts.set(key, draft);
  }

  /** The chat's draft, handed back to the box and no longer held here. */
  take(key: string): ComposerDraft {
    const draft = this.drafts.get(key) ?? EMPTY_DRAFT;
    this.drafts.delete(key);
    return draft;
  }

  /** Forget the drafts under these keys; the files they held, for the caller to release. */
  discard(keys: Iterable<string>): string[] {
    const released: string[] = [];
    for (const key of keys) {
      const draft = this.drafts.get(key);
      if (draft === undefined) continue;
      released.push(...draft.attachments.map((attachment) => attachment.id));
      this.drafts.delete(key);
    }
    return released;
  }

  /**
   * Put a file's newer state into whichever kept draft holds it: a clip whose
   * frames finished reading after its chat was left is ready on return.
   */
  replaceAttachment(next: AssetAttachment): void {
    for (const [key, draft] of this.drafts) {
      if (!draft.attachments.some((attachment) => attachment.id === next.id)) continue;
      this.drafts.set(key, { ...draft, attachments: draft.attachments.map((attachment) => attachment.id === next.id ? next : attachment) });
    }
  }

  get size(): number {
    return this.drafts.size;
  }
}
