/**
 * Which run the Run Deck shows.
 *
 * Results sit beside the chat rather than inside it, so the reply stays readable
 * while a run works. One deck shows one run: the one the reader picked, else, in
 * a window wide enough to hold it beside the chat, the latest run that has any
 * results. Below that width it covers part of the chat, so it opens only when
 * asked, and closing it holds until the reader opens it again.
 */

/** Sidebar, a deck and a chat that still reads as a chat. `signal-room.css` uses the same width. */
export const DECK_INLINE_MIN_WIDTH = 1240;

export type DeckChoice = Readonly<{
  /** The run the reader asked for, by its summary line in the chat. */
  picked: string | null;
  /** The latest run in this chat with results to show. */
  offered: string | null;
  closed: boolean;
  /** Whether the deck sits beside the chat rather than over it. */
  inline: boolean;
}>;

export function deckTarget({ picked, offered, closed, inline }: DeckChoice): string | null {
  if (picked !== null) return picked;
  return closed || !inline ? null : offered;
}

/** What the deck's heading says about a run. */
export type DeckStatus = Readonly<{ label: string; detail?: string; tone: "working" | "waiting" | "done" | "warning" | "failed" | "neutral" }>;

export function finishedDeckStatus(outcome: string, verified: boolean, warnings: boolean): DeckStatus {
  switch (outcome) {
    case "completed":
      if (warnings) return { label: "Done, with warnings", tone: "warning" };
      return verified ? { label: "Done", detail: "Applied and verified in Studio", tone: "done" } : { label: "Done", tone: "done" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "cancelled":
      return { label: "Stopped", tone: "neutral" };
    case "refused":
      return { label: "Refused", tone: "neutral" };
    default:
      return { label: "Finished", tone: "neutral" };
  }
}
