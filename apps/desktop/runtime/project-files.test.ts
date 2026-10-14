import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectFilesStore, runProjectFilesTool, sharedFilesNotice } from "./project-files";
import { displayNameFor, sendModelToStudio } from "./send-to-studio";
import { parseBlenderViews } from "./blender-tool";
import { riskForTool } from "../shared/mcp-tools";
import { effectivePreferences, rolePreference, createInitialWorkspace, normalizeWorkspace } from "../src/model";
import type { McpToolOutcome } from "./mcp-types";
import { MAX_WORKBENCH_TOOLS } from "./workbench-mcp-server";
import { workbenchToolNames } from "./workbench-tools";

async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-files-"));
  const outside = path.join(root, "made");
  await fs.mkdir(outside);
  return { root, store: new ProjectFilesStore(path.join(root, "files")), outside };
}

test("project files are copied in, listed, noted, and removed", async () => {
  const { store, outside } = await scratch();
  const source = path.join(outside, "Pine Tree.fbx");
  await fs.writeFile(source, "fbx bytes");
  const file = await store.add("project-1", source, { addedBy: "user", chatId: "chat-1", note: "the hero tree" });
  assert.equal(file.kind, "model");
  assert.equal(file.name, "Pine Tree.fbx");
  await fs.rm(source);
  const { filePath } = await store.path("project-1", file.id);
  assert.equal(await fs.readFile(filePath, "utf8"), "fbx bytes", "the copy outlives the original");

  const renamed = await store.update("project-1", file.id, { note: "two trunks" });
  assert.equal(renamed.note, "two trunks");
  assert.deepEqual((await store.list("project-2")), [], "projects do not share files");
  await store.remove("project-1", file.id);
  assert.deepEqual(await store.list("project-1"), []);
  await assert.rejects(fs.stat(filePath));
});

test("names are kept inside their own folder", async () => {
  const { store, outside } = await scratch();
  const source = path.join(outside, "plan.md");
  await fs.writeFile(source, "# Plan");
  const file = await store.add("project-1", source, { name: "../../escape\u0001.md", addedBy: "agent" });
  assert.equal(file.name, "escape_.md");
  await assert.rejects(store.add("../evil", source, { addedBy: "user" }));
});

test("the agent lists, reads, and saves files, but only saves what Roqer made", async () => {
  const { root, store, outside } = await scratch();
  const plan = path.join(outside, "plan.md");
  await fs.writeFile(plan, "# Beneath the Pines\nSurvive the night.");
  const added = await store.add("p", plan, { addedBy: "user" });
  const context = { store, projectId: "p", chatId: "c", shared: [added.id], saveRoots: [path.join(root, "jobs")] };

  const listed = await runProjectFilesTool(context, { action: "list" });
  assert.match(listed.text, /plan\.md · text/);
  assert.match(listed.text, /shared with this chat/);
  assert.match((await runProjectFilesTool(context, { action: "read", id: added.id })).text, /Survive the night/);

  await assert.rejects(runProjectFilesTool(context, { action: "save", path: plan }), /outside/);
  await fs.mkdir(path.join(root, "jobs", "job-1", "output"), { recursive: true });
  const exported = path.join(root, "jobs", "job-1", "output", "crate.glb");
  await fs.writeFile(exported, "glb");
  const saved = await runProjectFilesTool(context, { action: "save", path: exported, name: "Scrap Crate.glb", note: "glowing crate" });
  assert.equal(saved.changed, true);
  const files = await store.list("p");
  assert.equal(files.length, 2);
  assert.equal(files[1].addedBy, "agent");
  assert.equal(files[1].chatId, "c");
  assert.match((await runProjectFilesTool(context, { action: "read", id: files[1].id })).text, /inspect_file/);

  assert.match(sharedFilesNotice(files, [added.id]) ?? "", /plan\.md/);
  assert.equal(sharedFilesNotice(files, []), null);
});

