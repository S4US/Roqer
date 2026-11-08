import { useEffect, useState } from "react";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Keeps something that has just closed on the page for `leaveMs`, so it can
 * animate out instead of vanishing. `present` is whether to render it, and
 * `leaving` whether it is on its way out (style it closed, for example with a
 * `data-leaving` attribute).
 *
 * Decided during the render that closes it, not in an effect after: an effect
 * would let that render take the element out and put it back a moment later,
 * which the browser plays as a fresh entrance. Reopening mid-way cancels the
 * exit, and with reduced motion nothing lingers.
 */
export function usePresence(open: boolean, leaveMs: number): { present: boolean; leaving: boolean } {
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setLeaving(!open && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => setLeaving(false), leaveMs);
    return () => window.clearTimeout(timer);
  }, [leaving, leaveMs]);
  return { present: open || leaving, leaving };
}
