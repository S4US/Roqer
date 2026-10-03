import assert from "node:assert/strict";
import test from "node:test";

import { parseUploadAssets, uploadAssets } from "./upload-assets";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";

const ok = (data: unknown): McpToolOutcome => ({ ok: true, data, text: "", httpStatus: 200, durationMs: 1 });

/** What the server returns for a Decal Roblox finished, image id resolved. */
const decal = (assetId: string, imageId: string | null): McpToolOutcome => ok({
  path: `operations/op-${assetId}`, done: true, operation_id: `op-${assetId}`, status: "complete", asset_id: assetId,
  moderation_state: "Approved", response: { assetId, displayName: "x", assetType: "Decal" }, decalId: assetId, imageId,
});

function fakeStudio(outcomes: McpToolOutcome[]) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; options?: McpCallOptions }> = [];
  const studio: StudioCaller = async (tool, args, options) => {
    calls.push({ tool, args, options });
    return outcomes.shift() ?? ok({});
  };
  return { studio, calls };
}

const upload = (name: string, assetType = "Decal") => ({ filePath: `C:/jobs/${name}.png`, assetType, displayName: name });

test("the list is checked as a whole before anything is uploaded", () => {
  assert.match(String(parseUploadAssets({})), /uploads must list 1-16 files/);
  assert.match(String(parseUploadAssets({ uploads: [] })), /uploads must list 1-16 files/);
  assert.match(String(parseUploadAssets({ uploads: Array.from({ length: 17 }, (_, index) => upload(`t${index}`)) })), /1-16/);
  assert.match(String(parseUploadAssets({ uploads: ["C:/a.png"] })), /uploads\[0\] must be an object/);
  assert.match(String(parseUploadAssets({ uploads: [{ assetType: "Decal", displayName: "a" }] })), /uploads\[0\]\.filePath/);
  assert.match(String(parseUploadAssets({ uploads: [upload("a", "Image")] })), /uploads\[0\]\.assetType must be one of Audio, Decal, Model, Animation, Video/);
  assert.match(String(parseUploadAssets({ uploads: [upload("a"), upload("a")] })), /uploads\[1\] uploads C:\/jobs\/a\.png a second time/);
  assert.match(String(parseUploadAssets({ uploads: [{ ...upload("a"), displayName: "x".repeat(51) }] })), /displayName must be 1-50 characters/);
  assert.deepEqual(parseUploadAssets({ uploads: [{ ...upload("a"), description: "fire", extra: true }] }), [
    { filePath: "C:/jobs/a.png", assetType: "Decal", displayName: "a", description: "fire" },
  ]);
});

test("every file is sent as its own upload_asset call, in order, and listed with the ids the model needs", async () => {
  const { studio, calls } = fakeStudio([decal("101", "201"), decal("102", "202")]);

  const outcome = await uploadAssets({ uploads: [upload("Flash"), upload("Smoke")] }, {}, studio);

  assert.equal(outcome.ok, true, outcome.text);
  assert.deepEqual(calls.map((call) => call.args), [
    { action: "upload", filePath: "C:/jobs/Flash.png", assetType: "Decal", displayName: "Flash" },
    { action: "upload", filePath: "C:/jobs/Smoke.png", assetType: "Decal", displayName: "Smoke" },
  ]);
  assert.ok(calls.every((call) => call.tool === "upload_asset" && call.options?.timeoutMs === 75_000));
  assert.match(outcome.text, /^Uploaded 2 of 2 files\./);
  assert.match(outcome.text, /- Flash \(C:\/jobs\/Flash\.png\): complete, asset 101, imageId 201, moderation Approved/);
  assert.match(outcome.text, /never its decalId/);
  assert.deepEqual((outcome.data as { uploads: unknown[] }).uploads[0], {
    filePath: "C:/jobs/Flash.png", displayName: "Flash", assetType: "Decal", status: "complete",
    assetId: "101", imageId: "201", decalId: "101", moderationState: "Approved", operationId: "op-101",
  });
});

test("a failed file does not hide the ones already on Roblox, and an unresolved image says how to check it", async () => {
  const failed: McpToolOutcome = { ok: false, data: undefined, text: "", message: "File not found: C:/jobs/Ring.png", httpStatus: 200, durationMs: 1 };
  const { studio } = fakeStudio([decal("101", null), failed, decal("103", "203")]);

  const outcome = await uploadAssets({ uploads: [upload("Flash"), upload("Ring"), upload("Spark")] }, {}, studio);

  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /^Uploaded 2 of 3 files\. The uploaded ones are on Roblox already: retry only the others\./);
  assert.match(outcome.text, /- Flash \(C:\/jobs\/Flash\.png\): complete, asset 101, moderation Approved; still processing: check it with upload_asset \{action: 'status', operationId: 'op-101'\}/);
  assert.match(outcome.text, /- Ring \(C:\/jobs\/Ring\.png\): failed: File not found: C:\/jobs\/Ring\.png/);
  assert.match(outcome.text, /- Spark .*imageId 203/);
});

test("no upload is started that would not finish within the call's budget", async () => {
  const { studio, calls } = fakeStudio([]);

  const outcome = await uploadAssets({ uploads: [upload("Flash"), upload("Smoke")] }, { timeoutMs: 30_000 }, studio);

  assert.equal(calls.length, 0);
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /^Uploaded 0 of 2 files\./);
  assert.match(outcome.text, /- Smoke \(C:\/jobs\/Smoke\.png\): not uploaded, because this call's time ran out first/);
});

test("a bad list uploads nothing, and a cancelled run uploads nothing further", async () => {
  const { studio, calls } = fakeStudio([]);
  const refused = await uploadAssets({ uploads: [upload("a", "Png")] }, {}, studio);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /^upload_assets was not run: uploads\[0\]\.assetType/);

  const controller = new AbortController();
  const cancelling: StudioCaller = async (tool, args, options) => {
    controller.abort();
    return studio(tool, args, options);
  };
  await assert.rejects(uploadAssets({ uploads: [upload("a"), upload("b")] }, { signal: controller.signal }, cancelling), /cancelled/);
  assert.equal(calls.length, 1, "the second file was never sent");
});
