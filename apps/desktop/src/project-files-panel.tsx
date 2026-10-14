import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box, Check, FileText, FolderOpen, ImageIcon, Loader2, Paperclip, Pencil, Plus, Rotate3d, Send, Trash2, Upload, X,
} from "lucide-react";
import { ModelViewer, type LoadedModel } from "./model-viewer";
import { projectFilesApi } from "./platform";
import {
  canSendToStudio, imageMediaType, MAX_FILE_NOTE_CHARS, modelFormat, PROJECT_FILE_DRAG_TYPE, type ProjectFile, type ProjectFilesResult,
} from "../shared/project-files";
import type { RunEvidence } from "../shared/run-events";

export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileKindIcon({ file, size = 15 }: { file: Pick<ProjectFile, "kind">; size?: number }) {
  if (file.kind === "model") return <Box size={size} aria-hidden="true" />;
  if (file.kind === "image") return <ImageIcon size={size} aria-hidden="true" />;
  if (file.kind === "text") return <FileText size={size} aria-hidden="true" />;
  return <Paperclip size={size} aria-hidden="true" />;
}

/** Start dragging a project file, onto the composer or a chat in the sidebar. */
export function dragProjectFile(event: React.DragEvent, projectId: string, file: ProjectFile) {
  event.dataTransfer.setData(PROJECT_FILE_DRAG_TYPE, JSON.stringify({ projectId, fileId: file.id }));
  event.dataTransfer.setData("text/plain", file.name);
  event.dataTransfer.effectAllowed = "copyLink";
}

/** The project file a drop carries, if it carries one from this project. */
export function droppedProjectFile(event: React.DragEvent, projectId: string): string | null {
  const raw = event.dataTransfer.getData(PROJECT_FILE_DRAG_TYPE);
  if (raw === "") return null;
  try {
    const value = JSON.parse(raw) as { projectId?: unknown; fileId?: unknown };
    return value.projectId === projectId && typeof value.fileId === "string" ? value.fileId : null;
  } catch {
    return null;
  }
}

export const carriesProjectFile = (event: React.DragEvent) => event.dataTransfer.types.includes(PROJECT_FILE_DRAG_TYPE);
export const carriesOsFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

