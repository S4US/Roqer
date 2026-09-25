import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import readline from "node:readline";

import {
  isReasoningEffort,
  type ProviderLoginResult,
  type ProviderModel,
  type ProviderModelCatalog,
  type ProviderStatus,
  type ReasoningEffort,
} from "../shared/provider";
import { resolveClaudeExecutable } from "./claude-executable";

/**
 * Roqer's client for the locally installed Claude Code CLI.
 *
 * Claude Code owns the subscription credential exactly the way Codex owns the
 * ChatGPT one: it stores the OAuth tokens, refreshes them, and signs every
 * request. Roqer never sees, stores, or forwards a token — it starts the
 * binary, reads its status, and drives its sign-in flow.
 */

type JsonRecord = Record<string, unknown>;

const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_URL_TIMEOUT_MS = 45_000;
const MAX_LOGIN_OUTPUT_LENGTH = 64 * 1024;
const LOGIN_FINISH_TIMEOUT_MS = 180_000;
const MAX_LOGIN_CODE_LENGTH = 512;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `claude auth status` prints a JSON object and exits non-zero when signed
 * out, so the payload is extracted rather than gated on the exit code.
 */
function parseJsonObject(text: string): JsonRecord | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function planLabel(subscriptionType: string | undefined): string {
  if (!subscriptionType) return "Claude";
  return `${subscriptionType[0].toUpperCase()}${subscriptionType.slice(1)}`;
}

const EFFORT_DESCRIPTIONS: Partial<Record<ReasoningEffort, string>> = {
  low: "Cheapest. Good for small, well-specified edits.",
  medium: "Balanced for routine Studio work.",
  high: "Thorough inspection before changes.",
  xhigh: "Best for multi-step agentic work.",
  max: "Correctness over cost.",
};

/** What a run starts at when the user has not chosen, if the model offers it. */
const PREFERRED_DEFAULT_EFFORT: ReasoningEffort = "high";

/**
 * A model Claude Code offers without effort selection still needs one entry in
 * the catalog's effort list, because every catalog model declares one. The
 * planner does not pass `--effort` for it; this entry only fills the picker.
 */
const NO_EFFORT_SELECTION = {
  reasoningEffort: "medium" as const,
  description: "This model does not offer effort selection.",
};

/** The model a headless evaluation run uses when none is named. */
export const CLAUDE_DEFAULT_MODEL_ID = "opus";

/** Claude Code's own alias for "whatever it recommends"; its target is listed separately. */
const RECOMMENDED_ALIAS = "default";

/**
 * How long a model listing is reused. Listing starts a Claude Code process, and
 * the catalog is read before every run as well as by the picker; the set of
 * models an account can use does not change between two messages.
 */
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 30_000;

/**
 * How long a signed-in status is reused.
 *
 * Every message used to start `claude auth status` three times in a row before
 * anything reached the model — to admit the run, inside the model listing, and
 * again in the planner — at about 300 ms a process. The account does not change
 * between those reads. Only a signed-in answer is kept: a signed-out or
 * unreadable one is read again every time, so signing in from a terminal is
 * noticed at once, and Roqer's own sign-in forgets the cached answer.
 */
const STATUS_CACHE_TTL_MS = 30_000;

/**
 * The arguments for a Claude Code process that is only asked about itself.
 * Nothing is sent to a model; the process is killed once it has answered.
 */
const INITIALIZE_ARGS = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--tools", "",
  "--disable-slash-commands",
  "--setting-sources", "",
  "--strict-mcp-config",
];

type ClaudeModelListing = { catalog: ProviderModelCatalog; effortModels: ReadonlySet<string> };

/**
 * Turn Claude Code's `initialize` model list into Roqer's catalog.
 *
 * Model ids are Claude Code's own `--model` values — mostly aliases such as
 * `opus` — so a new model reaches the picker the day the user's Claude Code
 * offers it, with no Roqer release. The `default` alias is dropped in favour of
 * the entry it resolves to, which becomes the catalog default.
 */
