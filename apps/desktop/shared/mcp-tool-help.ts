import {
  TOOL_SCHEMAS,
  type ToolArgumentRequirement,
  type ToolParameterSchema,
  type ToolSchema,
} from "./mcp-tool-schemas";

/**
 * Renders the generated tool catalog into the two things a model needs.
 *
 * Roqer exposes every Studio tool through one `roblox_studio` operation
 * envelope whose `arguments` object is unconstrained, which is what keeps the
 * provider-facing surface at two tools. The cost of that envelope is that the
 * server's per-operation schemas never reach the model, so an operation the
 * tool description does not spell out gets called by guesswork. These renderers
 * pay the cost back: a one-line signature for the operations worth documenting
 * up front, and the full argument schema on the way back from a call whose
 * arguments did not fit.
 */

/** A long enumeration explains itself poorly in a signature; the hint has room. */
const MAX_SIGNATURE_ENUM_VALUES = 6;
const MAX_HINT_ENUM_VALUES = 16;
const MAX_HINT_PARAMETERS = 16;

/**
 * An own-property lookup, mirroring `isKnownTool`: an operation named
 * "constructor" or "toString" must not resolve to something off
 * `Object.prototype` and be treated as a known schema.
 */
export function toolSchema(operation: string): ToolSchema | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, operation)
    ? TOOL_SCHEMAS[operation]
    : undefined;
}

/**
 * The one argument the model is never shown, and never asked to supply.
 *
 * A run is bound to one Studio instance when the user sends the prompt, and the
 * run engine addresses every Studio call at it. Documenting `instance_id` only
 * invites a model to copy an opaque id out of a tool result — which it can
 * copy wrongly, and which the engine overwrites in any case.
 *
 * `manage_instance` is excepted, because choosing between Studio processes is
 * what that operation is for: it closes or reports on a named instance, and it
 * takes a `launch_id` for one that has not finished connecting.
 */
const ROUTED_BY_ROQER = "instance_id";

function documentedParameters(operation: string, schema: ToolSchema): readonly ToolParameterSchema[] {
  return operation === "manage_instance"
    ? schema.parameters
    : schema.parameters.filter((parameter) => parameter.name !== ROUTED_BY_ROQER);
}

function renderEnum(values: readonly string[], limit: number): string {
  const shown = values.slice(0, limit).map((value) => `'${value}'`).join("|");
  return values.length > limit ? `${shown}|…` : shown;
}

function renderType(parameter: ToolParameterSchema, enumLimit: number): string {
  return parameter.enumValues !== undefined && parameter.enumValues.length > 0
    ? renderEnum(parameter.enumValues, enumLimit)
    : parameter.type;
}

function conditionText(
  condition: ToolArgumentRequirement["when"][number],
): string {
  return `${condition.name}=${renderEnum(condition.enumValues, MAX_HINT_ENUM_VALUES)}`;
}

function requiredBeyondCondition(
  requirement: ToolArgumentRequirement,
): readonly string[] {
  const discriminants = new Set(requirement.when.map((condition) => condition.name));
  return requirement.required.filter((name) => !discriminants.has(name));
}

function requirementText(
  requirement: ToolArgumentRequirement,
): string {
  const condition = requirement.when.map(conditionText).join(" and ");
  const required = requiredBeyondCondition(requirement);
  return `${condition} requires ${required.join(", ")}`;
}

/**
 * One line an agent can call from: `solo_playtest {action: 'start'|'stop'|'status',
 * mode?: 'play'|'run', …}`. Optional arguments carry the `?` TypeScript users
 * already read that way.
 */
export function toolSignature(operation: string): string | undefined {
  const schema = toolSchema(operation);
  if (schema === undefined) return undefined;
  const parameters = documentedParameters(operation, schema)
    .map((parameter) => `${parameter.name}${parameter.required ? "" : "?"}: ${renderType(parameter, MAX_SIGNATURE_ENUM_VALUES)}`)
    .join(", ");
  const signature = `${operation} {${parameters}}`;
  const requirements = schema.requirements ?? [];
  return requirements.length === 0
    ? signature
    : `${signature} (${requirements.map(requirementText).join("; ")})`;
}

