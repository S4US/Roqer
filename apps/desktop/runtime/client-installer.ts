import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import type { ProviderId, ProviderInstallResult } from "../shared/provider";
import { resolveAntigravityExecutable } from "./antigravity-executable";
import { resolveClaudeExecutable } from "./claude-executable";
import { resolveCodexExecutable } from "./codex-executable";

/**
 * Installing the client a subscription runs through, Codex or Claude Code, by
 * running the vendor's own Windows installer, as the user would from a
 * terminal. Roqer never ships or downloads either client itself: the
 * installer fetches the official build, keeps it updated, and puts it where
 * the executable lookups already search, so the next status read finds it.
 *
 * Everything that reaches PowerShell is fixed here. The renderer can only name
 * a provider, and the main process confirms with the user before `install`.
 */
export type ClientInstaller = Readonly<{
  /** The client's name, as the interface shows it. */
  client: string;
  /** Who publishes the installer. */
  publisher: string;
  /** The official install script. */
  script: string;
  /** Extra environment the installer reads. */
  environment: Readonly<Record<string, string>>;
  /** Where the installed client is looked for afterwards, to check the install. */
  locate: (env: NodeJS.ProcessEnv) => Promise<string>;
}>;

const INSTALLERS: Partial<Record<ProviderId, ClientInstaller>> = {
  chatgpt: {
    client: "Codex",
    publisher: "OpenAI",
    script: "https://chatgpt.com/codex/install.ps1",
    // Without a console the installer answers its own questions "no": it does
    // not replace an older install, remove an npm one, or start Codex.
    environment: { CODEX_NON_INTERACTIVE: "1" },
    locate: (env) => resolveCodexExecutable({ env, platform: "win32" }),
  },
  claude: {
    client: "Claude Code",
    publisher: "Anthropic",
    script: "https://claude.ai/install.ps1",
    environment: {},
    locate: (env) => resolveClaudeExecutable({ env, platform: "win32" }),
  },
  antigravity: {
    client: "Antigravity CLI",
    publisher: "Google",
    script: "https://antigravity.google/cli/install.ps1",
    environment: {},
    locate: (env) => resolveAntigravityExecutable({ env, platform: "win32" }),
  },
};

/** Installing from Roqer is offered on Windows only, the one platform it is tested on. */
export function clientInstallSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function clientInstallerFor(provider: ProviderId): ClientInstaller | null {
  return INSTALLERS[provider] ?? null;
}

/** The command the vendor documents, for the confirmation and for running it by hand. */
export function installCommand(installer: ClientInstaller): string {
  return `irm ${installer.script} | iex`;
}

/**
 * Windows PowerShell by absolute path, so a `powershell.exe` earlier on PATH
 * cannot stand in for it. The execution policy is relaxed for this one process
 * only, as the vendors' own instructions do.
 */
export function installerProcess(installer: ClientInstaller, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  return {
    command: path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", installCommand(installer)],
  };
}

/** The installer's environment: Roqer's, without the bridge's credential, plus what the installer reads. */
export function installerEnvironment(installer: ClientInstaller, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, ...installer.environment };
  delete environment.ROBLOX_STUDIO_AUTH_TOKEN;
  return environment;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Only the end of the installer's output is kept; it is where an error is. */
const OUTPUT_TAIL_LENGTH = 16 * 1024;
const MESSAGE_DETAIL_LENGTH = 300;

/** The last lines of installer output, without terminal colour codes, short enough to show. */
export function installerFailureDetail(output: string): string {
  const plain = output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  if (plain.length <= MESSAGE_DETAIL_LENGTH) return plain;
  return `…${plain.slice(-MESSAGE_DETAIL_LENGTH).trimStart()}`;
}

export type SpawnInstaller = (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;

export type ClientInstallRunnerOptions = {
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnInstaller;
  killTree?: (child: ChildProcessWithoutNullStreams) => void;
  timeoutMs?: number;
};

const defaultSpawn: SpawnInstaller = (command, args, env) => spawn(command, args, {
  env,
  shell: false,
  windowsHide: true,
  // No input: a question the installer did not expect fails instead of waiting.
  stdio: ["ignore", "pipe", "pipe"],
}) as unknown as ChildProcessWithoutNullStreams;

function defaultKillTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  // The script starts downloads and the client's own setup; /T takes them all.
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

/** Runs at most one client installer at a time, and stops it when Roqer quits. */
export class ClientInstallRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnProcess: SpawnInstaller;
  private readonly killTree: (child: ChildProcessWithoutNullStreams) => void;
  private readonly timeoutMs: number;
  private running: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;

  constructor(options: ClientInstallRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.killTree = options.killTree ?? defaultKillTree;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async install(installer: ClientInstaller): Promise<ProviderInstallResult> {
    const command = installCommand(installer);
    if (this.stopped) return { ok: false, message: "Roqer is closing." };
    if (this.running) return { ok: false, message: "Another install is already running." };

    const environment = installerEnvironment(installer, this.env);
    const { command: executable, args } = installerProcess(installer, environment);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(executable, args, environment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `The ${installer.client} installer could not start: ${detail}`, command };
    }
    this.running = child;

    const outcome = await new Promise<{ code: number | null; output: string; timedOut: boolean; error?: Error }>((resolve) => {
      let output = "";
      let settled = false;
      const collect = (chunk: Buffer | string) => {
        output = `${output}${chunk.toString()}`.slice(-OUTPUT_TAIL_LENGTH);
      };
      const finish = (result: { code: number | null; timedOut: boolean; error?: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, output });
      };
      const timer = setTimeout(() => {
        this.killTree(child);
        finish({ code: null, timedOut: true });
      }, this.timeoutMs);
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => finish({ code: null, timedOut: false, error }));
      child.once("close", (code: number | null) => finish({ code, timedOut: false }));
    });
    if (this.running === child) this.running = null;

    if (this.stopped) return { ok: false, message: `The ${installer.client} install was stopped because Roqer is closing.`, command };
    if (outcome.timedOut) {
      return { ok: false, message: `The ${installer.client} installer did not finish within ${Math.round(this.timeoutMs / 60_000)} minutes and was stopped.`, command };
    }
    if (outcome.error) {
      return { ok: false, message: `The ${installer.client} installer could not start: ${outcome.error.message}`, command };
    }
    if (outcome.code !== 0) {
      const detail = installerFailureDetail(outcome.output);
      return {
        ok: false,
        message: `The ${installer.client} installer failed${detail ? `: ${detail}` : ` (exit code ${String(outcome.code)}).`}`,
        command,
      };
    }

    // A clean exit is not proof: look for the client where Roqer will run it from.
    try {
      await installer.locate(this.env);
    } catch {
      return {
        ok: false,
        message: `The ${installer.client} installer finished, but Roqer still cannot find ${installer.client}. Restart Roqer, or run the installer yourself.`,
        command,
      };
    }
    return { ok: true, message: `${installer.client} is installed.` };
  }

  /** Stop an install in progress and refuse new ones; called as Roqer quits. */
  stop(): void {
    this.stopped = true;
    if (this.running) this.killTree(this.running);
  }
}
