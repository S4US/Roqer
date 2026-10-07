/**
 * The Rojo pill, as the desktop main process and the renderer both see it.
 *
 * A place connects to Rojo through a `*.project.json` file picked by the main
 * process, never a path the renderer or the model supplies. `RojoView` is the
 * one shape the pill and its popover render from, and `rojoPillState` is the
 * single place that turns "is a place connected / is it linked / does a
 * server answer / did the last attempt fail" into the pill's state, so the
 * table in the design spec exists in exactly one function.
 */

/** Only `place:<id>` ids are ever stored across restarts; `anon:<uuid>` ids link for the Studio session only. */
export const PLACE_INSTANCE_ID_PATTERN = /^place:\d+$/;

export function isPlaceInstanceId(value: string): boolean {
  return PLACE_INSTANCE_ID_PATTERN.test(value);
}

export type RojoPillStateKind = "no-place" | "not-linked" | "detected" | "linked-running" | "linked-stopped" | "error";

export type RojoScriptCounts = Readonly<{ file: number; generated: number; unsupported: number }>;

export type RojoProjectView = Readonly<{
  fileName: string;
  folder: string;
  rojoVersion?: string;
  scripts?: RojoScriptCounts;
  problems?: readonly string[];
}>;

export type RojoServerView = Readonly<{ port: number; answering: boolean; projectName?: string }>;

export type RojoRecentEntry = Readonly<{ index: number; fileName: string; folder: string }>;

export type RojoView = Readonly<{
  instanceId: string | null;
  published: boolean;
  state: RojoPillStateKind;
  project?: RojoProjectView;
  server?: RojoServerView;
  recent: readonly RojoRecentEntry[];
  /** One sentence, shown mainly in the `error` state. */
  message?: string;
}>;

export type RojoResult =
  | Readonly<{ ok: true; view: RojoView }>
  | Readonly<{ ok: false; message: string; view?: RojoView }>;

/** What `rojoPillState` needs to pick one row of the design spec's table. */
export type RojoPillStateInputs = Readonly<{
  /** Whether `instanceId` is one the current Studio status lists. */
  connected: boolean;
  /** Whether a remembered or just-made link is active for this instance. */
  linked: boolean;
  /** Whether a Rojo server answered (the linked project's port, or a detected one). */
  answering: boolean;
  /** Whether the last link attempt for this instance failed. */
  errored: boolean;
}>;

/** The design spec's §4.1 table, as one pure function. */
export function rojoPillState(inputs: RojoPillStateInputs): RojoPillStateKind {
  if (!inputs.connected) return "no-place";
  if (inputs.errored) return "error";
  if (inputs.linked) return inputs.answering ? "linked-running" : "linked-stopped";
  return inputs.answering ? "detected" : "not-linked";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STATES: readonly RojoPillStateKind[] = ["no-place", "not-linked", "detected", "linked-running", "linked-stopped", "error"];

function isRojoScriptCounts(value: unknown): value is RojoScriptCounts {
  return isRecord(value) &&
    typeof value.file === "number" &&
    typeof value.generated === "number" &&
    typeof value.unsupported === "number";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRojoProjectView(value: unknown): value is RojoProjectView {
  if (!isRecord(value)) return false;
  if (typeof value.fileName !== "string" || typeof value.folder !== "string") return false;
  if (value.rojoVersion !== undefined && typeof value.rojoVersion !== "string") return false;
  if (value.scripts !== undefined && !isRojoScriptCounts(value.scripts)) return false;
  if (value.problems !== undefined && !isStringArray(value.problems)) return false;
  return true;
}

function isRojoServerView(value: unknown): value is RojoServerView {
  if (!isRecord(value)) return false;
  if (typeof value.port !== "number" || typeof value.answering !== "boolean") return false;
  return value.projectName === undefined || typeof value.projectName === "string";
}

function isRojoRecentEntry(value: unknown): value is RojoRecentEntry {
  return isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.fileName === "string" &&
    typeof value.folder === "string";
}

function isRojoView(value: unknown): value is RojoView {
  if (!isRecord(value)) return false;
  if (value.instanceId !== null && typeof value.instanceId !== "string") return false;
  if (typeof value.published !== "boolean") return false;
  if (!STATES.includes(value.state as RojoPillStateKind)) return false;
  if (value.project !== undefined && !isRojoProjectView(value.project)) return false;
  if (value.server !== undefined && !isRojoServerView(value.server)) return false;
  if (!Array.isArray(value.recent) || !value.recent.every(isRojoRecentEntry)) return false;
  if (value.message !== undefined && typeof value.message !== "string") return false;
  return true;
}

/** Strict guard for anything that crossed a process boundary, like `isBlenderSettingsResult`. */
export function isRojoResult(value: unknown): value is RojoResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    if (typeof value.message !== "string") return false;
    return value.view === undefined || isRojoView(value.view);
  }
  return value.ok === true && isRojoView(value.view);
}
