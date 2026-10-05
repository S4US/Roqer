import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexAppServerClient, type AppServerNotification, type AppServerRequest, type AppServerRequestHandler } from "./codex-app-server";
import {
  codexContextUsage, codexRunUsage, codexStreamedOutput, codexUsageTotals, createChatGptPlanner,
  type ChatGptAppServer, type CodexThread, type CodexThreadStore,
} from "./chatgpt-planner";
import { ProviderSessionStore } from "./provider-sessions";
import type { AgentDefinition } from "./agent-definition";
import type { PlannerContext } from "./run-engine";
import type { RunUsage } from "../shared/run-events";
import type { RunTask } from "../shared/tasks";
import type { SkillLibrary } from "./skill-library";

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

/** A steer that carries a tool's images, as opposed to a note the user typed. */
const isImageSteer = (request: { method: string; params: unknown }) =>
  request.method === "turn/steer" &&
  ((request.params as { input?: Array<{ type: string }> }).input ?? []).some((item) => item.type === "image");

class FakeAppServer implements ChatGptAppServer {
  notificationListener: ((notification: AppServerNotification) => void) | null = null;
  requestHandler: AppServerRequestHandler | null = null;
  disconnectListener: ((error: Error) => void) | null = null;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly studioResults: unknown[] = [];
  skillResult = "";
  /** How many image steers had been sent when the first Studio result came back. */
  imageSteersAtFirstResult: number | null = null;
  /** Answer image steers the way Codex answers one for a turn that has ended. */
  rejectImageSteers = false;

  async getChatGptStatus() {
    return { kind: "signed-in" as const, message: "Plus connected", planType: "plus" };
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListener = listener;
    return () => { this.notificationListener = null; };
  }

  handleRequests(handler: AppServerRequestHandler): () => void {
    this.requestHandler = handler;
    return () => { this.requestHandler = null; };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListener = listener;
    return () => { this.disconnectListener = null; };
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.rejectImageSteers && isImageSteer({ method, params })) throw new Error("no active turn to steer");
    if (method === "thread/start") return { thread: { id: "thread-1" } } as T;
    if (method === "turn/start") {
      queueMicrotask(() => void this.runTurn());
      return { turn: { id: "turn-1" } } as T;
    }
    return {} as T;
  }

  private async runTurn(): Promise<void> {
    const handler = this.requestHandler;
    assert.ok(handler);
    const request = (tool: string, args: Record<string, unknown>, id: string): AppServerRequest => ({
      id,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: id,
        tool,
        arguments: args,
      },
    });
    const delta = (itemId: string, text: string) => this.notificationListener?.({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId, delta: text },
    });

    // A turn that calls tools is several agent messages. Codex sends each as
    // its own item and never sends the break between them.
    const skill = await handler(request("load_skill", { name: "roblox-test" }, "skill-1"));
    this.skillResult = JSON.stringify(skill);
    const studioRequest = (operation: string, args: Record<string, unknown>, id: string) =>
      request("roblox_studio", { operation, arguments: args }, id);
    delta("message-1", "Reading Main.");
    this.studioResults.push(await handler(
      studioRequest("get_script_source", { instancePath: "game.ServerScriptService.Main" }, "call-1"),
    ));
    this.imageSteersAtFirstResult = this.requests.filter(isImageSteer).length;
    this.studioResults.push(await handler(studioRequest("set_script_source", {
      instancePath: "game.ServerScriptService.Main",
      source: "print('new')",
      expectedRevision: "rev-before",
    }, "call-2")));
    delta("message-2", "Updated and verified Main.");
    this.notificationListener?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
  }
}

