import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { displayNameFor, SendLedger, sendModelToStudio } from "./send-to-studio";
import { chooseSendPlace } from "../shared/project-files";
import type { McpToolOutcome } from "./mcp-types";

const outcome = (data: unknown, ok = true): McpToolOutcome => ({ ok, data, text: "", httpStatus: 200, durationMs: 1 });
const noWait = async () => undefined;

/** A model file, a ledger beside it, and a fake bridge that records each call. */
async function fixture(content = "glTF model bytes") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-send-"));
  const model = path.join(directory, "tree.glb");
  await fs.writeFile(model, content);
  const ledgerFile = path.join(directory, "studio-sends.json");
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    directory,
    model,
    ledgerFile,
    ledger: new SendLedger(ledgerFile),
    calls,
    tools: () => calls.map(([tool, args]) => `${tool}${typeof args.action === "string" ? ` ${args.action}` : ""}`),
    request: { filePath: model, displayName: "tree", instanceId: "place:1" },
    dispose: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("a send uploads, waits for Roblox, inserts, and records the upload", async () => {
  const f = await fixture();
  try {
    let polls = 0;
    const result = await sendModelToStudio(async (tool, args) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset" && args.action === "upload") return outcome({ status: "processing", operation_id: "op-1" });
      if (tool === "upload_asset") return outcome(++polls < 2 ? { status: "processing", operation_id: "op-1" } : { status: "complete", asset_id: "123" });
      return outcome({ success: true });
    }, f.request, f.ledger, { wait: noWait });
    assert.equal(result.ok, true);
    assert.equal(result.assetId, "123");
    assert.deepEqual(f.calls.at(-1), ["insert_asset", { assetId: 123, instance_id: "place:1" }]);
    const saved = JSON.parse(await fs.readFile(f.ledgerFile, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.sends.length, 1);
    assert.equal(saved.sends[0].operationId, "op-1");
    assert.equal(saved.sends[0].assetId, "123");
    assert.equal(displayNameFor("scrap_metal-glow.fbx"), "scrap metal glow");
  } finally {
    await f.dispose();
  }
});

test("a send says why Roblox refused the upload, records nothing, and inserts nothing", async () => {
  const f = await fixture();
  try {
    const result = await sendModelToStudio(async (tool, args) => {
      f.calls.push([tool, args]);
      return { ...outcome(undefined, false), message: "401 Unauthorized: invalid API key" };
    }, f.request, f.ledger, { wait: noWait });
    assert.equal(result.ok, false);
    assert.match(result.message, /Open Cloud key/);
    assert.deepEqual(f.tools(), ["upload_asset upload"]);
    await assert.rejects(fs.stat(f.ledgerFile), "nothing was taken, so nothing is recorded");
  } finally {
    await f.dispose();
  }
});

test("a send that stopped waiting for processing picks the same upload up again, never a second copy", async () => {
  const f = await fixture();
  try {
    let processed = false;
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset" && args.action === "upload") return outcome({ status: "processing", operation_id: "op-7" });
      if (tool === "upload_asset") return outcome(processed ? { status: "complete", asset_id: "77" } : { status: "processing", operation_id: "op-7" });
      return outcome({ success: true });
    };
    const first = await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait, processingWaitMs: 0 });
    assert.equal(first.ok, false);
    assert.match(first.message, /still processing.*instead of uploading another/);

    processed = true;
    f.calls.length = 0;
    // A new ledger reads what the first wrote, as after a restart.
    const second = await sendModelToStudio(bridge, f.request, new SendLedger(f.ledgerFile), { wait: noWait });
    assert.equal(second.ok, true);
    assert.deepEqual(f.tools(), ["upload_asset status", "insert_asset"]);
    assert.equal(f.calls[0][1].operationId, "op-7");
  } finally {
    await f.dispose();
  }
});

test("after a failed insert, sending again inserts the same asset without uploading", async () => {
  const f = await fixture();
  try {
    let studioOpen = false;
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset") return outcome({ status: "complete", asset_id: "555", moderation_state: "Approved" });
      return studioOpen ? outcome({ success: true }) : { ...outcome(undefined, false), message: "Studio is not connected" };
    };
    const first = await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    assert.equal(first.ok, false);
    assert.equal(first.assetId, "555");
    assert.match(first.message, /inserts the same asset without uploading again/);

    studioOpen = true;
    f.calls.length = 0;
    const second = await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    assert.equal(second.ok, true);
    assert.deepEqual(f.tools(), ["insert_asset"]);
    assert.match(second.message, /was not uploaded again/);
  } finally {
    await f.dispose();
  }
});

test("a changed file uploads again; the same file sent twice does not", async () => {
  const f = await fixture();
  try {
    let uploads = 0;
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset") return outcome({ status: "complete", asset_id: String(100 + ++uploads) });
      return outcome({ success: true });
    };
    await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    assert.equal(uploads, 1, "the same contents are the same asset");
    await fs.writeFile(f.model, "a re-exported model");
    const changed = await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    assert.equal(uploads, 2);
    assert.equal(changed.assetId, "102");
  } finally {
    await f.dispose();
  }
});

test("a model Roblox refuses while processing is forgotten, so the next send uploads it afresh", async () => {
  const f = await fixture();
  try {
    let refuse = true;
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset" && args.action === "upload") return outcome({ status: "processing", operation_id: refuse ? "op-bad" : "op-good" });
      if (tool === "upload_asset") return refuse ? outcome({ error: { message: "moderated" } }) : outcome({ status: "complete", asset_id: "9" });
      return outcome({ success: true });
    };
    const first = await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    assert.match(first.message, /could not process the model: moderated\. Sending again uploads it again/);
    refuse = false;
    f.calls.length = 0;
    assert.equal((await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait })).ok, true);
    assert.deepEqual(f.tools(), ["upload_asset upload", "upload_asset status", "insert_asset"]);
  } finally {
    await f.dispose();
  }
});

