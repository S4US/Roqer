import assert from "node:assert/strict";
import test from "node:test";
import { describeImageFacts, inspectImage, measureImage, seamMismatch } from "./image-checks";
import { decodePng } from "./flipbook-sheet";
import { rgbaPng } from "./test-rgba-png";

const SIZE = 64;
const centre = (SIZE - 1) / 2;
const distance = (x: number, y: number) => Math.hypot(x - centre, y - centre);

test("a hard-edged white disc on transparent is crisp drawn matter, mostly at full brightness", () => {
  const disc = rgbaPng(SIZE, SIZE, (x, y) => distance(x, y) < 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]);
  const inspected = inspectImage(disc, "matter");
  assert.ok("facts" in inspected);
  assert.equal(inspected.facts.family, "crisp");
  assert.equal(inspected.facts.square, true);
  assert.equal(inspected.facts.powerOfTwo, true);
  assert.ok(inspected.facts.fullBrightShare > 0.95);
  assert.ok(inspected.facts.drawnShare > 0.25 && inspected.facts.drawnShare < 0.4);
  const lines = describeImageFacts("disc.png", inspected.facts, "light");
  assert.match(lines[0], /crisp drawn matter/);
  assert.ok(lines.some((line) => /Asked for as light, it came back with hard edges/.test(line)));
});

test("a glow whose alpha falls off is soft light with little at full brightness", () => {
  const glow = rgbaPng(SIZE, SIZE, (x, y) => {
    const alpha = Math.max(0, 1 - distance(x, y) / 28);
    return [255, 255, 255, Math.round(alpha * 255)];
  });
  const inspected = inspectImage(glow, "light");
  assert.ok("facts" in inspected);
  assert.equal(inspected.facts.family, "soft");
  assert.ok(inspected.facts.fullBrightShare < 0.05, `full ${inspected.facts.fullBrightShare}`);
  const lines = describeImageFacts("glow.png", inspected.facts, "matter");
  assert.ok(lines.some((line) => /Asked for as drawn matter, it came back soft/.test(line)));
});

test("an opaque picture is measured by brightness, and a tile's seams by its edges", () => {
  const seamless = rgbaPng(32, 32, () => [120, 90, 60, 255]);
  const seamed = rgbaPng(32, 32, (x) => x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  assert.equal(seamMismatch(decodePng(seamless)), 0);
  assert.ok(seamMismatch(decodePng(seamed)) > 0.45, "left and right edges disagree");
  const tile = inspectImage(seamed, "tile");
  assert.ok("facts" in tile);
  assert.equal(tile.facts.family, "opaque");
  assert.ok((tile.facts.seam ?? 0) > 0.45);
  assert.ok(describeImageFacts("tile.png", tile.facts, "tile").some((line) => /shows as a line when tiled/.test(line)));
  const clean = inspectImage(seamless, "tile");
  assert.ok("facts" in clean && describeImageFacts("t.png", clean.facts, "tile").some((line) => /tiles cleanly/.test(line)));
});

test("a light texture on black is judged by its brightness falloff, and a ring that is even is noted", () => {
  const ring = rgbaPng(SIZE, SIZE, (x, y) => {
    const d = distance(x, y);
    const on = d > 18 && d < 24;
    return [on ? 255 : 0, on ? 255 : 0, on ? 255 : 0, 255];
  });
  const inspected = inspectImage(ring, "light");
  assert.ok("facts" in inspected);
  assert.equal(inspected.facts.family, "opaque");
  assert.ok(inspected.facts.ring !== undefined, "a ring is recognised");
  assert.ok(describeImageFacts("ring.png", inspected.facts, "light").some((line) => /even all round/.test(line)));
  const measured = measureImage(decodePng(ring), ring.length);
  assert.ok(measured.drawnShare > 0.1 && measured.drawnShare < 0.4);
});

test("bytes that are not a PNG are reported, never measured", () => {
  const inspected = inspectImage(Buffer.from("not a png"), "icon");
  assert.ok("problem" in inspected);
  assert.match(inspected.problem, /Not a PNG/);
});
