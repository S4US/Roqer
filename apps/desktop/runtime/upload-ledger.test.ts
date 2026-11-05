import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LedgerAsset, LedgerCreator } from "../shared/asset-ledger";
import { AssetLedger, hashFile } from "./asset-ledger";
import type { StudioCaller } from "./local-operations";
import type { McpToolOutcome } from "./mcp-types";
import { alreadyUploadedOutcome, ledgerAwareUpload, listUploads, uploadReport } from "./upload-ledger";

const ok = (data: Record<string, unknown>): McpToolOutcome => ({ ok: true, data, text: JSON.stringify(data), httpStatus: 200, durationMs: 1 });

function fakeStudio(answers: McpToolOutcome[]) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const studio: StudioCaller = async (tool, args) => {
    calls.push({ tool, args });
    return answers.shift() ?? ok({});
  };
  return { studio, calls };
}

async function withFiles(run: (root: string, ledger: AssetLedger) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "roqer-upload-ledger-"));
  try {
    await writeFile(join(root, "ring.png"), Buffer.from("ring bytes"));
    await writeFile(join(root, "ring-copy.png"), Buffer.from("ring bytes"));
    await writeFile(join(root, "puff.png"), Buffer.from("puff bytes"));
    await run(root, new AssetLedger({ file: join(root, "ledger.json") }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const creator: LedgerCreator = { kind: "user", id: "42" };
const context = { chatId: "chat-1", projectId: "project-1", runId: "run-1", creator: async () => creator, now: () => new Date("2026-11-05T12:00:00.000Z") };

test("an upload is recorded with its hash, and the same bytes are answered from the ledger without uploading again", async () => withFiles(async (root, ledger) => {
  const { studio, calls } = fakeStudio([ok({ asset_id: "500", status: "complete", operation_id: "op-500", response: { assetId: "500", moderationResult: { moderationState: "Approved" } }, imageId: "501" })]);
  const first = await ledgerAwareUpload({ action: "upload", filePath: join(root, "ring.png"), assetType: "Decal", displayName: "Ring" }, {}, studio, ledger, context);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);
  const rows = await ledger.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetId, "500");
  assert.equal(rows[0].imageId, "501");
  assert.equal(rows[0].moderationState, "Approved");
  assert.equal(rows[0].fileName, "ring.png");
  assert.equal(rows[0].bytes, 10);
  assert.deepEqual(rows[0].creator, creator);
  assert.equal(rows[0].chatId, "chat-1");
  assert.equal(rows[0].uploadedAt, "2026-11-05T12:00:00.000Z");

  const again = await ledgerAwareUpload({ action: "upload", filePath: join(root, "ring-copy.png"), assetType: "Decal", displayName: "Ring again" }, {}, studio, ledger, context);
  assert.equal(calls.length, 1, "the same bytes are not uploaded again");
  assert.equal(again.ok, true);
  assert.match(again.text, /Not uploaded again: these exact bytes went to Roblox on 2026-11-05 as Decal asset 500, imageId 501, moderation Approved/);
  assert.equal((again.data as Record<string, unknown>).status, "already_uploaded");
  assert.equal((again.data as Record<string, unknown>).asset_id, "500");

  const other = await ledgerAwareUpload({ action: "upload", filePath: join(root, "puff.png"), assetType: "Decal", displayName: "Puff" }, {}, studio, ledger, context);
  assert.equal(other.ok, true);
  assert.equal(calls.length, 2, "different bytes upload");
  const asModel = await ledgerAwareUpload({ action: "upload", filePath: join(root, "ring.png"), assetType: "Model", displayName: "Ring" }, {}, studio, ledger, context);
  assert.equal(asModel.ok, true);
  assert.equal(calls.length, 3, "the same bytes as another type upload");
}));

test("a rejected upload may be tried again, a failed upload is not recorded, and an unreadable file uploads as before", async () => withFiles(async (root, ledger) => {
  const sha = (await hashFile(join(root, "ring.png")))!.sha256;
  await ledger.record({ assetId: "9", assetType: "Decal", displayName: "Old", uploadedAt: "2026-01-01T00:00:00.000Z", sha256: sha, moderationState: "Rejected", creator });
  const { studio, calls } = fakeStudio([
    ok({ asset_id: "10", status: "complete", response: { assetId: "10" } }),
    { ok: false, data: { error: "upload refused" }, text: "", httpStatus: 200, durationMs: 1, message: "upload refused" },
    ok({ asset_id: "11", status: "complete" }),
  ]);
  const retried = await ledgerAwareUpload({ action: "upload", filePath: join(root, "ring.png"), assetType: "Decal", displayName: "Ring" }, {}, studio, ledger, context);
  assert.equal(retried.ok, true);
  assert.equal(calls.length, 1, "a rejected asset's bytes are uploaded again");
  const failed = await ledgerAwareUpload({ action: "upload", filePath: join(root, "puff.png"), assetType: "Decal", displayName: "Puff" }, {}, studio, ledger, context);
  assert.equal(failed.ok, false);
  assert.equal((await ledger.list()).some((row) => row.displayName === "Puff"), false);
  const unreadable = await ledgerAwareUpload({ action: "upload", filePath: join(root, "missing.png"), assetType: "Decal", displayName: "Missing" }, {}, studio, ledger, context);
  assert.equal(unreadable.ok, true);
  assert.equal(calls.length, 3);
  const row = (await ledger.list()).find((entry) => entry.assetId === "11");
  assert.equal(row?.sha256, undefined, "no hash for a file the host could not read");
  assert.equal(row?.fileName, "missing.png");
}));

test("a status check fills in what Roblox said about a pending upload", async () => withFiles(async (root, ledger) => {
  const { studio } = fakeStudio([
    ok({ status: "processing", operation_id: "op-7", done: false }),
    ok({ status: "complete", operation_id: "op-7", asset_id: "77", imageId: "78", response: { assetId: "77", moderationResult: { moderationState: "Approved" } } }),
  ]);
  await ledgerAwareUpload({ action: "upload", filePath: join(root, "ring.png"), assetType: "Decal", displayName: "Ring" }, {}, studio, ledger, context);
  assert.equal((await ledger.list()).length, 0, "an upload still processing has no asset id to record yet");
  const { studio: second } = fakeStudio([
    ok({ asset_id: "77", status: "processing", operation_id: "op-7", response: { assetId: "77" } }),
    ok({ status: "complete", operation_id: "op-7", asset_id: "77", imageId: "78", response: { assetId: "77", moderationResult: { moderationState: "Approved" } } }),
  ]);
  await ledgerAwareUpload({ action: "upload", filePath: join(root, "puff.png"), assetType: "Decal", displayName: "Puff" }, {}, second, ledger, context);
  assert.equal((await ledger.list())[0].moderationState, undefined);
  await ledgerAwareUpload({ action: "status", operationId: "op-7" }, {}, second, ledger, context);
  const row = (await ledger.list())[0];
  assert.equal(row.moderationState, "Approved");
  assert.equal(row.imageId, "78");
}));

test("list_uploads lists newest first, filters by query and type, bounds its limit, and refuses bad arguments", async () => withFiles(async (_root, ledger) => {
  const rows: LedgerAsset[] = [
    { assetId: "1", assetType: "Decal", displayName: "Rune ring", uploadedAt: "2026-11-01T00:00:00.000Z", imageId: "2", moderationState: "Approved", fileName: "rune_ring.png" },
    { assetId: "3", assetType: "Model", displayName: "Barrel", uploadedAt: "2026-11-02T00:00:00.000Z" },
    { assetId: "4", assetType: "Audio", displayName: "Whoosh", uploadedAt: "2026-11-03T00:00:00.000Z" },
  ];
  for (const row of rows) await ledger.record(row);
  const all = await listUploads({}, ledger);
  assert.equal(all.ok, true);
  assert.match(all.text, /^3 of 3 matching uploads, newest first/);
  assert.deepEqual((all.data as { uploads: Array<{ assetId: string }> }).uploads.map((entry) => entry.assetId), ["4", "3", "1"]);
  assert.match(all.text, /rbxassetid:\/\/1 · Decal · “Rune ring” · imageId 2 · moderation Approved · uploaded 2026-11-01 · from rune_ring.png/);
  const rings = await listUploads({ query: "ring" }, ledger);
  assert.deepEqual((rings.data as { uploads: Array<{ assetId: string }> }).uploads.map((entry) => entry.assetId), ["1"]);
  const models = await listUploads({ assetType: "model" }, ledger);
  assert.deepEqual((models.data as { uploads: Array<{ assetId: string }> }).uploads.map((entry) => entry.assetId), ["3"]);
  const one = await listUploads({ limit: 1 }, ledger);
  assert.match(one.text, /^1 of 3 matching uploads/);
  const none = await listUploads({ query: "sword" }, ledger);
  assert.match(none.text, /No upload matches “sword”; 3 recorded in all\./);
  assert.equal((await listUploads({ limit: 0 }, ledger)).ok, false);
  assert.equal((await listUploads({ query: "x".repeat(101) }, ledger)).ok, false);
  const empty = new AssetLedger({ file: join(await mkdtemp(join(tmpdir(), "roqer-empty-")), "l.json") });
  assert.match((await listUploads({}, empty)).text, /Nothing has been uploaded from this computer yet\./);
}));

test("an upload report reads the fields the result cards read, and the reused outcome records no new upload", () => {
  const report = uploadReport(ok({ asset_id: "5", status: "complete", operation_id: "op-5", imageId: "6", response: { moderationResult: { moderationState: "Reviewing" } } }));
  assert.deepEqual(report, { assetId: "5", imageId: "6", moderationState: "Reviewing", operationId: "op-5", complete: true, failed: false });
  assert.equal(uploadReport({ ok: false, data: { error: "no" }, text: "", httpStatus: 500, durationMs: 1 }).failed, true);
  const reused = alreadyUploadedOutcome({ assetId: "5", assetType: "Decal", displayName: "Ring", uploadedAt: "2026-11-05T00:00:00.000Z" });
  assert.equal((reused.data as Record<string, unknown>).status, "already_uploaded");
  assert.equal(uploadReport(reused).complete, false, "a reused asset is not a completed upload, so no change card is made");
});
