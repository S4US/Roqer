import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DictationModelSpec, DictationModelState } from "../shared/dictation";
import { DictationModelStore } from "./dictation-model";

const MODEL = Buffer.from(Array.from({ length: 5_000 }, (_, index) => (index * 31) % 251));

function spec(overrides: Partial<DictationModelSpec> = {}): DictationModelSpec {
  return {
    name: "Test model", publisher: "Test", license: "Test", source: "example.test/model",
    file: "model.gguf", url: "https://example.test/model.gguf",
    bytes: MODEL.length, sha256: createHash("sha256").update(MODEL).digest("hex"),
    ...overrides,
  };
}

/** A server holding `body`, honouring Range, sending `chunk` bytes at a time; `stopAfter` cuts the answer short. */
function server(body: Buffer, options: { chunk?: number; stopAfter?: number; status?: number; ignoreRange?: boolean } = {}) {
  const requests: Array<{ range: string | null }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    requests.push({ range });
    if (options.status !== undefined) return new Response(null, { status: options.status });
    const from = range === null || options.ignoreRange === true ? 0 : Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const end = options.stopAfter === undefined ? body.length : Math.min(body.length, from + options.stopAfter);
    const chunk = options.chunk ?? 1_024;
    let at = from;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted) { controller.error(new DOMException("Aborted", "AbortError")); return; }
        if (at >= end) { controller.close(); return; }
        controller.enqueue(new Uint8Array(body.subarray(at, Math.min(end, at + chunk))));
        at = Math.min(end, at + chunk);
      },
    });
    return new Response(stream, { status: from > 0 ? 206 : 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function withStore(
  run: (make: (fetchImpl: typeof fetch, modelSpec?: DictationModelSpec) => { store: DictationModelStore; states: DictationModelState[] }, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-dictation-test-"));
  try {
    await run((fetchImpl, modelSpec = spec()) => {
      const states: DictationModelState[] = [];
      let clock = 0;
      const store = new DictationModelStore({
        directory: path.join(directory, "dictation"), spec: modelSpec, fetch: fetchImpl,
        onChange: (state) => states.push(state), now: () => (clock += 300),
      });
      return { store, states };
    }, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a model that was never downloaded is missing, and a download makes it ready", async () => {
  await withStore(async (make) => {
    const { fetchImpl, requests } = server(MODEL);
    const { store, states } = make(fetchImpl);
    assert.deepEqual(await store.state(), { kind: "missing" });

    assert.deepEqual(await store.download(), { kind: "ready" });
    assert.ok((await fs.readFile(store.modelPath)).equals(MODEL));
    await assert.rejects(fs.stat(`${store.modelPath}.part`), { code: "ENOENT" });
    assert.deepEqual(requests, [{ range: null }]);
    // Progress was reported on the way, ending on the model being ready.
    assert.deepEqual(states[0], { kind: "downloading", receivedBytes: 0, totalBytes: MODEL.length });
    assert.ok(states.some((state) => state.kind === "downloading" && state.receivedBytes > 0 && state.receivedBytes < MODEL.length));
    assert.deepEqual(states[states.length - 1], { kind: "ready" });

    // A model already there is not fetched again.
    assert.deepEqual(await store.download(), { kind: "ready" });
    assert.equal(requests.length, 1);
  });
});

test("a download that stops early keeps its part, and the next one carries on from it", async () => {
  await withStore(async (make) => {
    const cut = server(MODEL, { stopAfter: 2_048 });
    const first = make(cut.fetchImpl);
    const failed = await first.store.download();
    assert.equal(failed.kind, "failed");
    assert.match((failed as { message: string }).message, /ended early/);
    assert.equal((await fs.stat(`${first.store.modelPath}.part`)).size, 2_048);
    assert.deepEqual(await first.store.state(), failed, "the failure stays until the next attempt");

    const whole = server(MODEL);
    const second = make(whole.fetchImpl);
    assert.deepEqual(await second.store.download(), { kind: "ready" });
    assert.deepEqual(whole.requests, [{ range: "bytes=2048-" }]);
    assert.ok((await fs.readFile(second.store.modelPath)).equals(MODEL));
  });
});

test("a server that ignores the range is fetched from the start again", async () => {
  await withStore(async (make) => {
    await make(server(MODEL, { stopAfter: 1_024 }).fetchImpl).store.download();
    const whole = server(MODEL, { ignoreRange: true });
    const { store } = make(whole.fetchImpl);
    assert.deepEqual(await store.download(), { kind: "ready" });
    assert.deepEqual(whole.requests, [{ range: "bytes=1024-" }, { range: null }]);
    assert.ok((await fs.readFile(store.modelPath)).equals(MODEL));
  });
});

test("a file that is not the published model is discarded, never made ready", async () => {
  await withStore(async (make) => {
    const tampered = Buffer.from(MODEL);
    tampered[100] ^= 0xff;
    const { store } = make(server(tampered).fetchImpl);
    const state = await store.download();
    assert.equal(state.kind, "failed");
    assert.match((state as { message: string }).message, /not the published model/);
    await assert.rejects(fs.stat(store.modelPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(`${store.modelPath}.part`), { code: "ENOENT" });

    // More bytes than the published file holds is refused as well.
    const longer = make(server(Buffer.concat([MODEL, Buffer.alloc(10)])).fetchImpl);
    assert.match(((await longer.store.download()) as { message: string }).message, /more than the published file/);
    await assert.rejects(fs.stat(longer.store.modelPath), { code: "ENOENT" });
  });
});

test("a server error is reported, and the model stays missing", async () => {
  await withStore(async (make) => {
    const { store } = make(server(MODEL, { status: 503 }).fetchImpl);
    const state = await store.download();
    assert.deepEqual(state, { kind: "failed", message: "The speech model could not be downloaded: the server answered 503." });
  });
});

test("a cancelled download is not a failure, and removing the model clears everything", async () => {
  await withStore(async (make) => {
    // One byte at a time, so the cancel lands while it is still arriving.
    const { store } = make(server(MODEL, { chunk: 1 }).fetchImpl);
    const running = store.download();
    assert.equal((await store.state()).kind, "downloading");
    assert.equal(store.download(), running, "a second call joins the download in progress");
    assert.deepEqual(await store.cancel(), { kind: "missing" });
    assert.deepEqual(await running, { kind: "missing" });

    const whole = make(server(MODEL).fetchImpl);
    assert.deepEqual(await whole.store.download(), { kind: "ready" });
    assert.deepEqual(await whole.store.remove(), { kind: "missing" });
    await assert.rejects(fs.stat(whole.store.modelPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(`${whole.store.modelPath}.part`), { code: "ENOENT" });
  });
});
