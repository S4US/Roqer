/**
 * The script of Roqer's hidden playtest recorder (`playtest-recorder.html`).
 *
 * The main process drives it through `executeJavaScript`, one call at a time,
 * and reads back only numbers, failure codes and base64: never a message, so
 * nothing on the recorded screen can reach the user or the model as text. The
 * window to record is chosen by the main process, which answers this page's
 * `getDisplayMedia` request with that window and nothing else.
 *
 * While it records, the page also keeps a small frame every quarter second,
 * so the frames the model is shown come from the live stream, with exact
 * times, and the recording itself never has to be decoded again.
 */

type FailureCode = "busy" | "denied" | "no-track" | "unsupported" | "not-recording" | "bad-request" | "failed";
type Failure = { error: FailureCode };

type Sample = { time: number; blob: Blob };

type Active = {
  recorder: MediaRecorder;
  stream: MediaStream;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  mimeType: string;
  chunks: Blob[];
  bytes: number;
  maxBytes: number;
  maxSamples: number;
  startedAt: number;
  samples: Sample[];
  sampler: number;
  stopTimer: number;
  stopped: Promise<void>;
  finishing: Promise<void> | null;
  width: number;
  height: number;
};

type Finished = { blob: Blob; durationMs: number; width: number; height: number; samples: Sample[] };

const JPEG_QUALITY = 0.8;
const MIME_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

let active: Active | null = null;
let finished: Finished | null = null;

function failure(error: FailureCode): Failure {
  return { error };
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("no blob")), "image/jpeg", JPEG_QUALITY));
}

function sized(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Keep one small frame of the live stream, at the time it was taken. */
async function sample(): Promise<void> {
  const current = active;
  if (current === null || current.samples.length >= current.maxSamples || current.video.videoWidth === 0) return;
  const time = (performance.now() - current.startedAt) / 1000;
  const size = sized(current.video.videoWidth, current.video.videoHeight, current.canvas.width);
  if (current.canvas.width !== size.width || current.canvas.height !== size.height) {
    current.canvas.width = size.width;
    current.canvas.height = size.height;
  }
  try {
    current.context.drawImage(current.video, 0, 0, current.canvas.width, current.canvas.height);
    const blob = await jpeg(current.canvas);
    if (active === current) current.samples.push({ time, blob });
  } catch {
    // A frame that could not be drawn is simply not kept.
  }
}

/** Stop recording and keep what was recorded; safe to call more than once. */
function finish(): Promise<void> {
  const current = active;
  if (current === null) return Promise.resolve();
  if (current.finishing !== null) return current.finishing;
  current.finishing = (async () => {
    clearInterval(current.sampler);
    clearTimeout(current.stopTimer);
    await sample();
    if (current.recorder.state !== "inactive") {
      try {
        current.recorder.requestData();
        current.recorder.stop();
      } catch {
        // Already stopped by the track ending.
      }
    }
    await Promise.race([current.stopped, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    for (const track of current.stream.getTracks()) track.stop();
    current.video.srcObject = null;
    finished = {
      blob: new Blob(current.chunks, { type: current.mimeType }),
      durationMs: performance.now() - current.startedAt,
      width: current.width,
      height: current.height,
      samples: current.samples,
    };
    if (active === current) active = null;
  })();
  return current.finishing;
}

/**
 * Start recording the window the main process answers the capture request
 * with, for at most `maxMs` and `maxBytes`, keeping a sample frame every
 * `sampleEveryMs` up to `maxSamples`, scaled to `sampleEdge` on the long side.
 */
async function start(frameRate: number, bitsPerSecond: number, maxMs: number, maxBytes: number, edge: number, sampleEveryMs: number, maxSamples: number, sampleEdge: number) {
  if (active !== null) return failure("busy");
  if (![frameRate, bitsPerSecond, maxMs, maxBytes, edge, sampleEveryMs, maxSamples, sampleEdge].every((value) => Number.isFinite(value) && value > 0)) return failure("bad-request");
  finished = null;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: frameRate, max: frameRate }, width: { max: edge }, height: { max: edge } },
      audio: false,
    });
  } catch (error) {
    // The exception's name is one of a closed set, and only its code travels.
    const name = error instanceof DOMException ? error.name : "";
    return failure(name === "NotAllowedError" ? "denied" : name === "NotFoundError" ? "no-track" : name === "OverconstrainedError" ? "bad-request" : "failed");
  }
  const track = stream.getVideoTracks()[0];
  if (track === undefined) {
    for (const each of stream.getTracks()) each.stop();
    return failure("no-track");
  }
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (mimeType === undefined) {
    track.stop();
    return failure("unsupported");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // Sampling then waits for the first frame the element presents.
  }
  const settings = track.getSettings();
  const canvas = document.createElement("canvas");
  canvas.width = sampleEdge;
  canvas.height = sampleEdge;
  const context = canvas.getContext("2d");
  if (context === null) {
    track.stop();
    return failure("failed");
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPerSecond });
  } catch {
    track.stop();
    return failure("unsupported");
  }
  let resolveStopped = () => undefined as void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const current: Active = {
    recorder, stream, video, canvas, context, mimeType,
    chunks: [], bytes: 0, maxBytes, maxSamples,
    startedAt: performance.now(), samples: [],
    sampler: 0, stopTimer: 0, stopped, finishing: null,
    width: settings.width ?? 0, height: settings.height ?? 0,
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    current.chunks.push(event.data);
    current.bytes += event.data.size;
    if (current.bytes >= current.maxBytes) void finish();
  };
  recorder.onstop = () => resolveStopped();
  recorder.onerror = () => void finish();
  track.onended = () => void finish();
  try {
    recorder.start(1_000);
  } catch {
    track.stop();
    return failure("failed");
  }
  active = current;
  current.sampler = window.setInterval(() => void sample(), sampleEveryMs);
  current.stopTimer = window.setTimeout(() => void finish(), maxMs);
  return { ok: true, width: current.width, height: current.height };
}

/** Stop, and say what was recorded: its size, length, frame size and how many sample frames were kept. */
async function stop() {
  if (active !== null) await finish();
  if (finished === null) return failure("not-recording");
  const { width, height } = finished.samples.length > 0 && finished.width === 0
    ? { width: 0, height: 0 }
    : { width: finished.width, height: finished.height };
  return { size: finished.blob.size, durationMs: finished.durationMs, width, height, samples: finished.samples.length };
}

/** `count` bytes of the recording from `from`, as base64. */
async function take(from: number, count: number) {
  if (finished === null) return failure("not-recording");
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(count) || from < 0 || count < 1) return failure("bad-request");
  return { data: await base64(finished.blob.slice(from, from + count)) };
}

/** The sample frame nearest each of `times` (recording seconds), with the time it was really taken. */
async function frames(times: number[]) {
  if (finished === null) return failure("not-recording");
  if (!Array.isArray(times) || times.some((time) => !Number.isFinite(time) || time < 0)) return failure("bad-request");
  const samples = finished.samples;
  if (samples.length === 0) return { frames: [] };
  const picked: { time: number; data: string }[] = [];
  for (const time of times) {
    let nearest = samples[0];
    for (const candidate of samples) if (Math.abs(candidate.time - time) < Math.abs(nearest.time - time)) nearest = candidate;
    picked.push({ time: nearest.time, data: await base64(nearest.blob) });
  }
  return { frames: picked };
}

function clear(): void {
  finished = null;
}

Object.assign(window, { roqerPlaytestRecorder: { start, stop, take, frames, clear } });

// A module of its own: its names stay out of the global scope the decoder page shares with it under the renderer tsconfig.
export {};
