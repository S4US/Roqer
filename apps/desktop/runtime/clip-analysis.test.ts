import assert from "node:assert/strict";
import test from "node:test";

import { analyseClip, describeClipAnalysis, dominantColors, type AnalysisFrame } from "./clip-analysis";

const WIDTH = 64;
const HEIGHT = 36;
const BACKGROUND: readonly [number, number, number] = [30, 30, 40];

type Paint = (x: number, y: number) => readonly [number, number, number] | undefined;

/** A frame of the background with `paint` drawn over it, in RGBA or BGRA. */
function frame(time: number, paint: Paint = () => undefined, order: "rgba" | "bgra" = "rgba"): AnalysisFrame {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = paint(x, y) ?? BACKGROUND;
      const offset = (y * WIDTH + x) * 4;
      pixels.set(order === "rgba" ? [r, g, b, 255] : [b, g, r, 255], offset);
    }
  }
  return { time, width: WIDTH, height: HEIGHT, pixels };
}

/**
 * A burst right of the middle: nothing for 0.2 s, then a disc that grows for
 * 0.3 s, white at its core and orange outside, then fades back into the
 * background over 0.5 s, at 30 frames a second.
 */
function burst(order: "rgba" | "bgra" = "rgba"): AnalysisFrame[] {
  const frames: AnalysisFrame[] = [];
  for (let index = 0; index < 40; index++) {
    const time = index / 30;
    let paint: Paint = () => undefined;
    if (time >= 0.2 && time < 1.0) {
      const radius = time < 0.5 ? 2 + ((time - 0.2) / 0.3) * 8 : 10;
      const strength = time < 0.5 ? 1 : Math.max(0, 1 - (time - 0.5) / 0.5);
      paint = (x, y) => {
        const distance = Math.hypot(x - 44, y - 18);
        if (distance > radius) return undefined;
        const color: readonly [number, number, number] = distance < radius * 0.4 ? [255, 255, 255] : [255, 140, 40];
        return color.map((channel, slot) => Math.round(BACKGROUND[slot]! + (channel - BACKGROUND[slot]!) * strength)) as unknown as [number, number, number];
      };
    }
    frames.push(frame(time, paint, order));
  }
  return frames;
}

test("a burst is timed from where it starts to where it is gone, and cropped to where it is", () => {
  const analysis = analyseClip(burst(), "rgba");
  assert.equal(analysis.active, true);
  assert.equal(analysis.cameraMoves, false);
  assert.ok(analysis.onset! >= 0.19 && analysis.onset! <= 0.27, `onset ${analysis.onset}`);
  assert.ok(analysis.peak! >= 0.43 && analysis.peak! <= 0.6, `peak ${analysis.peak}`);
  assert.ok(analysis.half! > analysis.peak! && analysis.half! <= 0.85, `half ${analysis.half}`);
  assert.ok(analysis.end! >= 0.8 && analysis.end! < 1.0, `end ${analysis.end}`);
  assert.ok(analysis.area!.largest > 0.1 && analysis.area!.largest < 0.25);
  assert.ok(analysis.area!.atOnset < analysis.area!.largest);
  // The disc is right of the middle, so the crop is too, and smaller than the frame.
  const crop = analysis.crop!;
  assert.ok(crop.x + crop.width / 2 > 0.6, JSON.stringify(crop));
  assert.ok(crop.width < 0.7 && crop.height < 1);
  assert.ok(analysis.brightness!.level > analysis.brightness!.before);
  // White and orange are what changed as it grows; once it fades, the orange
  // darkens toward the background.
  assert.deepEqual(analysis.phases.map((phase) => phase.name), ["build-up", "peak", "fade"]);
  const growing = analysis.phases[0]!.colors.map((color) => color.hex);
  assert.ok(growing.includes("#FFFFFF"), growing.join(","));
  assert.ok(growing.includes("#FF8C28"), growing.join(","));
  const fading = analysis.phases[2]!.colors.map((color) => color.hex);
  assert.ok(fading.every((value) => parseInt(value.slice(1, 3), 16) < 255), fading.join(","));
});

