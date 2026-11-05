import { CLIP_MEDIA_SCHEME } from "./reference-clip";

/**
 * A saved run's playtest recording, streamed from the store beside the chat
 * to the chat window's player.
 *
 * A recording is far larger than a picture or a sound, and a video seeks, so
 * it is not handed over as a data URL: the window plays it from the
 * `roqer-clip` scheme, naming it only by its ref (`isEvidenceClipRef`), and
 * the main process finds the file from that name alone, checks it is the clip
 * that was stored, and serves its bytes by range.
 */

/** A recording kept with a chat: two minutes of a 1280-pixel window at the recorder's bit rate, with room. */
export const MAX_EVIDENCE_CLIP_BYTES = 48 * 1024 * 1024;

/** The host under the clip scheme that names stored recordings; attached clips use `media`. */
export const EVIDENCE_CLIP_HOST = "evidence";

/** Where the chat window plays a stored recording from. */
export function evidenceClipUrl(ref: string): string {
  return `${CLIP_MEDIA_SCHEME}://${EVIDENCE_CLIP_HOST}/${encodeURIComponent(ref)}`;
}

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3];

/** Whether bytes begin as a WebM (an EBML document) does, which is what names a recording's type. */
export function isWebm(bytes: Uint8Array): boolean {
  return bytes.length >= EBML_HEADER.length && EBML_HEADER.every((byte, index) => bytes[index] === byte);
}
