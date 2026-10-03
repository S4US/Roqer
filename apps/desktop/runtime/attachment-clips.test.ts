import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AttachmentRegistry } from "./attachment-context";
import type { AnalysisFrame } from "./clip-analysis";
import type { ClipFrame, ClipSource, ClipSupport } from "./clip-source";
import { clipScope, ClipStore } from "./clip-store";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(20)]);
const SCOPE = clipScope("chat-1");

/** A frame that carries its clip time, 30 frames a second, in its last two bytes. */
function jpegAt(time: number): Buffer {
  const index = Math.round(time * 30);
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, index >> 8, index & 255]);
}

/** An 8x8 frame: black, with a white square while the effect plays (0.5 s-3 s of the clip). */
function analysisFrame(jpeg: Buffer, time: number): AnalysisFrame {
  const clipTime = ((jpeg[4]! << 8) | jpeg[5]!) / 30;
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel++) {
    const lit = clipTime >= 0.5 && clipTime <= 3 && pixel % 8 >= 2 && pixel % 8 < 6 && pixel >= 16 && pixel < 48;
    pixels.set(lit ? [255, 255, 255, 255] : [0, 0, 0, 255], pixel * 4);
  }
  return { time, width: 8, height: 8, pixels };
}

type Fake = {
  support: ClipSupport;
  store: ClipStore;
  composed: Array<{ count: number; labels: readonly string[] }>;
  /** Hold the next capture until released. */
  hold(): () => void;
};

function fakeClips(root: string, durations: { video?: number; image?: number } = {}): Fake {
  const store = new ClipStore(root);
  const composed: Fake["composed"] = [];
  let gate: Promise<void> | undefined;
  const support: ClipSupport = {
    info: async (source: ClipSource) => {
      if (source.kind === "image") {
        if (source.mediaType !== "image/gif") throw new Error("not animated");
        return { duration: durations.image ?? 2, width: 64, height: 64 };
      }
      return { duration: durations.video ?? 4, width: 1920, height: 1080 };
    },
    strip: async (_source, times) => times.map((time) => ({ time, jpeg: JPEG })),
    capture: async (_source, selection) => {
      await gate;
      const frames: ClipFrame[] = [];
      for (let time = selection.start; time <= selection.end + 1e-9; time += 1 / 30) frames.push({ time: Math.round(time * 1000) / 1000, jpeg: jpegAt(time) });
      return { frames };
    },
    thumbnail: async () => "data:image/jpeg;base64,AAAA",
    analysisFrame: async (jpeg, time) => analysisFrame(jpeg, time),
    pixelOrder: "rgba",
    store,
    compose: async (frames, options) => {
      composed.push({ count: frames.length, labels: options.labels });
      return { data: "c2hlZXQ=", mediaType: "image/jpeg" };
    },
  };
  return {
    support,
    store,
    composed,
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { release(); gate = undefined; };
    },
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "attachment-clips-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function videoFile(root: string, name = "nova.mp4"): Promise<string> {
  const path = join(root, name);
  await writeFile(path, "video bytes");
  return path;
}

test("a picked video is attached as a clip, all of it selected, with a preview", async () => {
  await withRoot(async (root) => {
    const registry = new AttachmentRegistry(undefined, fakeClips(root).support);
    const clip = await registry.register(await videoFile(root));
    assert.equal(clip.mediaType, "video/mp4");
    assert.equal(clip.thumbnailDataUrl, "data:image/jpeg;base64,AAAA");
    assert.deepEqual(clip.clip, { duration: 4, start: 0, end: 4, slow: 1 });
    // A long clip starts with its first ten seconds selected.
    const long = new AttachmentRegistry(undefined, fakeClips(root, { video: 75 }).support);
    assert.deepEqual((await long.register(await videoFile(root, "long.mov"))).clip, { duration: 75, start: 0, end: 10, slow: 1 });
  });
});

test("without clip support a video cannot be attached", async () => {
  await withRoot(async (root) => {
    await assert.rejects(new AttachmentRegistry().register(await videoFile(root)), /cannot be attached here/);
  });
});

