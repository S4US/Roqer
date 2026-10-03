import assert from "node:assert/strict";
import test from "node:test";

import { clipSeconds, effectSeconds, REFERENCE_CLIP_OPERATION } from "../shared/reference-clip";
import type { ClipAnalysis } from "./clip-analysis";
import type { ClipManifest } from "./clip-store";
import {
  framesBetween,
  nearestFrame,
  parseReferenceClipToolInput,
  planClipSheets,
  readReferenceClip,
  sheetColumns,
  spread,
  type ClipSheetComposer,
  type ClipSource,
} from "./reference-clip";
import { MalformedToolCallError } from "./studio-tools";

const ID = "0123456789ab";

/**
 * A clip the user marked as played at half speed, selected from 1 s: sixty
 * frames stored 1/60 s of clip time apart, so 1/120 s of effect time apart.
 */
function manifest(analysis: Partial<ClipAnalysis> = {}, overrides: Partial<ClipManifest> = {}): ClipManifest {
  return {
    version: 1,
    id: ID,
    name: "nova.mp4",
    duration: 5,
    width: 1280,
    height: 720,
    selection: { start: 1, end: 2, slow: 2 },
    frames: Array.from({ length: 60 }, (_, index) => 1 + index / 60),
    analysis: { active: true, cameraMoves: false, onset: 0.1, peak: 0.2, half: 0.4, end: 1.2, phases: [], crop: { x: 0.5, y: 0.2, width: 0.3, height: 0.5 }, ...analysis },
    createdAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

function source(clips: ClipManifest[]): ClipSource & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    list: async () => clips,
    read: async (id) => clips.find((clip) => clip.id === id),
    frame: async (_clip, index) => {
      reads.push(index);
      return Buffer.from([0xff, 0xd8, 0xff, index]);
    },
  };
}

function composer() {
  const calls: Array<{ count: number; columns: number; labels: readonly string[]; crop?: unknown }> = [];
  const compose: ClipSheetComposer = async (frames, options) => {
    calls.push({ count: frames.length, columns: options.columns, labels: options.labels, crop: options.crop });
    return { data: "c2hlZXQ=", mediaType: "image/jpeg" };
  };
  return { compose, calls };
}

test("effect time starts at the selection and plays a slowed clip at real speed", () => {
  const selection = { start: 1, end: 2, slow: 2 };
  assert.equal(effectSeconds(1.5, selection), 0.25);
  assert.equal(clipSeconds(0.25, selection), 1.5);
  for (const time of [1, 1.25, 1.9]) assert.equal(clipSeconds(effectSeconds(time, selection), selection), time);
  const clip = manifest();
  // Frame 30 is 0.5 s into the clip's selection, a quarter second of effect time.
  assert.deepEqual(framesBetween(clip, 0.25, 0.255), [30]);
  assert.equal(nearestFrame(clip, 0.251), 30);
  assert.equal(nearestFrame(clip, 99), 59);
});

test("spreading picks evenly from the first frame to the last", () => {
  assert.deepEqual(spread([1, 2, 3], 8), [1, 2, 3]);
  assert.deepEqual(spread([0, 1, 2, 3, 4, 5, 6, 7, 8], 3), [0, 4, 8]);
  assert.deepEqual(spread([4, 5, 6], 1), [4]);
  assert.deepEqual([1, 2, 4, 5, 9, 10, 16, 17].map(sheetColumns), [1, 2, 2, 3, 3, 4, 4, 4]);
});

test("an attached clip is sent as an overview of where it changes and a close-up of its start", () => {
  const clip = manifest();
  const [overview, closeUp] = planClipSheets(clip);
  assert.equal(overview!.indexes.length, 16);
  // The active stretch, padded: 0.1 s - 1.2 s of effect time, never the quiet either side.
  const times = overview!.indexes.map((index) => effectSeconds(clip.frames[index]!, clip.selection));
  assert.ok(times[0]! >= 0 && times[0]! <= 0.1, String(times[0]));
  assert.ok(times[times.length - 1]! <= 1.35);
  assert.equal(closeUp!.title, "close-up of the start");
  const closeTimes = closeUp!.indexes.map((index) => effectSeconds(clip.frames[index]!, clip.selection));
  assert.ok(closeTimes[0]! >= 0.1 && closeTimes[closeTimes.length - 1]! <= 0.4, closeTimes.join(","));
  // Nothing measured, or a moving camera: the whole selection, and no close-up.
  assert.equal(planClipSheets(manifest({ active: false, onset: undefined })).length, 1);
  assert.equal(planClipSheets(manifest({ cameraMoves: true })).length, 1);
  // A clip short enough to show whole needs no close-up.
  const short = manifest({}, { frames: [1, 1.1, 1.2, 1.3], selection: { start: 1, end: 1.4, slow: 1 } });
  assert.equal(planClipSheets(short).length, 1);
});

