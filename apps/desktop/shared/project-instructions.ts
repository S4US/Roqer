/**
 * Standing instructions the user writes for every chat in one project.
 *
 * "Use Knit, not ModuleLoader." "All UI goes in StarterGui/HUD." "Never touch
 * ServerStorage/Legacy." Without these, the user repeats the same context in
 * every chat. Each provider runs without the user's own instruction files
 * (Claude Code with no setting sources, Antigravity in a private home), so the
 * project is the one place these can live.
 *
 * This is renderer-authored text reaching the model, like the prompt and the
 * mid-run note (see `steer.ts`). It gets the same trust as those: the user
 * speaking, shown in the project's settings where the user can read and change
 * it, and labelled to the model as what it is. It is not Roqer's policy and
 * cannot change it: approvals and irreversible-action checks are enforced by
 * the run engine, whatever the model is told.
 */

/** Sent with every turn of every run in the project, so it stays short. */
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 8_000;

/**
 * The instructions as a run will send them, or null when there is nothing to
 * send: not a string, empty, over the bound, or carrying control characters
 * the wire contract refuses.
 */
export function normalizeProjectInstructions(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > MAX_PROJECT_INSTRUCTIONS_CHARS) return null;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return null;
  }
  return text;
}

/** Whether a stored value is instructions a run could send, unchanged. */
export function isProjectInstructions(value: unknown): value is string {
  return typeof value === "string" && normalizeProjectInstructions(value) === value;
}
