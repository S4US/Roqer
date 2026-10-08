import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A private home for one Antigravity CLI process.
 *
 * `agy` reads everything that decides what it may do from the user's home:
 * its permission rules and presets, the MCP servers it starts, the lifecycle
 * hooks it runs, plugins, skills and rules. Roqer never touches the user's own
 * copy. Each process instead runs with `HOME`/`USERPROFILE` pointed at a fresh
 * directory Roqer writes and deletes, so the agent sees only Roqer's tools,
 * under Roqer's rules, and its conversation history never lands in the user's
 * own Antigravity history. The Google sign-in is not kept in the home, so the
 * user's subscription still applies.
 *
 * Two layers keep the agent on Roqer's tools:
 *
 * 1. Permission rules. Roqer's MCP server is allowed; shell commands, file
 *    writes, URL reads and browser actions are denied outright; everything
 *    else stays at the `request-review` default, which a headless process can
 *    only refuse. This floor holds even if the gate below never runs.
 * 2. A `PreToolUse` gate. It allows a call to Roqer's MCP server and a read of
 *    a file Roqer or `agy` itself put in the private directories: the tool
 *    schemas `agy` caches for Roqer's server, the images `agy` saves from
 *    tool results, and the pictures the user attached. It denies everything
 *    else with a reason the model can read. Without it, a built-in tool with
 *    no permission of its own (web search, image generation, subagents) would
 *    simply run, and a refused one would end the turn rather than let the
 *    model carry on. A gate that crashes or times out makes `agy` deny the
 *    call, so a broken gate fails closed.
 */

/** The name Roqer's MCP server goes by inside `agy`, and in its permission rules. */
export const ANTIGRAVITY_MCP_SERVER_NAME = "roqer";

/** The file names the gate is written under, beside `hooks.json`. */
const GATE_SCRIPT_FILE = "roqer-gate.cjs";
const GATE_CONFIG_FILE = "roqer-gate.json";
const GATE_WINDOWS_WRAPPER = "roqer-gate.cmd";
const GATE_POSIX_WRAPPER = "roqer-gate.sh";
/** Seconds `agy` waits on the gate before treating it as failed, which denies the call. */
const GATE_TIMEOUT_SECONDS = 30;

/** What the gate prints in front of every refusal, so the planner can tell its refusals apart. */
export const GATE_REFUSAL_PREFIX = "Roqer allows only its own tools here";

/**
 * Permission rules for every Roqer-owned home. Deny beats allow in `agy`, so
 * nothing here may deny what `allow` grants. Reads are left at the default:
 * `agy` reads the schemas of an MCP server's tools from a file in the home
 * before calling one, and a read outside the workspace still needs a review a
 * headless process cannot give.
 */
export function antigravitySettings(options: {
  mcp: boolean;
  carried?: Readonly<Record<string, boolean>>;
  /** Folders outside the workspace the agent may read: `agy`'s own saved tool images. */
  readable?: readonly string[];
}): Record<string, unknown> {
  return {
    ...options.carried,
    toolPermission: "request-review",
    allowNonWorkspaceAccess: false,
    permissions: {
      allow: [
        ...(options.mcp ? [`mcp(${ANTIGRAVITY_MCP_SERVER_NAME}/*)`] : []),
        ...(options.readable ?? []).map((directory) => `read_file(${directory})`),
      ],
      deny: ["command(*)", "unsandboxed(*)", "write_file(*)", "read_url(*)", "execute_url(*)"],
    },
  };
}

/**
 * Choices in the user's own `agy` settings that are about their account rather
 * than about what the agent may do: whether runs may spend Google One AI
 * credits, and whether `agy` sends telemetry. A private home would otherwise
 * reset both to `agy`'s defaults behind the user's back.
 */
const CARRIED_SETTINGS = ["useG1Credits", "enableTelemetry"] as const;

/**
 * Read those choices from the user's own settings file, which Roqer never
 * writes. A file that is missing or unreadable carries nothing, and `agy`
 * uses its defaults.
 */