export function parseClaudeModels(value: unknown): ClaudeModelListing {
  const entries = Array.isArray(value) ? value.filter(isRecord) : [];
  const recommended = entries.find((entry) => entry.value === RECOMMENDED_ALIAS);
  const models: ProviderModel[] = [];
  const effortModels = new Set<string>();
  let defaultModelId: string | null = null;

  for (const entry of entries) {
    if (typeof entry.value !== "string" || entry.value === "" || entry.value === RECOMMENDED_ALIAS) continue;
    if (models.some((model) => model.id === entry.value)) continue;
    const displayName = typeof entry.displayName === "string" && entry.displayName !== ""
      ? entry.displayName
      : entry.value;
    const efforts = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.filter(isReasoningEffort)
      : [];
    const supportedReasoningEfforts = efforts.length > 0
      ? efforts.map((reasoningEffort) => ({
        reasoningEffort,
        ...(EFFORT_DESCRIPTIONS[reasoningEffort] ? { description: EFFORT_DESCRIPTIONS[reasoningEffort] } : {}),
      }))
      : [NO_EFFORT_SELECTION];
    if (efforts.length > 0) effortModels.add(entry.value);
    models.push({
      id: entry.value,
      displayName,
      ...(typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {}),
      defaultReasoningEffort: efforts.includes(PREFERRED_DEFAULT_EFFORT)
        ? PREFERRED_DEFAULT_EFFORT
        : supportedReasoningEfforts[0].reasoningEffort,
      supportedReasoningEfforts,
    });
    if (defaultModelId === null && recommended !== undefined &&
      typeof entry.resolvedModel === "string" && entry.resolvedModel === recommended.resolvedModel) {
      defaultModelId = entry.value;
    }
  }

  return { catalog: { models, defaultModelId: defaultModelId ?? models[0]?.id ?? null }, effortModels };
}

export type ClaudeCodeClientOptions = {
  executable?: string;
  cwd?: string;
  /** Injectable for tests. Receives the argument list, without the binary. */
  spawnProcess?: (args: string[]) => ChildProcessWithoutNullStreams;
  /** Injectable for tests. */
  now?: () => number;
};

/** What a planner needs in order to start a Claude Code turn. */
export interface ClaudeLauncher {
  launch(args: string[]): Promise<ChildProcessWithoutNullStreams>;
}

type PendingLogin = {
  child: ChildProcessWithoutNullStreams;
  authUrl: string;
};

export class ClaudeCodeClient implements ClaudeLauncher {
  private readonly executable?: string;
  private readonly cwd?: string;
  private readonly spawnProcess?: (args: string[]) => ChildProcessWithoutNullStreams;

  private readonly now: () => number;

  private pendingLogin: PendingLogin | null = null;
  private modelListing: { at: number; listing: ClaudeModelListing } | null = null;
  private statusCache: { at: number; status: ProviderStatus } | null = null;
  private statusRead: Promise<ProviderStatus> | null = null;
  /** Bumped whenever the account may have changed, so a read begun before that is never cached. */
  private statusGeneration = 0;

  constructor(options: ClaudeCodeClientOptions = {}) {
    this.executable = options.executable;
    this.cwd = options.cwd;
    this.spawnProcess = options.spawnProcess;
    this.now = options.now ?? Date.now;
  }

