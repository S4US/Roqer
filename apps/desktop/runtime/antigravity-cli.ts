import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProviderModel, ProviderModelCatalog, ProviderStatus } from "../shared/provider";
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
 * sees it. Every process Roqer starts runs in a private home of its own (see
 * `antigravity-home.ts`), including the short-lived ones that only report the
 * account and its models.
 *
 * Roqer does not drive the sign-in. `agy` has no command for it outside its
 * own terminal interface, so the user signs in by running `agy` once.
 */

type JsonRecord = Record<string, unknown>;

const STATUS_TIMEOUT_MS = 45_000;
const MODELS_TIMEOUT_MS = 45_000;
/** A signed-in answer is reused this long; asking starts `agy`, which takes seconds. */
const STATUS_CACHE_TTL_MS = 60_000;
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MAX_OUTPUT_LENGTH = 256 * 1024;
const MAX_MODELS = 64;

export const ANTIGRAVITY_SIGN_IN_MESSAGE =
  "Sign in to Antigravity: run agy in a terminal once and follow its sign-in, then choose Check.";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** Words in `agy`'s refusal that mean the account, not the CLI, is the problem. */
const SIGNED_OUT = /\b(sign(?:ed)?[- ]?in|log(?:ged)?[- ]?in|authenticat|credential|onboarding)/i;

/**
 * What a `/usage` answer says about the account. Only a well-formed answer is
 * signed in; anything else is not, whatever the exit code.
 */
export function antigravityStatusFrom(output: { stdout: string; stderr: string; code: number | null }): ProviderStatus {
  const envelope = parseAntigravityEnvelope(output.stdout);
  if (antigravityUsageData(envelope) !== null) {
    return { kind: "signed-in", message: "Google account connected through the Antigravity CLI" };
  }
  const reported = [
    typeof envelope?.error === "string" ? envelope.error : "",
    output.stderr,
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

export class AntigravityClient implements AntigravityLauncher {
  private readonly executable?: string;
  private readonly spawnProcess?: AntigravitySpawn;
  private readonly createHome: (options: AntigravityHomeOptions) => Promise<AntigravityHome>;
  private readonly now: () => number;

  private statusCache: { at: number; status: ProviderStatus; usage: JsonRecord | null } | null = null;
  private statusRead: Promise<{ status: ProviderStatus; usage: JsonRecord | null }> | null = null;
  private statusGeneration = 0;
  private modelCatalog: { at: number; catalog: ProviderModelCatalog } | null = null;

  constructor(options: AntigravityClientOptions = {}) {
    this.executable = options.executable;
    this.spawnProcess = options.spawnProcess;
    this.createHome = options.createHome ?? createAntigravityHome;
    this.now = options.now ?? Date.now;
  }

  async launch(args: string[], home: AntigravityHome): Promise<ChildProcessWithoutNullStreams> {
    const env = antigravityChildEnvironment(process.env, home.home);
    if (this.spawnProcess) return this.spawnProcess(args, { cwd: home.workspace, env });
    const executable = await resolveAntigravityExecutable({ executable: this.executable });
    const child = spawn(executable, args, {
      cwd: home.workspace,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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

  /** The executable Roqer runs, for its version. */
  locate(): Promise<string> {
    return resolveAntigravityExecutable({ executable: this.executable });
  }

  /**
   * The account `agy` is signed in with. Readers that arrive together share
   * one process, and a signed-in answer is reused briefly.
   */
  async getStatus(): Promise<ProviderStatus> {
    return (await this.readAccount()).status;
  }

  /**
   * The plan usage behind `/usage`, as `agy` reported it with the latest
   * status: groups of models sharing a five-hour and a weekly window. Null
   * when the account could not be read.
   */
  async readUsage(): Promise<unknown> {
    // Usage moves with every run, so it is read fresh rather than from a status
    // that may be a minute old.
    this.forgetAccount();
    return (await this.readAccount()).usage;
  }

  /** Forget the account and its models, because something that can change them may have happened. */
  forgetStatus(): void {
    this.forgetAccount();
    this.modelCatalog = null;
  }

  private forgetAccount(): void {
    this.statusGeneration += 1;
    this.statusCache = null;
    this.statusRead = null;
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

  close(): void {
    this.statusRead = null;
  }

  private readAccount(): Promise<{ status: ProviderStatus; usage: JsonRecord | null }> {
    const cached = this.statusCache;
    if (cached !== null && this.now() - cached.at < STATUS_CACHE_TTL_MS) return Promise.resolve(cached);
    if (this.statusRead !== null) return this.statusRead;

    const generation = this.statusGeneration;
    const read = this.queryAccount()
      .then((reading) => {
        if (generation === this.statusGeneration && reading.status.kind === "signed-in") {
          this.statusCache = { at: this.now(), ...reading };
        }
        return reading;
      })
      .finally(() => {
        if (this.statusRead === read) this.statusRead = null;
      });
    this.statusRead = read;
    return read;
  }

  /**
   * `/usage` answers without a model turn and needs a signed-in account, so
   * one call tells both whether the account works and how much of the plan is
   * left.
   */
  private async queryAccount(): Promise<{ status: ProviderStatus; usage: JsonRecord | null }> {
    let output: Collected;
    try {
      output = await this.collect(["--print", "/usage", "--output-format", "json"], STATUS_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ClientNotInstalledError) {
        return {
          status: { kind: "not-installed", message: "The Antigravity CLI was not found on this computer. Install it to use Antigravity." },
          usage: null,
        };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { status: { kind: "unavailable", message: `The Antigravity CLI is unavailable: ${detail}` }, usage: null };
    }
    return {
      status: antigravityStatusFrom(output),
      usage: antigravityUsageData(parseAntigravityEnvelope(output.stdout)),
    };
  }

  /** Run a short-lived `agy` in a private home of its own, collect what it wrote, and remove the home. */
  private async collect(args: string[], timeoutMs: number): Promise<Collected> {
    const home = await this.createHome({});
    try {
      const child = await this.launch(args, home);
      child.stdin.end();
      return await new Promise<Collected>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error(`\`agy ${args[0]}\` timed out.`));
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
