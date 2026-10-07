import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { McpToolOutcome } from "./mcp-types";
import { RojoConnection } from "./rojo-connection";
import { RojoLinksStore } from "./rojo-links";

type Call = { tool: string; args: Record<string, unknown> };

function outcome(partial: Partial<McpToolOutcome> & { ok: boolean }): McpToolOutcome {
  return { data: undefined, text: "", httpStatus: partial.ok ? 200 : 500, durationMs: 0, ...partial };
}

function linkSuccess(overrides: Partial<Record<string, unknown>> = {}): McpToolOutcome {
  return outcome({
    ok: true,
    data: {
      linked: true,
      instance_id: "place:1",
      project: "default.project.json",
      root: "/projects/one",
      rojoVersion: "7.6.1",
      scripts: { file: 2, studio_only: 1, generated: 0, unsupported: 0 },
      problems: [],
      rojoServer: { port: 34872, reachable: true },
      ...overrides,
    },
  });
}

function withStore(run: (store: RojoLinksStore, directory: string) => Promise<void>): Promise<void> {
  return (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-rojo-connection-"));
    try {
      await run(new RojoLinksStore({ file: path.join(directory, "rojo-links.json") }), directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  })();
}

function neverAnswers() {
  return async () => ({ answering: false });
}

function neverReadsPort() {
  return async () => undefined;
}

test("linking calls manage_instance link_project, remembers the link, and pushes the project to recent", async () => {
  await withStore(async (store) => {
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => { calls.push({ tool, args }); return linkSuccess(); },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    const result = await connection.link("place:1", "/projects/one/default.project.json");

    assert.deepEqual(calls, [{
      tool: "manage_instance",
      args: { action: "link_project", project: "/projects/one/default.project.json", instance_id: "place:1" },
    }]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.view.state, "linked-running");
    assert.equal(result.view.published, true);
    assert.deepEqual(result.view.project, {
      fileName: "default.project.json", folder: "/projects/one", rojoVersion: "7.6.1",
      scripts: { file: 2, generated: 0, unsupported: 0 }, problems: [],
    });
    assert.deepEqual(result.view.server, { port: 34872, answering: true, projectName: undefined });

    const saved = await store.get();
    assert.equal(saved.links.length, 1);
    assert.equal(saved.links[0].projectFile, "/projects/one/default.project.json");
    assert.deepEqual(saved.recent, ["/projects/one/default.project.json"]);
  });
});

test("an unpublished (anon) instance links for the session but is never remembered", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => linkSuccess({ instance_id: "anon:abc" }),
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    const result = await connection.link("anon:abc", "/projects/one/default.project.json");
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.view.published, false);
    assert.equal(result.view.state, "linked-running");

    assert.deepEqual((await store.get()).links, [], "an anon place's link is not persisted");
    assert.deepEqual((await store.get()).recent, ["/projects/one/default.project.json"], "the project file is still remembered as recent");
  });
});

test("a rojo_* failure surfaces its message and is remembered as this instance's error", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => outcome({
        ok: false,
        data: { error: "No project file at /projects/one/default.project.json", errorCode: "rojo_link_invalid" },
        message: "No project file at /projects/one/default.project.json",
      }),
      probe: async () => ({ answering: false }),
      readServePort: neverReadsPort(),
    });

    const result = await connection.link("place:1", "/projects/one/default.project.json");
    assert.equal(result.ok, false);
    assert.equal(result.message, "No project file at /projects/one/default.project.json");

    const view = await connection.view("place:1", ["place:1"]);
    assert.equal(view.state, "error");
    assert.equal(view.message, "No project file at /projects/one/default.project.json");
  });
});

test("an older bridge's unknown-action rejection is mapped to a clear message, not a generic one", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => outcome({
        ok: false,
        data: undefined,
        message: "manage_instance requires action=launch|authorize|complete|close|status|list_place_versions",
      }),
      probe: async () => ({ answering: false }),
      readServePort: neverReadsPort(),
    });

    const result = await connection.link("place:1", "/projects/one/default.project.json");
    assert.equal(result.ok, false);
    assert.equal(result.message, "This Roqer bridge is older than the app; quit other Roqer or Codex bridges and restart Roqer.");
  });
});

