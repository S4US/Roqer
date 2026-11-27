import { Check, Download, Loader2, Mic, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DICTATION_MODEL, MAX_DICTATION_SECONDS, type DictationModelState } from "../shared/dictation";
import { megabytes, recordingClock } from "./dictation-audio";
import { LEVEL_COUNT, startCapture, type DictationCapture } from "./dictation-capture";
import { dictationBridge } from "./platform";

type Phase = "idle" | "recording" | "transcribing";

/** What to check when the microphone cannot be opened, in the words of the system it runs on. */
const MICROPHONE_REFUSED = (() => {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const where = /Windows/.test(agent)
    ? "that Windows lets desktop apps use it (Settings, Privacy & security, Microphone)"
    : /Mac/.test(agent)
      ? "that Roqer may use it (System Settings, Privacy & Security, Microphone)"
      : "that the system lets Roqer use it";
  return `Roqer could not use the microphone. Check that one is plugged in and ${where}.`;
})();

/**
 * Dictation for the message box: record, transcribe on this computer, hand the
 * words over. The speech model is downloaded the first time, once the person
 * has seen what it is and agreed.
 *
 * The microphone button starts recording. The recording bar then shows that it
 * is listening (a clock, and the sound coming in) and offers to keep what was
 * said or throw it away; the words arrive through `onText` once it is kept.
 * Recording also stops by itself at the longest dictation.
 */
export function useDictation(onText: (text: string) => void) {
  const bridge = dictationBridge();
  const [model, setModel] = useState<DictationModelState>({ kind: "missing" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Whether the dialog about the speech model is open. */
  const [asking, setAsking] = useState(false);
  const capture = useRef<DictationCapture | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    if (bridge === undefined) return;
    let current = true;
    void bridge.model().then((state) => { if (current) setModel(state); });
    const unsubscribe = bridge.subscribe((state) => { if (current) setModel(state); });
    return () => { current = false; unsubscribe(); };
  }, [bridge]);

  // Leaving the window's page with the microphone open would keep it open.
  useEffect(() => () => { capture.current?.stop(); capture.current = null; }, []);

  /** Stop recording and write what was said. */
  const finish = useCallback(async () => {
    const taken = capture.current;
    if (taken === null || bridge === undefined) return;
    capture.current = null;
    taken.stop();
    setPhase("transcribing");
    try {
      const samples = taken.samples();
      const result = samples.length === 0
        ? { ok: false as const, message: "Nothing was recorded." }
        : await bridge.transcribe(samples.buffer as ArrayBuffer);
      if (!result.ok) setError(result.message);
      else if (result.text === "") setError("No words were heard in that recording.");
      else onTextRef.current(result.text);
    } catch {
      setError("The recording could not be transcribed.");
    } finally {
      setPhase("idle");
    }
  }, [bridge]);

  // While recording: the clock and the sound level.
  useEffect(() => {
    if (phase !== "recording") return;
    // The clock is the wall's, not a count of samples: sound can arrive in bursts.
    const started = Date.now();
    const meter = window.setInterval(() => {
      const taken = capture.current;
      if (taken === null) return;
      const elapsed = (Date.now() - started) / 1_000;
      setSeconds(elapsed);
      setLevels(taken.levels());
      if (elapsed >= MAX_DICTATION_SECONDS || taken.seconds() >= MAX_DICTATION_SECONDS) void finish();
    }, 70);
    return () => window.clearInterval(meter);
  }, [phase, finish]);

  const record = useCallback(async () => {
    if (bridge === undefined) return;
    setError(null);
    try {
      capture.current = await startCapture();
    } catch {
      setError(MICROPHONE_REFUSED);
      return;
    }
    setSeconds(0);
    setLevels([]);
    setPhase("recording");
  }, [bridge]);

  /** The microphone button: start, or first ask about the speech model. While recording, stop and keep the words. */
  const toggle = useCallback(() => {
    if (phase === "recording") { void finish(); return; }
    if (phase === "transcribing") return;
    if (model.kind !== "ready") { setAsking(true); return; }
    void record();
  }, [phase, model.kind, record, finish]);

  /** Stop recording and throw the recording away. */
  const cancel = useCallback(() => {
    if (phase !== "recording") return;
    capture.current?.stop();
    capture.current = null;
    setPhase("idle");
  }, [phase]);

  /** Let go of the microphone and say nothing about it: what the box holds stays as it is. */
  const abandon = useCallback(() => {
    if (capture.current === null) return;
    capture.current.stop();
    capture.current = null;
    setPhase("idle");
  }, []);

  return {
    available: bridge !== undefined,
    model, phase, seconds, levels, error, asking,
    toggle, cancel, abandon,
    dismissError: () => setError(null),
    closeDialog: () => setAsking(false),
    download: () => { void bridge?.download().then(setModel); },
    cancelDownload: () => { void bridge?.cancelDownload().then(setModel); },
    removeModel: () => { void bridge?.removeModel().then(setModel); },
    /** The model became ready while its dialog was open: go straight to recording. */
    recordNow: () => { setAsking(false); void record(); },
  };
}

