import { LINK_ROJO_PROJECT_OPERATION } from "../shared/gateway-operations";
import type { RojoPickOutcome } from "../shared/rojo";
import type { McpToolOutcome } from "./mcp-types";

/**
 * `link_rojo_project`: the agent's only way to link a place to Rojo.
 *
 * It never carries a path -- `pickProject` is `electron/main.ts`'s own
 * `pickRojoProject`, the same function the Rojo pill's "Change project…"
 * button calls, already bound to the window the run's chat lives in. This
 * function stays Electron-free so it is tested without starting one; the
 * main process supplies `pickProject` and the run's resolved instance, the
 * same way it resolves the run's Studio for `capture_moments`.
 */
export type ProjectPicker = (instanceId: string) => Promise<RojoPickOutcome>;

export async function linkRojoProject(instanceId: string | null, pickProject: ProjectPicker): Promise<McpToolOutcome> {
  const started = Date.now();
  const result = (ok: boolean, text: string, data?: unknown): McpToolOutcome =>
    ({ ok, data, text, httpStatus: 200, durationMs: Date.now() - started });

  if (instanceId === null) {
    return result(
      false,
      `${LINK_ROJO_PROJECT_OPERATION} was not run: no place is connected. Ask the user to open and connect a place in Roblox Studio first.`,
    );
  }

  const picked = await pickProject(instanceId);
  if ("cancelled" in picked) {
    return result(true, "The user closed the project picker without choosing a file.", { cancelled: true });
  }
  if (!picked.ok) return result(false, picked.message);

  const project = picked.view.project;
  const serving = picked.view.server?.answering
    ? ` Rojo is serving it on port ${picked.view.server.port}.`
    : " Rojo is not running yet; the link takes effect once it is.";
  const text = project === undefined
    ? "Linked the chosen Rojo project."
    : `Linked ${project.fileName} (${project.folder}).${serving}`;
  return result(true, text, { view: picked.view });
}
