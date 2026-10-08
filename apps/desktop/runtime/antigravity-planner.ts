import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import type { Planner, PlannerContext } from "./run-engine";
import type { RunUsage } from "../shared/run-events";
import type { AgentDefinition } from "./agent-definition";
import type { ProviderStatus } from "../shared/provider";
import type { AntigravityLauncher } from "./antigravity-cli";
import {
  ANTIGRAVITY_MCP_SERVER_NAME, createAntigravityHome, schemaDirectory, type AntigravityHome,
} from "./antigravity-home";
import type { SkillLibrary } from "./skill-library";
import { createSkillToolRunner, type SkillToolRunner } from "./skill-tool";
import { createWorkbenchToolInvoker, workbenchMcpTools } from "./workbench-tools";
import { buildConversationPrompt, buildFollowUpPrompt, continuesConversation } from "./conversation-prompt";
import type { ProviderSessionStore } from "./provider-sessions";
import { runDeveloperInstructions } from "./run-instructions";
import { createProseStream } from "./text-stream";
import { estimateTurnOutputTokens } from "./model-api/turn-contract";
import { DEFAULT_STALL_MS, describeStall, watchProgress } from "./progress-watchdog";
import {
  startWorkbenchMcpServer, type WorkbenchMcpServerHandle, type WorkbenchMcpToolResult,
} from "./workbench-mcp-server";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function steerText(text: string): string {
  return `[Roqer relays a note the user typed while you were working. It is from the user, not from a tool:]\n${text}`;
}

/**
 * Notes reach Antigravity only at a turn boundary, as with Claude Code, so the
 * explanation behind a "none of these" answer cannot ride along with the
 * tool result.
 */
const ESCAPE_RESULT =
  "The user chose none of the offered options. Their explanation is queued as a user note. End this turn now without further actions; Roqer will send that note as the next user message.";

/**
 * The permission preset Roqer's settings put `agy` in. `init` reports it, so a
 * process that is somehow running under another preset, one that would let
 * tools through without review, is caught before it does anything.
 */
const EXPECTED_PERMISSION_MODE = "request-review";

