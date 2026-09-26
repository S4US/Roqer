import {
  estimateTurnInputTokens,
  TransientTurnError,
  TURN_IMAGE_MEDIA_TYPES,
  MAX_TURN_IMAGE_BASE64,
  MAX_TURN_IMAGES,
  type TurnImageMediaType,
  type TurnToolCall,
  type TurnContent,
  type TurnEvent,
  type TurnMessage,
  type TurnRequest,
  type TurnStopReason,
  type TurnTool,
  type TurnUsage,
} from "./model-api/turn-contract";

import type { RunTask } from "../shared/tasks";
import type { AgentDefinition } from "./agent-definition";
import { blenderToolDefinition, parseBlenderToolInput } from "./blender-tool";
import { BLENDER_TOOL_NAME } from "../shared/blender";
import { buildConversationPrompt, buildFollowUpPrompt, continuesConversation } from "./conversation-prompt";
import { boundRetainedToolResults, compactHistory, describeRunState, type ToolOutputBudget } from "./agent-loop-history";
import { createIconToolRunner, iconToolDefinition, ICON_TOOL_NAME } from "./icon-tool";
import { runQuestionTool, questionToolDefinition, QUESTION_TOOL_NAME } from "./question-tool";
import { RunCancelledError, type Planner, type PlannerContext } from "./run-engine";
import { runDeveloperInstructions } from "./run-instructions";
import type { SkillLibrary } from "./skill-library";
import type { ProviderSessionStore } from "./provider-sessions";
import { createSkillToolRunner, skillToolDefinition, SKILL_TOOL_NAME, type SkillToolRunner } from "./skill-tool";
import {
  createStudioToolRunner, parseStudioToolInput, studioToolDescription, studioToolInputSchema,
  STUDIO_TOOL_NAME,
} from "./studio-tools";
import { runTaskTool, taskToolDefinition, TASK_TOOL_NAME } from "./task-tool";
import { createProseStream } from "./text-stream";
import { DEFAULT_STALL_MS, describeStall, watchProgress } from "./progress-watchdog";
import { isKnownTool, riskForTool, TOOL_RISK } from "../shared/mcp-tools";
import type { ReasoningEffort } from "../shared/provider";

/**
 * Roqer's own agent loop, which drives the Custom provider.
 *
 * A transport runs one turn against the model endpoint and reports what the
 * model said and asked for; this planner decides what to execute, routes it
 * through the engine's policy and approvals, and sends the results back as the
 * next turn. The transports for OpenAI-compatible and Anthropic endpoints are
 * in `model-api/`.
 */

export interface TurnTransport {
  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent>;
}

export type AgentLoopTelemetryEvent =
  | Readonly<{
    kind: "turn";
    turn: number;
    durationMs: number;
    /**
     * Where a turn's wall time went, in milliseconds from the moment the request
     * was sent. A slow run is slow in one of four places and they have nothing to
     * do with each other: waiting for the endpoint to say anything at all
     * (`firstEventMs` -- authorization, the upstream connection, and the model
     * thinking before its first token), streaming the answer, the tail after the
     * model has finished asking (`durationMs` minus `lastToolCallMs` -- the usage
     * frame, the end-of-stream marker, and the hop home), and running the tools,
     * which the `tool` events below already time. Without the split, every one of
     * them reads as "the model is slow".
     */
    firstEventMs?: number;
    firstTextMs?: number;
    firstToolCallMs?: number;
    lastToolCallMs?: number;
    requestCharacters: number;
    estimatedInputTokens: number;
    completed: boolean;
    /** The turn was ended because it made no semantic progress, not because it finished. */
    stalled?: boolean;
    /**
     * This attempt failed transiently and the same turn was sent again. The
     * turn's number is shared by every attempt at it; only the last is the turn.
     */
    retried?: boolean;
    stopReason?: TurnStopReason;
    failureCode?: Extract<TurnEvent, { kind: "failed" }>["code"];
    usage?: TurnUsage;
  }>
  | Readonly<{
    kind: "tool";
    turn: number;
    index: number;
    tool: string;
    ok: boolean;
    durationMs: number;
    resultCharacters: number;
  }>;

export type AgentLoopPlannerOptions = {
  transport: TurnTransport;
  runId: string;
  modelId: string;
  effort: ReasoningEffort;
  agent: AgentDefinition;
  skillLibrary: SkillLibrary;
  /** Numeric evaluation telemetry. It never receives prompts, arguments, or results. */
  onTelemetry?: (event: AgentLoopTelemetryEvent) => void;
  /** How long a turn may make no semantic progress before it is ended. Injectable for tests. */
  stallMs?: number;
  /**
   * The same loop drives a model on the user's own endpoint. These say how
   * that run is named and what the model can take.
   */
  /** The planner id recorded on the run. */
  plannerId?: string;
  /** Who the model is, in progress and error text. Defaults to "Roqer". */
  label?: string;
  /** False for a model that accepts no images: attachments and screenshots are withheld from it. */
  images?: boolean;
  /** How much tool output the conversation may carry. Defaults to the standard budget. */
  toolOutputBudget?: ToolOutputBudget;
  /** What to tell the user when a turn hits its output limit, where they can raise it. */
  outputLimitAdvice?: string;
  /** Offer the `blender` tool: only while the user has turned the local Blender worker on. */
  blender?: boolean;
  /** The chat this run belongs to, which names its kept conversation. */
  chatId?: string;
  /** Where a chat's conversation waits for its next message. Without it, every run starts a new one. */
  sessions?: AgentLoopSessionStore;
  /**
   * Everything the transport was made with -- the endpoint, the model, the
   * key -- as one string, so a conversation is continued only on the
   * transport it was held on. Without it, a kept conversation is never used.
   */
  transportKey?: string;
  /** How many times a turn that failed transiently is sent again. Injectable for tests. */
  turnRetries?: number;
  /** The first pause before sending a failed turn again; each later one doubles. Injectable for tests. */
  retryBaseMs?: number;
};

