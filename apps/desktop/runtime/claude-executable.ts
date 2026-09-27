import fs from "node:fs/promises";
import path from "node:path";

import { windowsNpmPackageRoots } from "./windows-npm";

export type ClaudeExecutableLookupOptions = {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
};

/**
 * The size under which an npm install's `bin/claude.exe` is still the
 * placeholder script its postinstall replaces, the same test the postinstall
 * itself uses. The placeholder only prints an error.
 */
const NPM_PLACEHOLDER_BYTES = 4096;

async function isFile(candidate: string, minimumBytes = 0): Promise<boolean> {
  try {
    const details = await fs.stat(candidate);
    return details.isFile() && details.size >= minimumBytes;
  } catch {
    return false;
  }
}

/** Where the native Claude Code installer puts the binary on each platform. */
function installCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  const candidates: string[] = [];
  if (home) candidates.push(path.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe"));
  } else {
    candidates.push("/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  }
  return candidates;
}

/**
 * The native binary inside an `npm install -g @anthropic-ai/claude-code`: the
 * copy its postinstall places in `bin`, or the platform package it copies from,
 * which is still there when the postinstall did not run.
 */
function windowsNpmCandidates(env: NodeJS.ProcessEnv, arch: string): string[] {
  if (arch !== "x64" && arch !== "arm64") return [];
  return windowsNpmPackageRoots(env, "@anthropic-ai/claude-code").flatMap((root) => [
    path.join(root, "bin", "claude.exe"),
    path.join(root, "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"),
  ]);
}

/**
 * Resolve Claude Code without relying on the graphical app inheriting a
 * terminal PATH, the same problem the Codex lookup solves.
 */
export async function resolveClaudeExecutable(options: ClaudeExecutableLookupOptions = {}): Promise<string> {
  if (options.executable) return options.executable;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (env.WORKBENCH_CLAUDE_EXECUTABLE) return env.WORKBENCH_CLAUDE_EXECUTABLE;

  // Node cannot launch .cmd/.bat shims with shell:false on Windows, so an npm
  // global install's shim is never used, only the executable inside it. Only
  // real executables qualify, which keeps provider input from ever passing
  // through a command shell.
  const names = platform === "win32" ? ["claude.exe"] : ["claude"];
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ""), name));
  }
  candidates.push(...installCandidates(env, platform));

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  if (platform === "win32") {
    for (const candidate of windowsNpmCandidates(env, arch)) {
      if (await isFile(candidate, NPM_PLACEHOLDER_BYTES)) return candidate;
    }
  }
  throw new Error(
    "Claude Code could not be found. Install it from claude.com/claude-code, or set WORKBENCH_CLAUDE_EXECUTABLE to the claude executable.",
  );
}
