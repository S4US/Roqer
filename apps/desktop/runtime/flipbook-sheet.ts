// Checks a particle flipbook sheet from its pixels. Roblox plays every cell of
// the grid in order, refuses a texture that is not exactly 1024 x 1024
// ("Particle texture must be 1024 by 1024 to use flipbooks."), and a frame
// that runs into its neighbour's cell shows as a sliver of the next frame. The
// file a Blender script writes beside the sheet says what it meant to make;
// this reads what it made, so the two can be compared.
import { inflateSync } from "node:zlib";

export const FLIPBOOK_SIDE = 1024;
export const FLIPBOOK_GRIDS = [2, 4, 8] as const;
export type FlipbookGrid = (typeof FLIPBOOK_GRIDS)[number];

const MAX_FLIPBOOK_FRAMERATE = 30;
/** A pixel counts as drawn above this: alpha on a transparent sheet, brightness on a black one. */
const CONTENT_THRESHOLD = 8;
/** The most pixels a sheet may decode to; a little over 1024 x 1024 leaves room for a wrong size to be reported. */
const MAX_PIXELS = 2048 * 2048;
const MAX_INPUT_BYTES = 24 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type DecodedPng = Readonly<{ width: number; height: number; rgba: Buffer; hasAlpha: boolean }>;

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes the PNGs Blender writes: greyscale, grey-alpha, RGB or RGBA at 8 or
 * 16 bits, not interlaced. Anything else is refused by name.
 */
export function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`The PNG is ${bytes.length} bytes; a flipbook sheet is far smaller.`);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG file.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  const data: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length + 4 > bytes.length) throw new Error("The PNG is truncated.");
    const chunk = bytes.subarray(start, start + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      depth = chunk[8];
      colorType = chunk[9];
      if (chunk[12] !== 0) throw new Error("The PNG is interlaced; save it without interlacing.");
      if (colorType === 3) throw new Error("The PNG uses a colour palette; save it as RGBA.");
      if (CHANNELS[colorType] === undefined || (depth !== 8 && depth !== 16)) {
        throw new Error(`The PNG has colour type ${colorType} at ${depth} bits; save it as 8-bit RGBA.`);
      }
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error(`The PNG is ${width} x ${height}; a flipbook sheet is 1024 x 1024.`);
    } else if (type === "IDAT") {
      data.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (colorType < 0) throw new Error("The PNG has no header.");
  const channels = CHANNELS[colorType];
  const bytesPerPixel = channels * (depth / 8);
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height + 1 });
  if (raw.length < (stride + 1) * height) throw new Error("The PNG's image data is shorter than its size says.");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
      const up = above ? above[x] : 0;
      const corner = above && x >= bytesPerPixel ? above[x - bytesPerPixel] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error(`The PNG uses an unknown filter (${filter}).`);
      out[x] = value & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  const step = depth / 8;
  for (let i = 0; i < width * height; i++) {
    const at = (channel: number) => pixels[i * bytesPerPixel + channel * step];
    const grey = channels <= 2;
    rgba[i * 4] = at(0);
    rgba[i * 4 + 1] = grey ? at(0) : at(1);
    rgba[i * 4 + 2] = grey ? at(0) : at(2);
    rgba[i * 4 + 3] = channels === 2 ? at(1) : channels === 4 ? at(3) : 255;
  }
  return { width, height, rgba, hasAlpha: channels === 2 || channels === 4 };
}

/** What the script that made a sheet said it made. Read as a claim to check, never as a fact. */
export type FlipbookClaim = Readonly<{ grid?: number; mode?: string; padding?: number; loop?: boolean; fps?: number; frames?: readonly number[] }>;

export type FlipbookReport = Readonly<{
  ok: boolean;
  width: number;
  height: number;
  background: "transparent" | "black" | "other";
  /** The grid the empty gutters between frames agree with, or none when content crosses every candidate. */
  detectedGrid?: FlipbookGrid;
  grid?: FlipbookGrid;
  /** Share of each cell that is drawn, row by row from the top left, the order Roblox plays them in. */
  coverage: readonly number[];
  emptyCells: readonly number[];
  /** Cells whose drawing reaches the edge of the area rendered for it: the subject left the camera's view, or bleeds into the next cell. */
  edgeCells: readonly number[];
  /** Cells identical to the one before: frames that do not move. */
  repeatedCells: readonly number[];
  problems: readonly string[];
  settings?: Readonly<{ FlipbookLayout: string; FlipbookMode: string; LightEmission: number; lifetime?: number; framerate?: number }>;
}>;

