import { DICTATION_SAMPLE_RATE, MAX_DICTATION_SAMPLES } from "../shared/dictation";

/**
 * A recording as the speech model takes it: one channel, 16 kHz, 32-bit float.
 *
 * The recording is decoded by the browser, whatever container the recorder
 * chose, then rendered once more at the model's rate, which also mixes its
 * channels down to one. Anything past the longest dictation is left out.
 */
export async function toDictationSamples(recording: Blob): Promise<Float32Array> {
  const encoded = await recording.arrayBuffer();
  if (encoded.byteLength === 0) return new Float32Array(0);
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(encoded);
  } finally {
    void decoder.close();
  }
  const frames = Math.min(Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE), MAX_DICTATION_SAMPLES);
  if (frames <= 0) return new Float32Array(0);
  const offline = new OfflineAudioContext(1, frames, DICTATION_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** A recording's length as "0:07" or "2:45". */
export function recordingClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A size in megabytes, as a download's progress shows it: "37 MB", "485 MB". */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
