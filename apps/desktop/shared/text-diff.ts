/**
 * A line diff, so a change to a script can be shown rather than described.
 *
 * The conversation makes changed code a first-class artifact: the card shows
 * what actually landed in Studio. That means the diff has to be computed where
 * both versions are known — beside the write, in the main process — and travel
 * in the run event as text, so the renderer never needs a diff library and the
 * payload stays bounded.
 *
 * The format is the familiar unified one: a leading `+` for an added line, `-`
 * for a removed one, a space for context, and an `@@ … @@` marker where
 * unchanged lines were elided. That makes it readable as-is if it is ever
 * logged, and lets the renderer colour a line from its first character alone.
 */

/**
 * One newline convention, so a diff compares code rather than line endings.
 *
 * Studio and a model do not always agree on how a line ends: source read back
 * as CRLF and rewritten as LF is the same script, but every line of it compares
 * unequal, and the diff claims the whole file changed. Normalising both sides
 * is what keeps a one-line edit a one-line edit.
 */
export const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");

export type LineDiff = {
  /** Unified-style diff text. */
  text: string;
  addedLines: number;
  removedLines: number;
  /** True when the diff was cut short at `maxLines`. */
  truncated: boolean;
};

type Op = { kind: "context" | "add" | "remove"; text: string };

/** Unchanged lines kept either side of a change, for orientation. */
const CONTEXT_LINES = 3;

/**
 * Shortest run of unchanged lines worth folding away.
 *
 * A fold costs a line to render and a beat to read, so hiding four lines behind
 * one that says four lines are hidden is a loss. Below this length the two
 * hunks either side are joined instead and the code between them stays on
 * screen, which is what makes a diff read as a region of a file rather than as
 * a list of changed lines.
 */
const MIN_FOLDED_LINES = 6;

/** Default cap on emitted diff lines, so one event cannot carry a whole file. */
const DEFAULT_MAX_LINES = 240;

/**
 * Above this, the quadratic table stops being worth building. A script that
 * long is shown as source instead of as a diff, which is the honest fallback:
 * better no diff than a wrong one or a frozen interface.
 */
const MAX_INPUT_LINES = 1_200;

/**
 * Longest-common-subsequence diff. The table is filled from the end so the
 * walk forward produces changes in file order, which keeps additions and
 * removals adjacent the way a reader expects to see them.
 */
function diffOps(before: readonly string[], after: readonly string[]): Op[] {
  const rows = before.length;
  const columns = after.length;
  const width = columns + 1;
  const table = new Int32Array((rows + 1) * width);

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] = before[row] === after[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
  }

  const ops: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      ops.push({ kind: "context", text: before[row] });
      row += 1;
      column += 1;
    } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
      ops.push({ kind: "remove", text: before[row] });
      row += 1;
    } else {
      ops.push({ kind: "add", text: after[column] });
      column += 1;
    }
  }
  while (row < rows) {
    ops.push({ kind: "remove", text: before[row] });
    row += 1;
  }
  while (column < columns) {
    ops.push({ kind: "add", text: after[column] });
    column += 1;
  }
  return ops;
}

const MARKER: Readonly<Record<Op["kind"], string>> = {
  context: " ",
  add: "+",
  remove: "-",
};

const fold = (count: number): string =>
  `@@ ${count} unchanged ${count === 1 ? "line" : "lines"} @@`;

/**
 * A diff for a deletion whose range is already known.
 *
 * `diffText` refuses a file too long for its table, but a deletion of a named
 * range does not need one: the range says exactly which lines went, so the
 * lines around it are real context rather than a reconstruction. Without this
 * a long file would show a run of removals with nothing to place them in.
 *
 * `startIndex` and `endIndex` are inclusive zero-based line indices.
 */
export function diffDeletedRange(before: string, startIndex: number, endIndex: number): LineDiff | null {
  const lines = normalizeNewlines(before).split("\n");
  if (startIndex < 0 || endIndex < startIndex || endIndex >= lines.length) return null;

  const from = Math.max(0, startIndex - CONTEXT_LINES);
  const to = Math.min(lines.length, endIndex + 1 + CONTEXT_LINES);
  const rows: string[] = [];
  if (from > 0) rows.push(fold(from));
  for (const line of lines.slice(from, startIndex)) rows.push(` ${line}`);
  for (const line of lines.slice(startIndex, endIndex + 1)) rows.push(`-${line}`);
  for (const line of lines.slice(endIndex + 1, to)) rows.push(` ${line}`);
  if (to < lines.length) rows.push(fold(lines.length - to));

  return {
    text: rows.join("\n"),
    addedLines: 0,
    removedLines: endIndex - startIndex + 1,
    truncated: false,
  };
}

/**
 * Diff two versions of a file. Returns null when they are identical, or when
 * either side is too long to diff, so a caller can fall back to showing the
 * source itself.
 */
export function diffText(
  rawBefore: string,
  rawAfter: string,
  maxLines: number = DEFAULT_MAX_LINES,
): LineDiff | null {
  const before = normalizeNewlines(rawBefore);
  const after = normalizeNewlines(rawAfter);
  if (before === after) return null;

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length > MAX_INPUT_LINES || afterLines.length > MAX_INPUT_LINES) return null;

  const ops = diffOps(beforeLines, afterLines);
  const addedLines = ops.filter((op) => op.kind === "add").length;
  const removedLines = ops.filter((op) => op.kind === "remove").length;

  // A context line is worth showing only near a change; the rest are elided.
  const shown = ops.map(() => false);
  ops.forEach((op, index) => {
    if (op.kind === "context") return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    for (let cursor = from; cursor <= to; cursor += 1) shown[cursor] = true;
  });

  // Then join hunks that all but touch, so a short gap is shown rather than
  // announced. Only runs long enough to be worth hiding stay folded.
  for (let index = 0; index < shown.length;) {
    if (shown[index]) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < shown.length && !shown[end]) end += 1;
    if (end - index < MIN_FOLDED_LINES) {
      for (let cursor = index; cursor < end; cursor += 1) shown[cursor] = true;
    }
    index = end;
  }

  const lines: string[] = [];
  let elided = 0;
  let truncated = false;
  const flushElision = () => {
    if (elided === 0) return;
    lines.push(fold(elided));
    elided = 0;
  };

  for (let index = 0; index < ops.length; index += 1) {
    if (!shown[index]) {
      elided += 1;
      continue;
    }
    flushElision();
    if (lines.length >= maxLines) {
      lines.push("@@ diff truncated @@");
      truncated = true;
      break;
    }
    const op = ops[index];
    lines.push(`${MARKER[op.kind]}${op.text}`);
  }
  if (!truncated) flushElision();

  return { text: lines.join("\n"), addedLines, removedLines, truncated };
}

/**
 * Trim a source file down to something an event can carry. Returns the code
 * plus whether it was cut, so the card can say so rather than imply the script
 * ends where the card does.
 */
export function boundedCode(
  source: string,
  maxLines = 400,
  maxChars = 12_000,
): { code: string; truncated: boolean } {
  const lines = source.split("\n");
  let code = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : source;
  let truncated = code !== source;
  if (code.length > maxChars) {
    code = code.slice(0, maxChars);
    truncated = true;
  }
  return { code, truncated };
}
