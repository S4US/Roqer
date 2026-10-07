import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileCode2, Folder, FolderPlus, RotateCw, X } from "lucide-react";

import type { RojoResult, RojoView } from "../shared/rojo";
import {
  chooseRojoProject, forgetRojoProject, getRojoView, hasDesktopRuntime, linkRecentRojoProject,
  openRojoFolder, retryRojoProject, unlinkRojoProject,
} from "./platform";
import { EMPTY_ROJO_VIEW, errorViewFromRejection, rojoLinkedNote, rojoPillLinked, rojoPillVisual, viewFromResult } from "./rojo-pill-model";

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

  // Reloaded whenever the place changes and whenever the caller's own
  // refresh signal changes identity -- the same cadence the Studio connection
  // pill refreshes on, so a relink after a bridge restart shows up here too.
  useEffect(() => {
    if (!desktop) { setView(EMPTY_ROJO_VIEW); return; }
    let cancelled = false;
    void getRojoView(instanceId).then((result) => { if (!cancelled) setView(viewFromResult(result, instanceId)); });
    return () => { cancelled = true; };
  }, [desktop, instanceId, refreshSignal]);

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
    setBusy(true);
    try {
      const result = await request();
      setView(viewFromResult(result, instanceId));
    } catch (error) {
      // A rejected IPC call (not a normal `{ ok: false }` result) must still
      // clear `busy` and leave something to look at, or the buttons stay
      // disabled forever with no explanation.
      setView(errorViewFromRejection(error, instanceId));
    } finally {
      setBusy(false);
    }
  };

  if (!desktop) {
    return <div className="rojo-wrap"><span className="rojo-pill muted" title="Rojo linking needs the desktop app.">Rojo · desktop only</span></div>;
  }

  const visual = rojoPillVisual(view);
  const id = view.instanceId;

  return <div className="rojo-wrap" ref={wrapRef}>
    <button
      className={`rojo-pill${visual.muted ? " muted" : ""}${visual.dashed ? " dashed" : ""}`}
      onClick={() => setOpen((value) => !value)}
    >
      {visual.dot !== "none" && <span className={`rojo-dot dot-${visual.dot}`} />}
      <span className="connection-label">{visual.label}</span>
      <ChevronDown size={15} />
    </button>
    {open && <div className="connection-popover">
      <div className="popover-title">
        <div className="studio-icon"><FileCode2 size={18} /></div>
        <div><strong>Rojo</strong><span>{popoverSubtitle(view)}</span></div>
      </div>

      {/* A failure's message is still shown on a kept, non-error view (e.g. a
          failed "Change project..." that left the old link in place) -- the
          `error` state's own block below already shows its message, so this
          one is skipped there to avoid saying it twice. */}
      {view.message !== undefined && view.state !== "error" &&
        <p className="popover-problem" role="alert">{view.message}</p>}

      {rojoPillLinked(view.state) && view.project !== undefined && <>
        <dl>
          <div><dt>Project</dt><dd title={view.project.folder}>{view.project.fileName}</dd></div>
          <div><dt>Folder</dt><dd>{view.project.folder}</dd></div>
          {view.project.rojoVersion !== undefined && <div><dt>Rojo</dt><dd>{view.project.rojoVersion}</dd></div>}
          <div><dt>Server</dt><dd>{view.server?.answering ? `Answering, port ${view.server.port}` : "Not running"}</dd></div>
          {view.project.scripts !== undefined &&
            <div><dt>Scripts</dt><dd>
              {view.project.scripts.file} file · {view.project.scripts.generated} generated
              {view.project.problems !== undefined && view.project.problems.length > 0 && ` · ${view.project.problems.length} problems`}
            </dd></div>}
        </dl>
        {view.project.problems !== undefined && view.project.problems.length > 0 &&
          <p className="popover-problem" role="alert">{view.project.problems.join("; ")}</p>}
        <p className="popover-note">{rojoLinkedNote(view.published, placeName)}</p>
        {id !== null && <>
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => openRojoFolder(id))}><Folder size={15} /> Open folder</button>
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => chooseRojoProject(id))}><FolderPlus size={15} /> Change project…</button>
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => unlinkRojoProject(id))}><X size={15} /> Unlink</button>
        </>}
      </>}

      {(view.state === "not-linked" || view.state === "detected") && <>
        {view.server?.answering &&
          <p className="popover-note">Rojo is serving {view.server.projectName ?? "a project"} on port {view.server.port}.</p>}
        {view.recent.length > 0 && <ul className="rojo-recent-list">
          {view.recent.slice(0, 5).map((entry) => <li key={entry.index} className="rojo-recent-row">
            <span className="rojo-recent-name" title={entry.folder}>{entry.fileName}</span>
            {id !== null &&
              <button className="small-button" disabled={busy} onClick={() => void apply(() => linkRecentRojoProject(id, entry.index))}>Link</button>}
          </li>)}
        </ul>}
        {id !== null &&
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => chooseRojoProject(id))}><FolderPlus size={15} /> Choose a project file…</button>}
        <p className="popover-note">Linking makes Roqer save script edits to your project's files, so they show up in Git.</p>
      </>}

      {view.state === "error" && <>
        <p className="popover-problem" role="alert">{view.message ?? "Rojo could not complete that request."}</p>
        {id !== null && <>
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => retryRojoProject(id))}><RotateCw size={15} /> Retry</button>
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => chooseRojoProject(id))}><FolderPlus size={15} /> Choose a project file…</button>
          <button className="popover-action" disabled={busy} onClick={() => void apply(() => forgetRojoProject(id))}><X size={15} /> Forget this link</button>
        </>}
      </>}

      {view.state === "no-place" && <p className="popover-note">No place is connected.</p>}
    </div>}
  </div>;
}

/** The popover's second line, under "Rojo", one state-appropriate sentence. */
function popoverSubtitle(view: RojoView): string {
  switch (view.state) {
    case "no-place":
      return "No place connected";
    case "not-linked":
      return "Not linked";
    case "detected":
      return "A Rojo server is running";
    case "linked-running":
      return "Linked, Rojo is serving it";
    case "linked-stopped":
      return "Linked, Rojo is not running";
    case "error":
      return "Last link attempt failed";
  }
}
