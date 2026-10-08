import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

import type { ProviderLoginResult, ProviderModel, ProviderModelCatalog, ProviderStatus } from "../shared/provider";
import {
  antigravityChildEnvironment, createAntigravityHome, type AntigravityHome, type AntigravityHomeOptions,
} from "./antigravity-home";
import { resolveAntigravityExecutable } from "./antigravity-executable";
import { ClientNotInstalledError } from "./client-not-installed";

/**
 * Roqer's client for the locally installed Antigravity CLI (`agy`).
 *
 * `agy` owns the Google sign-in the way Codex and Claude Code own theirs: it
 * stores and refreshes the credential and signs every request. Roqer never
 * sees it. Every process Roqer starts to work runs in a private home of its
 * own (see `antigravity-home.ts`), including the short-lived ones that only
 * report the account and its models. On Windows the credential lives in the
 * Credential Manager, which every Antigravity app shares, so a sign-in made in
 * any of them, Roqer included, reaches them all.
 *
 * Signing in uses `agy`'s own headless flow: with `AGY_CLI_CDE_AUTH_ACTION`
 * set to `login` it prints Google's sign-in address and reads the code
 * Google's page shows back from stdin, the same shape as Claude Code's flow.
 * With `check` it says whether an account is signed in, and as whom, without
 * starting a model or reaching the network.
 */

type JsonRecord = Record<string, unknown>;

/** What tells `agy` to sign in or report the account and exit, instead of starting. */
const AUTH_ACTION = "AGY_CLI_CDE_AUTH_ACTION";

const CHECK_TIMEOUT_MS = 20_000;
const USAGE_TIMEOUT_MS = 45_000;
const MODELS_TIMEOUT_MS = 45_000;
/**
 * How long an answer about the account is reused. The app asks about the
 * selected provider every 15 s; a signed-in answer is reused longer. Connect
 * and a finished sign-in forget it at once.
 */
const SIGNED_IN_CACHE_TTL_MS = 60_000;
const OTHER_STATUS_CACHE_TTL_MS = 15_000;
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MAX_OUTPUT_LENGTH = 256 * 1024;
const MAX_MODELS = 64;
const LOGIN_URL_TIMEOUT_MS = 30_000;
/** How long `agy` gets to trade a pasted code for a token. */
const LOGIN_FINISH_TIMEOUT_MS = 90_000;
/** How long a sign-in may wait for its code before it is given up. */
const LOGIN_WAIT_TIMEOUT_MS = 10 * 60_000;
const MAX_LOGIN_CODE_LENGTH = 512;

/** Where Google's sign-in for `agy` starts; the address `agy` prints must be on it. */
export const ANTIGRAVITY_SIGN_IN_HOSTS: readonly string[] = ["accounts.google.com"];

