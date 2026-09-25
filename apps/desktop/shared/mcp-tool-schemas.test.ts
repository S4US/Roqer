import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS_DIGEST, TOOL_SCHEMAS } from "./mcp-tool-schemas";
import { TOOL_RISK } from "./mcp-tools";

const __dirname = dirname(fileURLToPath(import.meta.url));

const definitionsSource = () =>
  readFileSync(join(__dirname, "../../../packages/core/src/tools/definitions.ts"), "utf-8");

/**
 * The generated catalog is a copy of data that lives in another package, so the
 * only thing that keeps it honest is a gate that fails the moment the original
 * moves. Newlines are normalised so a CRLF checkout and an LF checkout agree,
 * exactly as the generator does it.
 */
test("mcp-tool-schemas - the generated catalog is current with definitions.ts", () => {
  const digest = createHash("sha256")
    .update(definitionsSource().replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");

  assert.strictEqual(
    digest,
    TOOL_DEFINITIONS_DIGEST,
    "packages/core/src/tools/definitions.ts has changed since shared/mcp-tool-schemas.ts was generated. "
      + "Run: npm run generate:tool-schemas -w apps/desktop",
  );
});

test("mcp-tool-schemas - every tool Roqer can call has a schema", () => {
  const missing = Object.keys(TOOL_RISK).filter(
    (tool) => !Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, tool),
  );

  assert.deepStrictEqual(missing, [], `Tools in TOOL_RISK with no schema: ${missing.join(", ")}`);
});

test("mcp-tool-schemas - the catalog carries no tool Roqer cannot call", () => {
  const stale = Object.keys(TOOL_SCHEMAS).filter(
    (tool) => !Object.prototype.hasOwnProperty.call(TOOL_RISK, tool),
  );

  assert.deepStrictEqual(stale, [], `Schemas with no TOOL_RISK entry: ${stale.join(", ")}`);
});

test("mcp-tool-schemas - required arguments and enumerations survive generation", () => {
  const playtest = TOOL_SCHEMAS.solo_playtest;
  const action = playtest.parameters.find((parameter) => parameter.name === "action");

  assert.ok(action, "solo_playtest must document its action argument");
  assert.strictEqual(action.required, true);
  assert.deepStrictEqual(action.enumValues, ["start", "stop", "status"]);
  // The conditional requirement the JSON Schema cannot express is carried by
  // the argument description, which is why descriptions are generated at all.
  const mode = playtest.parameters.find((parameter) => parameter.name === "mode");
  assert.ok(mode?.description?.includes("start"));
});

test("mcp-tool-schemas - discriminated requirements survive generation", () => {
  assert.deepStrictEqual(TOOL_SCHEMAS.upload_asset.requirements, [
    {
      when: [{ name: "action", enumValues: ["upload"] }],
      required: ["filePath", "assetType", "displayName"],
    },
    {
      when: [{ name: "action", enumValues: ["status"] }],
      required: ["action", "operationId"],
    },
  ]);
});
