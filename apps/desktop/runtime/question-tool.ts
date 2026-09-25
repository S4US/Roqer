import {
  parseQuestionInput, MAX_OPTION_CHARS, MAX_QUESTION_CHARS, MAX_QUESTION_OPTIONS, MIN_QUESTION_OPTIONS,
  QUESTION_ESCAPE_OPTION,
} from "../shared/question";
import type { PlannerContext } from "./run-engine";

/**
 * The tool a model uses to ask the user one bounded question.
 *
 * The call suspends the same way an approval does, so the provider turn stays
 * open while the renderer decides. The cost of that is the user is blocked, so
 * the description spends most of its length on when *not* to ask: a run that
 * stops to confirm something it could have assumed is worse than one that
 * states the assumption and keeps going.
 */

type JsonRecord = Record<string, unknown>;

export const QUESTION_TOOL_NAME = "ask_user";

export function questionToolDefinition(): { name: string; description: string; inputSchema: JsonRecord } {
  return {
    name: QUESTION_TOOL_NAME,
    description: [
      "Ask the user one bounded multiple-choice question and wait for their answer.",
      "Use it only when two readings of the request would lead to materially different work and choosing wrong would waste the run or change the project in a way the user did not want.",
      "Do not use it to confirm something you can verify by reading Studio, to ask permission for an action Roqer already gates by approval, or to check in on progress. When one path is clearly reasonable, take it and state the assumption in your reply instead.",
      "The run is stopped while the user reads this, so ask at most once, and ask before doing the work rather than after.",
      "Roqer adds a \"none of these\" choice to every question, so do not offer one yourself; if the user takes it, their own answer reaches you as a note relayed by Roqer.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: `The question, at most ${MAX_QUESTION_CHARS} characters. Ask about the decision, not about whether you may proceed.`,
        },
        options: {
          type: "array",
          minItems: MIN_QUESTION_OPTIONS,
          maxItems: MAX_QUESTION_OPTIONS,
          description: `${MIN_QUESTION_OPTIONS}-${MAX_QUESTION_OPTIONS} mutually exclusive choices, best first. At most ${MAX_OPTION_CHARS} characters each.`,
          items: { type: "string" },
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  };
}

/**
 * What the model is told when the user took the host's "none of these" choice.
 *
 * The default suits a planner that can put a note in the same message as this
 * result. A planner whose notes only reach the model at a turn boundary passes
 * its own text instead, because telling the model to read a note that has not
 * been sent yet would be a claim about the transcript that is not true.
 */
const ESCAPE_RESULT =
  "The user chose none of the offered options. Their own answer follows in this message as a note relayed by Roqer; follow it.";

/**
 * Ask, wait, and return the chosen option as text.
 *
 * The answer is the option string the model itself supplied, selected by index,
 * so nothing the renderer typed reaches the provider through this result. When
 * the user chose none of them, their own words travel as a note, and
 * `escapeResult` is what tells the model where to expect it.
 */
export async function runQuestionTool(
  context: PlannerContext,
  value: unknown,
  escapeResult: string = ESCAPE_RESULT,
): Promise<string> {
  const { question, options } = parseQuestionInput(value);
  const answer = await context.askUser(question, options);
  if (answer === QUESTION_ESCAPE_OPTION) return escapeResult;
  return `The user answered: ${answer}`;
}
