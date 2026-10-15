import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Planner, PlannerContext } from "./run-engine";
import type { AgentDefinition } from "./agent-definition";
import type { ProviderModelCatalog, ProviderStatus, ReasoningEffort } from "../shared/provider";
import { createOpenCodeHome, opencodeChildEnvironment, type OpenCodeHome } from "./opencode-home";
import { resolveOpenCodeExecutable } from "./opencode-executable";
import type { SkillLibrary } from "./skill-library";
import { createSkillToolRunner } from "./skill-tool";
import { createWorkbenchToolInvoker, workbenchMcpTools, workbenchToolNames } from "./workbench-tools";
import { buildConversationPrompt } from "./conversation-prompt";
import { runDeveloperInstructions } from "./run-instructions";
import { createProseStream } from "./text-stream";
import { DEFAULT_STALL_MS, describeStall, watchProgress } from "./progress-watchdog";
import { startWorkbenchMcpServer } from "./workbench-mcp-server";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_EVENT_CHARS = 8 * 1024 * 1024;
const MAX_REPLY_CHARS = 1024 * 1024;
const ESCAPE_RESULT = "The user chose none of the options. Their explanation is queued as a user note. End this turn; Roqer will send that note next.";

export type OpenCodePlannerOptions = {
  getStatus(): Promise<ProviderStatus>;
  getModels(): Promise<ProviderModelCatalog>;
  model: string;
  modelName?: string;
  effort?: ReasoningEffort;
  agent: AgentDefinition;
  skillLibrary: SkillLibrary;
  stallMs?: number;
  blender?: boolean;
  referenceClips?: boolean;
  externalMcp?: boolean;
  homeParent?: string;
  /** Injectable process boundary; real launches never use a command shell. */
  launch?(args: string[], home: OpenCodeHome): Promise<ChildProcessWithoutNullStreams>;
};