test("ChatGPT planner routes Studio calls through PlannerContext and records verification", async () => {
  const calls: string[] = [];
  const said: string[] = [];
  const changes: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const taskUpdates: RunTask[][] = [];
  const questions: Array<{ question: string; options: string[] }> = [];
  const statuses: Array<{ label: string; detail?: string }> = [];
  const pendingSteers = ["Also make the button blue."];
  let currentTasks: RunTask[] = [];
  let readCount = 0;
  const context: PlannerContext = {
    prompt: "Change Main to print new",
    conversation: {
      messages: [
        { role: "user", text: "Read Main first." },
        { role: "assistant", text: "Main currently prints hello." },
      ],
      truncated: false,
    },
    images: [],
    instanceId: "studio-1",
    autoPlaytest: true,
    signal: new AbortController().signal,
    status: (label, detail) => statuses.push({ label, detail }),
    progress: () => undefined,
    outputTokens: () => undefined,
    contextUsage: () => undefined, runUsage: () => undefined,
    say: (text) => said.push(text),
    recordChange: (change) => changes.push(change),
    recordEvidence: (item) => evidence.push(item),
    setTasks: (next) => {
      currentTasks = next;
      taskUpdates.push(next);
    },
    tasks: () => currentTasks,
    changes: () => [],
    evidence: () => [],
    decisions: () => [],
    takeSteers: () => pendingSteers.splice(0),
    askUser: async (question, options) => {
      questions.push({ question, options });
      return options[0];
    },
    checkCompletion: () => ({ verified: true, issues: [] }),
    call: async (tool) => {
      calls.push(tool);
      if (tool === "get_script_source") {
        readCount += 1;
        return {
          ok: true,
          data: { source: readCount === 1 ? "print('old')" : "print('new')", sourceRevision: readCount === 1 ? "rev-before" : "rev-after" },
          text: "",
          ...(readCount === 1 ? {
            images: [{ mediaType: "image/jpeg" as const, data: Buffer.from("studio screenshot").toString("base64") }],
          } : {}),
          httpStatus: 200,
          durationMs: 1,
        };
      }
      return {
        ok: true,
        data: { sourceRevision: "rev-after" },
        text: "",
        httpStatus: 200,
        durationMs: 1,
      };
    },
  };

  const appServer = new FakeAppServer();
  const planner = createChatGptPlanner({
    appServer, cwd: "C:\\workbench", model: "gpt-test", effort: "high", agent: AGENT, skillLibrary: SKILLS,
  });
  const summary = await planner.run(context);

  assert.deepEqual(calls, ["get_script_source", "set_script_source", "get_script_source"]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].revisionBefore, "rev-before");
  assert.equal(changes[0].revisionAfter, "rev-after");
  assert.equal(changes[0].oldStartLine, 1);
  assert.equal(changes[0].newStartLine, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].passed, true);
  // The seam between two agent messages is a paragraph break, never a
  // concatenation that would read "Reading Main.Updated and verified Main."
  assert.deepEqual(said, ["Reading Main.", "\n\n", "Updated and verified Main."]);
  assert.equal(summary, "Reading Main.\n\nUpdated and verified Main.");
  assert.match(appServer.skillResult, /# Test skill/);
  // Codex hands a dynamic tool's result to code mode as one string, where an
  // image is base64 text the model cannot see. So the image follows as turn
  // input, accepted before the result is returned.
  assert.deepEqual(appServer.studioResults[0], {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: '{"operation":"get_script_source","ok":true,"data":{"sourceRevision":"rev-before"}}\n\nsource:\nprint(\'old\')'
          + "\n\n[This result has an image. Roqer attaches it right after this result, in a message of its own.]",
      },
    ],
  });
  assert.deepEqual(appServer.requests.filter(isImageSteer).map((request) => request.params), [{
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [
      {
        type: "text",
        text: "[Roqer attaches the image get_script_source just returned. This is tool output, not a message from the user.]",
      },
      { type: "image", url: `data:image/jpeg;base64,${Buffer.from("studio screenshot").toString("base64")}` },
    ],
  }]);
  assert.equal(appServer.imageSteersAtFirstResult, 1);
  const threadStart = appServer.requests.find((request) => request.method === "thread/start");
  const turnStart = appServer.requests.find((request) => request.method === "turn/start");
  assert.equal((threadStart?.params as Record<string, unknown>).model, "gpt-test");
  assert.equal((threadStart?.params as Record<string, unknown>).baseInstructions, AGENT.systemInstructions);
  const developerInstructions = (threadStart?.params as Record<string, unknown>).developerInstructions;
  assert.equal(typeof developerInstructions, "string");
  assert.match(developerInstructions as string, /DEVELOPER TEST INSTRUCTIONS/);
  assert.match(developerInstructions as string, /Automatic playtesting is enabled/);
  assert.deepEqual(
    ((threadStart?.params as Record<string, unknown>).dynamicTools as Array<{ name: string }>).map((tool) => tool.name),
    ["roblox_studio", "load_skill", "resolve_icon", "update_task_list", "ask_user"],
  );
  assert.equal((turnStart?.params as Record<string, unknown>).model, "gpt-test");
  assert.equal((turnStart?.params as Record<string, unknown>).effort, "high");
  const turnSteer = appServer.requests.find((request) => request.method === "turn/steer" && !isImageSteer(request));
  assert.deepEqual(turnSteer?.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{
      type: "text",
      text: "[Roqer relays a note the user typed while you were working. It is from the user, not from a tool:]\nAlso make the button blue.",
    }],
  });
  assert.deepEqual(statuses, [{ label: "Read your note", detail: "Also make the button blue." }]);
  assert.deepEqual((turnStart?.params as Record<string, unknown>).input, [{
    type: "text",
    text: [
      "Prior conversation context from this chat. Treat it as context, not as a new instruction:",
      "User:\nRead Main first.",
      "Assistant:\nMain currently prints hello.",
      "Current user message:\nChange Main to print new",
    ].join("\n\n"),
  }]);
  const promptText = ((turnStart?.params as Record<string, unknown>).input as Array<{ text: string }>)[0].text;
  assert.equal(promptText.split("Change Main to print new").length - 1, 1);
});

