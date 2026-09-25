import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_SCHEMAS } from "../shared/mcp-tool-schemas";
import { approvalCode } from "./approval-code";

const text = (lines: NonNullable<ReturnType<typeof approvalCode>>["lines"]) =>
  lines.map((tokens) => tokens.map((token) => token.text).join("")).join("\n");

test("approval-code - execute_luau shows every line of its code, highlighted and unaltered", () => {
  const code = "local part = Instance.new(\"Part\")\r\n--[[ a\nlong comment ]]\npart.Parent = workspace";
  const shown = approvalCode("execute_luau", { code });
  assert.ok(shown);
  assert.equal(shown.label, "Luau code");
  assert.equal(text(shown.lines), code.replace(/\r\n/g, "\n"));
  assert.ok(shown.lines[0].some((token) => token.kind === "keyword" && token.text === "local"));
  // The long comment's second line is still a comment: lexer state carries across lines.
  assert.deepEqual(shown.lines[2].map((token) => token.kind), ["comment"]);
  assert.match(shown.subtitle, /in Studio/);
});

test("approval-code - a playtest peer is named in the subtitle", () => {
  assert.match(approvalCode("execute_luau", { code: "print(1)", target: "server" })!.subtitle, /server peer/);
  assert.match(approvalCode("execute_luau", { code: "print(1)", target: "edit" })!.subtitle, /in Studio/);
});

test("approval-code - a Blender script is shown as plain Python", () => {
  const shown = approvalCode("run_blender_script", { script: "import bpy\nlocal = 1" });
  assert.ok(shown);
  assert.equal(shown.label, "Blender script");
  assert.match(shown.subtitle, /Python in Blender/);
  assert.ok(shown.lines.flat().every((token) => token.kind === "plain"));
});

test("approval-code - other tools and malformed code fall back to the summary", () => {
  assert.equal(approvalCode("set_properties", { code: "print(1)" }), undefined);
  assert.equal(approvalCode("execute_luau", { code: 42 }), undefined);
  assert.equal(approvalCode("execute_luau", {}), undefined);
  assert.equal(approvalCode("toString", { code: "print(1)" }), undefined);
});

test("approval-code - every MCP tool that takes Luau code shows it when asking", () => {
  const codeTools = Object.entries(TOOL_SCHEMAS)
    .filter(([, schema]) => schema.parameters.some((parameter) => parameter.name === "code" && parameter.type === "string"))
    .map(([tool]) => tool);
  assert.ok(codeTools.includes("execute_luau"));
  for (const tool of codeTools) {
    assert.ok(approvalCode(tool, { code: "print(1)" }), `${tool} takes code but its approval would not show it`);
  }
});