/**
 * A Custom chat's conversation, kept for the chat's next message.
 *
 * The subscription planners keep their Claude Code process or Codex thread
 * between the messages of a chat, and this loop now keeps its own: the whole
 * message history, tool results included, and the transport that produced it,
 * which holds each turn's reasoning as it has to be sent back. Without it every
 * follow-up replayed the chat as plain text, re-read Studio before it could
 * act, and paid for the replay again outside the endpoint's prompt cache.
 *
 * Nothing here is persisted, and closing it only lets it go.
 */
export type AgentLoopSession = Readonly<{
  /** The settings the conversation was held under; a run with other settings starts a new one. */
  key: string;
  /** The prompt of the last run that finished cleanly on this conversation. */
  lastPrompt: string;
  messages: TurnMessage[];
  transport: TurnTransport;
  /** Guidance delivered into this conversation and not folded out of it since. */
  skills: SkillToolRunner;
  /** Results that carry a user's answer, which elision must leave alone. */
  answerCallIds: Set<string>;
  close(): void;
}>;

export type AgentLoopSessionStore = ProviderSessionStore<AgentLoopSession>;

/**
 * Everything fixed when a conversation starts. The effort is not in it: it is
 * sent with every turn, so changing it keeps the conversation.
 */
function sessionKey(options: AgentLoopPlannerOptions, autoPlaytest: boolean): string {
  return JSON.stringify([
    options.transportKey ?? null, options.plannerId ?? "agent-loop", options.modelId, autoPlaytest,
    options.agent.id, options.agent.version, options.blender === true, options.images !== false,
    options.toolOutputBudget ?? null,
  ]);
}

function reportTelemetry(options: AgentLoopPlannerOptions, event: AgentLoopTelemetryEvent): void {
  try {
    options.onTelemetry?.(event);
  } catch {
    // Observability must never change whether a user-visible run succeeds.
  }
}

/**
 * The client owns the loop, so it owns when a stuck run stops. There is no
 * turn count: a long build that keeps making progress is the work the person
 * asked for, and `agent-loop-history.ts` folds older exchanges so the history
 * never outgrows the contract. What a bound must catch is a model that is
 * stuck, which shows as the same calls turn after turn, so a run on the
 * user's own key does not keep spending unattended on nothing.
 *
 * The same failing calls three turns running is stuck: nothing changed
 * between tries. The same calls six turns running is stuck even when they
 * succeed, because a result that did not change the next step was not read.
 */
export const REPEATED_FAILURE_TURNS = 3;
export const REPEATED_CALL_TURNS = 6;

/** Re-exported so existing callers and tests keep their import. */
export { DEFAULT_STALL_MS };

/**
 * How often a turn the endpoint failed transiently is sent again, and how long
 * the loop waits between tries.
 *
 * One overloaded response, one rate limit, or one dropped connection used to
 * end the whole run, forty turns into a build, because the retries lived in the
 * hosted gateway this loop once spoke to and did not come back with the direct
 * transports. Four more tries over about fifteen seconds rides out the ordinary
 * blip; an endpoint that asks for longer than a minute is not having a blip,
 * and is reported rather than waited on.
 */
export const TURN_RETRIES = 4;
const RETRY_BASE_MS = 1_000;
const MAX_RETRY_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * The pause before a turn's next try: what the endpoint asked for when it
 * said, otherwise a doubling backoff with a little jitter so that several
 * clients refused together do not all come back together.
 */
function retryDelayMs(retry: number, baseMs: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const backoff = Math.min(MAX_RETRY_BACKOFF_MS, baseMs * 2 ** retry);
  return Math.round(backoff * (1 + Math.random() * 0.25));
}

/** Wait, or stop waiting the moment the run is cancelled. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function seconds(milliseconds: number): string {
  const value = Math.max(1, Math.round(milliseconds / 1_000));
  return `${value} second${value === 1 ? "" : "s"}`;
}

/**
 * The engine's image type is provider-neutral, so its media type is a plain
 * string. Narrowing it here rather than asserting means a picture the contract
 * would refuse is dropped locally instead of failing the turn.
 */
