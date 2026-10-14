import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectFilesStore, runProjectFilesTool, safeName, sharedFilesNotice } from "./project-files";
import { BlenderWorker } from "./blender-worker";
import { modelPreviewSource } from "./model-preview";
import { canSendToStudio } from "../shared/project-files";
import { parseBlenderViews } from "./blender-tool";
import { riskForTool, summarizeToolCall } from "../shared/mcp-tools";
import { activityKind, activityLabel, activityTarget } from "../shared/activity";
import { projectDataOperations } from "./project-operations";
import { effectivePreferences, rolePreference, createInitialWorkspace, normalizeWorkspace } from "../src/model";
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

test("a long name is cut in its stem, keeps its extension, and cleans to itself", async () => {
  const long = `${"a".repeat(179)} tail.glb`;
  const cleaned = safeName(long);
  assert.ok(cleaned.endsWith(".glb") && cleaned.length <= 180, cleaned);
  assert.equal(safeName(cleaned), cleaned, "the stored name is the name on disk");
  assert.equal(safeName("plan. "), "plan");

  const { store, outside } = await scratch();
  const source = path.join(outside, "x.glb");
  await fs.writeFile(source, "glb");
  const file = await store.add("p", source, { name: long, addedBy: "user" });
  assert.equal(file.kind, "model");
  assert.equal(await fs.readFile((await store.path("p", file.id)).filePath, "utf8"), "glb");
});

test("reading a large text file reads only its start", async () => {
  const { store, outside } = await scratch();
  const source = path.join(outside, "log.txt");
  await fs.writeFile(source, "x".repeat(400_000));
  const file = await store.add("p", source, { addedBy: "user" });
  const read = await runProjectFilesTool({ store, projectId: "p", shared: [], saveRoots: [] }, { action: "read", id: file.id });
  assert.match(read.text, /the first 60,000 characters of/);
  assert.ok(read.text.length < 61_000);
});

test("only models Roblox takes are sent, and a preview of another export sends its own GLB", async () => {
  assert.equal(canSendToStudio("tree.fbx"), true);
  assert.equal(canSendToStudio("tree.GLB"), true);
  assert.equal(canSendToStudio("tree.obj"), false);
  assert.equal(canSendToStudio("tree.gltf"), false);

  const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-jobs-"));
  const job = path.join(jobsRoot, "2026-job-abcdef12");
  await fs.mkdir(path.join(job, "output"), { recursive: true });
  await fs.writeFile(path.join(job, "output", "tree.obj"), "obj");
  await fs.writeFile(path.join(job, "model-preview-0.glb"), "glb");
  await fs.writeFile(path.join(job, "model-preview-0.json"), JSON.stringify({ name: "tree.obj" }));
  assert.deepEqual(await modelPreviewSource(jobsRoot, "abcdef12-0"), { filePath: path.join(job, "model-preview-0.glb"), name: "model-abcdef12.glb" });
  await fs.writeFile(path.join(job, "output", "tree.fbx"), "fbx");
  await fs.writeFile(path.join(job, "model-preview-0.json"), JSON.stringify({ name: "tree.fbx" }));
  assert.deepEqual(await modelPreviewSource(jobsRoot, "abcdef12-0"), { filePath: path.join(job, "output", "tree.fbx"), name: "tree.fbx" });
});

test("a look at a file stays inside Roqer's own folders and never opens a network path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-look-"));
  const jobsRoot = path.join(root, "jobs");
  const filesRoot = path.join(root, "files");
  const elsewhere = path.join(root, "elsewhere");
  await Promise.all([jobsRoot, filesRoot, elsewhere].map((folder) => fs.mkdir(folder, { recursive: true })));
  await fs.writeFile(path.join(elsewhere, "secret.glb"), "glb");
  await fs.writeFile(path.join(filesRoot, "split.gltf"), JSON.stringify({ buffers: [{ uri: "split.bin" }] }));
  // Never started: every refusal comes before Blender would run.
  const worker = new BlenderWorker({ executable: process.execPath, jobsRoot, inspectRoots: [jobsRoot, filesRoot] });
  const refused = async (file: string) => {
    const outcome = await worker.run({ inspect_file: file });
    assert.equal(outcome.ok, false);
    return outcome.text;
  };
  assert.match(await refused(path.join(elsewhere, "secret.glb")), /not in them/);
  assert.match(await refused(path.join(filesRoot, "..", "elsewhere", "secret.glb")), /not in them/);
  assert.match(await refused("\\\\attacker.example\\share\\x.glb"), /not in them/);
  assert.match(await refused(path.join(filesRoot, "split.gltf")), /single \.glb/);
});

