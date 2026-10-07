import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { McpToolOutcome } from "./mcp-types";
import {
  isKnownInstance, isRojoProjectFile, resolvePickedProject,
  rojoForget, rojoGet, rojoLinkRecent, rojoOpenFolder, rojoRetry, rojoUnlink,
} from "./rojo-ipc";
import { RojoConnection } from "./rojo-connection";
import { RojoLinksStore } from "./rojo-links";

function outcome(partial: Partial<McpToolOutcome> & { ok: boolean }): McpToolOutcome {
  return { data: undefined, text: "", httpStatus: partial.ok ? 200 : 500, durationMs: 0, ...partial };
}

function linkSuccess(instanceId: string): McpToolOutcome {
  return outcome({
    ok: true,
    data: {
      linked: true, instance_id: instanceId, project: "default.project.json", root: "/projects/one",
      rojoVersion: "7.6.1", scripts: { file: 1, generated: 0, unsupported: 0 }, problems: [],
      rojoServer: { port: 34872 },
    },
  });
}

/** A real `RojoConnection` over a throwaway temp-dir store, matching `rojo-connection.test.ts`'s own fakes. */
async function withConnection(
  run: (connection: RojoConnection, store: RojoLinksStore, calls: { tool: string; args: Record<string, unknown> }[]) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-rojo-ipc-"));
  try {
    const store = new RojoLinksStore({ file: path.join(directory, "rojo-links.json") });
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => { calls.push({ tool, args }); return linkSuccess(String(args.instance_id)); },
      probe: async () => ({ answering: true }),
      readServePort: async () => undefined,
    });
    await run(connection, store, calls);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("isKnownInstance only accepts an id the connected list actually has", () => {
  assert.equal(isKnownInstance("place:1", ["place:1", "place:2"]), true);
  assert.equal(isKnownInstance("place:3", ["place:1", "place:2"]), false);
  assert.equal(isKnownInstance("place:1", []), false);
});

test("rojoGet refuses an untrusted sender", async () => {
  await withConnection(async (connection) => {
    const result = await rojoGet(false, "place:1", ["place:1"], connection);
    assert.deepEqual(result, { ok: false, message: "This window may not read the Rojo link." });
  });
});

test("rojoGet refuses an instance the latest Studio status does not list", async () => {
  await withConnection(async (connection) => {
    const result = await rojoGet(true, "place:9", ["place:1"], connection);
    assert.deepEqual(result, { ok: false, message: "That place is not connected." });
  });
});

test("rojoGet allows a null instanceId -- it means no place", async () => {
  await withConnection(async (connection) => {
    const result = await rojoGet(true, null, [], connection);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.view.state, "no-place");
  });
});

test("rojoUnlink, rojoForget and rojoRetry each refuse an untrusted sender and an unknown instance", async () => {
  await withConnection(async (connection) => {
    for (const handler of [rojoUnlink, rojoForget, rojoRetry]) {
      const untrusted = await handler(false, "place:1", ["place:1"], connection);
      assert.equal(untrusted.ok, false, "an untrusted sender is always refused");

      const unknown = await handler(true, "place:9", ["place:1"], connection);
      assert.deepEqual(unknown, { ok: false, message: "That place is not connected." });
    }
  });
});

test("rojoUnlink calls through to the connection once trust and the instance both check out", async () => {
  await withConnection(async (connection, store, calls) => {
    await connection.link("place:1", "/projects/one/default.project.json");
    const result = await rojoUnlink(true, "place:1", ["place:1"], connection);
    assert.equal(result.ok, true);
    assert.deepEqual(calls[1], { tool: "manage_instance", args: { action: "unlink_project", instance_id: "place:1" } });
  });
});

test("rojoForget never touches the bridge and refuses when untrusted", async () => {
  await withConnection(async (connection, store, calls) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    assert.deepEqual(await rojoForget(false, "place:1", ["place:1"], connection), { ok: false, message: "This window may not forget a Rojo link." });
    const result = await rojoForget(true, "place:1", ["place:1"], connection);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, "forget is store-only");
  });
});

test("rojoRetry refuses when untrusted, then retries the remembered link", async () => {
  await withConnection(async (connection, store, calls) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    assert.deepEqual(await rojoRetry(false, "place:1", ["place:1"], connection), { ok: false, message: "This window may not retry a Rojo link." });
    const result = await rojoRetry(true, "place:1", ["place:1"], connection);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
  });
});