function isTurnImageMediaType(value: string): value is TurnImageMediaType {
  return (TURN_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

function loopTools(library: SkillLibrary, blender: boolean): TurnTool[] {
  const textTools = [
    skillToolDefinition(library), iconToolDefinition(), taskToolDefinition(), questionToolDefinition(),
  ];
  const blenderTool = blender ? [blenderToolDefinition()] : [];
  return [
    {
      name: STUDIO_TOOL_NAME,
      description: studioToolDescription(),
      parameters: studioToolInputSchema(),
    },
    ...blenderTool.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })),
    ...textTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  ];
}

/** Reads whose result can carry image blocks need shared slot accounting. */
const IMAGE_RESULT_TOOLS = new Set(["capture_screenshot", "get_asset_thumbnail", "preview_asset"]);

function isParallelStudioRead(call: TurnToolCall): boolean {
  if (call.name !== STUDIO_TOOL_NAME) return false;
  try {
    const { operation, args } = parseStudioToolInput(call.arguments);
    // A read by its table entry and by this call's own arguments: a profiler
    // capture that writes a file needs the approval a parallel batch skips.
    return isKnownTool(operation) && TOOL_RISK[operation] === "read" && riskForTool(operation, args) === "read"
      && !IMAGE_RESULT_TOOLS.has(operation);
  } catch {
    return false;
  }
}

/**
 * Known failures are stated in local wording rather than echoed. The
 * transport's text reaches a chat transcript the user keeps, and an endpoint's
 * error prose can carry account or request details nobody meant to keep.
 */
function failureMessage(event: Extract<TurnEvent, { kind: "failed" }>): string {
  switch (event.code) {
    case "cancelled":
      return "Run was cancelled.";
    case "quota_exhausted":
      return "The model provider's usage limit was reached partway through the run.";
    case "upstream_timeout":
      return "The model provider stopped responding during this turn.";
    default:
      return event.message;
  }
}

/**
 * What a stop reason means once the model has stopped asking for tools.
 *
 * Only `end` is simply an answer. The others were all read as one before, so a
 * reply the model was cut off partway through, and one it declined to give,
 * both arrived at the user as the run's finished result with nothing marking
 * them apart from a complete one. The transport catches the tool-call form of
 * this -- arguments that stop mid-JSON are `truncated` -- but a turn that runs
 * out of room while writing prose produces no error at all, only a shorter
 * answer, which is exactly the failure a reader cannot see.
 */
function endedEarlyNote(stopReason: TurnStopReason | undefined, outputLimitAdvice?: string): string | undefined {
  switch (stopReason) {
    case "max-output":
      return "This answer stops partway through: the model reached its output limit for the turn. "
        + (outputLimitAdvice ?? "Ask for the rest, or for a smaller piece of the work.");
    case "refusal":
      return "The model declined to answer this turn.";
    case "tool-use":
      return "The model ended this turn expecting to use a tool, but did not send a usable one.";
    default:
      return undefined;
  }
}

/**
 * How much tool-output imagery a run carries forward, as base64 characters.
 * One screenshot's worth: enough that the newest capture always survives, small
 * enough that a run which screenshots repeatedly cannot grow its own bill
 * without limit. Raise it to let an agent compare a before and an after.
 */
const MAX_RETAINED_IMAGE_BASE64 = MAX_TURN_IMAGE_BASE64;

/**
 * Keep the newest tool-output images; drop the ones behind them.
 *
 * A screenshot has to outlive the turn it arrived on. An agent that captures one
 * typically spends its next turn stopping the playtest, and only the turn after
 * that describes what it saw — so retiring an image after a single turn meant
 * the describing turn was reliably the one with nothing left to look at, while
 * the tool result still cheerfully reported the dimensions.
 *
 * Retention is bounded by bytes rather than by turns, because what makes a run
 * expensive is how many pixels ride along, not how long ago they arrived.
 *
 * The request messages are exempt from eviction: the opening one, and in a
 * conversation continued from an earlier message of the chat, the one this run
 * is answering. What the person attached is the request itself, not a
 * transient observation: a mockup handed over with "build this" has to still
 * be there on the turn that builds. They are not exempt from the count: the
 * wire contract caps images per request with attachments included, so
 * screenshots get whatever slots the attachments leave. A run that kept four
 * screenshots beside one attached reference built a request the contract
 * refused, and died on the turn after its fourth capture.
 */
function imageCount(message: TurnMessage): number {
  return message.content.filter((block) => block.kind === "image").length;
}

/**
 * The user's mid-run notes as the model receives them.
 *
 * Labelled as relayed by the host, because they arrive in a message otherwise
 * full of tool output, and a tool result is exactly the place an instruction
 * must not be obeyed from. The label is what tells the two apart: this is the
 * person who started the run, speaking again.
 */
function steerBlocks(steers: readonly string[]): TurnContent[] {
  return steers.map((text) => ({
    kind: "text",
    text: `[Roqer relays a note the user typed while you were working. It is from the user, not from a tool:]\n${text}`,
  }));
}

/** How many broken tool calls in a row the model is asked to retry before the run fails. */
export const MALFORMED_CALL_RETRIES = 3;

