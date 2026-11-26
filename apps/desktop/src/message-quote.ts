/**
 * Text picked out of a reply, as a Markdown quote ready to answer under: each
 * line behind "> ", blank lines kept as ">", runs of blank lines folded to one,
 * and a blank line after it so the reply starts on a line of its own.
 */
export function quoteMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().split("\n");
  if (lines.length === 1 && lines[0].trim() === "") return "";
  return `${lines.map((line) => line.trim() === "" ? ">" : `> ${line.trimEnd()}`).join("\n")}\n\n`;
}

/**
 * A passage quoted in the message being written, and what is said in answer
 * to that passage alone. A message can hold several, each with its own reply.
 */
export type ComposerQuote = Readonly<{ id: string; text: string; reply: string }>;

/** The most quotes one message holds. */
export const MAX_COMPOSER_QUOTES = 12;

/** A selection as a quote keeps it: line ends made plain, runs of blank lines folded to one, no space around it. */
export function quotedText(selection: string): string {
  return selection.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The message as it is sent: each quote as a Markdown quote with its reply
 * under it, in the order they were picked, then what was typed in the box.
 */
export function withQuotes(quotes: readonly ComposerQuote[], message: string): string {
  const quoted = quotes.map((quote) => {
    const reply = quote.reply.trim();
    return `${quoteMarkdown(quote.text)}${reply === "" ? "" : `${reply}\n\n`}`;
  }).join("");
  return `${quoted}${message.trim()}`.trimEnd();
}

/** A sent message's text in order: quoted passages (without their "> ") and the words around them. */
export type MessagePart = Readonly<{ kind: "quote" | "text"; text: string }>;

/**
 * Splits a message into its quoted passages and its own words, so a quote
 * reads as a quote once sent. Only whole lines starting with ">" count; a
 * message without one is a single text part.
 */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let kind: MessagePart["kind"] | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (kind === null) return;
    const joined = lines.join("\n");
    const body = kind === "quote" ? joined.trim() : joined.replace(/^\n+|\n+$/g, "");
    if (body !== "") parts.push({ kind, text: body });
    kind = null;
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const quoted = /^\s{0,3}>/.test(line);
    const next = quoted ? "quote" : "text";
    // A blank line right after a quote belongs to neither; it only separates.
    if (kind !== next) flush();
    kind = next;
    lines.push(quoted ? line.replace(/^\s{0,3}> ?/, "") : line);
  }
  flush();
  return parts;
}
