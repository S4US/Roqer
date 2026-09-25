/**
 * The harness's own audit of a task's interface, taken after the agent stops.
 *
 * A UI task is scored on what Studio measures, not on whether the agent ran an
 * audit or reported it honestly: the harness starts a playtest itself, audits
 * the task's ScreenGui with `inspect_ui`, and always stops the playtest again.
 */

import type { McpToolCaller } from "../runtime/mcp-types";

export type InterfaceAuditIssue = Readonly<{ code: string; path: string }>;

export type InterfaceAudit = Readonly<{
  /** False when the harness could not get a clean reading; `error` says why. */
  ran: boolean;
  error?: string;
  /** How many of the interface's elements the audit saw. */
  elements: number;
  issues: readonly InterfaceAuditIssue[];
}>;

export type InterfaceAuditOptions = Readonly<{
  pollMs?: number;
  clientTimeoutMs?: number;
  guiTimeoutMs?: number;
}>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const MAX_ISSUES = 40;

async function clientRole(caller: McpToolCaller, instanceId: string | null): Promise<string | undefined> {
  const outcome = await caller.callTool("get_connected_instances", {});
  const places = Array.isArray(record(outcome.data).instances) ? record(outcome.data).instances as unknown[] : [];
  for (const place of places.map(record)) {
    if (instanceId !== null && place.id !== instanceId && place.instanceId !== instanceId) continue;
    const roles = Array.isArray(place.roles) ? place.roles : [];
    const role = roles.find((entry): entry is string => typeof entry === "string" && /^client-\d+$/.test(entry));
    if (role !== undefined) return role;
  }
  return undefined;
}

/** Audits the ScreenGui named `guiName` as a player sees it. Never throws; a failed reading is `ran: false`. */
export async function auditInterface(
  caller: McpToolCaller,
  instanceId: string | null,
  guiName: string,
  options: InterfaceAuditOptions = {},
): Promise<InterfaceAudit> {
  const pollMs = options.pollMs ?? 500;
  const place = instanceId === null ? {} : { instance_id: instanceId };
  const wait = () => new Promise((resolve) => setTimeout(resolve, pollMs));
  const failed = (error: string): InterfaceAudit => ({ ran: false, error, elements: 0, issues: [] });

  // A playtest the agent left running would be audited in whatever state it reached.
  await caller.callTool("solo_playtest", { action: "stop", ...place });
  try {
    const started = await caller.callTool("solo_playtest", { action: "start", mode: "play", ...place }, { timeoutMs: 60_000 });
    if (!started.ok) return failed(`The harness could not start a playtest: ${started.message ?? started.text}`);

    let target: string | undefined;
    for (const deadline = Date.now() + (options.clientTimeoutMs ?? 30_000); target === undefined && Date.now() < deadline; await wait()) {
      target = await clientRole(caller, instanceId);
    }
    if (target === undefined) return failed("No playtest client connected.");

    // The ScreenGui reaches PlayerGui a moment after the client does.
    const inGui = (path: unknown) => typeof path === "string" && path.split(".").includes(guiName);
    for (const deadline = Date.now() + (options.guiTimeoutMs ?? 10_000); Date.now() < deadline; await wait()) {
      const outcome = await caller.callTool("inspect_ui", { mode: "audit", target, max_depth: 30, max_nodes: 800, ...place }, { timeoutMs: 30_000 });
      const data = record(outcome.data);
      const elements = (Array.isArray(data.elements) ? data.elements : []).map(record).filter((element) => inGui(element.path));
      if (!outcome.ok || elements.length === 0) continue;
      const audit = record(data.audit);
      if (audit.success !== true) return failed("The audit could not read the live interface.");
      const issues = (Array.isArray(audit.issues) ? audit.issues : []).map(record)
        .filter((issue) => inGui(issue.path))
        .map((issue) => ({ code: String(issue.code ?? "issue"), path: String(issue.path) }));
      return { ran: true, elements: elements.length, issues: issues.slice(0, MAX_ISSUES) };
    }
    return failed(`${guiName} never appeared in the playtest client's PlayerGui.`);
  } finally {
    await caller.callTool("solo_playtest", { action: "stop", ...place });
  }
}