const MALFORMED_CALL_NOTE = "[Roqer, the host: your last tool call could not be formed: the model's provider reported a malformed function call, so nothing ran. This usually happens when one call is too large. Make the same step again as a smaller call: split a long script into parts, write a long script in stages with the line editors, or build in several batches.]";

/** Sent with the last turn of a run that is repeating itself. */
function stuckNote(stuck: Readonly<{ turns: number; failing: boolean }>): string {
  return `[Roqer, the host: you have made the same ${stuck.failing ? "failing " : ""}calls ${stuck.turns} turns in a row, so Roqer is stopping this run. Do not call any tool; Roqer will not run one. Reply now to the user: what works and how you checked it, what does not work yet, and what is left to do.]`;
}

/** Added to the reply of a run stopped for repeating itself, so the person knows how it ended. */
function stuckReply(stuck: Readonly<{ turns: number; failing: boolean }>): string {
  return `Roqer stopped this run because the model made the same ${stuck.failing ? "failing " : ""}calls ${stuck.turns} turns in a row. Send "Continue" to try again from here, or say what to change.`;
}

/** What Roqer says, as the host, to a model that ended a turn with no reply and no tool call. */
function silenceNote(open: readonly RunTask[]): string {
  if (open.length === 0) {
    return "[Roqer, the host: you ended your turn with no reply and no tool call. Continue working on the user's request now, or reply saying what you did and what is left.]";
  }
  const titles = open.map((task) => `"${task.title}"`).join(", ");
  return `[Roqer, the host: you ended your turn with no reply and no tool call while ${open.length === 1 ? "this task is" : "these tasks are"} still open: ${titles}. Continue the work now, or mark what cannot be finished as blocked and reply saying why.]`;
}

function boundRetainedImages(messages: TurnMessage[], requests: ReadonlySet<TurnMessage>): void {
  let remaining = MAX_RETAINED_IMAGE_BASE64;
  let kept = [...requests].reduce((total, message) => total + imageCount(message), 0);
  // Newest first, so the budget is spent on the most recent view of Studio.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (requests.has(message) || !message.content.some((block) => block.kind === "image")) continue;
    // Every message carrying an image also carries the tool result it came
    // with, so filtering images can never empty one.
    const content = message.content.filter((block) => {
      if (block.kind !== "image") return true;
      if (kept >= MAX_TURN_IMAGES || block.data.length > remaining) return false;
      remaining -= block.data.length;
      kept += 1;
      return true;
    });
    if (content.length !== message.content.length) messages[index] = { ...message, content };
  }
}

