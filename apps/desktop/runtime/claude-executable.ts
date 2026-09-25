import fs from "node:fs/promises";
import path from "node:path";

export type ClaudeExecutableLookupOptions = {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
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
 * Resolve Claude Code without relying on the graphical app inheriting a
 * terminal PATH, the same problem the Codex lookup solves.
 */
export async function resolveClaudeExecutable(options: ClaudeExecutableLookupOptions = {}): Promise<string> {
  if (options.executable) return options.executable;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.WORKBENCH_CLAUDE_EXECUTABLE) return env.WORKBENCH_CLAUDE_EXECUTABLE;

  // Node cannot launch .cmd/.bat shims with shell:false on Windows, so an npm
  // global install is deliberately not searched. Only real executables qualify,
  // which keeps provider input from ever passing through a command shell.
  const names = platform === "win32" ? ["claude.exe"] : ["claude"];
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ""), name));
  }
  candidates.push(...installCandidates(env, platform));

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(
    "Claude Code could not be found. Install it from claude.com/claude-code, or set WORKBENCH_CLAUDE_EXECUTABLE to the claude executable.",
  );
}
