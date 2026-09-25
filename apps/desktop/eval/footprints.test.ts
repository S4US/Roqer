import assert from "node:assert/strict";
import test from "node:test";

import { connectedGroups, footprint, footprintGap, readBox } from "./footprints";

const square = (x: number, z: number, half: number) => footprint({ x, z, h: [[half, 0], [0, 0], [0, half]] });

test("a rotated path is judged by its shape, not by its axis-aligned bounds", () => {
  // A diamond whose bounding square overlaps the plaza's corner while the
  // diamond itself stops short of it: the case an AABB check gets wrong.
  const diamond = footprint({ x: 10, z: 10, h: [[2.5, 2.5], [0, 0], [-2.5, 2.5]] });
  const plaza = square(0, 0, 6);
  assert.equal(diamond.length, 4);
  assert.ok(Math.abs(footprintGap(diamond, plaza) - 3 / Math.SQRT2) < 1e-9);
  assert.equal(footprintGap(square(4, 0, 2), plaza), 0, "overlapping footprints have no gap");
  assert.equal(footprintGap(square(20, 0, 2), plaza), 12);
});

test("a tilted box casts its whole shadow, including the part the up axis adds", () => {
  // A ramp tipped along X: the up half-vector widens the shadow along X.
  const ramp = footprint({ x: 0, z: 0, h: [[4, 0], [1, 0], [0, 3]] });
  const xs = ramp.map(([x]) => x);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-5, 5]);
});

test("pieces that touch form one network; a separate piece stays separate", () => {
  const groups = connectedGroups([square(0, 0, 5), square(10, 0, 5), square(19.5, 0, 4), square(40, 0, 5)], 1);
  assert.equal(groups[0], groups[1]);
  assert.equal(groups[1], groups[2], "a half-stud seam is still one surface");
  assert.notEqual(groups[2], groups[3]);
});

test("a probe entry that is not a box is ignored rather than guessed", () => {
  assert.equal(readBox({ x: 1, z: 2 }), undefined);
  assert.equal(readBox({ x: 1, z: 2, h: [[1, "2"]] }), undefined);
  assert.deepEqual(readBox({ x: 1, z: 2, top: 9, h: [[1, 0]] }), { x: 1, z: 2, top: 9, h: [[1, 0]] });
});
