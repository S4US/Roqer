/**
 * The "inspect this project and explain how it works" planner.
 *
 * This planner is entirely read-only: every tool it proposes has risk
 * `"read"` (see `shared/mcp-tools.ts`), so it behaves identically in every
 * approval mode and is safe to run unattended. It never assumes a payload's
 * shape — every field coming back from a tool call is `unknown` until a local
 * type guard says otherwise, because the MCP server is a separate process
 * that this planner does not control.
 */

import type { Planner, PlannerContext } from "./run-engine";
import { compactValue } from "./result-summary";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

type ScriptEntry = { path: string; scriptType: string };
type ServiceEntry = { name: string; path: string; hasChildren: boolean };

const MAX_STRUCTURE_LINES = 12;
const MAX_SOURCE_LINES = 20;
/** Bounds how many structure calls one inspection makes. */
const MAX_SERVICES_WALKED = 5;

/**
 * Services worth walking for scripts, most likely first. `get_project_structure`
 * with no path returns a service overview rather than a tree, so scripts are
 * only reachable by asking for each service's subtree by path.
 */
const SCRIPT_SERVICES = [
  "ServerScriptService",
  "ReplicatedStorage",
  "StarterPlayer",
  "ServerStorage",
  "StarterGui",
  "Workspace",
];

function collectServices(data: unknown): ServiceEntry[] {
  if (!isRecord(data) || !Array.isArray(data.services)) return [];
  const entries: ServiceEntry[] = [];
  for (const service of data.services) {
    if (!isRecord(service)) continue;
    if (!isNonEmptyString(service.name) || !isNonEmptyString(service.path)) continue;
    entries.push({
      name: service.name,
      path: service.path,
      hasChildren: service.hasChildren === true,
    });
  }
  return entries;
}

/**
 * Walk a `get_project_structure` subtree looking for script nodes, which the
 * plugin marks with `hasSource: true`. The `services` branch is a defensive
 * fallback for an overview payload arriving where a tree was expected.
 */
function collectScripts(node: unknown, out: ScriptEntry[], limit: number): void {
  if (out.length >= limit || !isRecord(node)) return;

  if (node.hasSource === true && isNonEmptyString(node.path)) {
    const scriptType = isNonEmptyString(node.scriptType)
      ? node.scriptType
      : isNonEmptyString(node.className)
        ? node.className
        : "Script";
    out.push({ path: node.path, scriptType });
  }

  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (out.length >= limit) return;
      collectScripts(child, out, limit);
    }
  }

  const services = node.services;
  if (Array.isArray(services)) {
    for (const service of services) {
      if (out.length >= limit) return;
      collectScripts(service, out, limit);
    }
  }
}

/**
 * A crude but deterministic guess at a script name mentioned in the prompt:
 * the first identifier with a camelCase/PascalCase "hump" (a lowercase or
 * digit immediately followed by an uppercase letter), at least four
 * characters long. Real script names are almost always written this way
 * ("PlayerController", "shopHandler"); a plain capitalized English word
 * (just an initial capital, no internal hump) is not.
 */
function extractScriptNameHint(prompt: string): string | null {
  const words = prompt.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  for (const word of words) {
    if (word.length < 4) continue;
    if (/[a-z0-9][A-Z]/.test(word)) return word;
  }
  return null;
}

function firstSearchResultPath(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const results = data.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  return isRecord(first) && isNonEmptyString(first.path) ? first.path : null;
}

function extractRevision(data: UnknownRecord): string | undefined {
  if (isNonEmptyString(data.sourceRevision)) return data.sourceRevision;
  if (isNonEmptyString(data.revision)) return data.revision;
  return undefined;
}

/**
 * Inspect the connected place and answer.
 *
 * The planner writes to two separate layers. Process — which service it is
 * walking, what came back oddly — goes to `context.status`, which the interface
 * shows in its collapsible Activity section. `context.say` is called exactly
 * once, at the end of whichever path the run takes, and carries only the answer
 * a reader wants: no step-by-step recounting of a timeline they can already
 * expand, and no paths or fingerprints the cards already carry.
 */
