/**
 * What the desktop knows about updating itself.
 *
 * An update carries more than the app: the Studio plugin ships inside it and is
 * reinstalled on the next launch, so keeping the app current is how a customer's
 * plugin stays in step. The states below are what the interface may say about
 * that, and nothing here invents progress it was not told about.
 */
export type AppUpdateState =
  /** Nothing to do: either no check has run yet, or this build is current. */
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "available"; version: string }>
  /** `percent` is whole numbers 0-100, as the provider reports it. */
  | Readonly<{ kind: "downloading"; version: string; percent: number }>
  /** Downloaded and staged; it installs when the app is restarted. */
  | Readonly<{ kind: "ready"; version: string }>
  /**
   * This build cannot update itself — a development run, or a package built
   * with no release feed. Distinct from a failure: nothing went wrong.
   */
  | Readonly<{ kind: "unsupported"; message: string }>
  | Readonly<{ kind: "failed"; message: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100;

export function isAppUpdateState(value: unknown): value is AppUpdateState {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "idle":
    case "checking":
      return true;
    case "available":
    case "ready":
      return isVersion(value.version);
    case "downloading":
      return isVersion(value.version) && typeof value.percent === "number" &&
        Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100;
    case "unsupported":
    case "failed":
      return typeof value.message === "string";
    default:
      return false;
  }
}

/** One line for the interface, whatever the state. */
export function appUpdateMessage(state: AppUpdateState): string {
  switch (state.kind) {
    case "idle":
      return "Roqer is up to date.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Downloading Roqer ${state.version}…`;
    case "downloading":
      return `Downloading Roqer ${state.version} — ${String(Math.round(state.percent))}%`;
    case "ready":
      return `Roqer ${state.version} is ready to install.`;
    case "unsupported":
      return state.message;
    case "failed":
      return state.message;
  }
}

/**
 * Whether the interface should offer a restart.
 *
 * Only a downloaded update can be installed, so this is the one state that
 * earns an interruption; everything else is either progress or nothing.
 */
export function canInstallUpdate(state: AppUpdateState): boolean {
  return state.kind === "ready";
}

/**
 * Whether an update is on its way: found and about to download, or
 * downloading. The interface shows this as progress, not as an offer -- there
 * is nothing to do yet -- but it has to show it, because the download is the
 * part that takes minutes, and the install button only appears when it is
 * over. Checking is deliberately not included: it happens every few hours
 * and takes a second, and a sidebar that flickered for it would be noise.
 */
export function updateInProgress(state: AppUpdateState): state is Extract<AppUpdateState, { kind: "available" | "downloading" }> {
  return state.kind === "available" || state.kind === "downloading";
}
