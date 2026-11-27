import assert from "node:assert/strict";
import test from "node:test";
import { DICTATION_SAMPLE_RATE, MAX_DICTATION_SAMPLES } from "../shared/dictation";
import { CaptureBuffer, LEVEL_COUNT, soundLevel } from "./dictation-capture";

const tone = (length: number, amplitude: number) => Float32Array.from({ length }, (_, index) => amplitude * Math.sin(index / 3));

test("silence is level 0, louder sound is a higher level, and no level passes 1", () => {
  assert.equal(soundLevel(new Float32Array(0)), 0);
  assert.equal(soundLevel(new Float32Array(960)), 0);
  const quiet = soundLevel(tone(960, 0.02));
  const speech = soundLevel(tone(960, 0.15));
  assert.ok(quiet > 0.1 && quiet < speech, `quiet ${quiet}, speech ${speech}`);
  assert.ok(speech < 1);
  assert.equal(soundLevel(tone(960, 1)), 1);
});

test("recorded blocks are kept in order, with the time they add up to", () => {
  const buffer = new CaptureBuffer();
  assert.equal(buffer.samples().length, 0);
  assert.equal(buffer.seconds(), 0);
  buffer.push(Float32Array.from([0.1, 0.2]));
  buffer.push(Float32Array.from([0.3]));
  assert.deepEqual([...buffer.samples()].map((value) => Math.round(value * 10)), [1, 2, 3]);
  for (let index = 0; index < 125; index += 1) buffer.push(new Float32Array(128));
  assert.equal(buffer.samples().length, 3 + 125 * 128);
  assert.equal(buffer.seconds(), (3 + 125 * 128) / DICTATION_SAMPLE_RATE);
  // A copy: what was read is not changed by what is recorded next.
  const read = buffer.samples();
  buffer.push(Float32Array.from([0.9]));
  assert.equal(read.length, 3 + 125 * 128);
});

test("a level is added about every 60 ms of sound, and only the latest are kept", () => {
  const buffer = new CaptureBuffer();
  for (let index = 0; index < 7; index += 1) buffer.push(tone(128, 0.1));
  assert.deepEqual(buffer.levels(), [], "896 samples: not one level's worth yet");
  buffer.push(tone(128, 0.1));
  assert.equal(buffer.levels().length, 1);
  assert.ok(buffer.levels()[0] > 0.3);
  // Silence afterwards shows as low levels, pushing the older ones out.
  for (let index = 0; index < 8 * (LEVEL_COUNT + 5); index += 1) buffer.push(new Float32Array(128));
  assert.equal(buffer.levels().length, LEVEL_COUNT);
  assert.ok(buffer.levels().every((level) => level === 0));
});

test("recording stops taking sound at the longest dictation", () => {
  const buffer = new CaptureBuffer();
  buffer.push(new Float32Array(MAX_DICTATION_SAMPLES - 10));
  assert.equal(buffer.full, false);
  buffer.push(new Float32Array(128));
  assert.equal(buffer.full, true);
  assert.equal(buffer.samples().length, MAX_DICTATION_SAMPLES);
  buffer.push(new Float32Array(128));
  assert.equal(buffer.samples().length, MAX_DICTATION_SAMPLES);
});
