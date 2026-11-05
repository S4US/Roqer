import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_LEDGER_ASSETS, type LedgerAsset } from "../shared/asset-ledger";
import { AssetLedger, hashFile } from "./asset-ledger";

const asset = (assetId: string, extra: Partial<LedgerAsset> = {}): LedgerAsset => ({
  assetId, assetType: "Decal", displayName: `Asset ${assetId}`, uploadedAt: "2026-11-05T10:00:00.000Z", ...extra,
});

async function withLedger(run: (ledger: AssetLedger, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "roqer-ledger-"));
  try {
    await run(new AssetLedger({ file: join(root, "asset-ledger.json") }), join(root, "asset-ledger.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("uploads are recorded once per asset id, listed newest first, and read back from disk", async () => withLedger(async (ledger, file) => {
  await ledger.record(asset("1"));
  await ledger.record(asset("2", { sha256: "a".repeat(64), bytes: 12, creator: { kind: "user", id: "7" } }));
  await ledger.record(asset("1", { displayName: "Renamed" }));
  assert.deepEqual((await ledger.list()).map((entry) => [entry.assetId, entry.displayName]), [["1", "Renamed"], ["2", "Asset 2"]]);
  const again = new AssetLedger({ file });
  assert.equal((await again.list()).length, 2);
  const saved = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number; assets: unknown[] };
  assert.equal(saved.schemaVersion, 1);
}));

test("a later report fills in an upload by its operation, and the same bytes are found by hash, type and creator", async () => withLedger(async (ledger) => {
  const hash = "b".repeat(64);
  await ledger.record(asset("10", { sha256: hash, operationId: "op-10", creator: { kind: "user", id: "7" } }));
  assert.equal(await ledger.update({ operationId: "op-10" }, { moderationState: "Approved", imageId: "11" }), true);
  assert.equal(await ledger.update({ operationId: "nope" }, { moderationState: "Approved" }), false);
  const found = await ledger.findByHash(hash, "Decal", { kind: "user", id: "7" });
  assert.equal(found?.assetId, "10");
  assert.equal(found?.moderationState, "Approved");
  assert.equal(found?.imageId, "11");
  assert.equal(await ledger.findByHash(hash, "Model", { kind: "user", id: "7" }), undefined, "another type is another asset");
  assert.equal(await ledger.findByHash(hash, "Decal", { kind: "group", id: "7" }), undefined, "another creator is another owner");
  assert.equal(await ledger.findByHash(hash, "Decal", undefined), undefined, "an unknown creator does not match a known one");
  await ledger.record(asset("12", { sha256: hash }));
  assert.equal((await ledger.findByHash(hash, "Decal", undefined))?.assetId, "12", "two unknown creators match");
}));

test("a damaged ledger is set aside once and a newer one is read but never written", async () => withLedger(async (ledger, file) => {
  await writeFile(file, "{ not json");
  assert.deepEqual(await ledger.list(), []);
  const notice = ledger.takeNotice();
  assert.match(notice ?? "", /damaged and moved to/);
  assert.equal(ledger.takeNotice(), undefined);
  assert.ok((await readdir(join(file, ".."))).some((name) => name.startsWith("asset-ledger.json.damaged-")));

  await writeFile(file, JSON.stringify({ schemaVersion: 2, assets: [{ future: true }] }));
  const newer = new AssetLedger({ file });
  assert.deepEqual(await newer.list(), []);
  await newer.record(asset("1"));
  assert.match(newer.takeNotice() ?? "", /newer Roqer/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, 2, "the newer file is left alone");
}));

test("rows this build cannot read cost only themselves, and the ledger is bounded", async () => withLedger(async (ledger, file) => {
  await writeFile(file, JSON.stringify({ schemaVersion: 1, assets: [asset("1"), { assetId: "not digits" }, asset("2")] }));
  assert.deepEqual((await ledger.list()).map((entry) => entry.assetId), ["2", "1"]);
  for (let index = 0; index < 30; index += 1) await ledger.record(asset(String(100 + index)));
  const bounded = new AssetLedger({ file: file.replace("asset-ledger.json", "bounded.json") });
  await writeFile(file.replace("asset-ledger.json", "bounded.json"), JSON.stringify({
    schemaVersion: 1,
    assets: Array.from({ length: MAX_LEDGER_ASSETS + 5 }, (_, index) => asset(String(index + 1))),
  }));
  assert.equal((await bounded.list()).length, MAX_LEDGER_ASSETS);
  assert.equal((await bounded.list())[0].assetId, String(MAX_LEDGER_ASSETS + 5), "the newest are the ones kept");
}));

test("a file is hashed by its bytes; what is not a readable file hashes to nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "roqer-hash-"));
  try {
    await writeFile(join(root, "a.png"), Buffer.from("same bytes"));
    await writeFile(join(root, "b.png"), Buffer.from("same bytes"));
    await writeFile(join(root, "c.png"), Buffer.from("other bytes"));
    const a = await hashFile(join(root, "a.png"));
    assert.equal(a?.bytes, 10);
    assert.match(a?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal((await hashFile(join(root, "b.png")))?.sha256, a?.sha256);
    assert.notEqual((await hashFile(join(root, "c.png")))?.sha256, a?.sha256);
    assert.equal(await hashFile(root), undefined);
    assert.equal(await hashFile(join(root, "missing.png")), undefined);
    assert.equal(await hashFile("relative.png"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
