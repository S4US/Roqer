/**
 * How much of a streaming reply is on screen.
 *
 * Providers deliver a reply in bursts: several words at once, then a pause,
 * whenever the network or the model hands over its next chunk. Showing each
 * burst the moment it lands makes the reply jump. Instead the shown text runs
 * a little behind what has arrived and closes the gap a share at a time every
 * frame: a burst becomes a quick, even run of characters, and a pause in the
 * stream is a slowing rather than a stop.
 *
 * The gap closes faster the larger it is, so the shown text never falls more
 * than a fraction of a second behind, however fast the reply arrives. Once the
 * run has ended, the rest is shown quickly rather than at reading pace.
 */

/** How quickly the shown text closes the gap while the reply is arriving: about two thirds of it in this time. */
export const REVEAL_LAG_MS = 280;
/** The same once the run has ended, a little quicker, so the end of the reply is not kept waiting. */
export const REVEAL_FINISH_MS = 160;
/** The slowest the text is shown while any of it is waiting, so a short tail still finishes. */
export const REVEAL_MIN_CHARACTERS_PER_SECOND = 60;
/** The longest frame counted, so a window that was hidden catches up smoothly instead of all at once. */
const MAX_FRAME_MS = 100;

/**
 * How many characters to show after a frame of `elapsedMs`, from `shown` (which
 * may be fractional) towards `arrived`. Never goes back, and never passes `arrived`.
 */
export function nextReveal(shown: number, arrived: number, elapsedMs: number, done: boolean): number {
  if (shown >= arrived) return arrived;
  const elapsed = Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS);
  const gap = arrived - shown;
  const share = gap * (1 - Math.exp(-elapsed / (done ? REVEAL_FINISH_MS : REVEAL_LAG_MS)));
  const floor = (REVEAL_MIN_CHARACTERS_PER_SECOND * elapsed) / 1000;
  return Math.min(arrived, shown + Math.max(share, floor));
}

/** Where to cut `text` near `count` characters without splitting a character made of two code units. */
export function revealEnd(text: string, count: number): number {
  const end = Math.max(0, Math.min(text.length, Math.floor(count)));
  if (end > 0 && end < text.length) {
    const unit = text.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) return end - 1;
  }
  return end;
}

/**
 * How far each recent reveal has got, by key, for this session only. A view
 * that takes over a reply carries on from here: the saved reply when a run
 * ends (it mounts in the same commit the live view goes), or the live view of
 * a chat opened again mid-run. A finished reveal stays, so neither view shows
 * the reply a second time. Only the most recent are kept.
 */
const revealing = new Map<string, { text: string; shown: number }>();
export const REVEALS_KEPT = 32;

/** Record how far the reveal of `text` under `key` has got. */
export function noteReveal(key: string, text: string, shown: number): void {
  // Re-inserted so the map's order is most recently revealed last.
  revealing.delete(key);
  revealing.set(key, { text, shown: Math.min(shown, text.length) });
  if (revealing.size > REVEALS_KEPT) revealing.delete(revealing.keys().next().value as string);
}

/**
 * How much of `text` a view taking over the reveal under `key` shows from the
 * start: undefined when there is no such reveal, or when `text` does not begin
 * with what was already shown, since carrying on would show the wrong words.
 */
export function resumeReveal(key: string, text: string): number | undefined {
  const reveal = revealing.get(key);
  if (reveal === undefined) return undefined;
  const shownText = reveal.text.slice(0, Math.floor(reveal.shown));
  if (!text.startsWith(shownText)) return undefined;
  // A reveal that had finished stays finished, though the text taking over has more.
  return reveal.shown >= reveal.text.length ? text.length : Math.min(reveal.shown, text.length);
}