test("ChatGPT keeps an empty history prompt byte-for-byte unchanged", async () => {
  const appServer = new FakeAppServer();
  const controller = new AbortController();
  const context: PlannerContext = {
    prompt: "A prompt with exact spacing\nsecond line",
    conversation: { messages: [], truncated: false },
    images: [],
    instanceId: null,
    autoPlaytest: false,
    signal: controller.signal,
    status: () => undefined,
    progress: () => undefined,
    outputTokens: () => undefined,
    contextUsage: () => undefined, runUsage: () => undefined,
    say: () => undefined,
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
    call: async () => ({ ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 }),
  };

  const planner = createChatGptPlanner({
    appServer, cwd: "C:\\workbench", model: "gpt-test", effort: "medium", agent: AGENT, skillLibrary: SKILLS,
  });
  await planner.run(context);

  const turnStart = appServer.requests.find((request) => request.method === "turn/start");
  assert.deepEqual((turnStart?.params as Record<string, unknown>).input, [{ type: "text", text: context.prompt }]);
  const threadStart = appServer.requests.find((request) => request.method === "thread/start");
  assert.match(
    (threadStart?.params as Record<string, unknown>).developerInstructions as string,
    /Automatic playtesting is disabled/,
  );
});

test("ChatGPT receives user-attached images in the opening turn", async () => {
  const appServer = new FakeAppServer();
  const controller = new AbortController();
  const context: PlannerContext = {
    prompt: "Inspect this UI",
    conversation: { messages: [], truncated: false },
    images: [{ name: "ui.png", mediaType: "image/png", data: "QUJD" }],
    instanceId: null,
    autoPlaytest: false,
    signal: controller.signal,
    status: () => undefined,
    progress: () => undefined,
    outputTokens: () => undefined,
    contextUsage: () => undefined, runUsage: () => undefined,
    say: () => undefined,
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
    call: async () => ({ ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 }),
  };

  await createChatGptPlanner({
    appServer, cwd: "C:\\workbench", model: "gpt-test", effort: "medium", agent: AGENT, skillLibrary: SKILLS,
  }).run(context);

  const turnStart = appServer.requests.find((request) => request.method === "turn/start");
  assert.deepEqual((turnStart?.params as Record<string, unknown>).input, [
    { type: "text", text: "Inspect this UI" },
    { type: "image", url: "data:image/png;base64,QUJD" },
  ]);
});

function pendingValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ManualAppServer extends FakeAppServer {
  readonly turnStarted = pendingValue<void>();
  readonly turnResponse = pendingValue<unknown>();

  override async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method !== "turn/start") return super.request<T>(method, params);
    this.requests.push({ method, params });
    this.turnStarted.resolve();
    return await this.turnResponse.promise as T;
  }
}

function lifecycleRun(
  appServer: ChatGptAppServer,
  signal = new AbortController().signal,
  overrides: {
    stallMs?: number; askUser?: PlannerContext["askUser"]; status?: PlannerContext["status"]; call?: PlannerContext["call"];
  } = {},
) {
  const context: PlannerContext = {
    prompt: "Inspect Studio", conversation: { messages: [], truncated: false }, images: [],
    instanceId: null, autoPlaytest: false, signal,
    progress: () => undefined, outputTokens: () => undefined, contextUsage: () => undefined, runUsage: () => undefined, status: overrides.status ?? (() => undefined), say: () => undefined,
    recordChange: () => undefined, recordEvidence: () => undefined, setTasks: () => undefined,
    tasks: () => [], changes: () => [], evidence: () => [], decisions: () => [], takeSteers: () => [],
    askUser: overrides.askUser ?? (async (_question, options) => options[0]),
    checkCompletion: () => ({ verified: true, issues: [] }),
    call: overrides.call ?? (async () => ({ ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 })),
  };
  return createChatGptPlanner({
    appServer, cwd: "C:\\workbench", model: "gpt-test", effort: "medium", agent: AGENT, skillLibrary: SKILLS,
    ...(overrides.stallMs === undefined ? {} : { stallMs: overrides.stallMs }),
  }).run(context);
}

