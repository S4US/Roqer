/**
 * The opt-in local Blender worker, as the main process and the renderer both
 * see it.
 *
 * Blender runs model-written Python with the user's own permissions, so the
 * worker is off until the user turns it on, and the executable it runs is one
 * the main process found or the user picked in a system file dialog -- never a
 * path the renderer or the model supplied.
 */

/** The run-engine operation a Blender job travels as: approved and cancelled like any tool. */
export const BLENDER_OPERATION = "run_blender_script";

/** The model-facing tool name, offered only while the worker is enabled. */
export const BLENDER_TOOL_NAME = "blender";

/** A script longer than this is not a modeling script, it is a program. */
export const MAX_BLENDER_SCRIPT_CHARACTERS = 60_000;

/**
 * A job's id, which a later job names in `continue_from` to start from the
 * scene it saved rather than from an empty one.
 */
export const BLENDER_JOB_ID_PATTERN = "^[0-9a-f]{8}$";

export function isBlenderJobId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(BLENDER_JOB_ID_PATTERN).test(value);
}

/** How long one job's script may run, and the most a call may ask for. */
export const DEFAULT_BLENDER_JOB_SECONDS = 120;
export const MAX_BLENDER_JOB_SECONDS = 200;

/**
 * Where Blender stands.
 * - `ready`: enabled, and the executable answered `--version`.
 * - `off`: found, or chosen, but not turned on.
 * - `missing`: no Blender was found and none has been chosen.
 * - `broken`: the chosen executable did not answer as Blender.
 */
export type BlenderState = "ready" | "off" | "missing" | "broken";

export type BlenderSettingsView = Readonly<{
  enabled: boolean;
  /** The executable Roqer would run, for display. */
  executable: string | null;
  /** What `blender --version` reported, e.g. "Blender 5.2.1 LTS". */
  version: string | null;
  state: BlenderState;
  /** One sentence for Settings. */
  message: string;
}>;

export type BlenderSettingsResult =
  | Readonly<{ ok: true; settings: BlenderSettingsView }>
  | Readonly<{ ok: false; message: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STATES: readonly BlenderState[] = ["ready", "off", "missing", "broken"];

export function isBlenderSettingsResult(value: unknown): value is BlenderSettingsResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.message === "string";
  if (value.ok !== true || !isRecord(value.settings)) return false;
  const settings = value.settings;
  return typeof settings.enabled === "boolean" &&
    (settings.executable === null || typeof settings.executable === "string") &&
    (settings.version === null || typeof settings.version === "string") &&
    STATES.includes(settings.state as BlenderState) &&
    typeof settings.message === "string";
}
