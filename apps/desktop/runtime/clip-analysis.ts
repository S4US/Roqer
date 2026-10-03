/**
 * Measurements of a reference clip, taken from its pixels.
 *
 * A grid of frames shows what an effect looks like but is a poor clock: the
 * model cannot tell from a picture whether a flash peaked at 0.15 s or 0.25 s,
 * or whether the fade took half a second or a whole one. Those are the numbers
 * an effect is built from (a particle's lifetime, a transparency curve, when a
 * second layer starts), so Roqer measures them here and sends them as text
 * beside the frames, labelled as measurements.
 *
 * Everything is computed from small frames compared with the clip's own
 * background: the median of its first few frames, or of its last few when the
 * clip opens mid-effect. A pixel has changed when one of its channels moved
 * more than `CHANGE_THRESHOLD` from that background. This is deliberately
 * simple, and it is honest about where it fails: a moving camera changes the
 * whole frame, and is reported as such rather than measured as an effect.
 *
 * Pure: frames in, numbers and lines of text out, so it is tested without
 * Electron. The main process decodes the frames.
 */

/** One frame to measure: small raw pixels, four bytes each, at an effect time. */
export type AnalysisFrame = Readonly<{ time: number; width: number; height: number; pixels: Uint8Array }>;

/** The byte order of `pixels`: Electron's bitmaps are BGRA, a canvas's are RGBA. */
export type PixelOrder = "rgba" | "bgra";

export type ClipColor = Readonly<{ hex: string; share: number }>;

export type ClipPhase = Readonly<{ name: "build-up" | "peak" | "fade"; from: number; to: number; colors: readonly ClipColor[] }>;

/** Part of the frame, as fractions of its width and height. */
export type CropBox = Readonly<{ x: number; y: number; width: number; height: number }>;

export type ClipAnalysis = Readonly<{
  /** False when nothing measurable changed between the frames. */
  active: boolean;
  /** When the change first passes, peaks, falls to half, and last passes its threshold. */
  onset?: number;
  peak?: number;
  half?: number;
  end?: number;
  /** The brightest moment, as mean brightness from 0 (black) to 1 (white), and the background's. */
  brightness?: Readonly<{ time: number; level: number; before: number }>;
  /** The largest share of the frame that changed, when, and the share at the onset. */
  area?: Readonly<{ largest: number; time: number; atOnset: number }>;
  /** Where the clip changes, when that is a part of the frame worth cropping to. */
  crop?: CropBox;
  /** The whole frame changes for much of the clip: a moving camera or a cut. */
  cameraMoves: boolean;
  phases: readonly ClipPhase[];
}>;

/** How far, out of 255, one channel must move from the background for a pixel to count as changed. */
export const CHANGE_THRESHOLD = 32;
/** The share of the peak at which the effect counts as started or ended. */
const EDGE_SHARE = 0.15;
/** The least mean change worth calling activity: below it, compression noise. */
const MIN_ACTIVITY = 0.002;
/** A frame where more than this share changed is changing everywhere. */
const WHOLE_FRAME = 0.6;
/** The share of frames changing everywhere that means the camera moves. */
const CAMERA_FRAMES = 0.4;
/** A crop this large shows little more than the whole frame, so the frame is kept. */
const MAX_CROP_AREA = 0.6;
/** Colours sampled per phase, and the most reported. */
const COLOR_SAMPLES = 6000;
const MAX_COLORS = 3;
const MIN_COLOR_SHARE = 0.1;

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function channels(order: PixelOrder): readonly [number, number, number] {
  return order === "bgra" ? [2, 1, 0] : [0, 1, 2];
}

/** The per-pixel median of a few frames, RGB, as the background. */
function medianBackground(frames: readonly AnalysisFrame[], order: PixelOrder): Float32Array {
  const [ri, gi, bi] = channels(order);
  const count = frames[0].width * frames[0].height;
  const background = new Float32Array(count * 3);
  const values: number[] = [];
  for (let pixel = 0; pixel < count; pixel++) {
    for (const [slot, channel] of [[0, ri], [1, gi], [2, bi]] as const) {
      values.length = 0;
      for (const frame of frames) values.push(frame.pixels[pixel * 4 + channel]);
      values.sort((a, b) => a - b);
      const middle = values.length >> 1;
      background[pixel * 3 + slot] = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    }
  }
  return background;
}

