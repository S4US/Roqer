import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import os from "node:os";

import {
  CLAUDE_TOOL_CALL_TIMEOUT_MS, claudeContextUsage, claudeContextWindow, claudeResultUsage, ClaudeRunUsage, claudeSessionFile,
  compactClaudeChat, createClaudePlanner, streamedOutput, type ClaudeSession,
} from "./claude-planner";
import { ClaudeSessionRegistry } from "./claude-session-registry";
import { ProjectNotesStore } from "./project-notes";
import { timeoutForTool } from "../shared/mcp-tools";
import type { RunUsage } from "../shared/run-events";
import type { AgentDefinition } from "./agent-definition";
import type { McpToolOutcome } from "./mcp-types";
import type { PlannerContext } from "./run-engine";
import type { RunTask } from "../shared/tasks";
import { QUESTION_ESCAPE_OPTION } from "../shared/question";
import type { SkillLibrary } from "./skill-library";
import { FakeChildProcess } from "./test-child-process";
import { ProviderSessionStore } from "./provider-sessions";

const QUALIFIED_STUDIO_TOOL = "mcp__workbench__roblox_studio";
const QUALIFIED_SKILL_TOOL = "mcp__workbench__load_skill";
const QUALIFIED_ICON_TOOL = "mcp__workbench__resolve_icon";
const QUALIFIED_TASK_TOOL = "mcp__workbench__update_task_list";
const QUALIFIED_QUESTION_TOOL = "mcp__workbench__ask_user";
/** Everything the planner refuses to start without. */
const PROVIDER_TOOLS = [
  QUALIFIED_STUDIO_TOOL, QUALIFIED_SKILL_TOOL, QUALIFIED_ICON_TOOL, QUALIFIED_TASK_TOOL, QUALIFIED_QUESTION_TOOL,
];
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
const AGENT_OPTIONS = { agent: AGENT, skillLibrary: SKILLS, supportsEffort: true };

type Recorded = {
  calls: string[];
  said: string[];
  changes: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  tasks: RunTask[][];
  questions: Array<{ question: string; options: string[] }>;
};

function makeContext(controller: AbortController, outcome?: (tool: string) => McpToolOutcome) {
  const recorded: Recorded = {
    calls: [], said: [], changes: [], evidence: [], tasks: [], questions: [],
  };
  let currentTasks: RunTask[] = [];
  const context: PlannerContext = {
    prompt: "Read Main and tell me what it does",
    conversation: {
      messages: [
        { role: "user", text: "What does Main do?" },
        { role: "assistant", text: "I can inspect Main for you." },
      ],
      truncated: false,
    },
    images: [],
    instanceId: "studio-1",
    autoPlaytest: true,
    signal: controller.signal,
    status: () => undefined,
    progress: () => undefined,
    outputTokens: () => undefined,
    contextUsage: () => undefined, runUsage: () => undefined,
    say: (text) => recorded.said.push(text),
    recordChange: (change) => recorded.changes.push(change),
    recordEvidence: (item) => recorded.evidence.push(item),
    setTasks: (next) => {
      currentTasks = next;
      recorded.tasks.push(next);
    },
    tasks: () => currentTasks,
    changes: () => [],
    evidence: () => [],
    decisions: () => [],
    takeSteers: () => [],
    askUser: async (question, options) => {
      recorded.questions.push({ question, options });
      return options[0];
    },
    checkCompletion: () => ({ verified: true, issues: [] }),
    call: async (tool) => {
      recorded.calls.push(tool);
      return outcome?.(tool) ?? {
        ok: true,
        data: { source: "print('hi')", sourceRevision: "rev-1" },
        text: "",
        httpStatus: 200,
        durationMs: 1,
      };
    },
  };
  return { context, recorded };
}

/** Read the MCP endpoint the planner wrote for the CLI to use. */
async function mcpTarget(args: string[]): Promise<{ url: string; token: string }> {
  const configPath = args[args.indexOf("--mcp-config") + 1];
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  const server = parsed.mcpServers.workbench;
  return { url: server.url, token: server.headers.Authorization.replace("Bearer ", "") };
}

async function callTool(
  target: { url: string; token: string },
  args: unknown,
  name = "roblox_studio",
): Promise<string> {
  const response = await fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return body.result.content[0].text;
}