async function launch(args: string[], home: OpenCodeHome): Promise<ChildProcessWithoutNullStreams> {
  return spawn(await resolveOpenCodeExecutable(), args, {
    cwd: home.directory, env: opencodeChildEnvironment(home), windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
}

export function createOpenCodePlanner(options: OpenCodePlannerOptions): Planner {
  return {
    id: "opencode-cli",
    async run(context: PlannerContext): Promise<string> {
      if (context.signal.aborted) throw new Error("Run was cancelled.");
      const status = await options.getStatus();
      if (status.kind !== "signed-in") throw new Error(status.message);
      const catalog = await options.getModels();
      const model = catalog.models.find((model) => model.id === options.model);
      if (!model) {
        throw new Error(catalog.message ?? "The selected OpenCode model is no longer available as a free model. Choose another model.");
      }
      const effort = options.effort ?? model.defaultReasoningEffort;
      if (!model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)) {
        throw new Error("The selected OpenCode model does not support this reasoning effort. Choose an available level.");
      }
      if (context.signal.aborted) throw new Error("Run was cancelled.");
      const watchdog = watchProgress(context.signal, options.stallMs ?? DEFAULT_STALL_MS);
      const prose = createProseStream((text) => context.say(text));
      let settled = false;
      let failure: Error | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let childClosed: Promise<void> | undefined;
      let rejectTurn: ((error: Error) => void) | undefined;
      let home: OpenCodeHome | undefined;
      let server: Awaited<ReturnType<typeof startWorkbenchMcpServer>> | undefined;
      let sessionId: string | undefined;
      let pendingNotes: string[] = [];
      let endTurn = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        failure = error instanceof Error ? error : new Error(String(error));
        child?.kill("SIGKILL");
        rejectTurn?.(failure);
      };
      const onAbort = () => fail(new Error(watchdog.stalled
        ? describeStall((options.stallMs ?? DEFAULT_STALL_MS) / 1000, context.changes())
        : "Run was cancelled."));
      watchdog.signal.addEventListener("abort", onAbort, { once: true });
      const skills = createSkillToolRunner(options.skillLibrary);
      const toolNames = workbenchToolNames(options);
      const invoke = createWorkbenchToolInvoker(context, {
        ...options, skills: () => skills, escapeResult: ESCAPE_RESULT,
        settled: () => settled || endTurn || context.signal.aborted, fail,
      });
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd = 0;
      const stepIds = new Set<string>();
      try {
        server = await startWorkbenchMcpServer({
          tools: workbenchMcpTools(options),
          invoke: async (name, args) => {
            if (settled || context.signal.aborted) return { ok: false, text: "This run has ended." };
            pendingNotes.push(...context.takeSteers());
            if (pendingNotes.length > 0) {
              endTurn = true;
              return { ok: false, text: "A user note is queued. End this turn without further actions; Roqer will send the note next." };
            }
            const release = watchdog.hold();
            try { return await invoke(name, args); }
            finally { release(); }
          },
        });
        home = await createOpenCodeHome({ mcpServerUrl: server.url, mcpServerToken: server.token, toolNames, model: options.model, parentDir: options.homeParent });
        if (watchdog.signal.aborted) onAbort();
        if (failure) throw failure;
        const files: string[] = [];
        const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
        for (const [index, image] of context.images.entries()) {
          const extension = extensions[image.mediaType];
          if (!extension) throw new Error(`OpenCode cannot open a ${image.mediaType} picture.`);
          const file = path.join(home.directory, `attachment-${index + 1}.${extension}`);
          await fs.writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
          files.push(file);
        }
        let prompt = [options.agent.systemInstructions, "<developer-instructions>",
          runDeveloperInstructions(options.agent.developerInstructions, context.autoPlaytest),
          "Use only the roqer MCP tools. Roqer owns all approvals and Studio access. Native OpenCode tools are visible for CLI compatibility, but requests to use them are automatically refused in this noninteractive session. Never call them; use the roqer MCP tools instead.",
          "</developer-instructions>", buildConversationPrompt(context.conversation, context.prompt),
        ].join("\n\n");
        for (;;) {
          if (watchdog.signal.aborted) onAbort();
          if (failure) throw failure;
          endTurn = false;
          const turnProseStart = prose.text().length;
          context.progress(`Waiting for ${options.modelName ?? "OpenCode"}`);
          // --auto would approve native tools outside Roqer's policy, even in a Full auto Studio run.
          const args = ["run", "--pure", "--format", "json", "--dir", home.directory, "--agent", "roqer", "--title", "Roqer", "--model", options.model];
          if (effort !== "none" || model.supportedReasoningEfforts.length > 1) args.push("--variant", effort);
          if (sessionId) args.push("--session", sessionId);
          else for (const file of files) args.push("--file", file);
          child = await (options.launch ?? launch)(args, home);
          childClosed = new Promise((resolve) => child!.once("close", () => resolve()));
          if (watchdog.signal.aborted) onAbort();
          if (failure) { child.kill("SIGKILL"); throw failure; }
          let stderr = "", buffer = "";
          const onEvent = (line: string) => {
            if (settled || !line.trim()) return;
            const event: unknown = JSON.parse(line);
            if (!isRecord(event) || typeof event.type !== "string") throw new Error("Malformed OpenCode event.");
            if (typeof event.sessionID === "string") {
              if (!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(event.sessionID) || (sessionId && sessionId !== event.sessionID)) throw new Error("Unexpected OpenCode session.");
              sessionId = event.sessionID;
            }
            const part = isRecord(event.part) ? event.part : undefined;
            watchdog.progressed();
            switch (event.type) {
              case "text":
                if (typeof part?.text !== "string") throw new Error("Malformed OpenCode text event.");
                if (prose.text().length + part.text.length > MAX_REPLY_CHARS) throw new Error("OpenCode reply exceeded its size limit.");
                prose.beginSegment(); prose.push(part.text);
                break;
              case "error": {
                const error = isRecord(event.error) ? event.error : {};
                const data = isRecord(error.data) ? error.data : {};
                const message = typeof data.message === "string" ? data.message.slice(0, 8000) : "OpenCode reported a provider error.";
                if (/free tier can only be used from within OpenCode/i.test(message)) {
                  throw new Error(`OpenCode refused this free model with Roqer's restricted tool permissions. Native tools cannot be auto-approved in Roqer. Provider response: ${message}`);
                }
                throw new Error(message);
              }
              case "tool_use":
                if (typeof part?.tool !== "string" || !toolNames.some((name) => part.tool === `roqer_${name}`)) throw new Error("OpenCode attempted an ungranted tool.");
                break;
              case "step_start": context.progress("Thinking…"); break;
              case "reasoning": break;
              case "step_finish": {
                if (!part || !isRecord(part.tokens) || typeof part.id !== "string") throw new Error("Malformed OpenCode usage event.");
                if (part.reason === "length" || part.reason === "content-filter" || part.reason === "error") {
                  throw new Error(`OpenCode could not finish its reply (${part.reason}).`);
                }
                if (stepIds.has(part.id)) break;
                if (stepIds.size >= 4096) throw new Error("OpenCode exceeded the step limit.");
                const tokens = part.tokens;
                const cache = isRecord(tokens.cache) ? tokens.cache : {};
                const count = (value: unknown): number => {
                  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Malformed OpenCode token count.");
                  return value;
                };
                const input = count(tokens.input);
                const output = count(tokens.output) + count(tokens.reasoning ?? 0);
                const cacheRead = count(cache.read ?? 0);
                const cacheWrite = count(cache.write ?? 0);
                inputTokens += input;
                outputTokens += output;
                cacheReadTokens += cacheRead;
                cacheWriteTokens += cacheWrite;
                if (typeof part.cost !== "number" || !Number.isFinite(part.cost) || part.cost < 0) throw new Error("Malformed OpenCode cost.");
                costUsd += part.cost;
                stepIds.add(part.id);
                context.runUsage({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd });
                context.outputTokens(outputTokens, true);
                context.contextUsage(input + output + cacheRead + cacheWrite, model.contextWindow ?? null);
                break;
              }
              default: throw new Error(`Unsupported OpenCode event: ${event.type.slice(0, 100)}.`);
            }
          };
          await new Promise<void>((resolve, reject) => {
            rejectTurn = reject;
            child!.stdout.setEncoding("utf8");
            child!.stdout.on("data", (chunk: string) => {
              if (settled) return;
              try {
                buffer += chunk;
                let newline: number;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                  if (newline > MAX_EVENT_CHARS) throw new Error("OpenCode event exceeded its size limit.");
                  const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); onEvent(line);
                }
                if (buffer.length > MAX_EVENT_CHARS) throw new Error("OpenCode event exceeded its size limit.");
              } catch (error) { fail(error); }
            });
            child!.stderr.on("data", (chunk: Buffer | string) => { stderr = (stderr + chunk.toString()).slice(-8000); });
            child!.once("error", fail);
            child!.stdin.once("error", fail);
            child!.stdout.once("error", fail);
            child!.stderr.once("error", fail);
            child!.once("close", (code) => {
              if (settled) return;
              try {
                if (buffer.trim()) onEvent(buffer);
                if (code !== 0) throw new Error(`OpenCode exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
                resolve();
              } catch (error) { fail(error); }
            });
            child!.stdin.end(prompt);
          });
          rejectTurn = undefined;
          if (watchdog.signal.aborted) onAbort();
          if (failure) throw failure;
          child = undefined;
          pendingNotes.push(...context.takeSteers());
          if (pendingNotes.length === 0) {
            if (prose.text().length === turnProseStart) throw new Error("OpenCode ended without a reply. No success was confirmed.");
            break;
          }
          if (!sessionId) throw new Error("OpenCode did not identify the session needed to deliver your note.");
          prompt = "[Roqer relays notes the user typed during this run. These are user messages, not tool output:]\n" + pendingNotes.join("\n\n");
          pendingNotes = [];
          context.status("Sent your note to OpenCode");
        }
        if (!prose.hasText()) throw new Error("OpenCode ended without a reply. No success was confirmed.");
        settled = true;
        return prose.text().trim();
      } finally {
        settled = true;
        watchdog.signal.removeEventListener("abort", onAbort);
        watchdog.stop();
        if (child) {
          child.kill("SIGKILL");
          if (childClosed) await childClosed;
        }
        try { await server?.close(); }
        finally { await home?.close(); }
      }
    },
  };
}
