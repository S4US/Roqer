import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  antigravityResultUsage, antigravityToolPermitted, createAntigravityPlanner, isGateFailure, readAntigravityStep,
  type AntigravitySession,
} from "./antigravity-planner";
import {
  ANTIGRAVITY_MCP_SERVER_NAME, attachmentDirectory, conversationDirectory, schemaDirectory, type AntigravityHome,
} from "./antigravity-home";
import type { AgentDefinition } from "./agent-definition";
import type { McpToolOutcome } from "./mcp-types";
import type { PlannerContext } from "./run-engine";
import type { RunUsage } from "../shared/run-events";
import type { SkillLibrary } from "./skill-library";
import { FakeChildProcess } from "./test-child-process";
import { ProviderSessionStore } from "./provider-sessions";

const AGENT: AgentDefinition = {
  id: "test-agent",
  version: "1",
  systemInstructions: "SYSTEM TEST INSTRUCTIONS",
  developerInstructions: "DEVELOPER TEST INSTRUCTIONS",
  skills: [{ name: "roblox-test", description: "Use for tests." }],
};
const SKILLS: SkillLibrary = {
  catalog: AGENT.skills,
  load: async (name, resource = "SKILL.md") => ({ name, resource, content: "# Test skill" }),
};
const SIGNED_IN = async () => ({ kind: "signed-in" as const, message: "Google account connected through the Antigravity CLI" });
const BASE_OPTIONS = { agent: AGENT, skillLibrary: SKILLS, model: "gemini-3.8-flash-high", getStatus: SIGNED_IN };

const INIT = { event: "init", conversation_id: "conv-1", init: { cwd: "x", tools: ["call_mcp_tool", "run_command"], permission_mode: "request-review" } };

const step = (index: number, fields: Record<string, unknown>) => ({
  event: "step_update",
  step_update: { conversation_id: "conv-1", step_index: index, ...fields },
});
const reply = (index: number, text: string, state = "DONE") => step(index, { state, step_type: "agent_response", text_delta: text });
const result = (response: string, extra: Record<string, unknown> = {}) => ({
  event: "result",
  result: {
    conversation_id: "conv-1", status: "SUCCESS", response, num_turns: 1,
    usage: { input_tokens: 1200, output_tokens: 80, thinking_tokens: 20, cache_read_tokens: 200, total_tokens: 1300 },
    ...extra,
  },
});

type Recorded = { calls: string[]; said: string[]; statuses: string[]; usage: RunUsage[]; context: number[] };

function makeContext(controller: AbortController, overrides: Partial<PlannerContext> = {}) {
  const recorded: Recorded = { calls: [], said: [], statuses: [], usage: [], context: [] };
  const context: PlannerContext = {
    prompt: "Read Main and tell me what it does",
    conversation: { messages: [], truncated: false },
    images: [],
    instanceId: "studio-1",
    autoPlaytest: false,
    signal: controller.signal,
    status: (label) => recorded.statuses.push(label),
    progress: () => undefined,
    outputTokens: () => undefined,
    contextUsage: (used) => recorded.context.push(used),
    runUsage: (usage) => recorded.usage.push(usage),
    say: (text) => recorded.said.push(text),
    recordChange: () => undefined,
    recordEvidence: () => undefined,
    setTasks: () => undefined,
    tasks: () => [],
    changes: () => [],
    evidence: () => [],
    decisions: () => [],
    takeSteers: () => [],
    askUser: async (_question, options) => options[0],
    checkCompletion: () => ({ verified: true, issues: [] }),
    call: async (tool): Promise<McpToolOutcome> => {
      recorded.calls.push(tool);
      return { ok: true, data: { source: "print('hi')", sourceRevision: "rev-1" }, text: "", httpStatus: 200, durationMs: 1 };
    },
    ...overrides,
  };
  return { context, recorded };
}

/** Call one of Roqer's tools the way agy would, with the endpoint and token from the private home. */
async function callTool(home: AntigravityHome, name: string, args: unknown): Promise<string> {
  const config = JSON.parse(await fs.readFile(path.join(home.home, ".gemini", "config", "mcp_config.json"), "utf8"));
  const server = config.mcpServers[ANTIGRAVITY_MCP_SERVER_NAME];
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: server.headers.Authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return body.result.content[0].text;
}

