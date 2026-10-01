import assert from "node:assert/strict";
import test from "node:test";

import { degreesBetween, describeBake, describeBakedFile, eulerDegrees, keptSamples, parseBake, type Bake } from "./blender-animation";

type Quaternion = [number, number, number, number];
const about = (axis: [number, number, number], degrees: number): Quaternion => {
  const half = (degrees * Math.PI) / 360;
  return [axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half), Math.cos(half)];
};
const times = (a: Quaternion, b: Quaternion): Quaternion => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const REST: Quaternion = [0, 0, 0, 1];

/** A tail of two bones under a spine, sampled 20 times a second for a second. */
function bake(turn: (joint: string, time: number) => Quaternion, travel?: (time: number) => [number, number, number]) {
  return {
    name: "Wag",
    rig: "game.Workspace.Wolf",
    loop: true,
    rootJoint: "Root",
    joints: [{ name: "Spine" }, { name: "Tail", parent: "Spine", offset: [0, 0.1, 1.5] }, { name: "Tail2", parent: "Tail", offset: [0, -0.2, 0.8] }],
    frames: Array.from({ length: 21 }, (_unused, index) => {
      const time = index / 20;
      return { time, rotations: { Spine: turn("Spine", time), Tail: turn("Tail", time), Tail2: turn("Tail2", time) }, ...(travel ? { travel: travel(time) } : {}) };
    }),
  };
}

test("a rotation becomes the degrees CFrame.Angles takes: about X, then Y, then Z", () => {
  assert.deepEqual(eulerDegrees(about([1, 0, 0], 30)), [30, 0, 0]);
  assert.deepEqual(eulerDegrees(about([0, 1, 0], -45)), [0, -45, 0]);
  assert.deepEqual(eulerDegrees(about([0, 0, 1], 120)), [0, 0, 120]);
  // Rx * Ry * Rz, read back as its three angles.
  const combined = times(times(about([1, 0, 0], 20), about([0, 1, 0], 35)), about([0, 0, 1], -50));
  assert.deepEqual(eulerDegrees(combined), [20, 35, -50]);
  // Looking straight along X, the turn about Z folds into the one about X.
  const [x, y, z] = eulerDegrees(times(times(about([1, 0, 0], 20), about([0, 1, 0], 90)), about([0, 0, 1], 15)));
  assert.equal(y, 90);
  assert.equal(z, 0);
  assert.ok(Math.abs(x - 35) < 0.01);
});

test("only the samples a straight run would miss are kept", () => {
  // A line needs its ends; a corner needs the corner.
  assert.deepEqual(keptSamples(11, () => 0, 0.1), [0, 10]);
  const corner = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0];
  const error = (from: number, to: number, at: number) => Math.abs(corner[at] - (corner[from] + ((corner[to] - corner[from]) * (at - from)) / (to - from)));
  assert.deepEqual(keptSamples(11, error, 0.1), [0, 5, 10]);
});

test("a bake becomes a pose description: each moving joint keyed where it needs to be, the rest left out", () => {
  // The tail swings steadily one way and back; its tip holds still; the spine never moves.
  const raw = bake((joint, time) => joint === "Tail" ? about([0, 1, 0], time <= 0.5 ? 60 * time : 60 * (1 - time)) : REST);
  const parsed = parseBake(raw);
  assert.ok(typeof parsed !== "string", String(parsed));
  const baked = describeBake(parsed as Bake);
  assert.equal(baked.joints, 1);
  assert.equal(baked.samples, 21);
  const { description } = baked;
  assert.deepEqual(description.keyframes, [
    { time: 0, joints: { Tail: { rotation: [0, 0, 0] } } },
    { time: 0.5, joints: { Tail: { rotation: [0, 30, 0] } } },
    { time: 1, joints: { Tail: { rotation: [0, 0, 0] } } },
  ]);
  assert.equal(description.name, "Wag");
  assert.equal(description.rig, "game.Workspace.Wolf");
  assert.equal(description.loop, true);
  assert.deepEqual(description.easing, { style: "Linear" });
  // The skeleton it was made on travels with it, for the tool to compare with the rig's.
  assert.deepEqual(description.skeleton, { Tail: { parent: "Spine", offset: [0, 0.1, 1.5] }, Tail2: { parent: "Tail", offset: [0, -0.2, 0.8] } });
  assert.match(describeBakedFile("C:/jobs/Wag.animation.json", baked), /Wag, 1\.00 s for game\.Workspace\.Wolf, looping, 1 joint moving, 21 samples kept as 3 keyframes and 3 poses$/);
});

test("a curved turn is kept within the tolerance of every sample", () => {
  const swing = (time: number) => about([0, 1, 0], 40 * Math.sin(2 * Math.PI * time));
  const parsed = parseBake(bake((joint, time) => joint === "Tail2" ? swing(time) : REST)) as Bake;
  const { description, keyframes } = describeBake(parsed);
  assert.ok(keyframes > 6 && keyframes < 21, `${keyframes} keyframes`);
  // Each sample lies within the tolerance of the straight run between the keys either side of it.
  const keys = (description.keyframes as { time: number; joints: Record<string, { rotation: number[] }> }[]).map((key) => ({ time: key.time, degrees: key.joints.Tail2.rotation[1] }));
  for (const frame of parsed.frames) {
    const after = keys.findIndex((key) => key.time >= frame.time - 1e-9);
    const [from, to] = [keys[Math.max(0, after - 1)], keys[after]];
    const share = to.time === from.time ? 0 : (frame.time - from.time) / (to.time - from.time);
    const between = about([0, 1, 0], from.degrees + (to.degrees - from.degrees) * share);
    assert.ok(degreesBetween(between, frame.rotations.Tail2) < 0.3, `at ${frame.time}`);
  }
});

test("the body's travel goes on the joint that moves the whole body, with a rotation beside it", () => {
  const parsed = parseBake(bake(() => REST, (time) => [0, time <= 0.5 ? time : 1 - time, 0])) as Bake;
  const { description, joints } = describeBake(parsed);
  assert.equal(joints, 1);
  assert.deepEqual(description.keyframes, [
    { time: 0, joints: { Root: { rotation: [0, 0, 0], position: [0, 0, 0] } } },
    { time: 0.5, joints: { Root: { rotation: [0, 0, 0], position: [0, 0.5, 0] } } },
    { time: 1, joints: { Root: { rotation: [0, 0, 0], position: [0, 0, 0] } } },
  ]);
});

test("a bake is read as data, and one that is not an animation says why", () => {
  const good = bake(() => REST);
  assert.equal(parseBake("nope"), "it is not a JSON object");
  assert.match(String(parseBake({ ...good, rig: undefined })), /does not name its rig/);
  assert.match(String(parseBake({ ...good, frames: good.frames.slice(0, 1) })), /at least two frames/);
  assert.match(String(parseBake({ ...good, frames: [...good.frames, good.frames[3]] })), /times do not rise/);
  assert.match(String(parseBake({ ...good, frames: good.frames.map((frame) => ({ ...frame, rotations: { Spine: REST } })) })), /no rotation for Tail/);
  assert.match(String(parseBake({ ...good, frames: good.frames.map((frame) => ({ ...frame, rotations: { ...frame.rotations, Tail: [0, 0, 0, 2] } })) })), /not a unit quaternion/);
  assert.match(String(parseBake({ ...good, joints: [...good.joints, { name: "Tail" }] })), /share a name/);
  assert.match(String(parseBake({ ...good, frames: Array.from({ length: 241 }, (_unused, index) => ({ ...good.frames[0], time: index / 30 })) })), /at most 240 keyframes/);
});
