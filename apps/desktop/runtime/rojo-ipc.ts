import type { RojoPickOutcome, RojoResult } from "../shared/rojo";
import type { RojoConnection } from "./rojo-connection";

/**
 * The Rojo IPC handlers' decisions, with Electron stripped out.
 *
 * `electron/main.ts` extracts the two things only it can produce --
 * `isTrusted(event.sender)` and the main process's own dialog or
 * `shell.openPath` call -- and everything else (refusal messages, whether the
 * named instance is one the latest Studio status actually lists, the recent
 * index's shape, the picked file's extension) lives here, where it is tested
 * without starting Electron. Every exported function takes `trusted` as a
 * plain boolean rather than an `IpcMainInvokeEvent`, which is what makes "an
 * untrusted sender is refused" a one-line test instead of something only an
 * Electron smoke test can see.
 */

/** Whether `instanceId` is one the latest Studio status lists -- also used by `rojo:choose` before it opens the main process's dialog. */
export function isKnownInstance(instanceId: string, connectedIds: readonly string[]): boolean {
  return connectedIds.includes(instanceId);
}

/** `rojo:get`: `instanceId === null` is allowed and means "no place". */
export async function rojoGet(
  trusted: boolean,
  instanceIdValue: unknown,
  connectedIds: readonly string[],
  connection: RojoConnection,
): Promise<RojoResult> {
  if (!trusted) return { ok: false, message: "This window may not read the Rojo link." };
  if (instanceIdValue !== null && (typeof instanceIdValue !== "string" || !isKnownInstance(instanceIdValue, connectedIds))) {
    return { ok: false, message: "That place is not connected." };
  }
  const instanceId = instanceIdValue as string | null;
  return { ok: true, view: await connection.view(instanceId, connectedIds) };
}

type KnownInstanceAction = (instanceId: string) => Promise<RojoResult>;

async function withKnownInstance(
  trusted: boolean,
  instanceIdValue: unknown,
  connectedIds: readonly string[],
  refusal: string,
  action: KnownInstanceAction,
): Promise<RojoResult> {
  if (!trusted) return { ok: false, message: refusal };
  if (typeof instanceIdValue !== "string" || !isKnownInstance(instanceIdValue, connectedIds)) {
    return { ok: false, message: "That place is not connected." };
  }
  return action(instanceIdValue);
}

export function rojoUnlink(
  trusted: boolean, instanceIdValue: unknown, connectedIds: readonly string[], connection: RojoConnection,
): Promise<RojoResult> {
  return withKnownInstance(trusted, instanceIdValue, connectedIds, "This window may not unlink a Rojo project.", (id) => connection.unlink(id));
}

export function rojoForget(
  trusted: boolean, instanceIdValue: unknown, connectedIds: readonly string[], connection: RojoConnection,
): Promise<RojoResult> {
  return withKnownInstance(trusted, instanceIdValue, connectedIds, "This window may not forget a Rojo link.", (id) => connection.forget(id));
}

export function rojoRetry(
  trusted: boolean, instanceIdValue: unknown, connectedIds: readonly string[], connection: RojoConnection,
): Promise<RojoResult> {
  return withKnownInstance(trusted, instanceIdValue, connectedIds, "This window may not retry a Rojo link.", (id) => connection.retry(id));
}

/** `rojo:open-folder`: `openPath` is `shell.openPath`, injected so this stays Electron-free; it resolves to an error string, or empty on success. */
export function rojoOpenFolder(
  trusted: boolean,
  instanceIdValue: unknown,
  connectedIds: readonly string[],
  connection: RojoConnection,
  openPath: (folder: string) => Promise<string>,
): Promise<RojoResult> {
  return withKnownInstance(trusted, instanceIdValue, connectedIds, "This window may not open that folder.", async (id) => {
    const view = () => connection.view(id, connectedIds);
    const folder = connection.projectFolderFor(id);
    if (folder === undefined) return { ok: false, message: "There is no linked project folder to open.", view: await view() };
    const error = await openPath(folder);
    if (error) return { ok: false, message: error, view: await view() };
    return { ok: true, view: await view() };
  });
}

/** `rojo:link-recent`'s payload is `{ instanceId, index }`; the index's upper bound is `RojoConnection.linkRecent`'s to enforce. */
export function rojoLinkRecent(
  trusted: boolean,
  payload: unknown,
  connectedIds: readonly string[],
  connection: RojoConnection,
): Promise<RojoResult> {
  if (!trusted) return Promise.resolve({ ok: false, message: "This window may not link a Rojo project." });
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return Promise.resolve({ ok: false, message: "The request was not valid." });
  }
  const { instanceId, index } = payload as Record<string, unknown>;
  if (typeof instanceId !== "string" || !isKnownInstance(instanceId, connectedIds)) {
    return Promise.resolve({ ok: false, message: "That place is not connected." });
  }
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return Promise.resolve({ ok: false, message: "That recent project is no longer available." });
  }
  return connection.linkRecent(instanceId, index);
}

export function isRojoProjectFile(filePath: string): boolean {
  return filePath.endsWith(".project.json");
}

/**
 * What the main process's own `dialog.showOpenDialog` returned, resolved into
 * a link attempt (or a plain cancellation). Shared by the `rojo:choose` IPC
 * handler and, later, the agent's link operation -- both open the same
 * dialog and must refuse the same bad extension the same way.
 */
export async function resolvePickedProject(
  picked: Readonly<{ canceled: boolean; filePaths: readonly string[] }>,
  instanceId: string,
  connection: RojoConnection,
): Promise<RojoPickOutcome> {
  if (picked.canceled || picked.filePaths.length === 0) return { cancelled: true };
  const projectFile = picked.filePaths[0];
  if (!isRojoProjectFile(projectFile)) return { ok: false, message: "Choose a *.project.json file." };
  return connection.link(instanceId, projectFile);
}
