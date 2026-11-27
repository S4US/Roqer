import { DICTATION_SAMPLE_RATE, MAX_DICTATION_SAMPLES } from "../shared/dictation";

/** How many of the latest sound levels are kept for the recording bar. */
export const LEVEL_COUNT = 28;

/** Samples per level: about 60 ms of sound each. */
const LEVEL_SAMPLES = 960;

/** A recording in progress: its samples so far, and how loud the last moments were. */
export type DictationCapture = Readonly<{
  /** Everything recorded so far, as the speech model takes it (16 kHz mono). A copy. */
  samples: () => Float32Array;
  /** The latest sound levels, oldest first, each from 0 (silence) to 1. */
  levels: () => readonly number[];
  /** How many seconds have been recorded. */
  seconds: () => number;
  /** Let go of the microphone. What was recorded can still be read. */
  stop: () => void;
}>;

/**
 * The worklet that hands the microphone's samples over, block by block. It is
 * loaded from a Blob so it needs no file of its own in the package.
 */
const WORKLET = `
class RoqerDictationCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("roqer-dictation-capture", RoqerDictationCapture);
`;

/** How loud a block is, on a scale that shows speech well: 0 for silence, 1 for loud speech. */
export function soundLevel(block: Float32Array): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < block.length; index += 1) sum += block[index] * block[index];
  const rms = Math.sqrt(sum / block.length);
  // Speech sits around 0.02 to 0.2 RMS; the square root spreads the quiet end.
  return Math.min(1, Math.sqrt(rms / 0.25));
}

/**
 * Collects recorded blocks and keeps the latest sound levels. Apart from the
 * microphone, so it can be tested without one.
 */
export class CaptureBuffer {
  private readonly blocks: Float32Array[] = [];
  private length = 0;
  private readonly recent: number[] = [];
  private pending: Float32Array[] = [];
  private pendingLength = 0;

  /** Add a block. Blocks past the longest dictation are dropped. */
  push(block: Float32Array): void {
    if (this.length >= MAX_DICTATION_SAMPLES) return;
    const taken = this.length + block.length > MAX_DICTATION_SAMPLES ? block.subarray(0, MAX_DICTATION_SAMPLES - this.length) : block;
    this.blocks.push(taken);
    this.length += taken.length;
    this.pending.push(taken);
    this.pendingLength += taken.length;
    if (this.pendingLength >= LEVEL_SAMPLES) {
      const joined = new Float32Array(this.pendingLength);
      let at = 0;
      for (const part of this.pending) { joined.set(part, at); at += part.length; }
      this.recent.push(soundLevel(joined));
      if (this.recent.length > LEVEL_COUNT) this.recent.shift();
      this.pending = [];
      this.pendingLength = 0;
    }
  }

  get full(): boolean {
    return this.length >= MAX_DICTATION_SAMPLES;
  }

  samples(): Float32Array {
    const joined = new Float32Array(this.length);
    let at = 0;
    for (const block of this.blocks) { joined.set(block, at); at += block.length; }
    return joined;
  }

  levels(): readonly number[] {
    return [...this.recent];
  }

  seconds(): number {
    return this.length / DICTATION_SAMPLE_RATE;
  }
}

/**
 * Open the microphone and start recording at the speech model's rate. Rejects
 * when there is no microphone or the system refuses it.
 */
export async function startCapture(): Promise<DictationCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const buffer = new CaptureBuffer();
  let context: AudioContext | null = null;
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => undefined);
    context = null;
  };
  try {
    // The context resamples the microphone to the model's rate.
    context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
    const module = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(module);
    } finally {
      URL.revokeObjectURL(module);
    }
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, "roqer-dictation-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => buffer.push(event.data);
    source.connect(tap);
  } catch (error) {
    release();
    throw error;
  }
  return {
    samples: () => buffer.samples(),
    levels: () => buffer.levels(),
    seconds: () => buffer.seconds(),
    stop: release,
  };
}
