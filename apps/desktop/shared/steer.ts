/**
 * A note the user adds while a run is working.
 *
 * "Also make it blue." "Wrong script -- it's the server one." Before this, the
 * only ways to say either were to wait for the run to finish or to stop it and
 * start again, and a long build made both expensive. A note is queued by the
 * engine and handed to the model at its next turn boundary, beside the tool
 * results it was about to read anyway. It is never injected into a tool result
 * and never interrupts a turn: Stop remains the hard interrupt.
 *
 * This is renderer-authored text reaching the model, which the question answer
 * channel was designed never to be. The two are different things. An answer
 * completes a question the model wrote, on a channel where a forged string
 * could change what the model believes the user chose; a note is the user
 * speaking, on the same footing as the prompt that started the run. It gets
 * the prompt's trust and the prompt's kind of bound, is recorded in the chat
 * and the timeline where the person can see it, and reaches the model labelled
 * as what it is.
 */

export const MAX_STEER_CHARS = 4_000;
/** A run may be steered, not dictated to a keystroke at a time. */
export const MAX_STEERS_PER_RUN = 20;

/**
 * The note as the engine will queue it, or null when there is nothing to
 * queue: empty, over the bound, or carrying control characters the wire
 * contract refuses.
 */
export function normalizeSteer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > MAX_STEER_CHARS) return null;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return null;
  }
  return text;
}
