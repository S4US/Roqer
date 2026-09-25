/**
 * Regenerates `shared/mcp-tool-schemas.ts` from the MCP server's public tool
 * catalog.
 *
 * Roqer shows every provider one `roblox_studio` tool whose `operation`
 * names one of the server's tools, so the per-operation argument schemas the
 * server publishes never reach the model. Copying a condensed form of them
 * here is what lets Roqer describe an operation and explain a rejected
 * call. The desktop app does not depend on `packages/core` at runtime — the
 * boundary between them is the HTTP bridge — so the catalog is generated into
 * the repository rather than imported, and `shared/mcp-tool-schemas.test.ts`
 * fails when `definitions.ts` changes without a regeneration.
 *
 * Run: npm run generate:tool-schemas -w apps/desktop
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const definitionsPath = fileURLToPath(
  new URL("../../../packages/core/src/tools/definitions.ts", import.meta.url),
);
const outputPath = fileURLToPath(new URL("../shared/mcp-tool-schemas.ts", import.meta.url));

/** Server descriptions are one short sentence; this only guards a future long one. */
const MAX_DESCRIPTION_CHARS = 200;

/**
 * Hashed with newlines normalised so a CRLF checkout and an LF checkout agree.
 * Shared with the drift test, which recomputes it the same way.
 */
function digestOfDefinitions(source) {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function condense(value) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  return text.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
}

function typeOf(spec) {
  if (spec.type === "array") {
    const item = spec.items?.type;
    return typeof item === "string" ? `${item}[]` : "array";
  }
  return typeof spec.type === "string" ? spec.type : "unknown";
}

function parametersOf(schema) {
  const properties = schema && typeof schema === "object" ? schema.properties ?? {} : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, spec]) => {
    const parameter = { name, type: typeOf(spec), required: required.has(name) };
    if (Array.isArray(spec.enum) && spec.enum.every((value) => typeof value === "string")) {
      parameter.enumValues = spec.enum;
    }
    // Carried because the server enforces it: a required argument declared with
    // a minimum length rejects an empty value, which Roqer can answer
    // locally instead of spending a round trip on it.
    if (typeof spec.minLength === "number") parameter.minLength = spec.minLength;
    if (spec.default !== undefined) parameter.defaultValue = JSON.stringify(spec.default);
    const description = condense(spec.description);
    if (description !== undefined) parameter.description = description;
    return parameter;
  });
}

/**
 * Keep simple discriminated `oneOf` branches from the public schema.
 *
 * Roqer flattens each MCP tool behind one provider-facing envelope, so a
 * branch such as upload_asset's action=upload requirements would otherwise be
 * lost and every branch-only field would look optional to the model and the
 * local validator.
 */
function requirementsOf(schema) {
  if (!Array.isArray(schema?.oneOf)) return [];
  return schema.oneOf.flatMap((branch) => {
    if (!branch || typeof branch !== "object" || !Array.isArray(branch.required)) return [];
    const required = branch.required.filter((name) => typeof name === "string");
    const properties = branch.properties && typeof branch.properties === "object"
      ? branch.properties
      : {};
    const when = Object.entries(properties).flatMap(([name, spec]) => {
      if (!spec || typeof spec !== "object" || !Array.isArray(spec.enum) ||
        !spec.enum.every((value) => typeof value === "string")) return [];
      return [{ name, enumValues: spec.enum }];
    });
    return required.length > 0 && when.length > 0 ? [{ when, required }] : [];
  });
}

const literal = (value) => JSON.stringify(value);

function parameterLiteral(parameter) {
  const parts = [
    `name: ${literal(parameter.name)}`,
    `type: ${literal(parameter.type)}`,
    `required: ${parameter.required}`,
  ];
  if (parameter.enumValues) {
    parts.push(`enumValues: [${parameter.enumValues.map(literal).join(", ")}]`);
  }
  if (parameter.minLength !== undefined) parts.push(`minLength: ${parameter.minLength}`);
  if (parameter.defaultValue !== undefined) {
    parts.push(`defaultValue: ${literal(parameter.defaultValue)}`);
  }
  if (parameter.description !== undefined) {
    parts.push(`description: ${literal(parameter.description)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function requirementLiteral(requirement) {
  const when = requirement.when
    .map((condition) => `{ name: ${literal(condition.name)}, enumValues: [${condition.enumValues.map(literal).join(", ")}] }`)
    .join(", ");
  return `{ when: [${when}], required: [${requirement.required.map(literal).join(", ")}] }`;
}

const HEADER = `/**
 * The Roblox Studio MCP tool catalog, condensed to what a model needs to call
 * an operation correctly: its purpose, its arguments, their types, which are
 * required, and the values an enumerated argument accepts.
 *
 * GENERATED FILE — do not edit by hand. Run
 * \`npm run generate:tool-schemas -w apps/desktop\` after changing
 * \`packages/core/src/tools/definitions.ts\`;
 * \`shared/mcp-tool-schemas.test.ts\` fails while the two disagree.
 *
 * \`shared/mcp-tool-help.ts\` renders these into the signatures the tool
 * description carries and the schema Roqer replies with when a call's
 * arguments do not fit.
 */

export type ToolParameterSchema = {
  readonly name: string;
  /** JSON Schema type, with arrays rendered as e.g. \`string[]\`. */
  readonly type: string;
  readonly required: boolean;
  /** Present only for string enumerations, which are the ones worth showing. */
  readonly enumValues?: readonly string[];
  /** The server's declared minimum string length, when it declares one. */
  readonly minLength?: number;
  /** The server's default, as JSON text. */
  readonly defaultValue?: string;
  readonly description?: string;
};

export type ToolArgumentRequirement = {
  /** Conditions that select this JSON Schema branch. */
  readonly when: readonly {
    readonly name: string;
    readonly enumValues: readonly string[];
  }[];
  /** Arguments required by the selected branch. */
  readonly required: readonly string[];
};

export type ToolSchema = {
  readonly description: string;
  readonly parameters: readonly ToolParameterSchema[];
  readonly requirements?: readonly ToolArgumentRequirement[];
};
`;

const source = readFileSync(definitionsPath, "utf8");
const { TOOL_DEFINITIONS } = await import(pathToFileURL(definitionsPath).href);

const tools = [...TOOL_DEFINITIONS].sort((left, right) => left.name.localeCompare(right.name));

const lines = [HEADER];
lines.push(
  "/** sha256 of `packages/core/src/tools/definitions.ts` with LF newlines. */",
  `export const TOOL_DEFINITIONS_DIGEST = ${literal(digestOfDefinitions(source))};`,
  "",
  "export const TOOL_SCHEMAS: Readonly<Record<string, ToolSchema>> = {",
);

for (const tool of tools) {
  const parameters = parametersOf(tool.inputSchema);
  const requirements = requirementsOf(tool.inputSchema);
  lines.push(`  ${tool.name}: {`);
  lines.push(`    description: ${literal(condense(tool.description) ?? "")},`);
  if (parameters.length === 0) {
    lines.push("    parameters: [],");
  } else {
    lines.push("    parameters: [");
    for (const parameter of parameters) lines.push(`      ${parameterLiteral(parameter)},`);
    lines.push("    ],");
  }
  if (requirements.length > 0) {
    lines.push("    requirements: [");
    for (const requirement of requirements) {
      lines.push(`      ${requirementLiteral(requirement)},`);
    }
    lines.push("    ],");
  }
  lines.push("  },");
}

lines.push("};", "");

writeFileSync(outputPath, lines.join("\n"), "utf8");
console.log(`Wrote ${tools.length} tool schemas to ${outputPath}`);