export type Dictation = ReturnType<typeof useDictation>;

/**
 * Dictation in the message box's row of controls: a microphone at rest, and
 * while it records a bar with what can be done and how it is going: discard,
 * the clock, the sound coming in, and keep.
 */
export function DictationButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  if (!dictation.available) return null;
  if (dictation.phase === "recording") {
    // Always the same number of bars, so the bar does not grow as sound arrives.
    const bars = [...Array.from({ length: Math.max(0, LEVEL_COUNT - dictation.levels.length) }, () => 0), ...dictation.levels];
    return <span className="dictation-recording" role="group" aria-label="Dictating">
      <button type="button" className="icon-button dictation-discard" onClick={dictation.cancel} aria-label="Discard what was said" title="Discard (Esc)"><X size={15} /></button>
      <span className="dictation-dot" aria-hidden="true" />
      <span className="dictation-clock" role="timer">{recordingClock(dictation.seconds)}</span>
      <span className="dictation-levels" aria-hidden="true">
        {bars.map((level, index) => <i key={index} style={{ height: `${Math.round(3 + level * 15)}px` }} />)}
      </span>
      <button type="button" className="dictation-confirm" onClick={dictation.toggle} aria-label="Stop and keep what was said" title="Stop and keep what was said (Enter)"><Check size={17} aria-hidden="true" /></button>
    </span>;
  }
  if (dictation.phase === "transcribing") {
    return <span className="dictation-button busy" role="status" aria-label="Writing what was said" title="Writing what was said"><Loader2 size={16} className="spin" aria-hidden="true" /></span>;
  }
  return <button type="button" className="dictation-button" onClick={dictation.toggle} disabled={disabled} aria-label="Dictate" title="Dictate: speak, and Roqer writes it here"><Mic size={17} aria-hidden="true" /></button>;
}

/**
 * Shown before the first dictation: what the speech model is, where it comes
 * from and how big it is, then its download. Nothing is fetched until the
 * person presses Download.
 */
export function DictationSetup({ dictation }: { dictation: Dictation }) {
  const { model } = dictation;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape") dictation.closeDialog(); };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [dictation]);
  if (!dictation.asking) return null;
  const downloading = model.kind === "downloading";
  const share = downloading ? Math.min(1, model.receivedBytes / model.totalBytes) : 0;
  return <div className="modal-backdrop" role="presentation" onMouseDown={dictation.closeDialog}>
    <div className="name-modal dictation-setup" role="dialog" aria-modal="true" aria-label="Set up dictation" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><h2>{model.kind === "ready" ? "Dictation is ready" : "Set up dictation"}</h2></div><button className="icon-button" onClick={dictation.closeDialog} aria-label="Close"><X size={19} /></button></div>
      {model.kind === "ready"
        ? <p>The speech model is on this computer. Press the microphone, speak, then keep what you said: it is written in the message box.</p>
        : <p>Dictation turns what you say into text on this computer: your voice is never sent anywhere. It needs a speech model, downloaded once.</p>}
      <dl className="dictation-facts">
        <div><dt>Model</dt><dd>{DICTATION_MODEL.name}, by {DICTATION_MODEL.publisher} ({DICTATION_MODEL.license})</dd></div>
        <div><dt>Languages</dt><dd>25 European languages, English and French among them, found automatically</dd></div>
        <div><dt>Download</dt><dd>{megabytes(DICTATION_MODEL.bytes)}, from {DICTATION_MODEL.source}</dd></div>
      </dl>
      {downloading && <div className="dictation-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Downloading the speech model">
        <span style={{ width: `${share * 100}%` }} />
      </div>}
      {downloading && <p className="dictation-progress-note">{megabytes(model.receivedBytes)} of {megabytes(model.totalBytes)}</p>}
      {model.kind === "failed" && <p className="dictation-problem" role="alert">{model.message}</p>}
      <div className="modal-actions">
        {model.kind === "ready"
          ? <>
            <button className="secondary-action" onClick={dictation.removeModel}>Remove the model</button>
            <button className="primary-action" autoFocus onClick={dictation.recordNow}><Mic size={15} /> Start dictating</button>
          </>
          : downloading
            ? <button className="secondary-action" onClick={dictation.cancelDownload}>Stop the download</button>
            : <>
              <button className="secondary-action" onClick={dictation.closeDialog}>Not now</button>
              <button className="primary-action" autoFocus onClick={dictation.download}><Download size={15} /> {model.kind === "failed" ? "Try again" : `Download ${megabytes(DICTATION_MODEL.bytes)}`}</button>
            </>}
      </div>
    </div>
  </div>;
}