/** Mean absolute difference between neighbouring frames of a group: how much it moves. */
function groupMotion(frames: readonly AnalysisFrame[]): number {
  let total = 0;
  let pairs = 0;
  for (let index = 1; index < frames.length; index++) {
    const a = frames[index - 1].pixels;
    const b = frames[index].pixels;
    let sum = 0;
    for (let byte = 0; byte < a.length; byte++) if ((byte & 3) !== 3) sum += Math.abs(a[byte] - b[byte]);
    total += sum / (a.length * 0.75);
    pairs++;
  }
  return pairs === 0 ? 0 : total / pairs;
}

function smooth(values: readonly number[]): number[] {
  return values.map((_, index) => {
    const window = values.slice(Math.max(0, index - 1), Math.min(values.length, index + 2));
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * The main colours among packed RGB samples, by a median-cut variant: the
 * box of colours with the widest spread is split until there are four, and
 * each box is reported as its mean, with the share of samples it holds.
 */
export function dominantColors(samples: readonly number[], boxes = 4): ClipColor[] {
  if (samples.length === 0) return [];
  const component = (value: number, channel: number) => (value >> (16 - channel * 8)) & 255;
  let groups: number[][] = [[...samples]];
  while (groups.length < boxes) {
    let widest = -1;
    let widestChannel = 0;
    let widestRange = 0;
    groups.forEach((group, index) => {
      if (group.length < 2) return;
      for (let channel = 0; channel < 3; channel++) {
        let low = 255;
        let high = 0;
        for (const value of group) {
          const part = component(value, channel);
          if (part < low) low = part;
          if (part > high) high = part;
        }
        if (high - low > widestRange) {
          widestRange = high - low;
          widest = index;
          widestChannel = channel;
        }
      }
    });
    if (widest < 0 || widestRange < 8) break;
    // Split halfway along the spread rather than at the middle sample, so two
    // distinct colours land in two boxes whatever their shares.
    const group = groups[widest];
    const parts = group.map((value) => component(value, widestChannel));
    const middle = (Math.min(...parts) + Math.max(...parts)) / 2;
    const below = group.filter((_, index) => parts[index] < middle);
    const above = group.filter((_, index) => parts[index] >= middle);
    groups = [...groups.slice(0, widest), below, above, ...groups.slice(widest + 1)];
  }
  return groups
    .map((group) => {
      const mean = [0, 1, 2].map((channel) => group.reduce((sum, value) => sum + component(value, channel), 0) / group.length);
      return { hex: hex(mean[0], mean[1], mean[2]), share: group.length / samples.length };
    })
    .sort((a, b) => b.share - a.share);
}

/** Merges colours that print the same once rounded, so one colour is not listed twice. */
function distinctColors(colors: readonly ClipColor[]): ClipColor[] {
  const merged = new Map<string, number>();
  for (const color of colors) merged.set(color.hex, (merged.get(color.hex) ?? 0) + color.share);
  return [...merged].map(([hexValue, share]) => ({ hex: hexValue, share })).sort((a, b) => b.share - a.share);
}

/** Measure a clip from its frames, in time order, all one size. */
export function analyseClip(frames: readonly AnalysisFrame[], order: PixelOrder): ClipAnalysis {
  const inactive: ClipAnalysis = { active: false, cameraMoves: false, phases: [] };
  if (frames.length < 2) return inactive;
  const { width, height } = frames[0];
  const count = width * height;
  if (count === 0 || frames.some((frame) => frame.width !== width || frame.height !== height || frame.pixels.length !== count * 4)) {
    throw new Error("Every frame measured must be the same size, with four bytes a pixel.");
  }
  const [ri, gi, bi] = channels(order);

  // The background: the quieter end of the clip, which is usually its start.
  const edge = Math.min(6, Math.max(2, Math.ceil(frames.length * 0.1)));
  const first = frames.slice(0, edge);
  const last = frames.slice(-edge);
  const reference = frames.length >= edge * 2 && groupMotion(first) > groupMotion(last) * 2 ? last : first;
  const background = medianBackground(reference, order);
  let backgroundLevel = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    backgroundLevel += luma(background[pixel * 3], background[pixel * 3 + 1], background[pixel * 3 + 2]);
  }
  backgroundLevel /= count * 255;

  const activity: number[] = [];
  const areas: number[] = [];
  const levels: number[] = [];
  const masks: Uint8Array[] = [];
  for (const frame of frames) {
    const mask = new Uint8Array(count);
    let change = 0;
    let changed = 0;
    let level = 0;
    for (let pixel = 0; pixel < count; pixel++) {
      const r = frame.pixels[pixel * 4 + ri];
      const g = frame.pixels[pixel * 4 + gi];
      const b = frame.pixels[pixel * 4 + bi];
      level += luma(r, g, b);
      const difference = Math.max(
        Math.abs(r - background[pixel * 3]),
        Math.abs(g - background[pixel * 3 + 1]),
        Math.abs(b - background[pixel * 3 + 2]),
      );
      if (difference > CHANGE_THRESHOLD) {
        mask[pixel] = 1;
        changed++;
        change += difference;
      }
    }
    masks.push(mask);
    activity.push(change / (count * 255));
    areas.push(changed / count);
    levels.push(level / (count * 255));
  }

  const cameraMoves = areas.filter((area) => area > WHOLE_FRAME).length >= frames.length * CAMERA_FRAMES;
  const brightest = levels.reduce((best, level, index) => (level > levels[best] ? index : best), 0);
  const brightness = levels[brightest] - backgroundLevel >= 0.03
    ? { time: frames[brightest].time, level: levels[brightest], before: backgroundLevel }
    : undefined;

  const curve = smooth(activity);
  const peakIndex = curve.reduce((best, value, index) => (value > curve[best] ? index : best), 0);
  const peakValue = curve[peakIndex];
  if (peakValue < MIN_ACTIVITY) return { ...inactive, ...(brightness === undefined ? {} : { brightness }) };
  if (cameraMoves) return { active: true, cameraMoves, phases: [], ...(brightness === undefined ? {} : { brightness }) };

  const threshold = peakValue * EDGE_SHARE;
  const onsetIndex = curve.findIndex((value) => value >= threshold);
  let endIndex = onsetIndex;
  curve.forEach((value, index) => { if (value >= threshold) endIndex = index; });
  let halfIndex = curve.findIndex((value, index) => index > peakIndex && value < peakValue * 0.5);
  if (halfIndex < 0) halfIndex = endIndex;

  const largestIndex = areas.reduce((best, area, index) => (index >= onsetIndex && index <= endIndex && area > areas[best] ? index : best), onsetIndex);
  const area = { largest: areas[largestIndex], time: frames[largestIndex].time, atOnset: areas[onsetIndex] };

  // Where it changes: pixels that changed in at least two of the active
  // frames (one alone is noise), boxed, padded and kept to a sensible shape.
  const activeFrames = endIndex - onsetIndex + 1;
  const hits = new Uint16Array(count);
  for (let index = onsetIndex; index <= endIndex; index++) {
    const mask = masks[index];
    for (let pixel = 0; pixel < count; pixel++) hits[pixel] += mask[pixel];
  }
  const needed = Math.max(2, Math.ceil(activeFrames * 0.05));
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (hits[y * width + x] < needed) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  let crop: CropBox | undefined;
  if (right >= left && bottom >= top) {
    let boxWidth = right - left + 1;
    let boxHeight = bottom - top + 1;
    const padX = Math.max(boxWidth * 0.1, width * 0.04);
    const padY = Math.max(boxHeight * 0.1, height * 0.04);
    let x0 = left - padX;
    let y0 = top - padY;
    boxWidth += padX * 2;
    boxHeight += padY * 2;
    // No narrower than 15% of the frame, and no longer than 2.5 times its width or height.
    const grow = (size: number, minimum: number) => Math.max(size, minimum);
    const widened = grow(grow(boxWidth, width * 0.15), boxHeight / 2.5);
    const heightened = grow(grow(boxHeight, height * 0.15), boxWidth / 2.5);
    x0 -= (widened - boxWidth) / 2;
    y0 -= (heightened - boxHeight) / 2;
    boxWidth = Math.min(width, widened);
    boxHeight = Math.min(height, heightened);
    x0 = Math.max(0, Math.min(width - boxWidth, x0));
    y0 = Math.max(0, Math.min(height - boxHeight, y0));
    if ((boxWidth * boxHeight) / count < MAX_CROP_AREA) {
      const round = (value: number) => Math.round(value * 1000) / 1000;
      crop = { x: round(x0 / width), y: round(y0 / height), width: round(boxWidth / width), height: round(boxHeight / height) };
    }
  }

  // Colours of what changed, by phase: the build-up to the peak, the peak
  // until it falls to half, and the fade after.
  const spans: { name: ClipPhase["name"]; from: number; to: number }[] = [];
  if (peakIndex > onsetIndex) spans.push({ name: "build-up", from: onsetIndex, to: peakIndex - 1 });
  spans.push({ name: "peak", from: peakIndex, to: Math.max(peakIndex, halfIndex - 1) });
  if (endIndex >= halfIndex && halfIndex > peakIndex) spans.push({ name: "fade", from: halfIndex, to: endIndex });
  const phases = spans.map((span): ClipPhase => {
    let changedPixels = 0;
    for (let index = span.from; index <= span.to; index++) changedPixels += areas[index] * count;
    const step = Math.max(1, Math.floor(changedPixels / COLOR_SAMPLES));
    const samples: number[] = [];
    let seen = 0;
    for (let index = span.from; index <= span.to; index++) {
      const { pixels } = frames[index];
      const mask = masks[index];
      for (let pixel = 0; pixel < count; pixel++) {
        if (mask[pixel] === 0) continue;
        if (seen++ % step !== 0) continue;
        samples.push((pixels[pixel * 4 + ri] << 16) | (pixels[pixel * 4 + gi] << 8) | pixels[pixel * 4 + bi]);
      }
    }
    const colors = distinctColors(dominantColors(samples)).filter((color) => color.share >= MIN_COLOR_SHARE).slice(0, MAX_COLORS);
    return { name: span.name, from: frames[span.from].time, to: frames[span.to].time, colors };
  });

  return {
    active: true,
    onset: frames[onsetIndex].time,
    peak: frames[peakIndex].time,
    half: frames[halfIndex].time,
    end: frames[endIndex].time,
    ...(brightness === undefined ? {} : { brightness }),
    area,
    ...(crop === undefined ? {} : { crop }),
    cameraMoves,
    phases,
  };
}

function seconds(value: number): string {
  return `${value.toFixed(2)} s`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The measurements as lines for the model, each saying what it measured.
 * Times are effect seconds, as the frames were given.
 */
export function describeClipAnalysis(analysis: ClipAnalysis): string[] {
  const lines = ["Measured by Roqer from the frames (approximate: compression, bloom and the background all shift these):"];
  if (analysis.brightness !== undefined) {
    const { time, level, before } = analysis.brightness;
    lines.push(`- Brightness: brightest at ${seconds(time)}, ${percent(level)} of white on average across the frame, from ${percent(before)} before the effect.`);
  }
  if (!analysis.active) {
    lines.push("- Change: none measurable between the frames; the clip may be still, or the effect too faint to measure. Read the frames instead.");
    return lines;
  }
  if (analysis.cameraMoves) {
    lines.push("- Change: the whole frame changes for much of the selection (a moving camera or a cut), so Roqer did not time or crop the effect; read its timing from the frames instead.");
    return lines;
  }
  const { onset, peak, half, end, area, crop } = analysis;
  if (onset !== undefined && peak !== undefined && half !== undefined && end !== undefined) {
    lines.push(`- Timing (how much of the frame differs from the background, and by how much): starts at ${seconds(onset)}, peaks at ${seconds(peak)}, falls to half by ${seconds(half)} and is gone by ${seconds(end)}.`);
  }
  if (area !== undefined) {
    lines.push(`- Size: covers up to ${percent(area.largest)} of the frame, at ${seconds(area.time)} (${percent(area.atOnset)} as it starts).`);
  }
  const colored = analysis.phases.filter((phase) => phase.colors.length > 0);
  if (colored.length > 0) {
    const parts = colored.map((phase) => `${phase.name} (${seconds(phase.from)}-${seconds(phase.to)}) ${phase.colors.map((color) => `${color.hex} ${percent(color.share)}`).join(", ")}`);
    lines.push(`- Colours of what changed, most first: ${parts.join("; ")}.`);
  }
  if (crop !== undefined) {
    lines.push(`- Framing: the frames are cropped to where the clip changes, ${percent(crop.width)} of the frame's width and ${percent(crop.height)} of its height, ${crop.x + crop.width / 2 < 0.4 ? "left of" : crop.x + crop.width / 2 > 0.6 ? "right of" : "around"} the middle.`);
  }
  return lines;
}
