import assert from "node:assert/strict";
import test from "node:test";
import { ComposerDrafts, draftKey, EMPTY_DRAFT, isEmptyDraft } from "./composer-drafts";
import type { AssetAttachment } from "./model";

const picture = (id: string): AssetAttachment => ({
  id, name: `${id}.png`, path: `C:\\shots\\${id}.png`, size: 10, addedAt: "2026-11-21T08:00:00.000Z", mediaType: "image/png",
});

test("a chat's draft, pictures included, comes back when the chat is opened again", () => {
  const drafts = new ComposerDrafts();
  const a = draftKey("project-1", "chat-a");
  const b = draftKey("project-2", "chat-b");
  drafts.put(a, { text: "Make the shop blue", pastedBlocks: [{ id: "paste-1", text: "long log" }], attachments: [picture("shot-1")], quotes: [] });
  drafts.put(b, { text: "Fix the timer", pastedBlocks: [], attachments: [], quotes: [] });

  assert.deepEqual(drafts.take(a), { text: "Make the shop blue", pastedBlocks: [{ id: "paste-1", text: "long log" }], attachments: [picture("shot-1")], quotes: [] });
  // Taken back into the box, it is no longer held: leaving again stores what the box holds then.
  assert.equal(drafts.take(a), EMPTY_DRAFT);
  assert.equal(drafts.take(b).text, "Fix the timer");
  assert.equal(drafts.size, 0);
});

test("an empty draft is not kept, and keys tell a chat from a project with no chat yet", () => {
  const drafts = new ComposerDrafts();
  drafts.put(draftKey("project-1", "chat-a"), { text: "  ", pastedBlocks: [], attachments: [], quotes: [] });
  assert.equal(drafts.size, 0);
  assert.ok(isEmptyDraft(EMPTY_DRAFT));
  assert.notEqual(draftKey("x", null), draftKey("other", "x"));
});

test("discarding a deleted chat's draft hands back its pictures to release, and only its own", () => {
  const drafts = new ComposerDrafts();
  drafts.put(draftKey("p", "gone"), { text: "", pastedBlocks: [], attachments: [picture("shot-1"), picture("shot-2")], quotes: [] });
  drafts.put(draftKey("p", "kept"), { text: "", pastedBlocks: [], attachments: [picture("shot-3")], quotes: [] });
  assert.deepEqual(drafts.discard([draftKey("p", "gone"), draftKey("p", "never")]), ["shot-1", "shot-2"]);
  assert.deepEqual(drafts.take(draftKey("p", "kept")).attachments.map((attachment) => attachment.id), ["shot-3"]);
});

test("a clip finished reading after its chat was left is ready when the chat is opened again", () => {
  const drafts = new ComposerDrafts();
  const key = draftKey("p", "c");
  drafts.put(key, { text: "", pastedBlocks: [], attachments: [picture("clip-1"), picture("shot-1")], quotes: [] });
  drafts.replaceAttachment({ ...picture("clip-1"), name: "read.mp4" });
  assert.deepEqual(drafts.take(key).attachments.map((attachment) => attachment.name), ["read.mp4", "shot-1.png"]);
});
