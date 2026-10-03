import assert from "node:assert/strict";
import test from "node:test";

import { defaultSelection, formatClipTime, isAttachmentClip, selectionProblem } from "./reference-clip";
import { isPersistedAttachment } from "./workspace-validation";

test("a new selection must lie inside the clip, last a twentieth to ten seconds, and play at a sane speed", () => {
  assert.equal(selectionProblem({ start: 1, end: 3, slow: 1 }, 30), undefined);
  assert.match(String(selectionProblem({ start: 0, end: 12, slow: 1 }, 30)), /at most 10 seconds/);
  assert.match(String(selectionProblem({ start: 5, end: 5.01, slow: 1 }, 30)), /a twentieth of a second/);
  assert.match(String(selectionProblem({ start: 29, end: 31, slow: 1 }, 30)), /inside the clip/);
  assert.match(String(selectionProblem({ start: 0, end: 1, slow: 0.5 }, 30)), /16 times slower/);
  assert.match(String(selectionProblem({ start: "0", end: 1, slow: 1 }, 30)), /times in the clip/);
  assert.match(String(selectionProblem(null, 30)), /Choose the part/);
  assert.deepEqual(defaultSelection(4.2), { start: 0, end: 4.2, slow: 1 });
  assert.deepEqual(defaultSelection(75), { start: 0, end: 10, slow: 1 });
  assert.equal(formatClipTime(63.25), "1:03.25");
});

test("a saved clip record is checked for its shape, not against today's selection limits", () => {
  const clip = { duration: 40, start: 0, end: 30, slow: 1, id: "0123456789ab", frames: 900 };
  // Longer than a new selection may be, and with more frames than are kept now: still readable.
  assert.equal(isAttachmentClip(clip), true);
  assert.equal(isAttachmentClip({ ...clip, id: "../../x" }), false);
  assert.equal(isAttachmentClip({ ...clip, end: 41 }), false);
  assert.equal(isAttachmentClip({ ...clip, start: 5, end: 5 }), false);
  assert.equal(isAttachmentClip({ ...clip, frames: 0 }), false);
  assert.equal(isAttachmentClip({ ...clip, duration: Number.NaN }), false);
  const attachment = { id: "a", name: "nova.mp4", size: 10, addedAt: "2026-10-03T00:00:00.000Z", mediaType: "video/mp4" };
  assert.equal(isPersistedAttachment({ ...attachment, clip }), true);
  assert.equal(isPersistedAttachment({ ...attachment, clip: { ...clip, slow: "fast" } }), false);
  assert.equal(isPersistedAttachment(attachment), true);
});
