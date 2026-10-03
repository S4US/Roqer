import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";

import type { AssetAttachment } from "./model";
import { clipPreviewUrl, clipStrip } from "./platform";
import {
  formatClipTime,
  MAX_CLIP_SELECTION_SECONDS,
  selectionProblem,
  type AttachmentClip,
  type ClipSelection,
} from "../shared/reference-clip";

/**
 * Choosing the part of a reference clip to send, as a video trimmer.
 *
 * A reference is usually a second or two of effect inside a longer video, and
 * every frame Roqer reads should be one where the effect is happening. The
 * clip plays above a filmstrip of itself; the part to send is the window on
 * the strip, dragged by its ends or moved whole, and playing loops that part,
 * slowed down if asked, so the user sees exactly what Roqer will read.
 *
 * The player streams the attached file from the main process
 * (`roqer-clip://`), which serves only clips the attachment registry issued.
 * The filmstrip comes from the main process's decoder.
 */

const FILMSTRIP_FRAMES = 16;
const MIN_LENGTH = 0.05;
const STEP = 0.01;
const PREVIEW_RATES: readonly number[] = [1, 0.5, 0.25];
/** The step for one frame until playback has measured the clip's own frame rate. */
const DEFAULT_FRAME = 1 / 30;

const SPEEDS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Real speed" },
  { value: 2, label: "½ speed" },
  { value: 4, label: "¼ speed" },
  { value: 8, label: "⅛ speed" },
];

