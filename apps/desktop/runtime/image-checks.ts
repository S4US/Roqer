import type { ImageKind } from "../shared/image-generation";
import { decodePng, type DecodedPng } from "./flipbook-sheet";
import { analyzeRing, describeRing, type RingReport } from "./texture-ring";

/**
 * What a generated picture is, measured from its pixels, against the texture
 * study the VFX guidance is built on: drawn matter has crisp alpha, light
 * falls off softly, little of a texture is at full brightness, a ring that is
 * even all round reads as clip art, and a tile shows its seams. The model is
 * told these numbers beside the picture, because a model judging its own
 * picture by eye did not see them.
 */

export type TextureFamily = "crisp" | "soft" | "mixed" | "opaque";

export type ImageFacts = Readonly<{
  width: number;
  height: number;
  bytes: number;
  square: boolean;
  /** Both sides a power of two, which particle textures are expected to be. */
  powerOfTwo: boolean;
  family: TextureFamily;
  /** Share of all pixels that are drawn: alpha above a floor, or brightness above it on an opaque picture. */
  drawnShare: number;
  /** Share of drawn pixels at full brightness. */
  fullBrightShare: number;
  /** Share of drawn pixels partly transparent, which is what tells soft light from crisp matter. */
  partialAlphaShare: number;
  ring?: RingReport;
  /** For a tile: how much the opposite edges differ, 0 (seamless) to 1. */
  seam?: number;
}>;

/** The study's medians: a soft light texture has about 1% at full brightness, crisp drawn matter about 19%. */
const STUDY_FULL_BRIGHT = { soft: 0.01, crisp: 0.19, mixed: 0.29 } as const;

const DRAWN_ALPHA = 0.05;
const FULL = 0.95;
const SOFT_PARTIAL = 0.35;
const CRISP_PARTIAL = 0.12;

/** The pixels' family and brightness, from an already decoded picture. */
export function measureImage(png: DecodedPng, bytes: number): ImageFacts {
  const { width, height, rgba } = png;
  const count = width * height;
  let transparentAny = false;
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] < 255) { transparentAny = true; break; }
  }
  let drawn = 0;
  let full = 0;
  let partial = 0;
  let midBright = 0;
  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * 4;
    const luminance = (0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]) / 255;
    const alpha = rgba[offset + 3] / 255;
    const shown = transparentAny ? alpha : luminance;
    if (shown <= DRAWN_ALPHA) continue;
    drawn += 1;
    const intensity = transparentAny ? alpha * luminance : luminance;
    if (intensity >= FULL) full += 1;
    if (transparentAny) {
      if (alpha < FULL) partial += 1;
    } else if (luminance < FULL && luminance > 0.1) {
      midBright += 1;
    }
  }
  const partialAlphaShare = drawn === 0 ? 0 : (transparentAny ? partial : midBright) / drawn;
  // With no transparency anywhere the picture is opaque: a light texture on
  // black or a decal. Its falloff is then read from brightness, not alpha.
  const family: TextureFamily = !transparentAny
    ? "opaque"
    : partialAlphaShare >= SOFT_PARTIAL ? "soft" : partialAlphaShare <= CRISP_PARTIAL ? "crisp" : "mixed";
  const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;
  return {
    width, height, bytes,
    square: width === height,
    powerOfTwo: isPowerOfTwo(width) && isPowerOfTwo(height),
    family,
    drawnShare: count === 0 ? 0 : drawn / count,
    fullBrightShare: drawn === 0 ? 0 : full / drawn,
    partialAlphaShare,
  };
}

/** How much a tile's opposite edges disagree: the mean colour difference across the wrap, 0 to 1. */
export function seamMismatch(png: DecodedPng): number {
  const { width, height, rgba } = png;
  if (width < 2 || height < 2) return 0;
  let total = 0;
  let samples = 0;
  const diff = (a: number, b: number) => {
    let sum = 0;
    for (let channel = 0; channel < 3; channel += 1) sum += Math.abs(rgba[a + channel] - rgba[b + channel]);
    return sum / (3 * 255);
  };
  for (let y = 0; y < height; y += 1) {
    total += diff(y * width * 4, (y * width + width - 1) * 4);
    samples += 1;
  }
  for (let x = 0; x < width; x += 1) {
    total += diff(x * 4, ((height - 1) * width + x) * 4);
    samples += 1;
  }
  return samples === 0 ? 0 : total / samples;
}

