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

test("a failed relink is not retried on later relinkConnected calls", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/missing/default.project.json");
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return outcome({ ok: false, data: { error: "No project file", errorCode: "rojo_link_invalid" }, message: "No project file" });
      },
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1"]);
    assert.equal(calls.length, 1);
    await connection.relinkConnected(["place:1"]);
    await connection.relinkConnected(["place:1"]);
    assert.equal(calls.length, 1, "still connected and still failed, so no repeat relink attempts");
  });
});

test("a failed relink is retried after bridgeRestarted()", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/missing/default.project.json");
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return outcome({ ok: false, data: { error: "No project file", errorCode: "rojo_link_invalid" }, message: "No project file" });
      },
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1"]);
    await connection.relinkConnected(["place:1"]);
    assert.equal(calls.length, 1);

    connection.bridgeRestarted();
    await connection.relinkConnected(["place:1"]);
    assert.equal(calls.length, 2, "bridgeRestarted() clears the remembered failure");
  });
});

test("a failed relink is retried once the instance drops out of and back into the connected list", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/missing/default.project.json");
    const calls: Call[] = [];
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return outcome({ ok: false, data: { error: "No project file", errorCode: "rojo_link_invalid" }, message: "No project file" });
      },
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1"]);
    await connection.relinkConnected(["place:1"]);
    assert.equal(calls.length, 1, "still present, so no repeat attempt yet");

    await connection.relinkConnected([]); // place:1 drops out of the connected list
    await connection.relinkConnected(["place:1"]); // and reappears
    assert.equal(calls.length, 2, "reappearing after dropping out retries the failed relink");

    await connection.relinkConnected(["place:1"]);
    assert.equal(calls.length, 2, "but settles again once re-attempted, without a further drop/reappear");
  });
});

test("retry() re-attempts a remembered link regardless of a settled failure, and returns the new view", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    let attempts = 0;
    const connection = new RojoConnection({
      store,
      callTool: async () => {
        attempts += 1;
        return attempts === 1
          ? outcome({ ok: false, data: { error: "Rojo was not found on PATH", errorCode: "rojo_not_found" }, message: "Rojo was not found on PATH" })
          : linkSuccess();
      },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1"]);
    assert.equal(attempts, 1);
    await connection.relinkConnected(["place:1"]);
    assert.equal(attempts, 1, "settled after the first failure");

    const retried = await connection.retry("place:1");
    assert.equal(attempts, 2, "retry() bypasses the settled-failure gate");
    assert.equal(retried.ok, true);
    if (!retried.ok) throw new Error("unreachable");
    assert.equal(retried.view.state, "linked-running", "a success clears the failure and reports the new view");

    await connection.relinkConnected(["place:1"]);
    assert.equal(attempts, 2, "now linked, so relinkConnected leaves it alone again");
  });
});

test("retry() reports plainly when there is nothing remembered to retry", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => linkSuccess(),
      probe: neverAnswers(),
      readServePort: neverReadsPort(),
    });
    const result = await connection.retry("place:1");
    assert.equal(result.ok, false);
    assert.equal(result.message, "There is no remembered project to retry.");
  });
});

test("a success through link() clears a previously settled failure for the same instance", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    let attempts = 0;
    const connection = new RojoConnection({
      store,
      callTool: async () => {
        attempts += 1;
        return attempts === 1
          ? outcome({ ok: false, data: { error: "Rojo was not found on PATH", errorCode: "rojo_not_found" }, message: "Rojo was not found on PATH" })
          : linkSuccess();
      },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    await connection.relinkConnected(["place:1"]);
    assert.equal(attempts, 1);

    // The user picks a (working) project directly, rather than using Retry.
    const linked = await connection.link("place:1", "/projects/one/default.project.json");
    assert.equal(linked.ok, true);
    assert.equal(attempts, 2);

    await connection.relinkConnected(["place:1"]);
    assert.equal(attempts, 2, "the earlier failure is gone; relinkConnected sees it as already linked");
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

test("two overlapping relinkConnected calls against a slow bridge make exactly one link_project call", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        await new Promise<void>((resolve) => { release = resolve; });
        return linkSuccess();
      },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    const first = connection.relinkConnected(["place:1"]);
    // Give the first call's `link_project` a chance to start (and register as
    // in-flight) before the second poll fires, the same as a real ~5 s gap.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = connection.relinkConnected(["place:1"]);

    assert.equal(calls.length, 1, "the second poll reused the first attempt instead of starting a concurrent one");
    release?.();
    await Promise.all([first, second]);
    assert.equal(calls.length, 1, "still exactly one call once both polls have settled");
  });
});

test("retry() reuses an in-flight automatic relink instead of starting a second attempt", async () => {
  await withStore(async (store) => {
    await store.remember("place:1", "/projects/one/default.project.json");
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    const connection = new RojoConnection({
      store,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        await new Promise<void>((resolve) => { release = resolve; });
        return linkSuccess();
      },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    const automatic = connection.relinkConnected(["place:1"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retried = connection.retry("place:1");

    assert.equal(calls.length, 1, "retry() awaited the attempt already running rather than starting another");
    release?.();
    const [, retriedResult] = await Promise.all([automatic, retried]);
    assert.equal(retriedResult.ok, true);
  });
});

test("bridgeRestarted() clears a linked anon place's memory, so its view is no longer linked", async () => {
  await withStore(async (store) => {
    const connection = new RojoConnection({
      store,
      callTool: async () => linkSuccess({ instance_id: "anon:abc" }),
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    await connection.link("anon:abc", "/projects/one/default.project.json");
    const linked = await connection.view("anon:abc", ["anon:abc"]);
    assert.equal(linked.state, "linked-running");

    connection.bridgeRestarted();
    const afterRestart = await connection.view("anon:abc", ["anon:abc"]);
    assert.notEqual(afterRestart.state, "linked-running", "an unpublished place's link does not survive a bridge restart");
  });
});

test("a failed 'Change project...' on a currently-linked instance keeps the working link instead of marking it broken", async () => {
  await withStore(async (store) => {
    let attempts = 0;
    const connection = new RojoConnection({
      store,
      callTool: async () => {
        attempts += 1;
        return attempts === 1
          ? linkSuccess({ project: "default.project.json", root: "/projects/one" })
          : outcome({ ok: false, data: { error: "Already linked to another place", errorCode: "rojo_link_invalid" }, message: "Already linked to another place" });
      },
      probe: async () => ({ answering: true }),
      readServePort: neverReadsPort(),
    });

    const linked = await connection.link("place:1", "/projects/one/default.project.json");
    assert.equal(linked.ok, true);

    const failed = await connection.link("place:1", "/projects/two/default.project.json");
    assert.equal(failed.ok, false);
    assert.equal(failed.message, "Already linked to another place");
    if (failed.ok) throw new Error("unreachable");
    assert.equal(failed.view?.state, "linked-running", "the view still shows the working link, not an error");
    assert.equal(failed.view?.project?.fileName, "default.project.json");

    const view = await connection.view("place:1", ["place:1"]);
    assert.equal(view.state, "linked-running", "a later view also still shows the old, working link");
    assert.equal(view.project?.fileName, "default.project.json");
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
