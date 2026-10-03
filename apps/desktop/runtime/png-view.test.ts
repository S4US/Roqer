import assert from "node:assert/strict";
import test from "node:test";

import { decodePng } from "./flipbook-sheet";
import { encodeRgbPng, onDarkGround, reviewSheet, VIEW_GROUND } from "./png-view";
import { png } from "./test-png";

/** The 8-bit RGB of one pixel of a decoded image. */
function pixel(bytes: Buffer, x: number, y: number): number[] {
  const image = decodePng(bytes);
  const at = (y * image.width + x) * 4;
  return [image.rgba[at], image.rgba[at + 1], image.rgba[at + 2]];
}

/** A white disc on a transparent background, the shape most particle textures have. */
function whiteDisc(side: number): Buffer {
  return png(side, side, (x, y) => Math.hypot(x - side / 2 + 0.5, y - side / 2 + 0.5) < side / 4 ? [255, 255, 255, 255] : [255, 255, 255, 0]);
}

test("an RGB PNG it writes decodes to the same pixels", () => {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const bytes = encodeRgbPng(2, 2, rgb);
  const image = decodePng(bytes);
  assert.equal(image.hasAlpha, false);
  assert.deepEqual([pixel(bytes, 0, 0), pixel(bytes, 1, 0), pixel(bytes, 0, 1), pixel(bytes, 1, 1)], [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30]]);
});

test("a white texture on transparency is shown over the dark ground, and an opaque image is left alone", () => {
  // White everywhere, shaped only by alpha: shown as it is, a model sees a blank white square.
  const grounded = onDarkGround(whiteDisc(64));
  assert.ok(grounded);
  assert.deepEqual(pixel(grounded, 0, 0), [...VIEW_GROUND], "the transparent corner is the ground");
  assert.deepEqual(pixel(grounded, 32, 32), [255, 255, 255], "the disc stays white");
  const half = onDarkGround(png(2, 1, () => [255, 255, 255, 128]));
  assert.ok(half);
  assert.deepEqual(pixel(half, 0, 0), VIEW_GROUND.map((ground) => Math.round(255 * (128 / 255) + ground * (1 - 128 / 255))));

  assert.equal(onDarkGround(png(8, 8, () => [200, 100, 50, 255])), undefined, "fully opaque: nothing to change");
  assert.equal(onDarkGround(png(8, 8, () => [200, 100, 50], { alpha: false })), undefined, "no alpha channel");
  assert.equal(onDarkGround(Buffer.from("not a png")), undefined);
});

test("a review sheet tiles every image over the dark ground, each fitted to its tile", () => {
  const images = [whiteDisc(256), whiteDisc(512), whiteDisc(1024), png(128, 512, () => [255, 0, 0, 255]), whiteDisc(256), whiteDisc(256)];
  const sheet = reviewSheet(images);
  assert.ok(sheet);
  assert.equal(sheet.columns, 3, "six images go three to a row");
  assert.equal(sheet.tile, 512);
  const decoded = decodePng(sheet.png);
  assert.deepEqual([decoded.width, decoded.height], [3 * 512 + 4 * 4, 2 * 512 + 3 * 4]);
  const tileCentre = (index: number) => [4 + (index % 3) * 516 + 256, 4 + Math.floor(index / 3) * 516 + 256] as const;
  for (const index of [0, 1, 2, 4, 5]) assert.deepEqual(pixel(sheet.png, ...tileCentre(index)), [255, 255, 255], `disc ${index} is drawn`);
  assert.deepEqual(pixel(sheet.png, 4 + 10, 4 + 10), [...VIEW_GROUND], "around a disc is the ground");
  // A tall strip keeps its shape: red down the middle of its tile, ground at the sides.
  const [stripX, stripY] = tileCentre(3);
  assert.deepEqual(pixel(sheet.png, stripX, stripY), [255, 0, 0]);
  assert.deepEqual(pixel(sheet.png, stripX - 100, stripY), [...VIEW_GROUND]);

  const many = reviewSheet(Array.from({ length: 16 }, () => whiteDisc(64)));
  assert.equal(many?.columns, 4);
  assert.ok(decodePng(many!.png).width <= 2000, "a sheet is never wider than a model reads without shrinking it");
  assert.equal(reviewSheet([whiteDisc(64), Buffer.from("not a png")]), undefined, "one unreadable image: no sheet");
});