function contentMask(image: DecodedPng): { mask: Uint8Array; background: FlipbookReport["background"] } {
  const { width, height, rgba } = image;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const transparent = image.hasAlpha && corners.every((i) => rgba[i * 4 + 3] <= CONTENT_THRESHOLD);
  const black = corners.every((i) => Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) <= CONTENT_THRESHOLD);
  const background = transparent ? "transparent" : black ? "black" : "other";
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const alpha = rgba[i * 4 + 3];
    const bright = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    mask[i] = background === "transparent"
      ? (alpha > CONTENT_THRESHOLD ? 1 : 0)
      : (alpha > CONTENT_THRESHOLD && bright > CONTENT_THRESHOLD ? 1 : 0);
  }
  return { mask, background };
}

/** Whether a grid's boundary rows and columns, two pixels each, are free of drawing. */
function gutterClear(mask: Uint8Array, side: number, grid: number): boolean {
  const cell = side / grid;
  for (let k = 1; k < grid; k++) {
    for (const line of [k * cell - 1, k * cell]) {
      for (let t = 0; t < side; t++) {
        if (mask[line * side + t] || mask[t * side + line]) return false;
      }
    }
  }
  return true;
}

export function analyzeFlipbook(png: Buffer, claim: FlipbookClaim = {}): FlipbookReport {
  const image = decodePng(png);
  const problems: string[] = [];
  const { mask, background } = contentMask(image);
  const base = { width: image.width, height: image.height, background, coverage: [], emptyCells: [], edgeCells: [], repeatedCells: [] };
  if (image.width !== FLIPBOOK_SIDE || image.height !== FLIPBOOK_SIDE) {
    return { ...base, ok: false, problems: [`The sheet is ${image.width} x ${image.height}; Roblox plays a flipbook only from a texture exactly 1024 x 1024.`] };
  }
  const side = FLIPBOOK_SIDE;
  const detectedGrid = [...FLIPBOOK_GRIDS].reverse().find((grid) => gutterClear(mask, side, grid));
  const claimed = FLIPBOOK_GRIDS.find((grid) => grid === claim.grid);
  if (claim.grid !== undefined && claimed === undefined) problems.push(`The script claims a ${claim.grid} x ${claim.grid} grid; Roblox's layouts are 2 x 2, 4 x 4 and 8 x 8.`);
  if (claimed !== undefined && !gutterClear(mask, side, claimed)) {
    problems.push(`Drawing crosses the cell boundaries of the claimed ${claimed} x ${claimed} grid, so frames run into each other or the sheet is not laid out on that grid.`);
  }
  if (background === "other") problems.push("The sheet's corners are neither transparent nor black, so it has no clear background: use a transparent film for alpha blending, or a black world for additive.");
  const grid = claimed ?? detectedGrid;
  if (grid === undefined) {
    problems.push("No 2 x 2, 4 x 4 or 8 x 8 grid fits: drawing crosses the boundaries of every one.");
    return { ...base, ok: false, problems };
  }

  const cell = side / grid;
  const padding = Math.max(0, Math.min(cell / 4, Math.floor(claim.padding ?? 0)));
  // The rendered area starts `padding` pixels in; drawing on its outermost two pixels touches its edge.
  const band = padding + 2;
  const coverage: number[] = [];
  const emptyCells: number[] = [];
  const edgeCells: number[] = [];
  const repeatedCells: number[] = [];
  let previous: Buffer | undefined;
  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const index = row * grid + column;
      let drawn = 0;
      let touches = false;
      const bytes = Buffer.alloc(cell * cell * 4);
      for (let y = 0; y < cell; y++) {
        const sheetRow = row * cell + y;
        image.rgba.copy(bytes, y * cell * 4, (sheetRow * side + column * cell) * 4, (sheetRow * side + column * cell + cell) * 4);
        for (let x = 0; x < cell; x++) {
          if (!mask[sheetRow * side + column * cell + x]) continue;
          drawn++;
          if (x < band || y < band || x >= cell - band || y >= cell - band) touches = true;
        }
      }
      coverage.push(Math.round((drawn / (cell * cell)) * 1000) / 10);
      if (drawn === 0) emptyCells.push(index);
      if (touches) edgeCells.push(index);
      if (previous !== undefined && previous.equals(bytes)) repeatedCells.push(index);
      previous = bytes;
    }
  }
  const cells = grid * grid;
  // A burst played once may end fully faded: its last cells are empty on purpose.
  let fadedTail = 0;
  if (claim.loop === false) {
    while (fadedTail < emptyCells.length && emptyCells[emptyCells.length - 1 - fadedTail] === cells - 1 - fadedTail) fadedTail++;
  }
  const blinking = emptyCells.slice(0, emptyCells.length - fadedTail);
  if (emptyCells.length === cells) problems.push("Every cell is empty: nothing was rendered, or the subject is outside the camera's view.");
  else if (blinking.length > 0) {
    problems.push(`${blinking.length} of ${cells} cells are empty (${listCells(blinking)}); Roblox plays every cell, so a particle blinks out on each.`);
  }
  if (edgeCells.length > 0) problems.push(`Drawing reaches the edge of ${edgeCells.length} cell${edgeCells.length === 1 ? "" : "s"} (${listCells(edgeCells)}): the subject leaves the camera's view there and is cut off. Frame it smaller or move the camera back.`);
  if (repeatedCells.length >= cells / 4) problems.push(`${repeatedCells.length} cells repeat the one before (${listCells(repeatedCells)}): the animation does not move there.`);
  const fps = claim.fps !== undefined && claim.fps > 0 ? claim.fps : undefined;
  const lifetime = claim.loop === false && fps !== undefined ? Math.round((cells / fps) * 100) / 100 : undefined;
  // A loop plays at FlipbookFramerate, which Roblox caps at 30 frames a second.
  const framerate = claim.loop !== false && fps !== undefined ? Math.min(MAX_FLIPBOOK_FRAMERATE, Math.round(fps)) : undefined;
  const settings = {
    FlipbookLayout: `Grid${grid}x${grid}`,
    FlipbookMode: claim.loop === false ? "OneShot" : "Loop",
    LightEmission: background === "black" ? 1 : 0,
    ...(lifetime === undefined ? {} : { lifetime }),
    ...(framerate === undefined ? {} : { framerate }),
  };
  return { ...base, ok: problems.length === 0, detectedGrid, grid, coverage, emptyCells, edgeCells, repeatedCells, problems, settings };
}

