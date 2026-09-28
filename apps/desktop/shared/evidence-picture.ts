import { isEvidenceImage } from "./run-events";

/**
 * A saved run's preview, read back from the picture store for the renderer.
 *
 * The renderer names a picture only by its ref (`isEvidencePictureRef`): the
 * SHA-256 of its bytes and its type. The main process finds the file from that
 * name alone, checks it is the picture that was stored, and hands it over as
 * the same bounded data URL a live run carries.
 */

export type EvidencePictureFailure =
  /** No stored picture has that name: it was removed with its chat, or never written. */
  | "missing"
  /** The file is not the picture its name says: damaged, or not a PNG or JPEG Roqer stored. */
  | "invalid"
  /** This window may not ask. */
  | "refused";

export type EvidencePictureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: EvidencePictureFailure };

export function isEvidencePictureResult(value: unknown): value is EvidencePictureResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return isEvidenceImage(record.dataUrl);
  return record.ok === false && (record.reason === "missing" || record.reason === "invalid" || record.reason === "refused");
}
