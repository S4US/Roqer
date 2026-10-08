import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import type { RojoResult, RojoView } from "../shared/rojo";
import {
  chooseRojoProject, forgetRojoProject, getRojoView, hasDesktopRuntime, linkRecentRojoProject,
  openRojoFolder, retryRojoProject, unlinkRojoProject,
} from "./platform";
import {
  EMPTY_ROJO_VIEW, errorViewFromRejection, RojoPillSequence, rojoLinkedNote, rojoPillLinked, rojoPillTone,
  rojoPillVisual, rojoPopoverHeadline, viewFromResult,
} from "./rojo-pill-model";

/**
 * The Rojo pill: always next to the Studio connection pill, per the approved
 * mockup and spec §4.1. A quiet "no place"/"not linked" pill is itself the
 * answer for someone who never uses Rojo, rather than nothing being there to
 * find. Every action goes through `platform.ts`'s narrow Rojo API: the
 * renderer never names a project file, it only tells the main process which
 * remembered one to use, or asks it to open its own dialog.
 */
export function RojoPill({ instanceId, placeName, refreshSignal }: { instanceId: string | null; placeName?: string; refreshSignal: unknown }) {
  const desktop = hasDesktopRuntime();
  const [view, setView] = useState<RojoView>(EMPTY_ROJO_VIEW);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Orders this background refresh against `apply`'s explicit actions (see
  // `RojoPillSequence`'s doc comment): without it, a refresh issued just
  // before the user clicks Retry can resolve after Retry's own fresh result
  // and clobber it with the stale, pre-retry view.
  const sequence = useRef(new RojoPillSequence()).current;

  // Reloaded whenever the place changes and whenever the caller's own
  // refresh signal changes identity -- the same cadence the Studio connection
  // pill refreshes on, so a relink after a bridge restart shows up here too.
  useEffect(() => {
    if (!desktop) { setView(EMPTY_ROJO_VIEW); return; }
    let cancelled = false;
    const ticket = sequence.startRefresh();
    void getRojoView(instanceId).then((result) => {
      if (!cancelled && sequence.isCurrent(ticket)) setView(viewFromResult(result, instanceId));
    });
    return () => { cancelled = true; };
  }, [desktop, instanceId, refreshSignal, sequence]);

  // Dismissed the same way the Studio connection popover is: a press anywhere
  // outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const apply = async (request: () => Promise<RojoResult>) => {
    // Supersede any background refresh already in flight -- it read state
    // from before this action, so it must not be allowed to overwrite this
    // action's own (later) result. See `RojoPillSequence`'s doc comment.
    sequence.bump();
    setBusy(true);
    try {
      const result = await request();
      sequence.bump(); // also supersede a refresh that started during this action
      setView(viewFromResult(result, instanceId));
    } catch (error) {
      // A rejected IPC call (not a normal `{ ok: false }` result) must still
      // clear `busy` and leave something to look at, or the buttons stay
      // disabled forever with no explanation.
      sequence.bump();
      setView(errorViewFromRejection(error, instanceId));
    } finally {
      setBusy(false);
    }
  };

  if (!desktop) {
    return <div className="rojo-wrap"><span className="rojo-pill muted" title="Rojo linking needs the desktop app.">Rojo · desktop only</span></div>;
  }

  const visual = rojoPillVisual(view);
  const tone = rojoPillTone(visual.dot);
  const headline = rojoPopoverHeadline(view);
  const id = view.instanceId;

  return <div className="rojo-wrap" ref={wrapRef}>
    <button
      className={`rojo-pill${visual.muted ? " muted" : ""}${tone !== "none" ? ` tone-${tone}` : ""}`}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="connection-label">{visual.label}</span>
      <ChevronDown size={15} />
    </button>
    {open && <div className={`rojo-popover${tone !== "none" ? ` tone-${tone}` : ""}`}>
      {headline !== undefined &&
        <p className="rojo-popover-headline" role={view.state === "error" ? "alert" : undefined}>{headline}</p>}

      {/* A failure's message is still shown on a kept, non-error view (e.g. a
          failed "Change project..." that left the old link in place) -- the
          `error` state's own headline above already carries its message, so
          this is skipped there to avoid saying it twice. */}
      {view.message !== undefined && view.state !== "error" &&
        <p className="popover-problem" role="alert">{view.message}</p>}

      {rojoPillLinked(view.state) && view.project !== undefined && <>
        <p className="rojo-popover-subline" title={view.project.folder}>{view.project.folder}</p>
        <dl>
          {placeName !== undefined && <div><dt>Place</dt><dd>{placeName}</dd></div>}
          <div><dt>Rojo</dt><dd>{rojoVersionLine(view)}</dd></div>
          {view.project.scripts !== undefined &&
            <div><dt>Scripts</dt><dd>
              {view.project.scripts.file} file · {view.project.scripts.generated} generated
              {view.project.problems !== undefined && view.project.problems.length > 0 && ` · ${view.project.problems.length} problems`}
            </dd></div>}
        </dl>
        {view.project.problems !== undefined && view.project.problems.length > 0 &&
          <p className="popover-problem" role="alert">{view.project.problems.join("; ")}</p>}
        {/* Spec §4.1's caveat: a published place relinks automatically after a
            restart, an unpublished one only lasts this Studio session. */}
        <p className="rojo-popover-subline">{rojoLinkedNote(view.published, placeName)}</p>
        {id !== null && <div className="rojo-popover-actions">
          <button className="link-button" disabled={busy} onClick={() => void apply(() => openRojoFolder(id))}>Open folder</button>
          <button className="link-button" disabled={busy} onClick={() => void apply(() => chooseRojoProject(id))}>Change…</button>
          <button className="link-button danger" disabled={busy} onClick={() => void apply(() => unlinkRojoProject(id))}>Unlink</button>
        </div>}
      </>}

      {(view.state === "not-linked" || view.state === "detected") && <>
        <p className="rojo-popover-subline">Link it so edits save to your files.</p>
        {view.recent.length > 0 && <ul className="rojo-recent-list">
          {view.recent.slice(0, 5).map((entry) => <li key={entry.index} className="rojo-recent-row">
            <span className="rojo-recent-name" title={entry.folder}>{entry.fileName}</span>
            {id !== null &&
              <button className="link-button" disabled={busy} onClick={() => void apply(() => linkRecentRojoProject(id, entry.index))}>Link</button>}
          </li>)}
        </ul>}
        {id !== null &&
          <button className="link-button" disabled={busy} onClick={() => void apply(() => chooseRojoProject(id))}>Choose a project file…</button>}
      </>}

      {view.state === "error" && id !== null && <div className="rojo-popover-actions">
        <button className="link-button" disabled={busy} onClick={() => void apply(() => retryRojoProject(id))}>Retry</button>
        <button className="link-button" disabled={busy} onClick={() => void apply(() => chooseRojoProject(id))}>Choose…</button>
        <button className="link-button danger" disabled={busy} onClick={() => void apply(() => forgetRojoProject(id))}>Forget</button>
      </div>}

      {view.state === "no-place" && <p className="rojo-popover-subline">No place is connected.</p>}
    </div>}
  </div>;
}

/**
 * The popover's "Rojo" fact row: the installed Rojo version and whether it is
 * currently answering, folded into one line (`"7.7.0 · port 34872"`) per the
 * approved mockup, rather than the two separate rows this used to be.
 */
function rojoVersionLine(view: RojoView): string {
  const version = view.project?.rojoVersion;
  const running = view.server?.answering ? `port ${view.server.port}` : undefined;
  if (version !== undefined && running !== undefined) return `${version} · ${running}`;
  if (version !== undefined) return version;
  if (running !== undefined) return running;
  return "Not running";
}
