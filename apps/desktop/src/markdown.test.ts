import assert from "node:assert/strict";
import test from "node:test";

import { markdownToPlainText, parseInline, parseMarkdown, type MarkdownBlock } from "./markdown";

/** Renders a block tree back to a compact shape a test can read. */
function shape(blocks: MarkdownBlock[]): string[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "paragraph": return `p:${inline(block.children)}`;
      case "heading": return `h${block.level}`;
      case "code": return `code(${block.language ?? "-"}):${block.value}`;
      case "list": return `${block.ordered ? "ol" : "ul"}:${block.items.length}`;
      case "quote": return "quote";
      case "rule": return "hr";
    }
  });
}

function inline(nodes: ReturnType<typeof parseInline>): string {
  return nodes.map((node) => node.type === "text" || node.type === "code"
    ? node.value
    : inline(node.children)).join("");
}

test("inline code keeps its content and drops the backticks", () => {
  const nodes = parseInline("Read `game.ServerScriptService.Main` before writing.");
  assert.deepEqual(nodes, [
    { type: "text", value: "Read " },
    { type: "code", value: "game.ServerScriptService.Main" },
    { type: "text", value: " before writing." },
  ]);
});

test("snake_case identifiers are never read as emphasis", () => {
  const nodes = parseInline("Called get_script_source and set_script_source on _Main_.");
  assert.deepEqual(nodes, [{ type: "text", value: "Called get_script_source and set_script_source on _Main_." }]);
});

test("bold and italic nest and survive punctuation", () => {
  assert.deepEqual(parseInline("**Done** and *verified*."), [
    { type: "strong", children: [{ type: "text", value: "Done" }] },
    { type: "text", value: " and " },
    { type: "emphasis", children: [{ type: "text", value: "verified" }] },
    { type: "text", value: "." },
  ]);
});

test("an asterisk used as arithmetic is left alone", () => {
  assert.deepEqual(parseInline("speed * 2 stays literal"), [
    { type: "text", value: "speed * 2 stays literal" },
  ]);
});

test("an unmatched backtick is not a code span", () => {
  assert.deepEqual(parseInline("a ` b"), [{ type: "text", value: "a ` b" }]);
});

test("a double-backtick span may contain a backtick", () => {
  assert.deepEqual(parseInline("``a ` b``"), [{ type: "code", value: "a ` b" }]);
});

test("links keep their label and only safe schemes keep a target", () => {
  assert.deepEqual(parseInline("[docs](https://create.roblox.com)"), [
    { type: "link", href: "https://create.roblox.com", children: [{ type: "text", value: "docs" }] },
  ]);
  assert.deepEqual(parseInline("[click](javascript:void)"), [{ type: "text", value: "click" }]);
});

test("an image becomes its description, since the conversation cannot show it", () => {
  assert.deepEqual(parseInline("See ![the layout](https://example.com/a.png) here"), [
    { type: "text", value: "See " },
    { type: "text", value: "the layout" },
    { type: "text", value: " here" },
  ]);
});

test("a nested list is flattened to one level rather than dropped", () => {
  const blocks = parseMarkdown("- one\n  - sub\n- two");
  assert.deepEqual(shape(blocks), ["ul:3"]);
});

test("a table is left as written rather than half-rendered", () => {
  const blocks = parseMarkdown("| Script | Lines |\n| --- | --- |\n| Main | 12 |");
  assert.deepEqual(shape(blocks), ["p:| Script | Lines |\n| --- | --- |\n| Main | 12 |"]);
});

test("a fenced block keeps every line and its language", () => {
  const blocks = parseMarkdown("Here:\n\n```lua\nlocal x = 1\n\nprint(x)\n```\n\nDone.");
  assert.deepEqual(shape(blocks), [
    "p:Here:",
    "code(lua):local x = 1\n\nprint(x)",
    "p:Done.",
  ]);
});

test("a fence that is still streaming renders what has arrived", () => {
  const blocks = parseMarkdown("```lua\nlocal x = 1");
  assert.deepEqual(shape(blocks), ["code(lua):local x = 1"]);
});

test("markers inside a fenced block are not parsed as prose", () => {
  const blocks = parseMarkdown("```\n# not a heading\n- not a list\n`not code`\n```");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    type: "code",
    language: null,
    value: "# not a heading\n- not a list\n`not code`",
  });
});

test("headings, lists, quotes, and rules become their own blocks", () => {
  const blocks = parseMarkdown([
    "## What changed",
    "",
    "- Rewrote `Main`",
    "- Left `Util` alone",
    "",
    "1. First",
    "2. Second",
    "",
    "> A caveat.",
    "",
    "---",
  ].join("\n"));
  assert.deepEqual(shape(blocks), ["h2", "ul:2", "ol:2", "quote", "hr"]);
});

test("a wrapped bullet stays one item", () => {
  const blocks = parseMarkdown("- A long point\n  that wrapped\n- A second point");
  assert.deepEqual(shape(blocks), ["ul:2"]);
});

test("blank lines separate paragraphs and single newlines stay inside one", () => {
  const blocks = parseMarkdown("First line.\nSecond line.\n\nA new paragraph.");
  assert.deepEqual(shape(blocks), ["p:First line.\nSecond line.", "p:A new paragraph."]);
});

test("a run-together seam is still two sentences, not a merged word", () => {
  // What the fixed stream assembly produces; the reader must keep them apart.
  const blocks = parseMarkdown("I updated the script in Studio.\n\nThere's one caveat.");
  assert.deepEqual(shape(blocks), ["p:I updated the script in Studio.", "p:There's one caveat."]);
});

test("empty input produces no blocks", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
});

test("markdownToPlainText strips markers for labels and tooltips", () => {
  assert.equal(
    markdownToPlainText("**Updated** `Main`\n\n- one\n- two"),
    "Updated Main\n\none\ntwo",
  );
});
