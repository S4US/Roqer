import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import { Markdown } from "./markdown-view";
import { projectNotes } from "./platform";
import { MAX_MEMORY_CHARS, MAX_PLAN_CHARS, type ProjectNotes, type ProjectNotesResult } from "../shared/project-notes";

/**
 * The project's memory and master plan, which every chat in the project starts
 * with and the agent keeps up to date with its own tools. The person can read
 * and change both here; a chat that is already running is told about a change
 * with its next message.
 */
export function ProjectNotesPanel({ projectId, projectName, onClose }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"plan" | "memory">("plan");
  const [notes, setNotes] = useState<ProjectNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [newMemory, setNewMemory] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((result: ProjectNotesResult): boolean => {
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setError(null);
    setNotes(result.notes);
    return true;
  }, []);

  useEffect(() => {
    void projectNotes.get(projectId).then(apply);
  }, [projectId, apply]);

  const planDirty = planDraft !== null && notes !== null && planDraft !== notes.plan;
  const close = () => {
    if (planDirty && !window.confirm("Discard your unsaved changes to the master plan?")) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const run = async (operation: () => Promise<ProjectNotesResult>): Promise<boolean> => {
    setBusy(true);
    try {
      return apply(await operation());
    } finally {
      setBusy(false);
    }
  };

  const savePlan = async () => {
    if (planDraft === null) return;
    if (await run(() => projectNotes.setPlan(projectId, planDraft))) setPlanDraft(null);
  };

  const addMemory = async () => {
    const text = newMemory.trim();
    if (!text) return;
    if (await run(() => projectNotes.addMemory(projectId, text))) setNewMemory("");
  };

  const saveMemory = async () => {
    if (editing === null) return;
    if (await run(() => projectNotes.updateMemory(projectId, editing.id, editing.text))) setEditing(null);
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={close}>
    <div className="notes-modal" role="dialog" aria-modal="true" aria-label="Project notes" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <div><h2>Project notes</h2><span className="notes-subtitle">{projectName} · every chat in this project starts with these</span></div>
        <button className="icon-button" onClick={close} aria-label="Close"><X size={19} /></button>
      </div>
      <div className="notes-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>Master plan</button>
        <button role="tab" aria-selected={tab === "memory"} className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>
          Memory{notes !== null && notes.memories.length > 0 ? ` (${notes.memories.length})` : ""}
        </button>
      </div>
      {error !== null && <p className="notes-error">{error}</p>}
      {notes === null
        ? <p className="notes-empty">Loading…</p>
        : tab === "plan"
          ? <div className="notes-body">
            {planDraft === null
              ? <>
                {notes.plan.trim() === ""
                  ? <p className="notes-empty">No master plan yet. Write one here, or ask Roqer in any chat to draft it from what you have discussed (for example: "write the master plan for this game").</p>
                  : <div className="notes-plan-view"><Markdown text={notes.plan} /></div>}
                <div className="modal-actions">
                  {notes.planUpdatedAt !== null && <span className="notes-meta">Updated {new Date(notes.planUpdatedAt).toLocaleString()}</span>}
                  <button className="primary-action" onClick={() => setPlanDraft(notes.plan)}><Pencil size={14} /> Edit</button>
                </div>
              </>
              : <>
                <textarea
                  className="notes-plan-editor"
                  value={planDraft}
                  spellCheck
                  autoFocus
                  maxLength={MAX_PLAN_CHARS}
                  placeholder={"# Game title\n\n## Pitch\n\n## Core loop\n\n## Mechanics\n- Radar — range 120 studs — status: done\n\n## Controls\n\n## Art direction"}
                  onChange={(event) => setPlanDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      void savePlan();
                    }
                  }}
                />
                <div className="modal-actions">
                  <span className="notes-meta">{planDraft.length.toLocaleString()} / {MAX_PLAN_CHARS.toLocaleString()} · Markdown · Ctrl+S saves</span>
                  <button className="secondary-action" onClick={() => setPlanDraft(null)}>Cancel</button>
                  <button className="primary-action" disabled={busy || !planDirty} onClick={() => void savePlan()}><Check size={14} /> Save plan</button>
                </div>
              </>}
          </div>
          : <div className="notes-body">
            <p className="notes-hint">Short facts every chat should know: decisions, conventions, where things live, things to avoid. Roqer saves its own here too.</p>
            {notes.memories.length === 0
              ? <p className="notes-empty">Nothing saved yet.</p>
              : <ul className="notes-memories">
                {notes.memories.map((memory) => <li key={memory.id}>
                  {editing?.id === memory.id
                    ? <div className="notes-memory-edit">
                      <textarea value={editing.text} maxLength={MAX_MEMORY_CHARS} autoFocus onChange={(event) => setEditing({ id: memory.id, text: event.target.value })} />
                      <div className="notes-row-actions">
                        <button className="secondary-action" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="primary-action" disabled={busy || !editing.text.trim()} onClick={() => void saveMemory()}>Save</button>
                      </div>
                    </div>
                    : <>
                      <span className="notes-memory-text">{memory.text}</span>
                      <span className="notes-row-actions">
                        <button className="icon-button" aria-label="Edit memory" title="Edit" onClick={() => setEditing({ id: memory.id, text: memory.text })}><Pencil size={14} /></button>
                        <button className="icon-button" aria-label="Remove memory" title="Remove" disabled={busy} onClick={() => void run(() => projectNotes.removeMemory(projectId, memory.id))}><Trash2 size={14} /></button>
                      </span>
                    </>}
                </li>)}
              </ul>}
            <div className="notes-add">
              <input
                value={newMemory}
                maxLength={MAX_MEMORY_CHARS}
                placeholder="Add a memory, e.g. “Characters are R6 only.”"
                onChange={(event) => setNewMemory(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void addMemory(); }}
              />
              <button className="primary-action" disabled={busy || !newMemory.trim()} onClick={() => void addMemory()}><Plus size={14} /> Add</button>
            </div>
          </div>}
    </div>
  </div>;
}