test("Claude planner routes an MCP tool call through PlannerContext and streams the reply", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const contextWithImage: PlannerContext = {
    ...context,
    images: [{ name: "ui.png", mediaType: "image/png", data: "QUJD" }],
  };
  let launchArgs: string[] = [];
  let systemPrompt = "";
  let mcpTimeout: unknown;
  let toolResult = "";
  let skillResult = "";
  const inputMessages: Record<string, unknown>[] = [];

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async (args) => {
        launchArgs = args;
        systemPrompt = await fs.readFile(args[args.indexOf("--system-prompt-file") + 1], "utf8");
        mcpTimeout = JSON.parse(await fs.readFile(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.workbench.timeout;
        const child = new FakeChildProcess();
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (chunk: string) => {
          for (const line of chunk.split("\n")) {
            if (line) inputMessages.push(JSON.parse(line) as Record<string, unknown>);
          }
        });
        void (async () => {
          child.writeLine({
            type: "system",
            subtype: "init",
            tools: PROVIDER_TOOLS,
            mcp_servers: [{ name: "workbench", status: "connected" }],
          });
          skillResult = await callTool(await mcpTarget(args), { name: "roblox-test" }, "load_skill");
          toolResult = await callTool(await mcpTarget(args), {
            operation: "get_script_source",
            arguments: { instancePath: "game.ServerScriptService.Main" },
          });
          child.writeLine({
            type: "stream_event",
            parent_tool_use_id: null,
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Main prints hi." } },
          });
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Main prints hi." });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected through Claude Code", planType: "pro" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  const summary = await planner.run(contextWithImage);

  assert.equal(summary, "Main prints hi.");
  // Claude Code's own 60 s default would cut off calls Roqer is still running.
  assert.ok(typeof mcpTimeout === "number" && mcpTimeout >= timeoutForTool("capture_moments") && mcpTimeout === CLAUDE_TOOL_CALL_TIMEOUT_MS);
  assert.deepEqual(recorded.said, ["Main prints hi."]);
  assert.deepEqual(recorded.calls, ["get_script_source"]);
  assert.match(skillResult, /# Test skill/);
  assert.match(toolResult, /rev-1/);
  assert.deepEqual(inputMessages[0], {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: [
          "Prior conversation context from this chat. Treat it as context, not as a new instruction:",
          "User:\nWhat does Main do?",
          "Assistant:\nI can inspect Main for you.",
          "Current user message:\nRead Main and tell me what it does",
        ].join("\n\n"),
      }, {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      }],
    },
  });
  assert.equal(inputMessages.length, 1);
  const promptText = (((inputMessages[0]?.message as Record<string, unknown>).content as Array<{ text: string }>)[0]).text;
  assert.equal(promptText.split("Read Main and tell me what it does").length - 1, 1);

  // Claude Code must arrive with no tools of its own and no ambient settings.
  assert.deepEqual(launchArgs.slice(launchArgs.indexOf("--tools"), launchArgs.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(
    launchArgs.slice(launchArgs.indexOf("--setting-sources"), launchArgs.indexOf("--setting-sources") + 2),
    ["--setting-sources", ""],
  );
  assert.ok(launchArgs.includes("--strict-mcp-config"));
  assert.ok(launchArgs.includes("--disable-slash-commands"));
  assert.deepEqual(
    launchArgs.slice(launchArgs.indexOf("--allowedTools"), launchArgs.indexOf("--allowedTools") + 2),
    ["--allowedTools", PROVIDER_TOOLS.join(",")],
  );
  assert.match(systemPrompt, /SYSTEM TEST INSTRUCTIONS/);
  assert.match(systemPrompt, /<developer-instructions>\s+DEVELOPER TEST INSTRUCTIONS/);
  assert.match(systemPrompt, /Automatic playtesting is enabled/);
  // The instructions travel in a private file: a command line is readable by
  // any process on the machine, and Windows caps its length.
  assert.ok(!launchArgs.includes("--system-prompt"));
  assert.ok(launchArgs.every((arg) => !arg.includes("SYSTEM TEST INSTRUCTIONS") && !arg.includes("DEVELOPER TEST INSTRUCTIONS")));
  assert.deepEqual(launchArgs.slice(launchArgs.indexOf("--effort"), launchArgs.indexOf("--effort") + 2), ["--effort", "high"]);

  // The endpoint and prompt files are private to the run and must not outlive it.
  const configPath = launchArgs[launchArgs.indexOf("--mcp-config") + 1];
  const systemPromptPath = launchArgs[launchArgs.indexOf("--system-prompt-file") + 1];
  assert.equal(path.dirname(systemPromptPath), path.dirname(configPath));
  await assert.rejects(() => fs.access(configPath));
  await assert.rejects(() => fs.access(systemPromptPath));
});

test("Claude planner keeps two assistant messages from running together", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async (args) => {
        const child = new FakeChildProcess();
        const delta = (text: string) => child.writeLine({
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        });
        const openMessage = () => {
          child.writeLine({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
          child.writeLine({
            type: "stream_event",
            parent_tool_use_id: null,
            event: { type: "content_block_start", content_block: { type: "text" } },
          });
        };
        void (async () => {
          child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
          // A turn that calls a tool is several messages, and the provider never
          // sends the break between them.
          openMessage();
          delta("I read the script in Studio.");
          await callTool(await mcpTarget(args), {
            operation: "get_script_source",
            arguments: { instancePath: "game.ServerScriptService.Main" },
          });
          openMessage();
          delta("There's one caveat.");
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "" });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  const summary = await planner.run(context);
  assert.equal(summary, "I read the script in Studio.\n\nThere's one caveat.");
  assert.equal(recorded.said.join(""), "I read the script in Studio.\n\nThere's one caveat.");
});

test("Claude planner omits --effort for a model that does not accept it", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  let launchArgs: string[] = [];

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async (args) => {
        launchArgs = args;
        const child = new FakeChildProcess();
        child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
        child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Done." });
        child.finish(0);
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "haiku",
    effort: "medium",
    supportsEffort: false,
  });

  assert.equal(await planner.run(context), "Done.");
  assert.ok(!launchArgs.includes("--effort"));
});

test("Claude planner ends a run whose model stops making progress", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const statuses: string[] = [];
  let launched: FakeChildProcess | undefined;

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async () => {
        launched = new FakeChildProcess();
        launched.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
        return launched.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
    stallMs: 30,
  });

  await assert.rejects(
    () => planner.run({ ...context, status: (label) => statuses.push(label) }),
    /stopped responding for 0 seconds.*Nothing was changed in Studio/,
  );
  assert.equal(launched?.killed, true);
  assert.deepEqual(statuses, ["Model stopped making progress"]);
});

test("Claude planner does not count a question the user is still reading as a stall", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  let answer = "";

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async (args) => {
        const child = new FakeChildProcess();
        void (async () => {
          child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
          answer = await callTool(await mcpTarget(args), { question: "Which?", options: ["A", "B"] }, "ask_user");
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Done." });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
    stallMs: 300,
  });

  const summary = await planner.run({
    ...context,
    askUser: async (_question, options) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return options[1];
    },
  });
  assert.equal(summary, "Done.");
  assert.match(answer, /The user answered: B/);
});

test("Claude planner refuses to run when Claude Code did not load every Roqer tool", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async () => {
        const child = new FakeChildProcess();
        child.writeLine({ type: "system", subtype: "init", tools: [] });
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  await assert.rejects(() => planner.run(context), /did not load the Roqer tools/);
});

test("Claude planner refuses to run when only some Roqer tools loaded", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async () => {
        const child = new FakeChildProcess();
        // The Studio and skill tools are there; the task and question tools are
        // not. A partial load is the failure mode a bare length check misses.
        child.writeLine({
          type: "system",
          subtype: "init",
          tools: [QUALIFIED_STUDIO_TOOL, QUALIFIED_SKILL_TOOL],
        });
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "ok" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  await assert.rejects(() => planner.run(context), /did not load the Roqer tools/);
});

test("Claude planner reports a failed turn instead of returning its text", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async () => {
        const child = new FakeChildProcess();
        child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
        child.writeLine({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Usage limit reached.",
        });
        child.finish(1);
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  await assert.rejects(() => planner.run(context), /Usage limit reached/);
});

test("Claude planner warns once as the plan nears a limit, and ends on Claude Code's own limit message", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const statuses: Array<{ label: string; detail?: string }> = [];
  context.status = (label, detail) => statuses.push({ label, detail });
  const limitMessage = "You've hit your session limit · resets 3:40pm";
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const rateLimit = (status: string) => ({
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType: "five_hour", resetsAt, utilization: 0.91 },
    uuid: "u", session_id: "s",
  });

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async () => {
        const child = new FakeChildProcess();
        child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
        child.writeLine(rateLimit("allowed"));
        child.writeLine(rateLimit("allowed_warning"));
        child.writeLine(rateLimit("allowed_warning"));
        child.writeLine(rateLimit("rejected"));
        child.writeLine({ type: "result", subtype: "success", is_error: true, result: limitMessage });
        child.finish(1);
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  await assert.rejects(() => planner.run(context), (error: Error) => error.message === limitMessage);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].label, "Close to your Claude usage limit");
  // Claude's utilization scale is undocumented, so no percentage is claimed.
  assert.match(statuses[0].detail ?? "", /^5-hour limit, resets .+\. The run stops if the limit is reached\.$/);
});

