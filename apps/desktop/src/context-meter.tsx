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
export function ContextMeter({ view, modelName, onNewChat }: {
  view: ContextMeterView;
  /** What the picker calls the model the reading is for. */
  modelName: string | null;
  onNewChat: () => void;
}) {
  const reported = view.kind === "reported";
  const tone = reported ? view.tone : "none";
  const filled = reported ? (view.percent ?? 0) / 100 : 0;
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
    </div>}
  </ComposerMenu>;
}
