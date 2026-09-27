import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { ClientNotInstalledError } from "./client-not-installed";
import { CodexAppServerClient, codexAppServerArgs, codexChildEnvironment } from "./codex-app-server";

type FakeProcess = ChildProcessWithoutNullStreams & {
  serverInput: PassThrough;
  serverOutput: PassThrough;
};

function fakeProcess(onMessage: (message: Record<string, unknown>, send: (message: unknown) => void) => void): FakeProcess {
  const process = new EventEmitter() as FakeProcess;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.serverInput = process.stdin as PassThrough;
  process.serverOutput = process.stdout as PassThrough;
  process.kill = (() => true) as FakeProcess["kill"];

  let buffer = "";
  process.serverInput.setEncoding("utf8");
  process.serverInput.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      onMessage(JSON.parse(line) as Record<string, unknown>, (message) => {
        process.serverOutput.write(`${JSON.stringify(message)}\n`);
      });
    }
  });
  queueMicrotask(() => process.emit("spawn"));
  return process;
}

test("app-server initializes and sanitizes a managed ChatGPT account", async () => {
  const methods: string[] = [];
  const child = fakeProcess((message, send) => {
    const method = typeof message.method === "string" ? message.method : "";
    methods.push(method);
    if (method === "initialize") send({ id: message.id, result: { userAgent: "test" } });
    if (method === "account/read") {
      send({
        id: message.id,
        result: { account: { type: "chatgpt", email: "player@example.com", planType: "plus" }, requiresOpenaiAuth: true },
      });
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });

  const status = await client.getChatGptStatus();

  assert.deepEqual(status, {
    kind: "signed-in",
    message: "Plus connected through Codex",
    email: "player@example.com",
    planType: "plus",
  });
  assert.deepEqual(methods.slice(0, 3), ["initialize", "initialized", "account/read"]);
  client.close();
});

test("app-server tells a missing Codex from a failing one, and notices it once installed", async () => {
  let installed = false;
  const client = new CodexAppServerClient({
    spawnProcess: () => {
      if (!installed) throw new ClientNotInstalledError("Codex could not be found.");
      return fakeProcess((message, send) => {
        if (message.method === "initialize") send({ id: message.id, result: {} });
        if (message.method === "account/read") send({ id: message.id, result: { account: null } });
      });
    },
  });

  const missing = await client.getChatGptStatus();
  assert.equal(missing.kind, "not-installed");
  assert.match(missing.message, /Codex was not found on this computer/);

  installed = true;
  assert.equal((await client.getChatGptStatus()).kind, "signed-out");
  client.close();
});

test("app-server keeps a Codex that fails to start unavailable, not missing", async () => {
  const client = new CodexAppServerClient({
    spawnProcess: () => {
      throw new Error("spawn EACCES");
    },
  });

  const status = await client.getChatGptStatus();
  assert.equal(status.kind, "unavailable");
  assert.match(status.message, /EACCES/);
});

test("app-server refuses a local API credential because Roqer accepts ChatGPT subscriptions only", async () => {
  const child = fakeProcess((message, send) => {
    if (message.method === "initialize") send({ id: message.id, result: {} });
    if (message.method === "account/read") {
      send({ id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: false } });
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });

  const status = await client.getChatGptStatus();
  assert.equal(status.kind, "signed-out");
  assert.match(status.message, /Connect your ChatGPT subscription/);
  client.close();
});

test("app-server parses browser login without exposing credentials", async () => {
  const child = fakeProcess((message, send) => {
    if (message.method === "initialize") send({ id: message.id, result: {} });
    if (message.method === "account/login/start") {
      send({ id: message.id, result: { type: "chatgpt", loginId: "login-1", authUrl: "https://chatgpt.com/auth" } });
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });

  assert.deepEqual(await client.beginChatGptLogin(), {
    loginId: "login-1",
    authUrl: "https://chatgpt.com/auth",
  });
  client.close();
});

test("app-server sanitizes the live model and effort catalog", async () => {
  const child = fakeProcess((message, send) => {
    if (message.method === "initialize") send({ id: message.id, result: {} });
    if (message.method === "model/list") {
      send({
        id: message.id,
        result: {
          data: [{
            id: "gpt-test",
            model: "provider-internal-name",
            displayName: "GPT Test",
            description: "A test model",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "Thorough" },
              { reasoningEffort: "future-effort", description: "Not understood by this client" },
            ],
          }],
          nextCursor: null,
        },
      });
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });

  assert.deepEqual(await client.listChatGptModels(), {
    models: [{
      id: "gpt-test",
      displayName: "GPT Test",
      description: "A test model",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "Thorough" },
      ],
    }],
    defaultModelId: "gpt-test",
  });
  client.close();
});

