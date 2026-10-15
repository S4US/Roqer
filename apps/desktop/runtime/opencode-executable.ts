import fs from "node:fs/promises";
import path from "node:path";

import { ClientNotInstalledError } from "./client-not-installed";
import { windowsNpmPackageRoots } from "./windows-npm";

export type OpenCodeExecutableLookupOptions = {
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

function installCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const list: string[] = [];
    list.push(...windowsNpmPackageRoots(env, "opencode-ai").map((root) => path.join(root, "bin", "opencode.exe")));
    if (env.LOCALAPPDATA) {
      list.push(path.win32.join(env.LOCALAPPDATA, "opencode", "bin", "opencode.exe"));
    }
    return list;
  }
  return env.HOME ? [path.posix.join(env.HOME, ".opencode", "bin", "opencode"), path.posix.join(env.HOME, ".local", "bin", "opencode")] : [];
}

export async function resolveOpenCodeExecutable(options: OpenCodeExecutableLookupOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = options.executable ?? env.WORKBENCH_OPENCODE_EXECUTABLE;
  if (override) {
    if (platform === "win32" && !override.toLowerCase().endsWith(".exe")) {
      throw new Error("OpenCode requires a native .exe on Windows; .cmd and .bat launchers cannot be used.");
    }
    return override;
  }

  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const delimiter = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "opencode.exe" : "opencode";
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory.replace(/^"|"$/g, ""), name));
  }
  candidates.push(...installCandidates(env, platform));

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new ClientNotInstalledError(
    "OpenCode could not be found. Install it with `npm install -g opencode-ai`, or set WORKBENCH_OPENCODE_EXECUTABLE to the opencode executable.",
  );
}
