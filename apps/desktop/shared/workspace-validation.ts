import { isRunRecord } from "./run-events";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * How large a saved attachment preview may be.
 *
 * A thumbnail is the one part of an attachment that outlives the run, so it is
 * the one that could quietly grow a chat file without bound. The producer aims
 * far below this; the ceiling is here so that a record which somehow exceeds it
 * is treated as damaged rather than saved.
 */
export const MAX_ATTACHMENT_THUMBNAIL_CHARACTERS = 96 * 1024;

/** A data URL for a preview image, bounded and restricted to image media. */
export function isAttachmentThumbnail(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_ATTACHMENT_THUMBNAIL_CHARACTERS &&
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * One attachment as it is persisted with a message. Shared by the renderer's
 * normalization and the recovery check so that the two can never disagree about
 * which records are readable.
 */
export function isPersistedAttachment(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.addedAt === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.mediaType === undefined || typeof value.mediaType === "string") &&
    (value.thumbnailDataUrl === undefined || isAttachmentThumbnail(value.thumbnailDataUrl));
}

export function supportsWorkspaceSchema(value: unknown): value is Record<string, unknown> & { schemaVersion: 1 | 2 | 3 } {
  return isRecord(value) && (value.schemaVersion === 1 || value.schemaVersion === 2 || value.schemaVersion === 3);
}

/** True when normalization would have to discard or overwrite user records. */
export function malformedWorkspace(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.projects)) return true;
  let malformed = false;
  const projectIds = new Set<string>();
  const chatIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const project of value.projects) {
    if (!isRecord(project) ||
      typeof project.id !== "string" ||
      typeof project.name !== "string" ||
      typeof project.createdAt !== "string" ||
      typeof project.updatedAt !== "string" ||
      !Array.isArray(project.chats) || projectIds.has(project.id)) { malformed = true; continue; }
    projectIds.add(project.id);
    for (const chat of project.chats) {
      if (!isRecord(chat) ||
        typeof chat.id !== "string" ||
        typeof chat.title !== "string" ||
        typeof chat.createdAt !== "string" ||
        typeof chat.updatedAt !== "string" ||
        !Array.isArray(chat.messages) || chatIds.has(chat.id)) { malformed = true; continue; }
      chatIds.add(chat.id);
      for (const message of chat.messages) {
        if (!isRecord(message) ||
          typeof message.id !== "string" ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.text !== "string" ||
          typeof message.createdAt !== "string" ||
          messageIds.has(message.id as string) ||
          (message.run !== undefined && !isRunRecord(message.run)) ||
          (message.attachments !== undefined && (!Array.isArray(message.attachments) ||
            message.attachments.some((attachment) => !isPersistedAttachment(attachment))))) malformed = true;
        else messageIds.add(message.id);
      }
    }
  }
  return malformed;
}

export function workspaceNeedsRecovery(value: unknown): boolean {
  return !supportsWorkspaceSchema(value) || malformedWorkspace(value);
}
