import { describeGateForModel } from "../shared/completion";
import {
  parseRunTaskList,
  summarizeTasks,
  MAX_RUN_TASKS,
  MAX_TASK_TITLE_CHARS,
  RUN_EVIDENCE_REQUIREMENTS,
} from "../shared/tasks";
import type { PlannerContext } from "./run-engine";

/**
 * The tool a model uses to declare and revise what it is doing.
 *
 * The list is not a transcript of every call. Typed evidence requirements are
 * promises the completion gate later holds the run to, so the tool description
 * asks for that judgement at planning time.
 */

type JsonRecord = Record<string, unknown>;

export const TASK_TOOL_NAME = "update_task_list";

export function taskToolDefinition(): { name: string; description: string; inputSchema: JsonRecord } {
  return {
    name: TASK_TOOL_NAME,
    description: [
      "Declare or update the task list for this run. Send the complete list every time, reusing each task's id so a status change is not read as a new task.",
      "Use this for work with at least three dependent stages, cross-system or destructive work, long-running work, or debugging with distinct diagnose/fix/verify milestones. Skip it for small edits and straightforward creates.",
      "Track meaningful milestones, not every inspection or tool call. Update the list when a milestone starts, finishes, or becomes blocked.",
      "Set requiredEvidence to the dimensions needed after the task's final change: runtime for executed behavior or logs, visual for rendered appearance, and interaction for a user action that must be exercised. Keep the task active until those observations are collected.",
      "Only one task may be active at a time. Mark a task blocked instead of done when you cannot finish it.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          maxItems: MAX_RUN_TASKS,
          description: `The full task list, in order. At most ${MAX_RUN_TASKS} tasks.`,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id. Reuse it when updating this task." },
              title: { type: "string", description: `What the task accomplishes, at most ${MAX_TASK_TITLE_CHARS} characters.` },
              status: { type: "string", enum: ["pending", "active", "done", "blocked"] },
              requiredEvidence: {
                type: "array",
                maxItems: RUN_EVIDENCE_REQUIREMENTS.length,
                uniqueItems: true,
                items: { type: "string", enum: [...RUN_EVIDENCE_REQUIREMENTS] },
                description: "Observation dimensions required after this task's final change; empty when verified mutation evidence is enough.",
              },
            },
            required: ["id", "title", "status", "requiredEvidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  };
}

/**
 * Validate and record a task list. Throws a message the model can act on.
 *
 * The reply carries the completion gate's current verdict, which is the one
 * moment the model is guaranteed to be listening and still has turn left: a
 * task marked done that promised runtime evidence and has none says so here,
 * while there is still time to go and collect it.
 */
export function runTaskTool(context: PlannerContext, value: unknown): string {
  const tasks = parseRunTaskList(value);
  context.setTasks(tasks);
  const gate = describeGateForModel(context.checkCompletion());
  const confirmation = `Task list updated: ${summarizeTasks(tasks)}.`;
  return gate === undefined ? confirmation : `${confirmation}\n\n${gate}`;
}
