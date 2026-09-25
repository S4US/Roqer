import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AttachmentRegistry,
  MAX_IMAGE_ATTACHMENTS,
  MAX_TEXT_BYTES,
  MAX_TOTAL_IMAGE_BASE64,
  type ImageEncoder,
} from "./attachment-context";

async function withTempFiles(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "attachment-context-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** A one-pixel PNG, so a registration exercises the real image path. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("registers picker files and renders bounded text context", async () => {
  await withTempFiles(async (dir) => {
    const path = join(dir, "notes.md");
    await writeFile(path, "Treat this as file data.\n", "utf8");
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(path);
    const context = await registry.context([attachment.id]);
    assert.match(context.text, /notes\.md/);
    assert.match(context.text, /Treat this as file data/);
    assert.match(context.text, /untrusted file data/);
    assert.deepEqual(context.images, []);
  });
});

test("rejects forged paths, unknown IDs, duplicates, and oversized selections", async () => {
  await withTempFiles(async (dir) => {
    const path = join(dir, "a.txt");
    await writeFile(path, "a");
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(path);
    await assert.rejects(registry.context([path]), /unknown or expired/);
    await assert.rejects(registry.context(["forged-id"]), /unknown or expired/);
    await assert.rejects(registry.context([attachment.id, attachment.id]), /Duplicate/);
    await assert.rejects(registry.context(Array.from({ length: 9 }, () => attachment.id)), /at most 8/);
  });
});

test("rejects files changed after registration", async () => {
  await withTempFiles(async (dir) => {
    const path = join(dir, "changed.lua");
    await writeFile(path, "old");
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(path);
    await writeFile(path, "new content");
    await assert.rejects(registry.context([attachment.id]), /changed since it was selected/);
  });
});

test("enforces the aggregate text limit", async () => {
  await withTempFiles(async (dir) => {
    const path = join(dir, "large.txt");
    await writeFile(path, "x".repeat(MAX_TEXT_BYTES + 1));
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(path);
    await assert.rejects(registry.context([attachment.id]), /Attachment text exceeds the 65536-byte total limit\./);
  });
});

