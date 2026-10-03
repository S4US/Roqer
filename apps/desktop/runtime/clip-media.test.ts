import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clipMediaUrl } from "../shared/reference-clip";
import { parseByteRange, serveClipMedia, type ClipMedia } from "./clip-media";

test("byte ranges are read as a video's player asks for them", () => {
  assert.equal(parseByteRange(null, 100), undefined);
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), "invalid");
  assert.equal(parseByteRange("bytes=20-10", 100), "invalid");
  assert.equal(parseByteRange("bytes=-", 100), "invalid");
  // Several ranges, or another unit, are answered with the whole file.
  assert.equal(parseByteRange("bytes=0-1,5-6", 100), undefined);
  assert.equal(parseByteRange("items=0-1", 100), undefined);
});

test("only a clip the registry knows is served, whole or by range", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clip-media-"));
  try {
    const path = join(dir, "nova.mp4");
    await writeFile(path, Buffer.from("0123456789"));
    const media = new Map<string, ClipMedia>([
      ["video-1", { path, mediaType: "video/mp4" }],
      ["gif-1", { bytes: Buffer.from("GIF89a-bytes"), mediaType: "image/gif" }],
    ]);
    const lookup = (id: string) => media.get(id);
    const get = (url: string, headers: Record<string, string> = {}, method = "GET") => serveClipMedia(new Request(url, { method, headers }), lookup);

    const whole = await get("http://media/video-1".replace("http://", "roqer-clip://"));
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(await whole.text(), "0123456789");

    const part = await get(clipMediaUrl("video-1"), { range: "bytes=2-5" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(part.headers.get("content-length"), "4");
    assert.equal(await part.text(), "2345");

    const picture = await get(clipMediaUrl("gif-1"), { range: "bytes=0-2" });
    assert.equal(await picture.text(), "GIF");

    assert.equal((await get(clipMediaUrl("video-1"), { range: "bytes=50-" })).status, 416);
    assert.equal((await get(clipMediaUrl("unknown"))).status, 404);
    assert.equal((await get("roqer-clip://elsewhere/video-1")).status, 404);
    assert.equal((await get(clipMediaUrl("video-1"), {}, "POST")).status, 405);
    const head = await get(clipMediaUrl("video-1"), {}, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    // A file gone since it was attached is not there.
    await rm(path);
    assert.equal((await get(clipMediaUrl("video-1"))).status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