test("the files index is versioned, and the first builds' bare list is read and rewritten in that form", async () => {
  const { root, store, outside } = await scratch();
  try {
    const source = path.join(outside, "rock.glb");
    await fs.writeFile(source, "glb");
    const file = await store.add("p1", source, { addedBy: "user" });
    const index = path.join(root, "files", "p1", "index.json");
    const saved = JSON.parse(await fs.readFile(index, "utf8"));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.files.map((entry: { id: string }) => entry.id), [file.id]);

    // An index written by the first builds: a bare array.
    await fs.writeFile(index, JSON.stringify(saved.files));
    const reopened = new ProjectFilesStore(path.join(root, "files"));
    assert.deepEqual((await reopened.list("p1")).map((entry) => entry.id), [file.id]);
    assert.equal(JSON.parse(await fs.readFile(index, "utf8")).version, 1, "rewritten in the versioned form");
    assert.ok(!(await fs.readdir(path.dirname(index))).some((name) => name.includes("damaged")), "an old index is not damage");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a damaged files index is kept aside and rebuilt from the files, so adding a file never loses the others", async () => {
  const { root, store, outside } = await scratch();
  try {
    const names = ["a.glb", "b.png", "plan.md"];
    const added = [];
    for (const name of names) {
      const source = path.join(outside, name);
      await fs.writeFile(source, name);
      added.push(await store.add("p1", source, { addedBy: "user", note: `about ${name}` }));
    }
    const index = path.join(root, "files", "p1", "index.json");
    await fs.writeFile(index, "{ \"version\": 1, \"files\": [ truncated");

    const reopened = new ProjectFilesStore(path.join(root, "files"));
    const extra = path.join(outside, "c.fbx");
    await fs.writeFile(extra, "c");
    await reopened.add("p1", extra, { addedBy: "user" });
    const listed = await reopened.list("p1");
    assert.deepEqual(listed.map((entry) => entry.name).sort(), ["a.glb", "b.png", "c.fbx", "plan.md"]);
    assert.deepEqual(new Set(listed.map((entry) => entry.id)), new Set([...added.map((entry) => entry.id), listed.find((entry) => entry.name === "c.fbx")!.id]));
    assert.equal(listed.find((entry) => entry.name === "b.png")!.kind, "image");
    const kept = (await fs.readdir(path.dirname(index))).filter((name) => name.startsWith("index.json.damaged-"));
    assert.equal(kept.length, 1, "the damaged index is kept for diagnosis, once");
    assert.match(await fs.readFile(path.join(path.dirname(index), kept[0]), "utf8"), /truncated/);

    // An entry that is not a file is damage too: the rest are kept with it.
    await fs.writeFile(index, JSON.stringify({ version: 1, files: [listed[0], { id: 42 }] }));
    assert.equal((await new ProjectFilesStore(path.join(root, "files")).list("p1")).length, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a files index that cannot be read just now, or that a newer Roqer wrote, is never written over", async () => {
  const { root, store, outside } = await scratch();
  try {
    const source = path.join(outside, "a.glb");
    await fs.writeFile(source, "a");
    await store.add("p1", source, { addedBy: "user" });
    const index = path.join(root, "files", "p1", "index.json");
    const before = await fs.readFile(index, "utf8");

    // Unreadable (a folder where the file should be stands in for a locked file).
    await fs.rename(index, `${index}.real`);
    await fs.mkdir(index);
    const locked = new ProjectFilesStore(path.join(root, "files"));
    await assert.rejects(locked.list("p1"), /could not be read just now/);
    await assert.rejects(locked.add("p1", source, { addedBy: "user" }), /could not be read just now/);
    await fs.rm(index, { recursive: true });
    await fs.rename(`${index}.real`, index);
    assert.equal(await fs.readFile(index, "utf8"), before);

    // Newer: listed, but not changed.
    const newer = JSON.stringify({ version: 2, files: JSON.parse(before).files, shelves: [] });
    await fs.writeFile(index, newer);
    const reopened = new ProjectFilesStore(path.join(root, "files"));
    assert.equal((await reopened.list("p1")).length, 1);
    await assert.rejects(reopened.add("p1", source, { addedBy: "user" }), /newer version of Roqer/);
    assert.equal(await fs.readFile(index, "utf8"), newer);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleting a project removes its files", async () => {
  const { root, store, outside } = await scratch();
  try {
    const source = path.join(outside, "a.glb");
    await fs.writeFile(source, "a");
    await store.add("p1", source, { addedBy: "user" });
    await store.add("p2", source, { addedBy: "user" });
    await store.removeProject("p1");
    await assert.rejects(fs.stat(path.join(root, "files", "p1")));
    assert.equal((await store.list("p1")).length, 0);
    assert.equal((await store.list("p2")).length, 1, "other projects keep theirs");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the agent's notes and files calls are classified and named as steps: reads are reads, changes are edits", async () => {
  assert.equal(riskForTool("project_memory", { action: "list" }), "read");
  assert.equal(riskForTool("project_memory", { action: "add", text: "x" }), "mutation");
  assert.equal(riskForTool("master_plan", { action: "read" }), "read");
  assert.equal(riskForTool("master_plan", { action: "edit" }), "mutation");
  assert.equal(riskForTool("project_files", { action: "path", id: "file-1" }), "read");
  assert.equal(riskForTool("project_files", { action: "save", path: "C:/x.glb" }), "mutation");
  assert.equal(riskForTool("project_files", {}), "mutation", "no action is not a read");

  const step = (tool: string, args: Record<string, unknown>, past = true) => {
    const target = activityTarget(tool, summarizeToolCall(tool, args));
    return [activityKind(tool, target), activityLabel(tool, target, past)];
  };
  assert.deepEqual(step("project_memory", { action: "add", text: "R6 only" }), ["edit", "Saved a project memory"]);
  assert.deepEqual(step("master_plan", { action: "edit" }), ["edit", "Edited the master plan"]);
  assert.deepEqual(step("master_plan", { action: "read" }, false), ["read", "Reading the master plan"]);
  assert.deepEqual(step("project_files", { action: "save", path: "C:/jobs/x.glb", name: "Pine.glb" }), ["edit", "Saved Pine.glb to the project"]);
  assert.deepEqual(step("project_files", { action: "list" }), ["read", "Listed the project files"]);

  // As local operations: a refusal the model can fix comes back as a failed call, not a crash.
  const { root, store } = await scratch();
  try {
    const operations = new Map(projectDataOperations({ files: { store, projectId: "p1", shared: [], saveRoots: [root] } }));
    const missing = await operations.get("project_files")!({ action: "read", id: "file-nope" }, {}, async () => { throw new Error("no Studio"); });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /has no file file-nope/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
