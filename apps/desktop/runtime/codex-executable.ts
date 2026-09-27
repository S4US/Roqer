import fs from "node:fs/promises";
import path from "node:path";

import { ClientNotInstalledError } from "./client-not-installed";
import { windowsNpmPackageRoots } from "./windows-npm";

export type CodexExecutableLookupOptions = {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
};

/** The Rust target each Windows build of Codex is published for. */
const WINDOWS_TARGETS: Partial<Record<string, string>> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function windowsDesktopCandidates(localAppData: string | undefined): Promise<string[]> {
  if (!localAppData) return [];
  const binDirectory = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [path.join(binDirectory, "codex.exe")];
  try {
    const entries = await fs.readdir(binDirectory, { withFileTypes: true });
    const nested = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const executable = path.join(binDirectory, entry.name, "codex.exe");
        try {
          const details = await fs.stat(executable);
          return details.isFile() ? { executable, modified: details.mtimeMs } : null;
        } catch {
          return null;
        }
      }));
    candidates.push(...nested
      .filter((entry): entry is { executable: string; modified: number } => entry !== null)
      .sort((left, right) => right.modified - left.modified)
      .map((entry) => entry.executable));
  } catch {
    // A missing desktop install is expected on machines that use npm or PATH.
  }
  return candidates;
}

/**
 * Where Codex's own installer puts the binary: `install.ps1` on Windows,
 * `install.sh` on macOS and Linux, plus Homebrew. The installer adds it to
 * PATH, but only for processes started afterwards, so Roqer looks here too.
 */
function installCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe")] : [];
  }
  const candidates = env.HOME ? [path.join(env.HOME, ".local", "bin", "codex")] : [];
  candidates.push("/usr/local/bin/codex", "/opt/homebrew/bin/codex");
  return candidates;
}

/**
 * The native binary inside an `npm install -g @openai/codex`, which npm puts
 * in a platform package beside the JavaScript launcher. Earlier releases kept
 * it in a `codex` folder rather than `bin`, some in the launcher package itself.
 */
function windowsNpmCandidates(env: NodeJS.ProcessEnv, arch: string): string[] {
  const target = WINDOWS_TARGETS[arch];
  if (target === undefined) return [];
  return windowsNpmPackageRoots(env, "@openai/codex").flatMap((root) => [
    path.join(root, "node_modules", "@openai", `codex-win32-${arch}`, "vendor"),
    path.join(root, "vendor"),
  ]).flatMap((vendor) => [
    path.join(vendor, target, "bin", "codex.exe"),
    path.join(vendor, target, "codex", "codex.exe"),
  ]);
}

/** Resolve Codex without relying on the graphical app inheriting a terminal PATH. */
export async function resolveCodexExecutable(options: CodexExecutableLookupOptions = {}): Promise<string> {
  if (options.executable) return options.executable;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (env.WORKBENCH_CODEX_EXECUTABLE) return env.WORKBENCH_CODEX_EXECUTABLE;

  // Node cannot launch .cmd/.bat shims with shell:false on Windows. Prefer the
  // real executable so provider input can never pass through a command shell.
  const names = platform === "win32" ? ["codex.exe"] : ["codex"];
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ""), name));
  }
  candidates.push(...installCandidates(env, platform));
  if (platform === "win32") {
    candidates.push(...await windowsDesktopCandidates(env.LOCALAPPDATA));
    candidates.push(...windowsNpmCandidates(env, arch));
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new ClientNotInstalledError(
    "Codex could not be found. Install Codex or the Codex desktop app, or set WORKBENCH_CODEX_EXECUTABLE to codex.exe.",
  );
}
