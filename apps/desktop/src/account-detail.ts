import type { ProviderStatus } from "../shared/provider";

function capitalized(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/**
 * The line under a subscription account in Settings: the plan and email it is
 * signed in with, and the client it runs through with that client's version,
 * which appears only once Roqer found the client and it answered.
 */
export function accountDetail(status: ProviderStatus, client: string | undefined): string {
  const version = status.kind === "signed-in" || status.kind === "signed-out" || status.kind === "unavailable"
    ? status.clientVersion
    : undefined;
  const named = client === undefined ? undefined : version === undefined ? client : `${client} ${version}`;
  if (status.kind === "signed-in") {
    return [status.planType === undefined ? undefined : capitalized(status.planType), status.email, named === undefined ? undefined : `through ${named}`]
      .filter((part): part is string => part !== undefined && part !== "")
      .join(" · ") || status.message;
  }
  return version === undefined || named === undefined ? status.message : `${status.message} · ${named}`;
}
