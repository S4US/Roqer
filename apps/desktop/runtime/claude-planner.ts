import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { Planner, PlannerContext } from "./run-engine";
import type { AgentDefinition } from "./agent-definition";
import type { ProviderStatus, ReasoningEffort } from "../shared/provider";
import type { ClaudeLauncher } from "./claude-cli";
import type { SkillLibrary } from "./skill-library";
import { createIconToolRunner, iconToolDefinition, ICON_TOOL_NAME } from "./icon-tool";
import { blenderToolDefinition, parseBlenderToolInput } from "./blender-tool";
import { BLENDER_TOOL_NAME } from "../shared/blender";
import { createSkillToolRunner, skillToolDefinition, SKILL_TOOL_NAME, type SkillToolRunner } from "./skill-tool";
import {
  createStudioToolRunner, parseStudioToolInput, studioToolDescription, studioToolInputSchema,
  STUDIO_TOOL_NAME,
} from "./studio-tools";
import { runTaskTool, taskToolDefinition, TASK_TOOL_NAME } from "./task-tool";
import { runQuestionTool, questionToolDefinition, QUESTION_TOOL_NAME } from "./question-tool";
import { buildConversationPrompt, buildFollowUpPrompt, continuesConversation } from "./conversation-prompt";
import type { ProviderSessionStore } from "./provider-sessions";
import { runDeveloperInstructions } from "./run-instructions";
import { createProseStream } from "./text-stream";
import { DEFAULT_STALL_MS, describeStall, watchProgress } from "./progress-watchdog";
import {
  startWorkbenchMcpServer, type WorkbenchMcpServerHandle, type WorkbenchMcpToolResult,
} from "./workbench-mcp-server";

type JsonRecord = Record<string, unknown>;

function steerText(text: string): string {
  return `[Roqer relays a note the user typed while you were working. It is from the user, not from a tool:]\n${text}`;
}

/**
 * Notes reach Claude only at a turn boundary, so the explanation behind a
 * "none of these" answer cannot ride along with the tool result. Say so, and
 * ask for the turn to end, rather than pointing at a note that is still queued.
 */
const ESCAPE_RESULT =
  "The user chose none of the offered options. Their explanation is queued as a user note. End this turn now without further actions; Roqer will send that note as the next user message.";

/** The MCP server name Claude Code namespaces the tool under. */
const MCP_SERVER_NAME = "workbench";
const QUALIFIED_STUDIO_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${STUDIO_TOOL_NAME}`;
const QUALIFIED_SKILL_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${SKILL_TOOL_NAME}`;
const QUALIFIED_ICON_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${ICON_TOOL_NAME}`;
const QUALIFIED_TASK_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${TASK_TOOL_NAME}`;
const QUALIFIED_QUESTION_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${QUESTION_TOOL_NAME}`;

const QUALIFIED_BLENDER_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${BLENDER_TOOL_NAME}`;

/** Every tool Roqer grants a Claude run, in the order they are announced. */
const QUALIFIED_TOOL_NAMES = [
  QUALIFIED_STUDIO_TOOL_NAME,
  QUALIFIED_SKILL_TOOL_NAME,
  QUALIFIED_ICON_TOOL_NAME,
  QUALIFIED_TASK_TOOL_NAME,
  QUALIFIED_QUESTION_TOOL_NAME,
];

/** The granted tools for these options: Blender only while the user has it on. */
function qualifiedToolNames(options: ClaudePlannerOptions): string[] {
  return options.blender === true ? [...QUALIFIED_TOOL_NAMES, QUALIFIED_BLENDER_TOOL_NAME] : QUALIFIED_TOOL_NAMES;
}