/** Everything measured about one picture, or why it could not be. */
export function inspectImage(bytes: Buffer, kind: ImageKind): { facts: ImageFacts } | { problem: string } {
  let png: DecodedPng;
  try {
    png = decodePng(bytes);
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  const base = measureImage(png, bytes.length);
  const ring = (kind === "light" || kind === "matter") && base.square ? analyzeRing(png) : undefined;
  const seam = kind === "tile" ? seamMismatch(png) : undefined;
  return { facts: { ...base, ...(ring === undefined ? {} : { ring }), ...(seam === undefined ? {} : { seam }) } };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The lines the model reads about one picture, what to do with each in the guidance's terms. */
export function describeImageFacts(name: string, facts: ImageFacts, kind: ImageKind): string[] {
  const lines: string[] = [];
  const family = facts.family === "opaque"
    ? "opaque, with no transparency"
    : facts.family === "soft"
      ? `soft light (${percent(facts.partialAlphaShare)} of its drawn pixels partly transparent)`
      : facts.family === "crisp"
        ? `crisp drawn matter (${percent(facts.partialAlphaShare)} of its drawn pixels partly transparent)`
        : `mixed, between crisp matter and soft light (${percent(facts.partialAlphaShare)} partly transparent)`;
  lines.push(`${name}: ${facts.width}×${facts.height}${facts.square ? "" : ", not square"}${facts.powerOfTwo ? "" : ", not a power of two"}; ${percent(facts.drawnShare)} of the frame drawn; family: ${family}.`);
  const expected = facts.family === "soft" ? STUDY_FULL_BRIGHT.soft : facts.family === "crisp" ? STUDY_FULL_BRIGHT.crisp : STUDY_FULL_BRIGHT.mixed;
  if (facts.family !== "opaque") {
    lines.push(`Full brightness: ${percent(facts.fullBrightShare)} of its drawn pixels (the studied textures: a median ${percent(expected)} for this family). Brightness makes a texture bright in Studio; the value inside it reads as craft.`);
  }
  if (facts.family === "opaque" && (kind === "light" || kind === "matter")) {
    lines.push(facts.partialAlphaShare >= SOFT_PARTIAL
      ? `On an opaque ground: ${percent(facts.partialAlphaShare)} of its lit pixels are at mid brightness, a soft falloff. With LightEmission 1 the black ground is invisible and the picture adds light; as matter it needs a transparent background instead.`
      : `On an opaque ground with hard edges: ${percent(facts.partialAlphaShare)} of its lit pixels are at mid brightness. With LightEmission 1 the black ground is invisible; for crisp matter ask for a transparent background.`);
  }
  if (kind === "light" && facts.family === "crisp") lines.push("Asked for as light, it came back with hard edges: ask for a soft falloff that fades to nothing, or use it as matter at LightEmission 0.");
  if (kind === "matter" && facts.family === "soft") lines.push("Asked for as drawn matter, it came back soft: ask for crisp cel edges with no gradient, or use it as light at LightEmission 1.");
  if ((kind === "light" || kind === "matter") && !facts.square) lines.push("A particle texture should be square; Roblox stretches it to the particle's size.");
  if ((kind === "light" || kind === "matter") && (facts.width > 1024 || facts.height > 1024)) lines.push("Larger than 1,024 pixels a side: Roblox keeps no more, so it will be shrunk on upload.");
  if (facts.ring !== undefined) lines.push(...describeRing(facts.ring));
  if (facts.seam !== undefined) {
    lines.push(facts.seam <= 0.04
      ? `Seams: the opposite edges differ ${percent(facts.seam)}, so it tiles cleanly.`
      : `Seams: the opposite edges differ ${percent(facts.seam)}, which shows as a line when tiled. Ask for a seamless, tileable texture, or edit it with reference.output and ask for the edges to meet.`);
  }
  return lines;
}
