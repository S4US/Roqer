import type { AssetAttachment } from "./model";
import { ATTACHABLE_IMAGE_TYPES } from "./platform";

export const isImageAttachment = (attachment: AssetAttachment): boolean =>
  attachment.mediaType !== undefined && ATTACHABLE_IMAGE_TYPES.has(attachment.mediaType);

/** A clip's length as a person says it: "0:08". The trimmer is where hundredths matter. */
export function clipLength(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The part of a clip chosen, in the seconds it lasts at real speed. */
export function chosenLength(clip: NonNullable<AssetAttachment["clip"]>): string {
  return `${((clip.end - clip.start) / clip.slow).toFixed(2)} s`;
}

/**
 * What the chat can promise about an attachment, given where the run will go.
 * `warning` marks a promise it cannot keep: the file is saved, but the model
 * this run goes to cannot look at it.
 */
export function attachmentDetail(attachment: AssetAttachment, where: {
  imagesReachModel: boolean;
  reading: boolean;
  /** Whether a text file's contents reach the model, which takes the desktop app. */
  readsText: boolean;
}): { text: string; warning: boolean } {
  const { clip } = attachment;
  if (clip !== undefined) {
    if (where.reading) return { text: "Reading its frames…", warning: false };
    if (clip.id === undefined) return { text: `${clipLength(clip.duration)} video`, warning: false };
    return where.imagesReachModel
      ? { text: `${chosenLength(clip)} clip shared with agent as frames`, warning: false }
      : { text: `${chosenLength(clip)} clip saved; this sign-in cannot read images`, warning: true };
  }
  if (isImageAttachment(attachment)) {
    return where.imagesReachModel
      ? { text: "Image shared with agent", warning: false }
      : { text: "Image saved; this sign-in cannot read images", warning: true };
  }
  return where.readsText && /\.(rbxmx|txt|md|lua|luau)$/i.test(attachment.name)
    ? { text: "Text shared with agent", warning: false }
    : { text: "File details only; contents not read", warning: false };
}
