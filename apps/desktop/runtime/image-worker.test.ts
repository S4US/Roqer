import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImageWorker } from "./image-worker";
import type { GeneratedImages, ImageRequest, ImageSource } from "./image-sources/openai-images";
import { rgbaPng } from "./test-rgba-png";

const centre = 31.5;
const glow = rgbaPng(64, 64, (x, y) => [255, 255, 255, Math.round(Math.max(0, 1 - Math.hypot(x - centre, y - centre) / 28) * 255)]);
const disc = rgbaPng(64, 64, (x, y) => Math.hypot(x - centre, y - centre) < 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]);

function fakeSource(answer: (request: ImageRequest, signal: AbortSignal) => Promise<GeneratedImages>): ImageSource & { requests: ImageRequest[] } {
  const requests: ImageRequest[] = [];
  return {
    label: "Fake images",
    requests,
    generate: (request, signal) => { requests.push(request); return answer(request, signal); },
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "roqer-image-jobs-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const args = { prompt: "a soft white glow", kind: "light", background: "transparent", size: "1024x1024", count: 1, name: "glow" };

test("a job keeps its pictures with a record of how they were made, measures them, and shows the model one on a dark ground", async () => withRoot(async (root) => {
  const source = fakeSource(async () => ({ images: [glow], model: "gpt-image-1", revisedPrompt: "A soft glow." }));
  const worker = new ImageWorker({ source, jobsRoot: root, scope: "chat-a", defaultQuality: "medium", studioContentDirectories: async () => [] });
  const outcome = await worker.run(args, {});
  assert.equal(outcome.ok, true, outcome.text);
  const data = outcome.data as Record<string, unknown>;
  assert.match(String(data.jobId), /^[0-9a-f]{8}$/);
  const images = data.images as Array<Record<string, unknown>>;
  assert.equal(images.length, 1);
  assert.equal(images[0].name, "glow.png");
  assert.equal(images[0].family, "soft");
  assert.equal(images[0].width, 64);
  assert.equal(outcome.images?.length, 1, "one picture attached");
  assert.equal(outcome.pictured?.name, "glow.png");
  assert.match(outcome.text, /Image job [0-9a-f]{8}: 1 image from Fake images \(gpt-image-1\) for kind light, 1024x1024, transparent background, quality medium\./);
  assert.match(outcome.text, /rewording of the prompt: A soft glow\./);
  assert.match(outcome.text, /glow\.png: 64×64; .*family: soft light/);
  assert.match(outcome.text, /shown over a dark ground/);
  assert.equal(source.requests[0].quality, "medium", "the default quality from Settings");
  const folders = await readdir(root);
  assert.equal(folders.length, 1);
  const files = (await readdir(join(root, folders[0]))).sort();
  assert.deepEqual(files, ["glow.json", "glow.png", "job.json"]);
  const sidecar = JSON.parse(await readFile(join(root, folders[0], "glow.json"), "utf8")) as Record<string, unknown>;
  assert.equal(sidecar.prompt, "a soft white glow");
  assert.equal(sidecar.model, "gpt-image-1");
  assert.equal(sidecar.source, "Fake images");
  assert.ok((await readFile(join(root, folders[0], "glow.png"))).equals(glow));
}));

test("several pictures are numbered and shown as one review sheet, and a later job may vary one of them", async () => withRoot(async (root) => {
  const source = fakeSource(async () => ({ images: [disc, glow, disc], model: "m" }));
  const worker = new ImageWorker({ source, jobsRoot: root, scope: "chat-a", defaultQuality: "low", studioContentDirectories: async () => [] });
  const first = await worker.run({ ...args, kind: "matter", name: "puff", count: 3 }, {});
  assert.equal(first.ok, true, first.text);
  const data = first.data as { jobId: string; images: Array<{ name: string; family: string }> };
  assert.deepEqual(data.images.map((image) => image.name), ["puff.png", "puff_2.png", "puff_3.png"]);
  assert.deepEqual(data.images.map((image) => image.family), ["crisp", "soft", "crisp"]);
  assert.equal(first.images?.length, 1, "one review sheet for several pictures");
  assert.match(first.text, /review sheet of the pictures is attached/);

  const second = await worker.run({ ...args, kind: "matter", name: "puff_edit", reference: { output: `${data.jobId}/puff_2.png` } }, {});
  assert.equal(second.ok, true, second.text);
  assert.ok(source.requests[1].reference?.bytes.equals(glow), "the reference is the earlier output's bytes");
  assert.equal(source.requests[1].reference?.name, "puff_2.png");

  const elsewhere = new ImageWorker({ source, jobsRoot: root, scope: "chat-b", defaultQuality: "low", studioContentDirectories: async () => [] });
  const refused = await elsewhere.run({ ...args, name: "x", reference: { output: `${data.jobId}/puff_2.png` } }, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "reference_not_found");
  assert.match(refused.text, /no image .* in this chat's jobs/);
  const missing = await worker.run({ ...args, name: "x", reference: { output: `${data.jobId}/nothing.png` } }, {});
  assert.equal(missing.ok, false);
}));

test("a source that fails, a stopped run, and bytes that are not a PNG are each reported as themselves", async () => withRoot(async (root) => {
  const failing = fakeSource(async () => { throw new Error("OpenAI refused the request (401): bad key"); });
  const worker = new ImageWorker({ source: failing, jobsRoot: root, scope: "s", defaultQuality: "low", studioContentDirectories: async () => [] });
  const failed = await worker.run(args, {});
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, "image_source_failed");
  assert.match(failed.text, /bad key/);

  const controller = new AbortController();
  const slow = fakeSource((_request, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const stopped = new ImageWorker({ source: slow, jobsRoot: root, scope: "s", defaultQuality: "low", studioContentDirectories: async () => [] });
  const pending = stopped.run(args, { signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.errorCode, "cancelled");
  assert.equal(slow.requests.length, 0, "a run stopped before the call spends nothing");

  // A stop that arrives while the source is working is reported the same way.
  const late = new AbortController();
  const waiting = fakeSource((_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const midway = new ImageWorker({ source: waiting, jobsRoot: root, scope: "s", defaultQuality: "low", studioContentDirectories: async () => [] });
  const inFlight = midway.run(args, { signal: late.signal });
  while (waiting.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  late.abort();
  assert.equal((await inFlight).errorCode, "cancelled");

  const junk = fakeSource(async () => ({ images: [Buffer.from("not a png")], model: "m" }));
  const unreadable = new ImageWorker({ source: junk, jobsRoot: root, scope: "s", defaultQuality: "low", studioContentDirectories: async () => [] });
  const result = await unreadable.run(args, {});
  assert.equal(result.ok, true);
  assert.match(result.text, /could not be read as a PNG/);
  assert.equal(result.images, undefined);
}));

test("with preview_in_studio the pictures are staged into Studio's content folder and their addresses returned", async () => withRoot(async (root) => {
  const studio = join(root, "studio-content");
  const source = fakeSource(async () => ({ images: [glow], model: "m" }));
  const worker = new ImageWorker({ source, jobsRoot: join(root, "jobs"), scope: "s", defaultQuality: "low", studioContentDirectories: async () => [studio] });
  await rm(join(root, "jobs"), { recursive: true, force: true });
  const outcome = await worker.run({ ...args, preview_in_studio: true }, {});
  assert.equal(outcome.ok, true, outcome.text);
  const previews = (outcome.data as { studioPreviews: Array<{ name: string; uri: string }> }).studioPreviews;
  assert.equal(previews.length, 1);
  assert.match(previews[0].uri, /^rbxasset:\/\/textures\/roqer-preview\/[0-9a-f]{8}-glow\.png$/);
  const staged = await readdir(join(studio, "textures", "roqer-preview"));
  assert.equal(staged.length, 1);
  assert.match(outcome.text, /Previews in Studio, before any upload/);
}));
