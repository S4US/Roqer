// PNG files built in memory for tests: a chunk writer, an image from a pixel
// function, and a flipbook sheet of discs.
import { deflateSync } from "node:zlib";

import { pngChunk } from "./png-view";

export const chunk = pngChunk;

/** An 8- or 16-bit RGBA (or RGB) PNG, each row filtered with `filter` so the decoder's unfiltering is exercised. */
export function png(width: number, height: number, pixel: (x: number, y: number) => number[], options: { alpha?: boolean; filter?: number; depth?: 8 | 16 } = {}): Buffer {
  const alpha = options.alpha ?? true;
  const depth = options.depth ?? 8;
  const channels = alpha ? 4 : 3;
  const bytesPerPixel = channels * (depth / 8);
  const filter = options.filter ?? 0;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(width * bytesPerPixel);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(width * bytesPerPixel);
    for (let x = 0; x < width; x++) {
      const values = pixel(x, y).slice(0, channels);
      values.forEach((value, c) => {
        if (depth === 16) line.writeUInt16BE(value * 257, (x * channels + c) * 2);
        else line[x * channels + c] = value;
      });
    }
    const filtered = Buffer.alloc(line.length);
    for (let i = 0; i < line.length; i++) {
      const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
      filtered[i] = filter === 1 ? (line[i] - left) & 0xff : filter === 2 ? (line[i] - previous[i]) & 0xff : line[i];
    }
    rows.push(Buffer.from([filter]), filtered);
    previous = line;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A sheet of `grid` x `grid` cells, each with a centred disc whose radius `radius(cell)` gives; 0 leaves the cell empty. */
export function sheet(grid: number, radius: (cell: number) => number, options: { additive?: boolean; side?: number; depth?: 8 | 16 } = {}): Buffer {
  const side = options.side ?? 1024;
  const size = side / grid;
  return png(side, side, (x, y) => {
    const index = Math.floor(y / size) * grid + Math.floor(x / size);
    const dx = (x % size) - size / 2 + 0.5;
    const dy = (y % size) - size / 2 + 0.5;
    const inside = Math.hypot(dx, dy) < radius(index);
    if (options.additive) return inside ? [255, 160, 60] : [0, 0, 0];
    return inside ? [255, 255, 255, 255] : [0, 0, 0, 0];
  }, { alpha: !options.additive, filter: 1, depth: options.depth });
}
