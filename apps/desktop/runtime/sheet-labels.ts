/**
 * Labels drawn onto a contact sheet's frames: a frame's number and time, in a
 * small pixel font, white on a black box in the frame's top-left corner.
 *
 * In a grid of sixteen frames it is easy to count wrong, and a frame named in
 * the text by its place is a frame the model has to count to. A label it can
 * read off the picture removes the counting. Electron's image tools cannot
 * draw text, so the font is here, as bitmaps: digits and the few characters a
 * label needs, five pixels wide and seven high, scaled up whole.
 *
 * Pure, so it is tested without Electron. White and black are the same in RGBA
 * and BGRA, so it writes either.
 */

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "s": ["00000", "00000", "01110", "10000", "01110", "00001", "11110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
/** Font pixels between characters, and around the text inside its box. */
const SPACING = 1;
const PADDING = 2;

/** The characters a label may use. */
export const LABEL_CHARACTERS = Object.keys(GLYPHS).join("");

/** A label's box, in pixels, at `scale` pixels to a font pixel. */
export function labelSize(text: string, scale: number): Readonly<{ width: number; height: number }> {
  const characters = Math.max(1, text.length);
  return {
    width: (characters * GLYPH_WIDTH + (characters - 1) * SPACING + PADDING * 2) * scale,
    height: (GLYPH_HEIGHT + PADDING * 2) * scale,
  };
}

/** The font scale for a tile `tileWidth` pixels wide: big enough to read, small enough to leave the frame. */
export function labelScale(tileWidth: number): number {
  return tileWidth >= 400 ? 3 : 2;
}

/**
 * Draw `text` at `left`, `top` into a four-byte-a-pixel bitmap, clipped to it.
 * A character the font lacks is drawn as a space.
 */
export function drawLabel(
  bitmap: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
  text: string,
  scale: number,
): void {
  const size = labelSize(text, scale);
  const put = (x: number, y: number, value: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    bitmap[offset] = value;
    bitmap[offset + 1] = value;
    bitmap[offset + 2] = value;
    bitmap[offset + 3] = 255;
  };
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) put(left + x, top + y, 0);
  }
  [...text].forEach((character, index) => {
    const glyph = GLYPHS[character] ?? GLYPHS[" "];
    const originX = left + (PADDING + index * (GLYPH_WIDTH + SPACING)) * scale;
    const originY = top + PADDING * scale;
    glyph.forEach((row, rowIndex) => {
      for (let column = 0; column < GLYPH_WIDTH; column++) {
        if (row[column] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) put(originX + column * scale + dx, originY + rowIndex * scale + dy, 255);
        }
      }
    });
  });
}

/** "3 0.25s": a frame's number and its time in seconds, as a sheet labels it. */
export function frameLabel(number: number, seconds: number, prefix = ""): string {
  return `${prefix}${number} ${seconds.toFixed(2)}s`;
}
