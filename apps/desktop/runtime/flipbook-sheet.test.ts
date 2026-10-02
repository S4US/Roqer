import assert from "node:assert/strict";
import test from "node:test";

import { analyzeFlipbook, decodePng, describeFlipbook } from "./flipbook-sheet";
import { chunk, png, sheet } from "./test-png";

test("decodePng reads 8-bit RGBA through every row filter it writes", () => {
  for (const filter of [0, 1, 2]) {
    const decoded = decodePng(png(3, 2, (x, y) => [x * 40, y * 90, 7, 200], { filter }));
    assert.equal(decoded.width, 3);
    assert.equal(decoded.hasAlpha, true);
    assert.deepEqual([...decoded.rgba.subarray(4 * 4, 4 * 5)], [40, 90, 7, 200]);
  }
});

test("decodePng refuses an interlaced or palette PNG by name", () => {
  const header = (colorType: number, interlace: number) => {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(4, 0);
    data.writeUInt32BE(4, 4);
    data[8] = 8;
    data[9] = colorType;
    data[12] = interlace;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", data)]);
  };
  assert.throws(() => decodePng(header(6, 1)), /interlaced/);
  assert.throws(() => decodePng(header(3, 0)), /palette/);
  assert.throws(() => decodePng(Buffer.from("not a png")), /Not a PNG/);
});

test("a padded 8 x 8 burst passes, with coverage that grows and fades in play order", () => {
  const radii = Array.from({ length: 64 }, (_, i) => 8 + Math.min(i, 63 - i) * 1.5);
  const report = analyzeFlipbook(sheet(8, (i) => radii[i]), { grid: 8, padding: 4, loop: false, fps: 30 });
  assert.equal(report.ok, true, report.problems.join("\n"));
  assert.equal(report.background, "transparent");
  assert.equal(report.detectedGrid, 8);
  assert.equal(report.coverage.length, 64);
  assert.ok(report.coverage[31] > report.coverage[0]);
  assert.ok(report.coverage[31] > report.coverage[63]);
  assert.deepEqual(report.settings, { FlipbookLayout: "Grid8x8", FlipbookMode: "OneShot", LightEmission: 0, lifetime: 2.13 });
});

test("a black-background sheet is read as additive", () => {
  const report = analyzeFlipbook(sheet(4, (i) => 40 + i * 4, { additive: true }), { grid: 4 });
  assert.equal(report.background, "black");
  assert.equal(report.settings?.LightEmission, 1);
  assert.equal(report.settings?.FlipbookMode, "Loop");
  assert.equal(report.ok, true, report.problems.join("\n"));
});

test("a loop gets the framerate it was animated at, capped at Roblox's 30", () => {
  const fire = (i: number) => 40 + (i % 4) * 5;
  const slow = analyzeFlipbook(sheet(4, fire, { additive: true }), { grid: 4, loop: true, fps: 12.4 });
  assert.equal(slow.settings?.framerate, 12);
  assert.equal(slow.settings?.lifetime, undefined);
  const fast = analyzeFlipbook(sheet(4, fire, { additive: true }), { grid: 4, loop: true, fps: 48 });
  assert.equal(fast.settings?.framerate, 30);
  assert.ok(describeFlipbook("fire.flipbook.png", fast).some((line) => /FlipbookFramerate = 30 \(the speed it was animated at, or Roblox's limit of 30\)/.test(line)));
});

test("16-bit sheets are read the same as 8-bit ones", () => {
  const report = analyzeFlipbook(sheet(2, (i) => 100 + i * 20, { depth: 16 }), { grid: 2 });
  assert.equal(report.ok, true, report.problems.join("\n"));
  assert.equal(report.grid, 2);
});

test("a sheet that is not 1024 x 1024 is refused with the size Roblox needs", () => {
  const report = analyzeFlipbook(sheet(4, () => 20, { side: 512 }), { grid: 4 });
  assert.equal(report.ok, false);
  assert.match(report.problems[0], /512 x 512.*exactly 1024 x 1024/);
});

test("a frame that runs into its neighbour fails the claimed grid and is named", () => {
  // Cell 10's disc is wider than its 128-pixel cell.
  const report = analyzeFlipbook(sheet(8, (i) => (i === 9 ? 70 : 30)), { grid: 8, padding: 4 });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => /crosses the cell boundaries of the claimed 8 x 8 grid/.test(problem)));
  assert.ok(report.edgeCells.includes(9));
  assert.ok(report.problems.some((problem) => /edge of .*#10/.test(problem)));
});

test("a subject leaving the camera's view is caught at the rendered area's edge, inside the padding", () => {
  // Radius 61 stays inside the 128 cell but reaches within 4 + 2 pixels of its edge.
  const report = analyzeFlipbook(sheet(8, (i) => (i === 5 ? 61 : 30)), { grid: 8, padding: 4 });
  assert.deepEqual(report.edgeCells, [5]);
  assert.equal(report.ok, false);
});

test("a burst played once may end on empty cells; a loop may not", () => {
  const faded = (i: number) => (i >= 14 ? 0 : 10 + i);
  assert.equal(analyzeFlipbook(sheet(4, faded), { grid: 4, loop: false }).ok, true);
  const looped = analyzeFlipbook(sheet(4, faded), { grid: 4, loop: true });
  assert.ok(looped.problems.some((problem) => /2 of 16 cells are empty \(#15, #16\)/.test(problem)));
  // An empty cell before the end still blinks, even played once.
  const gap = analyzeFlipbook(sheet(4, (i) => (i === 5 || i === 15 ? 0 : 10 + i)), { grid: 4, loop: false });
  assert.ok(gap.problems.some((problem) => /1 of 16 cells are empty \(#6\)/.test(problem)));
});

test("empty cells and frozen frames are reported", () => {
  const report = analyzeFlipbook(sheet(4, (i) => (i === 3 || i === 7 ? 0 : 20)), { grid: 4 });
  assert.deepEqual(report.emptyCells, [3, 7]);
  assert.ok(report.problems.some((problem) => /2 of 16 cells are empty \(#4, #8\)/.test(problem)));
  assert.ok(report.problems.some((problem) => /repeat the one before/.test(problem)));
});

test("a wrong claim is checked against the gutters in the pixels", () => {
  // A real 2 x 2 sheet whose discs cross the 4 x 4 boundaries, claimed as 4 x 4.
  const report = analyzeFlipbook(sheet(2, () => 200), { grid: 4 });
  assert.equal(report.detectedGrid, 2);
  assert.ok(report.problems.some((problem) => /claimed 4 x 4 grid/.test(problem)));
  const unsupported = analyzeFlipbook(sheet(2, () => 200), { grid: 3 });
  assert.ok(unsupported.problems.some((problem) => /2 x 2, 4 x 4 and 8 x 8/.test(problem)));
});

test("the description gives the model the settings and every problem", () => {
  const lines = describeFlipbook("burst.flipbook.png", analyzeFlipbook(sheet(4, (i) => (i === 0 ? 0 : 20)), { grid: 4, loop: false, fps: 16 }));
  assert.match(lines[0], /1024 x 1024, transparent background, 4 x 4 grid \(its gutters agree\)/);
  assert.ok(lines.some((line) => /Coverage per cell/.test(line)));
  assert.ok(lines.some((line) => /Problem: 1 of 16 cells are empty/.test(line)));
  assert.ok(lines.some((line) => /FlipbookLayout = Grid4x4, FlipbookMode = OneShot, LightEmission = 0, Lifetime = 1/.test(line)));
});
