import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { NO_LIMITS, type ProviderLimits } from "../shared/provider-limits";
import { providerLabel, type ProviderId } from "../shared/provider";
import { getProviderLimits } from "./platform";
import { planUsageView, USAGE_SCOPES } from "./plan-usage";
import { PlanUsageList } from "./plan-usage-list";
import type { ProviderCard } from "./provider-card";

/** How long the pointer rests on the card before its usage opens. */
const HOVER_OPEN_MS = 250;
/** How long a closed popover's numbers are still fresh enough to show without asking again. */
const LIMITS_FRESH_MS = 15_000;

/**
 * The sidebar's account card. Hovering it, or clicking it, shows the plan's
 * usage: the same meters as the account row in Settings, read again each time
 * it opens. A click keeps it open until another click, Escape, or a click
 * elsewhere; a hover keeps it only while the pointer is on the card or the
 * popover.
 */
export function SubscriptionCard({ card, provider, signedIn }: {
  card: ProviderCard;
  provider: ProviderId;
  /** Usage belongs to a signed-in account; without one the card has nothing to open. */
  signedIn: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [limits, setLimits] = useState<ProviderLimits>(NO_LIMITS);
  const [loading, setLoading] = useState(false);
  const readAt = useRef(0);
  const hoverTimer = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const open = signedIn && (hovered || pinned);
  const name = providerLabel(provider);

  const read = useCallback(async () => {
    if (Date.now() - readAt.current < LIMITS_FRESH_MS) return;
    setLoading(true);
    try {
      setLimits(await getProviderLimits(provider));
      readAt.current = Date.now();
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    if (open) void read();
  }, [open, read]);

  // Another account's numbers are not this one's.
  useEffect(() => {
    readAt.current = 0;
    setLimits(NO_LIMITS);
  }, [provider, signedIn]);

  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPinned(false); };
    const onPointer = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setPinned(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [pinned]);

  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); }, []);

  const enter = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(true), HOVER_OPEN_MS);
  };
  const leave = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(false);
  };

  const usage = planUsageView(limits, USAGE_SCOPES[provider] ?? name, Date.now());
  const body = <><Sparkles size={16} /><div><strong>{card.title}</strong><span>{card.detail}</span></div>{card.badge !== undefined && <span className="runtime-badge">{card.badge}</span>}</>;

  if (!signedIn) return <div className="subscription-card">{body}</div>;
  return <div className="subscription-wrap" ref={root} onMouseEnter={enter} onMouseLeave={leave}>
    {open && <div className="subscription-usage" role="dialog" aria-label={`${name} usage`}>
      <p className="subscription-usage-title">{card.title} usage</p>
      {usage !== null
        ? <PlanUsageList usage={usage} name={name} />
        : <p className="plan-usage-note">{loading ? "Reading your usage…" : `${name} has not reported your usage yet. It does after a run.`}</p>}
    </div>}
    <button
      type="button"
      className="subscription-card subscription-button"
      aria-expanded={open}
      aria-haspopup="dialog"
      title={pinned ? undefined : `Show your ${name} usage`}
      onClick={() => setPinned((current) => !current)}
    >{body}</button>
  </div>;
}