test("app-server routes server requests and preserves the JSON-RPC id", async () => {
  const child = fakeProcess((message, send) => {
    if (message.method === "initialize") send({ id: message.id, result: {} });
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();
  client.handleRequests(async (request) => request.method === "item/tool/call"
    ? { success: true, contentItems: [{ type: "inputText", text: "ok" }] }
    : undefined);

  const response = new Promise<Record<string, unknown>>((resolve) => {
    let buffer = "";
    child.serverInput.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.id === "server-7" && message.result !== undefined) resolve(message);
      }
    });
  });

  child.serverOutput.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "server-7",
    method: "item/tool/call",
    params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "roblox_studio", arguments: {} },
  })}\n`);

  const message = await response;
  assert.equal(message.id, "server-7");
  assert.deepEqual(message.result, { success: true, contentItems: [{ type: "inputText", text: "ok" }] });
  client.close();
});

test("app-server reports disconnects and rejects outstanding requests", async () => {
  const child = fakeProcess((message, send) => {
    if (message.method === "initialize") send({ id: message.id, result: {} });
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();
  const errors: string[] = [];
  client.onDisconnect((error) => errors.push(error.message));
  const request = client.request("model/list");
  const rejected = assert.rejects(request, /exited \(1\)/);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 1, null);
  child.stdout.emit("end");
  await rejected;
  assert.deepEqual(errors, ["Codex app-server exited (1)."]);
});

test("app-server ignores delayed events and tool results from an old process", async () => {
  const children: FakeProcess[] = [];
  const client = new CodexAppServerClient({ spawnProcess: () => {
    const child = fakeProcess((message, send) => {
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt" } } });
    });
    children.push(child);
    return child;
  } });
  await client.start();
  let finishTool!: (value: unknown) => void;
  client.handleRequests(() => new Promise((resolve) => { finishTool = resolve; }));
  children[0].serverOutput.write(`${JSON.stringify({ id: "old-tool", method: "item/tool/call", params: {} })}\n`);
  client.close();
  await client.start();
  const replacementInput: string[] = [];
  children[1].serverInput.on("data", (chunk: Buffer) => replacementInput.push(chunk.toString()));
  children[0].emit("exit", 0, null);
  children[0].emit("error", new Error("late old process error"));
  finishTool({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await client.getChatGptStatus()).kind, "signed-in");
  assert.equal(replacementInput.some((line) => line.includes("old-tool")), false);
  assert.equal(children.length, 2);
  client.close();
});

test("app-server handles process and pipe errors after initialization", async () => {
  for (const source of ["process", "stdin", "stdout"] as const) {
    const child = fakeProcess((message, send) => {
      if (message.method === "initialize") send({ id: message.id, result: {} });
    });
    const client = new CodexAppServerClient({ spawnProcess: () => child });
    await client.start();
    let disconnect: Error | undefined;
    client.onDisconnect((error) => { disconnect = error; });
    const emitter = source === "process" ? child : child[source];
    emitter.emit("error", new Error(`${source} unavailable`));
    assert.equal(disconnect?.message, `${source} unavailable`);
    client.close();
  }
});

test("app-server rejects a failed initialization without an unhandled rejection", async () => {
  const child = fakeProcess((message) => {
    if (message.method === "initialize") queueMicrotask(() => child.emit("error", new Error("initialization pipe failure")));
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await assert.rejects(client.start(), /initialization pipe failure/);
});

test("app-server starts with Codex's own tools turned off in a form every version accepts", () => {
  const args = codexAppServerArgs();
  assert.equal(args[0], "app-server");
  assert.equal(args.at(-1), "--stdio");
  // `--disable <name>` makes Codex exit on a name it does not know; a
  // `features` override is ignored instead, so only that form is allowed.
  assert.equal(args.includes("--disable"), false);
  const overrides = args.filter((_, index) => args[index - 1] === "-c");
  for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "computer_use", "browser_use"]) {
    assert.ok(overrides.includes(`features.${feature}=false`), feature);
  }
  assert.ok(overrides.every((value) => /^features\.[a-z0-9_]+=false$/.test(value)));
});

test("app-server runs in Roqer's own Codex home without the bridge credential", () => {
  const environment = codexChildEnvironment(
    { PATH: "/bin", CODEX_HOME: "/home/user/.codex", ROBLOX_STUDIO_AUTH_TOKEN: "secret" },
    "/data/roqer/codex",
  );
  assert.equal(environment.CODEX_HOME, "/data/roqer/codex");
  assert.equal(environment.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
  assert.equal(environment.PATH, "/bin");
  // Without a home of Roqer's own, Codex keeps whatever the user set.
  assert.equal(codexChildEnvironment({ CODEX_HOME: "/elsewhere" }).CODEX_HOME, "/elsewhere");
});

/** An app-server that answers sign-in requests and lets a test send its notifications. */
function loginServer(options: { signedIn?: () => boolean } = {}) {
  const methods: Array<{ method: string; params: unknown }> = [];
  let send: ((message: unknown) => void) | null = null;
  const child = fakeProcess((message, reply) => {
    send = reply;
    const method = typeof message.method === "string" ? message.method : "";
    methods.push({ method, params: message.params });
    if (method === "initialize") reply({ id: message.id, result: {} });
    if (method === "account/login/start") {
      reply({ id: message.id, result: { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/oauth/authorize?x=1" } });
    }
    if (method === "account/login/cancel") reply({ id: message.id, result: { status: "canceled" } });
    if (method === "account/read") {
      reply({ id: message.id, result: { account: options.signedIn?.() ? { type: "chatgpt", planType: "plus" } : null } });
    }
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  return { client, methods, notify: (method: string, params: unknown) => send?.({ method, params }) };
}

test("a ChatGPT sign-in connects the moment Codex says it completed, and only for its own login", async () => {
  const server = loginServer();
  const { loginId } = await server.client.beginChatGptLogin();
  let settled = false;
  const waited = server.client.waitForChatGptLogin(loginId, { pollMs: 60_000 }).then((result) => { settled = true; return result; });

  server.notify("account/login/completed", { loginId: "another-login", success: true, error: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  server.notify("account/login/completed", { loginId, success: true, error: null });
  assert.deepEqual(await waited, { ok: true, message: "Signed in with ChatGPT." });
  server.client.close();
});

test("a failed or cancelled ChatGPT sign-in says so, and cancelling tells Codex", async () => {
  const failed = loginServer();
  const first = await failed.client.beginChatGptLogin();
  const failing = failed.client.waitForChatGptLogin(first.loginId, { pollMs: 60_000 });
  failed.notify("account/login/completed", { loginId: first.loginId, success: false, error: "Access denied" });
  assert.deepEqual(await failing, { ok: false, message: "Access denied" });
  failed.client.close();

  const cancelled = loginServer();
  const second = await cancelled.client.beginChatGptLogin();
  const cancelling = cancelled.client.waitForChatGptLogin(second.loginId, { pollMs: 60_000 });
  await cancelled.client.cancelChatGptLogin(second.loginId);
  assert.deepEqual(await cancelling, { ok: false, message: "Sign-in cancelled." });
  assert.deepEqual(cancelled.methods.find(({ method }) => method === "account/login/cancel")?.params, { loginId: second.loginId });
  cancelled.client.close();
});

test("a ChatGPT sign-in is still noticed without Codex's notice, and gives up in time", async () => {
  let signedIn = false;
  const polled = loginServer({ signedIn: () => signedIn });
  const login = await polled.client.beginChatGptLogin();
  const noticed = polled.client.waitForChatGptLogin(login.loginId, { pollMs: 10 });
  signedIn = true;
  assert.deepEqual(await noticed, { ok: true, message: "Plus connected through Codex" });
  polled.client.close();

  const idle = loginServer();
  const stale = await idle.client.beginChatGptLogin();
  const expired = await idle.client.waitForChatGptLogin(stale.loginId, { pollMs: 60_000, timeoutMs: 20 });
  assert.equal(expired.ok, false);
  assert.match(expired.message, /not finished in time/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(idle.methods.some(({ method }) => method === "account/login/cancel"));
  idle.client.close();
});
