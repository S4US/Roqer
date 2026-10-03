/**
 * The script of Roqer's hidden clip decoder (`clip-decoder.html`).
 *
 * The main process drives it through `executeJavaScript`, one call at a time,
 * and reads back only numbers, failure codes and base64 JPEG frames: never a
 * message, so nothing a crafted video makes this page say can reach the user
 * or the model as text. Video plays through Chromium's own decoders in a
 * `<video>` element; GIF, animated WebP and APNG through `ImageDecoder`.
 *
 * Reading a selection plays it at normal speed and keeps each frame as it is
 * presented (`requestVideoFrameCallback`), which reads every frame of a
 * 60-frames-a-second clip in real time, where seeking to each costs a decode
 * from the previous keyframe. Frames playback skips are then filled by
 * seeking to the middle of each missing frame, where a seek is exact.
 */

type FailureCode = "unsupported" | "no-video" | "decode" | "timeout" | "not-animated" | "bad-request";
type Failure = { error: FailureCode };
type EncodedFrame = { time: number; data: string };

/** The parts of WebCodecs' ImageDecoder this page uses; the DOM library has no types for it. */
type DecodedImage = { image: CanvasImageSource & { timestamp: number; duration: number | null; close(): void } };
type AnimatedImageDecoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
  completed: Promise<void>;
  decode(options: { frameIndex: number }): Promise<DecodedImage>;
  close(): void;
};
type ImageDecoderConstructor = new (init: { data: Uint8Array; type: string }) => AnimatedImageDecoder;

type VideoFrameMetadata = { mediaTime: number };
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback(callback: (now: number, metadata: VideoFrameMetadata) => void): number;
};

const JPEG_QUALITY = 0.85;
/** The most frames a selection's gaps are filled with by seeking. */
const MAX_FILLS = 120;

/** Frames read by the last capture, until the main process takes them. */
let held: { time: number; blob: Blob }[] = [];

function failure(error: FailureCode): Failure {
  return { error };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "error" in value;
}

function sized(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasFor(width: number, height: number, edge: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const size = sized(width, height, edge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (context === null) throw failure("decode");
  return { canvas, context };
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(failure("decode")) : resolve(blob)), "image/jpeg", JPEG_QUALITY));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(failure("decode"));
    reader.readAsDataURL(blob);
  });
}

function bytesOf(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Answers with a failure code whatever went wrong, so nothing else ever leaves the page. */
async function guarded<T>(work: () => Promise<T>): Promise<T | Failure> {
  try {
    return await work();
  } catch (error) {
    return isFailure(error) ? error : failure("decode");
  }
}

// -- Video --------------------------------------------------------------------

function mediaFailure(video: HTMLVideoElement): Failure {
  // MEDIA_ERR_SRC_NOT_SUPPORTED: no demuxer or decoder for it (ProRes, or HEVC without the GPU's).
  return failure(video.error?.code === 4 ? "unsupported" : "decode");
}

function release(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function once(video: HTMLVideoElement, event: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(failure("timeout")); }, timeoutMs);
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(mediaFailure(video)); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
    };
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

async function openVideo(url: string): Promise<FrameCallbackVideo> {
  const video = document.createElement("video") as FrameCallbackVideo;
  video.muted = true;
  video.preload = "auto";
  const loaded = once(video, "loadeddata");
  video.src = url;
  try {
    await loaded;
    if (video.videoWidth === 0 || video.videoHeight === 0) throw failure("no-video");
    // A recording made without a duration in its header (as some WebM
    // recorders write) reports Infinity until it has been read to its end.
    if (!Number.isFinite(video.duration)) {
      const known = once(video, "seeked");
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await known;
      if (!Number.isFinite(video.duration)) throw failure("decode");
    }
    return video;
  } catch (error) {
    release(video);
    throw error;
  }
}

async function seek(video: HTMLVideoElement, time: number): Promise<void> {
  const seeked = once(video, "seeked");
  video.currentTime = Math.max(0, Math.min(video.duration, time));
  await seeked;
}

async function probeVideo(url: string) {
  return guarded(async () => {
    const video = await openVideo(url);
    try {
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    } finally {
      release(video);
    }
  });
}

async function stripVideo(url: string, times: number[], edge: number) {
  return guarded(async () => {
    const video = await openVideo(url);
    try {
      const { canvas, context } = canvasFor(video.videoWidth, video.videoHeight, edge);
      const frames: EncodedFrame[] = [];
      for (const time of times) {
        await seek(video, time);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({ time: video.currentTime, data: await base64(await jpeg(canvas)) });
      }
      return { frames };
    } finally {
      release(video);
    }
  });
}

/**
 * Read `start`-`end` of a video at up to `rate` frames a second and hold the
 * frames: played through at normal speed, then any frames playback skipped
 * filled in by seeking.
 */
