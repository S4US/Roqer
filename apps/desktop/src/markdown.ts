/**
 * A small Markdown reader for assistant prose.
 *
 * The models write GitHub-flavoured Markdown, and showing it raw leaks the
 * markers — backticks around every instance path, asterisks around every
 * emphasis — into what is meant to read as an answer. This turns the text into
 * a node tree that `Markdown.tsx` renders as real elements, so nothing is ever
 * built as an HTML string and there is no path from model output to markup.
 *
 * It is deliberately a subset. Two Roblox-specific departures from CommonMark:
 *
 *  - `_` never starts emphasis. Studio identifiers are snake_case
 *    (`get_script_source`, `Humanoid_Root`), and treating those underscores as
 *    emphasis mangles far more text than the feature is worth. `*` and `**`
 *    remain, guarded by the usual non-space rule.
 *  - Soft line breaks inside a paragraph are kept rather than folded into
 *    spaces, because a line the model chose to break is nearly always a list or
 *    a set of paths it wanted on separate lines.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "emphasis"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };

export type MarkdownBlock =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: number; children: InlineNode[] }
  | { type: "code"; language: string | null; value: string }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "quote"; children: InlineNode[] }
  | { type: "rule" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BLANK = /^\s*$/;

/** Schemes a link may carry. Anything else is shown as plain text. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

const ESCAPABLE = "\\`*_[]()#+-.!>~";

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (BLANK.test(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, language] = fence;
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end: a reply is often rendered while
      // its closing fence is still streaming in.
      while (index < lines.length && !isClosingFence(lines[index], marker)) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: language === "" ? null : language, value: body.join("\n") });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index]);
        if (!quoted) break;
        body.push(quoted[1]);
        index += 1;
      }
      blocks.push({ type: "quote", children: parseInline(body.join("\n")) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const match = ordered ? ORDERED.exec(current) : BULLET.exec(current);
        if (match) {
          items.push(match[2]);
          index += 1;
          continue;
        }
        // An indented, non-blank line that starts no new item continues the one
        // above it, so a wrapped bullet stays one bullet.
        if (items.length > 0 && !BLANK.test(current) && /^\s+\S/.test(current) &&
          !BULLET.test(current) && !ORDERED.test(current)) {
          items[items.length - 1] += `\n${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (BLANK.test(current) || FENCE.test(current) || HEADING.test(current) ||
        RULE.test(current) || QUOTE.test(current) ||
        BULLET.test(current) || ORDERED.test(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/** A run of the opening character, at least as long as the opening fence. */
function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length &&
    trimmed.split("").every((character) => character === marker[0]);
}

/** Length of the run of `character` starting at `start`. */
function runLength(source: string, start: number, character: string): number {
  let end = start;
  while (end < source.length && source[end] === character) end += 1;
  return end - start;
}

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let pending = "";
  let index = 0;

  const flush = () => {
    if (pending !== "") {
      nodes.push({ type: "text", value: pending });
      pending = "";
    }
  };

  while (index < source.length) {
    const character = source[index];

    if (character === "\\" && index + 1 < source.length && ESCAPABLE.includes(source[index + 1])) {
      pending += source[index + 1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const open = runLength(source, index, "`");
      const close = findClosingRun(source, index + open, "`", open);
      if (close !== -1) {
        flush();
        nodes.push({ type: "code", value: trimCodeSpan(source.slice(index + open, close)) });
        index = close + open;
        continue;
      }
    }

    // An image is a description of something the conversation does not show, so
    // the description is what is kept.
    if (character === "!" && source[index + 1] === "[") {
      const image = readLink(source, index + 1);
      if (image) {
        flush();
        nodes.push({ type: "text", value: inlineToText([image.node]) });
        index = image.end;
        continue;
      }
    }

    if (character === "[") {
      const link = readLink(source, index);
      if (link) {
        flush();
        nodes.push(link.node);
        index = link.end;
        continue;
      }
    }

    if (character === "*") {
      const open = Math.min(2, runLength(source, index, "*"));
      const emphasis = readEmphasis(source, index, open);
      if (emphasis) {
        flush();
        nodes.push(emphasis.node);
        index = emphasis.end;
        continue;
      }
    }

    pending += character;
    index += 1;
  }

  flush();
  return nodes;
}

/** Index of the next run of exactly `length` backticks, or -1. */
function findClosingRun(source: string, from: number, character: string, length: number): number {
  let index = from;
  while (index < source.length) {
    if (source[index] !== character) {
      index += 1;
      continue;
    }
    const run = runLength(source, index, character);
    if (run === length) return index;
    index += run;
  }
  return -1;
}

/** CommonMark strips one space from each end when both are present. */
function trimCodeSpan(value: string): string {
  const flattened = value.replace(/\n/g, " ");
  if (flattened.length > 2 && flattened.startsWith(" ") && flattened.endsWith(" ") && flattened.trim() !== "") {
    return flattened.slice(1, -1);
  }
  return flattened;
}

function readLink(source: string, start: number): { node: InlineNode; end: number } | null {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") { index += 2; continue; }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }
  if (depth !== 0 || source[index + 1] !== "(") return null;

  const label = source.slice(start + 1, index);
  const close = source.indexOf(")", index + 2);
  if (close === -1) return null;

  const href = source.slice(index + 2, close).trim().split(/\s+/)[0];
  const children = parseInline(label);
  // An unrecognised scheme is not a link. Showing the label as prose is
  // truthful; turning it into a target the reader cannot inspect is not.
  if (!SAFE_SCHEME.test(href)) {
    return { node: { type: "text", value: label }, end: close + 1 };
  }
  return { node: { type: "link", href, children }, end: close + 1 };
}

function readEmphasis(source: string, start: number, length: number): { node: InlineNode; end: number } | null {
  // "2 * 3" and a trailing "*" are arithmetic and punctuation, not emphasis.
  if (/[\s*]|^$/.test(source[start + length] ?? "")) return null;

  let index = start + length;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === "`") {
      const run = runLength(source, index, "`");
      const close = findClosingRun(source, index + run, "`", run);
      index = close === -1 ? index + run : close + run;
      continue;
    }
    if (source[index] === "*") {
      const run = runLength(source, index, "*");
      if (run >= length && !/\s/.test(source[index - 1])) {
        return {
          node: {
            type: length === 2 ? "strong" : "emphasis",
            children: parseInline(source.slice(start + length, index)),
          },
          end: index + length,
        };
      }
      index += run;
      continue;
    }
    index += 1;
  }
  return null;
}

/** Flattens inline nodes back to their text, markers removed. */
export function inlineToText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
      case "code": return node.value;
      case "strong":
      case "emphasis":
      case "link": return inlineToText(node.children);
    }
  }).join("");
}

/** Flattens a document to plain text, for titles and accessible labels. */
export function markdownToPlainText(source: string): string {
  return parseMarkdown(source).map((block) => {
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "quote": return inlineToText(block.children);
      case "code": return block.value;
      case "list": return block.items.map(inlineToText).join("\n");
      case "rule": return "";
    }
  }).filter((part) => part !== "").join("\n\n");
}