  async launch(args: string[]): Promise<ChildProcessWithoutNullStreams> {
    if (this.spawnProcess) return this.spawnProcess(args);

    const childEnvironment = { ...process.env };
    // The model provider never talks to the Roblox MCP directly. Keep the MCP
    // bridge secret in Roqer even when the server was configured by env.
    delete childEnvironment.ROBLOX_STUDIO_AUTH_TOKEN;
    const executable = await resolveClaudeExecutable({ executable: this.executable });
    const child = spawn(executable, args, {
      cwd: this.cwd,
      env: childEnvironment,
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

  /**
   * The account Claude Code is signed in with. Readers that arrive together
   * share one process, and a signed-in answer is reused briefly; see
   * `STATUS_CACHE_TTL_MS`.
   */
  getStatus(): Promise<ProviderStatus> {
    const cached = this.statusCache;
    if (cached !== null && this.now() - cached.at < STATUS_CACHE_TTL_MS) return Promise.resolve(cached.status);
    if (this.statusRead !== null) return this.statusRead;

    const generation = this.statusGeneration;
    const read: Promise<ProviderStatus> = this.readStatus()
      .then((status) => {
        if (generation === this.statusGeneration && status.kind === "signed-in") {
          this.statusCache = { at: this.now(), status };
        }
        return status;
      })
      .finally(() => {
        if (this.statusRead === read) this.statusRead = null;
      });
    this.statusRead = read;
    return read;
  }

  /** Forget the account state, because something that can change it just happened. */
  private forgetStatus(): void {
    this.statusGeneration += 1;
    this.statusCache = null;
    this.statusRead = null;
  }

  private async readStatus(): Promise<ProviderStatus> {
    let output: { stdout: string; stderr: string };
    try {
      output = await this.collect(["auth", "status", "--json"], STATUS_TIMEOUT_MS);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", message: `Claude Code is unavailable: ${detail}` };
    }

    const parsed = parseJsonObject(output.stdout);
    if (!parsed || typeof parsed.loggedIn !== "boolean") {
      const detail = output.stderr.trim() || output.stdout.trim();
      return {
        kind: "unavailable",
        message: detail
          ? `Claude Code returned an unreadable status: ${detail.slice(0, 200)}`
          : "Claude Code returned an unreadable status.",
      };
    }

    if (!parsed.loggedIn) return { kind: "signed-out", message: "Connect your Claude subscription" };

    const email = typeof parsed.email === "string" && parsed.email !== "" ? parsed.email : undefined;
    const subscriptionType = typeof parsed.subscriptionType === "string" && parsed.subscriptionType !== ""
      ? parsed.subscriptionType
      : undefined;

    // Roqer's subscription provider never consumes API credentials. A Console
    // login is therefore treated as disconnected even though Claude Code can
    // use it for its own API-billed work; Connect starts the official
    // `--claudeai` flow and replaces it with a subscription session.
    if (parsed.authMethod !== "claude.ai") {
      return {
        kind: "signed-out",
        message: "Claude Code is using Anthropic Console credentials. Connect your Claude subscription to use it in Roqer.",
      };
    }

    return {
      kind: "signed-in",
      message: `${planLabel(subscriptionType)} connected through Claude Code`,
      ...(email ? { email } : {}),
      ...(subscriptionType ? { planType: subscriptionType } : {}),
    };
  }

  /**
   * Start the subscription sign-in and return the authorization URL the CLI
   * printed. The child is kept alive: Claude Code's flow ends with the user
   * pasting a code back, which `submitLoginCode` writes to its stdin.
   */
  async beginLogin(): Promise<{ authUrl: string }> {
    this.cancelLogin();
    // A different account may be about to sign in, with a different plan.
    this.modelListing = null;
    this.forgetStatus();
    const child = await this.launch(["auth", "login", "--claudeai"]);

    const authUrl = await new Promise<string>((resolve, reject) => {
      let seen = "";
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error("Claude Code did not return a sign-in address in time."));
      }, LOGIN_URL_TIMEOUT_MS);

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

      // Pipes can split anywhere, including inside the URL. Wait for a printed
      // delimiter before accepting it; the prompt itself need not end in a newline.
      const onData = (chunk: Buffer | string) => {
        seen += chunk.toString();
        if (seen.length > MAX_LOGIN_OUTPUT_LENGTH) {
          finish(new Error("Claude Code returned too much sign-in output."));
          return;
        }
        const match = /https:\/\/[^\s"']+(?=[\s"'])/.exec(seen);
        if (match) finish(null, match[0]);
      };
      const onExit = () => finish(new Error("Claude Code exited before sign-in started."));
      const onError = (error: Error) => finish(error);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });

    this.pendingLogin = { child, authUrl };
    return { authUrl };
  }

  /**
   * Finish a sign-in by handing Claude Code the code from the callback page.
   * Success is confirmed by re-reading the account, never by the exit code
   * alone.
   */
  async submitLoginCode(code: string): Promise<ProviderLoginResult> {
    const login = this.pendingLogin;
    if (!login) return { ok: false, message: "No Claude sign-in is waiting for a code." };

    const trimmed = code.trim();
    if (trimmed === "" || trimmed.length > MAX_LOGIN_CODE_LENGTH || /[\r\n]/.test(trimmed)) {
      return { ok: false, message: "That does not look like a Claude authorization code." };
    }

    try {
      login.child.stdin.write(`${trimmed}\n`);
    } catch {
      this.cancelLogin();
      return { ok: false, message: "Claude Code stopped accepting the sign-in code." };
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        login.child.kill();
        resolve();
      }, LOGIN_FINISH_TIMEOUT_MS);
      login.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.pendingLogin = null;

    // Confirmed by a fresh read: an answer from before the code was accepted
    // says nothing about whether it was.
    this.forgetStatus();
    const status = await this.getStatus();
    if (status.kind === "signed-in") return { ok: true, message: status.message };
    return { ok: false, message: "Claude Code did not accept that code. Try connecting again." };
  }