test("unlinking calls manage_instance unlink_project and forgets the stored link", async () => {
  await withStore(async (store) => {
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        if (args.action === "link_project") return linkSuccess();
        return outcome({ ok: true, data: { unlinked: true, instance_id: "place:1" } });
      },
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    await connection.link("place:1", "/projects/one/default.project.json");
    const result = await connection.unlink("place:1");

    assert.deepEqual(calls[1], { tool: "manage_instance", args: { action: "unlink_project", instance_id: "place:1" } });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.view.state, "not-linked");
    assert.deepEqual((await store.get()).links, []);
  });
});

test("forget removes a stored link without calling the bridge at all", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    let called = false;
    const connection = new RojoConnection({
      store,
      callTool: async () => { called = true; return linkSuccess(); },
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    const result = await connection.forget("place:1");
    assert.equal(called, false, "forget never calls the bridge");
    assert.equal(result.ok, true);
    assert.deepEqual((await store.get()).links, []);
  });
});

test("linkRecent links by index into the recent list and refuses an out-of-range index", async () => {
  await withStore(async (store) => {
    await store.touchRecent("/projects/one/default.project.json");
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => { calls.push({ tool, args }); return linkSuccess(); },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    const result = await connection.linkRecent("place:1", 0);
    assert.equal(result.ok, true);
    assert.equal(calls[0].args.project, "/projects/one/default.project.json");

    const outOfRange = await connection.linkRecent("place:1", 7);
    assert.equal(outOfRange.ok, false);
    assert.equal(calls.length, 1, "no bridge call for an index with nothing behind it");
  });
});

test("relinkConnected links every connected place with a remembered link, once per bridge", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    await store.remember("place:2", "/projects/two/default.project.json");
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => { calls.push({ tool, args }); return linkSuccess({ instance_id: args.instance_id }); },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1", "place:2", "place:999"]);
    assert.equal(calls.length, 2, "only the two remembered, connected places are relinked");

    await connection.relinkConnected(["place:1", "place:2"]);
    assert.equal(calls.length, 2, "already relinked this bridge, so no repeat calls");

    connection.bridgeRestarted();
    await connection.relinkConnected(["place:1", "place:2"]);
    assert.equal(calls.length, 4, "a bridge restart means relinking is attempted again");
  });
});

test("relinkConnected remembers a failure per instance without throwing", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/missing/default.project.json");
    const connection = new RojoConnection({
      store,
      callTool: async () => outcome({
        ok: false,
        data: { error: "No project file at /projects/missing/default.project.json", errorCode: "rojo_link_invalid" },
        message: "No project file at /projects/missing/default.project.json",
      }),
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1"]);
    const view = await connection.view("place:1", ["place:1"]);
    assert.equal(view.state, "error");
    assert.equal(view.message, "No project file at /projects/missing/default.project.json");
  });
});

test("view reports no-place when the instance is not in the connected list, and detected when a server answers but nothing is linked", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => linkSuccess(),
      probe: async (port) => ({ answering: port === 34872, projectName: port === 34872 ? "Project" : undefined }),
      readServePort: neverReadsPort(),
    });

    assert.equal((await connection.view(null, [])).state, "no-place");
    assert.equal((await connection.view("place:1", [])).state, "no-place", "known id, but not in the connected list");

    const detected = await connection.view("place:1", ["place:1"]);
    assert.equal(detected.state, "detected");
    assert.deepEqual(detected.server, { port: 34872, answering: true, projectName: "Project" });
  });
});

test("view falls back to each recent project's own serve port when the default port answers nothing", async () => {
  await withStore(async (store) => {
    await store.touchRecent("/projects/one/default.project.json");
    const connection = new RojoConnection({
      store,
      callTool: async () => linkSuccess(),
      probe: async (port) => ({ answering: port === 40000 }),
      readServePort: async (projectFile) => (projectFile === "/projects/one/default.project.json" ? 40000 : undefined),
    });

    const view = await connection.view("place:1", ["place:1"]);
    assert.equal(view.state, "detected");
    assert.equal(view.server?.port, 40000);
  });
});

test("projectFolderFor returns the linked project's folder only while linked", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => linkSuccess(),
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });
    assert.equal(connection.projectFolderFor("place:1"), undefined);
    await connection.link("place:1", "/projects/one/default.project.json");
    assert.equal(connection.projectFolderFor("place:1"), "/projects/one");
  });
});

test("a success payload Rojo did not actually send is refused rather than fabricated", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => outcome({ ok: true, data: { linked: true } }),
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    const result = await connection.link("place:1", "/projects/one/default.project.json");
    assert.equal(result.ok, false);
    assert.equal((await store.get()).links.length, 0);
  });
});
