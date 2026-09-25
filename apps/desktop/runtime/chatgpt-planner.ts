import type { Planner, PlannerContext } from "./run-engine";
import type { AgentDefinition } from "./agent-definition";
import type { ProviderStatus, ReasoningEffort } from "../shared/provider";
import type { AppServerNotification, AppServerRequest, AppServerRequestHandler } from "./codex-app-server";
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
import { DEFAULT_STALL_MS, describeStall, watchProgress, type ProgressWatchdog } from "./progress-watchdog";

type JsonRecord = Record<string, unknown>;
const STEER_POLL_MS = 50;

function steerText(text: string): string {
  return `[Roqer relays a note the user typed while you were working. It is from the user, not from a tool:]\n${text}`;
}

export type ChatGptPlannerOptions = {
  appServer: ChatGptAppServer;
  cwd: string;
  model: string;
  effort: ReasoningEffort;
  agent: AgentDefinition;
  skillLibrary: SkillLibrary;
  /** How long Codex may say nothing, outside a tool call, before the run is ended. Injectable for tests. */
  stallMs?: number;
  /** The chat this run belongs to, which names its kept thread. */
  chatId?: string;
  /** Where a chat's Codex thread waits for its next message. Without it, every run starts a new one. */
  sessions?: CodexThreadStore;
  /** Offer the `blender` tool: only while the user has turned the local Blender worker on. */
  blender?: boolean;
};

export interface ChatGptAppServer {
  getChatGptStatus(refreshToken?: boolean): Promise<ProviderStatus>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  subscribe(listener: (notification: AppServerNotification) => void): () => void;
  handleRequests(handler: AppServerRequestHandler): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
}

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

function dynamicToolSpec() {
  return {
    type: "function",
    name: STUDIO_TOOL_NAME,
    description: studioToolDescription(),
    inputSchema: studioToolInputSchema(),
  };
}

function dynamicSkillSpec(library: SkillLibrary) {
  return { type: "function", ...skillToolDefinition(library) };
}

/**
 * The Roqer tools whose result is a plain string.
 *
 * They share one dispatch because they also share one failure rule: a bad
 * argument object is the model's to fix and comes back as a tool error, while
 * only a cancelled run ends the turn. Returning undefined means "not one of
 * mine", which is how the Studio tool keeps its own richer handling.
 */
function textToolRunner(
  tool: unknown,
  runSkillTool: (args: unknown) => Promise<string>,
  runIconTool: (args: unknown) => Promise<string>,
  context: PlannerContext,
): ((args: unknown) => Promise<string> | string) | undefined {
  if (tool === SKILL_TOOL_NAME) return runSkillTool;
  if (tool === ICON_TOOL_NAME) return runIconTool;
  if (tool === TASK_TOOL_NAME) return (args) => runTaskTool(context, args);
  if (tool === QUESTION_TOOL_NAME) return (args) => runQuestionTool(context, args);
  return undefined;
}

/**
 * Codex thread items that carry no action of Codex's own.
 *
 * Everything the model does to Studio or this machine has to go through
 * Roqer's dynamic tools, where the run engine classifies, approves, meters,
 * and cancels it. Codex's built-in shell, file edits, MCP servers, web search,
 * image viewing, and sub-agents all act on their own, with approvals off, so
 * the app-server is started with them disabled (see `CODEX_LOCKDOWN_ARGS`).
 * This list is the backstop for a Codex version that offers one anyway: an
 * item of any other type, including one a later Codex adds, ends the turn.
 */
const CODEX_PASSIVE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "hookPrompt",
  "dynamicToolCall",
  "functionCallOutput",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "sleep",
]);

const CODEX_ITEM_DESCRIPTIONS: Readonly<Record<string, string>> = {
  commandExecution: "shell",
  fileChange: "file editing",
  mcpToolCall: "MCP servers",
  webSearch: "web search",
  imageView: "image viewer",
  imageGeneration: "image generation",
  collabAgentToolCall: "sub-agents",
  subAgentActivity: "sub-agents",
};

/** The built-in Codex tool an item comes from, or null when the item is passive. */
export function disallowedCodexItem(notification: AppServerNotification): string | null {
  if (notification.method !== "item/started") return null;
  const item = notification.params.item;
  if (!isRecord(item) || typeof item.type !== "string") return null;
  if (CODEX_PASSIVE_ITEM_TYPES.has(item.type)) return null;
  return CODEX_ITEM_DESCRIPTIONS[item.type] ?? `"${item.type}" tool`;
}