test("a call is checked before it reads anything", () => {
  assert.throws(() => parseReferenceClipToolInput({ clip: "nova", from: 0, to: 1 }), MalformedToolCallError);
  assert.throws(() => parseReferenceClipToolInput({ clip: ID, from: -1, to: 1 }), /from must be a number of effect seconds/);
  assert.throws(() => parseReferenceClipToolInput({ clip: ID, from: 1, to: 0.5 }), /to must not be before from/);
  assert.throws(() => parseReferenceClipToolInput({ clip: ID, from: 0, to: 1, count: 17 }), /count must be a whole number from 1 to 16/);
  assert.throws(() => parseReferenceClipToolInput({ clip: ID, from: 0, to: 1, crop: "zoom" }), /crop must be effect or full/);
  assert.deepEqual(parseReferenceClipToolInput({ clip: ID, from: 0, to: 1, count: 4, crop: "full", extra: 1 }), {
    operation: REFERENCE_CLIP_OPERATION,
    args: { clip: ID, from: 0, to: 1, count: 4, crop: "full" },
  });
});

test("a closer look tiles the stored frames of a span, labelled with their effect times", async () => {
  const clips = source([manifest()]);
  const { compose, calls } = composer();
  const result = await readReferenceClip({ clip: ID, from: 0.1, to: 0.2, count: 16 }, {}, clips, compose);
  assert.equal(result.ok, true);
  assert.equal(result.images?.length, 1);
  // 0.10-0.20 s of effect time is 0.2 s of a clip stored at 60 a second: 13 frames, all of them,
  // 120 a second of real time.
  assert.equal(calls[0]!.count, 13);
  assert.equal(calls[0]!.columns, 4);
  assert.equal(calls[0]!.labels[0], "1 0.10s");
  assert.equal(calls[0]!.labels[12], "13 0.20s");
  assert.deepEqual(calls[0]!.crop, { x: 0.5, y: 0.2, width: 0.3, height: 0.5 });
  assert.match(result.text, /^Clip 0123456789ab \("nova\.mp4", 0\.50 s, 60 frames\): 13 frames at 0\.10-0\.20 s, every stored frame there \(stored at about 120 a second\)\. Tiled 4 to a row/);
  assert.match(result.text, /cropped to where the clip changes/);
  assert.match(result.text, /Pass crop: "full"/);

  const full = await readReferenceClip({ clip: ID, from: 0, to: 0.5, count: 4, crop: "full" }, {}, clips, compose);
  assert.equal(calls[1]!.crop, undefined);
  assert.equal(calls[1]!.count, 4);
  assert.match(full.text, /4 frames at 0\.00-0\.49 s, spread evenly over the 60 stored frames there/);
  assert.doesNotMatch(full.text, /cropped/);
});

test("a span between two stored frames shows the nearest, and one past the end says where the clip ends", async () => {
  const { compose, calls } = composer();
  const between = await readReferenceClip({ clip: ID, from: 0.251, to: 0.252 }, {}, source([manifest()]), compose);
  assert.equal(between.ok, true);
  assert.equal(calls[0]!.count, 1);
  const past = await readReferenceClip({ clip: ID, from: 3, to: 4 }, {}, source([manifest()]), compose);
  assert.equal(past.ok, false);
  assert.match(past.text, /ends at 0\.49 s of effect time/);
});

test("a clip the chat does not hold names the ones it does", async () => {
  const { compose } = composer();
  const other = await readReferenceClip({ clip: "aaaaaaaaaaaa", from: 0, to: 1 }, {}, source([manifest()]), compose);
  assert.equal(other.ok, false);
  assert.match(other.text, /This chat has no clip aaaaaaaaaaaa\. This chat's clips, most recently used first: 0123456789ab \("nova\.mp4"/);
  const none = await readReferenceClip({ clip: ID, from: 0, to: 1 }, {}, source([]), compose);
  assert.match(none.text, /holds no reference clips now: Roqer clears a clip 30 days after it was last used/);
  const malformed = await readReferenceClip({ clip: ID }, {}, source([]), compose);
  assert.equal(malformed.ok, false);
  assert.match(malformed.text, /from must be/);
});
