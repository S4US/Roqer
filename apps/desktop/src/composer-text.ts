/**
 * What the composer holds, and what it sends.
 *
 * A long paste is folded into a block so the words the person typed stay
 * readable around it. The block only changes how the text is shown while it is
 * edited: the message that is sent is the blocks' text, in the order shown,
 * followed by what was typed, joined by blank lines. Nothing is summarised,
 * trimmed inside, or sent any other way.
 */

/** A paste this long is folded into a block. */
export const LONG_PASTE_CHARACTERS = 1_500;
export const LONG_PASTE_LINES = 30;

export type PastedBlock = Readonly<{ id: string; text: string }>;

export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split(/\r\n|\r|\n/).length;
}

/** Whether a paste is long enough to fold away. */
export function isLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_CHARACTERS || lineCount(text) >= LONG_PASTE_LINES;
}

/** The message a composer sends: every block in order, then what was typed. */
export function composedMessage(blocks: readonly PastedBlock[], typed: string): string {
  return [...blocks.map((block) => block.text.trim()), typed.trim()]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** "184 lines · 9,240 characters" */
export function textSize(text: string): string {
  const lines = lineCount(text);
  const characters = text.length;
  return `${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"} · ${characters.toLocaleString("en-US")} ${characters === 1 ? "character" : "characters"}`;
}

/** The first line with words on it, shortened, so a block says what it holds. */
export function blockPreview(text: string, max = 90): string {
  const first = text.split(/\r\n|\r|\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

/** "9.4k characters", for the toolbar once a message is long enough to matter. */
export function characterCount(characters: number): string {
  if (characters < 1_000) return `${characters} ${characters === 1 ? "character" : "characters"}`;
  return `${(Math.floor(characters / 100) / 10).toFixed(1).replace(/\.0$/, "")}k characters`;
}
