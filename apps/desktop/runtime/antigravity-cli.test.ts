import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AntigravityClient, antigravityCheckStatus, antigravityStatusFrom, ANTIGRAVITY_SIGN_IN_MESSAGE, parseAntigravityModels,
  type AntigravitySpawn,
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

/** What `agy` 1.3.1 prints for a headless sign-in, colour codes included. */
const SIGN_IN_URL = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591.apps.googleusercontent.com&code_challenge=abc&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code";

type Launched = { args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/**
 * A stand-in `agy` that answers the way 1.3.1 does: the auth check, the
 * headless sign-in reading its code from stdin, `models` and `/usage`.
 */
function fakeAgy(state: { signedIn: boolean; goodCode?: string }) {
  const launched: Launched[] = [];
  const updates: Launched[] = [];
  const spawnProcess: AntigravitySpawn = (args, options) => {
    // The daily `agy update` goes in a list of its own; most tests are about the rest.
    (args[0] === "update" ? updates : launched).push({ args, cwd: options.cwd, env: options.env });
    const child = new FakeChildProcess();
    const action = options.env.AGY_CLI_CDE_AUTH_ACTION;
    setImmediate(() => {
      if (action === "check") {
        if (state.signedIn) child.writeLine("Already authenticated as player@example.com.");
        child.finish(state.signedIn ? 0 : 1);
      } else if (action === "login") {
        child.write("\u001b[1mPlease visit the following URL to authorize the application:\u001b[0m\n");
        child.write(`\u001b[34m${SIGN_IN_URL}\u001b[0m\nEnter the authorization code: `);
        child.stdin.setEncoding("utf8");
        child.stdin.once("data", (code: string) => {
          if (code.trim() === state.goodCode) {
            state.signedIn = true;
            child.writeLine("Successfully authenticated.");
            child.finish(0);
          } else {
            child.writeLine("Authentication failed: failed to exchange authorization code for token: oauth2: \"invalid_grant\" \"Bad Request\"");
            child.finish(1);
          }
        });
      } else if (args[0] === "update") {
        child.writeLine("You are already on the latest version.");
        child.finish(0);
      } else if (args[0] === "models") {
        child.write(MODELS_OUTPUT);
        child.finish(0);
      } else {
        child.writeLine(JSON.stringify(USAGE_ENVELOPE));
        child.finish(0);
      }
    });
    return child.asChild();
  };
  return { launched, updates, spawnProcess };
}

test("agy's auth check reads as an account, signed in or out", () => {
  assert.deepEqual(
    antigravityCheckStatus({ stdout: "Already authenticated as player@example.com.\n", stderr: "", code: 0 }),
    { kind: "signed-in", message: "Google account connected through the Antigravity CLI", email: "player@example.com" },
  );
  assert.deepEqual(antigravityCheckStatus({ stdout: "", stderr: "", code: 1 }), { kind: "signed-out", message: ANTIGRAVITY_SIGN_IN_MESSAGE });
  // Anything else is not trusted to mean either; the caller asks another way.
  assert.equal(antigravityCheckStatus({ stdout: "Welcome to agy", stderr: "", code: 0 }), null);
  assert.equal(antigravityCheckStatus({ stdout: "", stderr: "crash", code: 2 }), null);
});

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

  const other = antigravityStatusFrom({ stdout: JSON.stringify({ status: "SUCCESS", command: { name: "model", data: {} } }), stderr: "", code: 0 });
  assert.equal(other.kind, "unavailable");
});

/** `agy models` as 1.3.1 printed it for a personal account. */
const FULL_LISTING = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "not a model line",
].join("\n");

test("each family of agy's models is one model with a choice of effort", () => {
  const { catalog, slugs } = parseAntigravityModels(FULL_LISTING);
  assert.deepEqual(catalog.models.map((model) => [model.id, model.displayName, model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort), model.defaultReasoningEffort]), [
    ["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"], "high"],
    ["gemini-3.7-flash", "Gemini 3.7 Flash", ["low", "medium", "high"], "high"],
    ["gemini-3.1-pro", "Gemini 3.1 Pro", ["low", "high"], "high"],
    // Nothing to choose: no effort row, and the name agy gives it.
    ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", ["none"], "none"],
    ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", ["none"], "none"],
    // The only variant of its family is not a choice either.
    ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", ["none"], "none"],
  ]);
  assert.equal(catalog.defaultModelId, "gemini-3.8-flash");
  assert.equal(slugs.get("gemini-3.8-flash")?.get("medium"), "gemini-3.8-flash-medium");
  assert.equal(slugs.get("gemini-3.1-pro")?.get("low"), "gemini-3.1-pro-low");
  assert.equal(slugs.get("gpt-oss-120b-medium")?.get("none"), "gpt-oss-120b-medium");
});

