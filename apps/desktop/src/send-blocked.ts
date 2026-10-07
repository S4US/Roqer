import { providerLabel, type ProviderId, type ProviderStatus } from "../shared/provider";

/**
 * Why Send opened Settings instead of sending.
 *
 * A Send with no account to run it, or no model, opens Settings on the Models
 * page, where that is fixed. It used to open with nothing there saying so,
 * which read as the button doing the wrong thing. This is the line at the top
 * of that page. It also says the message is still in the box, because the box
 * is out of sight behind Settings and nothing else would say it was kept.
 */
export function sendBlockedNotice(provider: ProviderId, status: ProviderStatus, catalogMessage?: string): string {
  return `Your message wasn't sent. ${sentence(blockedReason(provider, status, catalogMessage))} It's still in the box.`;
}

function blockedReason(provider: ProviderId, status: ProviderStatus, catalogMessage: string | undefined): string {
  const label = providerLabel(provider);
  switch (status.kind) {
    case "checking":
      return `Roqer is still checking ${provider === "custom" ? "your endpoints" : `your ${label} account`}. Try again in a moment`;
    case "signed-in":
      if (catalogMessage !== undefined && catalogMessage.trim() !== "") return catalogMessage.trim();
      return provider === "custom" ? "None of your endpoints has a model to run" : `${label} has no model Roqer can run right now`;
    case "signed-out":
      return provider === "custom" ? status.message : `Connect your ${label} account below to send it`;
    case "not-installed":
    case "unavailable":
      return status.message;
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
