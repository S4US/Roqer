/**
 * Connection status for the local MCP bridge and the Roblox Studio instances
 * behind it. Produced in the main process from a real `/health` read and
 * rendered by the connection pill, so the interface never claims a connection
 * that was not observed.
 */

export type StudioStatusKind =
  /** The bridge answered and at least one Studio plugin is attached. */
  | "connected"
  /** The bridge answered but no Studio instance has connected to it. */
  | "bridge-only"
  /** The bridge did not answer. */
  | "offline"
  /** A check is in flight and nothing is known yet. */
  | "checking";

export type StudioInstanceSummary = {
  instanceId: string;
  role: string;
  placeName?: string;
  isRunning: boolean;
};

export type StudioStatus = {
  kind: StudioStatusKind;
  endpoint: string;
  placeName?: string;
  instanceCount?: number;
  serverVersion?: string;
  mode?: string;
  message: string;
  /** Instances available for targeting. The first is the default target. */
  instances?: StudioInstanceSummary[];
};

/** Result of a deliberate editor-presentation action requested by the user. */
export type StudioActionResult = { ok: boolean; message: string };

export type OpenStudioScriptRequest = {
  endpoint: string;
  target: string;
  instanceId: string | null;
};

export function isStudioActionResult(value: unknown): value is StudioActionResult {
  return typeof value === "object" && value !== null &&
    typeof (value as StudioActionResult).ok === "boolean" &&
    typeof (value as StudioActionResult).message === "string";
}

/** The instance a run should target, or null to let the server pick. */
export function defaultInstanceId(status: StudioStatus): string | null {
  return status.instances?.[0]?.instanceId ?? null;
}

/**
 * The place a run should go to, given what the user chose.
 *
 * A chosen place that is not connected falls back to the default rather than
 * failing the run: the choice is remembered across restarts, so it routinely
 * names a Studio window that is not open yet. The choice is kept either way —
 * reopening that place makes it the target again without the user re-picking.
 */
export function resolveInstanceId(status: StudioStatus, preferred: string | null): string | null {
  if (preferred === null) return defaultInstanceId(status);
  const connected = status.instances?.some((instance) => instance.instanceId === preferred) ?? false;
  return connected ? preferred : defaultInstanceId(status);
}

/** One connected Studio place, however many sessions it has behind it. */
export type ConnectedStudio = {
  instanceId: string;
  /** What to call it in the interface. Never empty. */
  name: string;
  /** True when any of its sessions is playtesting. */
  isRunning: boolean;
  /** `edit`, `server`, `client-1`… in the order they connected. */
  roles: readonly string[];
  /** Whether this is the one a run would go to right now. */
  isTarget: boolean;
};

/**
 * The connected places, one entry each.
 *
 * The bridge reports a session per plugin, so a single Studio running a
 * playtest arrives as three entries — `edit`, `server` and a client — under one
 * instance id. Showing those as three connections would misdescribe what is
 * open, so they are grouped, and the roles are kept because they are how a
 * playtest is distinguished from three separate windows.
 *
 * Order is the order the plugins connected, which is also how the target is
 * chosen when the user has not chosen one: the first wins. That is worth
 * showing rather than hiding, because a customer with two places open otherwise
 * has no way to know which one Roqer is about to edit.
 */
export function connectedStudios(
  status: StudioStatus,
  preferred: string | null = null,
): readonly ConnectedStudio[] {
  const target = resolveInstanceId(status, preferred);
  const byInstance = new Map<string, ConnectedStudio & { roles: string[] }>();

  for (const instance of status.instances ?? []) {
    const existing = byInstance.get(instance.instanceId);
    if (existing === undefined) {
      byInstance.set(instance.instanceId, {
        instanceId: instance.instanceId,
        name: instance.placeName?.trim() || "Untitled place",
        isRunning: instance.isRunning,
        roles: [instance.role],
        isTarget: instance.instanceId === target,
      });
      continue;
    }
    // A named session is worth more than an unnamed one, whichever arrived
    // first: an unsaved place reports no name from some of its sessions.
    if (existing.name === "Untitled place" && instance.placeName?.trim()) {
      existing.name = instance.placeName.trim();
    }
    existing.isRunning ||= instance.isRunning;
    if (!existing.roles.includes(instance.role)) existing.roles.push(instance.role);
  }

  return [...byInstance.values()];
}