export const ANTIGRAVITY_SIGN_IN_MESSAGE = "Connect your Google account to use Antigravity.";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** `agy`'s own output without terminal colour codes. */
function plain(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * The single JSON envelope `agy --output-format json` prints, or null when
 * stdout held something else.
 */
export function parseAntigravityEnvelope(stdout: string): JsonRecord | null {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The plan usage `/usage` reports, when the envelope is a successful answer to it. */
export function antigravityUsageData(envelope: JsonRecord | null): JsonRecord | null {
  if (envelope === null || envelope.status !== "SUCCESS") return null;
  const command = envelope.command;
  if (!isRecord(command) || command.name !== "usage" || !isRecord(command.data)) return null;
  return command.data;
}

/**
 * What `agy` with `AGY_CLI_CDE_AUTH_ACTION=check` says about the account, or
 * null when it answered in a way this reader does not know. Signed in, it
 * exits 0 naming the account; signed out, it exits 1 and says nothing.
 */
export function antigravityCheckStatus(output: { stdout: string; stderr: string; code: number | null }): ProviderStatus | null {
  const text = plain(`${output.stdout}\n${output.stderr}`).trim();
  if (output.code === 0) {
    const account = /Already authenticated as (\S+?)\.?$/m.exec(text)?.[1];
    if (account === undefined) return null;
    return {
      kind: "signed-in",
      message: "Google account connected through the Antigravity CLI",
      ...(account.includes("@") ? { email: account } : {}),
    };
  }
  if (output.code === 1 && text === "") return { kind: "signed-out", message: ANTIGRAVITY_SIGN_IN_MESSAGE };
  return null;
}

/** Words in `agy`'s refusal that mean the account, not the CLI, is the problem. */
const SIGNED_OUT = /\b(sign(?:ed)?[- ]?in|log(?:ged)?[- ]?in|authenticat|credential|onboarding)/i;

/**
 * What a `/usage` answer says about the account, for an `agy` whose sign-in
 * check did not answer as expected. Only a well-formed answer is signed in;
 * anything else is not, whatever the exit code.
 */
export function antigravityStatusFrom(output: { stdout: string; stderr: string; code: number | null }): ProviderStatus {
  const envelope = parseAntigravityEnvelope(output.stdout);
  if (antigravityUsageData(envelope) !== null) {
    return { kind: "signed-in", message: "Google account connected through the Antigravity CLI" };
  }
  const reported = [
    typeof envelope?.error === "string" ? envelope.error : "",
    plain(output.stderr),
  ].join("\n").trim();
  if (SIGNED_OUT.test(reported)) return { kind: "signed-out", message: ANTIGRAVITY_SIGN_IN_MESSAGE };
  const detail = reported.replace(/\s+/g, " ").slice(0, 200);
  return {
    kind: "unavailable",
    message: detail
      ? `The Antigravity CLI did not report your account: ${detail}`
      : `The Antigravity CLI did not report your account${output.code === null ? "." : ` (exit code ${output.code}).`}`,
  };
}

const NO_EFFORT_SELECTION = {
  reasoningEffort: "medium" as const,
  description: "Antigravity names the effort in the model itself.",
};

/**
 * `agy models` prints one `slug<TAB>label` line per model the account may use.
 * The slug is what `--model` takes; a variant such as `-high` names its
 * effort, so each one is its own entry rather than an effort setting.
 */
export function parseAntigravityModels(stdout: string): ProviderModelCatalog {
  const models: ProviderModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\t(.{1,200})$/.exec(line.trimEnd());
    if (match === null || models.some((model) => model.id === match[1])) continue;
    models.push({
      id: match[1],
      displayName: match[2].trim() || match[1],
      defaultReasoningEffort: NO_EFFORT_SELECTION.reasoningEffort,
      supportedReasoningEfforts: [NO_EFFORT_SELECTION],
    });
    if (models.length >= MAX_MODELS) break;
  }
  return { models, defaultModelId: models[0]?.id ?? null };
}

/**
 * The environment a sign-in runs with: the user's own home, so the credential
 * lands wherever their own `agy` keeps it, less what must stay in Roqer.
 */
export function antigravityLoginEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...environment, [AUTH_ACTION]: "login" };
  delete child.ROBLOX_STUDIO_AUTH_TOKEN;
  delete child.GEMINI_API_KEY;
  delete child.GOOGLE_API_KEY;
  return child;
}

export type AntigravitySpawn = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export type AntigravityClientOptions = {
  executable?: string;
  /** Injectable for tests. Receives the argument list, without the binary. */
  spawnProcess?: AntigravitySpawn;
  /** Injectable for tests. */
  createHome?: (options: AntigravityHomeOptions) => Promise<AntigravityHome>;
  now?: () => number;
};

/** What a planner needs in order to start an Antigravity process. */
export interface AntigravityLauncher {
  /** Start `agy` with these arguments, in that private home and its workspace. */
  launch(args: string[], home: AntigravityHome): Promise<ChildProcessWithoutNullStreams>;
}

type Collected = { stdout: string; stderr: string; code: number | null };

type PendingLogin = { child: ChildProcessWithoutNullStreams; authUrl: string; output: () => string };

