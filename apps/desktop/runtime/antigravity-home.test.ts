import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ANTIGRAVITY_MCP_SERVER_NAME, antigravityChildEnvironment, attachmentDirectory, conversationDirectory, createAntigravityHome,
  GATE_REFUSAL_PREFIX, gateWrapper, readableDirectories, schemaDirectory,
} from "./antigravity-home";

const MCP = { url: "http://127.0.0.1:5000/mcp", token: "secret-token" };

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

/**
 * Run the gate the way `agy` does: the command from hooks.json, through the
 * platform's shell, from the directory that holds hooks.json, with the tool
 * call on stdin. Returns what it printed and how it exited.
 */
async function runGate(home: string, payload: unknown): Promise<{ stdout: string; code: number | null }> {
  const config = path.join(home, ".gemini", "config");
  const hooks = await readJson(path.join(config, "hooks.json"));
  const gate = (hooks["roqer-gate"] as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse[0].hooks[0];
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", gate.command], { cwd: config, windowsHide: true })
    : spawn("sh", ["-c", gate.command], { cwd: config });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { stdout, code };
}

function decision(stdout: string): { decision: string; reason: string } | null {
  return stdout.trim() === "" ? null : JSON.parse(stdout) as { decision: string; reason: string };
}

test("a private home grants Roqer's MCP server and denies shell, writes and the web", async () => {
  const home = await createAntigravityHome({ mcp: MCP });
  try {
    const settings = await readJson(path.join(home.home, ".gemini", "antigravity-cli", "settings.json"));
    assert.equal(settings.toolPermission, "request-review");
    const permissions = settings.permissions as { allow: string[]; deny: string[] };
    assert.deepEqual(permissions.allow, [
      `mcp(${ANTIGRAVITY_MCP_SERVER_NAME}/*)`,
      ...readableDirectories(home).map((directory) => `read_file(${directory})`),
    ]);
    for (const rule of ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "unsandboxed(*)"]) {
      assert.ok(permissions.deny.includes(rule), rule);
    }
    // Deny beats allow in agy, so a deny rule on MCP would take Roqer's tools away.
    assert.ok(permissions.deny.every((rule) => !rule.startsWith("mcp(")));

    const mcp = await readJson(path.join(home.home, ".gemini", "config", "mcp_config.json"));
    assert.deepEqual(mcp, {
      mcpServers: { [ANTIGRAVITY_MCP_SERVER_NAME]: { url: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } } },
    });
    // The workspace holds only a repository marker that stops agy's search for
    // customizations at it, and the folder for the user's pictures.
    assert.deepEqual((await fs.readdir(home.workspace)).sort(), [".git", "attachments"]);
  } finally {
    await home.remove();
  }
  await assert.rejects(() => fs.access(home.home));
});

test("a private home keeps the user's billing and telemetry choices, and nothing else of theirs", async () => {
  const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-user-"));
  const own = path.join(userHome, ".gemini", "antigravity-cli");
  await fs.mkdir(own, { recursive: true });
  const original = JSON.stringify({
    useG1Credits: true,
    enableTelemetry: false,
    toolPermission: "always-proceed",
    permissions: { allow: ["command(*)"] },
  });
  await fs.writeFile(path.join(own, "settings.json"), original);
  const home = await createAntigravityHome({ mcp: MCP, userHome });
  try {
    const settings = await readJson(path.join(home.home, ".gemini", "antigravity-cli", "settings.json"));
    assert.equal(settings.useG1Credits, true);
    assert.equal(settings.enableTelemetry, false);
    // What the agent may do is Roqer's alone.
    assert.equal(settings.toolPermission, "request-review");
    assert.ok(!(settings.permissions as { allow: string[] }).allow.includes("command(*)"));
    assert.ok((settings.permissions as { allow: string[] }).allow.includes(`mcp(${ANTIGRAVITY_MCP_SERVER_NAME}/*)`));
    // The user's own file is read, never written.
    assert.equal(await fs.readFile(path.join(own, "settings.json"), "utf8"), original);
  } finally {
    await home.remove();
    await fs.rm(userHome, { recursive: true, force: true });
  }
});

test("a home with no MCP server grants nothing", async () => {
  const home = await createAntigravityHome({});
  try {
    const settings = await readJson(path.join(home.home, ".gemini", "antigravity-cli", "settings.json"));
    assert.ok((settings.permissions as { allow: string[] }).allow.every((rule) => rule.startsWith("read_file(")));
    assert.deepEqual(await readJson(path.join(home.home, ".gemini", "config", "mcp_config.json")), { mcpServers: {} });
  } finally {
    await home.remove();
  }
});