/** A model-driven planner running Roqer's own loop over a turn transport. */
export function createAgentLoopPlanner(options: AgentLoopPlannerOptions): Planner {
  const label = options.label ?? "Roqer";
  const acceptsImages = options.images !== false;
  return {
    id: options.plannerId ?? "agent-loop",
    async run(context: PlannerContext): Promise<string> {
      const prose = createProseStream((text) => context.say(text));
      const runStudioTool = createStudioToolRunner(context);
      const images = (acceptsImages ? context.images : []).flatMap((image): TurnContent[] => isTurnImageMediaType(image.mediaType)
        ? [{ kind: "image", mediaType: image.mediaType, data: image.data }]
        : []);

      // A kept conversation is used only when it has seen exactly this chat so
      // far, under the settings this run asks for, and has room for what this
      // message attaches; anything else would put the model in a conversation
      // the user is not looking at.
      const chatId = options.sessions !== undefined ? options.chatId : undefined;
      const key = sessionKey(options, context.autoPlaytest);
      const kept = chatId === undefined ? undefined : options.sessions!.take(chatId);
      const session = kept !== undefined && options.transportKey !== undefined && kept.key === key &&
        continuesConversation(context.conversation, kept.lastPrompt) &&
        imageCount(kept.messages[0]) + images.length <= MAX_TURN_IMAGES
        ? kept
        : undefined;
      if (kept !== undefined && session === undefined) kept.close();
      const transport = session?.transport ?? options.transport;
      const runSkillTool = session?.skills ?? createSkillToolRunner(options.skillLibrary);
      const runIconTool = createIconToolRunner(options.skillLibrary);
      const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
      const turnRetries = options.turnRetries ?? TURN_RETRIES;
      const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
      // Asked at most once a run: a model that goes silent again after being
      // asked is done, and the completion gate reports what it left open.
      let askedAfterSilence = false;
      // Broken tool calls in a row; a turn that forms a call resets it.
      let malformedInRow = 0;
      const tools = loopTools(options.skillLibrary, options.blender === true);
      const instructions = {
        system: options.agent.systemInstructions,
        developer: runDeveloperInstructions(options.agent.developerInstructions, context.autoPlaytest),
      };
      if (!acceptsImages && context.images.length > 0) {
        context.status(
          "Images not sent to the model",
          `${label} is set up as a model that does not accept images, so the attached ${context.images.length === 1 ? "image was" : "images were"} left out.`,
        );
      }
      // Any attached pictures follow the prose, so the model reads what it is
      // being asked about before it looks. They ride only on this first message:
      // re-sending them every turn would re-bill them for the whole run. A kept
      // conversation already holds the chat so far, tool results included, so
      // it is sent only this message and Roqer's record of the last run.
      const opening: TurnMessage = {
        role: "user",
        content: [
          {
            kind: "text",
            text: session === undefined
              ? buildConversationPrompt(context.conversation, context.prompt)
              : buildFollowUpPrompt(context.conversation, context.prompt, (name) => runSkillTool.isLoaded(name)),
          },
          ...images,
        ],
      };
      const messages: TurnMessage[] = session?.messages ?? [];
      messages.push(opening);
      // The chat's first request and this one are the request, not
      // observations: neither is folded away nor loses its pictures.
      const requests: ReadonlySet<TurnMessage> = new Set([messages[0], opening]);
      // A continued conversation can hold an earlier run's screenshot beside
      // what this message attaches, so the budget applies before the first turn.
      if (session !== undefined) boundRetainedImages(messages, requests);
      // Attachments hold their slots for the whole run, so every screenshot
      // budget below starts from what they leave rather than from the cap.
      const attachedImages = [...requests].reduce((total, message) => total + imageCount(message), 0);
      const screenshotSlots = acceptsImages ? MAX_TURN_IMAGES - attachedImages : 0;
      /** Results that carry a user's answer, which elision must leave alone. */
      const answerCallIds = session?.answerCallIds ?? new Set<string>();

      /**
       * End the run with its answer, and keep the conversation for the chat's
       * next message. Only a run that ends here is kept: one that failed, was
       * cancelled, or stalled leaves a conversation the chat does not describe.
       */
      const finish = (answer: string, finalText: string): string => {
        if (finalText.length > 0) messages.push({ role: "assistant", content: [{ kind: "text", text: finalText }] });
        if (chatId !== undefined && options.transportKey !== undefined) {
          options.sessions!.put(chatId, {
            key, lastPrompt: context.prompt, messages, transport, skills: runSkillTool, answerCallIds, close: () => undefined,
          });
        }
        return answer;
      };

      /**
       * Run one tool the model asked for. A bad argument object or a refused
       * action is the model's to recover from and comes back as a failed tool
       * result; only cancellation ends the run.
       */
      const executeCall = async (
        call: TurnToolCall,
        availableImageSlots: number,
        turn: number,
        index: number,
      ): Promise<TurnContent[]> => {
        const startedAt = Date.now();
        let measuredTool = call.name;
        const finish = (blocks: TurnContent[]): TurnContent[] => {
          const results = blocks.filter((block) => block.kind === "tool-result");
          reportTelemetry(options, {
            kind: "tool",
            turn,
            index,
            tool: measuredTool,
            ok: results.length > 0 && results.every((block) => !block.failed),
            durationMs: Date.now() - startedAt,
            resultCharacters: results.reduce((total, block) => total + block.content.length, 0),
          });
          return blocks;
        };
        try {
          // A Blender job returns text and a preview image the same way a
          // screenshot does, so it shares this path and its image budget.
          if (call.name === STUDIO_TOOL_NAME || (options.blender === true && call.name === BLENDER_TOOL_NAME)) {
            const parsed = call.name === STUDIO_TOOL_NAME
              ? parseStudioToolInput(call.arguments)
              : parseBlenderToolInput(call.arguments);
            measuredTool = parsed.operation;
            const result = await runStudioTool(parsed.operation, parsed.args);
            const returnedImages = result.images ?? [];
            const sizedImages = returnedImages
              .filter((image) => image.data.length <= MAX_TURN_IMAGE_BASE64);
            const images = acceptsImages ? sizedImages.slice(0, availableImageSlots) : [];
            const oversized = acceptsImages ? returnedImages.length - sizedImages.length : 0;
            const overCount = acceptsImages ? sizedImages.length - images.length : 0;
            const omissionNotes = [
              ...(!acceptsImages && returnedImages.length > 0
                ? ["This model does not accept images, so the picture was not sent. Do not take more screenshots: read the interface with inspect_ui and the instance properties instead."]
                : []),
              ...(oversized > 0
                ? [`${oversized} image${oversized === 1 ? " was" : "s were"} too large for a model turn. Retry the screenshot once as JPEG at lower quality.`]
                : []),
              ...(overCount > 0
                ? [`${overCount} image${overCount === 1 ? " was" : "s were"} omitted because one model turn accepts at most ${MAX_TURN_IMAGES}${
                  attachedImages > 0
                    ? ` and ${attachedImages} ${attachedImages === 1 ? "is" : "are"} attached to the request`
                    : ""
                }.`]
                : []),
            ];
            const content = omissionNotes.length > 0
              ? `${result.text}\n\n${omissionNotes.join(" ")}`
              : result.text;
            // Told to the person too, not only to the model. An image dropped
            // here is the difference between an agent that can see its own work
            // and one that narrates around a blank, and without a line in the
            // timeline that difference is invisible from the outside.
            if (omissionNotes.length > 0) {
              context.status(
                `Screenshot not sent to the model`,
                `${omissionNotes.join(" ")} The tool itself succeeded.`,
              );
            }
            return finish([
              { kind: "tool-result", callId: call.id, content, failed: !result.ok },
              ...images.map((image): TurnContent => ({
                kind: "image",
                mediaType: image.mediaType,
                data: image.data,
              })),
            ]);
          }
          const text = call.name === SKILL_TOOL_NAME
            ? await runSkillTool(call.arguments)
            : call.name === ICON_TOOL_NAME
              ? await runIconTool(call.arguments)
              : call.name === TASK_TOOL_NAME
                ? runTaskTool(context, call.arguments)
                : call.name === QUESTION_TOOL_NAME
                  ? await runQuestionTool(context, call.arguments)
                  : undefined;
          // An answer is the one result the model cannot get again by asking.
          if (call.name === QUESTION_TOOL_NAME && text !== undefined) answerCallIds.add(call.id);
          if (text === undefined) {
            return finish([{
              kind: "tool-result",
              callId: call.id,
              content: `Unknown tool: ${call.name}`,
              failed: true,
            }]);
          }
          return finish([{ kind: "tool-result", callId: call.id, content: text, failed: false }]);
        } catch (error) {
          if (error instanceof RunCancelledError || context.signal.aborted) throw error;
          return finish([{
            kind: "tool-result",
            callId: call.id,
            content: error instanceof Error ? error.message : String(error),
            failed: true,
          }]);
        }
      };

      let stuck: Readonly<{ turns: number; failing: boolean }> | undefined;
      let lastSignature = "";
      let sameCalls = 0;
      let sameFailures = 0;
      for (let turn = 0; ; turn += 1) {
        if (context.signal.aborted) throw new RunCancelledError();
        if (turn === 0 && session !== undefined) {
          context.progress(`Continuing with ${label}`, `${label} still has this chat's earlier work in context`);
        } else {
          context.progress(`Thinking with ${label}`);
        }
        // A stuck run's last turn is spent on a report rather than one more
        // try: a run stopped with no answer loses everything the person would
        // need to decide whether to continue it.
        if (stuck !== undefined) {
          const note: TurnContent = { kind: "text", text: stuckNote(stuck) };
          const last = messages[messages.length - 1];
          if (last.role === "user") messages[messages.length - 1] = { ...last, content: [...last.content, note] };
          else messages.push({ role: "user", content: [note] });
          context.status("Model is repeating itself", `The same ${stuck.failing ? "failing " : ""}calls ${stuck.turns} turns running; the model is asked to report instead.`);
        }

        const request: TurnRequest = {
          runId: options.runId,
          turnId: `${options.runId}:turn:${turn + 1}`,
          modelId: options.modelId,
          reasoningEffort: options.effort,
          instructions,
          tools,
          messages,
        };
        const turnNumber = turn + 1;
        const requestCharacters = JSON.stringify(request).length;
        const estimatedInputTokens = estimateTurnInputTokens(request);

        // Each turn is its own message, so the seam between two of them is a
        // paragraph break rather than a bare concatenation.
        prose.beginSegment();
        let calls: TurnToolCall[] = [];
        let spoken = "";
        let completed = false;
        let stopReason: TurnStopReason | undefined;
        let stalled = false;

        // A transport hands over a turn's calls only once the whole turn has
        // arrived, so a turn that failed partway ran nothing and is simply
        // asked for again. Each try starts from nothing but what it streams.
        for (let retry = 0; ; retry += 1) {
          calls = [];
          spoken = "";
          completed = false;
          stopReason = undefined;
          let failureCode: Extract<TurnEvent, { kind: "failed" }>["code"] | undefined;
          let usage: TurnUsage | undefined;
          let transient: TransientTurnError | undefined;

          let firstEventMs: number | undefined;
          let firstTextMs: number | undefined;
          let firstToolCallMs: number | undefined;
          let lastToolCallMs: number | undefined;

          const turnStartedAt = Date.now();
          const watchdog = watchProgress(context.signal, stallMs);
          try {
            for await (const event of transport.streamTurn(request, watchdog.signal)) {
              // Every branch below is semantic progress, so the watchdog is reset
              // here rather than per branch: a frame that is none of these is not
              // one of them either.
              watchdog.progressed();
              const elapsed = Date.now() - turnStartedAt;
              firstEventMs ??= elapsed;
              // Reasoning says nothing to the user and nothing to the next turn;
              // arriving is all it does, and that has just been counted.
              if (event.kind === "reasoning") continue;
              if (event.kind === "delta") {
                firstTextMs ??= elapsed;
                spoken += event.text;
                prose.push(event.text);
                continue;
              }
              if (event.kind === "tool-call") {
                lastToolCallMs = elapsed;
                firstToolCallMs ??= elapsed;
                calls.push(event.call);
                continue;
              }
              if (event.kind === "failed") {
                failureCode = event.code;
                usage = event.usage;
                throw new Error(failureMessage(event));
              }
              completed = true;
              stopReason = event.stopReason;
              usage = event.usage;
            }
          } catch (error) {
            // A cancellation or a stall ends the run exactly as before: a stall
            // is not retried, because a model that went quiet once would spend
            // the same wait again.
            if (!(error instanceof TransientTurnError) || context.signal.aborted || watchdog.stalled) throw error;
            if (retry >= turnRetries) {
              throw new Error(retry === 0 ? error.message : `${error.message} Roqer tried this turn ${retry + 1} times.`, { cause: error });
            }
            if (error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_AFTER_MS) {
              throw new Error(`${error.message} It asked Roqer to wait ${seconds(error.retryAfterMs)} before trying again.`, { cause: error });
            }
            transient = error;
          } finally {
            watchdog.stop();
            stalled = watchdog.stalled;
            reportTelemetry(options, {
              kind: "turn",
              turn: turnNumber,
              durationMs: Date.now() - turnStartedAt,
              ...(firstEventMs === undefined ? {} : { firstEventMs }),
              ...(firstTextMs === undefined ? {} : { firstTextMs }),
              ...(firstToolCallMs === undefined ? {} : { firstToolCallMs }),
              ...(lastToolCallMs === undefined ? {} : { lastToolCallMs }),
              requestCharacters,
              estimatedInputTokens,
              completed,
              ...(watchdog.stalled ? { stalled: true } : {}),
              ...(transient === undefined ? {} : { retried: true }),
              ...(stopReason === undefined ? {} : { stopReason }),
              ...(failureCode === undefined ? {} : { failureCode }),
              ...(usage === undefined ? {} : { usage }),
            });
          }
          if (transient === undefined) break;

          const delay = retryDelayMs(retry, retryBaseMs, transient.retryAfterMs);
          // Said, not done quietly: a failed try may already have streamed some
          // of its reply, and the next one will say it again.
          context.status(
            "Model endpoint failed; trying the turn again",
            `${transient.message} Roqer tries again in ${seconds(delay)} (${retry + 1} of ${turnRetries}).`,
          );
          prose.beginSegment();
          await pause(delay, context.signal);
          context.progress(`Thinking with ${label}`);
        }
        if (context.signal.aborted) throw new RunCancelledError();
        if (stalled) {
          // Checked before the generic incomplete-turn error, because "the
          // endpoint ended the turn without completing it" is what a stall looks
          // like from the outside and is the least useful thing to be told.
          const stall = describeStall(Math.round(stallMs / 1000), context.changes());
          context.status("Model stopped making progress", stall);
          throw new Error(stall);
        }
        if (!completed) {
          throw new Error(options.label === undefined
            ? "The model endpoint ended the turn without completing it."
            : `${label} ended the turn without completing it.`);
        }

        const endedEarly = endedEarlyNote(stopReason, options.outputLimitAdvice);
        if (calls.length === 0) {
          // The model is done, but the person may not be: a note typed while
          // it was finishing has not been read, and a run that ends without
          // reading it has lost the last thing the user said. So the reply so
          // far becomes one more assistant turn and the note the next user one.
          const unread = context.takeSteers();
          if (unread.length > 0) {
            if (spoken.length > 0) messages.push({ role: "assistant", content: [{ kind: "text", text: spoken }] });
            messages.push({ role: "user", content: steerBlocks(unread) });
            context.status("Read your note", "The model had finished; it is continuing with what you added.");
            continue;
          }
          // The run ends here, so whatever cut this turn short is the last thing
          // that can be said about the result. Recorded in the timeline and said
          // in the reply both: the timeline is where it is countable and the
          // reply is where the person who asked will actually read it.
          // The model tried to call a tool and could not form the call, most
          // often one too large to write in a single piece. Said to it as
          // that, a few times, then said to the person as that: not as a
          // model with nothing to say.
          if (stopReason === "malformed-tool-call") {
            malformedInRow += 1;
            if (malformedInRow > MALFORMED_CALL_RETRIES) {
              throw new Error(`${label === "Roqer" ? "The model" : label} could not form a tool call ${malformedInRow} times in a row (its provider reported a malformed function call). This usually means one call is too large; ask for the work in smaller steps.`);
            }
            if (spoken.length > 0) messages.push({ role: "assistant", content: [{ kind: "text", text: spoken }] });
            messages.push({ role: "user", content: [{ kind: "text", text: MALFORMED_CALL_NOTE }] });
            context.status("Model sent a broken tool call", `Its provider could not read the call, so Roqer asked for a smaller one (${malformedInRow} of ${MALFORMED_CALL_RETRIES}).`);
            continue;
          }
          const answer = prose.text().trim();
          // An empty turn is a model losing its place, not a finished run:
          // some models end a turn silently in the middle of a plan, even
          // before writing one. Asked once, by the host, to carry on or answer.
          if (answer.length === 0 && endedEarly === undefined && !askedAfterSilence) {
            askedAfterSilence = true;
            const open = context.tasks().filter((task) => task.status === "pending" || task.status === "active");
            messages.push({ role: "user", content: [{ kind: "text", text: silenceNote(open) }] });
            context.status("Model stopped without a reply", "Roqer asked it once to continue the request or reply.");
            continue;
          }
          if (stuck !== undefined) return finish(`${answer || "The model returned no answer for this turn."}\n\n${stuckReply(stuck)}`, spoken);
          if (endedEarly === undefined) return finish(answer || "The model returned no answer for this turn.", spoken);
          context.status("Turn ended early", endedEarly);
          return finish(answer.length === 0 ? endedEarly : `${answer}\n\n${endedEarly}`, spoken);
        }
        // Told to report, it asked for more work instead: nothing more runs.
        if (stuck !== undefined) {
          const answer = prose.text().trim();
          if (answer.length > 0) return finish(`${answer}\n\n${stuckReply(stuck)}`, spoken);
          break;
        }
        malformedInRow = 0;
        // Cut off while still asking for tools is survivable, because the next
        // turn carries the results and the model can pick up where it stopped.
        // It is still worth recording: a run that keeps hitting the limit is one
        // whose steps are too large, and that is invisible without this.
        if (stopReason === "max-output") {
          context.status("Turn reached its output limit", "The model was cut off while working and will continue.");
        }

        const assistant: TurnContent[] = [
          ...(spoken.length > 0 ? [{ kind: "text" as const, text: spoken }] : []),
          ...calls.map((call) => ({ kind: "tool-call" as const, call })),
        ];
        messages.push({ role: "assistant", content: assistant });

        const results: TurnContent[] = [];
        let availableImageSlots = screenshotSlots;
        for (let index = 0; index < calls.length;) {
          if (isParallelStudioRead(calls[index])) {
            let end = index + 1;
            while (end < calls.length && isParallelStudioRead(calls[end])) end += 1;
            const batches = await Promise.all(calls.slice(index, end).map((call, offset) =>
              executeCall(call, availableImageSlots, turnNumber, index + offset + 1)));
            for (const blocks of batches) {
              results.push(...blocks);
              // A batched read is one the table says returns no image, but the
              // budget is spent against what actually came back rather than
              // against what was predicted.
              availableImageSlots -= blocks.filter((block) => block.kind === "image").length;
            }
            index = end;
            continue;
          }

          const blocks = await executeCall(calls[index], availableImageSlots, turnNumber, index + 1);
          results.push(...blocks);
          availableImageSlots -= blocks.filter((block) => block.kind === "image").length;
          index += 1;
        }
        // A note the user typed while those calls ran rides in the same message
        // as their results: the turn boundary is the one place the model reads
        // new input, and this is the next one. After the results, so the
        // provider sees every call answered before it sees anything else.
        const steers = context.takeSteers();
        if (steers.length > 0) {
          context.status("Read your note", steers.length === 1 ? steers[0] : `${steers.length} notes reached the model.`);
        }
        messages.push({ role: "user", content: [...results, ...steerBlocks(steers)] });
        // A note from the user is new input, so it resets the count: the same
        // call after being told something is not the same situation.
        const signature = JSON.stringify(calls.map((call) => [call.name, call.arguments]));
        const outcomes = results.filter((block) => block.kind === "tool-result");
        const failed = outcomes.length > 0 && outcomes.every((block) => block.kind === "tool-result" && block.failed === true);
        const repeated = signature === lastSignature && steers.length === 0;
        sameCalls = repeated ? sameCalls + 1 : 1;
        sameFailures = failed ? (repeated ? sameFailures + 1 : 1) : 0;
        lastSignature = signature;
        if (sameFailures >= REPEATED_FAILURE_TURNS) stuck = { turns: sameFailures, failing: true };
        else if (sameCalls >= REPEATED_CALL_TURNS) stuck = { turns: sameCalls, failing: false };
        // Folding runs first: an exchange dropped here takes its tool output and
        // its pictures with it, so the budgets below are spent on what the run
        // still carries rather than on what is about to leave.
        const folded = compactHistory(messages, (foldedMessages) => describeRunState({
          tasks: context.tasks(),
          changes: context.changes(),
          evidence: context.evidence(),
          verification: context.checkCompletion(),
          decisions: context.decisions(),
        }, foldedMessages), opening);
        if (folded) {
          // Said rather than done quietly. A model that suddenly cannot quote a
          // result it read twenty turns ago is behaving correctly, and a reader
          // watching a long run deserves to know why it went back to re-read.
          context.status(
            "Earlier conversation folded",
            "This run grew long enough that Roqer replaced its older exchanges with a summary of the tasks, changes, and evidence recorded so far.",
          );
        }
        const elided = boundRetainedToolResults(messages, answerCallIds, options.toolOutputBudget);
        // The cache is only a pointer to guidance retained in the provider
        // conversation. Once either bound removes history, that pointer may no
        // longer have a document behind it, so the next request must deliver
        // the guidance again instead of claiming the model can still see it.
        if (folded || elided) runSkillTool.clearCache();
        // After the new results are in, so the budget is spent newest-first and
        // the capture that just happened is the one that survives.
        boundRetainedImages(messages, requests);
      }

      // Reached only when a stuck model, told to report, asked for more calls
      // and said nothing.
      throw new Error(stuckReply(stuck ?? { turns: REPEATED_CALL_TURNS, failing: false }));
    },
  };
}