test("rojoLinkRecent refuses an untrusted sender, an unknown instance, and a malformed payload", async () => {
  await withConnection(async (connection, store, calls) => {
    await store.touchRecent("/projects/one/default.project.json");
    assert.deepEqual(
      await rojoLinkRecent(false, { instanceId: "place:1", index: 0 }, ["place:1"], connection),
      { ok: false, message: "This window may not link a Rojo project." },
    );
    assert.deepEqual(
      await rojoLinkRecent(true, { instanceId: "place:9", index: 0 }, ["place:1"], connection),
      { ok: false, message: "That place is not connected." },
    );
    assert.deepEqual(await rojoLinkRecent(true, "not an object", ["place:1"], connection), { ok: false, message: "The request was not valid." });
    assert.equal(calls.length, 0, "nothing refused ever reaches the bridge");
  });
});

test("rojoLinkRecent refuses a negative or non-integer index before ever asking the connection", async () => {
  await withConnection(async (connection, store, calls) => {
    await store.touchRecent("/projects/one/default.project.json");
    const negative = await rojoLinkRecent(true, { instanceId: "place:1", index: -1 }, ["place:1"], connection);
    assert.deepEqual(negative, { ok: false, message: "That recent project is no longer available." });
    const fractional = await rojoLinkRecent(true, { instanceId: "place:1", index: 0.5 }, ["place:1"], connection);
    assert.deepEqual(fractional, { ok: false, message: "That recent project is no longer available." });
    assert.equal(calls.length, 0);
  });
});

test("rojoLinkRecent refuses an index with nothing behind it in the recent list (out of range)", async () => {
  await withConnection(async (connection, store, calls) => {
    await store.touchRecent("/projects/one/default.project.json");
    const outOfRange = await rojoLinkRecent(true, { instanceId: "place:1", index: 7 }, ["place:1"], connection);
    assert.equal(outOfRange.ok, false);
    assert.equal(calls.length, 0, "an out-of-range index never reaches the bridge");

    const inRange = await rojoLinkRecent(true, { instanceId: "place:1", index: 0 }, ["place:1"], connection);
    assert.equal(inRange.ok, true);
    assert.equal(calls.length, 1);
  });
});

test("rojoOpenFolder refuses when untrusted or unknown, reports no folder when nothing is linked, and surfaces an openPath error", async () => {
  await withConnection(async (connection) => {
    assert.deepEqual(await rojoOpenFolder(false, "place:1", ["place:1"], connection, async () => ""), {
      ok: false, message: "This window may not open that folder.",
    });
    assert.deepEqual(await rojoOpenFolder(true, "place:9", ["place:1"], connection, async () => ""), {
      ok: false, message: "That place is not connected.",
    });

    const noFolder = await rojoOpenFolder(true, "place:1", ["place:1"], connection, async () => "");
    assert.equal(noFolder.ok, false);
    if (!noFolder.ok) assert.equal(noFolder.message, "There is no linked project folder to open.");

    await connection.link("place:1", "/projects/one/default.project.json");
    const failedOpen = await rojoOpenFolder(true, "place:1", ["place:1"], connection, async () => "no handler for that path");
    assert.deepEqual(failedOpen.ok, false);
    if (!failedOpen.ok) assert.equal(failedOpen.message, "no handler for that path");

    const opened = await rojoOpenFolder(true, "place:1", ["place:1"], connection, async () => "");
    assert.equal(opened.ok, true);
  });
});

test("isRojoProjectFile accepts only a *.project.json path", () => {
  assert.equal(isRojoProjectFile("/projects/one/default.project.json"), true);
  assert.equal(isRojoProjectFile("/projects/one/default.json"), false);
  assert.equal(isRojoProjectFile("/projects/one/project.json.bak"), false);
  assert.equal(isRojoProjectFile(""), false);
});

test("resolvePickedProject reports a plain cancellation when the dialog was dismissed", async () => {
  await withConnection(async (connection, _store, calls) => {
    const outcomeValue = await resolvePickedProject({ canceled: true, filePaths: [] }, "place:1", connection);
    assert.deepEqual(outcomeValue, { cancelled: true });
    assert.equal(calls.length, 0);
  });
});

test("resolvePickedProject refuses a pick that does not end in .project.json, without ever linking", async () => {
  await withConnection(async (connection, _store, calls) => {
    const outcomeValue = await resolvePickedProject({ canceled: false, filePaths: ["/projects/one/default.json"] }, "place:1", connection);
    assert.deepEqual(outcomeValue, { ok: false, message: "Choose a *.project.json file." });
    assert.equal(calls.length, 0, "a bad extension never reaches manage_instance");
  });
});

test("resolvePickedProject links a valid pick through the connection", async () => {
  await withConnection(async (connection, _store, calls) => {
    const outcomeValue = await resolvePickedProject({ canceled: false, filePaths: ["/projects/one/default.project.json"] }, "place:1", connection);
    if ("cancelled" in outcomeValue) throw new Error("unreachable");
    assert.equal(outcomeValue.ok, true);
    assert.deepEqual(calls[0], {
      tool: "manage_instance",
      args: { action: "link_project", project: "/projects/one/default.project.json", instance_id: "place:1" },
    });
  });
});