type Thumbnail = { time: number; dataUrl: string };
type DragKind = "start" | "end" | "window" | "seek";
type Drag = { kind: DragKind; pointerX: number; startAt: number; endAt: number; moved: boolean };
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const round = (value: number) => Math.round(value / STEP) * STEP;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const rateLabel = (rate: number) => (rate === 1 ? "1×" : rate === 0.5 ? "½×" : "¼×");

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
  const [filmstrip, setFilmstrip] = useState<Thumbnail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(clip.start);
  const [rate, setRate] = useState(1);
  const [frame, setFrame] = useState(DEFAULT_FRAME);
  const [unplayable, setUnplayable] = useState(false);
  const video = useRef<FrameCallbackVideo>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const selection = useRef({ start, end });
  selection.current = { start, end };

  const url = clipPreviewUrl(attachment.id);
  const isVideo = attachment.mediaType?.startsWith("video/") === true;
  const playable = isVideo && url !== undefined && !unplayable;

  // Focus starts in the dialog, so Space plays and Escape closes straight away.
  useEffect(() => { dialog.current?.focus(); }, []);

  useEffect(() => {
    let current = true;
    clipStrip(attachment.id, FILMSTRIP_FRAMES)
      .then((frames) => { if (current) setFilmstrip(frames); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "The clip could not be read."); });
    return () => { current = false; };
  }, [attachment.id]);

  // While playing: follow the playhead, and loop the chosen part.
  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    const tick = () => {
      const element = video.current;
      if (element !== null) {
        const { start: from, end: to } = selection.current;
        if (element.currentTime >= to - 0.002 || element.currentTime < from - 0.05) element.currentTime = from;
        setTime(element.currentTime);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing]);

  // The clip's own frame interval, measured from the frames playback presents,
  // so stepping moves exactly one frame.
  useEffect(() => {
    const element = video.current;
    if (!playing || element === null || element.requestVideoFrameCallback === undefined) return;
    const deltas: number[] = [];
    let last: number | undefined;
    let handle = 0;
    let active = true;
    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (!active) return;
      if (last !== undefined) {
        const delta = metadata.mediaTime - last;
        if (delta > 0.001 && delta < 0.2) deltas.push(delta);
      }
      last = metadata.mediaTime;
      if (deltas.length >= 12) {
        setFrame([...deltas].sort((a, b) => a - b)[6]);
        return;
      }
      handle = element.requestVideoFrameCallback!(onFrame);
    };
    handle = element.requestVideoFrameCallback(onFrame);
    return () => {
      active = false;
      element.cancelVideoFrameCallback?.(handle);
    };
  }, [playing]);

  useEffect(() => {
    if (video.current !== null) video.current.playbackRate = rate;
  }, [rate]);

  const seek = (to: number) => {
    const at = clamp(to, 0, duration);
    if (video.current !== null) video.current.currentTime = at;
    setTime(at);
  };
  const pause = () => {
    video.current?.pause();
    setPlaying(false);
  };
  const play = async () => {
    const element = video.current;
    if (element === null) return;
    if (element.currentTime < start || element.currentTime >= end - 0.01) element.currentTime = start;
    element.playbackRate = rate;
    try {
      await element.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };
  const toggle = () => {
    if (!playable) return;
    if (playing) pause();
    else void play();
  };
  const step = (frames: number) => {
    pause();
    seek(time + frames * frame);
  };

  /** The selection with one end moved, the other pushed only as far as the limits need. */
  const withStart = (value: number, otherEnd: number): ClipSelection => {
    const from = round(clamp(value, 0, duration - MIN_LENGTH));
    const to = otherEnd - from > MAX_CLIP_SELECTION_SECONDS ? from + MAX_CLIP_SELECTION_SECONDS : otherEnd < from + MIN_LENGTH ? Math.min(duration, from + MIN_LENGTH) : otherEnd;
    return { start: from, end: round(to), slow };
  };
  const withEnd = (value: number, otherStart: number): ClipSelection => {
    const to = round(clamp(value, MIN_LENGTH, duration));
    const from = to - otherStart > MAX_CLIP_SELECTION_SECONDS ? to - MAX_CLIP_SELECTION_SECONDS : otherStart > to - MIN_LENGTH ? Math.max(0, to - MIN_LENGTH) : otherStart;
    return { start: round(from), end: to, slow };
  };
  const apply = (next: ClipSelection) => {
    setStart(next.start);
    setEnd(next.end);
  };

  const timeAt = (clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const kind: DragKind = target.closest("[data-handle='start']") !== null
      ? "start"
      : target.closest("[data-handle='end']") !== null
        ? "end"
        : target.closest(".clip-window") !== null ? "window" : "seek";
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, pointerX: event.clientX, startAt: start, endAt: end, moved: false };
    pause();
    if (kind === "seek") seek(timeAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    if (Math.abs(event.clientX - current.pointerX) > 3) current.moved = true;
    const at = timeAt(event.clientX);
    if (current.kind === "start") {
      const next = withStart(at, current.endAt);
      apply(next);
      seek(next.start);
    } else if (current.kind === "end") {
      const next = withEnd(at, current.startAt);
      apply(next);
      seek(next.end);
    } else if (current.kind === "window" && current.moved) {
      const length = current.endAt - current.startAt;
      const from = round(clamp(current.startAt + at - timeAt(current.pointerX), 0, duration - length));
      apply({ start: from, end: round(from + length), slow });
      seek(from);
    } else if (current.kind === "seek") {
      seek(at);
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    // A click inside the window, rather than a drag, moves the playhead there.
    if (current?.kind === "window" && !current.moved) seek(timeAt(event.clientX));
  };

  const onHandleKey = (edge: "start" | "end") => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (by === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = by * (event.shiftKey ? 0.5 : frame);
    pause();
    const next = edge === "start" ? withStart(start + delta, end) : withEnd(end + delta, start);
    apply(next);
    seek(edge === "start" ? next.start : next.end);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (target.closest("select, input, textarea") !== null) return;
    if (event.key === " " && target.closest("button") === null) {
      event.preventDefault();
      toggle();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && playable) {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  const chosen: ClipSelection = { start, end, slow };
  const problem = selectionProblem(chosen, duration);
  const length = end - start;
  const percent = (value: number) => `${(value / duration) * 100}%`;

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <div className="clip-modal" role="dialog" aria-modal="true" aria-label="Choose the part of the clip to send"
      onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKey} tabIndex={-1} ref={dialog}>
      <div className="clip-modal-head">
        <div>
          <h2>Choose the part to send</h2>
          <span>{attachment.name} · {formatClipTime(duration)}</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
      </div>

      <div className="clip-player">
        {isVideo && url !== undefined && !unplayable
          ? <video
            ref={video}
            src={url}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => { event.currentTarget.currentTime = start; }}
            onEnded={() => { if (playing) void play(); }}
            onError={() => { setUnplayable(true); setPlaying(false); }}
            onClick={toggle}
          />
          : url !== undefined && !isVideo
            ? <img src={url} alt="" />
            : filmstrip?.[0] !== undefined ? <img src={filmstrip[0].dataUrl} alt="" /> : null}
        {playable && !playing && <button type="button" className="clip-player-overlay" onClick={toggle} aria-label="Play the chosen part">
          <span><Play size={26} fill="currentColor" /></span>
        </button>}
        {!isVideo && <div className="clip-player-note">An animated picture plays whole here; the timeline sets the part Roqer reads.</div>}
        {isVideo && unplayable && <div className="clip-player-note">This video cannot play here; choose the part from the frames below.</div>}
      </div>

      {playable && <div className="clip-controls">
        <button type="button" className="clip-control" onClick={toggle} aria-label={playing ? "Pause" : "Play the chosen part"} title={playing ? "Pause (Space)" : "Play the chosen part (Space)"}>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <button type="button" className="clip-control" onClick={() => step(-1)} aria-label="Back one frame" title="Back one frame (←)"><ChevronLeft size={17} /></button>
        <button type="button" className="clip-control" onClick={() => step(1)} aria-label="Forward one frame" title="Forward one frame (→)"><ChevronRight size={17} /></button>
        <span className="clip-clock">{formatClipTime(time)}</span>
        <div className="clip-segmented clip-rate" role="group" aria-label="Preview speed">
          {PREVIEW_RATES.map((value) => <button type="button" key={value} aria-pressed={rate === value} onClick={() => setRate(value)} title={value === 1 ? "Play at normal speed" : `Play at ${value} speed`}>{rateLabel(value)}</button>)}
        </div>
      </div>}

      <div
        className="clip-timeline"
        ref={timeline}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; }}
        title="Drag the ends to trim, or the middle to move the part"
      >
        <div className={`clip-filmstrip${filmstrip === null ? " loading" : ""}`} aria-hidden="true">
          {(filmstrip ?? []).map((thumbnail) => <img key={thumbnail.time} src={thumbnail.dataUrl} alt="" draggable={false} />)}
        </div>
        <div className="clip-dim" style={{ left: 0, width: percent(start) }} />
        <div className="clip-dim" style={{ left: percent(end), right: 0 }} />
        <div className="clip-window" style={{ left: percent(start), width: percent(length) }}>
          <div className="clip-handle start" data-handle="start" role="slider" tabIndex={0} aria-label="Start of the part"
            aria-valuemin={0} aria-valuemax={duration} aria-valuenow={start} aria-valuetext={formatClipTime(start)} onKeyDown={onHandleKey("start")} />
          <div className="clip-handle end" data-handle="end" role="slider" tabIndex={0} aria-label="End of the part"
            aria-valuemin={0} aria-valuemax={duration} aria-valuenow={end} aria-valuetext={formatClipTime(end)} onKeyDown={onHandleKey("end")} />
        </div>
        {playable && <div className="clip-playhead" style={{ left: percent(time) }} aria-hidden="true" />}
      </div>
      <div className="clip-times">
        <span>{formatClipTime(start)}</span>
        <strong>{length.toFixed(2)} s chosen <em>· up to {MAX_CLIP_SELECTION_SECONDS} s</em></strong>
        <span>{formatClipTime(end)}</span>
      </div>
      {error !== null && <div className="attachment-notice" role="alert">{error}</div>}

      <div className="clip-speed-row">
        <div>
          <strong>How fast the video plays</strong>
          <span>For a slowed-down showcase, say how slow, so Roqer's timings come out in real time.</span>
        </div>
        <div className="clip-segmented" role="group" aria-label="How fast the video plays">
          {SPEEDS.map((speed) => <button type="button" key={speed.value} aria-pressed={slow === speed.value} onClick={() => setSlow(speed.value)}>{speed.label}</button>)}
        </div>
      </div>

      <div className="clip-modal-foot">
        <span className={problem === undefined ? "clip-note" : "clip-problem"}>
          {problem ?? (slow === 1 ? "Roqer reads every frame of this part." : `${(length / slow).toFixed(2)} s at real speed.`)}
        </span>
        <button className="secondary-action" onClick={onClose}>Cancel</button>
        <button className="primary-action" disabled={problem !== undefined} onClick={() => onConfirm(chosen)}>Use {length.toFixed(2)} s</button>
      </div>
    </div>
  </div>;
}
