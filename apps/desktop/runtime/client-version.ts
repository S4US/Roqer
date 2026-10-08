import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";

/**
 * The version of Codex or Claude Code, read from the executable Roqer runs, so
 * Settings can say which one an account goes through.
 *
 * It is that file's own `--version` answer, not a guess from a path or a
 * package: a terminal's `codex` can be a different install from the one Roqer
 * finds. Asking starts the client, so an answer is kept for as long as the file
 * is unchanged. An update replaces the file, or moves Codex to a new folder,
 * and the next read asks again. A client that did not answer is asked again
 * after a minute rather than on every status read.
 */

export type VersionedClient = "codex" | "claude" | "antigravity";

/** What each client prints: `codex-cli 0.160.0`, `2.1.289 (Claude Code)`, and `1.3.1` alone for `agy`. */
const VERSION_LINES: Readonly<Record<VersionedClient, RegExp>> = {
  codex: /^codex(?:-cli)? (\S+)/m,
  claude: /^(\S+) \(Claude Code\)/m,
  antigravity: /^(\S+)\s*$/,
};
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_VERSION_LENGTH = 64;
const MAX_OUTPUT_LENGTH = 4 * 1024;
const VERSION_TIMEOUT_MS = 15_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

/** The version in a client's `--version` output, or null when it did not answer as that client. */
export function parseClientVersion(client: VersionedClient, output: string): string | null {
  const version = VERSION_LINES[client].exec(output)?.[1];
  return version !== undefined && version.length <= MAX_VERSION_LENGTH && VERSION_SHAPE.test(version) ? version : null;
}

/** Roqer's environment without the bridge's credential, which a version check has no use for. */
export function versionEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  delete environment.ROBLOX_STUDIO_AUTH_TOKEN;
  return environment;
}

export type VersionSpawn = (executable: string, args: readonly string[]) => ChildProcess;

const defaultSpawn: VersionSpawn = (executable, args) => spawn(executable, [...args], {
  env: versionEnvironment(process.env),
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

function askVersion(client: VersionedClient, executable: string, spawnProcess: VersionSpawn, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, ["--version"]);
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    let settled = false;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(version);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(0, MAX_OUTPUT_LENGTH);
    });
    child.once("error", () => finish(null));
    child.once("close", () => finish(parseClientVersion(client, output)));
  });
}

type FileStat = (file: string) => Promise<{ mtimeMs: number; size: number }>;

export type ClientVersionReaderOptions = {
  /** Injectable for tests. */
  spawnProcess?: VersionSpawn;
  stat?: FileStat;
  now?: () => number;
  timeoutMs?: number;
};

type Entry = {
  executable: string;
  mtimeMs: number;
  size: number;
  version: Promise<string | null>;
  /** When the client last failed to answer; unset while it is asked, and once it has answered. */
  failedAt?: number;
};

export class ClientVersionReader {
  private readonly spawnProcess: VersionSpawn;
  private readonly stat: FileStat;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /** One answer per client: the executable Roqer runs for it now. */
  private readonly entries = new Map<VersionedClient, Entry>();

  constructor(options: ClientVersionReaderOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.stat = options.stat ?? ((file) => fs.stat(file));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  }

  /** The client's version, or null when the file is gone or did not answer as that client. */
  async read(client: VersionedClient, executable: string): Promise<string | null> {
    let details: { mtimeMs: number; size: number };
    try {
      details = await this.stat(executable);
    } catch {
      return null;
    }
    const cached = this.entries.get(client);
    if (cached !== undefined && cached.executable === executable &&
      cached.mtimeMs === details.mtimeMs && cached.size === details.size &&
      (cached.failedAt === undefined || this.now() - cached.failedAt < RETRY_AFTER_FAILURE_MS)) {
      return cached.version;
    }

    const entry: Entry = {
      executable,
      mtimeMs: details.mtimeMs,
      size: details.size,
      version: askVersion(client, executable, this.spawnProcess, this.timeoutMs),
    };
    this.entries.set(client, entry);
    const version = await entry.version;
    if (version === null) entry.failedAt = this.now();
    return version;
  }
}