/** A model, picture or text file from the project, opened for a look. */
export function ProjectFileViewer({ projectId, file, onClose, actions }: {
  projectId: string;
  file: ProjectFile;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  const [content, setContent] = useState<{ kind: "image"; src: string } | { kind: "text"; text: string } | { kind: "error"; message: string } | null>(null);
  const format = modelFormat(file.name);
  const load = useCallback(async (): Promise<LoadedModel> => {
    if (format === null) return { ok: false, reason: "failed" };
    const result = await projectFilesApi.read(projectId, file.id);
    return result.ok ? { ok: true, bytes: result.value, format } : { ok: false, reason: "failed" };
  }, [projectId, file.id, format]);
  const evidence = useMemo<RunEvidence>(() => ({ id: `project-${file.id}`, kind: "inspection", title: file.name }), [file.id, file.name]);

  useEffect(() => {
    if (file.kind === "model") return;
    let revoke: string | null = null;
    let live = true;
    void projectFilesApi.read(projectId, file.id).then((result) => {
      if (!live) return;
      if (!result.ok) { setContent({ kind: "error", message: result.message }); return; }
      if (file.kind === "image") {
        const blob = new Blob([result.value.slice()], { type: imageMediaType(file.name) ?? "application/octet-stream" });
        revoke = URL.createObjectURL(blob);
        setContent({ kind: "image", src: revoke });
      } else if (file.kind === "text") {
        setContent({ kind: "text", text: new TextDecoder().decode(result.value).slice(0, 200_000) });
      } else setContent({ kind: "error", message: "Roqer cannot show this kind of file. Use Show in folder to open it." });
    });
    return () => {
      live = false;
      if (revoke !== null) URL.revokeObjectURL(revoke);
    };
  }, [projectId, file.id, file.kind, file.name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return <div className="modal-backdrop file-viewer-backdrop" role="presentation" onMouseDown={(event) => { event.stopPropagation(); onClose(); }}>
    <div className="file-viewer" role="dialog" aria-modal="true" aria-label={file.name} onMouseDown={(event) => event.stopPropagation()}>
      <div className="file-viewer-bar">
        <strong><FileKindIcon file={file} /> {file.name}</strong>
        <span>{fileSizeLabel(file.size)}{file.kind === "model" ? " · drag to turn, scroll to zoom · on Roblox's axes, facing the way it will in Studio" : ""}</span>
        <div className="file-viewer-actions">{actions}</div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="file-viewer-stage" data-kind={file.kind}>
        {file.kind === "model"
          ? <ModelViewer evidence={evidence} onShowPicture={() => undefined} load={load} />
          : content === null
            ? <Loader2 className="spin" size={20} />
            : content.kind === "image"
              ? <img src={content.src} alt={file.name} />
              : content.kind === "text"
                ? <pre className="file-viewer-text">{content.text}</pre>
                : <p className="notes-error">{content.message}</p>}
      </div>
      {file.note !== undefined && <p className="file-viewer-note">{file.note}</p>}
    </div>
  </div>;
}

/**
 * The project's shared files: drop files in, look at them, share them with
 * the chat in view, and send a model to Studio in one click once it looks
 * right. Rows can be dragged onto the composer or onto a chat in the sidebar
 * to share them there.
 */
export function ProjectFilesPanel({ projectId, projectName, chat, files, onShare, onSendToStudio, sending, onClose }: {
  projectId: string;
  projectName: string;
  chat: { id: string; title: string; sharedFileIds: readonly string[] } | null;
  files: ProjectFile[] | null;
  onShare: (fileId: string, shared: boolean) => void;
  onSendToStudio: (file: ProjectFile) => void;
  /** The file being sent to Studio right now, if any. */
  sending: string | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [viewing, setViewing] = useState<ProjectFile | null>(null);
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "model" | "image" | "text" | "shared">("all");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && viewing === null) { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);

  const run = async <T,>(operation: () => Promise<ProjectFilesResult<T>>, done?: (value: T) => void) => {
    setBusy(true);
    try {
      const result = await operation();
      if (!result.ok) setError(result.message);
      else {
        setError(null);
        done?.(result.value);
      }
    } finally {
      setBusy(false);
    }
  };

  // While a row is dragged out, the panel steps aside so a chat in the sidebar
  // or the composer underneath can take the drop.
  const [draggingOut, setDraggingOut] = useState(false);

  const added = (list: ProjectFile[]) => {
    if (list.length === 0) return;
    setNotice(`Added ${list.length === 1 ? list[0].name : `${list.length} files`}${chat === null ? "" : ` and shared with “${chat.title}”`}.`);
    if (chat !== null) for (const file of list) onShare(file.id, true);
  };

  const shown = (files ?? []).filter((file) => filter === "all" || (filter === "shared" ? chat?.sharedFileIds.includes(file.id) : file.kind === filter))
    .slice().sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  const sendButton = (file: ProjectFile) => file.kind === "model" && canSendToStudio(file.name) && <button
    type="button"
    className="files-action primary"
    disabled={sending !== null}
    onClick={() => onSendToStudio(file)}
    title="Upload to Roblox and insert into the place in Studio"
  >{sending === file.id ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {file.assetId === undefined ? "Send to Studio" : "Send again"}</button>;

  return <div className={`modal-backdrop${draggingOut ? " files-dragging-out" : ""}`} role="presentation" onMouseDown={onClose}>
    <div
      className={`notes-modal files-modal${dropping ? " dropping" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Project files"
      onMouseDown={(event) => event.stopPropagation()}
      onDragOver={(event) => { if (!carriesOsFiles(event)) return; event.preventDefault(); setDropping(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(event) => {
        setDropping(false);
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        const dropped = Array.from(event.dataTransfer.files);
        void run(() => projectFilesApi.addDropped(projectId, dropped, chat?.id ?? null), added);
      }}
    >
      <div className="modal-header">
        <div>
          <h2>Project files</h2>
          <p className="notes-subtitle">{projectName} · shared by every chat in the project. Drop files anywhere here, or drag a file onto a chat to share it there.</p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
      </div>
      <div className="files-toolbar">
        <div className="notes-tabs files-filters">
          {(["all", "model", "image", "text", ...(chat === null ? [] : ["shared"])] as const).map((value) => <button
            key={value}
            className={filter === value ? "active" : ""}
            onClick={() => setFilter(value as typeof filter)}
          >{value === "all" ? "All" : value === "model" ? "Models" : value === "image" ? "Pictures" : value === "text" ? "Documents" : "Shared with this chat"}</button>)}
        </div>
        <button className="secondary-action" disabled={busy} onClick={() => void run(() => projectFilesApi.pick(projectId, chat?.id ?? null), added)}><Plus size={15} /> Add files</button>
      </div>
      {error !== null && <p className="notes-error" role="alert">{error}</p>}
      {notice !== null && error === null && <p className="files-notice" role="status">{notice}</p>}
      {files === null
        ? <p className="notes-empty"><Loader2 size={14} className="spin" /> Loading…</p>
        : shown.length === 0
          ? <div className="files-drop-empty"><Upload size={22} /><p>{files.length === 0
            ? "No files yet. Drop a master plan, reference pictures or models (.fbx, .glb, .obj) here. The Modeller's finished models land here too."
            : "Nothing here under this filter."}</p></div>
          : <ul className="files-list">
            {shown.map((file) => {
              const shared = chat?.sharedFileIds.includes(file.id) ?? false;
              return <li
                key={file.id}
                className="files-row"
                draggable
                onDragStart={(event) => {
                  dragProjectFile(event, projectId, file);
                  // After the drag has begun: changing the source as it starts can cancel it.
                  window.requestAnimationFrame(() => setDraggingOut(true));
                }}
                onDragEnd={() => setDraggingOut(false)}
              >
                <span className={`files-icon kind-${file.kind}`}><FileKindIcon file={file} size={16} /></span>
                <div className="files-main">
                  <button type="button" className="files-name" onClick={() => setViewing(file)} title={file.kind === "model" ? "View in 3D" : "Open"}>{file.name}</button>
                  <span className="files-meta">
                    {fileSizeLabel(file.size)} · {file.addedBy === "agent" ? "saved by a chat" : "added by you"} · {new Date(file.addedAt).toLocaleDateString()}
                    {file.assetId !== undefined && <> · <span className="files-asset">in Roblox as {file.assetId}</span></>}
                  </span>
                  {editing?.id === file.id
                    ? <div className="files-note-edit">
                      <input
                        autoFocus
                        value={editing.note}
                        maxLength={MAX_FILE_NOTE_CHARS}
                        placeholder="What is this file?"
                        onChange={(event) => setEditing({ id: file.id, note: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void run(() => projectFilesApi.note(projectId, file.id, editing.note), () => setEditing(null));
                          if (event.key === "Escape") { event.stopPropagation(); setEditing(null); }
                        }}
                      />
                      <button className="icon-button" onClick={() => void run(() => projectFilesApi.note(projectId, file.id, editing.note), () => setEditing(null))} aria-label="Save note"><Check size={15} /></button>
                    </div>
                    : file.note !== undefined && <span className="files-note">{file.note}</span>}
                </div>
                <div className="files-actions">
                  <button type="button" className="files-action" onClick={() => setViewing(file)}>{file.kind === "model" ? <><Rotate3d size={14} /> View 3D</> : "Open"}</button>
                  {sendButton(file)}
                  {chat !== null && <label className="files-share" title={`Give “${chat.title}” this file with every message`}>
                    <input type="checkbox" checked={shared} onChange={(event) => onShare(file.id, event.target.checked)} /> Shared here
                  </label>}
                  <button type="button" className="icon-button" onClick={() => setEditing({ id: file.id, note: file.note ?? "" })} aria-label={`Edit the note on ${file.name}`} title="Edit note"><Pencil size={14} /></button>
                  <button type="button" className="icon-button" onClick={() => void run(() => projectFilesApi.reveal(projectId, file.id))} aria-label={`Show ${file.name} in its folder`} title="Show in folder"><FolderOpen size={14} /></button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => {
                      if (!window.confirm(`Remove ${file.name} from the project? Chats can no longer use it.`)) return;
                      void run(() => projectFilesApi.remove(projectId, file.id), () => { if (shared) onShare(file.id, false); });
                    }}
                    aria-label={`Remove ${file.name}`}
                    title="Remove"
                  ><Trash2 size={14} /></button>
                </div>
              </li>;
            })}
          </ul>}
      {dropping && <div className="files-drop-hint"><Upload size={20} /> Drop to add to the project{chat === null ? "" : ` and share with “${chat.title}”`}</div>}
    </div>
    {viewing !== null && <ProjectFileViewer
      projectId={projectId}
      file={files?.find((file) => file.id === viewing.id) ?? viewing}
      onClose={() => setViewing(null)}
      actions={sendButton(files?.find((file) => file.id === viewing.id) ?? viewing)}
    />}
  </div>;
}
