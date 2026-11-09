/**
 * A saved run's sound, read back from the store beside the chat for the chat
 * window.
 *
 * A sound a run previewed from the Creator Store, or uploaded to Roblox, used
 * to reach the user as a line of text: the bridge client dropped the audio a
 * result carried. Sounds are kept the way pictures are, as files named by the
 * SHA-256 of their bytes, and the window names one only by that ref
 * (`isEvidenceSoundRef`). The main process finds the file from the name alone,
 * checks it is the sound that was stored, and hands it over as a bounded data
 * URL the window's player can play.
 */

/** A sound kept with a chat: large enough for a music loop, small enough for the chat's disk. */
export const MAX_EVIDENCE_SOUND_BYTES = 6 * 1024 * 1024;
/** The same bound as a data URL: base64 grows the bytes by a third, plus the scheme. */
export const MAX_EVIDENCE_SOUND_CHARACTERS = Math.ceil(MAX_EVIDENCE_SOUND_BYTES * 4 / 3) + 64;

export type EvidenceSoundFailure =
  /** No stored sound has that name: it was removed with its chat, or never written. */
  | "missing"
  /** The file is not the sound its name says: damaged, or not a format Roqer stored. */
  | "invalid"
  /** This window may not ask. */
  | "refused";

export type EvidenceSoundResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: EvidenceSoundFailure };

/** A bounded data URL of one of the formats the store keeps. */
export function isEvidenceSound(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_EVIDENCE_SOUND_CHARACTERS &&
    /^data:audio\/(mpeg|ogg|wav|flac);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function isEvidenceSoundResult(value: unknown): value is EvidenceSoundResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return isEvidenceSound(record.dataUrl);
  return record.ok === false && (record.reason === "missing" || record.reason === "invalid" || record.reason === "refused");
}