async function runInspection(context: PlannerContext): Promise<string> {
  // Things the answer has to admit to, gathered as the run goes.
  const caveats: string[] = [];

  const connected = await context.call("get_connected_instances", {});
  if (!connected.ok) {
    context.say(
      "I couldn't reach a connected Roblox Studio instance, so I wasn't able to inspect the project. " +
        "Make sure Studio is open with the Roqer plugin running and try again.",
    );
    return "Inspection could not start: no connected Studio instance.";
  }

  const placeInfo = await context.call("get_place_info", {});
  let placeLabel = "the project";
  if (placeInfo.ok && isRecord(placeInfo.data)) {
    const placeName = isNonEmptyString(placeInfo.data.placeName) ? placeInfo.data.placeName : undefined;
    const dataModelName = isNonEmptyString(placeInfo.data.dataModelName)
      ? placeInfo.data.dataModelName
      : undefined;
    placeLabel = placeName ?? dataModelName ?? placeLabel;
  } else {
    context.status("Studio did not report a place name", "Describing the place generically.");
  }

  const overview = await context.call("get_project_structure", {});

  const scripts: ScriptEntry[] = [];
  const walked: string[] = [];
  if (!overview.ok) {
    context.status("Could not read the project structure", overview.message ?? "unknown error");
    caveats.push("I couldn't read the project structure, so this may be incomplete.");
  } else {
    const services = collectServices(overview.data)
      .filter((service) => service.hasChildren && SCRIPT_SERVICES.includes(service.name))
      .sort((a, b) => SCRIPT_SERVICES.indexOf(a.name) - SCRIPT_SERVICES.indexOf(b.name))
      .slice(0, MAX_SERVICES_WALKED);

    for (const service of services) {
      if (scripts.length >= MAX_STRUCTURE_LINES) break;
      const subtree = await context.call("get_project_structure", {
        path: service.path,
        scriptsOnly: true,
        maxDepth: 4,
      });
      if (!subtree.ok) continue;
      walked.push(service.name);
      collectScripts(subtree.data, scripts, MAX_STRUCTURE_LINES);
    }

    let lines: string[];
    if (scripts.length > 0) {
      lines = scripts.map((entry) => `${entry.scriptType}: ${entry.path}`);
    } else if (walked.length > 0) {
      lines = [`No scripts were found in ${walked.join(", ")}.`];
    } else if (services.length === 0 && isRecord(overview.data)) {
      lines = ["Studio reported no script-bearing services in this place."];
    } else {
      lines = [`Unexpected project structure payload: ${compactValue(overview.data)}`];
    }
    context.recordEvidence({ kind: "inspection", title: placeLabel, lines });
  }

  let scriptPath: string | null = null;
  const hint = extractScriptNameHint(context.prompt);
  if (hint) {
    const search = await context.call("search_objects", { query: hint, searchType: "name" });
    if (search.ok) {
      scriptPath = firstSearchResultPath(search.data);
    }
  }
  if (!scriptPath && scripts.length > 0) {
    scriptPath = scripts[0].path;
  }

  if (scriptPath) {
    const source = await context.call("get_script_source", { instancePath: scriptPath });
    if (source.ok && isRecord(source.data)) {
      const revision = extractRevision(source.data);
      const sourceText = isString(source.data.source) ? source.data.source : "";
      const lines = sourceText.length > 0 ? sourceText.split("\n").slice(0, MAX_SOURCE_LINES) : [];
      context.recordEvidence({
        kind: "verification",
        title: scriptPath,
        passed: true,
        detail: revision
          ? "Read from Studio, with the source revision recorded."
          : "Read from Studio, but the server did not report a source revision.",
        lines,
        format: "code",
        metadata: revision ? [{ label: "Source revision", value: revision }] : undefined,
      });
    } else {
      context.status("Could not read a script's source", scriptPath);
      caveats.push("One script's source could not be read, so I haven't described what it does.");
      scriptPath = null;
    }
  }

  const scriptWord = scripts.length === 1 ? "script" : "scripts";
  // The walk stops at MAX_STRUCTURE_LINES, so a full result is a floor, not a total.
  const countLabel = scripts.length >= MAX_STRUCTURE_LINES
    ? `at least ${scripts.length} ${scriptWord}`
    : `${scripts.length} ${scriptWord}`;
  const where = walked.length > 0 ? ` in ${walked.join(", ")}` : "";
  // One sentence of answer, then anything it has to qualify. The script that
  // was read, its path, and its source are already on their own cards.
  context.say([`${placeLabel} has ${countLabel}${where}.`, ...caveats].join(" "));

  return scriptPath
    ? `Inspected ${placeLabel}: ${countLabel} found, read ${scriptPath}.`
    : `Inspected ${placeLabel}: ${countLabel} found.`;
}

export function createInspectionPlanner(): Planner {
  return {
    id: "inspection",
    run: runInspection,
  };
}