test("Claude planner refuses to start without a connected account", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: { launch: async () => { throw new Error("Claude Code should not be started."); } },
    getStatus: async () => ({ kind: "signed-out", message: "Connect your Claude subscription" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  await assert.rejects(() => planner.run(context), /Connect your Claude subscription/);
});

test("Claude planner stops the turn when the run is cancelled", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  let child: FakeChildProcess | null = null;

  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    launcher: {
      launch: async () => {
        child = new FakeChildProcess();
        child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
        setTimeout(() => controller.abort(), 10);
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  await assert.rejects(() => planner.run(context), /cancelled/);
  assert.equal((child as FakeChildProcess | null)?.killed, true);
});

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const PLANNER_DEFAULTS = {
  ...AGENT_OPTIONS,
  getStatus: async () => ({ kind: "signed-in" as const, message: "Connected" }),
  cwd: process.cwd(),
  model: "opus",
  effort: "high" as const,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("Claude gets each note at its next step, not when the turn ends", { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  const notes: string[] = [];
  const statuses: string[] = [];
  const inputs: Array<{ message: { content: Array<{ text: string }> } }> = [];
  const child = new FakeChildProcess();
  let target!: Awaited<ReturnType<typeof mcpTarget>>;
  let ready!: () => void;
  const launched = new Promise<void>((resolve) => { ready = resolve; });
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const line of chunk.trim().split("\n")) inputs.push(JSON.parse(line));
  });
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    notePollMs: 5,
    noteFollowUpMs: 40,
    launcher: { launch: async (args) => {
      target = await mcpTarget(args);
      ready();
      return child.asChild();
    } },
  });
  let finished = false;
  const running = planner.run({
    ...context,
    takeSteers: () => notes.splice(0),
    status: (title) => statuses.push(title),
    askUser: async () => {
      notes.push("Neither: make it green.");
      return QUESTION_ESCAPE_OPTION;
    },
  }).finally(() => { finished = true; });
  try {
    await launched;
    await nextTick();
    child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
    const questionResult = await callTool(target, { question: "Which color?", options: ["Red", "Blue"] }, "ask_user");
    assert.match(questionResult, /Do not act on any of the offered options/);
    assert.doesNotMatch(questionResult, /make it green/);
    // Written before the result went back, so Claude Code has it at this very step.
    assert.equal(inputs.length, 2, "the note goes to Claude Code with the result");
    assert.match(inputs[1].message.content[0].text, /Neither: make it green/);
    assert.deepEqual(statuses, ["Sent your note to Claude"]);

    child.writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Made it green." }] } });
    assert.match(await callTool(target, {
      operation: "get_script_source", arguments: { instancePath: "game.ServerScriptService.Main" },
    }), /rev-1/);

    // A note sent while the model works goes at once, without a tool call to carry it.
    notes.push("Also make it larger.");
    await sleep(25);
    assert.equal(inputs.length, 3);
    assert.match(inputs[2].message.content[0].text, /Also make it larger/);

    // The turn ends. A note may have come too late for it, so the run waits
    // briefly, and Claude Code starts a turn for that note.
    child.writeLine({ type: "result", subtype: "success", result: "Made it green." });
    await nextTick();
    assert.equal(finished, false);
    child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
    child.writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Made it larger." }] } });
    await sleep(60);
    assert.equal(finished, false, "the follow-up turn keeps the run going past the wait");
    child.writeLine({ type: "result", subtype: "success", result: "Made it larger." });
    const summary = await running;
    assert.equal(summary, "Made it green.\n\nMade it larger.");
    assert.equal(recorded.said.join(""), summary);
    assert.equal(child.killed, true);
    await assert.rejects(() => fetch(target.url));
  } finally {
    controller.abort();
    await running.catch(() => undefined);
  }
});

test("Claude ends a run whose notes were all read in the turn once the short wait passes", { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const notes: string[] = [];
  const child = new FakeChildProcess();
  let ready!: () => void;
  const launched = new Promise<void>((resolve) => { ready = resolve; });
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    notePollMs: 5,
    noteFollowUpMs: 40,
    launcher: { launch: async (args) => {
      await mcpTarget(args);
      ready();
      return child.asChild();
    } },
  });
  let finished = false;
  const running = planner.run({ ...context, takeSteers: () => notes.splice(0) }).finally(() => { finished = true; });
  try {
    await launched;
    await nextTick();
    child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
    notes.push("Use blue.");
    await sleep(25);
    child.writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Done, in blue." }] } });
    child.writeLine({ type: "result", subtype: "success", result: "Done, in blue." });
    await sleep(10);
    assert.equal(finished, false, "it waits in case Claude Code starts a turn for the note");
    assert.equal(await running, "Done, in blue.");
  } finally {
    controller.abort();
    await running.catch(() => undefined);
  }
});

test("Claude cancellation during launch has no unhandled rejection and cleans up", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const child = new FakeChildProcess();
  let configPath = "";
  let target!: Awaited<ReturnType<typeof mcpTarget>>;
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: { launch: async (args) => {
      configPath = args[args.indexOf("--mcp-config") + 1];
      target = await mcpTarget(args);
      controller.abort();
      // node:test fails this test if the completion rejection is unhandled
      // while the launcher has not yet returned the child.
      await nextTick();
      await nextTick();
      return child.asChild();
    } },
  });
  await assert.rejects(() => planner.run(context), /cancelled/);
  assert.equal(child.killed, true);
  assert.equal(child.stdin.readableLength, 0, "cancelled startup must not send a prompt");
  await assert.rejects(() => fs.access(configPath));
  await assert.rejects(() => fetch(target.url));
});

test("Claude does not launch after cancellation while reading account status", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    getStatus: async () => {
      controller.abort();
      return { kind: "signed-in", message: "Connected" };
    },
    launcher: { launch: async () => { assert.fail("must not launch a cancelled run"); } },
  });
  await assert.rejects(() => planner.run(context), /cancelled/);
});

test("Claude closes its MCP server when temporary-directory setup fails", async (t) => {
  const { context } = makeContext(new AbortController());
  const close = t.mock.method(http.Server.prototype, "close");
  t.mock.method(fs, "mkdtemp", async () => { throw new Error("temporary directory unavailable"); });
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: { launch: async () => { assert.fail("setup failed before launch"); } },
  });
  await assert.rejects(() => planner.run(context), /temporary directory unavailable/);
  assert.equal(close.mock.callCount(), 1);
});

test("Claude ends the run on a broken output pipe rather than throwing out of the stream", async () => {
  const { context } = makeContext(new AbortController());
  const child = new FakeChildProcess();
  let ready!: () => void;
  const launched = new Promise<void>((resolve) => { ready = resolve; });
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: { launch: async () => { ready(); return child.asChild(); } },
  });
  const rejected = assert.rejects(() => planner.run(context), /output pipe closed/);
  await launched;
  await nextTick();
  child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
  await nextTick();
  // readline re-emits an input error on the interface, so an unlistened
  // interface would throw this back at the caller instead of failing the run.
  child.stdout.emit("error", new Error("output pipe closed"));
  await rejected;
  assert.equal(child.killed, true);
});

test("Claude refuses a session that is missing only the icon tool", async () => {
  const { context } = makeContext(new AbortController());
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: { launch: async () => {
      const child = new FakeChildProcess();
      child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS.filter((name) => name !== QUALIFIED_ICON_TOOL) });
      return child.asChild();
    } },
  });
  await assert.rejects(() => planner.run(context), /did not load the Roqer tools/);
});

/** A Claude Code stand-in that answers every user message it is sent, and remembers them. */
function answeringLauncher() {
  const launches: FakeChildProcess[] = [];
  const inputs: string[] = [];
  let answer: (text: string) => Record<string, unknown> = () =>
    ({ type: "result", subtype: "success", is_error: false, result: `Answer ${inputs.length}` });
  return {
    launches,
    inputs,
    answerWith(next: (text: string) => Record<string, unknown>) { answer = next; },
    launcher: {
      launch: async () => {
        const child = new FakeChildProcess();
        launches.push(child);
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (chunk: string) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { message: { content: Array<{ text: string }> } };
            const text = message.message.content[0].text;
            inputs.push(text);
            child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
            child.writeLine(answer(text));
          }
        });
        return child.asChild();
      },
    },
  };
}

