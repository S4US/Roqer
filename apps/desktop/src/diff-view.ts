import type { RunChange } from "../shared/run-events";

/**
 * The reader-side model of a diff.
 *
 * `shared/text-diff.ts` produces a unified diff beside the write, because only
 * the producer has both versions of the file. This module turns that text back
 * into rows a code surface can lay out: file coordinates for both sides, an
 * explicit marker, the span each fold hides, and Luau tokens for the code
 * itself. Nothing here touches the DOM, so the whole model is unit-testable.
 */

export type DiffRowKind = "context" | "add" | "remove" | "collapse" | "truncated";

/** The unchanged span a fold row stands in for, in file coordinates. */
export type HiddenSpan = {
  lines: number;
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
};

export type DiffRow = {
  kind: DiffRowKind;
  marker: " " | "+" | "-" | "";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** Present on a `collapse` row: what was folded away, and where it was. */
  hidden?: HiddenSpan;
};

export type SyntaxKind =
  | "plain" | "keyword" | "string" | "number" | "comment"
  | "call" | "builtin" | "property" | "operator";

export type SyntaxToken = { kind: SyntaxKind; text: string };

export type ChangeGroup = {
  target: string;
  changes: RunChange[];
};

const COLLAPSE = /^@@ (\d+) unchanged lines? @@$/;

/**
 * Add old/new line coordinates to the compact diff format produced beside a
 * Studio write. Fold markers advance both sides, so the visible numbers remain
 * file coordinates even when a long unchanged region is folded away.
 */
export function parseDiffRows(diff: string, oldStartLine = 1, newStartLine = 1): DiffRow[] {
  let oldLine = oldStartLine;
  let newLine = newStartLine;

  return diff.split("\n").map((line): DiffRow => {
    const collapse = line.match(COLLAPSE);
    if (collapse) {
      const count = Number(collapse[1]);
      const hidden: HiddenSpan = {
        lines: count,
        oldFrom: oldLine,
        oldTo: oldLine + count - 1,
        newFrom: newLine,
        newTo: newLine + count - 1,
      };
      oldLine += count;
      newLine += count;
      return {
        kind: "collapse",
        marker: "",
        text: `${count} unchanged ${count === 1 ? "line" : "lines"}`,
        oldLine: null,
        newLine: null,
        hidden,
      };
    }

    if (line === "@@ diff truncated @@") {
      return { kind: "truncated", marker: "", text: "Diff truncated", oldLine: null, newLine: null };
    }

    const marker = line.charAt(0);
    const text = line.slice(1);
    if (marker === "+") {
      const row = { kind: "add", marker: "+", text, oldLine: null, newLine } as const;
      newLine += 1;
      return row;
    }
    if (marker === "-") {
      const row = { kind: "remove", marker: "-", text, oldLine, newLine: null } as const;
      oldLine += 1;
      return row;
    }

    const row = { kind: "context", marker: " ", text: marker === " " ? text : line, oldLine, newLine } as const;
    oldLine += 1;
    newLine += 1;
    return row;
  });
}

/**
 * A change with nothing to diff against, on the same numbered code surface.
 *
 * `added` separates a file the run created — where every line really is new —
 * from source shown only because the previous version was never read. Marking
 * the second kind as additions would claim a change nobody observed, so those
 * lines are presented as the file, not as a diff of it.
 */
export function sourceRows(source: string, newStartLine = 1, added = true): DiffRow[] {
  return source.split("\n").map((text, index) => ({
    kind: added ? "add" : "context",
    marker: added ? "+" : " ",
    text,
    oldLine: null,
    newLine: newStartLine + index,
  }));
}

/* -- Luau highlighting ----------------------------------------------------- */

const LUA_KEYWORDS = new Set([
  "and", "break", "continue", "do", "else", "elseif", "end", "export", "false", "for",
  "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "self", "then",
  "true", "type", "until", "while",
]);

const LUA_BUILTINS = new Set([
  "assert", "bit32", "buffer", "coroutine", "debug", "Enum", "error", "game", "Instance",
  "ipairs", "math", "next", "os", "pairs", "pcall", "print", "require", "script", "select",
  "string", "table", "task", "tonumber", "tostring", "typeof", "utf8", "warn", "workspace", "xpcall",
]);