test("only clips the registry issued can be read, and only within them", async () => {
  await withRoot(async (root) => {
    const registry = new AttachmentRegistry(undefined, fakeClips(root).support);
    const clip = await registry.register(await videoFile(root));
    const still = await registry.registerImage({ name: "a.png", mediaType: "image/png", bytes: PNG });
    for (const id of ["forged", still.id, 7]) {
      await assert.rejects(registry.clipStrip(id, null, 4), /no longer attached/);
      await assert.rejects(registry.clipFrame(id, 1), /no longer attached/);
      await assert.rejects(registry.selectClip(id, { start: 0, end: 1, slow: 1 }), /no longer attached/);
    }
    await assert.rejects(registry.clipStrip(clip.id, null, 0), /1 to 24/);
    await assert.rejects(registry.clipStrip(clip.id, null, 25), /1 to 24/);
    await assert.rejects(registry.clipStrip(clip.id, { start: 1, end: 9 }, 4), /not a part of the clip/);
    await assert.rejects(registry.clipFrame(clip.id, 4.5), /not in the clip/);
    const strip = await registry.clipStrip(clip.id, { start: 1, end: 2 }, 4);
    assert.deepEqual(strip.map((frame) => frame.time), [1.125, 1.375, 1.625, 1.875]);
    assert.match(strip[0]!.dataUrl, /^data:image\/jpeg;base64,/);
  });
});

test("choosing a part reads, measures and keeps its frames, and choosing again replaces them", async () => {
  await withRoot(async (root) => {
    const fake = fakeClips(root, { video: 30 });
    const registry = new AttachmentRegistry(undefined, fake.support);
    const clip = await registry.register(await videoFile(root));
    await assert.rejects(registry.selectClip(clip.id, { start: 0, end: 12, slow: 1 }), /at most 10 seconds/);
    await assert.rejects(registry.selectClip(clip.id, { start: 0, end: 2, slow: 0.5 }), /up to 16 times slower/);

    const read = await registry.selectClip(clip.id, { start: 0, end: 4, slow: 2 });
    assert.equal(read.clip?.frames, 121);
    assert.equal(read.clip?.slow, 2);
    const first = await fake.store.readPending(read.clip!.id!);
    assert.ok(first);
    // Measured in effect time: the square lights at 0.5 s of the clip, 0.25 s of a clip slowed twice
    // (a frame earlier, as the measure is smoothed over three frames).
    assert.ok(first.analysis.onset! >= 0.23 && first.analysis.onset! <= 0.25, String(first.analysis.onset));

    const again = await registry.selectClip(clip.id, { start: 1, end: 3, slow: 1 });
    assert.notEqual(again.clip?.id, read.clip?.id);
    assert.equal(await fake.store.readPending(read.clip!.id!), undefined);
  });
});

test("a clip cannot be read twice at once", async () => {
  await withRoot(async (root) => {
    const fake = fakeClips(root);
    const registry = new AttachmentRegistry(undefined, fake.support);
    const clip = await registry.register(await videoFile(root));
    const release = fake.hold();
    const reading = registry.selectClip(clip.id, { start: 0, end: 4, slow: 1 });
    await assert.rejects(registry.selectClip(clip.id, { start: 0, end: 2, slow: 1 }), /still reading/);
    await assert.rejects(registry.context([clip.id], { scope: SCOPE }), /wait for Roqer to read it/);
    release();
    await reading;
  });
});

