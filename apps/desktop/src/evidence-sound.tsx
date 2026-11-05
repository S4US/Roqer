import { useEffect, useState } from "react";
import { VolumeX } from "lucide-react";
import type { EvidenceSoundFailure, EvidenceSoundResult } from "../shared/evidence-sound";
import type { RunEvidence } from "../shared/run-events";
import { loadEvidenceSound } from "./platform";

/**
 * A run's sound, from the store beside the chat.
 *
 * Evidence carries only the sound's ref, live or saved, because a sound is
 * larger than a picture and is wanted only when someone presses play. The
 * sounds heard recently are kept here, so scrolling back does not ask again.
 */

/** Sounds kept for playing again; a handful, since each may be a few megabytes. */
const MAX_CACHED = 12;
const cache = new Map<string, string>();
const loading = new Map<string, Promise<EvidenceSoundResult>>();

function remember(ref: string, dataUrl: string): void {
  cache.delete(ref);
  cache.set(ref, dataUrl);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function load(ref: string): Promise<EvidenceSoundResult> {
  const pending = loading.get(ref);
  if (pending !== undefined) return pending;
  const request = loadEvidenceSound(ref)
    .catch((): EvidenceSoundResult => ({ ok: false, reason: "missing" }))
    .then((result) => {
      loading.delete(ref);
      if (result.ok) remember(ref, result.dataUrl);
      return result;
    });
  loading.set(ref, request);
  return request;
}

export type SoundState =
  | { status: "ready"; src: string }
  | { status: "loading" }
  | { status: "unavailable"; reason: EvidenceSoundFailure | "none" };

/** The sound to play for a piece of evidence, loading it from the store when it has to. */
export function useEvidenceSound(evidence: RunEvidence): SoundState {
  const ref = evidence.soundRef;
  const cached = ref === undefined ? undefined : cache.get(ref);
  const [loaded, setLoaded] = useState<{ ref: string; state: SoundState } | undefined>(undefined);
  const needsLoad = cached === undefined && ref !== undefined;
  useEffect(() => {
    if (!needsLoad || ref === undefined) return;
    let current = true;
    void load(ref).then((result) => {
      if (!current) return;
      setLoaded({ ref, state: result.ok ? { status: "ready", src: result.dataUrl } : { status: "unavailable", reason: result.reason } });
    });
    return () => { current = false; };
  }, [ref, needsLoad]);
  if (ref === undefined) return { status: "unavailable", reason: "none" };
  if (cached !== undefined) return { status: "ready", src: cached };
  return loaded !== undefined && loaded.ref === ref ? loaded.state : { status: "loading" };
}

/**
 * A sound as a player, or, when it cannot be had, a quiet line that says so: a
 * saved sound whose file is gone is shown as gone, never as a player that
 * fails on play.
 */
export function EvidenceSound({ evidence, className }: { evidence: RunEvidence; className?: string }) {
  const sound = useEvidenceSound(evidence);
  if (sound.status === "ready") {
    return <audio className={`evidence-sound ${className ?? ""}`} controls preload="metadata" src={sound.src} aria-label={evidence.title} />;
  }
  if (sound.status === "loading") return <span className={`evidence-sound-pending ${className ?? ""}`} aria-busy="true">Loading sound…</span>;
  return <span className={`evidence-sound-missing ${className ?? ""}`} role="note">
    <VolumeX size={14} aria-hidden="true" />
    <span>Sound no longer available</span>
  </span>;
}