/** The context of the next message in the same chat, after `previous` was answered. */
function followUp(previous: PlannerContext, reply: string, prompt: string): PlannerContext {
  return {
    ...previous,
    prompt,
    conversation: {
      messages: [
        ...previous.conversation.messages,
        { role: "user", text: previous.prompt },
        { role: "assistant", text: reply },
      ],
      truncated: false,
    },
  };
}

test("Claude keeps a chat's process for its next message and sends only the new prompt", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = answeringLauncher();
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions });
  const { context } = makeContext(new AbortController());

  assert.equal(await planner.run(context), "Answer 1");
  assert.match(provider.inputs[0], /Prior conversation context/);
  assert.equal(provider.launches[0].killed, false, "the process waits for the chat's next message");
  assert.equal(sessions.size, 1);

  assert.equal(await planner.run(followUp(context, "Answer 1", "Now change it.")), "Answer 2");
  assert.equal(provider.launches.length, 1, "the same process answered both messages");
  assert.equal(provider.inputs[1], "Now change it.");

  await sessions.closeAll();
  assert.equal(provider.launches[0].killed, true);
});

test("Claude starts over when the chat moved on without its kept process", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = answeringLauncher();
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions });
  const { context } = makeContext(new AbortController());

  await planner.run(context);
  const elsewhere = followUp({ ...context, prompt: "Asked on another provider" }, "Other answer", "Continue.");
  await planner.run(elsewhere);

  assert.equal(provider.launches.length, 2);
  assert.equal(provider.launches[0].killed, true, "the stale process is stopped, not leaked");
  assert.match(provider.inputs[1], /Asked on another provider/, "the new process is given the whole chat");
  await sessions.closeAll();
});

test("Claude starts a new process when the run needs different startup settings", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = answeringLauncher();
  const { context } = makeContext(new AbortController());
  const base = { ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions };

  await createClaudePlanner(base).run(context);
  await createClaudePlanner({ ...base, model: "sonnet" }).run(followUp(context, "Answer 1", "Again."));

  assert.equal(provider.launches.length, 2);
  assert.equal(provider.launches[0].killed, true);
  await sessions.closeAll();
});

test("Claude starts a new process when the chat moved to another Studio place", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = answeringLauncher();
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions });
  const { context } = makeContext(new AbortController());

  await planner.run({ ...context, instanceId: "place:1" });
  await planner.run({ ...followUp(context, "Answer 1", "Again."), instanceId: "place:2" });

  assert.equal(provider.launches.length, 2);
  assert.equal(provider.launches[0].killed, true);
  assert.match(provider.inputs[1], /Prior conversation context/, "the new process is given the chat, not the old place's reads");
  await sessions.closeAll();
});

test("Claude does not keep a process whose run failed", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = answeringLauncher();
  provider.answerWith(() => ({ type: "result", subtype: "error_during_execution", is_error: true, result: "Overloaded" }));
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions });
  const { context } = makeContext(new AbortController());

  await assert.rejects(() => planner.run(context), /Overloaded/);
  assert.equal(sessions.size, 0);
  assert.equal(provider.launches[0].killed, true);
});

/**
 * A Claude Code stand-in that loads the UI skill through Roqer on every message
 * it is sent, and can compact its conversation after the next load.
 */
function skillLoadingLauncher() {
  const launches: FakeChildProcess[] = [];
  const inputs: string[] = [];
  const skillResults: string[] = [];
  let compactAfterLoad = false;
  return {
    launches,
    inputs,
    skillResults,
    compactAfterNextLoad() { compactAfterLoad = true; },
    launcher: {
      launch: async (args: string[]) => {
        const target = await mcpTarget(args);
        const child = new FakeChildProcess();
        launches.push(child);
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (chunk: string) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { message: { content: Array<{ text: string }> } };
            inputs.push(message.message.content[0].text);
            void (async () => {
              child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
              skillResults.push(await callTool(target, { name: "roblox-ui-design" }, "load_skill"));
              if (compactAfterLoad) {
                compactAfterLoad = false;
                child.writeLine({
                  type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 160_000 },
                });
                await nextTick();
              }
              child.writeLine({ type: "result", subtype: "success", is_error: false, result: `Answer ${inputs.length}` });
            })();
          }
        });
        return child.asChild();
      },
    },
  };
}

test("Claude keeps delivered skills with the chat's process and a UI follow-up is told so", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = skillLoadingLauncher();
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions });
  const { context } = makeContext(new AbortController());
  const first = { ...context, prompt: "Build a shop menu" };

  assert.equal(await planner.run(first), "Answer 1");
  assert.match(provider.skillResults[0], /# Test skill/);
  assert.match(provider.inputs[0], /Load `roblox-ui-design` before any Studio mutation/);

  assert.equal(await planner.run(followUp(first, "Answer 1", "Make the shop panel wider")), "Answer 2");
  assert.equal(provider.launches.length, 1);
  assert.match(provider.inputs[1], /`roblox-ui-design` is already loaded in this conversation/);
  // The process still holds the document, so a repeat request is a pointer.
  assert.doesNotMatch(provider.skillResults[1], /# Test skill/);
  assert.match(provider.skillResults[1], /already loaded earlier in this conversation/);
  await sessions.closeAll();
});

test("Claude forgets delivered skills when Claude Code compacts the conversation", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const provider = skillLoadingLauncher();
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions });
  const { context } = makeContext(new AbortController());
  const first = { ...context, prompt: "Build a shop menu" };

  provider.compactAfterNextLoad();
  await planner.run(first);
  await planner.run(followUp(first, "Answer 1", "Make the shop panel wider"));

  assert.equal(provider.launches.length, 1, "compaction keeps the process");
  assert.match(provider.inputs[1], /Load `roblox-ui-design` before any Studio mutation/);
  assert.match(provider.skillResults[1], /# Test skill/, "the guidance is delivered again in full");
  await sessions.closeAll();
});

test("Claude refuses tool calls that reach a kept process between runs", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  let args: string[] = [];
  const provider = answeringLauncher();
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: { launch: async (launchArgs) => { args = launchArgs; return provider.launcher.launch(); } },
    chatId: "chat-1",
    sessions,
  });
  const { context, recorded } = makeContext(new AbortController());
  await planner.run(context);

  const text = await callTool(await mcpTarget(args), {
    operation: "get_script_source",
    arguments: { instancePath: "game.ServerScriptService.Main" },
  });
  assert.match(text, /No Roqer run is active/);
  assert.deepEqual(recorded.calls, [], "nothing reached Studio");
  await sessions.closeAll();
});