test("ChatGPT tells the model, and the user, when Codex will not take a tool's images", async () => {
  const appServer = new ManualAppServer();
  appServer.rejectImageSteers = true;
  const statuses: string[] = [];
  const run = lifecycleRun(appServer, undefined, {
    status: (label) => statuses.push(label),
    call: async () => ({
      ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1,
      images: [{ mediaType: "image/png", data: "QUJD" }, { mediaType: "image/png", data: "REVG" }],
    }),
  });
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(appServer.requestHandler);
  const result = await appServer.requestHandler({
    id: "call-1", method: "item/tool/call",
    params: {
      threadId: "thread-1", turnId: "turn-1", callId: "call-1",
      tool: "roblox_studio", arguments: { operation: "get_place_info", arguments: {} },
    },
  });
  // The model is told it has not seen them, rather than handed base64 it cannot read.
  assert.deepEqual(result, {
    success: true,
    contentItems: [{
      type: "inputText",
      text: '{"operation":"get_place_info","ok":true,"data":{}}'
        + "\n\n[This result had 2 images, but Roqer could not attach them, so you have not seen them. Do not describe or judge them.]",
    }],
  });
  assert.deepEqual(statuses, ["Images not shown to ChatGPT"]);
  // A refused attachment is not a failed run.
  appServer.notificationListener?.({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.equal(await run, "ChatGPT turn completed.");
});

test("ChatGPT ends a turn that makes no progress and interrupts it", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer, undefined, { stallMs: 30 });
  const rejected = assert.rejects(run, /stopped responding.*Nothing was changed in Studio/);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await rejected;
  assert.deepEqual(appServer.requests.filter(({ method }) => method === "turn/interrupt"), [
    { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
  ]);
  assert.equal(appServer.requestHandler, null);
});

test("ChatGPT does not count a question the user is still reading as a stall", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer, undefined, {
    stallMs: 300,
    askUser: async (_question, options) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return options[1];
    },
  });
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(appServer.requestHandler);
  const answer = await appServer.requestHandler({
    id: "question-1", method: "item/tool/call",
    params: { threadId: "thread-1", tool: "ask_user", arguments: { question: "Which?", options: ["A", "B"] } },
  });
  assert.match(JSON.stringify(answer), /The user answered: B/);
  appServer.notificationListener?.({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.equal(await run, "ChatGPT turn completed.");
});

test("ChatGPT keeps tool handlers alive through a retryable error", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  appServer.notificationListener?.({
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "Reconnecting..." } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(appServer.requestHandler);
  const result = await appServer.requestHandler({
    id: "skill-after-retry", method: "item/tool/call",
    params: { threadId: "thread-1", tool: "load_skill", arguments: { name: "roblox-test" } },
  });
  const skillResult = JSON.stringify(result);
  assert.match(skillResult, /"success":true/);
  assert.match(skillResult, /# Test skill/);
  appServer.notificationListener?.({
    method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "message-1", delta: "Recovered." },
  });
  appServer.notificationListener?.({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.equal(await run, "Recovered.");
  assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), false);
  assert.equal(appServer.requestHandler, null);
  assert.equal(appServer.disconnectListener, null);
});

test("ChatGPT answers a malformed Studio call to the model instead of ending the run", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(appServer.requestHandler);
  const studio = (id: string, args: Record<string, unknown>) => appServer.requestHandler!({
    id, method: "item/tool/call", params: { threadId: "thread-1", tool: "roblox_studio", arguments: args },
  });

  const malformed = JSON.stringify(await studio("bad-1", { operation: "insert_asset", assetId: 100967450390171 }));
  assert.match(malformed, /"success":false/);
  assert.match(malformed, /assetId arrived beside operation; move it inside arguments/);
  const corrected = JSON.stringify(await studio("good-1", { operation: "get_place_info", arguments: {} }));
  assert.match(corrected, /"success":true/);

  appServer.notificationListener?.({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.equal(await run, "ChatGPT turn completed.");
  assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), false);
});

test("ChatGPT ends a run whose model keeps sending malformed Studio calls", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  const rejected = assert.rejects(run, /3 malformed tool calls in a row.*arguments is missing/);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(appServer.requestHandler);
  for (let index = 0; index < 3; index += 1) {
    await appServer.requestHandler({
      id: `bad-${index}`, method: "item/tool/call",
      params: { threadId: "thread-1", tool: "roblox_studio", arguments: { operation: "get_place_info" } },
    });
  }
  await rejected;
});

