import type { PlannerContext } from "./run-engine";
import type { SkillLibrary } from "./skill-library";
import { createIconToolRunner, iconToolDefinition, ICON_TOOL_NAME } from "./icon-tool";
import { blenderToolDefinition, parseBlenderToolInput } from "./blender-tool";
import { BLENDER_TOOL_NAME } from "../shared/blender";
import { REFERENCE_CLIP_TOOL_NAME } from "../shared/reference-clip";
import { parseReferenceClipToolInput, referenceClipToolDefinition } from "./reference-clip";
import { skillToolDefinition, SKILL_TOOL_NAME, type SkillToolRunner } from "./skill-tool";
import {
  createStudioToolRunner, MalformedToolCallError, malformedCallsEndRun, MAX_CONSECUTIVE_MALFORMED_CALLS, parseStudioToolInput, studioToolDescription, studioToolInputSchema,
  STUDIO_TOOL_NAME,
} from "./studio-tools";
import { runTaskTool, taskToolDefinition, TASK_TOOL_NAME } from "./task-tool";
import { runQuestionTool, questionToolDefinition, QUESTION_TOOL_NAME } from "./question-tool";
import type { WorkbenchMcpTool, WorkbenchMcpToolResult } from "./workbench-mcp-server";

/**
 * The Roqer tools an MCP-speaking provider (Claude Code, the Antigravity CLI)
 * is given over the loopback workbench server, and what answers each call.
 *
 * The provider owns the agent loop; Roqer owns every tool. Studio calls go
 * through the run engine's policy and approvals; skill reads stay inside the
 * agent bundle.
 */

type JsonRecord = Record<string, unknown>;

export type WorkbenchToolOptions = {
  skillLibrary: SkillLibrary;
  /** Offer the `blender` tool: only while the user has turned the local Blender worker on. */
  blender?: boolean;
  /** Offer `reference_clip`: only in a chat holding a clip the user attached. */
  referenceClips?: boolean;
};

/** Every tool granted for these options, in the order they are announced. */
export function workbenchToolNames(options: WorkbenchToolOptions): string[] {
  return [
    STUDIO_TOOL_NAME, SKILL_TOOL_NAME, ICON_TOOL_NAME, TASK_TOOL_NAME, QUESTION_TOOL_NAME,
    ...(options.blender === true ? [BLENDER_TOOL_NAME] : []),
    ...(options.referenceClips === true ? [REFERENCE_CLIP_TOOL_NAME] : []),
  ];
}

/** The definitions the workbench server lists, in the same order as `workbenchToolNames`. */
export function workbenchMcpTools(options: WorkbenchToolOptions): WorkbenchMcpTool[] {
  return [
    { name: STUDIO_TOOL_NAME, description: studioToolDescription(), inputSchema: studioToolInputSchema() },
    skillToolDefinition(options.skillLibrary), iconToolDefinition(), taskToolDefinition(), questionToolDefinition(),
    ...(options.blender === true ? [blenderToolDefinition()] : []),
    ...(options.referenceClips === true ? [referenceClipToolDefinition()] : []),
  ];
}

export type WorkbenchToolInvokerOptions = WorkbenchToolOptions & {
  /** The skill documents already in the provider's conversation. */
  skills(): SkillToolRunner;
  /** The tool result for a "none of these" answer to a question; it depends on how notes reach the provider. */
  escapeResult: string;
  /** Whether the run has already ended, in which case no tool runs. */
  settled(): boolean;
  /** End the run: cancellation, a host failure, or malformed calls that are not converging. */
  fail(error: unknown): void;
};

export type WorkbenchToolInvoker = (name: string, args: JsonRecord) => Promise<WorkbenchMcpToolResult>;

const failure = (error: unknown): WorkbenchMcpToolResult => ({
  ok: false,
  text: error instanceof Error ? error.message : String(error),
});

/** Answer one run's calls to the workbench tools. */
export function createWorkbenchToolInvoker(context: PlannerContext, options: WorkbenchToolInvokerOptions): WorkbenchToolInvoker {
  const runStudioTool = createStudioToolRunner(context, { templates: options.skillLibrary });
  const runIconTool = createIconToolRunner(options.skillLibrary);
  /** Malformed Studio or Blender calls since the last well-formed one. */
  let malformedCalls = 0;

  return async (name, args) => {
    if (options.settled()) return { ok: false, text: "This Roqer run has ended. End this turn." };
    if (name === SKILL_TOOL_NAME || name === ICON_TOOL_NAME) {
      const run = name === SKILL_TOOL_NAME ? options.skills() : runIconTool;
      try {
        return { ok: true, text: await run(args) };
      } catch (error) {
        return failure(error);
      }
    }
    if (name === TASK_TOOL_NAME) {
      // A malformed list is the model's mistake to correct, not a reason
      // to end the turn, so it comes back as an ordinary tool error.
      try {
        return { ok: true, text: runTaskTool(context, args) };
      } catch (error) {
        return failure(error);
      }
    }
    if (name === QUESTION_TOOL_NAME) {
      try {
        return { ok: true, text: await runQuestionTool(context, args, options.escapeResult) };
      } catch (error) {
        // A cancelled run must still end the turn; a rejected question
        // shape must not.
        if (context.signal.aborted) options.fail(error);
        return failure(error);
      }
    }
    let call: { operation: string; args: JsonRecord };
    try {
      call = options.blender === true && name === BLENDER_TOOL_NAME
        ? parseBlenderToolInput(args)
        : options.referenceClips === true && name === REFERENCE_CLIP_TOOL_NAME
          ? parseReferenceClipToolInput(args)
          : parseStudioToolInput(args);
    } catch (error) {
      // A malformed call is the model's mistake to correct, answered like
      // any failed call; only a run of them that is not converging ends it.
      const text = error instanceof Error ? error.message : String(error);
      if (!(error instanceof MalformedToolCallError)) options.fail(error);
      else if (++malformedCalls >= MAX_CONSECUTIVE_MALFORMED_CALLS) options.fail(malformedCallsEndRun(text));
      return { ok: false, text };
    }
    malformedCalls = 0;
    try {
      return await runStudioTool(call.operation, call.args);
    } catch (error) {
      // Policy/user rejections are ordinary results from runStudioTool.
      // Only cancellation or an unexpected host error reaches this
      // boundary and ends the provider turn.
      options.fail(error);
      return failure(error);
    }
  };
}