export async function readCarriedSettings(userHome: string): Promise<Record<string, boolean>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(userHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
  } catch {
    return {};
  }
  const carried: Record<string, boolean> = {};
  if (typeof parsed !== "object" || parsed === null) return carried;
  for (const key of CARRIED_SETTINGS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "boolean") carried[key] = value;
  }
  return carried;
}

/**
 * The gate itself, run by `agy` before every tool call with the call on
 * stdin. Plain CommonJS with no dependencies, because it runs under whichever
 * Node Roqer has: Electron's own, as Node, in the app. Allowing is printing
 * nothing; `agy`'s permission rules then still apply. Anything it cannot read
 * is refused.
 */
export const GATE_SCRIPT = `"use strict";
const fs = require("fs");
const path = require("path");
const PREFIX = ${JSON.stringify(GATE_REFUSAL_PREFIX)};
function refuse(reason) {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: PREFIX + ": " + reason }));
}
function within(file, directory) {
  const target = path.resolve(file);
  const root = path.resolve(directory) + path.sep;
  return process.platform === "win32"
    ? target.toLowerCase().startsWith(root.toLowerCase())
    : target.startsWith(root);
}
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(GATE_CONFIG_FILE)}), "utf8"));
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const call = payload && typeof payload === "object" ? payload.toolCall : undefined;
  const name = call && typeof call.name === "string" ? call.name : "";
  const args = call && call.args && typeof call.args === "object" ? call.args : {};
  if (name === "call_mcp_tool" && args.ServerName === config.server) {
    // Roqer's own tool: allowed, and Roqer applies its approvals itself.
  } else if (name === "view_file" && typeof args.AbsolutePath === "string" &&
    config.readable.some((directory) => within(args.AbsolutePath, directory))) {
    // A tool schema, a saved tool image, or a picture the user attached.
  } else if (name === "call_mcp_tool") {
    refuse("only the " + JSON.stringify(config.server) + " MCP server is available.");
  } else {
    refuse((name || "this tool") + " is not available. Use the " + JSON.stringify(config.server) + " MCP tools.");
  }
} catch (error) {
  refuse("the request could not be read.");
}
`;

/** A string the POSIX shell reads back as exactly `value`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The wrapper `agy` runs. It sets `ELECTRON_RUN_AS_NODE` itself, because a
 * hook does not inherit the environment `agy` was started with, and it is
 * named by a relative path because `agy` runs hooks from the directory that
 * holds `hooks.json` and passes the command through `cmd /c`, which does not
 * accept a quoted absolute path the way `agy` escapes it.
 */
