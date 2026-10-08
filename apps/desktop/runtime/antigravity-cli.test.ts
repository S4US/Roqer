import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AntigravityClient, antigravityStatusFrom, ANTIGRAVITY_SIGN_IN_MESSAGE, parseAntigravityModels,
} from "./antigravity-cli";
import { resolveAntigravityExecutable } from "./antigravity-executable";
import { parseAntigravityUsage } from "./antigravity-limits";
import { ClientNotInstalledError } from "./client-not-installed";
import { FakeChildProcess } from "./test-child-process";

/** `agy --print /usage --output-format json`, as 1.3.1 answers it for a signed-in account. */
const USAGE_ENVELOPE = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-14T15:13:21Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [{
        name: "Gemini Models",
        buckets: [
          { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.75, reset_time: "2026-10-14T15:13:21Z" },
          { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9, reset_time: "2026-10-08T15:45:16Z" },
        ],
      }, {
        name: "Claude and GPT models",
        buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-15T10:56:15Z" }],
      }],
    },
  },
};

const MODELS_OUTPUT = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "",
].join("\n");

test("a well-formed /usage answer is a signed-in account", () => {
  const status = antigravityStatusFrom({ stdout: JSON.stringify(USAGE_ENVELOPE), stderr: "Fetching...", code: 0 });
  assert.equal(status.kind, "signed-in");
});

test("anything but a well-formed /usage answer is not signed in", () => {
  const signedOut = antigravityStatusFrom({
    stdout: JSON.stringify({ status: "ERROR", error: "You are not signed in. Run agy to sign in." }),
    stderr: "",
    code: 3,
  });
  assert.deepEqual(signedOut, { kind: "signed-out", message: ANTIGRAVITY_SIGN_IN_MESSAGE });

  const failing = antigravityStatusFrom({ stdout: "", stderr: "network unreachable", code: 3 });
  assert.equal(failing.kind, "unavailable");
  assert.match(failing.message, /network unreachable/);

  // Even a successful exit with the wrong command's answer is not an account.
  const other = antigravityStatusFrom({ stdout: JSON.stringify({ status: "SUCCESS", command: { name: "model", data: {} } }), stderr: "", code: 0 });
  assert.equal(other.kind, "unavailable");
});

test("the model listing keeps agy's slugs, labels and order", () => {
  const catalog = parseAntigravityModels(`Fetching available models...\n${MODELS_OUTPUT}not a model line\n`);
  assert.deepEqual(catalog.models.map((model) => [model.id, model.displayName]), [
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
    ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ]);
  assert.equal(catalog.defaultModelId, "gemini-3.8-flash-high");
  assert.ok(catalog.models.every((model) => model.supportedReasoningEfforts.length === 1));
});

test("the meter reads the first group's five-hour and weekly windows", () => {
  const report = parseAntigravityUsage(USAGE_ENVELOPE.command.data);
  assert.ok(report);
  assert.deepEqual(report.windows.map((window) => [window.windowMinutes, Math.round(window.usedPercent)]), [[300, 10], [10080, 25]]);
  assert.equal(report.windows[0].resetsAt, Date.parse("2026-10-08T15:45:16Z"));
  assert.equal(report.limitReached, false);
  assert.equal(parseAntigravityUsage({ groups: [{ buckets: [{ window: "monthly", remaining_fraction: 0.5 }] }] }), null);
  assert.equal(parseAntigravityUsage(null), null);
});

test("status and models are asked in a private home that is removed afterwards", async () => {
  const launched: Array<{ args: string[]; cwd: string; home: string | undefined; apiKey: string | undefined }> = [];
  process.env.GEMINI_API_KEY = "should-not-reach-agy";
  try {
    const client = new AntigravityClient({
      spawnProcess: (args, options) => {
        launched.push({ args, cwd: options.cwd, home: options.env.USERPROFILE, apiKey: options.env.GEMINI_API_KEY });
        const child = new FakeChildProcess();
        setImmediate(() => {
          child.writeLine(args[0] === "models" ? MODELS_OUTPUT : JSON.stringify(USAGE_ENVELOPE));
          child.finish(0);
        });
        return child.asChild();
      },
    });

    assert.equal((await client.getStatus()).kind, "signed-in");
    // A signed-in answer is reused rather than asked again.
    assert.equal((await client.getStatus()).kind, "signed-in");
    const catalog = await client.listModels();
    assert.equal(catalog.models.length, 3);

    assert.deepEqual(launched.map((entry) => entry.args), [["--print", "/usage", "--output-format", "json"], ["models"]]);
    for (const entry of launched) {
      assert.ok(entry.home !== undefined && entry.home !== os.homedir());
      assert.equal(path.dirname(entry.cwd), path.dirname(entry.home!));
      assert.equal(entry.apiKey, undefined);
      await assert.rejects(() => fs.access(path.dirname(entry.home!)));
    }
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test("a signed-out answer is reused briefly, and forgetting it asks again", async () => {
  let now = 0;
  let asked = 0;
  const client = new AntigravityClient({
    now: () => now,
    spawnProcess: () => {
      asked += 1;
      const child = new FakeChildProcess();
      setImmediate(() => {
        child.writeLine(JSON.stringify({ status: "ERROR", error: "Not signed in." }));
        child.finish(3);
      });
      return child.asChild();
    },
  });
  assert.equal((await client.getStatus()).kind, "signed-out");
  now = 10_000;
  assert.equal((await client.getStatus()).kind, "signed-out");
  assert.equal(asked, 1);
  // Connect forgets it: the user may just have signed in from a terminal.
  client.forgetStatus();
  await client.getStatus();
  assert.equal(asked, 2);
  now = 60_000;
  await client.getStatus();
  assert.equal(asked, 3);
});

test("a missing agy reads as not installed", async () => {
  const client = new AntigravityClient({
    spawnProcess: () => {
      throw new ClientNotInstalledError("not here");
    },
  });
  const status = await client.getStatus();
  assert.equal(status.kind, "not-installed");
  const catalog = await client.listModels();
  assert.deepEqual(catalog.models, []);
});

test("agy is found where Google's installer puts it, or by override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-lookup-"));
  try {
    const bin = path.win32.join(root, "agy", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.win32.join(bin, "agy.exe"), "");
    assert.equal(
      await resolveAntigravityExecutable({ env: { LOCALAPPDATA: root, PATH: "" }, platform: "win32" }),
      path.win32.join(bin, "agy.exe"),
    );
    assert.equal(
      await resolveAntigravityExecutable({ env: { WORKBENCH_ANTIGRAVITY_EXECUTABLE: "C:\\tools\\agy.exe" }, platform: "win32" }),
      "C:\\tools\\agy.exe",
    );
    await assert.rejects(
      () => resolveAntigravityExecutable({ env: { LOCALAPPDATA: path.join(root, "missing"), PATH: "" }, platform: "win32" }),
      ClientNotInstalledError,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