test("with Blender on, Claude may call the blender tool, and a call is one engine operation", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller, () => ({
    ok: true, data: { files: [] }, text: "Blender job finished.", httpStatus: 200, durationMs: 1,
  }));
  let launchArgs: string[] = [];
  let blenderResult = "";
  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    blender: true,
    launcher: {
      launch: async (args) => {
        launchArgs = args;
        const child = new FakeChildProcess();
        void (async () => {
          child.writeLine({
            type: "system",
            subtype: "init",
            tools: [...PROVIDER_TOOLS, "mcp__workbench__blender"],
            mcp_servers: [{ name: "workbench", status: "connected" }],
          });
          blenderResult = await callTool(await mcpTarget(args), { script: "import bpy" }, "blender");
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Modeled." });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected through Claude Code", planType: "pro" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  assert.equal(await planner.run(context), "Modeled.");
  assert.equal(
    launchArgs[launchArgs.indexOf("--allowedTools") + 1],
    [...PROVIDER_TOOLS, "mcp__workbench__blender"].join(","),
  );
  assert.deepEqual(recorded.calls, ["run_blender_script"]);
  assert.match(blenderResult, /Blender job finished/);
});

test("in a chat with reference clips, Claude may look closer at one, and a call is one engine read", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller, () => ({
    ok: true, data: { clip: "0123456789ab" }, text: "Clip 0123456789ab: 8 frames.", httpStatus: 200, durationMs: 1,
  }));
  let launchArgs: string[] = [];
  let clipResult = "";
  const planner = createClaudePlanner({
    ...AGENT_OPTIONS,
    referenceClips: true,
    launcher: {
      launch: async (args) => {
        launchArgs = args;
        const child = new FakeChildProcess();
        void (async () => {
          child.writeLine({
            type: "system",
            subtype: "init",
            tools: [...PROVIDER_TOOLS, "mcp__workbench__reference_clip"],
            mcp_servers: [{ name: "workbench", status: "connected" }],
          });
          clipResult = await callTool(await mcpTarget(args), { clip: "0123456789ab", from: 0.1, to: 0.3 }, "reference_clip");
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Looked." });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
    getStatus: async () => ({ kind: "signed-in", message: "Pro connected through Claude Code", planType: "pro" }),
    cwd: process.cwd(),
    model: "opus",
    effort: "high",
  });

  assert.equal(await planner.run(context), "Looked.");
  assert.equal(
    launchArgs[launchArgs.indexOf("--allowedTools") + 1],
    [...PROVIDER_TOOLS, "mcp__workbench__reference_clip"].join(","),
  );
  assert.deepEqual(recorded.calls, ["read_reference_clip"]);
  assert.match(clipResult, /8 frames/);
});

test("Claude Code's stream is counted for the waiting line: what streamed, then the API's own figure", () => {
  const event = (value: Record<string, unknown>, parent: string | null = null) =>
    streamedOutput({ type: "stream_event", parent_tool_use_id: parent, event: value });

  assert.deepEqual(event({ type: "message_start", message: { usage: { output_tokens: 1 } } }), { start: true });
  assert.deepEqual(event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan the shop." } }), { characters: 14 });
  assert.deepEqual(event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Adding it." } }), { characters: 10 });
  assert.deepEqual(event({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"operation\":" } }), { characters: 13 });
  assert.deepEqual(event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 412 } }), { exact: 412 });
  // A signature is not written output, and a sub-agent's stream is not the main reply's.
  assert.equal(event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }), null);
  assert.equal(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sub-agent" } }, "toolu_1"), null);
  assert.equal(event({ type: "message_delta", usage: { output_tokens: -1 } }), null);
});

test("Claude Code's context is what the main agent's response read and wrote, against the window its result names", () => {
  const assistant = (usage: Record<string, unknown>, parent: string | null = null) =>
    claudeContextUsage({ type: "assistant", parent_tool_use_id: parent, message: { model: "claude-opus-5-5", usage } });

  assert.deepEqual(
    assistant({ input_tokens: 12, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 61_000, output_tokens: 400 }),
    { usedTokens: 64_412, model: "claude-opus-5-5" },
    "cached input is still in the context",
  );
  assert.deepEqual(assistant({ input_tokens: 900 }), { usedTokens: 900, model: "claude-opus-5-5" });
  // A subagent's context is its own, and a usage without a count says nothing.
  assert.equal(assistant({ input_tokens: 900 }, "toolu_1"), null);
  assert.equal(assistant({ output_tokens: 10 }), null);
  assert.equal(assistant({ input_tokens: -1 }), null);

  const result = {
    type: "result",
    modelUsage: {
      "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
      "claude-opus-5-5[1m]": { contextWindow: 1_000_000 },
    },
  };
  assert.equal(claudeContextWindow(result, [null, "claude-opus-5-5"]), 1_000_000, "a bracketed variant names the same model");
  assert.equal(claudeContextWindow(result, ["claude-opus-5-5[1m]"]), 1_000_000);
  assert.equal(claudeContextWindow(result, ["claude-sonnet-5-5"]), null, "another model's window is not the conversation's");
  assert.equal(claudeContextWindow({ type: "result" }, ["claude-opus-5-5"]), null);
  assert.equal(claudeContextWindow({ type: "result", modelUsage: { "claude-opus-5-5": { contextWindow: 0 } } }, ["claude-opus-5-5"]), null);
});

test("Claude reports the context as each response ends, and a kept process knows the window from its first response", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  const launches: FakeChildProcess[] = [];
  let turn = 0;
  const launcher = {
    launch: async () => {
      const child = new FakeChildProcess();
      launches.push(child);
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk: string) => {
        const messages = chunk.split("\n").filter(Boolean).length;
        for (let index = 0; index < messages; index += 1) {
          turn += 1;
          const used = turn * 10_000;
          child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS, model: "claude-opus-5-5" });
          child.writeLine({ type: "assistant", parent_tool_use_id: "toolu_sub", message: { model: "claude-haiku-4-5", usage: { input_tokens: 5 } } });
          child.writeLine({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-5-5", content: [{ type: "text", text: `Answer ${turn}` }], usage: { input_tokens: used, output_tokens: 50 } } });
          child.writeLine({
            type: "result", subtype: "success", is_error: false, result: `Answer ${turn}`,
            modelUsage: { "claude-opus-5-5": { contextWindow: 200_000 }, "claude-haiku-4-5": { contextWindow: 64_000 } },
          });
        }
      });
      return child.asChild();
    },
  };
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher, chatId: "chat-1", sessions });
  const readings: Array<{ usedTokens: number; windowTokens: number | null }> = [];
  const { context } = makeContext(new AbortController());
  const reporting: PlannerContext = { ...context, contextUsage: (usedTokens, windowTokens) => readings.push({ usedTokens, windowTokens }) };

  await planner.run(reporting);
  assert.deepEqual(readings, [
    { usedTokens: 10_050, windowTokens: null },
    { usedTokens: 10_050, windowTokens: 200_000 },
  ], "the window arrives with the result, and the subagent's usage is not the conversation's");

  readings.length = 0;
  await planner.run(followUp(reporting, "Answer 1", "Now change it."));
  assert.equal(launches.length, 1);
  assert.deepEqual(readings[0], { usedTokens: 20_050, windowTokens: 200_000 });
  await sessions.closeAll();
});