export function gateWrapper(runtime: string, platform: NodeJS.Platform): { file: string; command: string; text: string } {
  if (platform === "win32") {
    if (/["\r\n]/.test(runtime)) throw new Error("Roqer's own executable path cannot be used in a hook.");
    return {
      file: GATE_WINDOWS_WRAPPER,
      command: `.\\${GATE_WINDOWS_WRAPPER}`,
      // A batch file expands %NAME%, so a literal percent sign is doubled.
      text: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runtime.replace(/%/g, "%%")}" "%~dp0${GATE_SCRIPT_FILE}"\r\n`,
    };
  }
  return {
    file: GATE_POSIX_WRAPPER,
    command: `sh ./${GATE_POSIX_WRAPPER}`,
    text: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(runtime)} "$(dirname "$0")/${GATE_SCRIPT_FILE}"\n`,
  };
}

/** Where `agy` caches the schemas of an MCP server's tools, under a home. */
export function schemaDirectory(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "mcp", ANTIGRAVITY_MCP_SERVER_NAME);
}

/**
 * Where `agy` keeps each conversation's own files under a home, the images it
 * saved from tool results among them. The model is pointed at a Studio
 * capture there and may look at it again.
 */
export function conversationDirectory(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain");
}

/** Where Roqer puts the pictures the user attached, inside the workspace. */
export function attachmentDirectory(workspace: string): string {
  return path.join(workspace, "attachments");
}

/** The folders the gate lets the agent read in: nothing else of the disk. */
export function readableDirectories(home: AntigravityHome): string[] {
  return [schemaDirectory(home.home), conversationDirectory(home.home), attachmentDirectory(home.workspace)];
}

/** Whether `file` lies inside `directory`, by resolved path. */
export function isWithin(file: string, directory: string): boolean {
  const target = path.resolve(file);
  const root = path.resolve(directory) + path.sep;
  return process.platform === "win32"
    ? target.toLowerCase().startsWith(root.toLowerCase())
    : target.startsWith(root);
}

export type AntigravityHomeOptions = {
  /** Roqer's MCP server for this process; omitted for a process that only answers about itself. */
  mcp?: { url: string; token: string };
  /** The Node the gate runs under. Defaults to the running one. */
  runtime?: string;
  platform?: NodeJS.Platform;
  /** Where the directory is made. Defaults to the system temp directory. */
  parent?: string;
  /** The user's real home, whose account-level `agy` choices are kept. Defaults to the running user's. */
  userHome?: string;
};

export type AntigravityHome = {
  /** What `HOME`/`USERPROFILE` point at. */
  home: string;
  /** The process's working directory: empty but for attached pictures, and a repository root of its own. */
  workspace: string;
  /** Remove everything, including the MCP credential. Safe to call more than once. */
  remove(): Promise<void>;
};

async function writePrivate(file: string, text: string): Promise<void> {
  await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

/**
 * Make a private home, and an empty workspace beside it, for one `agy`
 * process. The MCP credential is written to a file only this user can read,
 * never onto a command line.
 */
export async function createAntigravityHome(options: AntigravityHomeOptions = {}): Promise<AntigravityHome> {
  const platform = options.platform ?? process.platform;
  const root = await fs.mkdtemp(path.join(options.parent ?? os.tmpdir(), "roqer-agy-"));
  // A process that was just stopped can hold its files open for a moment on
  // Windows, so the removal is retried rather than left behind.
  const remove = () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  try {
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const config = path.join(home, ".gemini", "config");
    const cli = path.join(home, ".gemini", "antigravity-cli");
    await fs.mkdir(config, { recursive: true });
    await fs.mkdir(cli, { recursive: true });
    // `agy` looks for workspace customizations from the working directory up
    // to the repository root; a repository of its own stops that walk here.
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(attachmentDirectory(workspace));
    const readable = readableDirectories({ home, workspace, remove });

    const carried = await readCarriedSettings(options.userHome ?? os.homedir());
    await writePrivate(path.join(cli, "settings.json"), JSON.stringify(antigravitySettings({ mcp: options.mcp !== undefined, carried, readable })));
    await writePrivate(path.join(config, "mcp_config.json"), JSON.stringify({
      mcpServers: options.mcp === undefined ? {} : {
        [ANTIGRAVITY_MCP_SERVER_NAME]: { url: options.mcp.url, headers: { Authorization: `Bearer ${options.mcp.token}` } },
      },
    }));

    const wrapper = gateWrapper(options.runtime ?? process.execPath, platform);
    await writePrivate(path.join(config, GATE_SCRIPT_FILE), GATE_SCRIPT);
    await writePrivate(path.join(config, GATE_CONFIG_FILE), JSON.stringify({
      server: ANTIGRAVITY_MCP_SERVER_NAME,
      readable,
    }));
    await fs.writeFile(path.join(config, wrapper.file), wrapper.text, { encoding: "utf8", mode: 0o700 });
    await writePrivate(path.join(config, "hooks.json"), JSON.stringify({
      "roqer-gate": {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: wrapper.command, timeout: GATE_TIMEOUT_SECONDS }] }],
      },
    }));
    return { home, workspace, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/**
 * The environment an `agy` process starts with: the user's own, pointed at
 * the private home, less what must not reach it.
 *
 * - The Roblox bridge secret stays in Roqer.
 * - Roqer runs Antigravity on the user's subscription only. With an API key in
 *   the environment `agy` would bill that key instead, as the Claude provider
 *   likewise refuses a Console login.
 */
export function antigravityChildEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...environment, HOME: home, USERPROFILE: home };
  delete child.ROBLOX_STUDIO_AUTH_TOKEN;
  delete child.GEMINI_API_KEY;
  delete child.GOOGLE_API_KEY;
  return child;
}
