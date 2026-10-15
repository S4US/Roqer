import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createOpenCodePlanner, type OpenCodePlannerOptions } from "./opencode-planner";
import type { PlannerContext } from "./run-engine";
import type { OpenCodeHome } from "./opencode-home";
import { FakeChildProcess } from "./test-child-process";
import type { RunUsage } from "../shared/run-events";
import { QUESTION_ESCAPE_OPTION } from "../shared/question";

async function callTool(home: OpenCodeHome, name: string, args: unknown): Promise<unknown> {
  const config = JSON.parse(await fs.readFile(home.configPath, "utf8"));
  const response = await fetch(config.mcp.roqer.url, {
    method: "POST", headers: { "content-type": "application/json", authorization: config.mcp.roqer.headers.Authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return response.json();
}

const base = {
  agent: { id: "test", version: "1", systemInstructions: "SYSTEM", developerInstructions: "DEVELOPER", skills: [] },
  skillLibrary: { catalog: [], load: async () => { throw new Error("No skills"); } },
  model: "opencode/test-free",
  getStatus: async () => ({ kind: "signed-in" as const, message: "Ready" }),
  getModels: async () => ({ models: [{ id: "opencode/test-free", displayName: "Test", defaultReasoningEffort: "none" as const, supportedReasoningEfforts: [{ reasoningEffort: "none" as const }] }], defaultModelId: "opencode/test-free" }),
};
function context(signal = new AbortController().signal): PlannerContext {
  return {
    signal, prompt: "Current request", conversation: { messages: [{ role: "user", text: "Remember blue" }], truncated: false }, images: [],
    instanceId: "studio-1", autoPlaytest: false, call: async () => ({ ok: true, text: "read", data: {}, httpStatus: 200, durationMs: 1 }),
    say: () => undefined, status: () => undefined, progress: () => undefined, outputTokens: () => undefined,
    contextUsage: () => undefined, runUsage: () => undefined, recordChange: () => undefined, recordEvidence: () => undefined,
    setTasks: () => undefined, tasks: () => [], changes: () => [], evidence: () => [], decisions: () => [], takeSteers: () => [],
    askUser: async (_question, options) => options[0], checkCompletion: () => ({ verified: true, issues: [] }),
  };
}
type Launch = NonNullable<OpenCodePlannerOptions["launch"]>;
function fake(script: (child: FakeChildProcess, prompt: string, home: OpenCodeHome, args: string[]) => void | Promise<void>): Launch {
  return async (args, home) => {
    const child = new FakeChildProcess();
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk.toString(); });
    child.stdin.on("finish", () => { void Promise.resolve(script(child, input, home, args)).catch((error) => child.emit("error", error)); });
    return child.asChild();
  };
}
const text = (value: string) => ({ type: "text", sessionID: "ses_test", part: { type: "text", text: value } });

test("OpenCode carries history and images, reads nested text, and removes its home", async () => {
  let directory = "";
  let said = "";
  const ctx = context();
  ctx.say = (value) => { said += value; };
  ctx.images = [{ mediaType: "image/png", data: Buffer.from("picture").toString("base64"), name: "reference" }];
  const launch = fake(async (child, prompt, home, args) => {
    directory = home.directory;
    const config = JSON.parse(await fs.readFile(home.configPath, "utf8"));
    assert.equal(config.permission["*"], "ask");
    assert.equal(config.agent.roqer.permission["*"], "ask");
    assert.match(prompt, /Remember blue/);
    assert.match(prompt, /Current request/);
    assert.match(prompt, /SYSTEM/);
    assert.ok(args.includes("--pure"));
    assert.ok(!args.includes("--auto"));
    assert.ok(!args.includes(prompt));
    const file = args[args.indexOf("--file") + 1];
    assert.equal(await fs.readFile(file, "utf8"), "picture");
    child.writeLine(text("Hello")); child.writeLine(text("Done")); child.finish();
  });
  assert.equal(await createOpenCodePlanner({ ...base, launch }).run(ctx), "Hello\n\nDone");
  assert.equal(said, "Hello\n\nDone");
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

for (const event of [{ type: "error", error: { data: { message: "Provider refused" } } }, { type: "tool_use", part: { tool: "bash" } }, { type: "text", part: { text: 1 } }, { type: "unknown" }]) {
  test(`OpenCode fails closed for ${JSON.stringify(event)}`, async () => {
    const launch = fake((child) => { child.writeLine(event); child.finish(0); });
    await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(context()));
  });
}
test("OpenCode does not invent success for an empty reply", async () => {
  await assert.rejects(createOpenCodePlanner({ ...base, launch: fake((child) => child.finish()) }).run(context()), /without a reply/);
});
test("OpenCode explains the free service refusal without weakening tool permissions", async () => {
  const launch = fake((child) => {
    child.writeLine({ type: "error", error: { data: { message: "OpenCode's free tier can only be used from within OpenCode." } } });
    child.finish();
  });
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(context()), /restricted tool permissions.*cannot be auto-approved.*free tier/);
});
test("OpenCode routes Studio through the host and fails when the host fails", async () => {
  let calls = 0;
  const ctx = context(); ctx.call = async () => { calls++; throw new Error("Host transport failed"); };
  const launch = fake(async (child, _prompt, home) => {
    await callTool(home, "roblox_studio", { operation: "get_script_source", arguments: { instancePath: "game.ServerScriptService.Main" } }).catch(() => undefined);
    child.writeLine(text("Done")); child.finish(0);
  });
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(ctx), /Host transport failed/);
  assert.equal(calls, 1);
});
test("OpenCode cleans up after a synchronous launch failure", async () => {
  let directory = "";
  const launch: Launch = async (_args, home) => { directory = home.directory; throw new Error("spawn EINVAL"); };
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(context()), /EINVAL/);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
test("OpenCode never launches a cancelled run", async () => {
  const controller = new AbortController(); controller.abort();
  let launched = false;
  await assert.rejects(createOpenCodePlanner({ ...base, launch: async () => { launched = true; throw new Error("launch"); } }).run(context(controller.signal)), /cancel/i);
  assert.equal(launched, false);
});
test("OpenCode kills a running process on cancellation and removes its home", async () => {
  const controller = new AbortController(); let running: FakeChildProcess | undefined; let directory = "";
  const launch = fake((child, _prompt, home) => { running = child; directory = home.directory; controller.abort(); });
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(context(controller.signal)), /cancel/i);
  assert.equal(running?.killed, true);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
test("OpenCode cancellation at process close cannot return a successful reply", async () => {
  const controller = new AbortController();
  const child = new FakeChildProcess();
  const launch: Launch = async () => {
    child.stdin.on("finish", () => {
      child.writeLine(text("Done"));
      child.once("close", () => controller.abort());
      child.finish();
    });
    return child.asChild();
  };
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(context(controller.signal)), /cancel/i);
});
test("OpenCode stops a silent process", async () => {
  await assert.rejects(createOpenCodePlanner({ ...base, stallMs: 20, launch: fake(() => undefined) }).run(context()), /stopped responding/);
});
test("OpenCode sends queued notes as a new user turn in the same session", async () => {
  let turns = 0; let pending: string[] = [];
  const ctx = context(); ctx.takeSteers = () => pending.splice(0);
  const launch = fake((child, prompt, _home, args) => {
    assert.ok(!args.includes("--auto"));
    turns++;
    if (turns === 1) { pending = ["Use green instead"]; child.writeLine(text("First")); }
    else { assert.match(prompt, /Use green instead/); assert.equal(args[args.indexOf("--session") + 1], "ses_test"); child.writeLine(text("Updated")); }
    child.finish();
  });
  assert.equal(await createOpenCodePlanner({ ...base, launch }).run(ctx), "First\n\nUpdated");
  assert.equal(turns, 2);
});

test("OpenCode refuses a model that is no longer in its free catalog", async () => {
  let launched = false;
  await assert.rejects(createOpenCodePlanner({ ...base, model: "opencode/paid", launch: async () => { launched = true; throw new Error("launch"); } }).run(context()), /free model/);
  assert.equal(launched, false);
});

test("OpenCode passes the selected variant on every turn and refuses unsupported effort", async () => {
  let turns = 0; let notes: string[] = [];
  const ctx = context(); ctx.takeSteers = () => notes.splice(0);
  const getModels = async () => ({ models: [{ id: base.model, displayName: "Test", defaultReasoningEffort: "medium" as const, supportedReasoningEfforts: [{ reasoningEffort: "medium" as const }, { reasoningEffort: "high" as const }] }], defaultModelId: base.model });
  const launch = fake((child, _prompt, _home, args) => {
    assert.equal(args[args.indexOf("--variant") + 1], "high");
    if (++turns === 1) notes = ["Continue"];
    child.writeLine(text("Done")); child.finish();
  });
  await createOpenCodePlanner({ ...base, getModels, effort: "high", launch }).run(ctx);
  assert.equal(turns, 2);
  await assert.rejects(createOpenCodePlanner({ ...base, effort: "high", launch }).run(context()), /reasoning effort/);
  assert.equal(turns, 2);
});

test("OpenCode context tracks the latest step, including caches, rather than cumulative usage", async () => {
  const readings: unknown[] = [];
  const ctx = context(); ctx.contextUsage = (used, limit) => readings.push([used, limit]);
  const launch = fake((child, _prompt, _home, args) => {
    assert.equal(args.includes("--variant"), false);
    child.writeLine(text("Done"));
    for (const [id, input] of [["one", 100], ["two", 20], ["two", 20]]) child.writeLine({ type: "step_finish", part: { id, reason: "stop", tokens: { input, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0 } });
    child.finish();
  });
  const getModels = async () => ({ ...await base.getModels(), models: [{ ...(await base.getModels()).models[0], contextWindow: 200000 }] });
  await createOpenCodePlanner({ ...base, getModels, launch }).run(ctx);
  assert.deepEqual(readings, [[110, 200000], [30, 200000]]);
  readings.length = 0;
  await createOpenCodePlanner({ ...base, launch }).run(ctx);
  assert.deepEqual(readings, [[110, null], [30, null]]);
});
test("OpenCode does not reuse an old reply when the note's turn is silent", async () => {
  let turns = 0; let notes: string[] = [];
  const ctx = context(); ctx.takeSteers = () => notes.splice(0);
  const launch = fake((child) => { if (++turns === 1) { notes = ["Change it"]; child.writeLine(text("First")); } child.finish(); });
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(ctx), /without a reply/);
});
test("OpenCode routes a real MCP question and sends the none-of-these note separately", async () => {
  let notes: string[] = []; let turns = 0;
  const ctx = context(); ctx.takeSteers = () => notes.splice(0);
  ctx.askUser = async () => { notes = ["My own choice"]; return QUESTION_ESCAPE_OPTION; };
  const launch = fake(async (child, prompt, home) => {
    if (++turns === 1) {
      const answer = JSON.stringify(await callTool(home, "ask_user", { question: "Which color?", options: ["Blue", "Green"] }));
      assert.match(answer, /queued as a user note/);
      assert.doesNotMatch(answer, /My own choice/);
      child.writeLine(text("Question asked"));
    } else { assert.match(prompt, /My own choice/); child.writeLine(text("Understood")); }
    child.finish();
  });
  await createOpenCodePlanner({ ...base, launch }).run(ctx);
  assert.equal(turns, 2);
});
test("OpenCode cancellation during an MCP question stops the process", async () => {
  let running: FakeChildProcess | undefined;
  const ctx = context();
  const controller = new AbortController(); ctx.signal = controller.signal;
  ctx.askUser = async () => { controller.abort(); throw new Error("Question cancelled"); };
  const launch = fake(async (child, _prompt, home) => {
    running = child;
    await callTool(home, "ask_user", { question: "Which?", options: ["One", "Two"] }).catch(() => undefined);
    child.finish();
  });
  await assert.rejects(createOpenCodePlanner({ ...base, launch }).run(ctx), /cancel/i);
  assert.equal(running?.killed, true);
});
test("OpenCode records reported usage once per step and rejects truncated replies", async () => {
  const usage: RunUsage[] = [];
  const ctx = context(); ctx.runUsage = (value) => usage.push(value);
  const event = { type: "step_finish", part: { id: "step-1", reason: "stop", tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0 } };
  const launch = fake((child) => { child.writeLine(text("Done")); child.writeLine(event); child.writeLine(event); child.finish(); });
  await createOpenCodePlanner({ ...base, launch }).run(ctx);
  assert.deepEqual(usage, [{ inputTokens: 10, outputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 1, costUsd: 0 }]);
  await assert.rejects(createOpenCodePlanner({ ...base, launch: fake((child) => { child.writeLine(text("Partial")); child.writeLine({ ...event, part: { ...event.part, reason: "length" } }); child.finish(); }) }).run(context()), /could not finish/);
});
