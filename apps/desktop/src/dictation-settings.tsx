import { useEffect, useState } from "react";
import { DICTATION_MODEL, type DictationModelState } from "../shared/dictation";
import { megabytes } from "./dictation-audio";
import { dictationBridge } from "./platform";
import { SettingsRow } from "./settings-parts";

/**
 * The speech model in Settings: whether it is on this computer, and the way to
 * download it or take it off again. Nothing outside the desktop app, where
 * there is no dictation.
 */
export function DictationSettings() {
  const bridge = dictationBridge();
  const [model, setModel] = useState<DictationModelState>({ kind: "missing" });
  useEffect(() => {
    if (bridge === undefined) return;
    let live = true;
    void bridge.model().then((state) => { if (live) setModel(state); });
    const unsubscribe = bridge.subscribe((state) => { if (live) setModel(state); });
    return () => { live = false; unsubscribe(); };
  }, [bridge]);
  if (bridge === undefined) return null;
  const size = megabytes(DICTATION_MODEL.bytes);
  const detail = model.kind === "ready"
    ? `The speech model (${DICTATION_MODEL.name}, ${size}) is on this computer. What you say is turned into text here and never sent anywhere.`
    : model.kind === "downloading"
      ? `Downloading the speech model: ${megabytes(model.receivedBytes)} of ${megabytes(model.totalBytes)}.`
      : model.kind === "failed"
        ? model.message
        : `Speak a message instead of typing it. It needs a speech model (${DICTATION_MODEL.name}, ${size}) downloaded once from ${DICTATION_MODEL.source}; your voice never leaves this computer.`;
  return <SettingsRow title="Dictation" detail={detail}>
    {model.kind === "ready"
      ? <button type="button" className="small-button" onClick={() => void bridge.removeModel().then(setModel)}>Remove the model</button>
      : model.kind === "downloading"
        ? <button type="button" className="small-button" onClick={() => void bridge.cancelDownload().then(setModel)}>Stop</button>
        : <button type="button" className="small-button" onClick={() => void bridge.download().then(setModel)}>{model.kind === "failed" ? "Try again" : `Download ${size}`}</button>}
  </SettingsRow>;
}