async function captureVideo(url: string, start: number, end: number, edge: number, rate: number, budgetMs: number) {
  return guarded(async () => {
    held = [];
    const deadline = Date.now() + budgetMs;
    const video = await openVideo(url);
    try {
      const { canvas, context } = canvasFor(video.videoWidth, video.videoHeight, edge);
      const keep = async (time: number) => {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        held.push({ time, blob: await jpeg(canvas) });
      };
      const spacing = 1 / rate;
      await seek(video, start);
      const presented: number[] = [];
      const pending: Promise<void>[] = [];
      let next = -Infinity;
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          video.removeEventListener("ended", finish);
          video.removeEventListener("error", failed);
          video.pause();
          resolve();
        };
        const failed = () => {
          finished = true;
          clearTimeout(timer);
          video.pause();
          reject(mediaFailure(video));
        };
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now() - 5_000));
        const step = (_now: number, metadata: VideoFrameMetadata) => {
          if (finished) return;
          const time = metadata.mediaTime;
          if (time > end + 0.0005) { finish(); return; }
          if (time >= start - 0.0005) {
            presented.push(time);
            // A frame is kept once a slot's worth of time has passed since the last.
            if (time >= next - spacing * 0.25) {
              next = time + spacing;
              pending.push(keep(time));
            }
          }
          video.requestVideoFrameCallback(step);
        };
        video.addEventListener("ended", finish);
        video.addEventListener("error", failed);
        video.requestVideoFrameCallback(step);
        video.play().catch(failed);
      });
      await Promise.all(pending);

      // The frame interval the clip actually has, and the one kept at.
      const gaps = presented.slice(1).map((time, index) => time - presented[index]!).filter((gap) => gap > 0).sort((a, b) => a - b);
      const native = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : spacing;
      const kept = Math.max(native, native * Math.round(spacing / native)) || spacing;
      const fills: number[] = [];
      const times = held.map((frame) => frame.time).sort((a, b) => a - b);
      const bounds = [start - kept, ...times, end + kept * 0.5];
      for (let index = 1; index < bounds.length; index++) {
        const from = bounds[index - 1]!;
        const to = bounds[index]!;
        for (let slot = from + kept; slot < to - kept * 0.5 && slot <= end; slot += kept) {
          if (slot >= start - 0.0005) fills.push(slot);
        }
      }
      for (const time of fills.slice(0, MAX_FILLS)) {
        if (Date.now() > deadline) break;
        // The middle of the missing frame, where a seek lands on it exactly.
        await seek(video, time + native / 2);
        await keep(time);
      }
      held.sort((a, b) => a.time - b.time);
      return { count: held.length, nativeRate: native > 0 ? 1 / native : rate };
    } finally {
      release(video);
    }
  });
}

// -- Animated pictures ----------------------------------------------------------

type ImageFrame = { index: number; time: number; duration: number };

async function openImage(data: string, type: string): Promise<{ decoder: AnimatedImageDecoder; frames: ImageFrame[]; width: number; height: number }> {
  const Decoder = (globalThis as unknown as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
  if (Decoder === undefined) throw failure("unsupported");
  const decoder = new Decoder({ data: bytesOf(data), type });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (track === null || track.frameCount < 2) throw failure("not-animated");
    const frames: ImageFrame[] = [];
    let time = 0;
    let width = 0;
    let height = 0;
    for (let index = 0; index < track.frameCount; index++) {
      const { image } = await decoder.decode({ frameIndex: index });
      // A frame with no delay is shown for a tenth of a second, as browsers play it.
      const duration = image.duration !== null && image.duration > 0 ? image.duration / 1_000_000 : 0.1;
      const source = image as unknown as { displayWidth: number; displayHeight: number };
      width = source.displayWidth;
      height = source.displayHeight;
      image.close();
      frames.push({ index, time, duration });
      time += duration;
    }
    return { decoder, frames, width, height };
  } catch (error) {
    decoder.close();
    throw error;
  }
}

/** The frame showing at `time`. */
function frameAt(frames: readonly ImageFrame[], time: number): ImageFrame {
  return frames.find((frame) => time < frame.time + frame.duration) ?? frames[frames.length - 1]!;
}

async function drawImageFrame(decoder: AnimatedImageDecoder, index: number, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): Promise<void> {
  const { image } = await decoder.decode({ frameIndex: index });
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    image.close();
  }
}

async function probeImage(data: string, type: string) {
  return guarded(async () => {
    const { decoder, frames, width, height } = await openImage(data, type);
    decoder.close();
    const last = frames[frames.length - 1]!;
    return { duration: last.time + last.duration, width, height, frames: frames.length };
  });
}

async function stripImage(data: string, type: string, times: number[], edge: number) {
  return guarded(async () => {
    const { decoder, frames, width, height } = await openImage(data, type);
    try {
      const { canvas, context } = canvasFor(width, height, edge);
      const out: EncodedFrame[] = [];
      for (const time of times) {
        const frame = frameAt(frames, time);
        await drawImageFrame(decoder, frame.index, canvas, context);
        out.push({ time: frame.time, data: await base64(await jpeg(canvas)) });
      }
      return { frames: out };
    } finally {
      decoder.close();
    }
  });
}

async function captureImage(data: string, type: string, start: number, end: number, edge: number, rate: number) {
  return guarded(async () => {
    held = [];
    const { decoder, frames, width, height } = await openImage(data, type);
    try {
      const { canvas, context } = canvasFor(width, height, edge);
      let next = -Infinity;
      // Every frame shown during the selection, from the one already showing at its start.
      const shown = frames.filter((frame) => frame.time + frame.duration > start + 0.0005 && frame.time <= end + 0.0005);
      for (const frame of shown) {
        const time = Math.max(frame.time, start);
        if (time < next - 0.25 / rate) continue;
        next = time + 1 / rate;
        await drawImageFrame(decoder, frame.index, canvas, context);
        held.push({ time, blob: await jpeg(canvas) });
      }
      const native = frames.reduce((sum, frame) => sum + frame.duration, 0) / frames.length;
      return { count: held.length, nativeRate: 1 / native };
    } finally {
      decoder.close();
    }
  });
}

// -- Handing frames over ----------------------------------------------------------

async function take(from: number, count: number) {
  return guarded(async () => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(count) || from < 0 || count < 1) throw failure("bad-request");
    const frames: EncodedFrame[] = [];
    for (const frame of held.slice(from, from + count)) frames.push({ time: frame.time, data: await base64(frame.blob) });
    return { frames };
  });
}

function clear(): void {
  held = [];
}

Object.assign(window, {
  roqerClipDecoder: { probeVideo, stripVideo, captureVideo, probeImage, stripImage, captureImage, take, clear },
});