function renderDetail(parameter: ToolParameterSchema): string {
  const facts = [
    parameter.required ? "required" : "optional",
    renderType(parameter, MAX_HINT_ENUM_VALUES),
  ];
  if (parameter.minLength !== undefined && parameter.minLength > 0) facts.push("non-empty");
  if (parameter.defaultValue !== undefined) facts.push(`default ${parameter.defaultValue}`);
  const description = parameter.description === undefined ? "" : ` ${parameter.description}`;
  return `- ${parameter.name} (${facts.join(", ")})${description}`;
}

/**
 * The whole schema for one operation, as text to hand back to a model that
 * called it wrongly. Discriminated `oneOf` requirements are rendered directly;
 * requirements expressed only in prose — such as playtest mode for start —
 * stay in the parameter descriptions.
 */
export function toolSchemaHint(operation: string): string | undefined {
  const schema = toolSchema(operation);
  if (schema === undefined) return undefined;
  const documented = documentedParameters(operation, schema);
  const shown = documented.slice(0, MAX_HINT_PARAMETERS);
  const remaining = documented.length - shown.length;
  return [
    `Schema for ${toolSignature(operation)}`,
    schema.description,
    ...(schema.requirements ?? []).map((requirement) => `- when ${requirementText(requirement)}`),
    ...(shown.length === 0 ? ["- takes no arguments"] : shown.map(renderDetail)),
    ...(remaining > 0 ? [`- …and ${remaining} more optional arguments`] : []),
  ].join("\n");
}

/** Why an argument cannot be sent as it stands. */
export type ArgumentProblem =
  | Readonly<{ name: string; reason: "missing" | "empty" }>
  /** `expected` is the declared type (`number`, `object[]`); `received` says what came instead. */
  | Readonly<{ name: string; reason: "type"; expected: string; received: string }>;

/** The JavaScript shape a declared type needs, or nothing for a string or an unknown type. */
function declaredShape(type: string): "number" | "boolean" | "array" | "object" | undefined {
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type.endsWith("[]") || type === "array") return "array";
  if (type === "object") return "object";
  return undefined;
}

function hasShape(value: unknown, shape: NonNullable<ReturnType<typeof declaredShape>>): boolean {
  switch (shape) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/** A plain decimal number, the only text read as one: not "", "0x10", "Infinity" or "1,5". */
const NUMBER_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function restoredValue(value: string, shape: NonNullable<ReturnType<typeof declaredShape>>): unknown {
  const trimmed = value.trim();
  switch (shape) {
    case "number":
      return NUMBER_TEXT.test(trimmed) ? Number(trimmed) : value;
    case "boolean":
      return trimmed === "true" ? true : trimmed === "false" ? false : value;
    case "array":
    case "object": {
      if (!trimmed.startsWith(shape === "array" ? "[" : "{")) return value;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return hasShape(parsed, shape) ? parsed : value;
      } catch {
        return value;
      }
    }
  }
}

/**
 * The arguments a model sent, with values it wrote as text restored to the
 * type the operation declares.
 *
 * The `roblox_studio` envelope leaves `arguments` unconstrained, so no
 * operation's argument types reach the provider, and some models then write
 * values as strings: `maxDepth: "3"`, `operations: "[{…}]"`. The bridge route
 * Roqer calls checks no schema, so such a value reached Studio as text: a
 * depth compared against a number crashed a plugin handler, and a build's steps
 * arrived as one string and were refused sixteen times while the model
 * insisted it had sent an array.
 *
 * Only a string that reads unambiguously as the declared type is converted: a
 * JSON array for an array, a JSON object for an object, a plain decimal for a
 * number, `true` or `false` for a boolean. Anything else is left as sent, for
 * `argumentTypeProblems` and the server to judge. An argument declared a
 * string is never touched, so paths and script source pass through byte for
 * byte, and a model that sends proper JSON values sees no difference at all.
 */
export function restoreArgumentTypes(operation: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = toolSchema(operation);
  if (schema === undefined) return args;
  let restored: Record<string, unknown> | undefined;
  for (const parameter of schema.parameters) {
    if (!Object.prototype.hasOwnProperty.call(args, parameter.name)) continue;
    const value = args[parameter.name];
    const shape = declaredShape(parameter.type);
    if (shape === undefined || typeof value !== "string") continue;
    const converted = restoredValue(value, shape);
    if (converted === value) continue;
    restored ??= { ...args };
    restored[parameter.name] = converted;
  }
  return restored ?? args;
}

