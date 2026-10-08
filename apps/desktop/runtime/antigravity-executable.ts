import fs from "node:fs/promises";
import path from "node:path";

import { ClientNotInstalledError } from "./client-not-installed";

export type AntigravityExecutableLookupOptions = {
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

/**
 * Where Google's own installer puts `agy`: `%LOCALAPPDATA%\agy\bin` on
 * Windows, `~/.local/bin` everywhere else.
 */
function installCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe")] : [];
  }
  return env.HOME ? [path.posix.join(env.HOME, ".local", "bin", "agy")] : [];
}

/**
 * Resolve the Antigravity CLI without relying on the graphical app inheriting
 * a terminal PATH, the same problem the Codex and Claude Code lookups solve.
 * Only a real executable qualifies, so nothing Roqer hands it passes through a
 * command shell.
 */
export async function resolveAntigravityExecutable(options: AntigravityExecutableLookupOptions = {}): Promise<string> {
  if (options.executable) return options.executable;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.WORKBENCH_ANTIGRAVITY_EXECUTABLE) return env.WORKBENCH_ANTIGRAVITY_EXECUTABLE;

  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const delimiter = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "agy.exe" : "agy";
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory.replace(/^"|"$/g, ""), name));
  }
  candidates.push(...installCandidates(env, platform));

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new ClientNotInstalledError(
    "The Antigravity CLI could not be found. Install it from antigravity.google, or set WORKBENCH_ANTIGRAVITY_EXECUTABLE to the agy executable.",
  );
}