  cancelLogin(): void {
    if (!this.pendingLogin) return;
    const { child } = this.pendingLogin;
    this.pendingLogin = null;
    child.stdin.end();
    child.kill();
  }

  async listModels(): Promise<ProviderModelCatalog> {
    const status = await this.getStatus();
    if (status.kind !== "signed-in") {
      this.modelListing = null;
      return { models: [], defaultModelId: null, message: status.message };
    }
    const cached = this.modelListing;
    if (cached && this.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.listing.catalog;

    const listing = parseClaudeModels(await this.readInitializeModels());
    if (listing.catalog.models.length === 0) {
      return { models: [], defaultModelId: null, message: "Claude Code did not list any models for this account." };
    }
    this.modelListing = { at: this.now(), listing };
    return listing.catalog;
  }

  /**
   * Whether `--effort` may be passed for this model, from the latest listing.
   * A model the listing did not mark as effort-capable gets no flag: passing it
   * to one that does not take it is an error, and leaving it off only means
   * Claude Code's own default.
   */
  modelSupportsEffort(modelId: string): boolean {
    return this.modelListing?.listing.effortModels.has(modelId) ?? false;
  }

  close(): void {
    this.cancelLogin();
  }

  /**
   * Ask a Claude Code process which models this account may use.
   *
   * The stream-json `initialize` control request answers with the same list the
   * CLI's own model picker shows, resolved for the signed-in plan. No model is
   * called.
   */
  private async readInitializeModels(): Promise<unknown> {
    const child = await this.launch(INITIALIZE_ARGS);
    const requestId = `roqer-models-${this.now()}`;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Claude Code did not list its models in time.")), MODEL_LIST_TIMEOUT_MS);
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        let settled = false;
        let stderr = "";
        const finish = (error: Error | null, models?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          lines.close();
          if (error) reject(error);
          else resolve(models);
        };
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-500); });
        lines.on("error", (error) => finish(error));
        child.once("error", (error) => finish(error));
        lines.once("close", () => {
          const detail = stderr.trim();
          finish(new Error(`Claude Code exited before listing its models.${detail ? ` ${detail}` : ""}`));
        });
        lines.on("line", (line) => {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (!isRecord(message) || message.type !== "control_response" || !isRecord(message.response)) return;
          const response = message.response;
          if (response.request_id !== requestId) return;
          if (response.subtype !== "success" || !isRecord(response.response)) {
            finish(new Error(typeof response.error === "string" ? response.error : "Claude Code refused to list its models."));
            return;
          }
          finish(null, response.response.models);
        });
        child.stdin.write(`${JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        })}\n`);
      });
    } finally {
      child.stdin.end();
      child.kill();
    }
  }

  /** Run a short-lived command and collect everything it wrote. */
  private async collect(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const child = await this.launch(args);
    child.stdin.end();
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`\`claude ${args[0]}\` timed out.`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr });
      });
    });
  }
}