export type AntigravityPlannerOptions = {
  launcher: AntigravityLauncher;
  getStatus(): Promise<ProviderStatus>;
  model: string;
  /** What the model picker calls `model`, for the waiting line. Defaults to the provider's name. */
  modelName?: string;
  agent: AgentDefinition;
  skillLibrary: SkillLibrary;
  /** How long Antigravity may say nothing, outside a tool call, before the run is ended. Injectable for tests. */
  stallMs?: number;
  /** The chat this run belongs to, which names its kept session. */
  chatId?: string;
  /** Where a chat's `agy` process waits for its next message. Without it, every run starts a new one. */
  sessions?: AntigravitySessionStore;
  /** Offer the `blender` tool: only while the user has turned the local Blender worker on. */
  blender?: boolean;
  /** Offer `reference_clip`: only in a chat holding a clip the user attached. */
  referenceClips?: boolean;
  /** Where private homes are made. Injectable for tests; defaults to the system temp directory. */
  homeParent?: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * What a session's instructions look like to the model. `agy` takes no system
 * prompt, so Roqer's instructions open the first message of a session; a kept
 * session already has them in its conversation.
 */
function sessionInstructions(options: AntigravityPlannerOptions, autoPlaytest: boolean): string {
  return [
    "<system-instructions>",
    options.agent.systemInstructions,
    "</system-instructions>",
    "<developer-instructions>",
    runDeveloperInstructions(options.agent.developerInstructions, autoPlaytest),
    `In this session your tools are the "${ANTIGRAVITY_MCP_SERVER_NAME}" MCP server's tools, called through call_mcp_tool. Antigravity's own built-in tools (shell commands, file edits, web search, browser, subagents) are turned off and every call to one is refused. Work in Roblox Studio only through the "${ANTIGRAVITY_MCP_SERVER_NAME}" tools.`,
    "</developer-instructions>",
  ].join("\n\n");
}

function buildArguments(options: AntigravityPlannerOptions): string[] {
  return [
    // Print mode is implied by stream-json input; the prompt comes on stdin.
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    // A message that starts with a slash is the user's text, never a command.
    "--disable-slash-commands",
    "--model", options.model,
  ];
}

/** What one `step_update` says, with only the fields Roqer reads. */
export type AntigravityStep = {
  index: number;
  state: string;
  type: string;
  textDelta?: string;
  toolName?: string;
  toolParameters?: JsonRecord;
  toolError?: string;
  usage?: { input?: number; output?: number; thinking?: number };
};

export function readAntigravityStep(message: JsonRecord): AntigravityStep | null {
  if (message.event !== "step_update" || !isRecord(message.step_update)) return null;
  const step = message.step_update;
  const index = tokenCount(step.step_index);
  if (index === undefined || typeof step.state !== "string" || typeof step.step_type !== "string") return null;
  const info = isRecord(step.tool_info) ? step.tool_info : undefined;
  const usage = isRecord(step.usage) ? step.usage : undefined;
  const error = info !== undefined && isRecord(info.error) ? info.error : undefined;
  return {
    index,
    state: step.state,
    type: step.step_type,
    ...(typeof step.text_delta === "string" ? { textDelta: step.text_delta } : {}),
    ...(typeof step.tool_name === "string" ? { toolName: step.tool_name } : {}),
    ...(info !== undefined && isRecord(info.parameters) ? { toolParameters: info.parameters } : {}),
    ...(error !== undefined && typeof error.message === "string" ? { toolError: error.message } : {}),
    ...(usage === undefined ? {} : {
      usage: { input: tokenCount(usage.input_tokens), output: tokenCount(usage.output_tokens), thinking: tokenCount(usage.thinking_tokens) },
    }),
  };
}

/**
 * Whether a tool step that ran is one the gate lets through: a call to Roqer's
 * MCP server, or `agy` reading the schema it cached for one of Roqer's tools.
 * The gate already refuses everything else before it runs; this is the check
 * that it did, so a gate that was never loaded stops the run at the first
 * tool that got past it rather than letting it carry on.
 */
export function antigravityToolPermitted(step: AntigravityStep, home: string): boolean {
  const parameters = step.toolParameters ?? {};
  if (step.toolName === "call_mcp_tool") return parameters.ServerName === ANTIGRAVITY_MCP_SERVER_NAME;
  if (step.toolName === "view_file" && typeof parameters.AbsolutePath === "string") {
    const target = path.resolve(parameters.AbsolutePath);
    const root = path.resolve(schemaDirectory(home)) + path.sep;
    return process.platform === "win32"
      ? target.toLowerCase().startsWith(root.toLowerCase())
      : target.startsWith(root);
  }
  return false;
}

/** A tool error that says the gate itself failed to run, rather than refused the call. */
export function isGateFailure(step: AntigravityStep): boolean {
  return step.state === "ERROR" && step.toolError !== undefined &&
    /^JSON hook "[^"]*roqer-gate[^"]*" failed/.test(step.toolError);
}

/**
 * `agy`'s running totals for its whole process. In a streaming session the
 * `result` of each turn reports them across every turn so far.
 */
export type AntigravityUsageTotals = {
  inputTokens: number;
  cacheReadTokens: number;
  /** What the model wrote, its thinking included. */
  outputTokens: number;
};

/** What a turn's `result` says about the process's usage, or null when it says nothing usable. */
export function antigravityResultUsage(result: JsonRecord): AntigravityUsageTotals | null {
  if (!isRecord(result.usage)) return null;
  const usage = result.usage;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input === undefined || output === undefined) return null;
  const cacheRead = tokenCount(usage.cache_read_tokens) ?? 0;
  return {
    // Gemini's API counts cached input inside its input figure, and `agy`'s
    // figures are read the same way; Roqer's input figure leaves cache reads out.
    inputTokens: Math.max(0, input - cacheRead),
    cacheReadTokens: cacheRead,
    outputTokens: output + (tokenCount(usage.thinking_tokens) ?? 0),
  };
}

/** One run's share of a kept process's running totals. */
export class AntigravityRunUsage {
  private readonly baseline: AntigravityUsageTotals;

  constructor(private readonly totals: AntigravityUsageTotals) {
    this.baseline = { ...totals };
  }

  observe(result: JsonRecord): RunUsage | null {
    const reading = antigravityResultUsage(result);
    if (reading === null) return null;
    for (const name of Object.keys(reading) as Array<keyof AntigravityUsageTotals>) {
      // A figure that went down is not a refund; keep the larger.
      this.totals[name] = Math.max(this.totals[name], reading[name]);
    }
    const grown = (name: keyof AntigravityUsageTotals) => this.totals[name] - this.baseline[name];
    return {
      inputTokens: grown("inputTokens"),
      cacheReadTokens: grown("cacheReadTokens"),
      outputTokens: grown("outputTokens"),
    };
  }
}

