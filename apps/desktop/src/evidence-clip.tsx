import { useState } from "react";
import { VideoOff } from "lucide-react";
import { evidenceClipUrl } from "../shared/evidence-clip";
import type { RunEvidence } from "../shared/run-events";

/**
 * A run's playtest recording, played from the store beside the chat.
 *
 * Evidence carries only the clip's ref. The player streams it from the main
 * process by that ref, so a clip is read only when someone plays it, and
 * seeks by byte range like any video. A recording whose file is gone is shown
 * as gone, never as a player that fails on play.
 */
export function EvidenceClip({ evidence, className }: { evidence: RunEvidence; className?: string }) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const ref = evidence.clipRef;
  if (ref === undefined) return null;
  const desktop = typeof window !== "undefined" && window.workbenchDesktop !== undefined;
  if (!desktop || failed === ref) {
    return <span className={`evidence-clip-missing ${className ?? ""}`} role="note">
      <VideoOff size={14} aria-hidden="true" />
      <span>{desktop ? "Recording no longer available" : "Recordings play in the desktop app"}</span>
    </span>;
  }
  return <video
    className={`evidence-clip ${className ?? ""}`}
    controls
    preload="metadata"
    playsInline
    src={evidenceClipUrl(ref)}
    aria-label={evidence.title}
    onError={() => setFailed(ref)}
  />;
}
