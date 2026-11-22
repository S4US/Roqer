import assert from "node:assert/strict";
import test from "node:test";
import { messageParts, quoteMarkdown, withQuote } from "./message-quote";

test("a selection becomes a Markdown quote with a blank line after it", () => {
  assert.equal(quoteMarkdown("Use a RemoteEvent."), "> Use a RemoteEvent.\n\n");
  assert.equal(quoteMarkdown("  first line\nsecond line  \n"), "> first line\n> second line\n\n");
});

test("blank lines stay inside the quote, folded to one, and Windows line ends are read", () => {
  assert.equal(quoteMarkdown("one\r\n\r\n\r\n\r\ntwo"), "> one\n>\n> two\n\n");
});

test("a selection of nothing but space quotes nothing", () => {
  assert.equal(quoteMarkdown("  \n \n"), "");
  assert.equal(withQuote("draft", ""), "draft");
});

test("a quote goes at the end of the draft, a blank line apart", () => {
  const quote = quoteMarkdown("the part");
  assert.equal(withQuote("", quote), "> the part\n\n");
  assert.equal(withQuote("   \n", quote), "> the part\n\n");
  assert.equal(withQuote("What about", quote), "What about\n\n> the part\n\n");
  assert.equal(withQuote("> earlier\n\n", quote), "> earlier\n\n> the part\n\n");
});

test("a sent message is split into its quotes and its own words", () => {
  assert.deepEqual(messageParts("Just words.\nTwo lines."), [{ kind: "text", text: "Just words.\nTwo lines." }]);
  assert.deepEqual(messageParts("> the part\n>\n> more\n\nWhy that order?"), [
    { kind: "quote", text: "the part\n\nmore" },
    { kind: "text", text: "Why that order?" },
  ]);
  assert.deepEqual(messageParts("About this:\n\n> one\n\n> two\n\nAnd this."), [
    { kind: "text", text: "About this:" },
    { kind: "quote", text: "one" },
    { kind: "quote", text: "two" },
    { kind: "text", text: "And this." },
  ]);
});

test("a quote made from a selection reads back as the selection", () => {
  const selection = "first line\n\nsecond line";
  assert.deepEqual(messageParts(withQuote("", quoteMarkdown(selection))), [{ kind: "quote", text: selection }]);
});

test("a greater-than sign inside a line is not a quote", () => {
  assert.deepEqual(messageParts("Make speed > 16 here."), [{ kind: "text", text: "Make speed > 16 here." }]);
});
