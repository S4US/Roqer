import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCodeClient, parseClaudeModels } from "./claude-cli";
import { ClientNotInstalledError } from "./client-not-installed";
import { FakeChildProcess } from "./test-child-process";

/** Script one child per spawn, in order, and record the arguments used. */
function scripted(...steps: Array<(child: FakeChildProcess) => void>) {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    spawnProcess: (args: string[]) => {
      calls.push(args);
      const child = new FakeChildProcess();
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      queueMicrotask(() => step(child));
      return child.asChild();
    },
  };
}

function statusStep(payload: unknown, code = 0) {
  return (child: FakeChildProcess) => {
    child.stdout.write(JSON.stringify(payload, null, 2));
    child.finish(code);
  };
}

test("Claude status reports the connected subscription", async () => {
  const script = scripted(statusStep({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "builder@example.com",
    subscriptionType: "pro",
  }));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const status = await client.getStatus();
  assert.deepEqual(script.calls, [["auth", "status", "--json"]]);
  assert.equal(status.kind, "signed-in");
  assert.equal(status.kind === "signed-in" ? status.email : null, "builder@example.com");
  assert.equal(status.kind === "signed-in" ? status.planType : null, "pro");
  assert.match(status.message, /Pro connected through Claude Code/);
});

test("Claude status treats the signed-out payload as signed out, not as a failure", async () => {
  // `claude auth status` exits non-zero when signed out but still prints JSON.
  const script = scripted(statusStep({ loggedIn: false, authMethod: "none" }, 1));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const status = await client.getStatus();
  assert.equal(status.kind, "signed-out");
});

test("Claude status refuses a Console login because Roqer accepts subscriptions only", async () => {
  const script = scripted(statusStep({ loggedIn: true, authMethod: "console", email: "dev@example.com" }));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const status = await client.getStatus();
  assert.equal(status.kind, "signed-out");
  assert.match(status.message, /Connect your Claude subscription/);
});

test("Claude status surfaces unreadable output instead of claiming a sign-in", async () => {
  const script = scripted((child) => {
    child.stderr.write("claude: command failed");
    child.finish(1);
  });
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const status = await client.getStatus();
  assert.equal(status.kind, "unavailable");
});

test("Claude status tells a missing Claude Code from a failing one, and notices it once installed", async () => {
  let installed = false;
  const client = new ClaudeCodeClient({
    spawnProcess: () => {
      if (!installed) throw new ClientNotInstalledError("Claude Code could not be found.");
      const child = new FakeChildProcess();
      queueMicrotask(() => statusStep({ loggedIn: false, authMethod: "none" }, 1)(child));
      return child.asChild();
    },
  });

  const missing = await client.getStatus();
  assert.equal(missing.kind, "not-installed");
  assert.match(missing.message, /Claude Code was not found on this computer/);

  installed = true;
  assert.equal((await client.getStatus()).kind, "signed-out");
});

test("Claude status keeps a client that fails to launch unavailable, not missing", async () => {
  const client = new ClaudeCodeClient({
    spawnProcess: () => {
      throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    },
  });

  const status = await client.getStatus();
  assert.equal(status.kind, "unavailable");
  assert.match(status.message, /EACCES/);
});

/**
 * A message used to start `claude auth status` three times in a row before
 * anything reached the model: to admit the run, inside the model listing, and
 * in the planner.
 */
test("A connected Claude status is shared and reused rather than read for every caller", async () => {
  let now = 0;
  const signedIn = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" };
  const script = scripted(statusStep(signedIn));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess, now: () => now });

  const [first, second] = await Promise.all([client.getStatus(), client.getStatus()]);
  assert.equal(first.kind, "signed-in");
  assert.deepEqual(second, first);
  assert.equal(script.calls.length, 1, "callers that arrive together share one process");

  now += 29_000;
  assert.equal((await client.getStatus()).kind, "signed-in");
  assert.equal(script.calls.length, 1, "a recent sign-in is reused");

  now += 2_000;
  await client.getStatus();
  assert.equal(script.calls.length, 2, "an old one is read again");
});