test("Claude's usage is read from a result's running totals, a malformed figure left out", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    inputTokens: 60, outputTokens: 140, cacheReadInputTokens: 9_000, cacheCreationInputTokens: 120, costUSD: 1, contextWindow: 200_000, ...overrides,
  });
  assert.deepEqual(claudeResultUsage({
    type: "result", subtype: "success", num_turns: 4, total_cost_usd: 1.25,
    // The main agent's own per-turn figure is not the one used.
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-opus-5-5": entry(), "claude-haiku-4-5": entry({ inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }) },
  }), {
    totals: { inputTokens: 65, cacheReadTokens: 9_000, cacheWriteTokens: 120, outputTokens: 141, costUsd: 1.25 },
    requests: 4,
  }, "every model's tokens count, a subagent's included");

  assert.deepEqual(claudeResultUsage({
    type: "result", subtype: "success", num_turns: -1, total_cost_usd: "1.25",
    modelUsage: { "claude-opus-5-5": entry({ cacheReadInputTokens: 1.5 }), "claude-haiku-4-5": entry({ outputTokens: "9" }) },
  }), { totals: { inputTokens: 120, cacheWriteTokens: 240 } }, "a malformed figure drops that total, not the rest");
  assert.deepEqual(claudeResultUsage({ type: "result", subtype: "success" }), { totals: {} });
  assert.equal(claudeResultUsage({ type: "result", parent_tool_use_id: "toolu_1", total_cost_usd: 1 }), null, "only the main agent's results count");
  assert.equal(claudeResultUsage({ type: "assistant", total_cost_usd: 1 }), null);

  const totals = { inputTokens: 100, cacheReadTokens: 1_000, cacheWriteTokens: 10, outputTokens: 50, costUsd: 2 };
  const run = new ClaudeRunUsage(totals);
  const result = (input: number, output: number, cost: unknown, extra: Record<string, unknown> = {}) => ({
    type: "result", subtype: "success", num_turns: 2, total_cost_usd: cost,
    modelUsage: { "claude-opus-5-5": entry({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 1_500, cacheCreationInputTokens: 10 }) },
    ...extra,
  });
  assert.equal(run.observe({ type: "assistant" }), null);
  assert.deepEqual(run.observe(result(130, 70, 2.5)), {
    inputTokens: 30, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 20, requests: 2, costUsd: 0.5,
  }, "only what the totals grew by since the run began");
  // An error result still counts, and one carrying zeroed totals changes nothing.
  assert.deepEqual(run.observe(result(150, 75, 3, { subtype: "error_during_execution", is_error: true })), {
    inputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 25, requests: 4, costUsd: 1,
  });
  assert.deepEqual(run.observe({ type: "result", subtype: "error_during_execution", num_turns: 0, total_cost_usd: 0, modelUsage: {} }), {
    inputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 25, requests: 4, costUsd: 1,
  });
  assert.deepEqual(totals, { inputTokens: 150, cacheReadTokens: 1_500, cacheWriteTokens: 10, outputTokens: 75, costUsd: 3 }, "the process's totals move on for the next run");

  const unpriced = new ClaudeRunUsage({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 });
  assert.equal(unpriced.observe({ type: "result", subtype: "success", total_cost_usd: 1 }), null, "nothing to report without the token totals");
  assert.deepEqual(unpriced.observe(result(10, 5, null, { num_turns: undefined })), {
    inputTokens: 10, cacheReadTokens: 1_500, cacheWriteTokens: 10, outputTokens: 5, costUsd: 1,
  }, "a cost seen earlier in the run still counts; requests nobody counted are absent");
});

test("Claude reports a run's usage across its notes, and a kept process's next run reports only its own", async () => {
  const sessions = new ProviderSessionStore<ClaudeSession>();
  let turn = 0;
  const launcher = {
    launch: async () => {
      const child = new FakeChildProcess();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk: string) => {
        const messages = chunk.split("\n").filter(Boolean).length;
        for (let index = 0; index < messages; index += 1) {
          turn += 1;
          child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS, model: "claude-opus-5-5" });
          child.writeLine({
            type: "result", subtype: "success", is_error: false, result: `Answer ${turn}`, num_turns: 3, total_cost_usd: turn * 0.5,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {
              "claude-opus-5-5": { inputTokens: turn * 10, outputTokens: turn * 5, cacheReadInputTokens: turn * 1_000, cacheCreationInputTokens: turn * 100 },
              "claude-haiku-4-5": { inputTokens: turn, outputTokens: turn, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            },
          });
        }
      });
      return child.asChild();
    },
  };
  const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher, chatId: "chat-1", sessions });
  const reported: RunUsage[] = [];
  const notes = ["Also make it larger."];
  const { context } = makeContext(new AbortController());
  const reporting: PlannerContext = { ...context, takeSteers: () => notes.splice(0), runUsage: (usage) => reported.push(usage) };

  assert.equal(await planner.run(reporting), "Answer 1\n\nAnswer 2");
  assert.deepEqual(reported.at(-1), {
    inputTokens: 22, cacheReadTokens: 2_000, cacheWriteTokens: 200, outputTokens: 12, requests: 6, costUsd: 1,
  }, "both turns of the run, read from the latest totals rather than summed");

  reported.length = 0;
  await planner.run(followUp(reporting, "Answer 1\n\nAnswer 2", "Now change it."));
  assert.equal(turn, 3, "the same process carried on");
  assert.deepEqual(reported, [{
    inputTokens: 11, cacheReadTokens: 1_000, cacheWriteTokens: 100, outputTokens: 6, requests: 3, costUsd: 0.5,
  }], "the earlier run's usage is not counted again");
  await sessions.closeAll();
});

test("Claude's usage is also recorded request by request, with the tools each request carried the results of", async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const reported: RunUsage[] = [];
  const start = (usage: Record<string, unknown>, parent: string | null = null) => ({
    type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: { usage } },
  });
  const delta = (output: number) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: output } } });

  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: {
      launch: async (args) => {
        const child = new FakeChildProcess();
        void (async () => {
          child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
          child.writeLine(start({ input_tokens: 5, cache_creation_input_tokens: 9_000, cache_read_input_tokens: 0, output_tokens: 1 }));
          child.writeLine(delta(40));
          const target = await mcpTarget(args);
          await callTool(target, { operation: "get_place_info", arguments: {} });
          await callTool(target, { operation: "no_such_operation", arguments: {} });
          await callTool(target, { name: "roblox-test", resources: ["references/vfx-design.md", "templates/vfx/emit.lua"] }, "load_skill");
          await callTool(target, { name: "roblox-test", resource: "../secrets" }, "load_skill");
          // A subagent's request is its own context, not the conversation's.
          child.writeLine(start({ input_tokens: 100, output_tokens: 1 }, "toolu_sub"));
          child.writeLine(start({ input_tokens: 3, cache_creation_input_tokens: 250, cache_read_input_tokens: 9_000, output_tokens: 2 }));
          child.writeLine(delta(12));
          child.writeLine({
            type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2, total_cost_usd: 0.1,
            modelUsage: { "claude-opus-5-5": { inputTokens: 8, outputTokens: 52, cacheReadInputTokens: 9_000, cacheCreationInputTokens: 9_250 } },
          });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
  });

  assert.equal(await planner.run({ ...context, runUsage: (usage) => reported.push(usage) }), "Done.");
  assert.deepEqual(reported.at(-1)?.perRequest, [
    { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 9_000, outputTokens: 40 },
    // The unknown operation is named by the tool it went to, never by what the
    // model wrote; a skill load names its documents only when they are plain paths.
    {
      inputTokens: 3, cacheReadTokens: 9_000, cacheWriteTokens: 250, outputTokens: 12,
      after: ["get_place_info", "roblox_studio", "load_skill roblox-test: vfx-design, emit", "load_skill roblox-test"],
    },
  ]);
});