/** A launcher whose fake agy runs `script` once launched, and records what it was given. */
function fakeLauncher(
  script: (child: FakeChildProcess, home: AntigravityHome, input: () => Array<Record<string, unknown>>) => Promise<void> | void,
  onInput?: (child: FakeChildProcess, message: Record<string, unknown>) => void,
) {
  const launches: Array<{ args: string[]; home: AntigravityHome; child: FakeChildProcess }> = [];
  return {
    launches,
    launcher: {
      launch: async (args: string[], home: AntigravityHome) => {
        const child = new FakeChildProcess();
        const inputs: Array<Record<string, unknown>> = [];
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (chunk: string) => {
          for (const line of chunk.split("\n")) {
            if (!line) continue;
            const message = JSON.parse(line) as Record<string, unknown>;
            inputs.push(message);
            onInput?.(child, message);
          }
        });
        launches.push({ args, home, child });
        setImmediate(() => void script(child, home, () => inputs));
        return child.asChild();
      },
    },
  };
}

function firstText(input: Record<string, unknown>): string {
  return ((input.message as { content: Array<{ text: string }> }).content[0]).text;
}

test("Antigravity routes a call to Roqer's MCP server through PlannerContext and streams the reply", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  let toolResult = "";
  let sent: Array<Record<string, unknown>> = [];
  const fake = fakeLauncher(async (child, home, input) => {
    child.writeLine(INIT);
    child.writeLine(step(0, { state: "DONE", step_type: "user_input" }));
    child.writeLine(step(1, { state: "DONE", step_type: "agent_response", usage: { input_tokens: 900, output_tokens: 40, thinking_tokens: 10 } }));
    child.writeLine(step(2, {
      state: "DONE", step_type: "tool", tool_name: "view_file",
      tool_info: { name: "view_file", parameters: { AbsolutePath: path.join(schemaDirectory(home.home), "roblox_studio.json") }, output: "1 lines" },
    }));
    toolResult = await callTool(home, "roblox_studio", { operation: "get_script_source", arguments: { instancePath: "game.ServerScriptService.Main" } });
    child.writeLine(step(3, {
      state: "DONE", step_type: "tool", tool_name: "call_mcp_tool",
      tool_info: { name: "call_mcp_tool", parameters: { ServerName: ANTIGRAVITY_MCP_SERVER_NAME, ToolName: "roblox_studio", Arguments: {} }, output: toolResult },
    }));
    child.writeLine(reply(4, "Main ", "ACTIVE"));
    child.writeLine(reply(4, "prints hi."));
    sent = input();
    child.writeLine(result("Main prints hi."));
    child.finish(0);
  });

  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  const summary = await planner.run(context);

  assert.equal(summary, "Main prints hi.");
  assert.deepEqual(recorded.said.join(""), "Main prints hi.");
  assert.deepEqual(recorded.calls, ["get_script_source"]);
  assert.match(toolResult, /rev-1/);
  assert.deepEqual(recorded.context, [950]);
  assert.deepEqual(recorded.usage.at(-1), { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 100 });

  const { args, home } = fake.launches[0];
  assert.deepEqual(args, [
    "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--model", "gemini-3.8-flash-high",
  ]);
  // Never the switch that turns every permission check off.
  assert.ok(!args.includes("--dangerously-skip-permissions"));

  // Roqer's instructions open the first and only message; agy has no system prompt.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "user");
  const text = firstText(sent[0]);
  assert.match(text, /^<system-instructions>\s+SYSTEM TEST INSTRUCTIONS/);
  assert.match(text, /DEVELOPER TEST INSTRUCTIONS/);
  assert.match(text, /built-in tools .* are turned off/);
  assert.ok(text.endsWith("Read Main and tell me what it does"));

  // The private home, credential included, does not outlive the run.
  await assert.rejects(() => fs.access(home.home));
});

test("Antigravity stops a run the moment a tool Roqer does not allow got through", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine(INIT);
    child.writeLine(step(2, { state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } }));
    child.writeLine(step(2, { state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi" } }));
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  await assert.rejects(() => planner.run(context), /ran run_command, which Roqer does not allow/);
  assert.ok(fake.launches[0].child.killed);
});

test("Antigravity carries on past a call the gate refused", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine(INIT);
    child.writeLine(step(2, {
      state: "ERROR", step_type: "tool", tool_name: "search_web",
      tool_info: { name: "search_web", parameters: { query: "x" }, error: { type: "TOOL_ERROR", message: "tool call denied by pre-tool hook: Roqer allows only its own tools here: search_web is not available." } },
    }));
    child.writeLine(reply(3, "Done without the web."));
    child.writeLine(result("Done without the web."));
    child.finish(0);
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  assert.equal(await planner.run(context), "Done without the web.");
});