test("A signed-out or unreadable Claude status is read again every time", async () => {
  const script = scripted(statusStep({ loggedIn: false, authMethod: "none" }, 1));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  assert.equal((await client.getStatus()).kind, "signed-out");
  assert.equal((await client.getStatus()).kind, "signed-out");
  // Signing in from a terminal must be noticed on the next read.
  assert.equal(script.calls.length, 2);
});

test("Signing in through Roqer never reports a status cached before it", async () => {
  const script = scripted(
    statusStep({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }),
    (child) => {
      child.write("visit: https://claude.com/cai/oauth/authorize?code=true\n");
      child.stdin.once("data", () => child.finish(0));
    },
    statusStep({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
  );
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  assert.match((await client.getStatus()).message, /Pro connected/);
  await client.beginLogin();
  const result = await client.submitLoginCode("code-123#state");

  assert.match(result.message, /Max connected/, "the new account was read, not the cached one");
  assert.match((await client.getStatus()).message, /Max connected/);
  assert.equal(script.calls.length, 3);
});

test("Claude sign-in returns the authorization URL and finishes with a pasted code", async () => {
  const script = scripted(
    // The login child terminates the URL, then prints a prompt without a newline.
    (child) => {
      child.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ");
      child.stdin.once("data", () => child.finish(0));
    },
    statusStep({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
  );
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const login = await client.beginLogin();
  assert.equal(login.authUrl, "https://claude.com/cai/oauth/authorize?code=true");
  assert.deepEqual(script.calls[0], ["auth", "login", "--claudeai"]);

  const result = await client.submitLoginCode("code-123#state");
  assert.equal(result.ok, true);
  assert.match(result.message, /Max connected through Claude Code/);
});

test("Claude sign-in rejects a code that was never asked for, and malformed codes", async () => {
  const script = scripted((child) => {
    child.write("visit: https://claude.com/cai/oauth/authorize\n");
  });
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const early = await client.submitLoginCode("code-123");
  assert.equal(early.ok, false);

  await client.beginLogin();
  const malformed = await client.submitLoginCode("  ");
  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /authorization code/);
  client.close();
});

test("Claude sign-in waits for the complete URL across output chunks", async () => {
  const child = new FakeChildProcess();
  const client = new ClaudeCodeClient({ spawnProcess: () => child.asChild() });
  let settled = false;
  const login = client.beginLogin().then((result) => {
    settled = true;
    return result;
  });
  const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    await nextTick();
    for (const chunk of ["Visit https://cla", "ude.com/cai/oauth/authorize?client_", "id=test&state=abc"]) {
      child.write(chunk);
      await nextTick();
      assert.equal(settled, false, "an unterminated URL must not open the browser");
    }
    child.write("\nPaste code here if prompted > ");
    assert.equal((await login).authUrl, "https://claude.com/cai/oauth/authorize?client_id=test&state=abc");
  } finally {
    client.close();
    child.kill();
    await login.catch(() => undefined);
  }
});

test("Claude sign-in bounds output while waiting for a complete URL", async () => {
  const child = new FakeChildProcess();
  const client = new ClaudeCodeClient({ spawnProcess: () => child.asChild() });
  const rejected = assert.rejects(client.beginLogin(), /too much sign-in output/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.write(`https://claude.com/${"x".repeat(64 * 1024)}`);
  await rejected;
  assert.equal(child.killed, true);
  client.close();
});

test("The Claude model catalog is only offered to a connected account", async () => {
  const script = scripted(statusStep({ loggedIn: false, authMethod: "none" }, 1));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const catalog = await client.listModels();
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.defaultModelId, null);
});

/** The shape Claude Code 2.1 answers `initialize` with, trimmed to the model list. */
const INITIALIZE_MODELS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks · ~2× usage vs Sonnet",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max", "turbo"],
  },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
];

function initializeStep(models: unknown) {
  return (child: FakeChildProcess) => {
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as { type: string; request_id: string; request: { subtype: string } };
        assert.equal(request.type, "control_request");
        assert.equal(request.request.subtype, "initialize");
        child.writeLine({ type: "system", subtype: "status" });
        child.writeLine({
          type: "control_response",
          response: { subtype: "success", request_id: request.request_id, response: { models } },
        });
      }
    });
  };
}

const SIGNED_IN = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" };