test("Claude answers a malformed Studio call to the model, and the run goes on", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  let flattened = "";
  let asText = "";

  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: {
      launch: async (args) => {
        const child = new FakeChildProcess();
        void (async () => {
          child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
          const target = await mcpTarget(args);
          // The arguments beside operation rather than inside arguments.
          flattened = await callTool(target, { operation: "insert_asset", assetId: 100967450390171 });
          // The arguments as JSON text whose Luau string kept its line breaks raw.
          asText = await callTool(target, {
            operation: "execute_luau",
            arguments: "{\"code\": \"local slime = workspace.Slime\nprint(slime)\"}",
          });
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Inserted." });
          child.finish(0);
        })();
        return child.asChild();
      },
    },
  });

  assert.equal(await planner.run(context), "Inserted.");
  assert.match(flattened, /assetId arrived beside operation; move it inside arguments/);
  assert.match(flattened, /\{operation: "<name>", arguments: \{\.\.\.\}\}/);
  assert.doesNotMatch(asText, /requires an operation/);
  assert.deepEqual(recorded.calls, ["execute_luau"], "only the well-formed call reaches Studio");
});

test("Claude ends a run whose model keeps sending malformed Studio calls", async () => {
  const controller = new AbortController();
  const { context, recorded } = makeContext(controller);
  let child: FakeChildProcess | null = null;

  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    launcher: {
      launch: async (args) => {
        child = new FakeChildProcess();
        const running = child;
        void (async () => {
          running.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
          const target = await mcpTarget(args);
          // The third ends the run, which closes this endpoint under its own reply.
          for (let index = 0; index < 3; index += 1) {
            await callTool(target, { operation: "get_place_info", arguments: "not an object" }).catch(() => "");
          }
        })();
        return running.asChild();
      },
    },
  });

  await assert.rejects(() => planner.run(context), /3 malformed tool calls in a row.*arguments arrived as text/);
  assert.deepEqual(recorded.calls, []);
  assert.equal((child as FakeChildProcess | null)?.killed, true);
});

// -- Saved sessions, project notes, and compaction ---------------------------

/** A Claude Code stand-in that records each launch's arguments and answers every message. */
function savingLauncher(extraTools: string[] = []) {
  const launches: Array<{ args: string[]; child: FakeChildProcess; systemPrompt: string }> = [];
  const inputs: string[] = [];
  let answer: (text: string, child: FakeChildProcess) => void = (_text, child) =>
    child.writeLine({ type: "result", subtype: "success", is_error: false, result: `Answer ${inputs.length}` });
  return {
    launches,
    inputs,
    answerWith(next: (text: string, child: FakeChildProcess) => void) { answer = next; },
    launcher: {
      launch: async (args: string[]) => {
        const child = new FakeChildProcess();
        const systemPrompt = await fs.readFile(args[args.indexOf("--system-prompt-file") + 1], "utf8");
        launches.push({ args, child, systemPrompt });
        child.stdin.setEncoding("utf8");
        child.stdin.on("data", (chunk: string) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { message: { content: Array<{ text: string }> } };
            const text = message.message.content[0].text;
            inputs.push(text);
            child.writeLine({ type: "system", subtype: "init", tools: [...PROVIDER_TOOLS, ...extraTools] });
            answer(text, child);
          }
        });
        return child.asChild();
      },
    },
  };
}