test("a run adopts the clip into its chat and numbers its sheets among the message's pictures", async () => {
  await withRoot(async (root) => {
    const fake = fakeClips(root);
    const registry = new AttachmentRegistry(undefined, fake.support);
    const still = await registry.registerImage({ name: "a.png", mediaType: "image/png", bytes: PNG });
    const clip = await registry.register(await videoFile(root));
    await assert.rejects(registry.context([clip.id], { scope: SCOPE }), /Choose the part of “nova\.mp4” to send/);
    const read = await registry.selectClip(clip.id, { start: 0, end: 4, slow: 1 });
    await assert.rejects(registry.context([clip.id]), /only be sent in a chat/);

    const context = await registry.context([still.id, clip.id], { scope: SCOPE });
    assert.deepEqual((await fake.store.list(SCOPE)).map((manifest) => manifest.id), [read.clip!.id]);
    // The still first, then the clip's overview and close-up, in attachment order.
    assert.equal(context.images.length, 3);
    assert.equal(context.images[0]!.name, "a.png");
    assert.equal(context.images[1]!.name, "nova.mp4, overview");
    assert.equal(context.images[2]!.name, "nova.mp4, close-up of the start");
    assert.match(context.text, /Image 2 of this message, overview: 16 frames at/);
    assert.match(context.text, /Image 3 of this message, close-up of the start: 8 frames at/);
    assert.match(context.text, new RegExp(`Clip id: ${read.clip!.id}\\.`));
    assert.match(context.text, /call reference_clip with clip/);
    const labels = fake.composed[0]!.labels;
    assert.equal(labels.length, 16);
    assert.match(labels[0]!, /^1 0\.\d\ds$/);
    assert.match(labels[15]!, /^16 \d\.\d\ds$/);

    // Without images the clip is still described, and says its frames were not sent.
    const textOnly = new AttachmentRegistry(undefined, fake.support);
    const other = await textOnly.register(await videoFile(root, "b.mp4"));
    await textOnly.selectClip(other.id, { start: 0, end: 4, slow: 1 });
    const described = await textOnly.context([other.id], { images: false, scope: SCOPE });
    assert.deepEqual(described.images, []);
    assert.match(described.text, /Its frames were not sent: this sign-in cannot read images/);
    assert.match(described.text, /Timing/);
  });
});

test("a clip's sheets count against the pictures one message carries", async () => {
  await withRoot(async (root) => {
    const registry = new AttachmentRegistry(undefined, fakeClips(root).support);
    const stills = [];
    for (let index = 0; index < 3; index++) stills.push(await registry.registerImage({ name: `${index}.png`, mediaType: "image/png", bytes: PNG }));
    const clip = await registry.register(await videoFile(root));
    await registry.selectClip(clip.id, { start: 0, end: 4, slow: 1 });
    await assert.rejects(registry.context([...stills.map((still) => still.id), clip.id], { scope: SCOPE }), /sent as 2 images, and one message carries at most 4/);
  });
});

test("releasing a clip removes its unsent frames and a dropped video's copy", async () => {
  await withRoot(async (root) => {
    const fake = fakeClips(root);
    const registry = new AttachmentRegistry(undefined, fake.support);
    const temporary = join(root, "dropped.mp4");
    await writeFile(temporary, "dropped");
    const clip = await registry.registerClip({ name: "drop.mp4", size: 7, mediaType: "video/mp4", source: { kind: "video", path: temporary }, temporary });
    const read = await registry.selectClip(clip.id, { start: 0, end: 4, slow: 1 });
    registry.release([clip.id]);
    // Released in the background: give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(access(temporary));
    assert.equal(await fake.store.readPending(read.clip!.id!), undefined);
  });
});

test("a dropped video that cannot be read leaves no copy behind", async () => {
  await withRoot(async (root) => {
    const fake = fakeClips(root);
    const failing: ClipSupport = { ...fake.support, info: async () => { throw new Error("Roqer cannot play this video's format here."); } };
    const registry = new AttachmentRegistry(undefined, failing);
    const temporary = join(root, "prores.mov");
    await writeFile(temporary, "x");
    await assert.rejects(registry.registerClip({ name: "p.mov", size: 1, mediaType: "video/quicktime", source: { kind: "video", path: temporary }, temporary }), /cannot play/);
    await assert.rejects(access(temporary));
  });
});

test("an animated GIF becomes a clip; a still picture stays a picture", async () => {
  await withRoot(async (root) => {
    const registry = new AttachmentRegistry(undefined, fakeClips(root).support);
    const gif = await registry.registerImage({ name: "spark.gif", mediaType: "image/png", bytes: GIF });
    assert.equal(gif.mediaType, "image/gif");
    assert.deepEqual(gif.clip, { duration: 2, start: 0, end: 2, slow: 1 });
    const png = await registry.registerImage({ name: "a.png", mediaType: "image/png", bytes: PNG });
    assert.equal(png.clip, undefined);
    assert.equal(png.mediaType, "image/png");
  });
});