/**
 * Whether Codex has just compacted the thread's context.
 *
 * Codex reports it two ways depending on its version: the older
 * `thread/compacted` notification and the `contextCompaction` thread item that
 * replaces it. Either means guidance delivered before it may now be a summary.
 */
function isCompaction(notification: AppServerNotification): boolean {
  if (notification.method === "thread/compacted") return true;
  if (notification.method !== "item/started" && notification.method !== "item/completed") return false;
  const item = notification.params.item;
  return isRecord(item) && item.type === "contextCompaction";
}

function parseDynamicCall(request: AppServerRequest, threadId: string, blender: boolean):
  { operation: string; args: JsonRecord } | null {
  if (request.method !== "item/tool/call" || request.params.threadId !== threadId) return null;
  if (blender && request.params.tool === BLENDER_TOOL_NAME) return parseBlenderToolInput(request.params.arguments);
  if (request.params.tool !== STUDIO_TOOL_NAME) return null;
  return parseStudioToolInput(request.params.arguments);
}

/**
 * A Codex thread kept for its chat's next message. Ephemeral threads live only
 * in the app-server process, so there is nothing to close here: forgetting the
 * id is enough, and a lost app-server takes every thread with it.
 */
export type CodexThread = {
  threadId: string;
  /** The settings the thread was started with. */
  key: string;
  /** The prompt of the last run that finished cleanly on this thread. */
  lastPrompt: string;
  /** Skill documents delivered into this thread and not compacted out of it since. */
  skills: SkillToolRunner;
  close(): void;
};

export type CodexThreadStore = ProviderSessionStore<CodexThread>;

/**
 * Everything fixed when a thread starts. Model and effort are not in it: Codex
 * takes both per turn, so changing either keeps the conversation.
 */
function threadKey(options: ChatGptPlannerOptions, autoPlaytest: boolean): string {
  return JSON.stringify([autoPlaytest, options.agent.id, options.agent.version, options.blender === true]);
}

async function startThread(options: ChatGptPlannerOptions, autoPlaytest: boolean): Promise<string> {
  const started = await options.appServer.request("thread/start", {
    model: options.model,
    modelProvider: "openai",
    cwd: options.cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    environments: [],
    ephemeral: true,
    serviceName: "studio_workbench",
    baseInstructions: options.agent.systemInstructions,
    developerInstructions: runDeveloperInstructions(options.agent.developerInstructions, autoPlaytest),
    dynamicTools: [
      dynamicToolSpec(),
      dynamicSkillSpec(options.skillLibrary),
      { type: "function", ...iconToolDefinition() },
      { type: "function", ...taskToolDefinition() },
      { type: "function", ...questionToolDefinition() },
      ...(options.blender === true ? [{ type: "function", ...blenderToolDefinition() }] : []),
    ],
  });
  const thread = isRecord(started) && isRecord(started.thread) ? started.thread : null;
  const threadId = thread && typeof thread.id === "string" ? thread.id : null;
  if (!threadId) throw new Error("Codex did not start a ChatGPT conversation.");
  return threadId;
}

/**
 * A model-driven planner backed by the user's managed ChatGPT/Codex sign-in.
 *
 * Given a `sessions` store and a `chatId`, the thread is kept for the chat's
 * next message, which then carries only the new prompt.
 */