for (const [type, described] of [
  ["commandExecution", "shell"],
  ["mcpToolCall", "MCP servers"],
  ["someToolCodexAddsLater", "\"someToolCodexAddsLater\" tool"],
] as const) {
  test(`ChatGPT stops a turn that starts Codex's built-in ${described}`, async () => {
    const appServer = new ManualAppServer();
    const run = lifecycleRun(appServer);
    const rejected = assert.rejects(run, (error: Error) => {
      assert.match(error.message, new RegExp(`Codex's built-in ${described.replace(/"/g, '\\"')}, which Roqer does not allow`));
      return true;
    });
    await appServer.turnStarted.promise;
    appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
    await new Promise((resolve) => setImmediate(resolve));
    appServer.notificationListener?.({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type } },
    });
    await rejected;
    assert.deepEqual(appServer.requests.filter(({ method }) => method === "turn/interrupt"), [
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
    ]);
    assert.equal(appServer.requestHandler, null);
  });
}

test("ChatGPT lets its own messages, reasoning, and Roqer's tools through", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  for (const type of ["reasoning", "agentMessage", "dynamicToolCall", "plan", "contextCompaction"]) {
    appServer.notificationListener?.({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: `item-${type}`, type } },
    });
  }
  appServer.notificationListener?.({
    method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.equal(await run, "ChatGPT turn completed.");
  assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), false);
});

test("ChatGPT fails and releases handlers when its app-server disconnects", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  const rejected = assert.rejects(run, /app-server exited/);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  appServer.disconnectListener?.(new Error("Codex app-server exited (1)."));
  await rejected;
  assert.equal(appServer.requestHandler, null);
  assert.equal(appServer.notificationListener, null);
  assert.equal(appServer.disconnectListener, null);
  assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), false);
});

test("ChatGPT interrupts terminal errors and releases handlers", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  const rejected = assert.rejects(run, /Rate limit/);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  appServer.notificationListener?.({
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "Rate limit" } },
  });
  await rejected;
  assert.deepEqual(appServer.requests.filter(({ method }) => method === "turn/interrupt"), [
    { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
  ]);
  assert.equal(appServer.requestHandler, null);
});

test("ChatGPT warns once as the plan nears a limit, and ends on Codex's own limit message", async () => {
  const appServer = new ManualAppServer();
  const statuses: Array<{ label: string; detail?: string }> = [];
  const run = lifecycleRun(appServer, undefined, { status: (label, detail) => statuses.push({ label, detail }) });
  const limitMessage = "You’ve hit your usage limit. Try again at 3:40 PM.";
  const rejected = assert.rejects(run, (error: Error) => error.message === limitMessage);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  // Usage is the account's, so the update carries no thread.
  const usage = (usedPercent: number) => appServer.notificationListener?.({
    method: "account/rateLimits/updated",
    params: { rateLimits: { limitId: "codex", primary: { usedPercent, windowDurationMins: 300, resetsAt: null }, secondary: null } },
  });
  usage(62);
  usage(84);
  usage(91);
  assert.deepEqual(statuses, [{
    label: "Close to your ChatGPT usage limit",
    detail: "5-hour limit: 84% used. The run stops if the limit is reached.",
  }]);

  appServer.notificationListener?.({
    method: "error",
    params: {
      threadId: "thread-1", turnId: "turn-1", willRetry: false,
      error: { message: limitMessage, codexErrorInfo: "usageLimitExceeded" },
    },
  });
  await rejected;
});

test("ChatGPT cancellation before turn/start responds settles promptly and interrupts its late turn", async () => {
  const appServer = new ManualAppServer();
  const controller = new AbortController();
  const run = lifecycleRun(appServer, controller.signal);
  const rejected = assert.rejects(run, /cancelled/);
  await appServer.turnStarted.promise;
  controller.abort();
  await rejected;
  assert.equal(appServer.requestHandler, null);
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(appServer.requests.filter(({ method }) => method === "turn/interrupt"), [
    { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
  ]);
});

test("ChatGPT disconnect before turn/start responds settles without restarting Codex", async () => {
  const appServer = new ManualAppServer();
  const run = lifecycleRun(appServer);
  const rejected = assert.rejects(run, /pipe closed/);
  await appServer.turnStarted.promise;
  appServer.disconnectListener?.(new Error("pipe closed"));
  await rejected;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appServer.requests.some(({ method }) => method === "turn/interrupt"), false);
});

test("a real app-server client propagates a mid-turn child exit to the ChatGPT planner", async () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const turnStarted = pendingValue<void>();
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, index)) as { id?: number; method: string };
      buffer = buffer.slice(index + 1);
      const result = message.method === "account/read" ? { account: { type: "chatgpt" } }
        : message.method === "thread/start" ? { thread: { id: "thread-1" } }
          : message.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      if (message.id !== undefined) child.stdout.push(`${JSON.stringify({ id: message.id, result })}\n`);
      if (message.method === "turn/start") turnStarted.resolve();
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  } });
  const run = lifecycleRun(client);
  const rejected = assert.rejects(run, /Codex app-server exited \(1\)/);
  await turnStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 1, null);
  await rejected;
  client.close();
});

