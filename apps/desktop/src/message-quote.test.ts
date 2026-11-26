import assert from "node:assert/strict";
import test from "node:test";
import { messageParts, quotedText, quoteMarkdown, withQuotes, type ComposerQuote } from "./message-quote";

test("a selection becomes a Markdown quote with a blank line after it", () => {
  assert.equal(quoteMarkdown("Use a RemoteEvent."), "> Use a RemoteEvent.\n\n");
  assert.equal(quoteMarkdown("  first line\nsecond line  \n"), "> first line\n> second line\n\n");
});

test("blank lines stay inside the quote, folded to one, and Windows line ends are read", () => {
  assert.equal(quoteMarkdown("one\r\n\r\n\r\n\r\ntwo"), "> one\n>\n> two\n\n");
});

test("a selection of nothing but space quotes nothing", () => {
  assert.equal(quoteMarkdown("  \n \n"), "");
  assert.equal(quotedText("  \r\n \n"), "");
  assert.equal(quotedText("  one\r\n\r\n\r\n\r\ntwo \n"), "one\n\ntwo");
});

const quote = (text: string, reply = ""): ComposerQuote => ({ id: text, text, reply });

test("a message is sent as each quote with its reply under it, then what was typed", () => {
  assert.equal(withQuotes([], "  Just this.  "), "Just this.");
  assert.equal(withQuotes([quote("the part")], ""), "> the part");
  assert.equal(withQuotes([quote("the part", "  Why?  ")], ""), "> the part\n\nWhy?");
  assert.equal(
    withQuotes([quote("first part", "Why?"), quote("second\npart"), quote("third part", "Change this.")], "And do the rest."),
    "> first part\n\nWhy?\n\n> second\n> part\n\n> third part\n\nChange this.\n\nAnd do the rest.",
  );
});

test("a message sent with quotes reads back as those quotes and replies, in order", () => {
  const sent = withQuotes([quote("first part", "Why?"), quote("second part"), quote("third part", "Change this.")], "And do the rest.");
  assert.deepEqual(messageParts(sent), [
    { kind: "quote", text: "first part" },
    { kind: "text", text: "Why?" },
    { kind: "quote", text: "second part" },
    { kind: "quote", text: "third part" },
    { kind: "text", text: "Change this.\n\nAnd do the rest." },
  ]);
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
  assert.deepEqual(messageParts(withQuotes([{ id: "q", text: quotedText(selection), reply: "" }], "")), [{ kind: "quote", text: selection }]);
});

test("a greater-than sign inside a line is not a quote", () => {
  assert.deepEqual(messageParts("Make speed > 16 here."), [{ kind: "text", text: "Make speed > 16 here." }]);
});