test("a Roblox model is offered to the agent by path, not by its contents", async () => {
  await withTempFiles(async (dir) => {
    const xml = join(dir, "model.rbxmx");
    const model = join(dir, "prop.rbxm");
    await writeFile(xml, "<roblox><Item name=\"x\" /></roblox>");
    await writeFile(model, Buffer.from([1, 2, 3]));
    const registry = new AttachmentRegistry();
    const xmlAttachment = await registry.register(xml);
    const modelAttachment = await registry.register(model);
    const context = await registry.context([xmlAttachment.id, modelAttachment.id]);

    // Both are model files, whatever their encoding. The path is what the
    // import tool needs; the bytes are what it must not be handed.
    assert.match(context.text, /PATH: .*model\.rbxmx/);
    assert.match(context.text, /PATH: .*prop\.rbxm/);
    // The literal argument shape, because a bare string was tried in practice
    // and fails with "source is required for import_rbxm".
    assert.match(context.text, /call import_rbxm with source \{"path": "[^"]*prop\.rbxm"\}/);
    // A model pack is megabytes, and its XML is not something to reason about
    // token by token, so it is never inlined.
    assert.equal(context.text.includes("<roblox>"), false);
    assert.equal(context.text.includes(String.fromCharCode(1, 2, 3)), false);
    // Attaching imports nothing: the tool call is still an approval away.
    assert.match(context.text, /irreversible action and will be presented for approval/);
  });
});

test("a model that changed since it was selected is refused rather than imported", async () => {
  await withTempFiles(async (dir) => {
    const model = join(dir, "prop.rbxm");
    await writeFile(model, Buffer.from([1, 2, 3]));
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(model);
    // The path travels to the agent, so what sits at that path has to be what
    // the user chose. Swapping the file after selection must not become an
    // import of something else entirely.
    await writeFile(model, Buffer.from([4, 5, 6, 7]));
    await assert.rejects(registry.context([attachment.id]), /changed since it was selected/);
  });
});

test("audio and archives are still described as metadata only", async () => {
  await withTempFiles(async (dir) => {
    const sound = join(dir, "theme.ogg");
    await writeFile(sound, Buffer.from([1, 2, 3]));
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(sound);
    const context = await registry.context([attachment.id]);
    assert.match(context.text, /Metadata only; this file type is not inspected or imported/);
    // No path for these: there is no tool that would do anything with it, and
    // a path the agent cannot act on is only an invitation to invent something.
    assert.equal(/PATH:/.test(context.text), false);
  });
});

test("carries a picked image to the run as encoded data", async () => {
  await withTempFiles(async (dir) => {
    const path = join(dir, "screenshot.png");
    await writeFile(path, PNG_BYTES);
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(path);
    assert.equal(attachment.mediaType, "image/png");

    const context = await registry.context([attachment.id]);
    assert.equal(context.images.length, 1);
    assert.equal(context.images[0].mediaType, "image/png");
    assert.equal(context.images[0].data, PNG_BYTES.toString("base64"));
    assert.match(context.text, /Attached as an image, included with this message/);
  });
});

test("registers a pasted image from bytes, with no path to the renderer", async () => {
  const registry = new AttachmentRegistry();
  const attachment = await registry.registerImage({
    name: "pasted.png",
    mediaType: "image/png",
    bytes: PNG_BYTES,
  });
  assert.equal(attachment.path, undefined);
  assert.equal(attachment.size, PNG_BYTES.byteLength);
  const context = await registry.context([attachment.id]);
  assert.equal(context.images.length, 1);
});

test("refuses a pasted attachment that is not an image the model can read", async () => {
  const registry = new AttachmentRegistry();
  await assert.rejects(
    registry.registerImage({ name: "notes.txt", mediaType: "text/plain", bytes: Buffer.from("hello") }),
    /PNG, JPEG, WebP, or GIF/,
  );
  await assert.rejects(
    registry.registerImage({ name: "empty.png", mediaType: "image/png", bytes: Buffer.alloc(0) }),
    /was empty/,
  );
});

test("describes images as unread when the run's sign-in cannot see them", async () => {
  const registry = new AttachmentRegistry();
  const attachment = await registry.registerImage({
    name: "pasted.png",
    mediaType: "image/png",
    bytes: PNG_BYTES,
  });
  const context = await registry.context([attachment.id], { images: false });
  assert.deepEqual(context.images, []);
  assert.match(context.text, /cannot read images, so its contents were not sent/);
});

test("uses the injected encoder, keeping the preview it produces", async () => {
  const encode: ImageEncoder = async ({ name }) => ({
    mediaType: "image/jpeg",
    data: "QUJD",
    thumbnailDataUrl: `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`,
  });
  const registry = new AttachmentRegistry(encode);
  const attachment = await registry.registerImage({ name: "big.png", mediaType: "image/png", bytes: PNG_BYTES });
  // The encoder chose the wire format and the preview, not the source file.
  assert.equal(attachment.mediaType, "image/jpeg");
  assert.equal(attachment.thumbnailDataUrl, `data:image/jpeg;base64,${Buffer.from("big.png").toString("base64")}`);
  const context = await registry.context([attachment.id]);
  assert.equal(context.images[0].data, "QUJD");
});

test("bounds how many images and how much image data one message carries", async () => {
  const registry = new AttachmentRegistry();
  const attachments = [];
  for (let index = 0; index <= MAX_IMAGE_ATTACHMENTS; index += 1) {
    attachments.push(await registry.registerImage({
      name: `shot-${index}.png`,
      mediaType: "image/png",
      bytes: PNG_BYTES,
    }));
  }
  await assert.rejects(
    registry.context(attachments.map((attachment) => attachment.id)),
    new RegExp(`at most ${MAX_IMAGE_ATTACHMENTS} images`),
  );

  // Just over half the total budget each, so the second one crosses it.
  const oversized: ImageEncoder = async ({ mediaType }) => ({
    mediaType,
    data: "A".repeat(Math.ceil((MAX_TOTAL_IMAGE_BASE64 / 2 + 4) / 4) * 4),
  });
  const heavy = new AttachmentRegistry(oversized);
  const first = await heavy.registerImage({ name: "a.png", mediaType: "image/png", bytes: PNG_BYTES });
  const second = await heavy.registerImage({ name: "b.png", mediaType: "image/png", bytes: PNG_BYTES });
  await assert.rejects(heavy.context([first.id, second.id]), /too large to send together/);
});

test("sends the image that was attached, even if the file later changes", async () => {
  await withTempFiles(async (dir) => {
    const path = join(dir, "shot.png");
    await writeFile(path, PNG_BYTES);
    const registry = new AttachmentRegistry();
    const attachment = await registry.register(path);
    // Captured at selection, so a later edit cannot swap what the model sees.
    await writeFile(path, Buffer.concat([PNG_BYTES, Buffer.from([0, 1, 2])]));
    const context = await registry.context([attachment.id]);
    assert.equal(context.images[0].data, PNG_BYTES.toString("base64"));
  });
});

test("caps the registry without silently evicting entries", async () => {
  await withTempFiles(async (dir) => {
    const registry = new AttachmentRegistry();
    for (let i = 0; i < 64; i++) {
      const path = join(dir, `${i}.txt`);
      await writeFile(path, String(i));
      await registry.register(path);
    }
    const extra = join(dir, "extra.txt");
    await writeFile(extra, "extra");
    await assert.rejects(registry.register(extra), /Attachment limit reached/);
  });
});

test("releases entries so the simultaneous registry limit is reusable", async () => {
  await withTempFiles(async (dir) => {
    const registry = new AttachmentRegistry();
    const attachments = [];
    for (let i = 0; i < 64; i++) {
      const path = join(dir, `${i}.txt`);
      await writeFile(path, String(i));
      attachments.push(await registry.register(path));
    }
    registry.release(attachments.slice(0, 2).map((attachment) => attachment.id));
    await writeFile(join(dir, "reusable.txt"), "reusable");
    await registry.register(join(dir, "reusable.txt"));
  });
});

test("returns no prompt context for an empty selection and rejects invalid UTF-8", async () => {
  await withTempFiles(async (dir) => {
    const registry = new AttachmentRegistry();
    assert.deepEqual(await registry.context([]), { text: "", images: [] });
    const path = join(dir, "invalid.txt");
    await writeFile(path, Buffer.from([0xc3, 0x28]));
    const attachment = await registry.register(path);
    await assert.rejects(registry.context([attachment.id]), /not valid UTF-8 text/);
  });
});