/** An app-server stand-in whose every turn answers at once with one message. */
class AnsweringAppServer extends FakeAppServer {
  threadsStarted = 0;
  readonly turnInputs: Array<{ threadId: unknown; text: string; model: unknown }> = [];

  override async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      this.threadsStarted += 1;
      return { thread: { id: `thread-${this.threadsStarted}` } } as T;
    }
    if (method === "turn/start") {
      const turn = params as { threadId: string; model: string; input: Array<{ text: string }> };
      this.turnInputs.push({ threadId: turn.threadId, text: turn.input[0].text, model: turn.model });
      const answer = `Answer ${this.turnInputs.length}`;
      setImmediate(() => {
        this.notificationListener?.({
          method: "item/agentMessage/delta",
          params: { threadId: turn.threadId, itemId: `message-${this.turnInputs.length}`, delta: answer },
        });
        this.notificationListener?.({
          method: "turn/completed",
          params: { threadId: turn.threadId, turn: { id: "turn", status: "completed" } },
        });
      });
      return { turn: { id: "turn" } } as T;
    }
    return {} as T;
  }
}

function sessionRun(
  appServer: ChatGptAppServer,
  sessions: CodexThreadStore,
  prompt: string,
  messages: PlannerContext["conversation"]["messages"],
  model = "gpt-test",
  instanceId: string | null = null,
  runUsage: PlannerContext["runUsage"] = () => undefined,
) {
  const context: PlannerContext = {
    prompt, conversation: { messages, truncated: false }, images: [],
    instanceId, autoPlaytest: false, signal: new AbortController().signal,
    progress: () => undefined, outputTokens: () => undefined, contextUsage: () => undefined, runUsage, status: () => undefined, say: () => undefined,
    recordChange: () => undefined, recordEvidence: () => undefined, setTasks: () => undefined,
    tasks: () => [], changes: () => [], evidence: () => [], decisions: () => [], takeSteers: () => [],
    askUser: async (_question, options) => options[0],
    checkCompletion: () => ({ verified: true, issues: [] }),
    call: async () => ({ ok: true, data: {}, text: "", httpStatus: 200, durationMs: 1 }),
  };
  return createChatGptPlanner({
    appServer, cwd: "C:\\workbench", model, effort: "medium", agent: AGENT, skillLibrary: SKILLS,
    chatId: "chat-1", sessions,
  }).run(context);
}

test("ChatGPT keeps a chat's thread for its next message and sends only the new prompt", async () => {
  const appServer = new AnsweringAppServer();
  const sessions = new ProviderSessionStore<CodexThread>();

  assert.equal(await sessionRun(appServer, sessions, "Build the shop.", []), "Answer 1");
  assert.equal(await sessionRun(appServer, sessions, "Add a button.", [
    { role: "user", text: "Build the shop." },
    { role: "assistant", text: "Answer 1" },
  ], "gpt-other"), "Answer 2");

  assert.equal(appServer.threadsStarted, 1);
  assert.deepEqual(appServer.turnInputs.map(({ threadId }) => threadId), ["thread-1", "thread-1"]);
  assert.equal(appServer.turnInputs[1].text, "Add a button.");
  // Codex takes the model per turn, so changing it keeps the conversation.
  assert.equal(appServer.turnInputs[1].model, "gpt-other");
});

/** Reports the thread's running token totals, which grow by the same amount every turn. */
class CountingAppServer extends AnsweringAppServer {
  private readonly turnsByThread = new Map<string, number>();

  override async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === "turn/start") {
      const { threadId } = params as { threadId: string };
      const turns = (this.turnsByThread.get(threadId) ?? 0) + 1;
      this.turnsByThread.set(threadId, turns);
      // Queued ahead of the answer, which the base class sends on a later tick.
      setImmediate(() => this.notificationListener?.({
        method: "thread/tokenUsage/updated",
        params: {
          threadId, turnId: "turn",
          tokenUsage: {
            total: { totalTokens: turns * 1_100, inputTokens: turns * 1_000, cachedInputTokens: turns * 800, outputTokens: turns * 100, reasoningOutputTokens: turns * 50 },
            last: { totalTokens: 1_100, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 50 },
            modelContextWindow: null,
          },
        },
      }));
    }
    return super.request<T>(method, params);
  }
}

