import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import readline from "node:readline";

import {
  isReasoningEffort,
  type ChatGptModel,
  type ChatGptModelCatalog,
  type ChatGptStatus,
} from "../shared/provider";
import { resolveCodexExecutable } from "./codex-executable";

type JsonRecord = Record<string, unknown>;
type RequestId = number | string;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type AppServerNotification = {
  method: string;
  params: JsonRecord;
};

export type AppServerRequest = AppServerNotification & { id: RequestId };
export type AppServerRequestHandler = (request: AppServerRequest) => Promise<unknown | undefined>;

export type CodexAppServerOptions = {
  executable?: string;
  cwd?: string;
  /**
   * Codex's configuration and sign-in folder for this client, in place of
   * the user's own `~/.codex`. See `codexChildEnvironment`.
   */
  codexHome?: string;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
};

/**
 * Codex features that act on their own rather than through Roqer's tools:
 * the shell, apps and plugins, the browser and computer use, image
 * generation, sub-agents, hooks, memories, and tool suggestions.
 *
 * Passed as `-c features.<name>=false` rather than `--disable <name>`: Codex
 * refuses to start on a `--disable` it does not recognize, but ignores an
 * unknown `features` key, so a user on an older or newer Codex still starts.
 * `chatgpt-planner.ts` stops any turn that uses a built-in tool anyway.
 */
const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "hooks",
  "memories",
  "tool_suggest",
  "skill_mcp_dependency_install",
] as const;

export const CODEX_LOCKDOWN_ARGS: readonly string[] =
  CODEX_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]);

export function codexAppServerArgs(): string[] {
  return ["app-server", ...CODEX_LOCKDOWN_ARGS, "--stdio"];
}

/**
 * The environment the Codex app-server runs with.
 *
 * `CODEX_HOME` points at a folder Roqer owns, so the user's own Codex
 * configuration never loads inside a Roqer run: the MCP servers, plugins,
 * hooks, and instructions they set up for Codex would otherwise run beside
 * Roqer's tools, outside its approvals. That includes the Roblox Studio MCP
 * this repository's README tells people to register with `codex mcp add`,
 * which would reach Studio directly. The ChatGPT sign-in lives in that
 * folder too, so Roqer asks for its own once.
 *
 * The bridge's credential is removed as well: the model provider never talks
 * to the Roblox MCP directly.
 */
