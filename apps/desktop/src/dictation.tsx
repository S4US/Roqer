import { Download, Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DICTATION_MODEL, MAX_DICTATION_SECONDS, type DictationModelState } from "../shared/dictation";
import { megabytes, recordingClock, toDictationSamples } from "./dictation-audio";
import { dictationBridge } from "./platform";

type Phase = "idle" | "recording" | "transcribing";

/**
 * Dictation for the message box: record, transcribe on this computer, hand the
 * words over. The speech model is downloaded the first time, once the person
 * has seen what it is and agreed.
 *
 * One click starts recording and the next stops it; the words then arrive
 * through `onText`. Recording also stops by itself at the longest dictation.
 */
export function useDictation(onText: (text: string) => void) {
  const bridge = dictationBridge();
  const [model, setModel] = useState<DictationModelState>({ kind: "missing" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Whether the dialog about the speech model is open. */
  const [asking, setAsking] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    if (bridge === undefined) return;
    let live = true;
    void bridge.model().then((state) => { if (live) setModel(state); });
    const unsubscribe = bridge.subscribe((state) => { if (live) setModel(state); });
    return () => { live = false; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = (Date.now() - started) / 1_000;
      setSeconds(elapsed);
      if (elapsed >= MAX_DICTATION_SECONDS) recorder.current?.stop();
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  // Leaving the window's page with the microphone open would keep it open.
  useEffect(() => () => { discard.current = true; recorder.current?.stop(); }, []);

  const record = useCallback(async () => {
    if (bridge === undefined) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("Roqer could not use the microphone. Check that one is plugged in and that Windows lets desktop apps use it.");
      return;
    }
    const chunks: Blob[] = [];
    const taking = new MediaRecorder(stream);
    discard.current = false;
    taking.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    taking.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recorder.current = null;
      if (discard.current) { setPhase("idle"); return; }
      setPhase("transcribing");
      void (async () => {
        try {
          const samples = await toDictationSamples(new Blob(chunks, { type: taking.mimeType }));
          const result = await bridge.transcribe(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer);
          if (!result.ok) setError(result.message);
          else if (result.text === "") setError("No words were heard in that recording.");
          else onTextRef.current(result.text);
        } catch {
          setError("The recording could not be read.");
        } finally {
          setPhase("idle");
        }
      })();
    };
    recorder.current = taking;
    setSeconds(0);
    setPhase("recording");
    taking.start();
  }, [bridge]);

  /** The microphone button: start, stop, or first ask about the speech model. */
  const toggle = useCallback(() => {
    if (phase === "recording") { recorder.current?.stop(); return; }
    if (phase === "transcribing") return;
    if (model.kind !== "ready") { setAsking(true); return; }
    void record();
  }, [phase, model.kind, record]);

  /** Stop recording and throw the recording away. */
  const cancel = useCallback(() => {
    if (phase !== "recording") return;
    discard.current = true;
    recorder.current?.stop();
  }, [phase]);

  return {
    available: bridge !== undefined,
    model, phase, seconds, error, asking,
    toggle, cancel,
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

/** The microphone button in the message box's row of controls. */
export function DictationButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  if (!dictation.available) return null;
  if (dictation.phase === "recording") {
    return <span className="dictation-recording" role="status">
      <button type="button" className="dictation-button recording" onClick={dictation.toggle} aria-label="Stop dictating and write what was said" title="Stop and write what was said"><Square size={11} fill="currentColor" aria-hidden="true" /></button>
      <span className="dictation-clock">{recordingClock(dictation.seconds)}</span>
      <button type="button" className="icon-button dictation-discard" onClick={dictation.cancel} aria-label="Discard this recording" title="Discard this recording"><X size={14} /></button>
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
        ? <p>The speech model is on this computer. Press the microphone, speak, and press it again: what you said is written in the message box.</p>
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