/** Two-character operators that mean something different than their halves. */
const LONG_OPERATORS = ["==", "~=", "<=", ">=", "..", "->", "::", "+=", "-=", "*=", "/=", "%=", "^=", "//"];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F_]/;
const DECIMAL = /[0-9_]/;
const OPERATOR = /[-+*/%^#=~<>(){}[\];:,.?|&]/;

/**
 * Whether the previous line ended inside a long bracket, and at which level.
 *
 * Luau's `[[ … ]]` strings and `--[[ … ]]` comments span lines, so a lexer that
 * forgets everything at each newline colours the inside of a block comment as
 * if it were code. The state is threaded per side of the diff, so a block the
 * edit opened on the new side does not bleed into the old one.
 */
export type LexState = { block: "string" | "comment"; level: number } | null;

/** Level of a long bracket opening at `index`, or null if none opens there. */
function longBracketLevel(line: string, index: number): number | null {
  if (line[index] !== "[") return null;
  let cursor = index + 1;
  while (line[cursor] === "=") cursor += 1;
  return line[cursor] === "[" ? cursor - index - 1 : null;
}

/** Index just past the matching close bracket, or -1 when it is on a later line. */
function closeLongBracket(line: string, from: number, level: number): number {
  const close = `]${"=".repeat(level)}]`;
  const at = line.indexOf(close, from);
  return at < 0 ? -1 : at + close.length;
}

const isLua = (language?: string): boolean => language === "lua" || language === "luau";

/**
 * Lex one line of Luau, continuing from the state the previous line left.
 *
 * A scanner rather than a set of regular expressions: a string containing `--`
 * is not a comment, a comment containing a quote is not a string, and only
 * position tells the two apart.
 */
export function lexCodeLine(
  line: string,
  language: string | undefined,
  state: LexState = null,
): { tokens: SyntaxToken[]; state: LexState } {
  if (!isLua(language)) return { tokens: [{ kind: "plain", text: line }], state: null };

  const tokens: SyntaxToken[] = [];
  const push = (kind: SyntaxKind, text: string) => {
    if (text.length > 0) tokens.push({ kind, text });
  };

  /** True directly after a `.` or `:`, where a name is a member, not a global. */
  let afterAccessor = false;
  let index = 0;

  if (state) {
    const kind = state.block === "comment" ? "comment" : "string";
    const end = closeLongBracket(line, 0, state.level);
    if (end < 0) {
      push(kind, line);
      return { tokens, state };
    }
    push(kind, line.slice(0, end));
    index = end;
  }

  while (index < line.length) {
    const char = line[index];

    if (char === " " || char === "\t") {
      let end = index;
      while (end < line.length && (line[end] === " " || line[end] === "\t")) end += 1;
      // Indentation is not a token, so it must not become the "previous" one.
      tokens.push({ kind: "plain", text: line.slice(index, end) });
      index = end;
      continue;
    }

    if (char === "-" && line[index + 1] === "-") {
      const level = longBracketLevel(line, index + 2);
      if (level === null) {
        push("comment", line.slice(index));
        index = line.length;
        afterAccessor = false;
        continue;
      }
      const end = closeLongBracket(line, index + level + 4, level);
      if (end < 0) {
        push("comment", line.slice(index));
        return { tokens, state: { block: "comment", level } };
      }
      push("comment", line.slice(index, end));
      index = end;
      afterAccessor = false;
      continue;
    }

    const openLevel = longBracketLevel(line, index);
    if (openLevel !== null) {
      const end = closeLongBracket(line, index + openLevel + 2, openLevel);
      if (end < 0) {
        push("string", line.slice(index));
        return { tokens, state: { block: "string", level: openLevel } };
      }
      push("string", line.slice(index, end));
      index = end;
      afterAccessor = false;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      let end = index + 1;
      while (end < line.length) {
        if (line[end] === "\\") {
          end += 2;
          continue;
        }
        if (line[end] === char) {
          end += 1;
          break;
        }
        end += 1;
      }
      end = Math.min(end, line.length);
      push("string", line.slice(index, end));
      index = end;
      afterAccessor = false;
      continue;
    }

    if (DIGIT.test(char) || (char === "." && DIGIT.test(line[index + 1] ?? ""))) {
      let end = index;
      if (char === "0" && (line[index + 1] === "x" || line[index + 1] === "X")) {
        end = index + 2;
        while (end < line.length && HEX.test(line[end])) end += 1;
      } else {
        while (end < line.length && DECIMAL.test(line[end])) end += 1;
        if (line[end] === ".") {
          end += 1;
          while (end < line.length && DECIMAL.test(line[end])) end += 1;
        }
        if (line[end] === "e" || line[end] === "E") {
          let cursor = end + 1;
          if (line[cursor] === "+" || line[cursor] === "-") cursor += 1;
          if (DIGIT.test(line[cursor] ?? "")) {
            end = cursor;
            while (end < line.length && DIGIT.test(line[end])) end += 1;
          }
        }
      }
      push("number", line.slice(index, end));
      index = end;
      afterAccessor = false;
      continue;
    }

    if (IDENT_START.test(char)) {
      let end = index;
      while (end < line.length && IDENT_PART.test(line[end])) end += 1;
      const word = line.slice(index, end);
      let after = end;
      while (line[after] === " " || line[after] === "\t") after += 1;
      const next = line[after];
      const called = next === "(" || next === "{" || next === "\"" || next === "'" || next === "`";
      push(
        LUA_KEYWORDS.has(word) ? "keyword"
          : called ? "call"
            : afterAccessor ? "property"
              : LUA_BUILTINS.has(word) ? "builtin"
                : "plain",
        word,
      );
      index = end;
      afterAccessor = false;
      continue;
    }

    if (OPERATOR.test(char)) {
      const three = line.slice(index, index + 3);
      const two = line.slice(index, index + 2);
      const text = three === "..." ? three : LONG_OPERATORS.includes(two) ? two : char;
      push("operator", text);
      index += text.length;
      afterAccessor = text === "." || text === ":";
      continue;
    }

    push("plain", char);
    index += 1;
    afterAccessor = false;
  }

  return { tokens: tokens.length > 0 ? tokens : [{ kind: "plain", text: line }], state: null };
}

/** Lex a single line with no carried state. Convenience over `lexCodeLine`. */
export function tokenizeCodeLine(line: string, language?: string): SyntaxToken[] {
  return lexCodeLine(line, language, null).tokens;
}

/**
 * Tokens for every row, in the order they are rendered.
 *
 * The old and new sides carry independent lexer state, since a row only exists
 * on one of them; a fold clears both, because the hidden lines could have
 * opened or closed a block the visible rows know nothing about.
 */
export function highlightRows(rows: readonly DiffRow[], language?: string): SyntaxToken[][] {
  let oldState: LexState = null;
  let newState: LexState = null;

  return rows.map((row) => {
    if (row.kind === "collapse" || row.kind === "truncated") {
      oldState = null;
      newState = null;
      return [];
    }
    if (row.kind === "remove") {
      const lexed = lexCodeLine(row.text, language, oldState);
      oldState = lexed.state;
      return lexed.tokens;
    }
    if (row.kind === "add") {
      const lexed = lexCodeLine(row.text, language, newState);
      newState = lexed.state;
      return lexed.tokens;
    }
    const lexed = lexCodeLine(row.text, language, newState);
    oldState = lexed.state;
    newState = lexed.state;
    return lexed.tokens;
  });
}

/* -- Change grouping ------------------------------------------------------- */

/**
 * The write a file's card leads with, and the ones folded in behind it.
 *
 * A run that writes one script five times — a draft, a correction, a debug
 * print, its removal — was rendering all five bodies stacked in one card. The
 * same file appeared several times over, which reads as the agent having
 * written it repeatedly for no reason, and the line counts were summed into
 * "+183 −93" against a 93-line script. The last write is the one that left the
 * file as it now stands, so it leads; the rest stay reachable, because a run's
 * intermediate steps are still a record of what it did.
 */
export function splitChangeGroup(group: ChangeGroup): { latest?: RunChange; earlier: RunChange[] } {
  return {
    latest: group.changes[group.changes.length - 1],
    earlier: group.changes.slice(0, -1),
  };
}

/** Preserve event order while giving every changed path one card. */
export function groupChangesByTarget(changes: readonly RunChange[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    const existing = groups.get(change.target);
    if (existing) existing.changes.push(change);
    else groups.set(change.target, { target: change.target, changes: [change] });
  }
  return [...groups.values()];
}
