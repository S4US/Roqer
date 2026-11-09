import assert from "node:assert/strict";
import test from "node:test";

import { nextReveal, noteReveal, resumeReveal, REVEAL_MIN_CHARACTERS_PER_SECOND, revealEnd, REVEALS_KEPT } from "./streaming-reveal";

const FRAME = 1000 / 60;

/** Frames until `arrived` characters are all shown, starting from `shown`. */
function framesToShow(shown: number, arrived: number, done: boolean): number {
  let frames = 0;
  while (shown < arrived) {
    shown = nextReveal(shown, arrived, FRAME, done);
    frames += 1;
  }
  return frames;
}

test("a burst is shown over several frames, not all at once", () => {
  const first = nextReveal(0, 120, FRAME, false);
  assert.ok(first > 0 && first < 20, `first frame showed ${first}`);
  // Spread over roughly a second at most: smooth, and never far behind.
  const frames = framesToShow(0, 120, false);
  assert.ok(frames > 10 && frames < 70, `took ${frames} frames`);
});

test("the shown text never goes back and never passes what has arrived", () => {
  let shown = 0;
  let arrived = 0;
  for (let frame = 0; frame < 400; frame += 1) {
    if (frame % 9 === 0) arrived += 40;
    const next = nextReveal(shown, arrived, FRAME, false);
    assert.ok(next >= shown && next <= arrived);
    shown = next;
  }
  assert.equal(nextReveal(50, 50, FRAME, false), 50);
  assert.equal(nextReveal(60, 50, FRAME, false), 50);
});

test("a steady stream is followed closely, and a short tail still finishes", () => {
  // 400 characters a second, about as fast as a model writes.
  let shown = 0;
  let arrived = 0;
  for (let frame = 0; frame < 300; frame += 1) {
    arrived += 400 / 60;
    shown = nextReveal(shown, arrived, FRAME, false);
  }
  assert.ok(arrived - shown < 200, `behind by ${arrived - shown}`);
  // Two characters left still go at the minimum pace, not ever more slowly.
  assert.ok(nextReveal(0, 2, FRAME, false) >= (REVEAL_MIN_CHARACTERS_PER_SECOND * FRAME) / 1000);
});

test("once the run has ended, the rest is shown faster, still within about a second", () => {
  assert.ok(framesToShow(0, 2000, true) < framesToShow(0, 2000, false) * 0.75);
  assert.ok(framesToShow(0, 2000, true) <= 66);
  assert.ok(framesToShow(0, 100, true) < framesToShow(0, 100, false));
});

test("a long pause, such as a hidden window, counts as one short frame", () => {
  assert.equal(nextReveal(0, 10_000, 5_000, false), nextReveal(0, 10_000, 100, false));
  assert.equal(nextReveal(0, 100, -5, false), 0);
});

test("the cut never splits a character made of two code units", () => {
  const text = "Fire 🔥 ready";
  const inside = text.indexOf("🔥") + 1;
  assert.equal(revealEnd(text, inside), inside - 1);
  assert.equal(revealEnd(text, inside + 1), inside + 1);
  assert.equal(revealEnd(text, 3.7), 3);
  assert.equal(revealEnd(text, 999), text.length);
  assert.equal(revealEnd(text, -1), 0);
});

test("a view taking over a reply carries on from the same character", () => {
  const reply = "Done. The fireball now launches 0.2 s sooner.";
  noteReveal("run-1", reply, 12.6);
  assert.equal(resumeReveal("run-1", reply), 12.6);
  // Still there for a later view, such as the chat opened again.
  assert.equal(resumeReveal("run-1", reply), 12.6);
  // A reveal that finished stays finished, even if the saved reply is longer.
  noteReveal("run-1", "Done.", 5);
  assert.equal(resumeReveal("run-1", "Done. More."), "Done. More.".length);
  assert.equal(resumeReveal("never", reply), undefined);
});

test("a reveal is not carried on into different words, nor past the text", () => {
  noteReveal("run-2", "Done. The fireball", 10);
  assert.equal(resumeReveal("run-2", "Finished. Something else"), undefined);
  noteReveal("run-3", "Done. The fireball", 15);
  assert.equal(resumeReveal("run-3", "Done. The"), undefined);
  // Part way into a character, the reveal still stops at the text's end.
  noteReveal("run-4", "Done.", 2.5);
  assert.equal(resumeReveal("run-4", "Do"), 2);
});

test("only the most recent reveals are kept", () => {
  noteReveal("oldest", "a", 0);
  for (let index = 0; index < REVEALS_KEPT; index += 1) noteReveal(`later-${index}`, "a", 0);
  assert.equal(resumeReveal("oldest", "a"), undefined);
  assert.equal(resumeReveal(`later-${REVEALS_KEPT - 1}`, "a"), 0);
});