export type ClaudePlannerOptions = {
  launcher: ClaudeLauncher;
  getStatus(): Promise<ProviderStatus>;
  cwd: string;
  model: string;
  effort: ReasoningEffort;
  /** Whether Claude Code listed `model` as taking `--effort`; passing it otherwise is an error. */
  supportsEffort: boolean;
  agent: AgentDefinition;
  skillLibrary: SkillLibrary;
  /** How long Claude may say nothing, outside a tool call, before the run is ended. Injectable for tests. */
  stallMs?: number;
  /** The chat this run belongs to, which names its kept session. */
  chatId?: string;
  /** Where a chat's Claude Code process waits for its next message. Without it, every run starts a new one. */
  sessions?: ClaudeSessionStore;
  /** Offer the `blender` tool: only while the user has turned the local Blender worker on. */
  blender?: boolean;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Write the MCP endpoint and its bearer token to a private file.
 *
 * `--mcp-config` also takes the JSON inline, but a command line is readable by
 * any process on the machine, and the token is what authorises Studio access.
 */
async function writeMcpConfig(directory: string, server: WorkbenchMcpServerHandle): Promise<string> {
  const configuration = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
      },
    },
  };
  const file = path.join(directory, "mcp.json");
  await fs.writeFile(file, JSON.stringify(configuration), { encoding: "utf8", mode: 0o600 });
  return file;
}

function systemPrompt(options: ClaudePlannerOptions, autoPlaytest: boolean): string {
  return [
    options.agent.systemInstructions,
    "<developer-instructions>",
    runDeveloperInstructions(options.agent.developerInstructions, autoPlaytest),
    "</developer-instructions>",
  ].join("\n\n");
}

/**
 * Write the system prompt beside the MCP config rather than onto the command
 * line.
 *
 * On Windows a command line is capped at 32,767 characters, which a prompt
 * allowed 64 KB per instruction file would eventually overrun, failing the
 * launch outright.
 */
async function writeSystemPrompt(directory: string, text: string): Promise<string> {
  const file = path.join(directory, "system-prompt.md");
  await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return file;
}

function buildArguments(options: ClaudePlannerOptions, configPath: string, systemPromptPath: string): string[] {
  const args = [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--model", options.model,
    "--system-prompt-file", systemPromptPath,
    // Roqer owns every Studio action, so Claude Code keeps none of its own
    // tools: no shell, filesystem, web, subagents, or ambient native skills.
    "--tools", "",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", configPath,
    "--allowedTools", qualifiedToolNames(options).join(","),
  ];
  if (options.supportsEffort) args.push("--effort", options.effort);
  return args;
}

/**
 * What a `stream_event` from the main agent's own reply means for the prose.
 *
 * `start` is every point where Claude Code opens a new message or a new text
 * block. Deltas either side of one of those are separate documents, so the
 * assembler has to be told about the seam rather than concatenating across it.
 */
function streamedProse(message: JsonRecord): { start: boolean; text: string } | null {
  if (message.parent_tool_use_id != null) return null;
  const event = message.event;
  if (!isRecord(event)) return null;

  if (event.type === "message_start") return { start: true, text: "" };
  if (event.type === "content_block_start") {
    const block = event.content_block;
    return isRecord(block) && block.type === "text" ? { start: true, text: "" } : null;
  }
  if (event.type !== "content_block_delta") return null;

  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return { start: false, text: delta.text };
}

