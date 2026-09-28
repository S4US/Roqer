import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import type { EvidencePictureFailure, EvidencePictureResult } from "../shared/evidence-picture";
import type { RunEvidence } from "../shared/run-events";
import { loadEvidencePicture } from "./platform";

/**
 * A run's picture, wherever it is kept.
 *
 * A live run's evidence carries the picture itself; a saved run's carries only
 * its ref in the picture store beside the chat, and the picture is asked for
 * when it is shown. The pictures shown recently are kept here, so scrolling
 * back and forth does not ask again, and a run's own pictures are here the
 * moment it ends rather than loading in after it.
 */

/** Pictures kept for showing again; about 8 MB at the size previews are made. */
const MAX_CACHED = 100;
const cache = new Map<string, string>();
const loading = new Map<string, Promise<EvidencePictureResult>>();

function remember(ref: string, dataUrl: string): void {
  cache.delete(ref);
  cache.set(ref, dataUrl);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Keep a live run's picture under its ref, so the saved run shows it without asking. */
export function rememberEvidencePicture(evidence: RunEvidence): void {
  if (evidence.imageRef !== undefined && evidence.imageDataUrl !== undefined) remember(evidence.imageRef, evidence.imageDataUrl);
}

function load(ref: string): Promise<EvidencePictureResult> {
  const pending = loading.get(ref);
  if (pending !== undefined) return pending;
  const request = loadEvidencePicture(ref)
    .catch((): EvidencePictureResult => ({ ok: false, reason: "missing" }))
    .then((result) => {
      loading.delete(ref);
      if (result.ok) remember(ref, result.dataUrl);
      return result;
    });
  loading.set(ref, request);
  return request;
}

export type PictureState =
  | { status: "ready"; src: string }
  | { status: "loading" }
  | { status: "unavailable"; reason: EvidencePictureFailure | "none" };

function known(evidence: RunEvidence): PictureState | undefined {
  if (evidence.imageDataUrl !== undefined) return { status: "ready", src: evidence.imageDataUrl };
  if (evidence.imageRef === undefined) return { status: "unavailable", reason: "none" };
  const cached = cache.get(evidence.imageRef);
  return cached === undefined ? undefined : { status: "ready", src: cached };
}

/** The picture to show for a piece of evidence, loading it from the store when it has to. */
export function useEvidencePicture(evidence: RunEvidence): PictureState {
  rememberEvidencePicture(evidence);
  const ref = evidence.imageRef;
  const [loaded, setLoaded] = useState<{ ref: string; state: PictureState } | undefined>(undefined);
  const now = known(evidence);
  const needsLoad = now === undefined && ref !== undefined;
  useEffect(() => {
    if (!needsLoad || ref === undefined) return;
    let current = true;
    void load(ref).then((result) => {
      if (!current) return;
      setLoaded({ ref, state: result.ok ? { status: "ready", src: result.dataUrl } : { status: "unavailable", reason: result.reason } });
    });
    return () => { current = false; };
  }, [ref, needsLoad]);
  if (now !== undefined) return now;
  return loaded !== undefined && loaded.ref === ref ? loaded.state : { status: "loading" };
}

/**
 * A picture as an image, or, when it cannot be had, a quiet placeholder that
 * says so: a saved picture whose file is gone is shown as gone, never as a
 * blank that looks like a broken image.
 */
export function EvidencePicture({ evidence, alt = "", className }: {
  evidence: RunEvidence;
  alt?: string;
  className?: string;
}) {
  const picture = useEvidencePicture(evidence);
  if (picture.status === "ready") return <img className={className} src={picture.src} alt={alt} draggable={false} />;
  if (picture.status === "loading") return <span className={`evidence-picture-pending ${className ?? ""}`} aria-busy="true" />;
  return <span className={`evidence-picture-missing ${className ?? ""}`} role="img" aria-label={alt === "" ? "Picture no longer available" : `${alt}: picture no longer available`}>
    <ImageOff size={16} aria-hidden="true" />
    <span>Picture no longer available</span>
  </span>;
}