/** What one run needs to hear from the session it is using. */
type RunBinding = {
  invoke(name: string, args: JsonRecord): Promise<WorkbenchMcpToolResult>;
  message(message: JsonRecord): void;
  /** The process ended or its pipes broke; the session is gone. */
  closed(error: Error): void;
};

/**
 * One `agy` process, its loopback MCP server, and the private home holding
 * that server's credential. Kept for a chat's next message the way a Claude
 * Code session is.
 */
export class AntigravitySession {
  readonly key: string;
  lastPrompt: string | null = null;
  readonly usageTotals: AntigravityUsageTotals = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  /** Skill documents delivered into this process's conversation and still in it. */
  readonly skills: SkillToolRunner;
  /** Whether `init` has been seen and checked. */
  initialized = false;

  private binding: RunBinding | null = null;
  private dead = false;
  private stderrTail = "";
  private exitReason = "unknown";
  private closing: Promise<void> | null = null;

  private constructor(
    key: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly server: WorkbenchMcpServerHandle,
    readonly home: AntigravityHome,
    skills: SkillToolRunner,
  ) {
    this.key = key;
    this.skills = skills;
  }

  get alive(): boolean {
    return !this.dead;
  }

  static async open(options: AntigravityPlannerOptions, key: string, signal: AbortSignal): Promise<AntigravitySession> {
    let session: AntigravitySession | null = null;
    const server = await startWorkbenchMcpServer({
      tools: workbenchMcpTools(options),
      invoke: async (name, args) => session?.binding
        ? session.binding.invoke(name, args)
        : { ok: false, text: "No Roqer run is active. End this turn." },
    });
    let home: AntigravityHome | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      home = await createAntigravityHome({
        mcp: { url: server.url, token: server.token },
        ...(options.homeParent === undefined ? {} : { parent: options.homeParent }),
      });
      if (signal.aborted) throw new Error("Run was cancelled.");
      child = await options.launcher.launch(buildArguments(options), home);
      session = new AntigravitySession(key, child, server, home, createSkillToolRunner(options.skillLibrary));
      session.attach();
      if (signal.aborted) throw new Error("Run was cancelled.");
      return session;
    } catch (error) {
      if (session) await session.close();
      else {
        child?.kill();
        await server.close().catch(() => undefined);
        await home?.remove();
      }
      throw error;
    }
  }

  bind(binding: RunBinding | null): void {
    this.binding = binding;
  }

  writeUserMessage(text: string): void {
    this.child.stdin.write(`${JSON.stringify({ event: "user", message: { content: [{ type: "text", text }] } })}\n`);
  }

  /** Stop the process and remove its home and credential. Safe to call more than once. */
  close(): Promise<void> {
    this.dead = true;
    this.binding = null;
    this.closing ??= (async () => {
      this.child.kill();
      await this.server.close().catch(() => undefined);
      await this.home.remove();
    })();
    return this.closing;
  }

  private attach(): void {
    const child = this.child;
    const broken = (error: unknown) => this.end(error instanceof Error ? error : new Error(String(error)));
    child.on("error", broken);
    child.stdin.on("error", broken);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });
    child.once("exit", (code, signal) => {
      this.exitReason = String(signal ?? code ?? "unknown");
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("error", broken);
    child.stdout.on("error", broken);
    // Settle on end-of-output rather than on "exit": the process can exit
    // while its final lines, the `result` among them, are still buffered.
    lines.once("close", () => {
      const detail = this.stderrTail.trim();
      this.end(new Error(`The Antigravity CLI exited (${this.exitReason}).${detail ? ` ${detail}` : ""}`));
    });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (isRecord(message)) this.binding?.message(message);
    });
  }

  private end(error: Error): void {
    this.dead = true;
    const binding = this.binding;
    this.binding = null;
    binding?.closed(error);
  }
}

/**
 * Every setting baked into an `agy` process when it starts. The Studio place
 * is part of it: a conversation that read one place's scripts and parts would
 * carry them into a run against another.
 */