export function codexChildEnvironment(base: NodeJS.ProcessEnv, codexHome?: string): NodeJS.ProcessEnv {
  const environment = { ...base };
  delete environment.ROBLOX_STUDIO_AUTH_TOKEN;
  if (codexHome !== undefined) environment.CODEX_HOME = codexHome;
  return environment;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asParams(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function rpcError(value: unknown): Error {
  if (isRecord(value) && typeof value.message === "string") return new Error(value.message);
  return new Error("Codex app-server returned an error.");
}

/**
 * Small JSON-RPC client for the supported Codex app-server stdio protocol.
 * It owns the child process and keeps every credential inside Codex itself.
 */
export class CodexAppServerClient {
  private readonly executable?: string;
  private readonly cwd?: string;
  private readonly codexHome?: string;
  private readonly spawnProcess?: () => ChildProcessWithoutNullStreams;

  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notifications = new Set<(notification: AppServerNotification) => void>();
  private readonly requestHandlers = new Set<AppServerRequestHandler>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private disconnectError: Error | null = null;
  private stderrTail = "";

  constructor(options: CodexAppServerOptions = {}) {
    this.executable = options.executable;
    this.cwd = options.cwd;
    this.codexHome = options.codexHome;
    this.spawnProcess = options.spawnProcess;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const starting = this.startInternal().catch((error) => {
      // A previous child's delayed failure must not stop a replacement process.
      if (this.startPromise === starting) {
        this.stopProcess(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    });
    this.startPromise = starting;
    return this.startPromise;
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    await this.start();
    return this.sendRequest<T>(method, params);
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  handleRequests(handler: AppServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    if (!this.child && this.disconnectError) listener(this.disconnectError);
    return () => this.disconnectListeners.delete(listener);
  }

  async getChatGptStatus(refreshToken = false): Promise<ChatGptStatus> {
    try {
      const result = await this.request("account/read", { refreshToken });
      if (!isRecord(result)) return { kind: "unavailable", message: "Codex returned an invalid account status." };
      const account = result.account;
      if (!isRecord(account) || account.type !== "chatgpt") {
        return { kind: "signed-out", message: "Connect your ChatGPT subscription" };
      }

      const email = typeof account.email === "string" && account.email !== "" ? account.email : undefined;
      const planType = typeof account.planType === "string" && account.planType !== ""
        ? account.planType
        : undefined;
      const planLabel = planType ? `${planType[0].toUpperCase()}${planType.slice(1)}` : "ChatGPT";
      return {
        kind: "signed-in",
        message: `${planLabel} connected through Codex`,
        ...(email ? { email } : {}),
        ...(planType ? { planType } : {}),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", message: `Codex app-server is unavailable: ${detail}` };
    }
  }

  async beginChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    const result = await this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
    if (!isRecord(result) || result.type !== "chatgpt" ||
      typeof result.loginId !== "string" || typeof result.authUrl !== "string") {
      throw new Error("Codex did not return a ChatGPT sign-in URL.");
    }
    return { loginId: result.loginId, authUrl: result.authUrl };
  }

  async listChatGptModels(): Promise<ChatGptModelCatalog> {
    const models: ChatGptModel[] = [];
    let defaultModelId: string | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: unknown = await this.request("model/list", {
        limit: 50,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new Error("Codex returned an invalid model catalog.");
      }
      for (const value of result.data) {
        if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string" ||
          !Array.isArray(value.supportedReasoningEfforts)) continue;
        const supportedReasoningEfforts = value.supportedReasoningEfforts.flatMap((entry) => {
          if (!isRecord(entry) || !isReasoningEffort(entry.reasoningEffort)) return [];
          return [{
            reasoningEffort: entry.reasoningEffort,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          }];
        });
        if (supportedReasoningEfforts.length === 0) continue;
        const fallbackEffort = supportedReasoningEfforts[0].reasoningEffort;
        const defaultReasoningEffort = isReasoningEffort(value.defaultReasoningEffort) &&
          supportedReasoningEfforts.some((entry) => entry.reasoningEffort === value.defaultReasoningEffort)
          ? value.defaultReasoningEffort
          : fallbackEffort;
        models.push({
          id: value.id,
          displayName: value.displayName,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
          defaultReasoningEffort,
          supportedReasoningEfforts,
        });
        if (value.isDefault === true) defaultModelId = value.id;
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : null;
      if (!cursor) break;
    }

    const preferred = defaultModelId ?? models[0]?.id;
    return { models, defaultModelId: preferred && models.some((model) => model.id === preferred) ? preferred : null };
  }

  close(): void {
    if (!this.child) return;
    this.stopProcess(new Error("Codex app-server closed."));
  }

  private async startInternal(): Promise<void> {
    const childEnvironment = codexChildEnvironment(process.env, this.codexHome);
    // Codex refuses a CODEX_HOME that does not exist yet.
    if (this.codexHome !== undefined && !this.spawnProcess) mkdirSync(this.codexHome, { recursive: true });
    const executable = this.spawnProcess ? undefined : await resolveCodexExecutable({ executable: this.executable });
    const child = this.spawnProcess?.() ?? spawn(executable!, codexAppServerArgs(), {
      cwd: this.cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.disconnectError = null;
    this.stderrTail = "";
    this.attachProcess(child);

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

    if (this.child !== child) throw new Error("Codex app-server closed during startup.");
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "studio_workbench",
        title: "Roqer",
        version: "0.0.1",
      },
      capabilities: { experimentalApi: true },
    });
    this.sendNotification("initialized", {});
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (this.child === child) this.receiveLine(line, child);
    });
    if (this.child !== child) throw new Error("Codex app-server closed during startup.");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });
    const disconnect = (error: Error) => {
      if (this.child !== child) return;
      lines.close();
      this.stopProcess(error);
    };
    child.on("error", disconnect);
    child.stdin.on("error", disconnect);
    // readline re-emits a stdout error on the interface, and an interface with
    // no listener throws it out of the emit. Take it here so a broken pipe ends
    // the run as a disconnect instead of an uncaught exception.
    lines.on("error", disconnect);
    child.stdout.on("error", disconnect);
    child.stdout.once("end", () => disconnect(new Error("Codex app-server output closed.")));
    child.once("exit", (code, signal) => {
      const suffix = this.stderrTail.trim();
      const reason = `Codex app-server exited (${signal ?? code ?? "unknown"}).${suffix ? ` ${suffix}` : ""}`;
      disconnect(new Error(reason));
    });
  }

  private receiveLine(line: string, child: ChildProcessWithoutNullStreams): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (message.id !== undefined && typeof message.method === "string") {
      const id = message.id;
      if (typeof id !== "number" && typeof id !== "string") return;
      void this.dispatchServerRequest({ id, method: message.method, params: asParams(message.params) }, child)
        .catch((error: unknown) => {
          if (this.child === child) {
            this.stopProcess(error instanceof Error ? error : new Error(String(error)));
          }
        });
      return;
    }

    if (message.id !== undefined) {
      const id = message.id;
      if (typeof id !== "number" && typeof id !== "string") return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error !== undefined) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      const notification = { method: message.method, params: asParams(message.params) };
      for (const listener of this.notifications) listener(notification);
    }
  }

  private async dispatchServerRequest(request: AppServerRequest, child: ChildProcessWithoutNullStreams): Promise<void> {
    for (const handler of this.requestHandlers) {
      try {
        const result = await handler(request);
        if (this.child !== child) return;
        if (result !== undefined) {
          this.write({ jsonrpc: "2.0", id: request.id, result });
          return;
        }
      } catch (error) {
        if (this.child !== child) return;
        this.write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
    }
    this.write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Unsupported app-server request: ${request.method}` },
    });
  }

  private sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonRecord): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private stopProcess(error: Error): void {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.disconnectError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    child?.stdin.destroy();
    child?.kill();
    for (const listener of this.disconnectListeners) listener(error);
  }
}