function describeReceived(value: unknown, shape: NonNullable<ReturnType<typeof declaredShape>>): string {
  if (typeof value === "string") {
    return shape === "array" || shape === "object"
      ? `text that is not a JSON ${shape}; send the ${shape} itself, not a string`
      : "text";
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return Number.isFinite(value) ? "a number" : "a non-finite number";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Arguments supplied with a type the operation does not declare, after
 * `restoreArgumentTypes` has had its chance. A value of the wrong type is one
 * the plugin was never written to receive, so the call is answered here with
 * the rule it broke rather than with whatever the handler does with it.
 * Strings, unknown types, and unknown operations are left to the server.
 */
export function argumentTypeProblems(operation: string, args: Record<string, unknown>): ArgumentProblem[] {
  const schema = toolSchema(operation);
  if (schema === undefined) return [];
  const problems: ArgumentProblem[] = [];
  for (const parameter of schema.parameters) {
    if (!Object.prototype.hasOwnProperty.call(args, parameter.name)) continue;
    const value = args[parameter.name];
    const shape = declaredShape(parameter.type);
    if (shape === undefined || value === undefined || value === null || hasShape(value, shape)) continue;
    problems.push({ name: parameter.name, reason: "type", expected: parameter.type, received: describeReceived(value, shape) });
  }
  return problems;
}

/**
 * Required arguments the call cannot be sent with, in the order the server
 * declares them.
 *
 * Two rejections are checked, and only two, because they are the ones this
 * table can be sure the server will make: an argument a top-level or selected
 * `oneOf` branch names and the call omits, and an empty string for an argument
 * the server declares with a minimum length. Everything subtler — an invalid
 * enum value or a path that does not exist — stays the server's call, so a Roqer
 * that is a version behind never refuses a call the server would have accepted.
 * An unknown operation is left alone for the same reason.
 *
 * Emptiness is judged by the declared `minLength` rather than by falsiness:
 * `set_script_source {source: ""}` clears a script and `edit_script_lines
 * {new_string: ""}` deletes text, so an empty string is a legitimate value
 * wherever the server has not said otherwise.
 */
export function requiredArgumentProblems(
  operation: string,
  args: Record<string, unknown>,
): ArgumentProblem[] {
  const schema = toolSchema(operation);
  if (schema === undefined) return [];
  const selectedRequirements = (schema.requirements ?? []).filter((requirement) =>
    requirement.when.every((condition) => {
      const supplied = Object.prototype.hasOwnProperty.call(args, condition.name)
        ? args[condition.name]
        : undefined;
      const parameter = schema.parameters.find((candidate) => candidate.name === condition.name);
      let value = supplied;
      if (value === undefined && parameter?.defaultValue !== undefined) {
        try {
          value = JSON.parse(parameter.defaultValue) as unknown;
        } catch {
          // Generated defaults are JSON, but an invalid future default should
          // leave branch selection to the server rather than refusing a call.
        }
      }
      return typeof value === "string" && condition.enumValues.includes(value);
    }),
  );
  const conditionallyRequired = new Set(
    selectedRequirements.flatMap((requirement) => requirement.required),
  );
  const problems: ArgumentProblem[] = [];
  for (const parameter of schema.parameters) {
    if (!parameter.required && !conditionallyRequired.has(parameter.name)) continue;
    const value = Object.prototype.hasOwnProperty.call(args, parameter.name)
      ? args[parameter.name]
      : undefined;
    if (value === undefined || value === null) {
      problems.push({ name: parameter.name, reason: "missing" });
      continue;
    }
    const minLength = parameter.minLength ?? 0;
    if (minLength > 0 && typeof value === "string" && value.length < minLength) {
      problems.push({ name: parameter.name, reason: "empty" });
    }
  }
  return problems;
}

/**
 * Whether a failure reads like the model got the arguments wrong rather than
 * Studio being unreachable, a script being missing, or a revision conflict.
 * Only those failures are worth spending a schema on; attaching one to every
 * error would bury the actual message.
 */
export function looksLikeArgumentError(message: string): boolean {
  return /\b(require[sd]?|missing|invalid|unknown|unsupported|expected|must be|not a valid|no such (argument|parameter|field)|malformed)\b/i
    .test(message);
}
