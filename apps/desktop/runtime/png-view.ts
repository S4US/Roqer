// What a model is shown of an image a Blender job made. A model sees a PNG's
// colour and not its alpha, so a white shape on a transparent background, which
// is what most particle textures are, reaches it as a blank white square: every
// texture and flipbook sheet of a missile run read that way (2026-10-03). A
// texture with transparency is therefore shown on a dark ground, where a white
// shape reads as it will glow in the game, and many are tiled into one sheet.
import { deflateSync } from "node:zlib";

import { decodePng, type DecodedPng } from "./flipbook-sheet";

/** The ground a transparent image is shown on, and the lines between a sheet's tiles. */
export const VIEW_GROUND = [22, 22, 28] as const;
const SHEET_LINE = [70, 70, 82] as const;
/** A review sheet is at most this wide, the most a model reads without shrinking it, and a tile at most this big. */
const SHEET_WIDTH = 2000;
const SHEET_TILE = 512;
const SHEET_COLUMNS = 4;
const SHEET_GAP = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data and CRC. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGB PNG of `rgb`, three bytes a pixel, row by row. */
export function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decoded(bytes: Buffer): DecodedPng | undefined {
  try {
    return decodePng(bytes);
  } catch {
    return undefined;
  }
}

function transparent(image: DecodedPng): boolean {
  if (!image.hasAlpha) return false;
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] < 255) return true;
  return false;
}

/**
 * The image over the dark ground, for a PNG with any transparency. Undefined
 * for an opaque image, which is shown as it is, and for one this cannot decode,
 * which the caller then shows as it is.
 */
export function onDarkGround(bytes: Buffer): Buffer | undefined {
  const image = decoded(bytes);
  if (image === undefined || !transparent(image)) return undefined;
  return encodeRgbPng(image.width, image.height, scaledOnGround(image, image.width, image.height));
}

/**
 * The image composited over the ground and resized to `width` x `height`:
 * each output pixel averages the source pixels it covers, or takes the nearest
 * one when enlarging.
 */
function scaledOnGround(image: DecodedPng, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 3);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let v = y0; v < y1; v++) {
        for (let u = x0; u < x1; u++) {
          const at = (v * image.width + u) * 4;
          const alpha = image.rgba[at + 3] / 255;
          r += image.rgba[at] * alpha + VIEW_GROUND[0] * (1 - alpha);
          g += image.rgba[at + 1] * alpha + VIEW_GROUND[1] * (1 - alpha);
          b += image.rgba[at + 2] * alpha + VIEW_GROUND[2] * (1 - alpha);
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * width + x) * 3;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
    }
  }
  return out;
}

export type ReviewSheet = Readonly<{ png: Buffer; columns: number; tile: number }>;

/**
 * Several images as one sheet over the dark ground, left to right then top to
 * bottom, each fitted into a square tile of up to 512 pixels without changing
 * its shape. A model pays for an image by its pixels, so this costs what the
 * images would one by one, but arrives as one image, on a ground where a
 * transparent texture shows. Undefined when any image does not decode.
 */
export function reviewSheet(images: readonly Buffer[]): ReviewSheet | undefined {
  if (images.length === 0) return undefined;
  const columns = Math.min(SHEET_COLUMNS, Math.ceil(Math.sqrt(images.length)));
  const rows = Math.ceil(images.length / columns);
  const tile = Math.min(SHEET_TILE, Math.floor((SHEET_WIDTH - (columns + 1) * SHEET_GAP) / columns));
  const width = columns * tile + (columns + 1) * SHEET_GAP;
  const height = rows * tile + (rows + 1) * SHEET_GAP;
  const sheet = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) sheet.set(SHEET_LINE, i * 3);
  // One image decoded at a time: sixteen large ones would otherwise all be held at once.
  for (const [index, bytes] of images.entries()) {
    const image = decoded(bytes);
    if (image === undefined) return undefined;
    const left = SHEET_GAP + (index % columns) * (tile + SHEET_GAP);
    const top = SHEET_GAP + Math.floor(index / columns) * (tile + SHEET_GAP);
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) sheet.set(VIEW_GROUND, ((top + y) * width + left + x) * 3);
    }
    const scale = tile / Math.max(image.width, image.height);
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const fitted = scaledOnGround(image, w, h);
    const offsetX = left + Math.floor((tile - w) / 2);
    const offsetY = top + Math.floor((tile - h) / 2);
    for (let y = 0; y < h; y++) fitted.copy(sheet, ((offsetY + y) * width + offsetX) * 3, y * w * 3, (y + 1) * w * 3);
  }
  return { png: encodeRgbPng(width, height, sheet), columns, tile };
}