test("Antigravity fails a run whose gate did not run", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine(INIT);
    child.writeLine(step(2, {
      state: "ERROR", step_type: "tool", tool_name: "call_mcp_tool",
      tool_info: { name: "call_mcp_tool", parameters: { ServerName: "roqer" }, error: { type: "TOOL_ERROR", message: "JSON hook \"jsonhook__roqer-gate_PreToolUse_0_0\" failed: command failed: exit status 1" } },
    }));
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  await assert.rejects(() => planner.run(context), /tool gate for Antigravity did not run/);
});

test("Antigravity refuses a process that is not under Roqer's permission rules", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine({ ...INIT, init: { ...INIT.init, permission_mode: "always-proceed" } });
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  await assert.rejects(() => planner.run(context), /"always-proceed" permission mode/);
});

test("Antigravity reports a turn its permission rules ended instead of an empty success", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine(INIT);
    child.writeLine(result("", { denied_actions: [{ action: "read_file", display_name: "ViewFile" }] }));
    child.finish(0);
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  await assert.rejects(() => planner.run(context), /asking for something Roqer does not allow \(ViewFile\)/);
});

test("Antigravity fails a turn agy reports as failed", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine(INIT);
    child.writeLine(result("", { status: "ERROR", error: "quota exhausted" }));
    child.finish(3);
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  await assert.rejects(() => planner.run(context), /quota exhausted/);
});

test("attached images are put where the agent may open them, and the message says where", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller, {
    images: [
      { name: "mockup.png", mediaType: "image/png", data: Buffer.from("PNG-BYTES").toString("base64") },
      { name: "../../evil\u0007.jpg", mediaType: "image/jpeg", data: Buffer.from("JPEG-BYTES").toString("base64") },
    ],
  });
  const sent: Array<Record<string, unknown>> = [];
  let files: Array<{ name: string; bytes: string }> = [];
  const fake = fakeLauncher((child) => child.writeLine(INIT), (child, message) => {
    sent.push(message);
    void (async () => {
      // The pictures are on disk by the time the message naming them arrives.
      const directory = attachmentDirectory(fake.launches[0].home.workspace);
      files = await Promise.all((await fs.readdir(directory)).sort().map(async (name) => ({
        name, bytes: (await fs.readFile(path.join(directory, name))).toString(),
      })));
      child.writeLine(step(2, {
        state: "DONE", step_type: "tool", tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: path.join(directory, "message-1-1.png") } },
      }));
      child.writeLine(reply(3, "A mockup."));
      child.writeLine(result("A mockup."));
      child.finish(0);
    })();
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  assert.equal(await planner.run(context), "A mockup.");

  // Named by Roqer, never by the user's file name, and inside the attachment folder.
  assert.deepEqual(files, [
    { name: "message-1-1.png", bytes: "PNG-BYTES" },
    { name: "message-1-2.jpg", bytes: "JPEG-BYTES" },
  ]);
  const text = firstText(sent[0]);
  assert.match(text, /comes with 2 images, saved as files\. Open each one with view_file/);
  // Numbered as they are among the message's images, which a clip's text refers to.
  const directory = attachmentDirectory(fake.launches[0].home.workspace);
  assert.ok(text.includes(`Image 1 ("mockup.png"): ${path.join(directory, "message-1-1.png")}`));
  assert.ok(text.includes(`Image 2 ("../../evil .jpg"): ${path.join(directory, "message-1-2.jpg")}`));
  assert.ok(!text.includes("\u0007"));
});

test("Antigravity refuses to start without a signed-in account", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher(() => undefined);
  const planner = createAntigravityPlanner({
    ...BASE_OPTIONS,
    launcher: fake.launcher,
    getStatus: async () => ({ kind: "signed-out", message: "Sign in to Antigravity" }),
  });
  await assert.rejects(() => planner.run(context), /Sign in to Antigravity/);
  assert.equal(fake.launches.length, 0);
});

test("cancelling an Antigravity run stops the process and removes its home", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const fake = fakeLauncher((child) => {
    child.writeLine(INIT);
    setImmediate(() => controller.abort());
  });
  const planner = createAntigravityPlanner({ ...BASE_OPTIONS, launcher: fake.launcher });
  await assert.rejects(() => planner.run(context), /cancelled/);
  const { child, home } = fake.launches[0];
  assert.ok(child.killed);
  await assert.rejects(() => fs.access(home.home));
});