test("ChatGPT reports a run's usage from the thread's totals, and a kept thread's next run only its own", async () => {
  const appServer = new CountingAppServer();
  const sessions = new ProviderSessionStore<CodexThread>();
  const reported: RunUsage[] = [];
  const record = (usage: RunUsage) => { reported.push(usage); };

  await sessionRun(appServer, sessions, "Build the shop.", [], "gpt-test", null, record);
  await sessionRun(appServer, sessions, "Add a button.", [
    { role: "user", text: "Build the shop." },
    { role: "assistant", text: "Answer 1" },
  ], "gpt-test", null, record);

  assert.equal(appServer.threadsStarted, 1);
  const expected = { inputTokens: 200, cacheReadTokens: 800, outputTokens: 100 };
  assert.deepEqual(reported, [expected, expected], "the second run does not count the first run's tokens again");

  const totals = (total: unknown) => codexUsageTotals({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total } } });
  assert.equal(totals({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 1 }), null, "the cached part cannot exceed the input");
  assert.equal(totals({ inputTokens: 10, cachedInputTokens: "1", outputTokens: 1 }), null);
  assert.equal(totals(undefined), null);
  assert.equal(codexRunUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }, { inputTokens: 9, cachedInputTokens: 0, outputTokens: 6 }), null, "totals do not go down");
});

test("ChatGPT starts a new thread when the chat moved on without it", async () => {
  const appServer = new AnsweringAppServer();
  const sessions = new ProviderSessionStore<CodexThread>();

  await sessionRun(appServer, sessions, "Build the shop.", []);
  await sessionRun(appServer, sessions, "Continue.", [
    { role: "user", text: "Build the shop." },
    { role: "assistant", text: "Answer 1" },
    { role: "user", text: "Asked on another provider" },
    { role: "assistant", text: "Other answer" },
  ]);

  assert.equal(appServer.threadsStarted, 2);
  assert.match(appServer.turnInputs[1].text, /Asked on another provider/);
});

test("ChatGPT starts a new thread when the chat moved to another Studio place", async () => {
  const appServer = new AnsweringAppServer();
  const sessions = new ProviderSessionStore<CodexThread>();

  await sessionRun(appServer, sessions, "Build the shop.", [], "gpt-test", "place:1");
  await sessionRun(appServer, sessions, "Add a button.", [
    { role: "user", text: "Build the shop." },
    { role: "assistant", text: "Answer 1" },
  ], "gpt-test", "place:2");

  // The first thread read place 1; it is not carried into a run against place 2.
  assert.equal(appServer.threadsStarted, 2);
  assert.match(appServer.turnInputs[1].text, /Prior conversation context/);
});

/**
 * An app-server stand-in whose every turn loads the UI skill through Roqer, and
 * which can report a compaction in either of the shapes Codex uses.
 */
class SkillLoadingAppServer extends FakeAppServer {
  threadsStarted = 0;
  readonly turnTexts: string[] = [];
  readonly skillTexts: string[] = [];
  compaction: "none" | "notification" | "item" = "none";

  override async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      this.threadsStarted += 1;
      return { thread: { id: `thread-${this.threadsStarted}` } } as T;
    }
    if (method === "turn/start") {
      const turn = params as { threadId: string; input: Array<{ text: string }> };
      this.turnTexts.push(turn.input[0].text);
      setImmediate(() => void this.answer(turn.threadId));
      return { turn: { id: "turn" } } as T;
    }
    return {} as T;
  }

  private async answer(threadId: string): Promise<void> {
    const handler = this.requestHandler;
    assert.ok(handler);
    const result = await handler({
      id: `skill-${this.skillTexts.length}`,
      method: "item/tool/call",
      params: { threadId, turnId: "turn", tool: "load_skill", arguments: { name: "roblox-ui-design" } },
    });
    this.skillTexts.push(JSON.stringify(result));
    if (this.compaction === "notification") {
      this.notificationListener?.({ method: "thread/compacted", params: { threadId, turnId: "turn" } });
    } else if (this.compaction === "item") {
      this.notificationListener?.({
        method: "item/completed",
        params: { threadId, turnId: "turn", item: { type: "contextCompaction", id: "compaction-1" } },
      });
    }
    this.compaction = "none";
    this.notificationListener?.({
      method: "item/agentMessage/delta",
      params: { threadId, itemId: `message-${this.skillTexts.length}`, delta: `Answer ${this.skillTexts.length}` },
    });
    this.notificationListener?.({
      method: "turn/completed", params: { threadId, turn: { id: "turn", status: "completed" } },
    });
  }
}

const SHOP_EXCHANGE: PlannerContext["conversation"]["messages"] = [
  { role: "user", text: "Build a shop menu" },
  { role: "assistant", text: "Answer 1" },
];