test("a run's model and effort become the slug agy takes", async () => {
  const fake = fakeAgy({ signedIn: true });
  const client = new AntigravityClient({
    spawnProcess: (args, options) => {
      if (args[0] !== "models") return fake.spawnProcess(args, options);
      const child = new FakeChildProcess();
      setImmediate(() => { child.write(FULL_LISTING); child.finish(0); });
      return child.asChild();
    },
  });
  await client.listModels();
  assert.equal(client.modelSlug("gemini-3.8-flash", "low"), "gemini-3.8-flash-low");
  assert.equal(client.modelSlug("gemini-3.8-flash", "high"), "gemini-3.8-flash-high");
  assert.equal(client.modelSlug("claude-sonnet-4-6", "none"), "claude-sonnet-4-6");
  // An effort the model does not list takes its first variant rather than an invented slug.
  assert.equal(client.modelSlug("gemini-3.1-pro", "medium"), "gemini-3.1-pro-low");
  assert.equal(client.modelSlug("unknown-model", "high"), "unknown-model");
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

test("status, models and usage are asked in a private home that is removed afterwards", async () => {
  process.env.GEMINI_API_KEY = "should-not-reach-agy";
  try {
    const fake = fakeAgy({ signedIn: true });
    const client = new AntigravityClient({ spawnProcess: fake.spawnProcess });

    const status = await client.getStatus();
    assert.equal(status.kind, "signed-in");
    assert.equal(status.kind === "signed-in" ? status.email : undefined, "player@example.com");
    // A signed-in answer is reused rather than asked again.
    assert.equal((await client.getStatus()).kind, "signed-in");
    assert.equal((await client.listModels()).models.length, 3);
    assert.ok(parseAntigravityUsage(await client.readUsage()));

    assert.deepEqual(fake.launched.map((entry) => [entry.args, entry.env.AGY_CLI_CDE_AUTH_ACTION]), [
      [[], "check"],
      [["models"], undefined],
      [["--print", "/usage", "--output-format", "json"], undefined],
    ]);
    for (const entry of [...fake.launched, ...fake.updates]) {
      // agy's own background updater flashes a console window; Roqer's processes keep it off.
      assert.equal(entry.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
      assert.ok(entry.env.USERPROFILE !== undefined && entry.env.USERPROFILE !== os.homedir());
      assert.equal(path.dirname(entry.cwd), path.dirname(entry.env.USERPROFILE!));
      assert.equal(entry.env.GEMINI_API_KEY, undefined);
      await assert.rejects(() => fs.access(path.dirname(entry.env.USERPROFILE!)));
    }
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test("a signed-out answer is reused briefly, and forgetting it asks again", async () => {
  let now = 0;
  const fake = fakeAgy({ signedIn: false });
  const client = new AntigravityClient({ now: () => now, spawnProcess: fake.spawnProcess });
  assert.deepEqual(await client.getStatus(), { kind: "signed-out", message: ANTIGRAVITY_SIGN_IN_MESSAGE });
  now = 10_000;
  await client.getStatus();
  assert.equal(fake.launched.length, 1);
  client.forgetStatus();
  await client.getStatus();
  assert.equal(fake.launched.length, 2);
  now = 60_000;
  await client.getStatus();
  assert.equal(fake.launched.length, 3);
});

test("signing in hands agy the code Google showed, in the user's own home, and confirms the account", async () => {
  process.env.GEMINI_API_KEY = "should-not-reach-agy";
  try {
    const state = { signedIn: false, goodCode: "4/0AGood-Code" };
    const fake = fakeAgy(state);
    const client = new AntigravityClient({ spawnProcess: fake.spawnProcess });
    assert.equal((await client.getStatus()).kind, "signed-out");

    const { authUrl } = await client.beginLogin();
    assert.equal(authUrl, SIGN_IN_URL);
    assert.equal(client.pendingLoginUrl(), SIGN_IN_URL);
    const login = fake.launched.at(-1)!;
    assert.equal(login.env.AGY_CLI_CDE_AUTH_ACTION, "login");
    // The credential goes wherever the user's own agy keeps it, not into a home Roqer deletes.
    assert.equal(login.env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(login.env.GEMINI_API_KEY, undefined);
    assert.equal(login.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");

    const waiting = client.waitForLogin();
    assert.deepEqual(await client.submitLoginCode("  4/0AGood-Code \n"), {
      ok: true, message: "Google account connected through the Antigravity CLI",
    });
    assert.equal((await waiting).ok, true);
    assert.equal(client.pendingLoginUrl(), null);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test("a code Google refuses says so, and the next Connect starts again", async () => {
  const fake = fakeAgy({ signedIn: false, goodCode: "right" });
  const client = new AntigravityClient({ spawnProcess: fake.spawnProcess });
  await client.beginLogin();
  const outcome = await client.submitLoginCode("wrong");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Google did not accept that code: Authentication failed: .*invalid_grant/);
  assert.deepEqual(await client.submitLoginCode("right"), {
    ok: false, message: "No Antigravity sign-in is waiting for a code. Choose Connect to start one.",
  });
  assert.equal((await client.submitLoginCode("has space")).ok, false);
});

test("cancelling a sign-in stops agy", async () => {
  const fake = fakeAgy({ signedIn: false });
  const client = new AntigravityClient({ spawnProcess: fake.spawnProcess });
  await client.beginLogin();
  client.cancelLogin();
  assert.equal(client.pendingLoginUrl(), null);
  assert.equal((await client.waitForLogin()).ok, false);
});

test("Roqer asks agy to update itself at most once a day, in place of agy's background updater", async () => {
  let now = 0;
  const fake = fakeAgy({ signedIn: true });
  const client = new AntigravityClient({ now: () => now, spawnProcess: fake.spawnProcess });
  await client.getStatus();
  await client.updateInBackground();
  assert.equal(fake.updates.length, 1);
  assert.deepEqual(fake.updates[0].args, ["update"]);
  now = 23 * 60 * 60_000;
  client.forgetStatus();
  await client.getStatus();
  await client.updateInBackground();
  assert.equal(fake.updates.length, 1);
  now = 25 * 60 * 60_000;
  client.forgetStatus();
  await client.getStatus();
  await client.updateInBackground();
  assert.equal(fake.updates.length, 2);
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
