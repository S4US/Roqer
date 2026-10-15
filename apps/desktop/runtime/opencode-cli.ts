import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProviderLoginResult, ProviderModel, ProviderModelCatalog, ProviderStatus } from "../shared/provider";
import { REASONING_EFFORTS } from "../shared/provider";
import { ClientNotInstalledError } from "./client-not-installed";
import { resolveOpenCodeExecutable } from "./opencode-executable";
import { createOpenCodeHome, opencodeChildEnvironment } from "./opencode-home";

const MAX_OUTPUT_LENGTH = 256 * 1024;
const MODEL_CACHE_MS = 60_000;

/** Advertise only active tool-capable models whose reported prices are zero. */
export function parseOpenCodeModels(output: string): ProviderModel[] {
  const entries = output.split(/^(opencode\/[^\s]{1,200})\r?$/m);
  const models: ProviderModel[] = [];
  for (let index = 1; index < entries.length; index += 2) {
    const id = entries[index];
    const metadata: unknown = JSON.parse(entries[index + 1].trim());
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) continue;
    const model = metadata as Record<string, unknown>;
    const cost = model.cost;
    if (typeof cost !== "object" || cost === null || Array.isArray(cost)) continue;
    const price = cost as Record<string, unknown>;
    const cache = price.cache;
    if (cache !== undefined && (typeof cache !== "object" || cache === null ||
      !("read" in cache) || cache.read !== 0 || !("write" in cache) || cache.write !== 0)) continue;
    const capabilities = model.capabilities;
    if (model.status !== "active" || price.input !== 0 || price.output !== 0 ||
      typeof capabilities !== "object" || capabilities === null || !("toolcall" in capabilities) || capabilities.toolcall !== true) continue;
    if (models.some((entry) => entry.id === id)) continue;
    const variants = model.variants;
    const efforts = REASONING_EFFORTS.filter((effort) => {
      if (typeof variants !== "object" || variants === null || !Object.hasOwn(variants, effort)) return false;
      const variant = (variants as Record<string, unknown>)[effort];
      return typeof variant === "object" && variant !== null && !Array.isArray(variant);
    });
    const limit = model.limit;
    const contextWindow = typeof limit === "object" && limit !== null && "context" in limit ? limit.context : undefined;
    models.push({
      id,
      displayName: typeof model.name === "string" ? model.name.slice(0, 200) : id,
      defaultReasoningEffort: efforts.includes("medium") ? "medium" : efforts[0] ?? "none",
      supportedReasoningEfforts: (efforts.length ? efforts : ["none" as const]).map((reasoningEffort) => ({ reasoningEffort })),
      runsOn: "OpenCode",
      ...(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    });
    if (models.length >= 64) break;
  }
  if (models.length === 0) throw new Error("OpenCode did not report any free models available without login.");
  return models;
}

export type OpenCodeClientOptions = {
  resolveExecutable?: () => Promise<string>;
  spawnProcess?: (executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  now?: () => number;
};

export class OpenCodeClient {
  private readonly children = new Map<ChildProcessWithoutNullStreams, () => void>();
  private stopped = false;
  private cached?: { models: ProviderModel[]; expires: number };
  private pending?: Promise<ProviderModel[]>;

  constructor(private readonly options: OpenCodeClientOptions = {}) {}

  private async readModels(): Promise<ProviderModel[]> {
    if (this.stopped) throw new Error("Roqer is closing.");
    const now = this.options.now ?? Date.now;
    if (this.cached && this.cached.expires > now()) return this.cached.models;
    if (this.pending) return this.pending;
    this.pending = this.discoverModels().then((models) => {
      if (!this.stopped) this.cached = { models, expires: now() + MODEL_CACHE_MS };
      return models;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async discoverModels(): Promise<ProviderModel[]> {
    const executable = await (this.options.resolveExecutable ?? resolveOpenCodeExecutable)();
    const home = await createOpenCodeHome({});
    try {
      if (this.stopped) throw new Error("Roqer is closing.");
      const environment = opencodeChildEnvironment(home, process.env);
      const args = ["models", "opencode", "--verbose", "--pure"];
      const child = this.options.spawnProcess
        ? this.options.spawnProcess(executable, args, environment, home.directory)
        : spawn(executable, args, { env: environment, cwd: home.directory, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      try {
        const output = await new Promise<string>((resolve, reject) => {
          let stdout = "";
          let length = 0;
          let failure: Error | undefined;
          const stop = (error: Error) => {
            if (failure) return;
            failure = error;
            clearTimeout(timer);
            child.kill("SIGKILL");
          };
          const timer = setTimeout(() => stop(new Error("OpenCode model discovery timed out.")), this.options.timeoutMs ?? 30_000);
          this.children.set(child, () => stop(new Error("Roqer is closing.")));
          const collect = (chunk: Buffer | string, isStdout: boolean) => {
            if (failure) return;
            length += Buffer.byteLength(chunk);
            if (length > MAX_OUTPUT_LENGTH) return stop(new Error("OpenCode model discovery exceeded its output limit."));
            if (isStdout) stdout += chunk.toString();
          };
          child.stdout.on("data", (chunk: Buffer | string) => collect(chunk, true));
          child.stderr.on("data", (chunk: Buffer | string) => collect(chunk, false));
          child.once("error", stop);
          child.stdin.on("error", stop);
          child.stdout.on("error", stop);
          child.stderr.on("error", stop);
          child.once("close", (code: number | null) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0) reject(new Error(`OpenCode model discovery failed (exit ${String(code)}).`));
            else resolve(stdout);
          });
          child.stdin.end();
        });
        return parseOpenCodeModels(output);
      } finally {
        this.children.delete(child);
      }
    } finally {
      await home.close();
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    try {
      await this.readModels();
      return { kind: "signed-in", message: "OpenCode CLI ready. Free models use Roqer's tools; native tool requests are refused." };
    } catch (error) {
      return {
        kind: error instanceof ClientNotInstalledError ? "not-installed" : "unavailable",
        message: error instanceof Error ? error.message : "OpenCode is unavailable.",
      };
    }
  }

  async models(): Promise<ProviderModelCatalog> {
    try {
      const models = await this.readModels();
      return { models, defaultModelId: models[0]?.id ?? null };
    } catch (error) {
      return { models: [], defaultModelId: null, message: error instanceof Error ? error.message : "OpenCode models are unavailable." };
    }
  }

  async login(): Promise<ProviderLoginResult> {
    return { ok: false, message: "Roqer uses OpenCode's free models without login. Connected paid accounts are not supported." };
  }

  cancelLogin(): void {}

  close(): void {
    this.stopped = true;
    this.cached = undefined;
    for (const stop of this.children.values()) stop();
  }
}