/** Answer `initialize` and then `get_usage`, recording each request as Claude Code received it. */
function usageStep(answer: (request: Record<string, unknown>) => Record<string, unknown>, received: Array<Record<string, unknown>>) {
  return (child: FakeChildProcess) => {
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { type: string; request_id: string; request: Record<string, unknown> };
        assert.equal(message.type, "control_request");
        received.push(message.request);
        const response = message.request.subtype === "initialize"
          ? { subtype: "success", request_id: message.request_id, response: { models: [] } }
          : { request_id: message.request_id, ...answer(message.request) };
        child.writeLine({ type: "control_response", response });
      }
    });
  };
}

const CLAUDE_USAGE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 38, resets_at: "2026-09-27T15:40:00Z" },
    seven_day: { utilization: 71.5, resets_at: "2026-09-30T09:00:00Z" },
  },
  behaviors: null,
};

test("Claude usage is read with get_usage after initialize, without the transcript scan", async () => {
  const received: Array<Record<string, unknown>> = [];
  const script = scripted(usageStep(() => ({ subtype: "success", response: CLAUDE_USAGE }), received));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  assert.deepEqual(await client.readUsage(), CLAUDE_USAGE);
  assert.deepEqual(received, [{ subtype: "initialize" }, { subtype: "get_usage", skip_behaviors: true }]);
  // The same short-lived, tool-less process the model listing uses.
  assert.ok(script.calls[0].includes("--print") && script.calls[0].includes("--strict-mcp-config"));
});

test("a Claude Code that does not know get_usage is an error, not an empty report", async () => {
  const script = scripted(usageStep(() => ({ subtype: "error", error: "Unknown control request subtype: get_usage" }), []));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  await assert.rejects(() => client.readUsage(), /Unknown control request subtype: get_usage/);
});

test("The Claude catalog is the list Claude Code itself offers the account", async () => {
  const script = scripted(statusStep(SIGNED_IN), initializeStep(INITIALIZE_MODELS));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const catalog = await client.listModels();

  assert.deepEqual(catalog.models.map((model) => model.id), ["opus", "sonnet", "haiku"]);
  // "default" is an alias; the entry it resolves to becomes the default instead.
  assert.equal(catalog.defaultModelId, "opus");
  assert.match(catalog.models[0].description ?? "", /2× usage vs Sonnet/);
  assert.equal(catalog.models[0].defaultReasoningEffort, "high");
  // An effort Roqer does not know is dropped rather than offered.
  assert.ok(!catalog.models[1].supportedReasoningEfforts.some((entry) => entry.reasoningEffort as string === "turbo"));
  assert.ok(script.calls[1].includes("--no-session-persistence"));
  assert.equal(client.modelSupportsEffort("opus"), true);
  assert.equal(client.modelSupportsEffort("haiku"), false, "Haiku rejects --effort, so the planner must not pass it");
  assert.equal(client.modelSupportsEffort("never-listed"), false);
});

test("A Claude listing is reused rather than starting Claude Code for every read", async () => {
  let now = 0;
  const script = scripted(
    statusStep(SIGNED_IN), initializeStep(INITIALIZE_MODELS),
    statusStep(SIGNED_IN),
    statusStep(SIGNED_IN), initializeStep(INITIALIZE_MODELS),
  );
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess, now: () => now });

  await client.listModels();
  now += 60_000;
  await client.listModels();
  assert.equal(script.calls.length, 3, "the second read only rechecked the sign-in");
  now += 10 * 60_000;
  await client.listModels();
  assert.equal(script.calls.length, 5);
});

test("A Claude Code that lists no models is reported, not shown as an empty picker", async () => {
  const script = scripted(statusStep(SIGNED_IN), initializeStep([]));
  const client = new ClaudeCodeClient({ spawnProcess: script.spawnProcess });

  const catalog = await client.listModels();
  assert.deepEqual(catalog.models, []);
  assert.match(catalog.message ?? "", /did not list any models/);
});

test("A model without effort selection still declares one effort for the picker", () => {
  const { catalog, effortModels } = parseClaudeModels([{ value: "haiku", displayName: "Haiku" }]);
  assert.equal(catalog.defaultModelId, "haiku");
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts.map((entry) => entry.reasoningEffort), ["medium"]);
  assert.equal(catalog.models[0].defaultReasoningEffort, "medium");
  assert.equal(effortModels.size, 0);
});