/** A temporary Claude config directory and registry, so saved sessions can be created and found. */
async function savedSessionFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-sessions-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, "claude");
  const registry = new ClaudeSessionRegistry(path.join(directory, "claude-sessions.json"));
  return {
    directory,
    registry,
    /** What Claude Code does when a process with `--session-id` writes its first turn. */
    async save(sessionId: string) {
      const file = claudeSessionFile(PLANNER_DEFAULTS.cwd, sessionId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "{}\n");
    },
    async dispose() {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

const argAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("Claude resumes a chat's saved conversation in a new process after a failed run", async () => {
  const fixture = await savedSessionFixture();
  try {
    const sessions = new ProviderSessionStore<ClaudeSession>();
    const provider = savingLauncher();
    const planner = createClaudePlanner({
      ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions, registry: fixture.registry,
    });
    const { context } = makeContext(new AbortController());

    provider.answerWith((_text, child) => child.writeLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "Overloaded" }));
    await assert.rejects(() => planner.run(context), /Overloaded/);
    const first = provider.launches[0].args;
    const sessionId = argAfter(first, "--session-id")!;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(first.includes("--no-session-persistence"), false, "the conversation is saved");
    assert.equal(first.includes("--disable-slash-commands"), true, "a run's prompt is never a slash command");
    assert.equal((await fixture.registry.get("chat-1"))?.lastPrompt, context.prompt);
    assert.match(provider.inputs[0], /Prior conversation context/, "a chat's first Claude session gets the replay once");

    await fixture.save(sessionId);
    provider.answerWith((_text, child) => child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Done" }));
    assert.equal(await planner.run(followUp(context, "Claude Code ended the turn.", "Try again.")), "Done");
    const second = provider.launches[1].args;
    assert.equal(argAfter(second, "--resume"), sessionId, "the new process continues the same conversation");
    assert.equal(provider.inputs[1], "Try again.", "nothing is replayed: the session holds the conversation");
    await sessions.closeAll();
  } finally {
    await fixture.dispose();
  }
});

test("Claude resumes after a model change and tells the session what the chat said without it", async () => {
  const fixture = await savedSessionFixture();
  try {
    const sessions = new ProviderSessionStore<ClaudeSession>();
    const provider = savingLauncher();
    const base = { ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions, registry: fixture.registry };
    const { context } = makeContext(new AbortController());

    await createClaudePlanner(base).run(context);
    const sessionId = argAfter(provider.launches[0].args, "--session-id")!;
    await fixture.save(sessionId);

    // Another provider answered a message in between, then the model changed.
    const elsewhere = followUp(followUp(context, "Answer 1", "Asked on another provider"), "Other answer", "Continue.");
    await createClaudePlanner({ ...base, model: "sonnet" }).run(elsewhere);

    assert.equal(provider.launches.length, 2);
    assert.equal(provider.launches[0].child.killed, true, "the old process is stopped, not leaked");
    assert.equal(argAfter(provider.launches[1].args, "--resume"), sessionId);
    assert.equal(argAfter(provider.launches[1].args, "--model"), "sonnet");
    assert.match(provider.inputs[1], /added to this chat since your last turn/);
    assert.match(provider.inputs[1], /Asked on another provider/);
    assert.match(provider.inputs[1], /Other answer/);
    assert.doesNotMatch(provider.inputs[1], /What does Main do\?/, "what the session already holds is not repeated");
    assert.match(provider.inputs[1], /Current user message:\nContinue\.$/);
    await sessions.closeAll();
  } finally {
    await fixture.dispose();
  }
});

test("Claude tells a resumed session when the chat moved to another Studio place", async () => {
  const fixture = await savedSessionFixture();
  try {
    const provider = savingLauncher();
    const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", registry: fixture.registry });
    const { context } = makeContext(new AbortController());
    await planner.run({ ...context, instanceId: "place:1" });
    await fixture.save(argAfter(provider.launches[0].args, "--session-id")!);
    await planner.run({ ...followUp(context, "Answer 1", "Again."), instanceId: "place:2" });
    assert.match(provider.inputs[1], /different Studio place/);
  } finally {
    await fixture.dispose();
  }
});

test("Claude starts a new saved session when the old one is gone", async () => {
  const fixture = await savedSessionFixture();
  try {
    const provider = savingLauncher();
    const planner = createClaudePlanner({ ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", registry: fixture.registry });
    const { context } = makeContext(new AbortController());
    await planner.run(context);
    const first = argAfter(provider.launches[0].args, "--session-id")!;
    // Never saved by Claude Code, or deleted since.
    await planner.run(followUp(context, "Answer 1", "Again."));
    const second = argAfter(provider.launches[1].args, "--session-id");
    assert.ok(second !== undefined && second !== first, "a fresh id, not a resume that would fail");
    assert.equal(provider.launches[1].args.includes("--resume"), false);
    assert.match(provider.inputs[1], /Prior conversation context/);
    assert.equal((await fixture.registry.get("chat-1"))?.sessionId, second);
  } finally {
    await fixture.dispose();
  }
});

const NOTES_TOOLS = ["mcp__workbench__project_memory", "mcp__workbench__master_plan"];

test("Claude starts with the project's notes and keeps them current with its tools", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-notes-"));
  try {
    const store = new ProjectNotesStore(directory);
    await store.setPlan("project-1", "# Dark Forest\n\n- Radar: status building");
    await store.addMemory("project-1", "Characters are R6 only.");
    const sessions = new ProviderSessionStore<ClaudeSession>();
    const provider = savingLauncher(NOTES_TOOLS);
    const planner = createClaudePlanner({
      ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions,
      projectNotes: { store, projectId: "project-1" },
    });
    const controller = new AbortController();
    const { context } = makeContext(controller);

    let target!: Awaited<ReturnType<typeof mcpTarget>>;
    provider.answerWith((text, child) => {
      if (text.includes("Mark the radar done")) {
        void (async () => {
          target = await mcpTarget(provider.launches[0].args);
          assert.equal(await callTool(target, { action: "edit", old_text: "status building", new_text: "status done" }, "master_plan"), "Master plan updated.");
          assert.match(await callTool(target, { action: "add", text: "The radar sweep runs on the client." }, "project_memory"), /^Saved as mem-/);
          child.writeLine({ type: "result", subtype: "success", is_error: false, result: "Marked it done." });
        })();
        return;
      }
      child.writeLine({ type: "result", subtype: "success", is_error: false, result: "OK" });
    });

    await planner.run(context);
    const prompt = provider.launches[0].systemPrompt;
    assert.match(prompt, /<master-plan>\n# Dark Forest/);
    assert.match(prompt, /Characters are R6 only\./);

    await planner.run(followUp(context, "OK", "Mark the radar done."));
    const notes = await store.get("project-1");
    assert.match(notes.plan, /status done/);
    assert.equal(notes.memories.length, 2);

    // The session wrote those itself, so its next message carries no update.
    await planner.run(followUp(followUp(context, "OK", "Mark the radar done."), "Marked it done.", "Next."));
    assert.equal(provider.inputs[2], "Next.");

    // The user edits the plan in Roqer: the live session is told on its next message.
    await store.setPlan("project-1", "# Dark Forest\n\n- Radar: needs fixing");
    const fourth = followUp(followUp(followUp(context, "OK", "Mark the radar done."), "Marked it done.", "Next."), "Answer 3", "And now?");
    await planner.run(fourth);
    assert.match(provider.inputs[3], /project notes were changed/);
    assert.match(provider.inputs[3], /needs fixing/);
    assert.equal(provider.launches.length, 1, "telling it does not restart the process");
    await sessions.closeAll();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("compacting a chat resumes its saved session with /compact allowed and reports the sizes", async () => {
  const fixture = await savedSessionFixture();
  try {
    const sessions = new ProviderSessionStore<ClaudeSession>();
    const provider = savingLauncher();
    const base = { ...PLANNER_DEFAULTS, launcher: provider.launcher, chatId: "chat-1", sessions, registry: fixture.registry };
    const { context } = makeContext(new AbortController());
    await createClaudePlanner(base).run(context);
    const sessionId = argAfter(provider.launches[0].args, "--session-id")!;
    await fixture.save(sessionId);

    provider.answerWith((text, child) => {
      assert.equal(text, "/compact");
      child.writeLine({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 180_000, post_tokens: 9_000 } });
      child.writeLine({ type: "result", subtype: "success", is_error: false, result: "" });
    });
    const result = await compactClaudeChat({ ...base, registry: fixture.registry, chatId: "chat-1" });
    assert.deepEqual(result, { ok: true, preTokens: 180_000, postTokens: 9_000 });
    assert.equal(provider.launches[0].child.killed, true, "the chat's live process made way for it");
    const compactor = provider.launches[1];
    assert.equal(argAfter(compactor.args, "--resume"), sessionId);
    assert.equal(compactor.args.includes("--disable-slash-commands"), false);
    assert.equal(compactor.child.killed, true, "the compacting process exits when done");
    assert.equal(sessions.size, 0);
  } finally {
    await fixture.dispose();
  }
});

test("compacting a chat with no saved conversation says so", async () => {
  const fixture = await savedSessionFixture();
  try {
    const provider = savingLauncher();
    const result = await compactClaudeChat({ ...PLANNER_DEFAULTS, launcher: provider.launcher, registry: fixture.registry, chatId: "chat-1" });
    assert.equal(result.ok, false);
    assert.equal(provider.launches.length, 0);
  } finally {
    await fixture.dispose();
  }
});

test("Claude takes a note sent while it waited after a turn, instead of ending the run without it", { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const { context } = makeContext(controller);
  const notes: string[] = [];
  const inputs: Array<{ message: { content: Array<{ text: string }> } }> = [];
  const child = new FakeChildProcess();
  let ready!: () => void;
  const launched = new Promise<void>((resolve) => { ready = resolve; });
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const line of chunk.trim().split("\n")) inputs.push(JSON.parse(line));
  });
  const planner = createClaudePlanner({
    ...PLANNER_DEFAULTS,
    notePollMs: 5,
    noteFollowUpMs: 40,
    launcher: { launch: async (args) => {
      await mcpTarget(args);
      ready();
      return child.asChild();
    } },
  });
  let finished = false;
  const running = planner.run({ ...context, takeSteers: () => notes.splice(0) }).finally(() => { finished = true; });
  try {
    await launched;
    await nextTick();
    child.writeLine({ type: "system", subtype: "init", tools: PROVIDER_TOOLS });
    notes.push("Use blue.");
    await sleep(25);
    child.writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Done, in blue." }] } });
    child.writeLine({ type: "result", subtype: "success", result: "Done, in blue." });
    await sleep(10);
    // The turn is over and Claude Code started nothing: a note now arrives.
    notes.push("Also make it bigger.");
    await sleep(60);
    assert.equal(finished, false, "the late note keeps the run going");
    assert.ok(inputs.some((input) => input.message.content.some((part) => part.text.includes("Also make it bigger."))));
    child.writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Made it bigger." }] } });
    child.writeLine({ type: "result", subtype: "success", result: "Made it bigger." });
    assert.equal(await running, "Done, in blue.\n\nMade it bigger.");
  } finally {
    controller.abort();
    await running.catch(() => undefined);
  }
});