export function createChatGptPlanner(options: ChatGptPlannerOptions): Planner {
  return {
    id: "chatgpt-codex",
    async run(context: PlannerContext): Promise<string> {
      const checkCancelled = () => {
        if (context.signal.aborted) throw new Error("Run was cancelled.");
      };
      checkCancelled();
      context.progress("Connecting to ChatGPT", "Using your managed Codex sign-in");
      const account = await options.appServer.getChatGptStatus();
      if (account.kind !== "signed-in") throw new Error(account.message);
      checkCancelled();

      // A kept thread is used only when it has seen exactly this chat so far,
      // under the instructions this run asks for; anything else would put the
      // model in a conversation the user is not looking at.
      const chatId = options.sessions !== undefined ? options.chatId : undefined;
      const key = threadKey(options, context.autoPlaytest);
      const kept = chatId === undefined ? undefined : options.sessions!.take(chatId);
      const current = kept !== undefined && kept.key === key &&
        continuesConversation(context.conversation, kept.lastPrompt)
        ? kept
        : undefined;
      const resumed = current !== undefined;
      const threadId = current !== undefined ? current.threadId : await startThread(options, context.autoPlaytest);
      checkCancelled();

      const completion = deferred<{ status: string; summary: string }>();
      // Notifications and cancellation can reject before turn/start responds.
      void completion.promise.catch(() => undefined);
      const runStudioTool = createStudioToolRunner(context);
      // A kept thread still holds what earlier messages loaded, so its cache
      // comes with it; a new thread starts from nothing.
      const runSkillTool = current !== undefined ? current.skills : createSkillToolRunner(options.skillLibrary);
      const runIconTool = createIconToolRunner(options.skillLibrary);
      const prose = createProseStream((text) => context.say(text));
      let turnId: string | null = null;
      let streamedItemId: string | null = null;
      let settled = false;
      let failed = false;
      let disconnected = false;
      let interruptSent = false;
      let forwardingSteers = false;
      let steerTimer: ReturnType<typeof setInterval> | null = null;

      const finish = (status: string, summary: string) => {
        if (settled) return;
        settled = true;
        completion.resolve({ status, summary });
      };
      const interrupt = () => {
        if (!turnId || disconnected || interruptSent) return;
        interruptSent = true;
        void options.appServer.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      };
      const fail = (error: unknown, interruptTurn = true) => {
        if (settled) return;
        settled = true;
        failed = true;
        if (interruptTurn) interrupt();
        completion.reject(error);
      };
      const stopDisconnect = options.appServer.onDisconnect((error) => {
        disconnected = true;
        fail(error, false);
      });

      const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
      const watchdog: ProgressWatchdog = watchProgress(context.signal, stallMs);
      // Codex has no turn bound of Roqer's, so a model that goes quiet would
      // otherwise hold the run open, on the user's own allowance, until someone
      // pressed stop.
      const onStall = () => {
        if (!watchdog.stalled) return;
        const stall = describeStall(Math.round(stallMs / 1000), context.changes());
        context.status("Model stopped making progress", stall);
        fail(new Error(stall));
      };
      watchdog.signal.addEventListener("abort", onStall, { once: true });

      const forwardSteers = async () => {
        if (settled || forwardingSteers || turnId === null) return;
        const steers = context.takeSteers();
        if (steers.length === 0) return;
        forwardingSteers = true;
        try {
          await options.appServer.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: steers.map((text) => ({ type: "text", text: steerText(text) })),
          });
          context.status("Read your note", steers.length === 1 ? steers[0] : `${steers.length} notes reached the model.`);
        } catch (error) {
          fail(error instanceof Error ? error : new Error("ChatGPT could not receive your note."));
        } finally {
          forwardingSteers = false;
        }
      };

      const stopNotifications = options.appServer.subscribe((notification: AppServerNotification) => {
        if (settled || notification.params.threadId !== threadId) return;
        // Every notification on this thread is progress, reasoning included.
        watchdog.progressed();
        const builtIn = disallowedCodexItem(notification);
        if (builtIn !== null) {
          const message = `ChatGPT tried to use Codex's built-in ${builtIn}, which Roqer does not allow: `
            + "every action has to go through Roqer's own tools and approvals. The run was stopped.";
          context.status("Stopped a built-in Codex tool", message);
          fail(new Error(message));
          return;
        }
        if (isCompaction(notification)) {
          runSkillTool.clearCache();
          return;
        }
        if (notification.method === "item/agentMessage/delta") {
          const delta = notification.params.delta;
          if (typeof delta !== "string" || delta === "") return;
          // Codex emits one item per agent message, and a turn that calls tools
          // produces several. Each is its own document, so the boundary between
          // two of them is a paragraph break, not a bare concatenation.
          const itemId = typeof notification.params.itemId === "string" ? notification.params.itemId : null;
          if (itemId !== streamedItemId) {
            streamedItemId = itemId;
            prose.beginSegment();
          }
          prose.push(delta);
          return;
        }
        if (notification.method === "item/completed") {
          // Only the fallback for a turn that streamed no deltas at all.
          const item = notification.params.item;
          if (streamedItemId === null && isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") {
            prose.beginSegment();
            prose.push(item.text);
          }
          return;
        }
        if (notification.method === "turn/completed") {
          const turnValue = notification.params.turn;
          const status = isRecord(turnValue) && typeof turnValue.status === "string"
            ? turnValue.status
            : "failed";
          const error = isRecord(turnValue) && isRecord(turnValue.error) && typeof turnValue.error.message === "string"
            ? turnValue.error.message
            : undefined;
          if (status === "failed") fail(new Error(error ?? "ChatGPT turn failed."), false);
          else finish(status, prose.text().trim() || `ChatGPT turn ${status}.`);
          return;
        }
        if (notification.method === "error") {
          if (notification.params.willRetry === true) return;
          const error = notification.params.error;
          if (isRecord(error) && typeof error.message === "string") fail(new Error(error.message));
        }
      });

      const handleRequest = async (request: AppServerRequest): Promise<unknown> => {
        if (settled || context.signal.aborted) return undefined;
        if (request.method === "item/tool/call" && request.params.threadId === threadId) {
          const runTextTool = textToolRunner(request.params.tool, runSkillTool, runIconTool, context);
          if (runTextTool) {
            try {
              return {
                success: true,
                contentItems: [{ type: "inputText", text: await runTextTool(request.params.arguments) }],
              };
            } catch (error) {
              if (context.signal.aborted) {
                fail(error);
              }
              return {
                success: false,
                contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
              };
            }
          }
        }
        const call = parseDynamicCall(request, threadId, options.blender === true);
        if (!call) return undefined;

        try {
          const result = await runStudioTool(call.operation, call.args);
          return {
            success: result.ok,
            contentItems: [
              { type: "inputText", text: result.text },
              ...(result.images ?? []).map((image) => ({
                type: "inputImage",
                imageUrl: `data:${image.mediaType};base64,${image.data}`,
              })),
            ],
          };
        } catch (error) {
          fail(error);
          throw error;
        }
      };

      // A tool call is Roqer's time, not the model's: an approval or a question
      // can wait on the user indefinitely without anything being stuck.
      const stopRequests = options.appServer.handleRequests(async (request) => {
        if (request.params.threadId !== threadId) return handleRequest(request);
        const release = watchdog.hold();
        try {
          return await handleRequest(request);
        } finally {
          release();
        }
      });

      const onAbort = () => {
        fail(new Error("Run was cancelled."));
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (settled) await completion.promise;
        checkCancelled();
        context.progress(
          resumed ? "Continuing with ChatGPT" : "Thinking with ChatGPT",
          resumed ? "ChatGPT still has this chat's earlier work in context" : undefined,
        );
        const turnStarted = options.appServer.request("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: resumed
                ? buildFollowUpPrompt(context.conversation, context.prompt, (name) => runSkillTool.isLoaded(name))
                : buildConversationPrompt(context.conversation, context.prompt),
            },
            ...context.images.map((image) => ({
              type: "image",
              url: `data:${image.mediaType};base64,${image.data}`,
            })),
          ],
          model: options.model,
          effort: options.effort,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          cwd: options.cwd,
        }).then((turnResult) => {
          const turn = isRecord(turnResult) && isRecord(turnResult.turn) ? turnResult.turn : null;
          turnId = turn && typeof turn.id === "string" ? turn.id : null;
          if (!turnId) throw new Error("Codex did not start the ChatGPT turn.");
          // Cancellation may win before the server acknowledges the new turn.
          if (failed) interrupt();
        });
        await Promise.race([turnStarted, completion.promise.then(() => turnStarted)]);
        steerTimer = setInterval(() => void forwardSteers(), STEER_POLL_MS);
        void forwardSteers();
        if (context.signal.aborted) {
          interrupt();
          throw new Error("Run was cancelled.");
        }

        const completed = await completion.promise;
        if (completed.status === "interrupted") throw new Error("Run was cancelled.");
        // Only a turn that finished cleanly leaves the thread describing what
        // the chat now shows; any other ending simply forgets it.
        if (chatId !== undefined && completed.status === "completed") {
          options.sessions!.put(chatId, {
            threadId, key, lastPrompt: context.prompt, skills: runSkillTool, close: () => undefined,
          });
        }
        return completed.summary;
      } finally {
        if (steerTimer !== null) clearInterval(steerTimer);
        context.signal.removeEventListener("abort", onAbort);
        watchdog.signal.removeEventListener("abort", onStall);
        watchdog.stop();
        stopRequests();
        stopNotifications();
        stopDisconnect();
      }
    },
  };
}
