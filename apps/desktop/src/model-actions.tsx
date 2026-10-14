import { createContext, useContext } from "react";
import { Check, FolderPlus, Loader2, Send } from "lucide-react";

/**
 * What can be done with a Blender result straight from the chat: keep it in
 * the project's files, or upload it and insert it into the place. Provided by
 * the app, which knows the project, the chat and the Studio place; a preview
 * shown anywhere without it simply offers neither.
 */
export type ModelActions = {
  save(previewId: string): void;
  send(previewId: string): void;
  /** The preview being saved or sent right now, if any. */
  busy: { previewId: string; action: "save" | "send" } | null;
  /** Previews already saved to the project in this session. */
  saved: ReadonlySet<string>;
};

export const ModelActionsContext = createContext<ModelActions | null>(null);

export function ModelActionButtons({ previewId }: { previewId: string }) {
  const actions = useContext(ModelActionsContext);
  if (actions === null) return null;
  const busy = actions.busy?.previewId === previewId ? actions.busy.action : null;
  const saved = actions.saved.has(previewId);
  return <span className="model-actions" role="group" aria-label="Use this model">
    <button type="button" disabled={actions.busy !== null || saved} onClick={() => actions.save(previewId)} title="Keep this model in the project's files, for every chat">
      {busy === "save" ? <Loader2 size={13} className="spin" /> : saved ? <Check size={13} /> : <FolderPlus size={13} />}
      {saved ? "In project files" : "Save to project"}
    </button>
    <button type="button" className="primary" disabled={actions.busy !== null} onClick={() => actions.send(previewId)} title="Upload to Roblox and insert into the place in Studio">
      {busy === "send" ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
      Send to Studio
    </button>
  </span>;
}
