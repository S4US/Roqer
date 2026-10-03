import { useEffect, useRef, useState } from "react";
import { Film, Loader2, X } from "lucide-react";

import type { AssetAttachment } from "./model";
import { clipFrame, clipStrip } from "./platform";
import {
  formatClipTime,
  MAX_CLIP_SELECTION_SECONDS,
  selectionProblem,
  type AttachmentClip,
  type ClipSelection,
} from "../shared/reference-clip";

/**
 * Choosing the part of a reference clip to send.
 *
 * A reference is usually a second or two of effect inside a longer video, and
 * every frame Roqer reads should be one where the effect is happening. The
 * dialog never holds the video: the main process's decoder answers with
 * thumbnails over the whole clip, larger frames at the two ends of the
 * selection, and a strip of the selection itself, so the user can see where
 * the effect starts and ends before anything is read.
 */

const OVERVIEW_FRAMES = 16;
const SELECTION_FRAMES = 10;
const STEP = 0.01;
/** How long the handles must rest before the frames under them are fetched. */
const SETTLE_MS = 250;

const SPEEDS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Real time" },
  { value: 2, label: "Slowed to half speed" },
  { value: 4, label: "Slowed to a quarter" },
  { value: 8, label: "Slowed 8 times" },
];

type Thumbnail = { time: number; dataUrl: string };

const round = (value: number) => Math.round(value / STEP) * STEP;

export function ClipTrimDialog({ attachment, clip, onConfirm, onClose }: {
  attachment: AssetAttachment;
  clip: AttachmentClip;
  onConfirm: (selection: ClipSelection) => void;
  onClose: () => void;
}) {
  const { duration } = clip;
  const [start, setStart] = useState(clip.start);
  const [end, setEnd] = useState(clip.end);
  const [slow, setSlow] = useState(clip.slow);
  const [overview, setOverview] = useState<Thumbnail[] | null>(null);
  const [inside, setInside] = useState<Thumbnail[] | null>(null);
  const [ends, setEnds] = useState<{ start?: string; end?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let current = true;
    clipStrip(attachment.id, OVERVIEW_FRAMES)
      .then((frames) => { if (current) setOverview(frames); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "The clip could not be read."); });
    return () => { current = false; };
  }, [attachment.id]);

  // The frames at the handles and inside the selection, once the handles rest.
  useEffect(() => {
    const id = ++request.current;
    const timer = setTimeout(() => {
      void Promise.all([
        clipFrame(attachment.id, start).catch(() => undefined),
        clipFrame(attachment.id, Math.max(start, end - 0.001)).catch(() => undefined),
        end > start ? clipStrip(attachment.id, SELECTION_FRAMES, { start, end }).catch(() => null) : Promise.resolve(null),
      ]).then(([first, last, strip]) => {
        if (request.current !== id) return;
        setEnds({ start: first, end: last });
        setInside(strip);
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [attachment.id, start, end]);

  const moveStart = (value: number) => {
    const next = round(Math.min(Math.max(0, value), duration - 0.05));
    setStart(next);
    if (end - next > MAX_CLIP_SELECTION_SECONDS) setEnd(round(next + MAX_CLIP_SELECTION_SECONDS));
    else if (end < next + 0.05) setEnd(round(Math.min(duration, next + 0.05)));
  };
  const moveEnd = (value: number) => {
    const next = round(Math.max(Math.min(duration, value), 0.05));
    setEnd(next);
    if (next - start > MAX_CLIP_SELECTION_SECONDS) setStart(round(next - MAX_CLIP_SELECTION_SECONDS));
    else if (start > next - 0.05) setStart(round(Math.max(0, next - 0.05)));
  };
  /** Clicking a thumbnail moves the selection to start there, keeping its length. */
  const startAt = (time: number) => {
    const length = end - start;
    const from = round(Math.max(0, Math.min(time, duration - length)));
    setStart(from);
    setEnd(round(Math.min(duration, from + length)));
  };

  const selection: ClipSelection = { start, end, slow };
  const problem = selectionProblem(selection, duration);
  const length = (end - start) / slow;

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <div className="clip-modal" role="dialog" aria-modal="true" aria-label="Choose the part of the clip to send" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <div><h2>Choose the part to send</h2><span className="clip-modal-subtitle">{attachment.name} · {formatClipTime(duration)}</span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
      </div>
      <p>Roqer reads every frame of this part, up to {MAX_CLIP_SELECTION_SECONDS} seconds, and shows the agent the frames where the clip changes. Start just before the effect and end once it has faded.</p>
      {error !== null && <div className="attachment-notice" role="alert">{error}</div>}
      <div className="clip-strip" aria-label="The whole clip">
        {overview === null
          ? <div className="clip-strip-loading"><Loader2 size={15} /> Reading the clip…</div>
          : overview.map((frame) => <button type="button" key={frame.time} onClick={() => startAt(frame.time)} title={`Start at ${formatClipTime(frame.time)}`}>
            <img src={frame.dataUrl} alt="" />
          </button>)}
        <div className="clip-window" style={{ left: `${(start / duration) * 100}%`, width: `${((end - start) / duration) * 100}%` }} aria-hidden="true" />
      </div>
      <div className="clip-range">
        <label><span>Start {formatClipTime(start)}</span>
          <input type="range" min={0} max={duration} step={STEP} value={start} onChange={(event) => moveStart(Number(event.target.value))} />
        </label>
        <label><span>End {formatClipTime(end)}</span>
          <input type="range" min={0} max={duration} step={STEP} value={end} onChange={(event) => moveEnd(Number(event.target.value))} />
        </label>
      </div>
      <div className="clip-ends">
        <figure>{ends.start ? <img src={ends.start} alt="The frame at the start" /> : <div className="clip-frame-empty"><Film size={18} /></div>}<figcaption>Starts {formatClipTime(start)}</figcaption></figure>
        <figure>{ends.end ? <img src={ends.end} alt="The frame at the end" /> : <div className="clip-frame-empty"><Film size={18} /></div>}<figcaption>Ends {formatClipTime(end)}</figcaption></figure>
      </div>
      <div className="clip-strip selection" aria-label="The chosen part">
        {(inside ?? []).map((frame) => <img key={frame.time} src={frame.dataUrl} alt="" title={formatClipTime(frame.time)} />)}
      </div>
      <label className="clip-speed"><span>How fast the clip plays</span>
        <select value={slow} onChange={(event) => setSlow(Number(event.target.value))}>
          {SPEEDS.map((speed) => <option key={speed.value} value={speed.value}>{speed.label}</option>)}
        </select>
      </label>
      <p className="clip-summary">{problem ?? `${(end - start).toFixed(2)} s of the clip${slow === 1 ? "" : `, ${length.toFixed(2)} s at real speed`}.`}</p>
      <div className="modal-actions">
        <button className="secondary-action" onClick={onClose}>Cancel</button>
        <button className="primary-action" disabled={problem !== undefined} onClick={() => onConfirm(selection)}>Use this part</button>
      </div>
    </div>
  </div>;
}