test("a kept Antigravity session carries the chat's next message, and each run reports only its own usage", async () => {
  const sessions = new ProviderSessionStore<AntigravitySession>();
  let turn = 0;
  const inputs: Array<Record<string, unknown>> = [];
  const fake = fakeLauncher((child) => child.writeLine(INIT), (child, message) => {
    inputs.push(message);
    turn += 1;
    child.writeLine(reply(turn * 10, `Answer ${turn}.`));
    child.writeLine({
      event: "result",
      result: { status: "SUCCESS", response: `Answer ${turn}.`, usage: { input_tokens: turn * 1000, output_tokens: turn * 10, thinking_tokens: 0, cache_read_tokens: 0 } },
    });
  });
  const options = { ...BASE_OPTIONS, launcher: fake.launcher, sessions, chatId: "chat-1" };

  const first = makeContext(new AbortController());
  assert.equal(await createAntigravityPlanner(options).run(first.context), "Answer 1.");
  const second = makeContext(new AbortController(), {
    prompt: "And then?",
    conversation: {
      messages: [{ role: "user", text: "Read Main and tell me what it does" }, { role: "assistant", text: "Answer 1." }],
      truncated: false,
    },
  });
  assert.equal(await createAntigravityPlanner(options).run(second.context), "Answer 2.");

  assert.equal(fake.launches.length, 1);
  assert.equal(inputs.length, 2);
  // The follow-up does not repeat the instructions the session already has.
  assert.doesNotMatch(firstText(inputs[1]), /SYSTEM TEST INSTRUCTIONS/);
  assert.deepEqual(second.recorded.usage.at(-1), { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 10 });
  sessions.closeAll();
});

test("a tool step is permitted only for Roqer's server and the files in its private folders", () => {
  const root = path.resolve("agy-root");
  const home = { home: path.join(root, "home"), workspace: path.join(root, "workspace"), remove: async () => undefined };
  const tool = (name: string, parameters: Record<string, unknown>) =>
    readAntigravityStep(step(1, { state: "DONE", step_type: "tool", tool_name: name, tool_info: { name, parameters } }))!;
  const permitted = (name: string, parameters: Record<string, unknown>) => antigravityToolPermitted(tool(name, parameters), home);
  assert.ok(permitted("call_mcp_tool", { ServerName: ANTIGRAVITY_MCP_SERVER_NAME }));
  assert.ok(!permitted("call_mcp_tool", { ServerName: "other" }));
  assert.ok(permitted("view_file", { AbsolutePath: path.join(schemaDirectory(home.home), "a.json") }));
  assert.ok(permitted("view_file", { AbsolutePath: path.join(conversationDirectory(home.home), "c", ".system_generated", "steps", "4", "media_0.png") }));
  assert.ok(permitted("view_file", { AbsolutePath: path.join(attachmentDirectory(home.workspace), "message-1-1.png") }));
  assert.ok(!permitted("view_file", { AbsolutePath: path.join(schemaDirectory(home.home), "..", "..", "settings.json") }));
  assert.ok(!permitted("view_file", { AbsolutePath: path.join(home.workspace, "notes.txt") }));
  assert.ok(!permitted("view_file", { AbsolutePath: path.join(home.home, ".gemini", "config", "mcp_config.json") }));
  assert.ok(!permitted("generate_image", {}));

  const failed = readAntigravityStep(step(1, {
    state: "ERROR", step_type: "tool", tool_name: "view_file",
    tool_info: { name: "view_file", error: { message: "JSON hook \"jsonhook__roqer-gate_PreToolUse_0_0\" failed: timeout" } },
  }))!;
  assert.ok(isGateFailure(failed));
  const refused = readAntigravityStep(step(1, {
    state: "ERROR", step_type: "tool", tool_name: "view_file",
    tool_info: { name: "view_file", error: { message: "tool call denied by pre-tool hook: Roqer allows only its own tools here" } },
  }))!;
  assert.ok(!isGateFailure(refused));
});

test("a result's usage leaves cache reads out of input and counts thinking as output", () => {
  assert.deepEqual(
    antigravityResultUsage({ usage: { input_tokens: 500, output_tokens: 30, thinking_tokens: 12, cache_read_tokens: 100 } }),
    { inputTokens: 400, cacheReadTokens: 100, outputTokens: 42 },
  );
  assert.equal(antigravityResultUsage({ usage: { output_tokens: 3 } }), null);
});
