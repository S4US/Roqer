import { BrowserWindow, ipcMain, utilityProcess, type IpcMainInvokeEvent, type WebContents } from "electron";
import path from "node:path";
import { DictationModelStore } from "../runtime/dictation-model";
import { DictationTranscriber } from "../runtime/dictation-transcriber";
import { DICTATION_MODEL, MAX_DICTATION_SAMPLES, type DictationModelState, type DictationResult } from "../shared/dictation";

/**
 * Dictation in the main process: the speech model's file, the process that
 * transcribes with it, and the calls the window makes to both.
 *
 * The window records and sends samples; nothing here opens a microphone.
 */
export function registerDictation(options: Readonly<{
  /** Roqer's data folder; the model is kept in `dictation` inside it. */
  userData: () => string;
  isTrusted: (sender: WebContents) => boolean;
}>): { stop: () => void } {
  let store: DictationModelStore | null = null;
  const model = (): DictationModelStore => {
    store ??= new DictationModelStore({
      directory: path.join(options.userData(), "dictation"),
      spec: DICTATION_MODEL,
      onChange: (state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send("dictation:model", state);
        }
      },
    });
    return store;
  };

  const transcriber = new DictationTranscriber({
    start: () => {
      const child = utilityProcess.fork(path.join(__dirname, "dictation-worker.mjs"), [], { serviceName: "Roqer dictation" });
      return {
        postMessage: (message) => child.postMessage(message),
        kill: () => { child.kill(); },
        onMessage: (listener) => { child.on("message", listener); },
        onExit: (listener) => { child.on("exit", listener); },
      };
    },
  });

  const trusted = (event: IpcMainInvokeEvent): void => {
    if (!options.isTrusted(event.sender)) throw new Error("This window may not use dictation.");
  };

  ipcMain.handle("dictation:model", (event): Promise<DictationModelState> => {
    trusted(event);
    return model().state();
  });
  ipcMain.handle("dictation:download", (event): Promise<DictationModelState> => {
    trusted(event);
    // Answered at once with where it stands; progress and the end arrive as "dictation:model" events.
    void model().download();
    return model().state();
  });
  ipcMain.handle("dictation:cancel-download", (event): Promise<DictationModelState> => {
    trusted(event);
    return model().cancel();
  });
  ipcMain.handle("dictation:remove-model", async (event): Promise<DictationModelState> => {
    trusted(event);
    // The process holds the file open (it is memory-mapped), so it has to be gone first.
    await transcriber.stopAndWait("The speech model was removed.");
    return model().remove();
  });
  ipcMain.handle("dictation:transcribe", async (event, payload: unknown): Promise<DictationResult> => {
    trusted(event);
    const bytes = payload instanceof ArrayBuffer ? payload : ArrayBuffer.isView(payload) ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : null;
    if (bytes === null || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0 || bytes.byteLength / 4 > MAX_DICTATION_SAMPLES) {
      return { ok: false, message: "The recording could not be read." };
    }
    if ((await model().state()).kind !== "ready") return { ok: false, message: "The speech model is not downloaded yet." };
    return transcriber.transcribe(model().modelPath, new Float32Array(bytes as ArrayBuffer));
  });

  return { stop: () => transcriber.stop() };
}
