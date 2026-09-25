import assert from "node:assert/strict";
import test from "node:test";
import {
  isAnswerIndex, isEscapeAnswer, isRunQuestion, parseQuestionInput,
  MAX_OPTION_CHARS, MAX_QUESTION_CHARS, QUESTION_ESCAPE_OPTION,
} from "./question";

test("a model may not offer the host's own escape as one of its options", () => {
  assert.throws(
    () => parseQuestionInput({ question: "Which?", options: ["The shop", QUESTION_ESCAPE_OPTION] }),
    /offered by Roqer on every question already/,
  );
});

test("a well-formed question parses and trims", () => {
  const parsed = parseQuestionInput({
    question: "  Should the shop button open the shop or the inventory?  ",
    options: ["The shop", "  The inventory  "],
  });
  assert.equal(parsed.question, "Should the shop button open the shop or the inventory?");
  assert.deepEqual(parsed.options, ["The shop", "The inventory"]);
});

test("a question with fewer than two options is rejected", () => {
  assert.throws(
    () => parseQuestionInput({ question: "Proceed?", options: ["Yes"] }),
    /Offer 2-4 options/,
    "one option is an announcement, not a question",
  );
  assert.throws(() => parseQuestionInput({ question: "Proceed?", options: [] }), /Offer 2-4 options/);
});

test("more than four options is rejected", () => {
  assert.throws(
    () => parseQuestionInput({ question: "Which?", options: ["a", "b", "c", "d", "e"] }),
    /Offer 2-4 options/,
  );
});

test("options must be distinct, non-empty, and bounded", () => {
  assert.throws(() => parseQuestionInput({ question: "Which?", options: ["a", "a"] }), /repeats an earlier option/);
  assert.throws(() => parseQuestionInput({ question: "Which?", options: ["a", "  "] }), /must be a non-empty string/);
  assert.throws(
    () => parseQuestionInput({ question: "Which?", options: ["a", "b".repeat(MAX_OPTION_CHARS + 1)] }),
    /at most 80 characters/,
  );
});

test("the question itself is bounded and required", () => {
  assert.throws(() => parseQuestionInput({ options: ["a", "b"] }), /requires a `question` string/);
  assert.throws(() => parseQuestionInput({ question: "   ", options: ["a", "b"] }), /cannot be empty/);
  assert.throws(
    () => parseQuestionInput({ question: "q".repeat(MAX_QUESTION_CHARS + 1), options: ["a", "b"] }),
    /at most 300 characters/,
  );
  assert.throws(() => parseQuestionInput({ question: "Which?" }), /requires an `options` array/);
});

test("isRunQuestion validates what crosses the bridge", () => {
  assert.equal(isRunQuestion({ callId: "q1", question: "Which?", options: ["a", "b"] }), true);
  assert.equal(isRunQuestion({ callId: "", question: "Which?", options: ["a", "b"] }), false);
  assert.equal(isRunQuestion({ callId: "q1", question: "Which?", options: ["a"] }), false);
  assert.equal(isRunQuestion({ callId: "q1", question: "Which?", options: ["a", 2] }), false);
});

test("an answer index must address an option that was actually offered", () => {
  const options = ["The shop", "The inventory"];
  assert.equal(isAnswerIndex(0, options), true);
  assert.equal(isAnswerIndex(1, options), true);
  // One past the model's options is the host's own: "none of these".
  assert.equal(isAnswerIndex(2, options), true, "the escape");
  assert.equal(isEscapeAnswer(2, options), true);
  assert.equal(isEscapeAnswer(1, options), false);
  assert.equal(isAnswerIndex(3, options), false, "past the end");
  assert.equal(isAnswerIndex(-1, options), false);
  assert.equal(isAnswerIndex(0.5, options), false);
  assert.equal(isAnswerIndex("0", options), false, "a string index is not an index");
  assert.equal(isAnswerIndex(null, options), false);
});