function assistantText(message: JsonRecord): string {
  if (message.parent_tool_use_id != null) return "";
  const payload = message.message;
  if (!isRecord(payload) || !Array.isArray(payload.content)) return "";
  return payload.content
    .filter((block): block is JsonRecord => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** What one run needs to hear from the session it is using. */
type RunBinding = {
  invoke(name: string, args: JsonRecord): Promise<WorkbenchMcpToolResult>;
  message(message: JsonRecord): void;
  /** The process ended or its pipes broke; the session is gone. */
  closed(error: Error): void;
};

/**
 * One Claude Code process, its loopback MCP server, and the private directory
 * holding that server's credentials.
 *
 * It outlives a run when a chat store holds it: the next message in the same
 * chat is written to the same process, so Claude still has every tool result
 * it read. Whatever run is current is bound to it; output and tool calls
 * arriving with no run bound are refused or ignored.
 *
 * The skill cache lives here rather than in a run for the same reason: what an
 * earlier message loaded is still in this process's context, so the next
 * message gets a pointer instead of the document again. When Claude Code
 * compacts that context, the cache is cleared with it.
 */
export class ClaudeSession {
  /** The settings the process was started with; a run with different ones needs a new process. */
  readonly key: string;
  /** The prompt of the last run that finished cleanly on this session. */
  lastPrompt: string | null = null;
  /** Skill documents delivered into this process's conversation and still in it. */
  readonly skills: SkillToolRunner;

  private binding: RunBinding | null = null;
  private dead = false;
  private stderrTail = "";
  private exitReason = "unknown";
  private closing: Promise<void> | null = null;

  private constructor(
    key: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly server: WorkbenchMcpServerHandle,
    private readonly workingDirectory: string,
    skills: SkillToolRunner,
  ) {
    this.key = key;
    this.skills = skills;
  }

  get alive(): boolean {
    return !this.dead;
  }

  static async open(
    options: ClaudePlannerOptions,
    key: string,
    autoPlaytest: boolean,
    signal: AbortSignal,
  ): Promise<ClaudeSession> {
    let session: ClaudeSession | null = null;
    const server = await startWorkbenchMcpServer({
      tools: [{
        name: STUDIO_TOOL_NAME, description: studioToolDescription(), inputSchema: studioToolInputSchema(),
      }, skillToolDefinition(options.skillLibrary), iconToolDefinition(), taskToolDefinition(), questionToolDefinition(),
      ...(options.blender === true ? [blenderToolDefinition()] : [])],
      invoke: async (name, args) => session?.binding
        ? session.binding.invoke(name, args)
        : { ok: false, text: "No Roqer run is active. End this turn." },
    });
    let workingDirectory: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-claude-"));
      if (signal.aborted) throw new Error("Run was cancelled.");
      const configPath = await writeMcpConfig(workingDirectory, server);
      const systemPromptPath = await writeSystemPrompt(workingDirectory, systemPrompt(options, autoPlaytest));
      if (signal.aborted) throw new Error("Run was cancelled.");
      child = await options.launcher.launch(buildArguments(options, configPath, systemPromptPath));
      session = new ClaudeSession(key, child, server, workingDirectory, createSkillToolRunner(options.skillLibrary));
      session.attach();
      if (signal.aborted) throw new Error("Run was cancelled.");
      return session;
    } catch (error) {
      if (session) await session.close();
      else {
        child?.kill();
        await server.close().catch(() => undefined);
        if (workingDirectory) await fs.rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  bind(binding: RunBinding | null): void {
    this.binding = binding;
  }

  writeUserMessage(content: unknown[]): void {
    this.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  }

  /** Stop the process and remove its credentials. Safe to call more than once. */
  close(): Promise<void> {
    this.dead = true;
    this.binding = null;
    this.closing ??= (async () => {
      this.child.kill();
      await this.server.close().catch(() => undefined);
      await fs.rm(this.workingDirectory, { recursive: true, force: true }).catch(() => undefined);
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
    // readline re-emits an input error on the interface, and an interface
    // with no listener throws it out of the emit. Take it here so a broken
    // pipe ends the session instead of escaping as an uncaught exception.
    lines.on("error", broken);
    child.stdout.on("error", broken);
    // Settle on end-of-output rather than on "exit": the process can exit
    // while its final lines, the `result` among them, are still buffered.
    lines.once("close", () => {
      const detail = this.stderrTail.trim();
      this.end(new Error(`Claude Code exited (${this.exitReason}).${detail ? ` ${detail}` : ""}`));
    });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      // Compaction replaces what the model was given with a summary of it, so
      // a pointer to a skill loaded before this line would point at nothing.
      if (message.type === "system" && message.subtype === "compact_boundary") this.skills.clearCache();
      this.binding?.message(message);
    });
  }

  private end(error: Error): void {
    this.dead = true;
    const binding = this.binding;
    this.binding = null;
    binding?.closed(error);
  }
}

/** Every setting baked into a Claude Code process when it starts. */
function sessionKey(options: ClaudePlannerOptions, autoPlaytest: boolean): string {
  return JSON.stringify([
    options.model, options.supportsEffort ? options.effort : null, autoPlaytest,
    options.agent.id, options.agent.version, options.blender === true,
  ]);
}

export type ClaudeSessionStore = ProviderSessionStore<ClaudeSession>;

/**
 * A model-driven planner backed by the user's Claude subscription.
 *
 * Claude Code owns the credential and the agent loop; Roqer supplies the
 * bounded tools it may call over a loopback MCP server. Studio
 * calls route back into the run engine's policy and approval checks; skill
 * reads stay inside the client agent bundle.
 *
 * Given a `sessions` store and a `chatId`, the process is kept for the chat's
 * next message instead of being stopped when the run ends.
 */
export function createClaudePlanner(options: ClaudePlannerOptions): Planner {
  return {
    id: "claude-code",
    async run(context: PlannerContext): Promise<string> {
      if (context.signal.aborted) throw new Error("Run was cancelled.");
      context.progress("Connecting to Claude", "Using your managed Claude Code sign-in");
      const account = await options.getStatus();
      if (account.kind !== "signed-in") throw new Error(account.message);
      if (context.signal.aborted) throw new Error("Run was cancelled.");

      const runStudioTool = createStudioToolRunner(context);
      const runIconTool = createIconToolRunner(options.skillLibrary);
      const completion = deferred<string>();
      // Startup can still be awaiting filesystem/process work when cancellation
      // rejects this promise. Observe it now; the run still awaits it below.
      void completion.promise.catch(() => undefined);
      const prose = createProseStream((text) => context.say(text));
      let session: ClaudeSession | undefined;
      let settled = false;
      let succeeded = false;
      let streaming = false;
      let turnProseStart = 0;

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
      // Claude Code has no turn bound of Roqer's, so a model that goes quiet
      // would otherwise hold the run open, on the user's own allowance, until
      // someone pressed stop.
      const onStall = () => {
        if (!watchdog.stalled) return;
        const stall = describeStall(Math.round(stallMs / 1000), context.changes());
        context.status("Model stopped making progress", stall);
        fail(new Error(stall));
      };
      watchdog.signal.addEventListener("abort", onStall, { once: true });
      const onAbort = () => fail(new Error("Run was cancelled."));
      context.signal.addEventListener("abort", onAbort, { once: true });

      const invokeTool = async (name: string, args: JsonRecord): Promise<WorkbenchMcpToolResult> => {
        if (settled) return { ok: false, text: "This Roqer run has ended. End this turn." };
        if (name === SKILL_TOOL_NAME || name === ICON_TOOL_NAME) {
          // Tools are only reachable through a session this run has bound.
          const run = name === SKILL_TOOL_NAME ? session!.skills : runIconTool;
          try {
            return { ok: true, text: await run(args) };
          } catch (error) {
            return { ok: false, text: error instanceof Error ? error.message : String(error) };
          }
        }
        if (name === TASK_TOOL_NAME) {
          // A malformed list is the model's mistake to correct, not a reason
          // to end the turn, so it comes back as an ordinary tool error.
          try {
            return { ok: true, text: runTaskTool(context, args) };
          } catch (error) {
            return { ok: false, text: error instanceof Error ? error.message : String(error) };
          }
        }
        if (name === QUESTION_TOOL_NAME) {
          try {
            return { ok: true, text: await runQuestionTool(context, args, ESCAPE_RESULT) };
          } catch (error) {
            // A cancelled run must still end the turn; a rejected question
            // shape must not.
            if (context.signal.aborted) fail(error);
            return { ok: false, text: error instanceof Error ? error.message : String(error) };
          }
        }
        try {
          const call = options.blender === true && name === BLENDER_TOOL_NAME
            ? parseBlenderToolInput(args)
            : parseStudioToolInput(args);
          return await runStudioTool(call.operation, call.args);
        } catch (error) {
          // Policy/user rejections are ordinary results from runStudioTool.
          // Only malformed calls, cancellation, or an unexpected host error
          // reaches this boundary and ends the provider turn.
          fail(error);
          return { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
      };

      const onMessage = (message: JsonRecord) => {
        if (settled || context.signal.aborted) return;
        // Any output is progress: with partial messages on, thinking streams
        // as events too, so a long silent-looking turn is still talking.
        watchdog.progressed();

        if (message.type === "system" && message.subtype === "init") {
          // Claude Code announces its tools at the start of every turn, so a
          // kept session is checked again on each message it carries.
          const tools = Array.isArray(message.tools) ? message.tools : [];
          if (!qualifiedToolNames(options).every((name) => tools.includes(name))) {
            fail(new Error("Claude Code did not load the Roqer tools."));
            return;
          }
          context.progress("Thinking with Claude");
          return;
        }

        if (message.type === "stream_event") {
          const chunk = streamedProse(message);
          if (chunk === null) return;
          streaming = true;
          if (chunk.start) prose.beginSegment();
          else prose.push(chunk.text);
          return;
        }

        if (message.type === "assistant") {
          // Only the fallback when partial messages are unavailable; the
          // streamed deltas already carry the same text.
          if (streaming) return;
          prose.beginSegment();
          prose.push(assistantText(message));
          return;
        }

        if (message.type === "result") {
          const summary = typeof message.result === "string" ? message.result : "";
          if (message.is_error === true || message.subtype !== "success") {
            fail(new Error(summary || `Claude Code ended the turn (${String(message.subtype)}).`));
            return;
          }
          if (prose.text().length === turnProseStart && summary.trim()) prose.push(summary.trim());
          // A result ends one user turn, not the stream-json session. Keep
          // notes in the host queue until this boundary so Claude cannot
          // merge them unpredictably into a turn that is already running.
          const steers = context.takeSteers();
          if (steers.length > 0) {
            streaming = false;
            prose.beginSegment();
            turnProseStart = prose.text().length;
            context.status("Sent your note to Claude", steers.length === 1 ? steers[0] : `${steers.length} notes sent.`);
            session?.writeUserMessage(steers.map((text) => ({ type: "text", text: steerText(text) })));
            return;
          }
          finish(prose.text().trim() || summary.trim() || "Claude finished the turn.");
        }
      };

      const chatId = options.sessions !== undefined ? options.chatId : undefined;
      const key = sessionKey(options, context.autoPlaytest);
      try {
        // A kept session is used only when it has seen exactly this chat so
        // far, under the settings this run asks for; anything else would put
        // the model in a conversation the user is not looking at.
        const kept = chatId === undefined ? undefined : options.sessions!.take(chatId);
        if (kept !== undefined) {
          const current = kept.alive && kept.key === key && kept.lastPrompt !== null &&
            continuesConversation(context.conversation, kept.lastPrompt);
          if (current) session = kept;
          else await kept.close();
        }
        const resumed = session !== undefined;
        session ??= await ClaudeSession.open(options, key, context.autoPlaytest, context.signal);
        if (settled) return await completion.promise;
        if (context.signal.aborted) throw new Error("Run was cancelled.");
        if (resumed) context.progress("Continuing with Claude", "Claude still has this chat's earlier work in context");

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
        session.writeUserMessage([
          {
            type: "text",
            text: resumed
              ? buildFollowUpPrompt(context.conversation, context.prompt, (name) => skills.isLoaded(name))
              : buildConversationPrompt(context.conversation, context.prompt),
          },
          ...context.images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          })),
        ]);

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