const outcome = (data: unknown, ok = true): McpToolOutcome => ({ ok, data, text: "", httpStatus: 200, durationMs: 1 });

test("send to Studio uploads, waits for processing, then inserts", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let polls = 0;
  const result = await sendModelToStudio(async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "upload_asset" && args.action === "upload") return outcome({ status: "processing", operation_id: "op-1" });
    if (tool === "upload_asset") return outcome(++polls < 2 ? { status: "processing", operation_id: "op-1" } : { status: "complete", asset_id: "123" });
    return outcome({ success: true });
  }, { filePath: "C:/m/tree.fbx", displayName: "tree", instanceId: "place:1" }, async () => undefined);
  assert.equal(result.ok, true);
  assert.equal(result.assetId, "123");
  assert.deepEqual(calls.at(-1), ["insert_asset", { assetId: 123, instance_id: "place:1" }]);
  assert.equal(displayNameFor("scrap_metal-glow.fbx"), "scrap metal glow");
});

test("send to Studio says why an upload failed and does not insert", async () => {
  const tools: string[] = [];
  const result = await sendModelToStudio(async (tool) => {
    tools.push(tool);
    return { ...outcome(undefined, false), message: "401 Unauthorized: invalid API key" };
  }, { filePath: "C:/m/tree.fbx", displayName: "tree", instanceId: null }, async () => undefined);
  assert.equal(result.ok, false);
  assert.match(result.message, /Open Cloud key/);
  assert.deepEqual(tools, ["upload_asset"]);
});

test("blender views are checked and filled in, and looking at a file is a read", () => {
  assert.deepEqual(parseBlenderViews([{ yaw: -90, focus: "Wheel", label: "left wheel" }, {}]), [
    { yaw: 270, pitch: 20, zoom: 1, focus: "Wheel", label: "left wheel" },
    { yaw: 30, pitch: 20, zoom: 1 },
  ]);
  assert.throws(() => parseBlenderViews(new Array(7).fill({})));
  assert.throws(() => parseBlenderViews([{ yaw: "front" }]));
  assert.equal(riskForTool("run_blender_script", { inspect_file: "C:/a.fbx" }), "read");
  assert.equal(riskForTool("run_blender_script", { script: "pass" }), "irreversible");
});

test("a chat role keeps its own model and effort", () => {
  const base = createInitialWorkspace().preferences;
  const general = { ...base, provider: "claude" as const, claudeModelId: "sonnet", reasoningEffort: "medium" as const };
  assert.equal(effectivePreferences(general, "planner"), general, "a role not set up starts from the workspace's choice");
  const patch = rolePreference(general, "planner", { claudeModelId: "opus", reasoningEffort: "high" });
  const withPlanner = { ...general, ...patch };
  assert.equal(withPlanner.claudeModelId, "sonnet", "the workspace's own choice is untouched");
  const planner = effectivePreferences(withPlanner, "planner");
  assert.equal(planner.claudeModelId, "opus");
  assert.equal(planner.reasoningEffort, "high");
  assert.equal(effectivePreferences(withPlanner, "scripter").claudeModelId, "sonnet");

  const saved = normalizeWorkspace(JSON.parse(JSON.stringify({ ...createInitialWorkspace(), preferences: withPlanner })));
  assert.deepEqual(saved.preferences.roleSettings, { planner: { provider: "claude", model: "opus", effort: "high" } });
});

test("every workbench tool, all turned on at once, fits the server", async () => {
  const { store } = await scratch();
  const names = workbenchToolNames({
    skillLibrary: undefined as never, blender: true, referenceClips: true,
    projectNotes: { store: undefined as never, projectId: "p" },
    projectFiles: { store, projectId: "p", shared: [], saveRoots: [] },
  });
  assert.ok(names.includes("project_files"));
  assert.ok(names.length <= MAX_WORKBENCH_TOOLS, `${names.length} tools`);
});