test("no answer from Roblox is not a refusal: the upload is kept, and an unanswered upload is reported as maybe sent", async () => {
  const f = await fixture();
  try {
    let bridgeUp = false;
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset" && args.action === "upload") return outcome({ status: "processing", operation_id: "op-5" });
      if (tool === "upload_asset") return bridgeUp ? outcome({ status: "complete", asset_id: "5" }) : { ...outcome(undefined, false), errorCode: "request_failed", message: "nothing is listening" };
      return outcome({ success: true });
    };
    const first = await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait });
    assert.match(first.message, /could not check the upload with Roblox: nothing is listening.*will not upload another/);
    bridgeUp = true;
    f.calls.length = 0;
    assert.equal((await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait })).ok, true);
    assert.deepEqual(f.tools(), ["upload_asset status", "insert_asset"]);

    // An upload that got no answer at all may have gone through; nothing is guessed.
    await fs.writeFile(f.model, "another model");
    const timedOut = await sendModelToStudio(async () => ({ ...outcome(undefined, false), errorCode: "timeout", message: "upload_asset did not answer" }), f.request, f.ledger, { wait: noWait });
    assert.match(timedOut.message, /may or may not have gone through/);
  } finally {
    await f.dispose();
  }
});

test("a send can be stopped: before the upload nothing goes, and after it the upload is kept for next time", async () => {
  const f = await fixture();
  try {
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      if (tool === "upload_asset" && args.action === "upload") return outcome({ status: "processing", operation_id: "op-3" });
      if (tool === "upload_asset") return outcome({ status: "complete", asset_id: "33" });
      return outcome({ success: true });
    };
    const before = new AbortController();
    before.abort();
    const notStarted = await sendModelToStudio(bridge, f.request, f.ledger, { signal: before.signal, wait: noWait });
    assert.equal(notStarted.cancelled, true);
    assert.match(notStarted.message, /Nothing was uploaded/);
    assert.deepEqual(f.calls, []);

    // Stopped while Roblox processes: the upload already made is recorded.
    const during = new AbortController();
    const stopped = await sendModelToStudio(bridge, f.request, f.ledger, {
      signal: during.signal,
      wait: async () => { during.abort(); },
    });
    assert.equal(stopped.cancelled, true);
    assert.match(stopped.message, /picks it up without uploading again/);
    assert.deepEqual(f.tools(), ["upload_asset upload"], "no insert after a stop");

    f.calls.length = 0;
    assert.equal((await sendModelToStudio(bridge, f.request, f.ledger, { wait: noWait })).ok, true);
    assert.deepEqual(f.tools(), ["upload_asset status", "insert_asset"]);
  } finally {
    await f.dispose();
  }
});

test("a ledger that cannot be trusted stops the send before anything is uploaded", async () => {
  const f = await fixture();
  try {
    const bridge = async (tool: string, args: Record<string, unknown>) => {
      f.calls.push([tool, args]);
      return outcome({ status: "complete", asset_id: "1" });
    };
    // Written by a newer Roqer: not read as empty, and not written over.
    await fs.writeFile(f.ledgerFile, JSON.stringify({ version: 2, sends: [] }));
    await assert.rejects(sendModelToStudio(bridge, f.request, new SendLedger(f.ledgerFile), { wait: noWait }), /newer version of Roqer/);
    // Unreadable (here a folder in its place): refused rather than read as empty.
    await fs.rm(f.ledgerFile);
    await fs.mkdir(f.ledgerFile);
    await assert.rejects(sendModelToStudio(bridge, f.request, new SendLedger(f.ledgerFile), { wait: noWait }), /could not check which models it already sent/);
    assert.deepEqual(f.calls, []);
    // Damaged: set aside, and a new one started.
    await fs.rm(f.ledgerFile, { recursive: true });
    await fs.writeFile(f.ledgerFile, "{ not json");
    assert.equal((await sendModelToStudio(bridge, f.request, new SendLedger(f.ledgerFile), { wait: noWait })).ok, true);
    assert.ok((await fs.readdir(f.directory)).some((name) => name.startsWith("studio-sends.json.damaged-")));
  } finally {
    await f.dispose();
  }
});

test("the place is decided before anything is uploaded", () => {
  const one = [{ instanceId: "place:1" }, { instanceId: "place:1" }];
  const two = [{ instanceId: "place:1" }, { instanceId: "place:2" }];
  // A chosen place must be open.
  assert.deepEqual(chooseSendPlace(two, { instanceId: "place:2", chosen: true }), { ok: true, instanceId: "place:2" });
  assert.match(String((chooseSendPlace(one, { instanceId: "place:9", chosen: true }) as { message: string }).message), /chat's Studio place is not open.*Nothing was uploaded/);
  // Otherwise exactly one open place; a playtest's sessions are one place.
  assert.deepEqual(chooseSendPlace(one, { instanceId: null, chosen: false }), { ok: true, instanceId: "place:1" });
  assert.deepEqual(chooseSendPlace(one, { instanceId: "place:9", chosen: false }), { ok: true, instanceId: "place:1" });
  assert.match(String((chooseSendPlace(two, { instanceId: "place:1", chosen: false }) as { message: string }).message), /Several Studio places are open/);
  assert.match(String((chooseSendPlace([], { instanceId: null, chosen: false }) as { message: string }).message), /No Studio place is connected/);
});
