import { ComposerMenu } from "./composer-menus";
import type { ContextMeterView } from "./context-usage";

/** The ring's radius and circumference in its 18-pixel box. */
const RING_RADIUS = 7;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * How full the model's context is, in the composer's corner: a ring and a
 * short figure, and the reported numbers behind them on a click. A chat with
 * nothing reported shows an empty dashed ring instead of a guess.
 */
export function ContextMeter({ view, modelName, onNewChat, compacted, compactedUsage, canCompact, onCompact, compacting = false, modelWritten = false }: {
  view: ContextMeterView;
  /** What the picker calls the model the reading is for. */
  modelName: string | null;
  onNewChat: () => void;
  /** Earlier messages a manual compact has folded into a record; 0 when none. */
  compacted: number;
  /** What the chat was using when it was last compacted; null when nothing was reported then. */
  compactedUsage: string | null;
  canCompact: boolean;
  onCompact: () => void;
  /** Claude is writing the compact summary now. */
  compacting?: boolean;
  /** The compact is Claude summarizing its saved conversation, not the window's own record. */
  modelWritten?: boolean;
}) {
  const reported = view.kind === "reported";
  const tone = reported ? view.tone : "none";
  const filled = reported ? (view.percent ?? 0) / 100 : 0;
  // Shared by both panel states: a chat with no reading can still be compacted.
  const compactRow = (close: () => void) => <div className="context-compact">
    <span>{[
      modelWritten ? "Claude compacts by itself when the context fills. Compact now to have Claude summarize the conversation so far and free up room. Every message stays on screen." : null,
      compacted > 0
        ? `${compacted} earlier ${compacted === 1 ? "message is" : "messages are"} summarized for the model.${compactedUsage === null ? "" : ` ${compactedUsage}`}`
        : modelWritten ? null : "Summarize older messages to free up room.",
    ].filter((line) => line !== null).join(" ")}</span>
    <button type="button" disabled={!canCompact || compacting} onClick={() => { close(); onCompact(); }}>{compacting ? "Compacting…" : "Compact chat"}</button>
  </div>;
  return <ComposerMenu
    className={`context-menu tone-${tone}`}
    label="Context window"
    ariaLabel={view.ariaLabel}
    title={view.ariaLabel}
    chevron={false}
    disabled={false}
    trigger={<span className="context-meter">
      <svg className="context-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className={`context-ring-track${reported && view.percent !== null ? "" : " unknown"}`} cx="9" cy="9" r={RING_RADIUS} />
        {filled > 0 && <circle
          className="context-ring-fill"
          cx="9" cy="9" r={RING_RADIUS}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - filled)}
        />}
      </svg>
      <span className="context-meter-label">{reported ? view.label : "—"}</span>
    </span>}
  >{(close) => view.kind === "none"
    ? <div className="context-panel">
      <strong>Context window</strong>
      <p className="context-footnote">{view.message}</p>
      {compactRow(close)}
    </div>
    : <div className="context-panel">
      <div className="context-panel-head">
        <strong>Context window</strong>
        {view.percent !== null && <span className="context-percent">{view.percent}% used</span>}
      </div>
      {view.percent !== null && <div className="context-bar" aria-hidden="true"><span style={{ width: `${view.percent}%` }} /></div>}
      <div className="context-figures"><span>{view.summary}</span>{view.left !== null && <span>{view.left}</span>}</div>
      {view.advice !== null && <div className="context-advice">
        <span>{view.advice}</span>
        <button type="button" onClick={() => { close(); onNewChat(); }}>New chat</button>
      </div>}
      <dl className="metadata-list">
        <div><dt>Model</dt><dd className="context-model">{modelName ?? "Default model"}</dd></div>
        <div><dt>Window</dt><dd>{view.windowTokens ?? "Not reported"}</dd></div>
        <div><dt>In use</dt><dd>{view.usedTokens}</dd></div>
      </dl>
      <p className="context-footnote">{view.footnote}</p>
      {compactRow(close)}
    </div>}
  </ComposerMenu>;
}
