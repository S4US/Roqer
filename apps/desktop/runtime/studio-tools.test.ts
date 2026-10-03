import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { blenderToolDefinition } from "./blender-tool";
import { iconToolDefinition } from "./icon-tool";
import { questionToolDefinition } from "./question-tool";
import { openSkillLibrary } from "./skill-library";
import { skillToolDefinition } from "./skill-tool";
import { taskToolDefinition } from "./task-tool";
import type { McpToolOutcome } from "./mcp-types";
import type { PlannerContext } from "./run-engine";
import { ANIMATION_BOXES_LABEL, ANIMATION_NAME_LABEL, ANIMATION_RIG_LABEL, RIG_RANGE_SHEET_TITLE, type RunEvidence } from "../shared/run-events";
import { runDeveloperInstructions } from "./run-instructions";
import {
  createStudioToolRunner, MalformedToolCallError, MAX_TOOL_DESCRIPTION_CHARS, parseStudioToolInput, studioToolDescription, studioToolGuide, studioToolResultText,
} from "./studio-tools";
import { previewVersions } from "../src/preview-layout";

const ok = (data: Record<string, unknown>): McpToolOutcome => ({
  ok: true,
  data,
  text: "",
  httpStatus: 200,
  durationMs: 1,
});

/**
 * A write is preceded by a read that widens the source context, so a test that
 * wants the runner to fall back on what the agent itself read supplies a failed
 * one. Studio being unable to answer must not change what the write does.
 */
const unavailable = (): McpToolOutcome => ({
  ok: false,
  data: {},
  text: "",
  httpStatus: 500,
  durationMs: 1,
});

function contextWith(outcomes: McpToolOutcome[]) {
  const changes: Array<Record<string, unknown>> = [];
  const evidence: Array<Omit<RunEvidence, "id">> = [];
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const context: PlannerContext = {
    prompt: "Edit Main",
    conversation: { messages: [], truncated: false },
    images: [],
    instanceId: "studio-1",
    autoPlaytest: false,
    signal: new AbortController().signal,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return outcomes.shift() ?? ok({});
    },
    say: () => undefined,
    status: () => undefined,
    progress: () => undefined,
    outputTokens: () => undefined,
    contextUsage: () => undefined, runUsage: () => undefined,
    recordChange: (change) => changes.push(change),
    recordEvidence: (item) => evidence.push(item),
    setTasks: () => undefined,
    tasks: () => [],
    changes: () => [],
    evidence: () => [],
    decisions: () => [],
    takeSteers: () => [],
    askUser: async (_question, options) => options[0],
    checkCompletion: () => ({ verified: true, issues: [] }),
  };
  return { context, changes, evidence, calls };
}