function sessionKey(options: AntigravityPlannerOptions, { autoPlaytest, instanceId }: Pick<PlannerContext, "autoPlaytest" | "instanceId">): string {
  return JSON.stringify([
    instanceId, options.model, autoPlaytest,
    options.agent.id, options.agent.version, options.blender === true, options.referenceClips === true,
  ]);
}

export type AntigravitySessionStore = ProviderSessionStore<AntigravitySession>;

/**
 * A model-driven planner backed by the user's Google subscription, through the
 * Antigravity CLI.
 *
 * `agy` owns the credential and the agent loop; Roqer supplies the bounded
 * tools it may call over a loopback MCP server, in a private home whose
 * permission rules and gate keep it from every built-in tool. Studio calls
 * route back into the run engine's policy and approval checks.
 */
export function createAntigravityPlanner(options: AntigravityPlannerOptions): Planner {
  return {
    id: "antigravity-cli",
    async run(context: PlannerContext): Promise<string> {
      if (context.signal.aborted) throw new Error("Run was cancelled.");
      if (context.images.length > 0) {
        // `agy` takes text only on its input stream; dropping the picture
        // would answer a different question than the one the user asked.
        throw new Error("Antigravity cannot read attached images yet. Remove the image, or choose a ChatGPT or Claude model for this message.");
      }
      context.progress("Connecting to Antigravity", "Using your Antigravity CLI sign-in");
      const waitingLabel = `Thinking with ${options.modelName ?? "Antigravity"}`;
      const account = await options.getStatus();
      if (account.kind !== "signed-in") throw new Error(account.message);
      if (context.signal.aborted) throw new Error("Run was cancelled.");

      const completion = deferred<string>();
      void completion.promise.catch(() => undefined);
      const prose = createProseStream((text) => context.say(text));
      let session: AntigravitySession | undefined;
      let settled = false;
      let succeeded = false;
      let turnProseStart = 0;
      /** The agent-response step whose text is streaming, so a new step starts a new segment. */
      let proseStep: number | null = null;
      /** What the response in progress has streamed, for the waiting line's count. */
      let responseCharacters = 0;
      let runUsage: AntigravityRunUsage | undefined;

      const finish = (summary: string) => {
        if (settled) return;
        settled = true;
        succeeded = true;
        completion.resolve(summary);
      };
      // Every failure also stops the process at once, so a model mid-turn
      // cannot keep acting on a run that has already ended.
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        completion.reject(error);
        void session?.close();
      };

      const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
      const watchdog = watchProgress(context.signal, stallMs);
      const onStall = () => {
        if (!watchdog.stalled) return;
        const stall = describeStall(Math.round(stallMs / 1000), context.changes());
        context.status("Model stopped making progress", stall);
        fail(new Error(stall));
      };
      watchdog.signal.addEventListener("abort", onStall, { once: true });
      const onAbort = () => fail(new Error("Run was cancelled."));
      context.signal.addEventListener("abort", onAbort, { once: true });

      const invokeTool = createWorkbenchToolInvoker(context, {
        ...options,
        // Tools are only reachable through a session this run has bound.
        skills: () => session!.skills,
        escapeResult: ESCAPE_RESULT,
        settled: () => settled,
        fail,
      });

      const onStep = (step: AntigravityStep) => {
        if (step.type === "agent_response") {
          if (proseStep !== step.index) {
            proseStep = step.index;
            responseCharacters = 0;
            prose.beginSegment();
          }
          if (step.textDelta !== undefined && step.textDelta !== "") {
            prose.push(step.textDelta);
            responseCharacters += step.textDelta.length;
            context.outputTokens(estimateTurnOutputTokens(responseCharacters), false);
          }
          if (step.state === "DONE" && step.usage !== undefined) {
            const output = (step.usage.output ?? 0) + (step.usage.thinking ?? 0);
            if (step.usage.output !== undefined) context.outputTokens(output, true);
            // Everything that request read, plus what it wrote, is what the
            // conversation now holds. `agy` does not say how large its window is.
            if (step.usage.input !== undefined) context.contextUsage(step.usage.input + output, null);
          }
          return;
        }
        if (step.type !== "tool" || session === undefined) return;
        if (isGateFailure(step)) {
          fail(new Error(`Roqer's tool gate for Antigravity did not run, so Antigravity refused every tool. ${step.toolError ?? ""}`.trim()));
          return;
        }
        if (step.state === "DONE" && !antigravityToolPermitted(step, session.home.home)) {
          fail(new Error(`Antigravity ran ${step.toolName ?? "a tool"}, which Roqer does not allow, so the run was stopped.`));
        }
      };

      const onMessage = (message: JsonRecord) => {
        if (settled || context.signal.aborted) return;
        watchdog.progressed();

        if (message.event === "init") {
          const init = isRecord(message.init) ? message.init : {};
          if (init.permission_mode !== EXPECTED_PERMISSION_MODE) {
            fail(new Error(`The Antigravity CLI started under the "${String(init.permission_mode)}" permission mode instead of Roqer's rules, so the run was stopped.`));
            return;
          }
          if (session !== undefined) session.initialized = true;
          context.progress(waitingLabel);
          return;
        }

        const step = readAntigravityStep(message);
        if (step !== null) {
          onStep(step);
          return;
        }

        if (message.event !== "result" || !isRecord(message.result)) return;
        const result = message.result;
        // Before the error check: a failed turn was still spent.
        const usage = runUsage?.observe(result);
        if (usage) context.runUsage(usage);
        const response = typeof result.response === "string" ? result.response.trim() : "";
        if (result.status !== "SUCCESS") {
          const error = typeof result.error === "string" && result.error !== "" ? result.error : `Antigravity ended the turn (${String(result.status)}).`;
          fail(new Error(error));
          return;
        }
        const denied = Array.isArray(result.denied_actions)
          ? result.denied_actions.filter(isRecord).map((entry) => String(entry.display_name ?? entry.action ?? "an action"))
          : [];
        const wrote = prose.text().length > turnProseStart;
        if (denied.length > 0 && !wrote && response === "") {
          // A refusal by permission rule, rather than by the gate, ends the
          // turn without a reply. Say why instead of reporting an empty success.
          fail(new Error(`Antigravity stopped after asking for something Roqer does not allow (${denied.join(", ")}).`));
          return;
        }
        if (denied.length > 0) context.status("Antigravity was refused a built-in tool", denied.join(", "));
        if (!wrote && response !== "") prose.push(response);

        const steers = context.takeSteers();
        if (steers.length > 0) {
          proseStep = null;
          prose.beginSegment();
          turnProseStart = prose.text().length;
          context.status("Sent your note to Antigravity", steers.length === 1 ? steers[0] : `${steers.length} notes sent.`);
          session?.writeUserMessage(steers.map(steerText).join("\n\n"));
          return;
        }
        finish(prose.text().trim() || response || "Antigravity finished the turn.");
      };

      const chatId = options.sessions !== undefined ? options.chatId : undefined;
      const key = sessionKey(options, context);
      try {
        const kept = chatId === undefined ? undefined : options.sessions!.take(chatId);
        if (kept !== undefined) {
          const current = kept.alive && kept.key === key && kept.lastPrompt !== null &&
            continuesConversation(context.conversation, kept.lastPrompt);
          if (current) session = kept;
          else await kept.close();
        }
        const resumed = session !== undefined;
        session ??= await AntigravitySession.open(options, key, context.signal);
        if (settled) return await completion.promise;
        if (context.signal.aborted) throw new Error("Run was cancelled.");
        if (resumed) context.progress(waitingLabel);

        runUsage = new AntigravityRunUsage(session.usageTotals);
        session.bind({
          invoke: async (name, args) => {
            // A tool call is Roqer's time, not the model's: an approval or a
            // question can wait on the user indefinitely without anything being stuck.
            const release = watchdog.hold();
            try {
              return await invokeTool(name, args);
            } finally {
              release();
            }
          },
          message: onMessage,
          closed: fail,
        });
        const skills = session.skills;
        session.writeUserMessage(resumed
          ? buildFollowUpPrompt(context.conversation, context.prompt, (name) => skills.isLoaded(name))
          : `${sessionInstructions(options, context.autoPlaytest)}\n\n${buildConversationPrompt(context.conversation, context.prompt)}`);

        return await completion.promise;
      } finally {
        context.signal.removeEventListener("abort", onAbort);
        watchdog.signal.removeEventListener("abort", onStall);
        watchdog.stop();
        if (session !== undefined) {
          session.bind(null);
          if (succeeded && chatId !== undefined && session.alive) {
            session.lastPrompt = context.prompt;
            options.sessions!.put(chatId, session);
          } else {
            await session.close();
          }
        }
      }
    },
  };
}
