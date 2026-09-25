/**
 * Which model drives a run.
 *
 * `chatgpt` and `claude` run on the user's own subscription through the
 * official Codex app-server and Claude Code CLI. `custom` runs a model on an
 * endpoint the user configured themselves, with their own key, through
 * Roqer's own agent loop.
 *
 * Earlier builds also knew `workbench`, a hosted service that no longer
 * exists. It is not a provider id any more, so a saved workspace that names
 * it moves to the default when it loads.
 */
export type ProviderId = "chatgpt" | "claude" | "custom";

/** Every provider this build knows how to drive. */
export const PROVIDER_IDS: readonly ProviderId[] = ["chatgpt", "claude", "custom"];

/** Providers this build offers. */
export const ENABLED_PROVIDER_IDS: readonly ProviderId[] = PROVIDER_IDS;

/** What a workspace runs on when it names nothing, or names something hidden. */
export const DEFAULT_PROVIDER_ID: ProviderId = "chatgpt";

export function isProviderId(value: unknown): value is ProviderId {
  return value === "chatgpt" || value === "claude" || value === "custom";
}

/** Whether this build can drive the provider. */
export function isEnabledProvider(value: unknown): value is ProviderId {
  return isProviderId(value) && ENABLED_PROVIDER_IDS.includes(value);
}

/** A saved provider known to this build, or the default when it is unknown. */
export function enabledProviderOr(value: unknown): ProviderId {
  return isEnabledProvider(value) ? value : DEFAULT_PROVIDER_ID;
}

export function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "custom":
      return "Custom";
    default:
      return "ChatGPT";
  }
}

/** Sanitized provider state that is safe to expose to the renderer. */
export type ProviderStatus =
  | { kind: "checking"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "signed-out"; message: string }
  | {
    kind: "signed-in";
    message: string;
    email?: string;
    planType?: string;
  };

/**
 * The result of asking a provider to start sign-in.
 *
 * `awaitingCode` marks a flow that cannot finish on its own: Claude Code's
 * OAuth flow returns the authorization code to a hosted page, so the user has
 * to paste it back before the sign-in completes. Codex finishes in the browser
 * and never sets it.
 */
export type ProviderLoginResult =
  | { ok: true; message: string; awaitingCode?: boolean }
  | { ok: false; message: string };

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export type ProviderModel = {
  id: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description?: string;
  }>;
  /** Which provider runs this model, for transparency rather than routing. */
  runsOn?: string;
};

/** Account-visible model metadata, sanitized before crossing into the renderer. */
export type ProviderModelCatalog = {
  models: ProviderModel[];
  defaultModelId: string | null;
  message?: string;
};

/**
 * Historical names, kept because the ChatGPT connector and its tests were
 * written before a second provider existed. New code should use the
 * provider-neutral names above.
 */
export type ChatGptStatus = ProviderStatus;
export type ChatGptLoginResult = ProviderLoginResult;
export type ChatGptModel = ProviderModel;
export type ChatGptModelCatalog = ProviderModelCatalog;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isProviderStatus(value: unknown): value is ProviderStatus {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.message !== "string") return false;
  if (!["checking", "unavailable", "signed-out", "signed-in"].includes(value.kind)) return false;
  if (value.kind !== "signed-in") return true;
  return (value.email === undefined || typeof value.email === "string") &&
    (value.planType === undefined || typeof value.planType === "string");
}

export function isProviderLoginResult(value: unknown): value is ProviderLoginResult {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.message !== "string") return false;
  return value.awaitingCode === undefined || typeof value.awaitingCode === "boolean";
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function isProviderModel(value: unknown): value is ProviderModel {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string" ||
    !isReasoningEffort(value.defaultReasoningEffort) || !Array.isArray(value.supportedReasoningEfforts)) return false;
  return (value.description === undefined || typeof value.description === "string") &&
    (value.runsOn === undefined || typeof value.runsOn === "string") &&
    value.supportedReasoningEfforts.every((entry) => isRecord(entry) &&
      isReasoningEffort(entry.reasoningEffort) &&
      (entry.description === undefined || typeof entry.description === "string"));
}

export function isProviderModelCatalog(value: unknown): value is ProviderModelCatalog {
  return isRecord(value) && Array.isArray(value.models) && value.models.every(isProviderModel) &&
    (value.defaultModelId === null || typeof value.defaultModelId === "string") &&
    (value.message === undefined || typeof value.message === "string");
}

export const isChatGptStatus = isProviderStatus;
export const isChatGptModelCatalog = isProviderModelCatalog;
