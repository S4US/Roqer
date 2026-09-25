import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { adoptPreviousUserData } from "./user-data-location";

function scratch(): { root: string; current: string; previous: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roqer-user-data-"));
  return { root, current: path.join(root, "Roqer"), previous: path.join(root, "@chrrxs", "studio-workbench") };
}

test("the previous data folder is moved into place once, with everything in it", () => {
  const { root, current, previous } = scratch();
  try {
    fs.mkdirSync(path.join(previous, "run-journal"), { recursive: true });
    fs.writeFileSync(path.join(previous, "workspace.json"), "{\"chats\":1}");
    assert.equal(adoptPreviousUserData(current, previous), current);
    assert.equal(fs.readFileSync(path.join(current, "workspace.json"), "utf8"), "{\"chats\":1}");
    assert.ok(fs.existsSync(path.join(current, "run-journal")));
    assert.equal(fs.existsSync(previous), false);
    // Later launches find the data where it now is and leave it alone.
    assert.equal(adoptPreviousUserData(current, previous), current);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty new folder, as Electron may create, does not block the move", () => {
  const { root, current, previous } = scratch();
  try {
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "workspace.json"), "{}");
    assert.equal(adoptPreviousUserData(current, previous), current);
    assert.ok(fs.existsSync(path.join(current, "workspace.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("data already in the new folder is never overwritten, and a fresh install starts empty", () => {
  const { root, current, previous } = scratch();
  try {
    assert.equal(adoptPreviousUserData(current, previous), current, "nothing anywhere: the new folder");
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, "workspace.json"), "new");
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "workspace.json"), "old");
    assert.equal(adoptPreviousUserData(current, previous), current);
    assert.equal(fs.readFileSync(path.join(current, "workspace.json"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(previous, "workspace.json"), "utf8"), "old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a move that fails keeps using the previous folder rather than starting empty", () => {
  const { root, current, previous } = scratch();
  try {
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "workspace.json"), "{}");
    const locked = { ...fs, renameSync: () => { throw new Error("EBUSY"); } } as unknown as typeof fs;
    assert.equal(adoptPreviousUserData(current, previous, locked), previous);
    assert.ok(fs.existsSync(path.join(previous, "workspace.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