test("ChatGPT keeps delivered skills with the chat's thread and a UI follow-up is told so", async () => {
  const appServer = new SkillLoadingAppServer();
  const sessions = new ProviderSessionStore<CodexThread>();

  assert.equal(await sessionRun(appServer, sessions, "Build a shop menu", []), "Answer 1");
  assert.equal(await sessionRun(appServer, sessions, "Make the shop panel wider", SHOP_EXCHANGE), "Answer 2");

  assert.equal(appServer.threadsStarted, 1);
  assert.match(appServer.skillTexts[0], /# Test skill/);
  assert.match(appServer.turnTexts[0], /Load `roblox-ui-design` before any Studio mutation/);
  assert.match(appServer.turnTexts[1], /`roblox-ui-design` is already loaded in this conversation/);
  // The thread still holds the document, so a repeat request is a pointer.
  assert.doesNotMatch(appServer.skillTexts[1], /# Test skill/);
  assert.match(appServer.skillTexts[1], /already loaded earlier in this conversation/);
});

for (const compaction of ["notification", "item"] as const) {
  test(`ChatGPT forgets delivered skills when Codex reports a compaction (${compaction})`, async () => {
    const appServer = new SkillLoadingAppServer();
    const sessions = new ProviderSessionStore<CodexThread>();

    appServer.compaction = compaction;
    await sessionRun(appServer, sessions, "Build a shop menu", []);
    await sessionRun(appServer, sessions, "Make the shop panel wider", SHOP_EXCHANGE);

    assert.equal(appServer.threadsStarted, 1, "compaction keeps the thread");
    assert.match(appServer.turnTexts[1], /Load `roblox-ui-design` before any Studio mutation/);
    assert.match(appServer.skillTexts[1], /# Test skill/, "the guidance is delivered again in full");
  });
}

test("ChatGPT does not keep a thread whose turn failed", async () => {
  const appServer = new ManualAppServer();
  const sessions = new ProviderSessionStore<CodexThread>();
  const run = sessionRun(appServer, sessions, "Build the shop.", []);
  const rejected = assert.rejects(run, /Rate limit/);
  await appServer.turnStarted.promise;
  appServer.turnResponse.resolve({ turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  appServer.notificationListener?.({
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "Rate limit" } },
  });
  await rejected;
  assert.equal(sessions.size, 0);
});

test("Codex's stream is counted for the waiting line: what streamed, then Codex's own figure per response", () => {
  const note = (method: string, params: Record<string, unknown>) => codexStreamedOutput({ method, params: { threadId: "thread-1", ...params } });

  assert.deepEqual(note("item/agentMessage/delta", { itemId: "m1", delta: "Adding it." }), { characters: 10 });
  assert.deepEqual(note("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Planning", summaryIndex: 0 }), { characters: 8 });
  assert.deepEqual(note("item/reasoning/textDelta", { itemId: "r1", delta: "Plan", contentIndex: 0 }), { characters: 4 });
  assert.deepEqual(note("thread/tokenUsage/updated", {
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 9_000, inputTokens: 8_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000, reasoningOutputTokens: 800 },
      last: { totalTokens: 3_000, inputTokens: 2_600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 300 },
      modelContextWindow: null,
    },
  }), { exact: 400 }, "the last response's count, not the thread's running total");
  assert.deepEqual(note("item/started", { item: { type: "dynamicToolCall", id: "call-1" } }), { ended: true });
  assert.equal(note("item/started", { item: { type: "reasoning", id: "r2" } }), null);
  assert.equal(note("item/agentMessage/delta", { itemId: "m1", delta: "" }), null);
  assert.equal(note("thread/tokenUsage/updated", { tokenUsage: { last: { outputTokens: "400" } } }), null);
});

test("Codex's context is its last response's total, against the window it reports", () => {
  const usage = (tokenUsage: unknown) => codexContextUsage({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage } });
  const last = { totalTokens: 3_000, inputTokens: 2_600, cachedInputTokens: 2_000, outputTokens: 400, reasoningOutputTokens: 300 };
  const total = { totalTokens: 9_000, inputTokens: 8_000, cachedInputTokens: 0, outputTokens: 1_000, reasoningOutputTokens: 800 };

  assert.deepEqual(usage({ total, last, modelContextWindow: 272_000 }), { usedTokens: 3_000, windowTokens: 272_000 }, "not the thread's running total");
  assert.deepEqual(usage({ total, last, modelContextWindow: null }), { usedTokens: 3_000, windowTokens: null });
  assert.deepEqual(usage({ total, last, modelContextWindow: -5 }), { usedTokens: 3_000, windowTokens: null });
  assert.equal(usage({ total, last: { ...last, totalTokens: "3000" }, modelContextWindow: 272_000 }), null);
  assert.equal(usage({ total }), null);
  assert.equal(codexContextUsage({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: "Hi" } }), null);
});