test("localized edits carry their real file line coordinates", async () => {
  const { context, changes } = contextWith([
    ok({ source: "line 40\nline 41\nold value\nline 43", startLine: 40, sourceRevision: "before" }),
    unavailable(),
    ok({ sourceRevision: "after" }),
    ok({ source: "line 40\nline 41\nnew value\nline 43", sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("get_script_source", { instancePath: "game.ServerScriptService.Main", line_range: "40-43" });
  await run("edit_script_lines", {
    instancePath: "game.ServerScriptService.Main",
    old_string: "old value",
    new_string: "new value",
    line_range: "42",
  });

  assert.equal(changes[0].oldStartLine, 40);
  assert.equal(changes[0].newStartLine, 40);
  assert.equal(changes[0].diff, " line 40\n line 41\n-old value\n+new value\n line 43");
});

test("an operation's schema can be read without spending a Studio call on it", async () => {
  // Discovering a local fact by sending a call you expect to fail costs a round
  // trip, an approval decision on a write you did not mean yet, and a failed row
  // describing the model finding its footing rather than anything that happened.
  const { context, calls, changes } = contextWith([]);
  const run = createStudioToolRunner(context);

  const result = await run("capture_device_matrix", { help: true });

  assert.equal(result.ok, true);
  assert.match(result.text, /Schema for capture_device_matrix/);
  assert.equal(calls.length, 0, "nothing reached Studio");
  assert.equal(changes.length, 0);
});

test("asking for help on an operation with no published schema is answered, not failed silently", async () => {
  const { context, calls } = contextWith([]);
  const run = createStudioToolRunner(context);

  const result = await run("not_a_real_operation", { help: true });

  assert.equal(result.ok, false);
  assert.match(result.text, /No schema is published for not_a_real_operation/);
  assert.equal(calls.length, 0);
});

test("a completed upload becomes one host-owned asset result with a Roblox link", async () => {
  const completed = ok({
    path: "operations/upload-456",
    operation_id: "upload-456",
    done: true,
    status: "complete",
    asset_id: "987654321",
    moderation_state: "Approved",
    response: {
      assetId: "987654321",
      displayName: "Village kit",
      assetType: "Model",
      moderationResult: { moderationState: "Approved" },
    },
  });
  const { context, changes } = contextWith([completed, completed]);
  const run = createStudioToolRunner(context);

  await run("upload_asset", {
    action: "upload",
    filePath: "C:/tmp/village.rbxm",
    assetType: "Model",
    displayName: "Village kit",
  });
  await run("upload_asset", { action: "status", operationId: "upload-456" });

  assert.deepEqual(changes, [{
    kind: "asset",
    target: "rbxassetid://987654321",
    summary: "Uploaded “Village kit” to Roblox as asset 987654321. Moderation: Approved.",
    assetId: "987654321",
    assetUrl: "https://create.roblox.com/store/asset/987654321",
    assetType: "Model",
    moderationState: "Approved",
    operationId: "upload-456",
  }]);
});

test("a processing upload keeps its operation in the tool result but creates no asset card yet", async () => {
  const { context, changes } = contextWith([ok({
    path: "operations/upload-pending",
    operation_id: "upload-pending",
    done: false,
    status: "processing",
  })]);
  const run = createStudioToolRunner(context);

  const result = await run("upload_asset", {
    action: "upload",
    filePath: "C:/tmp/village.rbxm",
    assetType: "Model",
    displayName: "Village kit",
  });

  assert.equal(changes.length, 0);
  assert.match(result.text, /upload-pending/);
  assert.match(result.text, /processing/);
});

test("a batch of edits is one change, one diff, and one read-back", async () => {
  // Three separate edit_script_lines calls used to mean three writes, three
  // revisions, three cards, and three automatic read-backs of the same file.
  const source = "local price = 10\nlocal name = \"old\"\nlocal count = 1\n";
  const edited = "local price = 25\nlocal name = \"new\"\nlocal count = 1\n";
  const { context, changes, evidence, calls } = contextWith([
    ok({ source, sourceRevision: "before" }),
    ok({ sourceRevision: "after", editsApplied: 2 }),
    ok({ source: edited, sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Shop";

  await run("get_script_source", { instancePath: target });
  await run("edit_script_batch", {
    instancePath: target,
    expectedRevision: "before",
    edits: [
      { old_string: "local price = 10", new_string: "local price = 25" },
      { old_string: "local name = \"old\"", new_string: "local name = \"new\"" },
    ],
  });

  assert.equal(changes.length, 1, "one transaction is one change");
  assert.equal(changes[0].kind, "script-source");
  assert.equal(changes[0].revisionAfter, "after");
  assert.equal(
    changes[0].diff,
    "-local price = 10\n-local name = \"old\"\n+local price = 25\n+local name = \"new\"\n local count = 1\n ",
  );
  assert.equal(
    calls.filter((call) => call.tool === "get_script_source").length,
    2,
    "the agent's own read plus one automatic read-back, not one per edit",
  );
  const verifications = evidence.filter((item) => item.kind === "verification");
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].passed, true);
});

test("a batch whose edits cannot be placed shows its summary rather than a wrong diff", async () => {
  const { context, changes } = contextWith([
    ok({ source: "local a = 1\nlocal b = 2\n", sourceRevision: "before" }),
    ok({ sourceRevision: "after" }),
    ok({ source: "local a = 1\nlocal b = 2\n", sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Shop";

  await run("get_script_source", { instancePath: target });
  await run("edit_script_batch", {
    instancePath: target,
    expectedRevision: "before",
    edits: [
      { old_string: "local a = 1", new_string: "local a = 9" },
      { old_string: "nowhere in this file", new_string: "x" },
    ],
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].diff, undefined, "a diff missing one of the edits would misdescribe the approval");
  assert.equal(changes[0].code, undefined);
  assert.equal(changes[0].summary, "Applied several edits to the script in one transaction.");
});

test("overlapping batch edits are not drawn as if they applied", async () => {
  const { context, changes } = contextWith([
    ok({ source: "local greeting = \"hello world\"\n", sourceRevision: "before" }),
    ok({ sourceRevision: "after" }),
    ok({ source: "local greeting = \"hello world\"\n", sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target });
  await run("edit_script_batch", {
    instancePath: target,
    expectedRevision: "before",
    edits: [
      { old_string: "hello world", new_string: "hi world" },
      { old_string: "world\"", new_string: "there\"" },
    ],
  });

  assert.equal(changes[0].diff, undefined);
});

test("a batch without the revision it was written against never reaches Studio", async () => {
  const { context, changes, calls } = contextWith([ok({ source: "local a = 1\n", sourceRevision: "before" })]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target });
  const result = await run("edit_script_batch", {
    instancePath: target,
    edits: [{ old_string: "local a = 1", new_string: "local a = 9" }],
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /expectedRevision/);
  assert.equal(changes.length, 0);
  assert.equal(calls.filter((call) => call.tool === "edit_script_batch").length, 0);
});

test("small edits include source context and fold untouched regions", async () => {
  const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  const { context, changes } = contextWith([
    ok({ source, sourceRevision: "before" }),
    ok({ sourceRevision: "after" }),
    ok({ source: source.replace("line 15", "line fifteen"), sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("get_script_source", { instancePath: "game.ServerScriptService.Main" });
  await run("edit_script_lines", {
    instancePath: "game.ServerScriptService.Main",
    old_string: "line 15",
    new_string: "line fifteen",
    line_range: "15",
  });

  assert.equal(
    changes[0].diff,
    "@@ 11 unchanged lines @@\n line 12\n line 13\n line 14\n-line 15\n+line fifteen\n line 16\n line 17\n line 18\n@@ 12 unchanged lines @@",
  );
  assert.equal(changes[0].oldStartLine, 1);
  assert.equal(changes[0].newStartLine, 1);
});

test("a deletion from a file too long to diff still shows the code around it", async () => {
  const source = Array.from({ length: 1_400 }, (_, index) => `line ${index + 1}`).join("\n");
  const { context, changes } = contextWith([
    ok({ source, sourceRevision: "before" }),
    ok({ sourceRevision: "after" }),
    ok({ sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target });
  await run("delete_script_lines", { instancePath: target, line_range: "700-701" });

  assert.equal(
    changes[0].diff,
    "@@ 696 unchanged lines @@\n line 697\n line 698\n line 699\n-line 700\n-line 701\n line 702\n line 703\n line 704\n@@ 696 unchanged lines @@",
  );
  assert.equal(changes[0].oldStartLine, 1);
  assert.equal(changes[0].removedLines, 2);
});

test("insertions and deletions become numbered code artifacts", async () => {
  const { context, changes } = contextWith([
    unavailable(),
    ok({ sourceRevision: "inserted" }),
    ok({ sourceRevision: "inserted" }),
    ok({ source: "keep\nremove one\nremove two\ntail", startLine: 40, sourceRevision: "before-delete" }),
    unavailable(),
    ok({ sourceRevision: "deleted" }),
    ok({ sourceRevision: "deleted" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("insert_script_lines", { instancePath: target, afterLine: 12, newContent: "first\nsecond" });
  await run("get_script_source", { instancePath: target, line_range: "40-43" });
  await run("delete_script_lines", { instancePath: target, line_range: "41-42" });

  assert.deepEqual(changes[0], {
    kind: "script-source",
    target,
    instanceId: "studio-1",
    summary: "Inserted lines into the script in Studio.",
    code: "first\nsecond",
    language: "lua",
    truncated: false,
    addedLines: 2,
    newStartLine: 13,
    revisionBefore: undefined,
    revisionAfter: "inserted",
  });
  assert.equal(changes[1].diff, " keep\n-remove one\n-remove two\n tail");
  assert.equal(changes[1].oldStartLine, 40);
  assert.equal(changes[1].removedLines, 2);
});

test("a partial read is never presented as the old side of a full-file diff", async () => {
  const { context, changes } = contextWith([
    ok({ source: "only a range", startLine: 20, isPartial: true, sourceRevision: "before" }),
    unavailable(),
    ok({ sourceRevision: "after" }),
    ok({ source: "whole new file", sourceRevision: "after" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target, line_range: "20-20" });
  await run("set_script_source", { instancePath: target, source: "whole new file", expectedRevision: "before" });

  assert.equal(changes[0].diff, undefined);
  assert.equal(changes[0].code, "whole new file");
  assert.equal(changes[0].newStartLine, 1);
});

test("an edit to a script read one line at a time is still shown in its place in the file", async () => {
  const source = [
    'local Players = game:GetService("Players")',
    "",
    "local function greet()",
    '\tprint("Hello World!")',
    "end",
    "",
    "return greet",
  ].join("\n");
  const { context, changes } = contextWith([
    ok({ source: '\tprint("Hello World!")', startLine: 4, isPartial: true, sourceRevision: "r1" }),
    ok({ source, sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: source.replace("Hello World!", "Hello from AI"), sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Script";

  await run("get_script_source", { instancePath: target, line_range: "4" });
  await run("edit_script_lines", {
    instancePath: target,
    old_string: '\tprint("Hello World!")',
    new_string: '\tprint("Hello from AI")',
    line_range: "4",
  });

  // The agent read one line, so on its own the panel could only have shown that
  // line changing. The widened read is what puts the function around it.
  assert.equal(changes[0].diff, [
    ' local Players = game:GetService("Players")',
    " ",
    " local function greet()",
    '-\tprint("Hello World!")',
    '+\tprint("Hello from AI")',
    " end",
    " ",
    " return greet",
  ].join("\n"));
  assert.equal(changes[0].oldStartLine, 1);
  assert.equal(changes[0].newStartLine, 1);
});

test("an edit is placed by the occurrence nearest its line range when the text repeats", async () => {
  const source = ["a = 1", "value = 0", "b = 2", "value = 0", "c = 3"].join("\n");
  const { context, changes } = contextWith([
    ok({ source, sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: source.replace(/value = 0(?=\nc = 3)/, "value = 9"), sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target });
  await run("edit_script_lines", {
    instancePath: target,
    old_string: "value = 0",
    new_string: "value = 9",
    line_range: "4",
  });

  // Both lines match, so the range decides which one changed. Refusing to
  // choose would have dropped the surrounding code from the panel entirely.
  assert.equal(changes[0].diff, " a = 1\n value = 0\n b = 2\n-value = 0\n+value = 9\n c = 3");
});

test("a full-source rewrite of a CRLF script diffs only the line that changed", async () => {
  const lines = ["local a = 1", "local b = 2", "local c = 3", "local d = 4", "local e = 5"];
  const { context, changes } = contextWith([
    ok({ source: lines.join("\r\n"), sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: [...lines.slice(0, 2), "local c = 30", ...lines.slice(3)].join("\n"), sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target });
  await run("set_script_source", {
    instancePath: target,
    source: [...lines.slice(0, 2), "local c = 30", ...lines.slice(3)].join("\n"),
    expectedRevision: "r1",
  });

  // Studio read the script back as CRLF and the model rewrote it as LF. Compared
  // literally that is a change to every line, and the panel showed the whole
  // file replaced by a copy of itself.
  assert.equal(changes[0].addedLines, 1);
  assert.equal(changes[0].removedLines, 1);
  assert.equal(
    changes[0].diff,
    " local a = 1\n local b = 2\n-local c = 3\n+local c = 30\n local d = 4\n local e = 5",
  );
});

test("an edit repeated after it already landed is not drawn a second time", async () => {
  const before = ["local function greet()", '\tprint("Hello World!")', "end"].join("\n");
  const after = ["local function greet()", '\tprint("Hello from AI")', "end"].join("\n");
  const { context, changes } = contextWith([
    ok({ source: before, sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: after, sourceRevision: "r2" }),
    ok({ sourceRevision: "r3" }),
    ok({ source: after, sourceRevision: "r3" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Script";
  const edit = {
    instancePath: target,
    old_string: '\tprint("Hello World!")',
    new_string: '\tprint("Hello from AI")',
  };

  await run("get_script_source", { instancePath: target });
  await run("edit_script_lines", edit);
  await run("edit_script_lines", edit);

  assert.equal(changes[0].diff, ' local function greet()\n-\tprint("Hello World!")\n+\tprint("Hello from AI")\n end');
  // The script no longer contains the text this edit says it replaced, so there
  // is no second change to show — only the summary of a call Studio accepted.
  assert.equal(changes.length, 2);
  assert.equal(changes[1].diff, undefined);
  assert.equal(changes[1].code, undefined);
});

test("a second write diffs against what the first one left, not the stale read", async () => {
  const { context, changes } = contextWith([
    ok({ source: 'print("Hello World!")', sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: 'print("Hello from AI")', sourceRevision: "r2" }),
    ok({ sourceRevision: "r3" }),
    ok({ source: 'print("Hello again")', sourceRevision: "r3" }),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Script";

  await run("get_script_source", { instancePath: target });
  await run("set_script_source", { instancePath: target, source: 'print("Hello from AI")', expectedRevision: "r1" });
  await run("set_script_source", { instancePath: target, source: 'print("Hello again")', expectedRevision: "r2" });

  assert.equal(changes[0].diff, '-print("Hello World!")\n+print("Hello from AI")');
  // Reusing the original read here would show the first edit a second time, so
  // one change would appear as two identical panels.
  assert.equal(changes[1].diff, '-print("Hello from AI")\n+print("Hello again")');
  assert.equal(changes[1].revisionBefore, "r2");
});

test("a call missing a required argument is answered with the schema, not sent to Studio", async () => {
  const calls: string[] = [];
  const { context } = contextWith([]);
  const run = createStudioToolRunner({ ...context, call: async (tool) => { calls.push(tool); return ok({}); } });

  const result = await run("solo_playtest", {});

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], "Studio must not be asked for a call the server would reject");
  assert.ok(result.text.includes("missing the required argument action"));
  assert.ok(result.text.includes("Schema for solo_playtest {action: 'start'|'stop'|'status'"));
  // The conditional requirement that cost the second call in the observed run.
  assert.ok(result.text.includes('Required for action="start"'));
});

test("a guessed upload shape is corrected locally instead of becoming a failed activity", async () => {
  const { context, calls } = contextWith([]);
  const run = createStudioToolRunner(context);

  const result = await run("upload_asset", {
    action: "upload",
    path: "C:/Users/creator/Downloads/head.png",
    type: "Decal",
    name: "funny head",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], "the malformed upload must not reach the bridge");
  assert.match(result.text, /missing the required arguments filePath, assetType, displayName/);
  assert.match(result.text, /action='upload' requires filePath, assetType, displayName/);
});

test("steps written as JSON text reach Studio as the array the model meant", async () => {
  const steps = [{ op: "create", className: "Part", id: "floor" }];
  const parsed = parseStudioToolInput({
    operation: "build_instances",
    arguments: JSON.stringify({ path: "game.Workspace.Track", operations: JSON.stringify(steps) }),
  });
  const { context, calls } = contextWith([ok({ path: "game.Workspace.Track", created: 1 })]);
  const run = createStudioToolRunner(context);

  const result = await run(parsed.operation, parsed.args);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ tool: "build_instances", args: { path: "game.Workspace.Track", operations: steps } }]);
});

test("a value that cannot be read as its declared type is answered locally, saying what to send", async () => {
  const { context, calls } = contextWith([]);
  const run = createStudioToolRunner(context);

  const result = await run("get_project_structure", { path: "game.Workspace", maxDepth: "deep" });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], "a string where Studio compares numbers must not reach the plugin");
  assert.match(result.text, /maxDepth must be number, but it arrived as text/);
  assert.match(result.text, /Schema for get_project_structure/);
});

test("an empty pattern is answered with the schema rather than sent to Studio", async () => {
  const calls: string[] = [];
  const { context } = contextWith([]);
  const run = createStudioToolRunner({ ...context, call: async (tool) => { calls.push(tool); return ok({}); } });

  const result = await run("grep_scripts", { pattern: "" });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
  assert.ok(result.text.includes("pattern is required and cannot be empty"));
  assert.ok(result.text.includes("- pattern (required, string, non-empty)"));
});

test("an empty script source is still written, because emptying a script is a real edit", async () => {
  const calls: string[] = [];
  const { context } = contextWith([]);
  const run = createStudioToolRunner({
    ...context,
    call: async (tool) => { calls.push(tool); return ok({ sourceRevision: "r2" }); },
  });

  const result = await run("set_script_source", {
    instancePath: "game.ServerScriptService.Main", source: "", expectedRevision: "r1",
  });

  assert.equal(result.ok, true);
  assert.ok(calls.includes("set_script_source"));
});

test("a successful script mutation is read back and verified without another model call", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, changes, evidence, calls } = contextWith([
    ok({ source: 'print("before")', sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: 'print("after")', sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("set_script_source", {
    instancePath: target,
    source: 'print("after")',
    expectedRevision: "r1",
  });

  assert.deepEqual(calls.map(({ tool, args }) => ({ tool, args })), [
    { tool: "get_script_source", args: { instancePath: target, line_range: "1-" } },
    {
      tool: "set_script_source",
      args: { instancePath: target, source: 'print("after")', expectedRevision: "r1" },
    },
    { tool: "get_script_source", args: { instancePath: target, line_range: "1-" } },
  ]);
  assert.equal(changes.length, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].passed, true);
  assert.deepEqual(evidence[0].metadata, [
    { label: "Revision after write", value: "r2" },
    { label: "Revision read back", value: "r2" },
  ]);
  assert.match(result.text, /automatically read the script back and verified revision r2/);
});

/**
 * The reported failure: a three-line change rendered as the whole file deleted
 * and re-added. Studio answers a read with a numbered listing, and diffing that
 * against the source the model wrote makes every line differ.
 */
test("a diff is taken against the file, not against the numbered listing Studio returns", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, changes } = contextWith([
    ok({ source: "1: local a = 1\n2: local b = 2\n3: return a + b", sourceRevision: "r1", startLine: 1 }),
    ok({ revision: "r2" }),
    ok({ source: "1: local a = 1\n2: local b = 3\n3: return a + b", sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("set_script_source", {
    instancePath: target,
    source: "local a = 1\nlocal b = 3\nreturn a + b",
    expectedRevision: "r1",
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].addedLines, 1, "one line changed, so one line is added");
  assert.equal(changes[0].removedLines, 1, "and one removed — not the whole file");
  assert.match(String(changes[0].diff ?? ""), /^ local a = 1$/m, "the unchanged lines are recognised as unchanged");
});

test("a payload that is not a numbered listing is diffed exactly as it arrived", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, changes } = contextWith([
    ok({ source: "local a = 1\nlocal b = 2", sourceRevision: "r1" }),
    ok({ revision: "r2" }),
    ok({ source: "local a = 1\nlocal b = 3", sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("set_script_source", {
    instancePath: target,
    source: "local a = 1\nlocal b = 3",
    expectedRevision: "r1",
  });

  assert.equal(changes[0].addedLines, 1);
  assert.equal(changes[0].removedLines, 1);
});

test("a revision mismatch leaves the applied mutation explicitly unverified", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, evidence } = contextWith([
    ok({ source: 'print("before")', sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    ok({ source: 'print("someone else changed it")', sourceRevision: "r3" }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("set_script_source", {
    instancePath: target,
    source: 'print("after")',
    expectedRevision: "r1",
  });

  assert.equal(result.ok, true, "the mutation itself succeeded");
  assert.equal(evidence[0].passed, false);
  assert.match(evidence[0].detail ?? "", /different revision/);
  assert.match(result.text, /Do not describe this change as verified/);
});

/**
 * One write, one check. The agent is told a write is unverified and reads the
 * script to see for itself; that read must not file the same failure again and
 * count it twice against the run.
 */
test("an unverifiable write is reported once, however often the agent re-reads it", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, evidence } = contextWith([
    ok({ source: "local COOLDOWN = 0.8", sourceRevision: "r1" }),
    // The mutation reports no revision of its own, so nothing can match it.
    ok({ success: true }),
    ok({ source: "local COOLDOWN = 0.5", sourceRevision: "r2" }),
    ok({ source: "local COOLDOWN = 0.5", sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("edit_script_lines", {
    instancePath: target,
    old_string: "local COOLDOWN = 0.8",
    new_string: "local COOLDOWN = 0.5",
  });
  await run("get_script_source", { instancePath: target });

  assert.equal(evidence.length, 1, "the agent's own read does not repeat the failed check");
  assert.equal(evidence[0].passed, false);
});

test("a read that never arrived leaves the write pending for a later check", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, evidence } = contextWith([
    ok({ source: "local COOLDOWN = 0.8", sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    { ...unavailable(), errorCode: "request_failed", message: "Studio disconnected" },
    ok({ source: "local COOLDOWN = 0.5", sourceRevision: "r2" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("edit_script_lines", {
    instancePath: target,
    old_string: "local COOLDOWN = 0.8",
    new_string: "local COOLDOWN = 0.5",
  });
  await run("get_script_source", { instancePath: target });

  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].passed, false, "the read never came back");
  assert.equal(evidence[1].passed, true, "the agent's read verified the revision the write reported");
});

test("a failed automatic read-back reports unverified without undoing a successful mutation", async () => {
  const target = "game.ServerScriptService.Main";
  const failedRead = {
    ...unavailable(),
    errorCode: "request_failed",
    message: "Studio disconnected",
  };
  const { context, changes, evidence } = contextWith([
    ok({ source: 'print("before")', sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    failedRead,
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("set_script_source", {
    instancePath: target,
    source: 'print("after")',
    expectedRevision: "r1",
  });

  assert.equal(result.ok, true);
  assert.equal(changes.length, 1);
  assert.equal(evidence[0].passed, false);
  assert.match(evidence[0].detail ?? "", /Studio disconnected/);
  assert.match(result.text, /automatic read-back failed: Studio disconnected/);
});

test("successful runtime observations are recorded with distinct evidence dimensions", async () => {
  const screenshot = {
    ...ok({ width: 800, height: 600 }),
    images: [{ data: "QUJD", mediaType: "image/png" as const }],
  };
  const { context, evidence } = contextWith([
    ok({ entries: [{ message: "ready" }] }),
    screenshot,
    ok({ nodes: [{ path: "PlayerGui.Shop" }] }),
    ok({ clicked: "PlayerGui.Shop.Buy" }),
    ok({ state: "running" }),
  ]);
  const run = createStudioToolRunner(context);

  await run("get_runtime_logs", { target: "client-1" });
  await run("capture_screenshot", { target: "client-1" });
  await run("inspect_ui", { target: "client-1" });
  await run("interact_ui", { action: "click", selector: { name: "Buy" }, target: "client-1" });
  await run("solo_playtest", { action: "start", mode: "play" });

  assert.deepEqual(evidence.map((item) => [item.kind, item.requirement]), [
    ["logs", "runtime"],
    ["screenshot", "visual"],
    ["inspection", "visual"],
    ["interaction", "interaction"],
    ["playtest", undefined],
  ]);
  assert.equal(evidence[1].metadata?.[0]?.value, "1");
});

const PREVIEW = "data:image/jpeg;base64,cHJldmlldw==";

test("image evidence carries the host-made preview of the first returned image", async () => {
  const screenshot = {
    ...ok({ width: 800, height: 600 }),
    images: [{ data: "Rmlyc3Q=", mediaType: "image/png" as const }, { data: "U2Vjb25k", mediaType: "image/png" as const }],
  };
  const { context, evidence } = contextWith([screenshot]);
  const previewed: string[] = [];
  context.previewImage = async (image) => { previewed.push(image.data); return PREVIEW; };
  const run = createStudioToolRunner(context);

  const result = await run("capture_screenshot", {});

  assert.deepEqual(previewed, ["Rmlyc3Q="]);
  assert.equal(evidence[0].kind, "screenshot");
  assert.equal(evidence[0].imageDataUrl, PREVIEW);
  assert.equal(result.images?.length, 2, "the model still receives every image at full size");
});

test("a preview that cannot be made leaves the evidence and the call intact", async () => {
  const screenshot = { ...ok({}), images: [{ data: "QUJD", mediaType: "image/png" as const }] };
  const failing = contextWith([screenshot]);
  failing.context.previewImage = async () => { throw new Error("decoder unavailable"); };
  const withoutEncoder = contextWith([screenshot]);

  const failed = await createStudioToolRunner(failing.context)("capture_screenshot", {});
  await createStudioToolRunner(withoutEncoder.context)("capture_screenshot", {});

  assert.equal(failed.ok, true);
  assert.equal(failing.evidence[0].kind, "screenshot");
  assert.equal(failing.evidence[0].imageDataUrl, undefined);
  assert.equal(withoutEncoder.evidence[0].imageDataUrl, undefined);
});

test("a Blender preview is shown as the job's output and never counts as Studio evidence", async () => {
  const job = { ...ok({}), text: "Exported model.glb", images: [{ data: "QUJD", mediaType: "image/png" as const }] };
  const { context, evidence } = contextWith([job, { ...ok({}), text: "Exported model.glb" }]);
  context.previewImage = async () => PREVIEW;
  const run = createStudioToolRunner(context);

  await run("run_blender_script", { script: "import bpy" });
  await run("run_blender_script", { script: "import bpy" });

  assert.equal(evidence.length, 1, "a job that returned no image records nothing");
  assert.equal(evidence[0].kind, "inspection");
  assert.equal(evidence[0].title, "Blender result, before upload");
  assert.equal(evidence[0].requirement, undefined);
  assert.equal(evidence[0].passed, undefined);
  assert.equal(evidence[0].imageDataUrl, PREVIEW);
  assert.equal(evidence[0].modelPreviewId, undefined, "no 3D preview was kept");
});

test("a Blender job that continues an earlier one's scene previews a later version of the same model", async () => {
  // The run that showed the problem: take 1 only built the scene, so its
  // picture is of scene.blend; take 2 continued it and exported mug.glb.
  const job = (jobId: string, pictured: string, continuedFrom?: string) => ({
    ...ok({ jobId, ...(continuedFrom === undefined ? {} : { continuedFrom }), files: [] }),
    images: [{ data: "QUJD", mediaType: "image/png" as const }],
    pictured: { name: pictured },
  });
  const { context, evidence } = contextWith([
    job("6317610a", "scene.blend"),
    job("9254b059", "mug.glb", "6317610a"),
    job("aaaa0001", "mug.glb"),                   // a fresh start that rebuilds the mug file
    job("aaaa0002", "scene.blend"),               // a fresh scene: a new model
    job("aaaa0003", "cup.glb", "0ld0j0b0"),       // continues a job from an earlier run: new here
    job("aaaa0004", "scene.blend", "aaaa0002"),
  ]);
  context.previewImage = async () => PREVIEW;
  const run = createStudioToolRunner(context);
  for (let call = 0; call < 6; call += 1) await run("run_blender_script", { script: "import bpy" });

  const subjects = evidence.map((item) => item.subject);
  assert.ok(subjects.every((subject) => typeof subject === "string" && subject.length > 0));
  assert.equal(subjects[1], subjects[0], "take 2 continued take 1");
  assert.equal(subjects[2], subjects[0], "a rebuild writing the same file is the same model");
  assert.notEqual(subjects[3], subjects[0], "a fresh scene is a new model");
  assert.notEqual(subjects[4], subjects[0]);
  assert.notEqual(subjects[4], subjects[3]);
  assert.equal(subjects[5], subjects[3]);

  // And the answer's card shows them that way: the mug, the new scene, the cup.
  const { shown, versions } = previewVersions(evidence.map((item, index) => ({ ...item, id: `e${index}` })));
  assert.deepEqual(shown.map((item) => item.id), ["e2", "e4", "e5"]);
  assert.deepEqual(versions.get("e2")?.map((item) => item.id), ["e0", "e1", "e2"]);
  assert.deepEqual(versions.get("e5")?.map((item) => item.id), ["e3", "e5"]);
});

test("a Blender preview carries its model's 3D preview and what was measured, on Roblox's axes", async () => {
  const files = [
    { name: "cart.glb", path: "/jobs/output/cart.glb", bytes: 2048, meshes: 2, triangles: 1336, size: [3.9, 7.14, 2.75] },
    { name: "crate.glb", path: "/jobs/output/crate.glb", bytes: 1024, meshes: 1, triangles: 12, size: [2, 2, 2] },
  ];
  const job = (pictured: McpToolOutcome["pictured"]) => ({
    ...ok({ jobId: "a1b2c3d4", files }),
    text: "Exported cart.glb and crate.glb",
    images: [{ data: "QUJD", mediaType: "image/png" as const }],
    pictured,
  });
  const { context, evidence } = contextWith([
    job({ name: "cart.glb", modelPreviewId: "a1b2c3d4-0" }),
    job({ name: "crate.glb" }),
    job({ name: "cart.glb", modelPreviewId: "../../cart.glb" }),
    job(undefined),
  ]);
  context.previewImage = async () => PREVIEW;
  const run = createStudioToolRunner(context);

  for (let call = 0; call < 4; call += 1) await run("run_blender_script", { script: "import bpy" });

  assert.equal(evidence[0].modelPreviewId, "a1b2c3d4-0");
  // Blender's (x, y, z) arrive in Studio as (x, z, y) in size: 7.14 deep, 2.75 up.
  assert.deepEqual(evidence[0].metadata, [
    { label: "Model", value: "cart.glb" },
    { label: "Size", value: "3.9 × 2.8 × 7.1 studs" },
    { label: "Triangles", value: "1,336" },
    { label: "Objects", value: "2" },
  ]);
  // The facts are the pictured model's, even without a 3D preview of it.
  assert.equal(evidence[1].modelPreviewId, undefined);
  assert.deepEqual(evidence[1].metadata?.map((entry) => entry.value), ["crate.glb", "2.0 × 2.0 × 2.0 studs", "12", "1"]);
  // An id that is not one the main process serves is dropped, not recorded,
  // but the model is still named: its picture is a version of cart.glb.
  assert.equal(evidence[2].modelPreviewId, undefined);
  assert.equal(evidence[2].metadata?.[0].value, "cart.glb");
  // With no word on which model the picture shows, nothing is attributed to one.
  assert.equal(evidence[3].modelPreviewId, undefined);
  assert.equal(evidence[3].metadata, undefined);
});

test("a screenshot taken while this run's own playtest runs says so, and only then", async () => {
  const screenshot = () => ({ ...ok({}), images: [{ data: "QUJD", mediaType: "image/png" as const }] });
  const { context, evidence } = contextWith([
    screenshot(),
    ok({ success: true }),
    screenshot(),
    ok({ success: true }),
    screenshot(),
    unavailable(),
    screenshot(),
  ]);
  const run = createStudioToolRunner(context);
  const view = (item: Omit<RunEvidence, "id">) => item.metadata?.find((entry) => entry.label === "View")?.value;

  await run("capture_screenshot", {});
  await run("solo_playtest", { action: "start", mode: "play" });
  await run("capture_screenshot", {});
  await run("solo_playtest", { action: "stop" });
  await run("capture_screenshot", {});
  await run("multiplayer_playtest", { action: "start", clients: 2 });
  await run("capture_screenshot", {});

  const screenshots = evidence.filter((item) => item.kind === "screenshot");
  assert.deepEqual(screenshots.map(view), [undefined, "Playtest", undefined, undefined]);
});

test("a failed observation does not manufacture passing evidence", async () => {
  const { context, evidence } = contextWith([{
    ...unavailable(), errorCode: "request_failed", message: "client disconnected",
  }]);
  const run = createStudioToolRunner(context);

  await run("get_runtime_logs", { target: "client-1" });

  assert.deepEqual(evidence, []);
});

test("successful atomic property writes are exposed as verified changes", async () => {
  const { context, changes, evidence } = contextWith([
    ok({ summary: { total: 2, succeeded: 2, failed: 0 } }),
  ]);
  const run = createStudioToolRunner(context);

  await run("set_properties", {
    instancePath: "game.Workspace.Part",
    properties: { Transparency: 0.5, Anchored: true },
  });

  assert.equal(changes[0].kind, "properties");
  assert.equal(evidence[0].kind, "verification");
  assert.equal(evidence[0].changeKind, "properties");
  assert.equal(evidence[0].passed, true);
  assert.equal(evidence[0].metadata?.[0]?.value, "Anchored, Transparency");
});

/**
 * The plugin refuses a write it cannot apply with an `error` field on an
 * ordinary response, so the transport calls it a success. Before this was
 * checked, a refused property write was recorded as a verified change.
 */
test("a property write the plugin refused records no change and reads as failed", async () => {
  const { context, changes, evidence } = contextWith([
    ok({ error: "Atomic set_properties failed for ClassName: read-only", summary: { total: 1, succeeded: 0, failed: 1 } }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("set_properties", { instancePath: "game.Workspace.Part", properties: { ClassName: "Folder" } });

  assert.equal(result.ok, false);
  assert.match(result.text, /read-only/);
  assert.deepEqual(changes, []);
  assert.deepEqual(evidence, []);
});

test("a build is one change to its root, verified by Studio's read-back", async () => {
  const { context, changes, evidence } = contextWith([
    ok({
      path: "game.Workspace.Island",
      createdRoot: true,
      created: 12,
      cloned: 30,
      updated: 0,
      removed: 2,
      undoable: true,
      descendants: 102,
      bounds: { min: [-60, 0, -60], max: [60, 24, 60], size: [120, 24, 120] },
    }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("build_instances", {
    path: "game.Workspace.Island",
    operations: [{ op: "create", className: "Part" }],
  });

  assert.equal(result.ok, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "instance");
  assert.equal(changes[0].target, "game.Workspace.Island");
  assert.equal(changes[0].summary, "Built in one undoable step: 12 created, 30 cloned, 2 removed.");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "verification");
  assert.equal(evidence[0].changeKind, "instance");
  assert.equal(evidence[0].title, "game.Workspace.Island");
  assert.equal(evidence[0].passed, true);
  assert.deepEqual(evidence[0].metadata, [
    { label: "Instances under the root", value: "102" },
    { label: "Bounds", value: "120 × 24 × 120 studs" },
    { label: "Undo", value: "One Studio undo step" },
  ]);
});

test("a refused build records nothing and tells the model which step failed", async () => {
  const { context, changes, evidence } = contextWith([
    ok({ error: "step 3 (create): cannot create NotAClass. Nothing was changed." }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("build_instances", {
    path: "game.Workspace.Island",
    operations: [{ op: "create", className: "NotAClass" }],
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /step 3 \(create\)/);
  assert.deepEqual(changes, []);
  assert.deepEqual(evidence, []);
});

test("a built animation is one change, verified by its preview and read-back", async () => {
  const { context, changes, evidence } = contextWith([
    ok({
      built: true,
      path: "game.ServerStorage.Animations.Run",
      replaced: true,
      undoable: true,
      animation: { name: "Run", duration: 0.6, keyframes: 5, loop: true },
      readBack: { keyframes: 5, poses: 35, matchesCompiled: true },
      playback: { verified: true, samples: 8, maxDegrees: 0.4, maxStuds: 0 },
      checks: {
        passed: true,
        waived: ["rootDrift"],
        results: [{ id: "groundContact", status: "pass", detail: "a foot is on the ground for 100% of the gait" }],
      },
    }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("animation", { action: "build", animation: { name: "Run" }, parent: "game.ServerStorage.Animations" });

  assert.equal(result.ok, true);
  assert.deepEqual(changes.map((change) => [change.kind, change.target, change.summary]), [
    ["instance", "game.ServerStorage.Animations.Run", "Rebuilt an animation in one undoable step: 5 keyframes, 0.6 s, looping."],
  ]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].passed, true);
  assert.deepEqual(evidence[0].metadata, [
    { label: "Motion checks", value: "Passed, with rootDrift waived" },
    { label: "Gait checks", value: "Checked as a gait" },
    { label: "Preview", value: "Within 0.4° of the checked model" },
    { label: "Read back", value: "Matches what was compiled" },
    { label: "Undo", value: "One Studio undo step" },
  ]);
});

test("an animation built from a baked file says so in its verification", async () => {
  const built = {
    built: true, path: "game.ServerStorage.Animations.Slither", undoable: true,
    animation: { name: "Slither", duration: 1, keyframes: 9, loop: true },
    readBack: { matchesCompiled: true }, playback: { verified: true }, checks: { passed: true },
  };
  const { context, evidence } = contextWith([ok(built), ok(built)]);
  const run = createStudioToolRunner(context);

  await run("animation", { action: "build", animation_file: "C:\\out\\slither.animation.json", parent: "game.ServerStorage.Animations" });
  await run("animation", { action: "build", animation: { name: "Slither" }, parent: "game.ServerStorage.Animations" });

  const describedBy = evidence.map((item) => item.metadata?.find((entry) => entry.label === "Described by")?.value);
  assert.deepEqual(describedBy, ["A file baked in Blender", undefined]);
});

test("publishing, wiring and verifying an animation each leave their own record", async () => {
  const { context, changes, evidence } = contextWith([
    ok({
      published: true, assetId: "555", animationId: "rbxassetid://555", displayName: "Run", moderation: "Approved",
      ownerCheck: "The animation belongs to user 42, who owns the place.", readBack: { matches: true },
    }),
    ok({
      wired: true, loader: "game.ServerScriptService.RoqerAnimate", installed: true, slot: "run",
      animationId: "rbxassetid://555", previousId: false, readBackMatches: true, undoable: true,
    }),
    ok({
      verified: true,
      played: { source: "published", verified: true, maxDegrees: 0.8 },
      wiring: { slot: "run", matches: true, playingNow: false },
    }),
  ]);
  const run = createStudioToolRunner(context);

  await run("animation", { action: "publish", path: "game.ServerStorage.Animations.Run" });
  await run("animation", { action: "wire", slot: "run", animation_id: "rbxassetid://555" });
  await run("animation", { action: "verify", animation: { name: "Run" }, animation_id: "rbxassetid://555", slot: "run" });

  assert.deepEqual(changes.map((change) => [change.kind, change.target, change.summary]), [
    ["asset", "rbxassetid://555", "Published “Run” to Roblox as animation 555. Moderation: Approved."],
    ["instance", "game.ServerScriptService.RoqerAnimate", "Installed the animation loader and set the run slot to rbxassetid://555, in one undoable step."],
  ]);
  assert.deepEqual(evidence.map((item) => [item.kind, item.title, item.passed]), [
    ["verification", "rbxassetid://555", true],
    ["verification", "game.ServerScriptService.RoqerAnimate", true],
    ["playtest", "Run on the playtest character", true],
  ]);
  assert.deepEqual(evidence[2].metadata, [
    { label: "Played from", value: "The published asset" },
    { label: "Largest difference", value: "0.8°" },
    { label: "run slot", value: "Wired" },
  ]);
});

test("wiring a model's state records the loader inside the model, and says every copy plays it", async () => {
  const { context, changes, evidence } = contextWith([
    ok({
      wired: true, model: "game.Workspace.Guard", loader: "game.Workspace.Guard.RoqerModelAnimate", installed: true, slot: "walk",
      animationId: "rbxassetid://555", previousId: false, groundSpeed: 2.2, readBackMatches: true, undoable: true,
    }),
    ok({
      wired: true, model: "game.Workspace.Guard", loader: "game.Workspace.Guard.RoqerModelAnimate", installed: false, slot: "idle",
      animationId: "rbxassetid://556", previousId: "rbxassetid://550", readBackMatches: false, undoable: true,
    }),
  ]);
  const run = createStudioToolRunner(context);

  await run("animation", { action: "wire", model: "game.Workspace.Guard", slot: "walk", animation_id: "rbxassetid://555", ground_speed: 2.2 });
  await run("animation", { action: "wire", model: "game.Workspace.Guard", slot: "idle", animation_id: "rbxassetid://556", expected_id: "rbxassetid://550" });

  assert.deepEqual(changes.map((change) => [change.target, change.summary]), [
    ["game.Workspace.Guard.RoqerModelAnimate", "Installed the animation loader in game.Workspace.Guard and set its walk to rbxassetid://555 (paced for 2.2 studs a second), in one undoable step."],
    ["game.Workspace.Guard.RoqerModelAnimate", "Set game.Workspace.Guard's idle to rbxassetid://556, replacing rbxassetid://550, in one undoable step."],
  ]);
  assert.deepEqual(evidence.map((item) => [item.title, item.passed, item.detail]), [
    ["game.Workspace.Guard.RoqerModelAnimate", true, "Studio read the loader back: its code is the fixed loader, and its walk holds the new ID. Every copy of the model plays it."],
    ["game.Workspace.Guard.RoqerModelAnimate", false, "Studio read the loader back, and it does not hold what was wired: its code, or the idle's ID, differs."],
  ]);
});

test("rigging an NPC records the model it made, and what Studio read back", async () => {
  const made = {
    rigged: true, model: "game.Workspace.Guard", rigType: "R15", parts: 16, joints: 15, height: 5.23, feet: [4, 0, -2], walkSpeed: 16,
    loader: "game.Workspace.Guard.RoqerModelAnimate", states: { idle: "rbxassetid://1", walk: "rbxassetid://2", run: "rbxassetid://3" },
    animateRemoved: true, readBackMatches: true, undoable: true,
  };
  const { context, changes, evidence } = contextWith([
    ok(made),
    ok({ ...made, model: "game.Workspace.Guard2", states: { idle: "rbxassetid://1" }, missingStates: ["walk", "run"], readBackMatches: false }),
    ok({ ...made, model: "game.Workspace.Guard3", readBackMatches: false, mismatches: ["its feet stand at [4, -0.19, -2], 0.19 studs from where they were asked"] }),
  ]);
  const run = createStudioToolRunner(context);

  await run("animation", { action: "rig", model: "game.Workspace.Guard", stock: "R15", position: [4, 0, -2] });
  await run("animation", { action: "rig", model: "game.Workspace.Guard2", stock: "R15", position: [4, 0, -2] });
  await run("animation", { action: "rig", model: "game.Workspace.Guard3", stock: "R15", position: [4, 0, -2] });

  assert.deepEqual(changes.map((change) => [change.kind, change.target]), [
    ["instance", "game.Workspace.Guard"],
    ["instance", "game.Workspace.Guard2"],
    ["instance", "game.Workspace.Guard3"],
  ]);
  assert.equal(
    changes[0].summary,
    "Made a stock R15 NPC at game.Workspace.Guard, its feet at [4, 0, -2], with the animation loader in place of its Animate script, in one undoable step.",
  );
  assert.deepEqual(evidence.map((item) => [item.kind, item.title, item.passed, item.detail]), [
    ["verification", "game.Workspace.Guard", true, "Studio read the NPC back: an R15 body of 16 parts and 15 joints, 5.23 studs tall, its feet at [4, 0, -2], whose loader plays Roblox's default idle, walk and run."],
    ["verification", "game.Workspace.Guard2", false, "Studio read the NPC back, and it is not what was made: its rig, its place, its loader or the loader's states differ."],
    // Studio names what differs, and the card says it rather than guessing.
    ["verification", "game.Workspace.Guard3", false, "Studio read the NPC back, and it is not what was made: its feet stand at [4, -0.19, -2], 0.19 studs from where they were asked."],
  ]);
  assert.deepEqual(evidence[0].metadata, [
    { label: "Undo", value: "One Studio undo step" },
    { label: "WalkSpeed", value: "16 studs a second" },
  ]);
  assert.deepEqual(evidence[1].metadata?.at(-1), { label: "No default", value: "walk and run" });
});

test("verifying a model records what its loader played while it moved and stood, and why it failed", async () => {
  const movement = (extra: Record<string, unknown>) => ({
    verified: true, mode: "walked", reached: true,
    moving: { samples: 25, averageSpeed: 4.4, played: { walk: 25 } },
    standing: { samples: 10, played: { idle: 9, walk: 1 } },
    pace: { state: "walk", groundSpeed: 2.2, averageSpeed: 4.4, needed: 2, played: 2, kept: true },
    ...extra,
  });
  const { context, evidence } = contextWith([
    ok({ verified: true, model: "game.Workspace.Guard", loader: {}, movement: movement({}) }),
    ok({
      verified: false, model: "game.Workspace.Guard", loader: {},
      movement: movement({ verified: false, standing: { samples: 10, played: { nothing: 10 } }, reason: "it moved at 16 studs a second, but its walk is written for 2.2" }),
    }),
  ]);
  const run = createStudioToolRunner(context);

  await run("animation", { action: "verify", model: "game.Workspace.Guard", position: [10, 0, 0] });
  await run("animation", { action: "verify", model: "game.Workspace.Guard", position: [10, 0, 0] });

  assert.deepEqual(evidence.map((item) => [item.kind, item.title, item.passed, item.detail]), [
    ["playtest", "game.Workspace.Guard in the playtest", true, "On the playtest server, its loader played its walk while it moved, and its idle while it stood."],
    ["playtest", "game.Workspace.Guard in the playtest", false, "Not verified: it moved at 16 studs a second, but its walk is written for 2.2."],
  ]);
  assert.deepEqual(evidence[0].metadata, [
    { label: "Moved by", value: "verify, walking it to a position" },
    { label: "While moving", value: "walk 100%" },
    { label: "While standing", value: "idle 90%, walk 10%" },
    { label: "Pace", value: "walk at 2× for 4.4 studs a second; written for 2.2" },
  ]);
});

test("verifying a model's wiring alone says so, and with the animation says it played", async () => {
  const wiring = { slot: "idle", animationId: "rbxassetid://701", matches: true };
  const played = { source: "published", verified: true };
  const { context, evidence } = contextWith([
    ok({ verified: true, model: "game.Workspace.Snake", loader: {}, wiring }),
    ok({ verified: true, model: "game.Workspace.Snake", loader: {}, wiring, played }),
  ]);
  const run = createStudioToolRunner(context);

  await run("animation", { action: "verify", model: "game.Workspace.Snake", slot: "idle", animation_id: "rbxassetid://701" });
  await run("animation", {
    action: "verify", model: "game.Workspace.Snake", slot: "idle", animation_id: "rbxassetid://701", animation_file: "C:\\out\\Slither.animation.json",
  });

  assert.deepEqual(evidence.map((item) => item.detail), [
    "On the playtest server, its idle holds rbxassetid://701, though how it plays was not compared.",
    "On the playtest server, the animation played on it as checked, and its idle holds rbxassetid://701.",
  ]);
  assert.deepEqual(evidence[1].metadata, [
    { label: "Played from", value: "The published asset" },
    { label: "idle state", value: "Wired" },
  ]);
});

test("the Studio tool description fits what Claude Code passes on", () => {
  // Claude Code silently keeps only an MCP tool description's first 2,048
  // characters; everything past that never reached the model.
  assert.ok(studioToolDescription().length <= MAX_TOOL_DESCRIPTION_CHARS, `${studioToolDescription().length} characters`);
  assert.match(studioToolDescription(), /<roblox-studio-tool>/);
});

test("every tool Roqer grants fits what Claude Code passes on", async () => {
  const library = await openSkillLibrary(fileURLToPath(new URL("../agent/skills", import.meta.url)));
  const tools = [
    { name: "roblox_studio", description: studioToolDescription() },
    skillToolDefinition(library), iconToolDefinition(), taskToolDefinition(), questionToolDefinition(), blenderToolDefinition(),
  ];
  for (const tool of tools) {
    assert.ok(tool.description.length <= MAX_TOOL_DESCRIPTION_CHARS, `${tool.name}: ${tool.description.length} characters`);
  }
});

test("every provider's developer instructions carry the Studio tool guide", () => {
  const developer = runDeveloperInstructions("BASE", true);
  assert.ok(developer.startsWith("BASE"));
  assert.ok(developer.includes(`<roblox-studio-tool>\n${studioToolGuide()}\n</roblox-studio-tool>`));
  assert.match(runDeveloperInstructions("BASE", false), /<roblox-studio-tool>/);
});

test("an animation that was only checked, or refused, records nothing", async () => {
  const { context, changes, evidence } = contextWith([
    ok({ valid: true, checks: { passed: true } }),
    ok({ error: "A motion check failed (jointLimits); nothing was built." }),
  ]);
  const run = createStudioToolRunner(context);

  assert.equal((await run("animation", { action: "check", animation: { name: "Run" } })).ok, true);
  const refused = await run("animation", { action: "build", animation: { name: "Run" }, parent: "game.ServerStorage" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /nothing was built/);
  assert.deepEqual(changes, []);
  assert.deepEqual(evidence, []);
});

test("a call the server rejects over its arguments comes back with that operation's schema", () => {
  const text = studioToolResultText("solo_playtest", {
    ok: false,
    data: undefined,
    text: "",
    httpStatus: 200,
    errorCode: "tool_failed",
    message: "solo_playtest action=start requires mode=play|run",
    durationMs: 5,
  });

  assert.ok(text.includes("solo_playtest action=start requires mode=play|run"));
  assert.ok(text.includes("Schema for solo_playtest"));
  assert.ok(text.includes("- mode (optional, 'play'|'run')"));
});

test("a failure that no schema explains is left alone", () => {
  const unreachable = studioToolResultText("solo_playtest", {
    ok: false,
    data: undefined,
    text: "",
    httpStatus: 0,
    errorCode: "request_failed",
    message: "fetch failed",
    durationMs: 1,
  });
  const conflict = studioToolResultText("set_script_source", {
    ok: false,
    data: undefined,
    text: "",
    httpStatus: 200,
    errorCode: "source_revision_conflict",
    message: "The script changed in Studio since it was read",
    durationMs: 2,
  });

  assert.ok(!unreachable.includes("Schema for"));
  assert.ok(!conflict.includes("Schema for"));
});

/**
 * The model's copy used the card's compaction, which keeps ten entries of every
 * array: a search that found forty scripts read as ten and a footnote, and a
 * project tree lost everything past each folder's tenth child. The character
 * budget is what bounds the model's copy now.
 */
test("the model reads every array entry the budget has room for", () => {
  const results = Array.from({ length: 40 }, (_, index) => ({ path: `game.ServerScriptService.Script${index}` }));
  const text = studioToolResultText("grep_scripts", {
    ok: true, data: { results }, text: "", httpStatus: 200, durationMs: 1,
  });

  assert.ok(text.includes("Script39"));
  assert.doesNotMatch(text, /more\)/);
});

test("script source reaches the model as plain text after the JSON envelope", () => {
  const source = '1: local name = "Roqer"\n2: print(name)';
  const text = studioToolResultText("get_script_source", {
    ok: true,
    data: { source, sourceRevision: "sr1:2:abcd", startLine: 1 },
    text: "",
    httpStatus: 200,
    durationMs: 1,
  });

  const [header, body] = text.split("\n\nsource:\n");
  assert.equal(body, source, "no escaped quotes or newlines");
  const envelope = JSON.parse(header) as { data: Record<string, unknown> };
  assert.equal(envelope.data.sourceRevision, "sr1:2:abcd");
  assert.equal(envelope.data.source, undefined, "the source is not sent twice");
});

test("a long script is cut to the model budget with a note", () => {
  const source = "x".repeat(40_000).replace(/x{100}/g, (run) => `${run}\n`);
  const text = studioToolResultText("get_script_source", {
    ok: true, data: { source, sourceRevision: "r" }, text: "", httpStatus: 200, durationMs: 1,
  });

  assert.ok(text.length <= 24_000);
  assert.match(text, /more characters\)$/);
});

/**
 * Logs arrive oldest first with the read cursor after them. Cut from the end,
 * an over-budget read kept the start of the buffer and lost both the error the
 * model was looking for and the `nextSince` it needed to read on from there.
 */
test("a log read too large for the budget keeps its newest entries and its cursor", () => {
  const entries = Array.from({ length: 2_000 }, (_, index) => ({
    seq: index + 1, ts: 1_000 + index, level: "OUT", message: `line ${index + 1} ${"x".repeat(40)}`, capturedBy: "server",
  }));
  const text = studioToolResultText("get_runtime_logs", ok({
    entries, totalDropped: 0, perCaptureNextSince: { server: 2_000 }, originPeerReliable: false,
  }));

  assert.ok(text.length <= 24_000);
  const envelope = JSON.parse(text) as { truncated: string; data: { entries: Array<{ seq: number }>; perCaptureNextSince: unknown } };
  const kept = envelope.data.entries;
  assert.equal(kept.at(-1)?.seq, 2_000, "the most recent line survives");
  assert.equal(kept[0].seq, 2_000 - kept.length + 1, "what survives is one contiguous newest window");
  assert.ok(kept.length > 100, "the budget is used, not left empty");
  assert.deepEqual(envelope.data.perCaptureNextSince, { server: 2_000 });
  assert.match(envelope.truncated, new RegExp(`newest ${kept.length} of 2000 entries; ${2_000 - kept.length} older entries were left out`));
  assert.match(envelope.truncated, /tail, filter, or since/);
  assert.ok(text.indexOf("\"truncated\"") < text.indexOf("\"data\""), "the model reads the cut before the data");
});

test("a search too large for the budget keeps its first results and every other field", () => {
  const results = Array.from({ length: 1_000 }, (_, index) => ({
    name: `Part${index}`, className: "Part", path: `game.Workspace.Model.Part${index}`,
  }));
  const text = studioToolResultText("search_objects", ok({ results, query: "Part", searchType: "name", count: 1_000 }));

  assert.ok(text.length <= 24_000);
  const envelope = JSON.parse(text) as { truncated: string; data: { results: Array<{ name: string }>; count: number } };
  assert.equal(envelope.data.results[0].name, "Part0");
  assert.equal(envelope.data.count, 1_000);
  assert.match(envelope.truncated, /data\.results shows the first \d+ of 1000 entries/);
  assert.match(envelope.truncated, /more specific query/);
});

/**
 * A tree whose later subtrees are each larger than the budget used to come back
 * as the small entries ahead of them and a count, with nothing to say what the
 * rest were called: a place's Workspace read as its Camera, Terrain, and spawn,
 * and the model could not ask for the map it never learned existed.
 */
test("a tree trimmed around oversized subtrees names every entry it left out", () => {
  const leaf = (path: string) => ({ name: path.split(".").at(-1), className: "Part", path, instanceRef: "ir:0:1" });
  const big = (name: string) => ({
    name,
    className: "Folder",
    path: `game.Workspace.${name}`,
    children: Array.from({ length: 400 }, (_, index) => leaf(`game.Workspace.${name}.Part${index}`)),
  });
  const tree = {
    name: "Workspace",
    className: "Workspace",
    path: "game.Workspace",
    children: [leaf("game.Workspace.Camera"), leaf("game.Workspace.Terrain"), big("Map"), big("NPCs"), big("Coins")],
    requestedPath: "game.Workspace",
    maxDepth: 3,
  };
  const text = studioToolResultText("get_project_structure", ok(tree));

  assert.ok(text.length <= 24_000);
  const envelope = JSON.parse(text) as { truncated: string; data: { children: Array<{ name: string }>; requestedPath: string } };
  assert.deepEqual(envelope.data.children.map((child) => child.name), ["Camera", "Terrain"]);
  assert.equal(envelope.data.requestedPath, "game.Workspace");
  assert.match(
    envelope.truncated,
    /first 2 of 5 entries; 3 entries were left out to fit the result budget: game\.Workspace\.Map, game\.Workspace\.NPCs, game\.Workspace\.Coins\. Pass one of their paths/,
  );
});

test("a trim that leaves out many entries counts them rather than listing a few", () => {
  const results = Array.from({ length: 1_000 }, (_, index) => ({
    name: `Part${index}`, className: "Part", path: `game.Workspace.Model.Part${index}`,
  }));
  const text = studioToolResultText("search_objects", ok({ results, count: 1_000 }));

  const envelope = JSON.parse(text) as { truncated: string };
  assert.match(envelope.truncated, /entries were left out to fit the result budget\. Use a more specific query/);
  assert.doesNotMatch(envelope.truncated, /Part999/);
});

test("a trim names left-out entries only when every one of them can be named", () => {
  const entries = [
    { name: "Small", path: "game.Workspace.Small" },
    { path: "game.Workspace.Big", blob: "x ".repeat(15_000) },
    { blob: "y ".repeat(15_000) },
  ];
  const text = studioToolResultText("get_project_structure", ok({ children: entries }));

  const envelope = JSON.parse(text) as { truncated: string; data: { children: unknown[] } };
  assert.equal(envelope.data.children.length, 1);
  assert.match(envelope.truncated, /2 entries were left out to fit the result budget\. Pass one of their paths/);
});

test("a result with no array to shorten is still cut to the budget", () => {
  const text = studioToolResultText("get_instance_properties", ok({ properties: { Text: "a long label ".repeat(3_000) } }));

  assert.ok(text.length <= 24_000);
  assert.match(text, /more characters\)$/);
});

test("a rejected action is a readable provider result rather than a thrown planner failure", async () => {
  const rejection: McpToolOutcome = {
    ok: false,
    data: {
      success: false,
      errorCode: "approval_rejected",
      policyReason: "mutation-requires-approval",
    },
    text: "",
    httpStatus: 0,
    errorCode: "approval_rejected",
    message: "The user rejected this proposed action. Choose a different approach.",
    durationMs: 0,
  };
  const { context } = contextWith([rejection]);
  const run = createStudioToolRunner(context);

  const result = await run("set_properties", {
    instancePath: "game.Workspace.Part",
    properties: { Anchored: true },
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /approval_rejected/);
  assert.match(result.text, /Choose a different approach/);
  assert.doesNotMatch(result.text, /Schema for/);
});

/**
 * The failure this catches: a run that built a whole tool inside one
 * `execute_luau` call, so the user saw an Activity row, no diff, and a change
 * nothing had read back. Telling the agent afterwards is too late — the work is
 * done and it moves on — so the call does not run at all.
 */
test("Luau that assigns a script's Source is refused before it reaches Studio", async () => {
  const { context, changes, calls } = contextWith([ok({ success: true, output: [] })]);
  const run = createStudioToolRunner(context);

  const result = await run("execute_luau", {
    code: 'local made = Instance.new("Script")\nmade.Source = "print(1)"\nmade.Parent = game.ServerScriptService',
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "nothing reached Studio, so there is no partial state to undo");
  assert.equal(changes.length, 0);
  assert.match(result.text, /set_script_source/);
  assert.match(result.text, /Split it/);
});

test("the same refusal covers Luau run inside a live playtest", async () => {
  const { context, calls } = contextWith([ok({ success: true, output: [] })]);
  const run = createStudioToolRunner(context);

  const result = await run("eval_server_runtime", { code: 'game.ServerScriptService.Main.Source = "print(1)"' });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("the refusal covers the code that starts an effect for capturing, too", async () => {
  const { context, calls } = contextWith([ok({})]);
  const result = await createStudioToolRunner(context)("capture_moments", { code: 'script.Parent.Main.Source = "x"', times: [0.1] });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("moments captured in one call are visual evidence, and the model receives every frame", async () => {
  const captured = {
    ...ok({ moments: [] }),
    text: "Captured 2 of 2 moments, held still for each capture.",
    images: [{ data: "Rmlyc3Q=", mediaType: "image/jpeg" as const }, { data: "U2Vjb25k", mediaType: "image/jpeg" as const }],
  };
  const { context, evidence } = contextWith([captured]);
  context.previewImage = async () => PREVIEW;
  const result = await createStudioToolRunner(context)("capture_moments", { code: "_G.vfx = start()", times: [0.1, 0.3] });

  assert.equal(result.images?.length, 2);
  assert.equal(evidence[0].kind, "screenshot");
  assert.equal(evidence[0].requirement, "visual");
  assert.equal(evidence[0].imageDataUrl, PREVIEW);
  assert.deepEqual(evidence[0].metadata?.map((entry) => entry.label), ["Images returned", "Moments"]);
  assert.equal(evidence[0].metadata?.[1]?.value, "0.1 s, 0.3 s");
});

test("arbitrary Luau that only creates instances is left alone", async () => {
  const { context } = contextWith([ok({ success: true, output: [] })]);
  const run = createStudioToolRunner(context);

  const result = await run("execute_luau", {
    code: 'local tool = Instance.new("Tool")\ntool.Parent = game.StarterPack\nreturn tool.Source ~= nil',
  });

  assert.doesNotMatch(result.text, /set_script_source/);
});

test("the tool guide spells out the arguments of the operations a run leans on", () => {
  const description = studioToolGuide();

  // A recorded forest run started a playtest without mode in two runs, because
  // the signature showed mode as optional, before the error revealed the rule.
  assert.ok(description.includes(
    "solo_playtest {action: 'start'|'stop'|'status', mode?: 'play'|'run', timeout?: number} (action='start' requires mode)",
  ));
  assert.ok(description.includes("get_script_source {instancePath: string,"));
  // A UI task cannot be done without these, so their arguments are spelled out
  // rather than left to a failed call to reveal.
  assert.ok(description.includes("inspect_ui {mode?: 'inspect'"));
  assert.ok(description.includes("interact_ui {action: 'click'"));
  assert.ok(description.includes("upload_asset {action?: 'upload'|'status'"));
  assert.ok(description.includes("action='upload' requires filePath, assetType, displayName"));
  assert.ok(description.includes("Roqer automatically reads back every successful script mutation"));
  // The generated schema can only say `operations: object[]`, so the step
  // shape has to travel in the description or a build starts with a guess.
  assert.ok(description.includes("build_instances {path: string, operations: object[]"));
  assert.ok(description.includes("{op: 'create'|'clone'|'set'|'remove'"));
  assert.ok(description.includes("Color3 is [r, g, b] from 0 to 1"));
  // A recorded run's mist emitters were refused for a CFrame no step said how
  // to write. Sequences need no line: their natural forms convert, and a
  // refusal names the keypoint form.
  assert.ok(description.includes("A CFrame is {position, rotation?} in those forms."));
  // Every recorded world run aimed its screenshots through execute_luau, one
  // approval each outside Full auto, because framing was not described here.
  assert.match(description, /selection \{action: 'get'\|'set'\|'open'\|'view'/);
  assert.ok(description.includes("Do not move the camera with execute_luau."));
  // A live map run spent a call on angleY 90, which the tool refuses.
  assert.ok(description.includes("angleY: elevation, -89 to 89"));
  // A recorded forest run framed a campfire with a padding the tool refuses.
  assert.ok(description.includes("padding: distance scale, above 0, at most 10"));
  // Required for interface work, whether or not the model loads the UI skill.
  assert.ok(description.includes("call inspect_ui {mode: 'audit'} on the client"));
  // The rest of the catalog is reachable without being spelled out here.
  assert.ok(description.includes("Other operations in the enum are called the same way."));
});

/**
 * The reported cost: a long script was read again before every write and again
 * after it, because Studio shortens an unqualified read to its first 300 lines
 * and a shortened read can never be the whole file the next write is waiting
 * for. Roqer's own reads ask for `1-`, which the plugin does not shorten, so the
 * file is fetched once and the write after it needs no fetch at all.
 */
test("a long script is widened once, not before every write", async () => {
  const target = "game.ServerScriptService.Main";
  const whole = Array.from({ length: 900 }, (_, index) => `line ${index + 1}`).join("\n");
  const afterFirst = whole.replace("line 700", "line seven hundred");
  const afterSecond = afterFirst.replace("line 800", "line eight hundred");
  const full = (source: string, revision: string) =>
    ok({ source, startLine: 1, endLine: 900, lineCount: 900, sourceRevision: revision });
  const { context, changes, calls } = contextWith([
    ok({
      source: whole.split("\n").slice(0, 300).join("\n"),
      startLine: 1,
      endLine: 300,
      lineCount: 900,
      truncated: true,
      sourceRevision: "r1",
    }),
    full(whole, "r1"),
    ok({ sourceRevision: "r2" }),
    full(afterFirst, "r2"),
    ok({ sourceRevision: "r3" }),
    full(afterSecond, "r3"),
  ]);
  const run = createStudioToolRunner(context);

  await run("get_script_source", { instancePath: target });
  await run("edit_script_lines", {
    instancePath: target, old_string: "line 700", new_string: "line seven hundred", line_range: "700",
  });
  await run("edit_script_lines", {
    instancePath: target, old_string: "line 800", new_string: "line eight hundred", line_range: "800",
  });

  assert.deepEqual(calls.map(({ tool }) => tool), [
    "get_script_source",
    // The model's own read came back shortened, so this one widens it.
    "get_script_source",
    "edit_script_lines",
    "get_script_source",
    // No widening read here: the read-back after the first write was whole.
    "edit_script_lines",
    "get_script_source",
  ]);
  assert.equal(calls[1].args.line_range, "1-");
  assert.match(String(changes[1].diff), /-line 800\n\+line eight hundred/);
});

/**
 * The bridge reports the range a read returned but not that a range was asked
 * for, so completeness has to be decided from the range itself. Reading it the
 * other way made the first fifty lines of a five-hundred-line file look like the
 * whole thing, and a later full-source write diff against it would have reported
 * the remaining four hundred and fifty as deleted.
 */
test("a range that stops short of the end is not mistaken for the whole script", async () => {
  const target = "game.ServerScriptService.Main";
  const head = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
  const { context, changes } = contextWith([
    ok({ source: head, startLine: 1, endLine: 50, lineCount: 500, sourceRevision: "r1" }),
    unavailable(),
    ok({ sourceRevision: "r2" }),
    unavailable(),
  ]);
  const run = createStudioToolRunner(context);

  await run("get_script_source", { instancePath: target, line_range: "1-50" });
  await run("set_script_source", {
    instancePath: target, source: `${head}\nline 51`, expectedRevision: "r1",
  });

  assert.equal(changes[0].diff, undefined);
  assert.equal(typeof changes[0].code, "string");
});

test("a mutation whose result is unknown drops the read rather than replaying it", async () => {
  const { context, changes } = contextWith([
    ok({ source: "alpha\nbravo\ncharlie", sourceRevision: "r1" }),
    ok({ sourceRevision: "r2" }),
    unavailable(),
    unavailable(),
    ok({ sourceRevision: "r3" }),
    unavailable(),
  ]);
  const run = createStudioToolRunner(context);
  const target = "game.ServerScriptService.Main";

  await run("get_script_source", { instancePath: target });
  await run("delete_script_lines", { instancePath: target, line_range: "2" });
  await run("delete_script_lines", { instancePath: target, line_range: "2" });

  assert.equal(changes[0].diff, " alpha\n-bravo\n charlie");
  // Only Studio knows what the first delete left behind, so the second change
  // falls back to its summary instead of diffing against a source that is gone.
  assert.equal(changes[1].diff, undefined);
  assert.equal(changes[1].code, undefined);
});

test("an inspect_ui audit is a pass/fail check that says which changes it saw", async () => {
  const withIssues = ok({ audit: { success: true, issues: [
    { code: "text_obscured", path: "PlayerGui.Shop.Card.Title" },
    { code: "content_beyond_scroll", path: "PlayerGui.Shop.Scroll.Row" },
  ], summary: { total: 2 } } });
  const clean = ok({ audit: { success: true, issues: [], summary: { total: 0 } } });
  const { context, evidence } = contextWith([withIssues, clean, ok({ nodes: [] })]);
  let changes: Array<{ id: string }> = [];
  context.changes = () => changes as never;
  const run = createStudioToolRunner(context);

  changes = [{ id: "change-1" }];
  await run("inspect_ui", { mode: "audit", target: "client-1" });
  changes = [{ id: "change-1" }, { id: "change-2" }];
  await run("inspect_ui", { mode: "audit", target: "client-1" });
  await run("inspect_ui", { target: "client-1" });

  assert.deepEqual(evidence.map((item) => [item.title, item.passed]), [
    ["Interface audit", false],
    ["Interface audit", true],
    ["Interface (client-1)", true],
  ]);
  assert.deepEqual(evidence[0].lines, ["text_obscured: PlayerGui.Shop.Card.Title", "content_beyond_scroll: PlayerGui.Shop.Scroll.Row"]);
  assert.deepEqual(evidence[0].metadata, [
    { label: "Problems", value: "2" }, { label: "Latest change before audit", value: "change-1" },
  ]);
  assert.equal(evidence[1].metadata?.[1]?.value, "change-2");
});

test("a preview that drew MeshParts as their boxes says which and why, so a box is never taken for the model", async () => {
  const sheet = (boxes?: string) => ({
    ...ok({
      valid: true,
      animation: { name: "OctopusIdle", rig: "game.Workspace.Octopus", duration: 1.6, keyframes: 4, loop: true },
      checks: { passed: true },
      sheet: { times: [0, 0.8, 1.6], ...(boxes === undefined ? {} : { boxes }) },
    }),
    images: [{ data: "QUJD", mediaType: "image/png" as const }],
  });
  const range = {
    ...ok({
      rigged: true, model: "game.Workspace.Octopus", controller: "AnimationController", rig: { joints: [{}, {}] },
      readBack: { matches: true },
      rangeSheet: { times: [0, 1], boxes: "MeshParts drawn as their boxes: Octopus (its mesh has not been read from Studio)" },
    }),
    images: [{ data: "QUJD", mediaType: "image/png" as const }],
  };
  const long = `MeshParts drawn as their boxes: ${"Tentacle (it has 30000 triangles; a preview draws a mesh of at most 20000), ".repeat(8)}`;
  const { context, evidence } = contextWith([
    sheet("MeshParts drawn as their boxes: Octopus (it has 30000 triangles; a preview draws a mesh of at most 20000)"),
    sheet(),
    range,
    sheet(long),
  ]);
  context.previewImage = async () => PREVIEW;
  const run = createStudioToolRunner(context);

  await run("animation", { action: "check", animation: { name: "OctopusIdle" } });
  await run("animation", { action: "check", animation: { name: "OctopusIdle" } });
  await run("animation", { action: "rig", model: "game.Workspace.Octopus", controller: "AnimationController" });
  await run("animation", { action: "check", animation: { name: "OctopusIdle" } });

  const previews = evidence.filter((item) => item.imageDataUrl !== undefined);
  assert.equal(previews.length, 4);
  // Before the counts, so a journal clipped to five entries keeps it.
  assert.deepEqual(previews[0].metadata?.slice(0, 3), [
    { label: ANIMATION_NAME_LABEL, value: "OctopusIdle" },
    { label: ANIMATION_RIG_LABEL, value: "game.Workspace.Octopus" },
    { label: ANIMATION_BOXES_LABEL, value: "Octopus (it has 30000 triangles; a preview draws a mesh of at most 20000)" },
  ]);
  assert.equal(previews[1].metadata?.some((entry) => entry.label === ANIMATION_BOXES_LABEL), false, "every part drawn as itself");
  assert.equal(previews[2].title, RIG_RANGE_SHEET_TITLE);
  assert.equal(previews[2].metadata?.find((entry) => entry.label === ANIMATION_BOXES_LABEL)?.value, "Octopus (its mesh has not been read from Studio)");
  const bounded = previews[3].metadata?.find((entry) => entry.label === ANIMATION_BOXES_LABEL)?.value ?? "";
  assert.equal(bounded.length, 400);
  assert.ok(bounded.endsWith("…"));
});

test("a malformed envelope is refused saying what arrived wrong", () => {
  const refusal = (value: unknown) => {
    try {
      parseStudioToolInput(value);
    } catch (error) {
      assert.ok(error instanceof MalformedToolCallError);
      return error.message;
    }
    assert.fail("the envelope was accepted");
  };

  assert.match(refusal({ operation: "insert_asset", assetId: 1, parent: "game.Workspace" }),
    /arguments is missing, and assetId, parent arrived beside operation; move them inside arguments/);
  assert.match(refusal({ operation: "get_place_info" }), /arguments is missing; send arguments: \{\} when get_place_info needs none/);
  assert.match(refusal({ arguments: {} }), /operation is missing/);
  assert.match(refusal({ operation: "get_place_info", arguments: [1] }), /arguments arrived as an array/);
  assert.match(refusal({ operation: "get_place_info", arguments: "{\"path\": " }), /arguments arrived as text that is not valid JSON \(/);
  assert.match(refusal({ operation: "no_such_operation", arguments: {} }), /Unknown Roblox Studio operation: no_such_operation/);
  for (const message of [refusal("text"), refusal({ operation: "get_place_info" })]) {
    assert.match(message, /^roblox_studio requires an operation and argument object\./);
  }
});

test("arguments written as JSON text with raw line breaks in a string are read as the object meant", () => {
  // Quotes and a trailing backslash inside the Luau keep the string tracking honest.
  const code = "local part = Instance.new(\"Part\")\n\tpart.Name = \"C:\\\\\"\r\nprint(part)";
  const raw = JSON.stringify({ code }).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  assert.ok(raw.includes("\n") && raw.includes("\t"), "the text carries raw control characters");
  assert.throws(() => JSON.parse(raw));

  const parsed = parseStudioToolInput({ operation: "execute_luau", arguments: raw });

  assert.equal(parsed.args.code, code);
});

const EMPTY_REVISION = "sr1:0:0000150500000000";
const EMIT = "roblox-animation-vfx/templates/vfx/emit.lua";

/** A skill pack holding one template, written with CRLF as a Windows checkout has it. */
function templateLibrary(content = "-- ROQER_VFX_EMIT test\r\nlocal VFX = {}\r\nreturn VFX\r\n") {
  const loads: Array<{ name: string; resource?: string }> = [];
  return {
    loads,
    templates: {
      load: async (name: string, resource?: string) => {
        loads.push({ name, resource });
        if (name !== "roblox-animation-vfx" || resource !== "templates/vfx/emit.lua") throw new Error(`Skill resource not found: ${name}/${resource}`);
        return { name, resource, content };
      },
    },
  };
}

test("a template is written into a new script without the model reading, sending or retyping it", async () => {
  const target = "game.ReplicatedStorage.VFX.Emit";
  const written = "-- ROQER_VFX_EMIT test\nlocal VFX = {}\nreturn VFX\n";
  const { context, calls, changes } = contextWith([
    ok({ source: "1: ", revision: EMPTY_REVISION, lineCount: 1 }),
    ok({ success: true, revision: "sr1:44:after", previousRevision: EMPTY_REVISION }),
    ok({ source: "1: -- ROQER_VFX_EMIT test\n2: local VFX = {}\n3: return VFX\n4: ", revision: "sr1:44:after" }),
  ]);
  const { templates, loads } = templateLibrary();
  const run = createStudioToolRunner(context, { templates });

  const result = await run("set_script_source", { instancePath: target, template: EMIT });

  assert.equal(result.ok, true, result.text);
  assert.deepEqual(loads, [{ name: "roblox-animation-vfx", resource: "templates/vfx/emit.lua" }]);
  assert.deepEqual(calls, [
    { tool: "get_script_source", args: { instancePath: target, line_range: "1-" } },
    // The template's own text, in one newline convention, against the revision Roqer read.
    { tool: "set_script_source", args: { instancePath: target, source: written, expectedRevision: EMPTY_REVISION } },
    { tool: "get_script_source", args: { instancePath: target, line_range: "1-" } },
  ]);
  assert.equal(changes.length, 1);
  assert.match(String(changes[0].diff), /\+local VFX = \{\}/);
  assert.match(result.text, /verified revision sr1:44:after/);
  assert.match(result.text, /Roqer wrote roblox-animation-vfx\/templates\/vfx\/emit\.lua \(4 lines\)/);
  assert.doesNotMatch(result.text, /local VFX = \{\}/, "the template's text is not handed back to the model");
});

test("a script that already holds the template is left alone", async () => {
  const target = "game.ReplicatedStorage.VFX.Emit";
  const { context, calls, changes } = contextWith([
    ok({ source: "1: -- ROQER_VFX_EMIT test\n2: local VFX = {}\n3: return VFX\n4: ", revision: "sr1:44:same" }),
  ]);
  const run = createStudioToolRunner(context, { templates: templateLibrary().templates });

  const result = await run("set_script_source", { instancePath: target, template: EMIT });

  assert.equal(result.ok, true);
  assert.match(result.text, /already holds .* exactly, so nothing was written/);
  assert.deepEqual(calls.map((call) => call.tool), ["get_script_source"]);
  assert.deepEqual(changes, []);
});

test("an empty script is written without the model reading it for its revision", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, calls } = contextWith([
    ok({ source: "1: ", revision: EMPTY_REVISION }),
    ok({ success: true, revision: "sr1:5:r2" }),
    ok({ source: "1: print()", revision: "sr1:5:r2" }),
  ]);
  const run = createStudioToolRunner(context);

  const result = await run("set_script_source", { instancePath: target, source: "print()" });

  assert.equal(result.ok, true, result.text);
  assert.deepEqual(calls[1], { tool: "set_script_source", args: { instancePath: target, source: "print()", expectedRevision: EMPTY_REVISION } });
});

test("a script with anything in it still needs the revision the model read", async () => {
  const target = "game.ServerScriptService.Main";
  const { context, calls } = contextWith([ok({ source: "1: print(\"mine\")", revision: "sr1:13:theirs" })]);
  const run = createStudioToolRunner(context, { templates: templateLibrary().templates });

  const plain = await run("set_script_source", { instancePath: target, source: "print()" });
  const template = await run("set_script_source", { instancePath: target, template: EMIT, expectedRevision: "" });

  assert.equal(plain.ok, false);
  assert.match(plain.text, /is not empty, so expectedRevision is required: read it with get_script_source and pass that revision/);
  assert.equal(template.ok, false);
  assert.match(template.text, /line_range "1" is enough/);
  assert.deepEqual(calls.map((call) => call.tool), ["get_script_source", "get_script_source"], "nothing was written");
});

test("a script Roqer cannot read is not written on a revision it never saw", async () => {
  const { context, calls } = contextWith([unavailable()]);
  const run = createStudioToolRunner(context);

  const result = await run("set_script_source", { instancePath: "game.ServerScriptService.Main", source: "print()" });

  assert.equal(result.ok, false);
  assert.match(result.text, /could not read game\.ServerScriptService\.Main to check that it is empty/);
  assert.deepEqual(calls.map((call) => call.tool), ["get_script_source"]);
});

test("a template write that cannot be resolved is refused before anything reaches Studio", async () => {
  const target = "game.ReplicatedStorage.VFX.Emit";
  const { context, calls } = contextWith([]);
  const withTemplates = createStudioToolRunner(context, { templates: templateLibrary().templates });
  const without = createStudioToolRunner(context);

  const refusals = [
    await withTemplates("set_script_source", { instancePath: target, template: EMIT, source: "print()" }),
    await withTemplates("set_script_source", { instancePath: target, template: "roblox-animation-vfx/references/vfx-craft.md" }),
    await withTemplates("set_script_source", { instancePath: target, template: "roblox-animation-vfx/templates/missing.lua" }),
    await withTemplates("set_script_source", { instancePath: target, template: 7 }),
    await withTemplates("set_script_source", { instancePath: target }),
    await without("set_script_source", { instancePath: target, template: EMIT }),
  ];

  assert.deepEqual(refusals.map((result) => result.ok), [false, false, false, false, false, false]);
  assert.match(refusals[0].text, /pass source or template, not both/);
  assert.match(refusals[1].text, /must name a Lua file in a skill's templates folder/);
  assert.match(refusals[2].text, /could not be read: Skill resource not found/);
  assert.match(refusals[3].text, /template must be a skill template path/);
  assert.match(refusals[4].text, /source is required/);
  assert.match(refusals[5].text, /templates are not available in this run/);
  assert.deepEqual(calls, []);
});

test("the guide and the schema both offer the template and the empty-script write", () => {
  assert.match(studioToolGuide(), /set_script_source \{instancePath: string, instanceRef\?: string, source\?: string, template\?: string, expectedRevision\?: string\}/);
  assert.match(studioToolGuide(), /pass template \(its skill path/);
});

test("the shipped emit template can be written by the path the VFX reference gives", async () => {
  const library = await openSkillLibrary(fileURLToPath(new URL("../agent/skills", import.meta.url)));
  const reference = (await library.load("roblox-animation-vfx", "references/vfx-craft.md")).content;
  const named = reference.match(/template: "([^"]+)"/)?.[1];
  assert.equal(named, EMIT);
  const { context, calls } = contextWith([
    ok({ source: "1: ", revision: EMPTY_REVISION }),
    ok({ success: true, revision: "sr1:1:after" }),
    ok({ source: "1: x", revision: "sr1:1:after" }),
  ]);
  const run = createStudioToolRunner(context, { templates: library });

  const result = await run("set_script_source", { instancePath: "game.ReplicatedStorage.VFX.Emit", template: named });

  assert.equal(result.ok, true, result.text);
  const source = String(calls[1].args.source);
  assert.match(source, /^-- ROQER_VFX_EMIT/);
  assert.match(source, /\nreturn VFX\n?$/);
  assert.doesNotMatch(source, /\r/);
});
const startTimedOut = (): McpToolOutcome => ({
  ok: false,
  data: { success: false, action: "start", error: "start_failed", message: "Playtest did not become ready before timeout." },
  text: "",
  message: "Playtest did not become ready before timeout.",
  httpStatus: 200,
  durationMs: 60_000,
});

test("a timed-out playtest start comes back with Studio's status, and after two in a row no more starts are sent", async () => {
  const decisions: Array<{ question: string; answer: string }> = [];
  const { context, calls } = contextWith([
    startTimedOut(), ok({ success: true, action: "status", running: false, roles: ["edit"] }),
    startTimedOut(), ok({ success: true, action: "status", running: false, roles: ["edit"] }),
    ok({ success: true, action: "start", roles: ["edit", "server", "client-1"] }),
  ]);
  const run = createStudioToolRunner({ ...context, decisions: () => decisions });

  const first = await run("solo_playtest", { action: "start", mode: "play" });
  assert.equal(first.ok, false);
  assert.match(first.text, /status afterwards: it is not running \(peers: edit\)\. A start that timed out may be tried once more/);
  const second = await run("solo_playtest", { action: "start", mode: "play" });
  assert.match(second.text, /second start in a row that timed out, so Roqer will not send another\. Ask the user to press Play and then Stop/);
  const third = await run("solo_playtest", { action: "start", mode: "play" });
  assert.equal(third.ok, false);
  assert.match(third.text, /solo_playtest was not started: 2 starts in a row timed out/);
  assert.deepEqual(calls.map((call) => `${call.tool}:${String(call.args.action)}`), [
    "solo_playtest:start", "solo_playtest:status", "solo_playtest:start", "solo_playtest:status",
  ], "the third start never reached Studio");

  // An answer from the user is how they say it is cleared.
  decisions.push({ question: "Press Play and then Stop in Studio?", answer: "Done" });
  const fourth = await run("solo_playtest", { action: "start", mode: "play" });
  assert.equal(fourth.ok, true);
  assert.equal(calls.at(-1)?.args.action, "start");
});

test("a start that became ready late is reported as running, and a success clears the count", async () => {
  const { context, calls } = contextWith([
    startTimedOut(), ok({ success: true, action: "status", running: true, roles: ["edit", "server", "client-1"] }),
    ok({ success: true, action: "start" }),
    startTimedOut(), ok({ success: true, action: "status", running: false }),
  ]);
  const run = createStudioToolRunner(context);

  assert.match((await run("solo_playtest", { action: "start", mode: "play" })).text, /it is running now \(edit, server, client-1\), so use it rather than starting another/);
  assert.equal((await run("solo_playtest", { action: "start", mode: "play" })).ok, true);
  // One timeout since the last success is a first timeout again, not a second.
  assert.match((await run("solo_playtest", { action: "start", mode: "play" })).text, /may be tried once more/);
  assert.equal(calls.length, 5);
});

test("a start that failed for another reason is not counted as a timeout", async () => {
  const failed: McpToolOutcome = { ok: false, data: { success: false, message: "Playtest did not start." }, text: "", message: "Playtest did not start.", httpStatus: 200, durationMs: 5 };
  const { context, calls } = contextWith([failed, failed, failed]);
  const run = createStudioToolRunner(context);

  for (let attempt = 0; attempt < 3; attempt += 1) await run("solo_playtest", { action: "start", mode: "play" });

  assert.deepEqual(calls.map((call) => call.args.action), ["start", "start", "start"], "no status reads and no refusal");
});