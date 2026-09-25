import fs from "node:fs/promises";
import path from "node:path";

export type CodexExecutableLookupOptions = {
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

/** Resolve Codex without relying on the graphical app inheriting a terminal PATH. */
export async function resolveCodexExecutable(options: CodexExecutableLookupOptions = {}): Promise<string> {
  if (options.executable) return options.executable;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.WORKBENCH_CODEX_EXECUTABLE) return env.WORKBENCH_CODEX_EXECUTABLE;

  // Node cannot launch .cmd/.bat shims with shell:false on Windows. Prefer the
  // real executable so provider input can never pass through a command shell.
  const names = platform === "win32" ? ["codex.exe"] : ["codex"];
  const candidates: string[] = [];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ""), name));
  }
  if (platform === "win32") {
    candidates.push(...await windowsDesktopCandidates(env.LOCALAPPDATA));
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(
    "Codex could not be found. Open or install the Codex desktop app, or set WORKBENCH_CODEX_EXECUTABLE to codex.exe.",
  );
}