test("BGRA frames measure the same as RGBA ones", () => {
  assert.deepEqual(analyseClip(burst("bgra"), "bgra"), analyseClip(burst("rgba"), "rgba"));
});

test("a still clip is reported as having nothing to measure", () => {
  const still = Array.from({ length: 10 }, (_, index) => frame(index / 30));
  const analysis = analyseClip(still, "rgba");
  assert.equal(analysis.active, false);
  assert.equal(analysis.crop, undefined);
  assert.match(describeClipAnalysis(analysis).join("\n"), /none measurable between the frames/);
});

test("a moving camera is reported rather than timed or cropped", () => {
  // A gradient sliding across the whole frame: everything changes all the time.
  const panning = Array.from({ length: 30 }, (_, index) => frame(index / 30, (x, y) => {
    const value = ((x + y + index * 9) * 13) % 256;
    return [value, 255 - value, (value * 3) % 256];
  }));
  const analysis = analyseClip(panning, "rgba");
  assert.equal(analysis.cameraMoves, true);
  assert.equal(analysis.crop, undefined);
  assert.equal(analysis.onset, undefined);
  assert.match(describeClipAnalysis(analysis).join("\n"), /moving camera or a cut/);
});

test("a clip that opens mid-effect takes its background from the quiet end", () => {
  // Flickering for the first quarter, then still: the end is the background.
  const frames = Array.from({ length: 40 }, (_, index) => frame(index / 30, index < 10
    ? (x, y) => (x > 20 && x < 40 && y > 10 && y < 26 ? (index % 2 === 0 ? [250, 220, 90] : [200, 60, 20]) : undefined)
    : () => undefined));
  const analysis = analyseClip(frames, "rgba");
  assert.equal(analysis.active, true);
  assert.ok(analysis.onset! <= 0.05, `onset ${analysis.onset}`);
  assert.ok(analysis.end! < 0.4, `end ${analysis.end}`);
});

test("frames of different sizes are refused", () => {
  const small = { time: 0.1, width: 2, height: 2, pixels: new Uint8Array(16) };
  assert.throws(() => analyseClip([frame(0), small], "rgba"), /same size/);
  assert.deepEqual(analyseClip([frame(0)], "rgba"), { active: false, cameraMoves: false, phases: [] });
});

test("dominant colours are the colours that cover most of the samples", () => {
  const red = (255 << 16) | (10 << 8) | 10;
  const blue = (10 << 16) | (20 << 8) | 250;
  const colors = dominantColors([...Array(70).fill(red), ...Array(30).fill(blue)]);
  assert.equal(colors[0]!.hex, "#FF0A0A");
  assert.equal(Math.round(colors[0]!.share * 100), 70);
  assert.equal(colors[1]!.hex, "#0A14FA");
  assert.deepEqual(dominantColors([]), []);
});

test("the description says what each number measured", () => {
  const text = describeClipAnalysis(analyseClip(burst(), "rgba")).join("\n");
  assert.match(text, /^Measured by Roqer from the frames \(approximate/);
  assert.match(text, /- Timing \(how much of the frame differs from the background, and by how much\): starts at 0\.\d\d s, peaks at 0\.\d\d s, falls to half by 0\.\d\d s and is gone by 0\.\d\d s\./);
  assert.match(text, /- Brightness: brightest at 0\.\d\d s, \d+% of white on average across the frame, from \d+% before the effect\./);
  assert.match(text, /- Size: covers up to \d+% of the frame/);
  assert.match(text, /- Colours of what changed, most first: build-up \(0\.\d\d s-0\.\d\d s\) #/);
  assert.match(text, /- Framing: the frames are cropped to where the clip changes, \d+% of the frame's width and \d+% of its height, right of the middle\./);
});
