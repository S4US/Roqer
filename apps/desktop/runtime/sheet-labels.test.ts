import assert from "node:assert/strict";
import test from "node:test";

import { drawLabel, frameLabel, labelScale, labelSize, LABEL_CHARACTERS } from "./sheet-labels";

function canvas(width: number, height: number, fill = 90): Uint8Array {
  return new Uint8Array(width * height * 4).fill(fill);
}

function pixel(bitmap: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [...bitmap.subarray(offset, offset + 4)];
}

test("a label is a black box with white glyphs, sized by its characters", () => {
  assert.deepEqual(labelSize("1", 2), { width: (5 + 4) * 2, height: (7 + 4) * 2 });
  assert.deepEqual(labelSize("12", 3), { width: (10 + 1 + 4) * 3, height: 33 });
  const width = 40;
  const bitmap = canvas(width, 30);
  drawLabel(bitmap, width, 30, 0, 0, "1", 2);
  // The box's corner is black; the "1"'s stem (column 2 of the glyph) is white.
  assert.deepEqual(pixel(bitmap, width, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(bitmap, width, (2 + 2) * 2, (2 + 3) * 2), [255, 255, 255, 255]);
  // Outside the box nothing changed.
  assert.deepEqual(pixel(bitmap, width, 30, 25), [90, 90, 90, 90]);
});

test("a label is clipped to the bitmap rather than written past it", () => {
  const bitmap = canvas(10, 6);
  drawLabel(bitmap, 10, 6, 4, 2, "0.25s", 3);
  assert.equal(bitmap.length, 10 * 6 * 4);
  assert.deepEqual(pixel(bitmap, 10, 0, 0), [90, 90, 90, 90]);
  assert.deepEqual(pixel(bitmap, 10, 4, 2), [0, 0, 0, 255]);
  // Entirely outside: nothing is drawn, nothing throws.
  drawLabel(bitmap, 10, 6, -500, -500, "1", 2);
});

test("characters the font lacks are drawn as spaces", () => {
  const width = 60;
  const unknown = canvas(width, 30);
  const space = canvas(width, 30);
  drawLabel(unknown, width, 30, 0, 0, "1?2", 2);
  drawLabel(space, width, 30, 0, 0, "1 2", 2);
  assert.deepEqual(unknown, space);
  for (const character of "0123456789.s-RS ") assert.ok(LABEL_CHARACTERS.includes(character));
});

test("frame labels carry a number and a time in seconds", () => {
  assert.equal(frameLabel(3, 0.25), "3 0.25s");
  assert.equal(frameLabel(12, 1.5, "R"), "R12 1.50s");
  assert.equal(labelScale(500), 3);
  assert.equal(labelScale(250), 2);
});
