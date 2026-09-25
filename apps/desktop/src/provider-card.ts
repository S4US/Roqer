import { providerLabel, type ProviderId, type ProviderStatus } from "../shared/provider";

/**
 * What the sidebar's provider card says: a title, one line under it, and a
 * badge only when the badge adds something. Each fact is said once — the card
 * used to read "Claude connected / Pro connected through Claude Code / pro".
 */
export type ProviderCard = Readonly<{ title: string; detail: string; badge?: string }>;

/** The app each subscription is run through. */
const CLIENTS: Partial<Record<ProviderId, string>> = { claude: "Claude Code", chatgpt: "Codex" };

const capitalized = (text: string) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

export function providerCard(provider: ProviderId, status: ProviderStatus, desktop: boolean): ProviderCard {
  if (!desktop) return { title: "Studio access", detail: "Preview mode", badge: "Demo" };
  if (status.kind !== "signed-in") return { title: "Studio access", detail: status.message, badge: "Local" };
  const client = CLIENTS[provider];
  if (client === undefined) return { title: providerLabel(provider) === "Custom" ? "Your own models" : providerLabel(provider), detail: status.message };
  const plan = status.planType?.trim();
  return {
    title: plan ? `${providerLabel(provider)} ${capitalized(plan)}` : providerLabel(provider),
    detail: `Through ${client}`,
  };
}
