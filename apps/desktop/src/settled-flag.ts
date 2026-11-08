import { useEffect, useState } from "react";

/**
 * True once `value` has stayed true for `delayMs`, and false the moment it
 * turns false. Used where a state that flips on and off quickly would make the
 * interface flicker if every flip were shown.
 */
export function useSettledFlag(value: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!value) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return value && settled;
}