function listCells(cells: readonly number[]): string {
  const shown = cells.slice(0, 8).map((cell) => `#${cell + 1}`).join(", ");
  return cells.length > 8 ? `${shown} and ${cells.length - 8} more` : shown;
}

/** The report as lines the model reads. */
export function describeFlipbook(name: string, report: FlipbookReport): string[] {
  const lines = [`- ${name}: ${report.width} x ${report.height}, ${report.background} background${report.grid === undefined ? "" : `, ${report.grid} x ${report.grid} grid${report.detectedGrid === report.grid ? " (its gutters agree)" : ""}`}.`];
  if (report.coverage.length > 0) {
    lines.push(`  Coverage per cell, in play order (% drawn): ${report.coverage.map((value) => value.toFixed(0)).join(" ")}`);
  }
  for (const problem of report.problems) lines.push(`  Problem: ${problem}`);
  if (report.settings !== undefined) {
    const { FlipbookLayout, FlipbookMode, LightEmission, lifetime, framerate } = report.settings;
    lines.push(`  On a ParticleEmitter: FlipbookLayout = ${FlipbookLayout}, FlipbookMode = ${FlipbookMode}, LightEmission = ${LightEmission}${lifetime === undefined ? "" : `, Lifetime = ${lifetime} (OneShot plays the sheet once per lifetime)`}${framerate === undefined ? "" : `, FlipbookFramerate = ${framerate} (the speed it was animated at${framerate === MAX_FLIPBOOK_FRAMERATE ? ", or Roblox's limit of 30" : ""})`}.`);
  }
  return lines;
}
