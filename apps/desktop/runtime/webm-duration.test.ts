import assert from "node:assert/strict";
import test from "node:test";
import { webmDurationMs, withWebmDuration } from "./webm-duration";

/** An EBML element: id bytes, a one-byte size, and its data. */
function element(id: number[], data: number[]): number[] {
  assert.ok(data.length < 127);
  return [...id, 0x80 | data.length, ...data];
}

const EBML_HEADER = element([0x1a, 0x45, 0xdf, 0xa3], [...element([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])]);
const TIMECODE_SCALE = element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]);
const WRITING_APP = element([0x57, 0x41], [0x43, 0x68, 0x72, 0x6f, 0x6d, 0x65]);
const INFO = element([0x15, 0x49, 0xa9, 0x66], [...TIMECODE_SCALE, ...WRITING_APP]);
const TRACKS = element([0x16, 0x54, 0xae, 0x6b], [0x01, 0x02]);
const CLUSTER = element([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00]);
/** A live Segment: unknown size, as Chromium's recorder writes it. */
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function liveWebm(info = INFO): Uint8Array {
  return Uint8Array.from([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE, ...info, ...TRACKS, ...CLUSTER]);
}

test("a live WebM gets its length written into Info, after what Info already holds, and the rest stays byte for byte", () => {
  const original = liveWebm();
  assert.equal(webmDurationMs(original), undefined);
  const fixed = withWebmDuration(original, 12_345);
  assert.equal(fixed.length, original.length + 11);
  assert.equal(Math.round(webmDurationMs(fixed) ?? 0), 12_345);
  // Everything after Info moved by eleven bytes and nothing else changed.
  const infoStart = EBML_HEADER.length + 4 + UNKNOWN_SIZE.length;
  const infoEnd = infoStart + INFO.length;
  assert.deepEqual([...fixed.subarray(0, infoStart)], [...original.subarray(0, infoStart)]);
  assert.deepEqual([...fixed.subarray(infoEnd + 11)], [...original.subarray(infoEnd)]);
  assert.equal(fixed[infoStart + 4], 0x80 | (INFO.length - 5 + 11), "Info's size grew by the new element");
});

test("a WebM that already names a length has it replaced in place", () => {
  const withDuration = withWebmDuration(liveWebm(), 1_000);
  const again = withWebmDuration(withDuration, 2_500);
  assert.equal(again.length, withDuration.length);
  assert.equal(Math.round(webmDurationMs(again) ?? 0), 2_500);
});

test("the timecode scale is honoured, and a Segment of known size grows with its Info", () => {
  const microseconds = element([0x2a, 0xd7, 0xb1], [0x03, 0xe8]);
  const info = element([0x15, 0x49, 0xa9, 0x66], [...microseconds]);
  const body = [...info, ...TRACKS, ...CLUSTER];
  const known = Uint8Array.from([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, 0x40, body.length, ...body]);
  const fixed = withWebmDuration(known, 500);
  assert.equal(Math.round(webmDurationMs(fixed) ?? 0), 500);
  assert.equal(fixed[EBML_HEADER.length + 5], body.length + 11, "the Segment's size counts the new element");
});

test("what is not understood is left alone", () => {
  const seekHead = element([0x11, 0x4d, 0x9b, 0x74], [0x00]);
  const withSeekHead = Uint8Array.from([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE, ...seekHead, ...INFO, ...CLUSTER]);
  assert.equal(withWebmDuration(withSeekHead, 1_000), withSeekHead, "a seek table's positions would be wrong after an insertion");
  const noInfo = Uint8Array.from([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE, ...CLUSTER]);
  assert.equal(withWebmDuration(noInfo, 1_000), noInfo);
  const junk = Uint8Array.from([1, 2, 3, 4, 5]);
  assert.equal(withWebmDuration(junk, 1_000), junk);
  const zero = liveWebm();
  assert.equal(withWebmDuration(zero, 0), zero, "no length is no change");
  assert.equal(withWebmDuration(zero, Number.NaN), zero);
});
