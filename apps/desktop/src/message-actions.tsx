import { Check, Copy, Quote } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

type CopyState = "idle" | "copied" | "failed";

/** Copies a reply's text, as written (Markdown), and says so for a moment. */
export function CopyReplyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const copy = () => {
    const settle = (next: CopyState) => {
      setState(next);
      window.clearTimeout(reset.current);
      reset.current = window.setTimeout(() => setState("idle"), 2_000);
    };
    if (navigator.clipboard === undefined) { settle("failed"); return; }
    navigator.clipboard.writeText(text).then(() => settle("copied"), () => settle("failed"));
  };
  const label = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy";
  return <button type="button" className="message-action" onClick={copy} title={label} aria-label={state === "idle" ? "Copy the reply" : label} data-state={state}>
    {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    <span className="message-action-label" role="status">{state === "idle" ? "" : label}</span>
  </button>;
}

type Anchor = Readonly<{ top: number; left: number; below: boolean }>;

/** The text of the selection when it lies inside one reply in `container`, else null. */
function selectedReplyText(container: HTMLElement | null): { text: string; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (container === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const reply = start?.closest(".assistant-message");
  if (reply === null || reply === undefined || !container.contains(reply) || end?.closest(".assistant-message") !== reply) return null;
  const text = selection.toString();
  if (text.trim() === "") return null;
  return { text, rect: range.getBoundingClientRect() };
}

/**
 * A "Quote" button that appears over text selected in a reply, the way the
 * Claude app offers one: it adds the selection to the message box as a quote.
 * It shows once the mouse is let go (or a keyboard selection settles), follows
 * the selection as the chat scrolls, and goes as soon as the selection does or
 * it is used.
 */
export function QuoteSelection({ containerRef, onQuote }: {
  containerRef: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const shown = useRef(false);
  shown.current = anchor !== null;
  const pressed = useRef(false);

  const place = useCallback(() => {
    const picked = selectedReplyText(containerRef.current);
    // The part of the window the conversation shows: a selection scrolled out
    // of it, under the header or the message box, has no button.
    const view = containerRef.current?.parentElement?.getBoundingClientRect();
    if (picked === null || view === undefined || (picked.rect.width === 0 && picked.rect.height === 0) ||
      picked.rect.bottom < view.top || picked.rect.top > view.bottom) { setAnchor(null); return; }
    // Above the selection's first line, or below it when there is no room above.
    const below = picked.rect.top - 44 < view.top;
    setAnchor({
      top: below ? picked.rect.bottom + 8 : picked.rect.top - 8,
      left: Math.min(Math.max(picked.rect.left + picked.rect.width / 2, 48), window.innerWidth - 48),
      below,
    });
  }, [containerRef]);

  useEffect(() => {
    const down = (event: PointerEvent) => {
      // A press on the button itself must not hide it before its click lands.
      if (event.target instanceof Element && event.target.closest(".quote-selection")) return;
      pressed.current = true;
      setAnchor(null);
    };
    const up = () => { pressed.current = false; window.setTimeout(place, 0); };
    const changed = () => {
      if (pressed.current) return;
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) setAnchor(null);
    };
    const key = (event: KeyboardEvent) => { if (event.shiftKey || event.key === "Shift") window.setTimeout(place, 0); };
    // The button follows the selection as the conversation scrolls.
    const follow = () => { if (shown.current && !pressed.current) place(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("keyup", key, true);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("keyup", key, true);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [place]);

  if (anchor === null) return null;
  return createPortal(<button
    type="button"
    className="quote-selection"
    data-placement={anchor.below ? "below" : "above"}
    style={{ top: anchor.top, left: anchor.left }}
    // Keeps the selection: a press would otherwise clear it before the click.
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => {
      const picked = selectedReplyText(containerRef.current);
      setAnchor(null);
      if (picked === null) return;
      window.getSelection()?.removeAllRanges();
      onQuote(picked.text);
    }}
  ><Quote size={13} aria-hidden="true" />Quote</button>, document.body);
}
