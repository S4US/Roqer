/**
 * The process that turns dictated audio into text.
 *
 * It runs apart from the main process: the speech model holds close to a
 * gigabyte of memory and a native library, and the main process carries every
 * run's events, so neither a slow transcription nor a crash in native code may
 * reach it. The main process starts this one for the first dictation and stops
 * it after a while without one, which is also what frees the model's memory.
 */
import path from "node:path";

type TranscribeRequest = Readonly<{ id: number; modelPath: string; pcm: ArrayBuffer }>;
type Library = typeof import("transcribe-cpp");
type LoadedModel = Awaited<ReturnType<Library["TranscribeModel"]["load"]>>;

let library: Promise<Library> | null = null;
let model: { path: string; loaded: Promise<LoadedModel> } | null = null;

/**
 * The speech library, with its native files found outside the application's
 * archive: a packaged build keeps them unpacked beside it, because the system
 * cannot load a library from inside an archive.
 */
function loadLibrary(): Promise<Library> {
  library ??= import("transcribe-cpp").then((loaded) => {
    const directory = loaded.artifactDir();
    const archive = `app.asar${path.sep}`;
    if (directory.includes(archive) && process.env.TRANSCRIBE_LIBRARY === undefined) {
      const name = process.platform === "darwin" ? "libtranscribe.dylib" : process.platform === "win32" ? "transcribe.dll" : "libtranscribe.so";
      process.env.TRANSCRIBE_LIBRARY = path.join(directory.replace(archive, `app.asar.unpacked${path.sep}`), name);
    }
    return loaded;
  });
  return library;
}

async function transcribe(request: TranscribeRequest): Promise<string> {
  const loaded = await loadLibrary();
  if (model === null || model.path !== request.modelPath) {
    // The processor only: it transcribes many times faster than speech, and a
    // graphics card is busy with Studio.
    model = { path: request.modelPath, loaded: loaded.TranscribeModel.load(request.modelPath, { backend: "cpu" }) };
  }
  const result = await (await model.loaded).transcribe(new Float32Array(request.pcm));
  return result.text.trim();
}

process.parentPort.on("message", (event) => {
  const request = event.data as TranscribeRequest;
  transcribe(request).then(
    (text) => process.parentPort.postMessage({ id: request.id, ok: true, text }),
    (error: unknown) => {
      // A model that failed to load is tried afresh next time.
      model = null;
      process.parentPort.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) });
    },
  );
});
