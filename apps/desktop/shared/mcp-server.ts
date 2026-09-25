/**
 * What the desktop knows about the local MCP bridge process.
 *
 * Roqer owns that process: without a bridge there is nothing to drive Studio
 * with, so the app starts one rather than asking the user to run a command.
 * The one case it does not own is `adopted` — a bridge was already listening,
 * usually a developer's own `npx robloxstudio-mcp`, and taking it over would
 * kill their session for no reason.
 */
export type McpServerState =
  /** No bridge yet: either not started, or deliberately stopped. */
  | Readonly<{ kind: "stopped" }>
  /** Launching, or waiting for a launched bridge to answer. */
  | Readonly<{ kind: "starting" }>
  /**
   * A bridge Roqer started and supervises.
   *
   * `pluginUpdated` is set when this launch replaced the Studio plugin on disk,
   * which happens after an app update because the plugin ships inside the app.
   * Studio loads plugins once at startup, so a session that is already open
   * keeps running the old copy until the user restarts it — and nothing else in
   * the product would tell them that.
   *
   * `pluginProblem` is set when the install did not happen. Without it the only
   * symptom is Studio never connecting, which sends the user looking at Studio
   * rather than at the plugin that was never put in place.
   */
  | Readonly<{ kind: "running"; endpoint: string; pluginUpdated?: true; pluginProblem?: string }>
  /**
   * A bridge someone else started, which Roqer uses but does not manage.
   *
   * Roqer still installs the Studio plugin in this case. It used to leave the
   * whole startup alone, which meant a developer's own bridge — or any process
   * holding the port — left the app with no plugin and no explanation.
   */
  | Readonly<{ kind: "adopted"; endpoint: string; pluginUpdated?: true; pluginProblem?: string }>
  /**
   * No usable bridge, and retrying stopped. `message` is written for the
   * person reading it, and `detail` carries the last lines the process wrote
   * so a support conversation has something concrete in it.
   */
  | Readonly<{ kind: "failed"; message: string; detail?: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isMcpServerState(value: unknown): value is McpServerState {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "stopped":
    case "starting":
      return true;
    case "running":
    case "adopted":
      return typeof value.endpoint === "string" && value.endpoint.length > 0 &&
        (value.pluginUpdated === undefined || value.pluginUpdated === true) &&
        (value.pluginProblem === undefined || typeof value.pluginProblem === "string");
    case "failed":
      return typeof value.message === "string" &&
        (value.detail === undefined || typeof value.detail === "string");
    default:
      return false;
  }
}

/** One line for the interface, whatever the state. */
export function mcpServerMessage(state: McpServerState): string {
  switch (state.kind) {
    case "stopped":
      return "The Studio bridge is not running.";
    case "starting":
      return "Starting the Studio bridge…";
    case "running":
      return "The Studio bridge is running.";
    case "adopted":
      return "Using a Studio bridge that was already running.";
    case "failed":
      return state.message;
  }
}
