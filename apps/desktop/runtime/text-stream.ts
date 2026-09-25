/**
 * Assembles streamed assistant prose without losing the seams between chunks.
 *
 * A provider streams a reply as deltas inside a content block, blocks inside a
 * message, and — around every tool call — several messages inside one turn.
 * Only the deltas within a single block are guaranteed to concatenate into
 * readable text: no provider sends the break *between* two blocks or two
 * messages, because each one is its own document. Appending them end to end
 * therefore runs the last sentence of one into the first word of the next
 * ("…is wired up in Studio.There's one caveat", "…verified it.Done").
 *
 * `beginSegment` marks each of those boundaries. The stream then emits exactly
 * the newlines the seam is missing, and never trims, collapses, or rewrites a
 * chunk, so every space and newline the model actually sent survives.
 */

/** Newlines already present at the end of what has been emitted. */
function trailingNewlines(value: string): number {
  return value.length - value.replace(/\n+$/, "").length;
}

/** Newlines the next chunk already starts with. */
function leadingNewlines(value: string): number {
  return value.length - value.replace(/^\n+/, "").length;
}

export type ProseStream = {
  /**
   * Declare that the next chunk starts a new message or content block. Emits
   * nothing on its own, so a segment that never produces text costs nothing.
   */
  beginSegment(): void;
  /** Append one chunk verbatim. */
  push(text: string): void;
  /** Everything emitted so far, separators included. */
  text(): string;
  /** True once any non-whitespace prose has been emitted. */
  hasText(): boolean;
};

export function createProseStream(emit: (text: string) => void): ProseStream {
  let assembled = "";
  let awaitingSeam = false;

  const write = (text: string) => {
    assembled += text;
    emit(text);
  };

  return {
    beginSegment() {
      awaitingSeam = true;
    },
    push(text) {
      if (text === "") return;
      if (awaitingSeam) {
        awaitingSeam = false;
        // Nothing to join to before the first chunk of the reply.
        if (assembled !== "") {
          const missing = 2 - trailingNewlines(assembled) - leadingNewlines(text);
          if (missing > 0) write("\n".repeat(missing));
        }
      }
      write(text);
    },
    text() {
      return assembled;
    },
    hasText() {
      return assembled.trim() !== "";
    },
  };
}
