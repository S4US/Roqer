/**
 * The one bounded question a run may put to the user.
 *
 * Approvals already prove a tool call can suspend mid-turn while the renderer
 * decides, so a clarification uses the same shape rather than inventing a
 * second waiting mechanism. What it deliberately does not reuse is free text:
 * the model offers a small set of options, and the renderer answers with an
 * *index* into them. No renderer-authored string ever reaches the model, so the
 * answer channel cannot be used to smuggle text past the trust boundary — the
 * worst a compromised renderer can do is pick a choice the model already wrote.
 *
 * The model's options are not always the right ones, and a person whose answer
 * is "neither" used to have to pick the least wrong or stop the run. So every
 * question carries one more choice than the model wrote, appended by the host:
 * "none of these", at index `options.length`. Choosing it keeps this channel
 * exactly as bounded as before — an index, into a list the host controls — and
 * the person's own words travel on the channel built for the user's words, as
 * a note to the run, which the planner puts in front of the model beside the
 * answer.
 */

export type RunQuestion = {
  /** Shares the call-id space with approvals, so one map can hold both. */
  callId: string;
  question: string;
  /** Two to four mutually exclusive choices, in the model's preferred order. */
  options: string[];
};

export const MAX_QUESTION_CHARS = 300;
export const MAX_OPTION_CHARS = 80;
export const MIN_QUESTION_OPTIONS = 2;
export const MAX_QUESTION_OPTIONS = 4;
/** A run may not interrogate the user; one answered question is the budget. */
export const MAX_QUESTIONS_PER_RUN = 2;

/**
 * The host's own option, offered after the model's. Its text is what the
 * record and the timeline show for the choice; the person's actual answer is
 * the note that follows it.
 */
export const QUESTION_ESCAPE_OPTION = "None of these — I'll explain";

/** Whether an answer index is the host's escape rather than one of the model's options. */
export function isEscapeAnswer(answerIndex: number, options: readonly string[]): boolean {
  return answerIndex === options.length;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isRunQuestion(value: unknown): value is RunQuestion {
  return isRecord(value) &&
    typeof value.callId === "string" && value.callId !== "" &&
    typeof value.question === "string" &&
    value.question !== "" && value.question.length <= MAX_QUESTION_CHARS &&
    Array.isArray(value.options) &&
    value.options.length >= MIN_QUESTION_OPTIONS &&
    value.options.length <= MAX_QUESTION_OPTIONS &&
    value.options.every((option) =>
      typeof option === "string" && option !== "" && option.length <= MAX_OPTION_CHARS);
}

/**
 * Parse a model-supplied question, throwing text the model can act on.
 *
 * Requiring at least two options is the substantive rule: a question with one
 * option is not a question, it is an announcement, and a model that cannot name
 * a second path should proceed on a stated assumption instead of stopping the
 * run to say so.
 */
export function parseQuestionInput(value: unknown): { question: string; options: string[] } {
  if (!isRecord(value) || typeof value.question !== "string") {
    throw new Error("ask_user requires a `question` string and an `options` array.");
  }
  const question = value.question.trim();
  if (question === "") throw new Error("The question cannot be empty.");
  if (question.length > MAX_QUESTION_CHARS) {
    throw new Error(`The question must be at most ${MAX_QUESTION_CHARS} characters; it was ${question.length}.`);
  }
  if (!Array.isArray(value.options)) throw new Error("ask_user requires an `options` array.");

  const options: string[] = [];
  for (const [index, option] of value.options.entries()) {
    if (typeof option !== "string" || option.trim() === "") {
      throw new Error(`Option ${index + 1} must be a non-empty string.`);
    }
    const trimmed = option.trim();
    if (trimmed.length > MAX_OPTION_CHARS) {
      throw new Error(`Option ${index + 1} must be at most ${MAX_OPTION_CHARS} characters.`);
    }
    if (options.includes(trimmed)) throw new Error(`Option ${index + 1} repeats an earlier option.`);
    if (trimmed === QUESTION_ESCAPE_OPTION) {
      throw new Error(`Option ${index + 1} is offered by Roqer on every question already; leave it out.`);
    }
    options.push(trimmed);
  }
  if (options.length < MIN_QUESTION_OPTIONS || options.length > MAX_QUESTION_OPTIONS) {
    throw new Error(`Offer ${MIN_QUESTION_OPTIONS}-${MAX_QUESTION_OPTIONS} options; ${options.length} were supplied. If only one path exists, take it and state the assumption instead of asking.`);
  }
  return { question, options };
}

/**
 * Whether an index the renderer sent actually addresses one of the choices:
 * the model's options, or the host's escape one past them.
 */
export function isAnswerIndex(value: unknown, options: readonly string[]): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= options.length;
}