test("the gate lets Roqer's tools and the files in its private folders through and refuses everything else", async () => {
  const home = await createAntigravityHome({ mcp: MCP });
  try {
    const schemas = schemaDirectory(home.home);
    const call = (name: string, args: Record<string, unknown>) => ({ conversationId: "c", stepIdx: 1, toolCall: { name, args } });

    const allowed = [
      call("call_mcp_tool", { ServerName: ANTIGRAVITY_MCP_SERVER_NAME, ToolName: "roblox_studio", Arguments: {} }),
      call("view_file", { AbsolutePath: path.join(schemas, "roblox_studio.json") }),
      // A Studio capture agy saved from a tool result, and a picture the user attached.
      call("view_file", { AbsolutePath: path.join(conversationDirectory(home.home), "c", ".system_generated", "steps", "4", "media_0.png") }),
      call("view_file", { AbsolutePath: path.join(attachmentDirectory(home.workspace), "message-1-1.png") }),
    ];
    for (const payload of allowed) {
      const outcome = await runGate(home.home, payload);
      assert.equal(outcome.code, 0);
      assert.equal(decision(outcome.stdout), null, JSON.stringify(payload));
    }

    const refused = [
      call("call_mcp_tool", { ServerName: "github", ToolName: "create_issue", Arguments: {} }),
      call("run_command", { CommandLine: "echo hi" }),
      call("write_to_file", { TargetFile: path.join(home.workspace, ".agents", "mcp_config.json") }),
      call("search_web", { query: "roblox" }),
      call("invoke_subagent", {}),
      call("view_file", { AbsolutePath: path.join(home.home, ".gemini", "config", "mcp_config.json") }),
      // A path that starts inside the schema folder and climbs out of it.
      call("view_file", { AbsolutePath: path.join(schemas, "..", "..", "settings.json") }),
      call("view_file", { AbsolutePath: `${schemas}-elsewhere${path.sep}x.json` }),
      call("view_file", { AbsolutePath: path.join(home.workspace, ".git", "config") }),
      call("view_file", { AbsolutePath: path.join(attachmentDirectory(home.workspace), "..", "..", "home", ".gemini", "config", "mcp_config.json") }),
      { conversationId: "c" },
    ];
    for (const payload of refused) {
      const outcome = await runGate(home.home, payload);
      assert.equal(outcome.code, 0);
      const answer = decision(outcome.stdout);
      assert.equal(answer?.decision, "deny", JSON.stringify(payload));
      assert.ok(answer.reason.startsWith(GATE_REFUSAL_PREFIX));
    }

    const unreadable = decision((await runGate(home.home, "not json")).stdout);
    assert.equal(unreadable?.decision, "deny");
  } finally {
    await home.remove();
  }
});

test("the gate wrapper survives an executable path a shell would mangle", () => {
  const windows = gateWrapper("C:\\Program Files\\Roqer 100%\\Roqer.exe", "win32");
  assert.equal(windows.command, ".\\roqer-gate.cmd");
  assert.match(windows.text, /set ELECTRON_RUN_AS_NODE=1/);
  assert.match(windows.text, /"C:\\Program Files\\Roqer 100%%\\Roqer\.exe" "%~dp0roqer-gate\.cjs"/);
  assert.throws(() => gateWrapper("C:\\bad\"path\\Roqer.exe", "win32"));

  const posix = gateWrapper("/Applications/Roqer's App/Roqer", "darwin");
  assert.equal(posix.command, "sh ./roqer-gate.sh");
  assert.match(posix.text, /ELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Roqer'\\''s App\/Roqer' /);
});

test("an agy process gets the private home and no API key", () => {
  const environment = antigravityChildEnvironment({
    PATH: "/bin",
    HOME: "/home/user",
    USERPROFILE: "C:\\Users\\user",
    GEMINI_API_KEY: "key",
    GOOGLE_API_KEY: "key",
    ROBLOX_STUDIO_AUTH_TOKEN: "bridge",
  }, path.join(os.tmpdir(), "home"));
  assert.equal(environment.HOME, path.join(os.tmpdir(), "home"));
  assert.equal(environment.USERPROFILE, path.join(os.tmpdir(), "home"));
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.GEMINI_API_KEY, undefined);
  assert.equal(environment.GOOGLE_API_KEY, undefined);
  assert.equal(environment.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
});