/** Wait for a child to exit, or give up after `timeoutMs`. True when it exited. */
function exited(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || (child.signalCode ?? null) !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class AntigravityClient implements AntigravityLauncher {
  private readonly executable?: string;
  private readonly spawnProcess?: AntigravitySpawn;
  private readonly createHome: (options: AntigravityHomeOptions) => Promise<AntigravityHome>;
  private readonly now: () => number;

  private statusCache: { at: number; status: ProviderStatus } | null = null;
  private statusRead: Promise<ProviderStatus> | null = null;
  private statusGeneration = 0;
  private modelCatalog: { at: number; catalog: ProviderModelCatalog } | null = null;
  private pendingLogin: PendingLogin | null = null;

  constructor(options: AntigravityClientOptions = {}) {
    this.executable = options.executable;
    this.spawnProcess = options.spawnProcess;
    this.createHome = options.createHome ?? createAntigravityHome;
    this.now = options.now ?? Date.now;
  }

  async launch(args: string[], home: AntigravityHome, extra: NodeJS.ProcessEnv = {}): Promise<ChildProcessWithoutNullStreams> {
    return this.start(args, home.workspace, { ...antigravityChildEnvironment(process.env, home.home), ...extra });
  }

  /**
   * The account `agy` is signed in with. Readers that arrive together share
   * one process, and an answer is reused briefly.
   */
  getStatus(): Promise<ProviderStatus> {
    const cached = this.statusCache;
    if (cached !== null) {
      const ttl = cached.status.kind === "signed-in" ? SIGNED_IN_CACHE_TTL_MS : OTHER_STATUS_CACHE_TTL_MS;
      if (this.now() - cached.at < ttl) return Promise.resolve(cached.status);
    }
    if (this.statusRead !== null) return this.statusRead;

    const generation = this.statusGeneration;
    const read = this.queryStatus()
      .then((status) => {
        if (generation === this.statusGeneration) this.statusCache = { at: this.now(), status };
        return status;
      })
      .finally(() => {
        if (this.statusRead === read) this.statusRead = null;
      });
    this.statusRead = read;
    return read;
  }

  /**
   * The plan usage behind `/usage`: groups of models sharing a five-hour and a
   * weekly window. `/usage` answers without a model turn. Null when the
   * account could not be read.
   */
  async readUsage(): Promise<unknown> {
    const output = await this.collect(["--print", "/usage", "--output-format", "json"], USAGE_TIMEOUT_MS);
    return antigravityUsageData(parseAntigravityEnvelope(output.stdout));
  }

  /** Forget the account and its models, because something that can change them may have happened. */
  forgetStatus(): void {
    this.statusGeneration += 1;
    this.statusCache = null;
    this.statusRead = null;
    this.modelCatalog = null;
  }

  async listModels(): Promise<ProviderModelCatalog> {
    const status = await this.getStatus();
    if (status.kind !== "signed-in") {
      this.modelCatalog = null;
      return { models: [], defaultModelId: null, message: status.message };
    }
    const cached = this.modelCatalog;
    if (cached && this.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.catalog;

    let output: Collected;
    try {
      output = await this.collect(["models"], MODELS_TIMEOUT_MS);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { models: [], defaultModelId: null, message: `The Antigravity CLI did not list its models: ${detail}` };
    }
    const catalog = parseAntigravityModels(output.stdout);
    if (catalog.models.length === 0) {
      return { models: [], defaultModelId: null, message: "The Antigravity CLI did not list any models for this account." };
    }
    this.modelCatalog = { at: this.now(), catalog };
    return catalog;
  }

  /**
   * Start a Google sign-in and return the address `agy` printed for it. `agy`
   * does not open the browser in this flow and waits for the code Google's
   * page shows, which `submitLoginCode` hands it. The process is kept until
   * the sign-in ends.
   */
  async beginLogin(): Promise<{ authUrl: string }> {
    this.cancelLogin();
    this.forgetStatus();
    const child = await this.start([], os.homedir(), antigravityLoginEnvironment(process.env));
    let seen = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collectOutput = (chunk: string) => { seen = `${seen}${chunk}`.slice(-MAX_OUTPUT_LENGTH); };
    child.stdout.on("data", collectOutput);
    child.stderr.on("data", collectOutput);

    const authUrl = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        if (error) {
          child.kill();
          reject(error);
        } else {
          resolve(url!);
        }
      };
      const timer = setTimeout(() => finish(new Error("The Antigravity CLI did not return a sign-in address in time.")), LOGIN_URL_TIMEOUT_MS);
      // Pipes can split anywhere, including inside the address, so it is taken
      // only once something has followed it.
      const onData = () => {
        // eslint-disable-next-line no-control-regex
        const match = /https:\/\/[^\s"'\u001b]+(?=[\s"'\u001b])/.exec(seen);
        if (match) finish(null, match[0]);
      };
      const onExit = () => {
        const detail = plain(seen).trim().replace(/\s+/g, " ").slice(0, 200);
        finish(new Error(`The Antigravity CLI exited before sign-in started.${detail ? ` ${detail}` : ""}`));
      };
      const onError = (error: Error) => finish(error);
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });

    this.pendingLogin = { child, authUrl, output: () => seen };
    return { authUrl };
  }

  /**
   * Finish a sign-in with the code Google's page showed. Success is confirmed
   * by reading the account again, never by the exit code alone.
   */
  async submitLoginCode(code: string): Promise<ProviderLoginResult> {
    const login = this.pendingLogin;
    if (!login) return { ok: false, message: "No Antigravity sign-in is waiting for a code. Choose Connect to start one." };

    const trimmed = code.trim();
    if (trimmed === "" || trimmed.length > MAX_LOGIN_CODE_LENGTH || /[\s]/.test(trimmed)) {
      return { ok: false, message: "That does not look like a Google authorization code." };
    }
    const before = login.output().length;
    try {
      login.child.stdin.write(`${trimmed}\n`);
    } catch {
      this.cancelLogin();
      return { ok: false, message: "The Antigravity CLI stopped accepting the sign-in code. Choose Connect to try again." };
    }
    if (!await exited(login.child, LOGIN_FINISH_TIMEOUT_MS)) login.child.kill();
    if (this.pendingLogin === login) this.pendingLogin = null;

    this.forgetStatus();
    const status = await this.getStatus();
    if (status.kind === "signed-in") return { ok: true, message: status.message };
    const said = plain(login.output().slice(before)).trim().replace(/\s+/g, " ").slice(0, 200);
    return {
      ok: false,
      message: `Google did not accept that code${said ? `: ${said}` : "."} Choose Connect to try again.`,
    };
  }

  /**
   * Wait for the pending sign-in to end, however it ends, and report whether
   * the account is now signed in. It ends when a code is handed over or the
   * sign-in is cancelled.
   */
  async waitForLogin(timeoutMs = LOGIN_WAIT_TIMEOUT_MS): Promise<ProviderLoginResult> {
    const login = this.pendingLogin;
    if (!login) {
      const status = await this.getStatus();
      return status.kind === "signed-in" ? { ok: true, message: status.message } : { ok: false, message: "No Antigravity sign-in is waiting." };
    }
    if (!await exited(login.child, timeoutMs)) {
      if (this.pendingLogin === login) this.cancelLogin();
      return { ok: false, message: "The Antigravity sign-in was not finished in time. Choose Connect to try again." };
    }
    if (this.pendingLogin === login) this.pendingLogin = null;
    this.forgetStatus();
    const status = await this.getStatus();
    if (status.kind === "signed-in") return { ok: true, message: status.message };
    return { ok: false, message: "The Antigravity sign-in did not finish. Choose Connect to try again." };
  }

  /** The address of the sign-in in progress, if one is. */
  pendingLoginUrl(): string | null {
    return this.pendingLogin?.authUrl ?? null;
  }

  cancelLogin(): void {
    if (!this.pendingLogin) return;
    const { child } = this.pendingLogin;
    this.pendingLogin = null;
    child.stdin.end();
    child.kill();
  }

  close(): void {
    this.cancelLogin();
    this.statusRead = null;
  }

  /**
   * Ask `agy` whether an account is signed in. When it answers in a way this
   * reader does not know, `/usage` is asked instead, which only a signed-in
   * account can answer.
   */
  private async queryStatus(): Promise<ProviderStatus> {
    try {
      const checked = antigravityCheckStatus(await this.collect([], CHECK_TIMEOUT_MS, { [AUTH_ACTION]: "check" }));
      if (checked !== null) return checked;
      return antigravityStatusFrom(await this.collect(["--print", "/usage", "--output-format", "json"], USAGE_TIMEOUT_MS));
    } catch (error) {
      if (error instanceof ClientNotInstalledError) {
        return { kind: "not-installed", message: "The Antigravity CLI was not found on this computer. Install it to use Antigravity." };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", message: `The Antigravity CLI is unavailable: ${detail}` };
    }
  }

  private async start(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> {
    if (this.spawnProcess) return this.spawnProcess(args, { cwd, env });
    const executable = await resolveAntigravityExecutable({ executable: this.executable });
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return child;
  }

  /** Run a short-lived `agy` in a private home of its own, collect what it wrote, and remove the home. */
  private async collect(args: string[], timeoutMs: number, extra: NodeJS.ProcessEnv = {}): Promise<Collected> {
    const home = await this.createHome({});
    try {
      const child = await this.launch(args, home, extra);
      child.stdin.end();
      return await new Promise<Collected>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error(`\`agy ${args[0] ?? "auth check"}\` timed out.`));
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, MAX_OUTPUT_LENGTH); });
        child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_LENGTH); });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
      });
    } finally {
      await home.remove();
    }
  }
}
