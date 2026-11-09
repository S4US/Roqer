import assert from "node:assert/strict";
import test from "node:test";

import { attachmentDetail, clipLength } from "./attachment-detail";
import type { AssetAttachment } from "./model";

const file = (name: string, extra: Partial<AssetAttachment> = {}): AssetAttachment =>
  ({ id: "a", name, size: 1, addedAt: "2026-01-01T00:00:00.000Z", ...extra });
const clip = (extra: object) => file("sword.mp4", { clip: { duration: 8, start: 2.4, end: 4.16, slow: 1, ...extra } } as Partial<AssetAttachment>);
const reaches = { imagesReachModel: true, reading: false, readsText: true };

test("a clip says what it is, then that it is being read, then what was chosen", () => {
  assert.deepEqual(attachmentDetail(clip({}), reaches), { text: "0:08 video", warning: false });
  assert.equal(attachmentDetail(clip({}), { ...reaches, reading: true }).text, "Reading its frames…");
  assert.equal(attachmentDetail(clip({ id: "c1" }), reaches).text, "1.76 s clip shared with agent as frames");
});

test("a chosen clip is measured at real speed", () => {
  assert.equal(attachmentDetail(clip({ id: "c1", slow: 2 }), reaches).text, "0.88 s clip shared with agent as frames");
});

test("a sign-in that cannot read images is a warning, for pictures and clips alike", () => {
  const blind = { ...reaches, imagesReachModel: false };
  assert.deepEqual(attachmentDetail(file("a.png", { mediaType: "image/png" }), blind), { text: "Image saved; this sign-in cannot read images", warning: true });
  assert.deepEqual(attachmentDetail(clip({ id: "c1" }), blind), { text: "1.76 s clip saved; this sign-in cannot read images", warning: true });
});

test("only a text file the desktop can read is promised to the agent", () => {
  assert.equal(attachmentDetail(file("notes.md"), reaches).text, "Text shared with agent");
  assert.equal(attachmentDetail(file("notes.md"), { ...reaches, readsText: false }).text, "File details only; contents not read");
  assert.equal(attachmentDetail(file("castle.rbxl"), reaches).text, "File details only; contents not read");
});

test("a clip's length rounds to whole seconds", () => {
  assert.equal(clipLength(8.2), "0:08");
  assert.equal(clipLength(75), "1:15");
});
