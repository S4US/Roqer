import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, PanelRight, X } from "lucide-react";

import type { RunChange, RunEvidence } from "../shared/run-events";
import type { ChangeGroup } from "./diff-view";
import { ResultsCard, type FileExpansion } from "./results-card";
import { resultsSummary, runResults } from "./results-model";
import { clampDeckWidth, DECK_INLINE_MIN_WIDTH, deckTarget } from "./run-deck-model";

/**
 * The Run Deck: a run's results beside the chat.
 *
 * Each run's results are still rendered by the run they belong to, and portalled
 * into the deck when the deck shows that run. So a deck has no data of its own
 * to fall out of step, and what a reader did in a run's results is kept by run
 * id exactly as it was. The chat keeps a one-line summary of each run with
 * results, which is how a past run is opened.
 */

type Deck = {
  host: HTMLElement | null;
  target: string | null;
  offered: string | null;
  inline: boolean;
  pick: (runId: string) => void;
  offer: (runId: string) => void;
  withdraw: (runId: string) => void;
  close: () => void;
  toggle: () => void;
};

const DeckContext = createContext<Deck | null>(null);

function useInlineWidth(): boolean {
  const [inline, setInline] = useState(() => window.matchMedia(`(min-width: ${DECK_INLINE_MIN_WIDTH}px)`).matches);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DECK_INLINE_MIN_WIDTH}px)`);
    const changed = () => setInline(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return inline;
}

/** The deck's state for one window. Switching chats forgets a picked run; closing the deck holds. */
export function useRunDeck(chatId: string | null, host: HTMLElement | null): Deck {
  const inline = useInlineWidth();
  const [picked, setPicked] = useState<string | null>(null);
  const [offered, setOffered] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => setPicked(null), [chatId]);
  const target = deckTarget({ picked, offered, closed, inline });
  const close = useCallback(() => { setPicked(null); setClosed(true); }, []);
  const pick = useCallback((runId: string) => {
    setPicked((current) => (current === runId ? null : runId));
    setClosed(false);
  }, []);
  const offer = useCallback((runId: string) => setOffered(runId), []);
  const withdraw = useCallback((runId: string) => setOffered((current) => (current === runId ? null : current)), []);
  const toggle = useCallback(() => {
    if (target !== null) close();
    else if (inline) setClosed(false);
    else setPicked(offered);
  }, [close, inline, offered, target]);
  return useMemo(() => ({ host, target, offered, inline, pick, offer, withdraw, close, toggle }), [close, host, inline, offer, offered, pick, target, toggle, withdraw]);
}

export function RunDeckProvider({ deck, children }: { deck: Deck; children: ReactNode }) {
  return <DeckContext.Provider value={deck}>{children}</DeckContext.Provider>;
}

/** The top bar's way to open and close the deck; nothing to show means no button. */
export function RunDeckToggle({ deck }: { deck: Deck }) {
  if (deck.offered === null && deck.target === null) return null;
  const open = deck.target !== null;
  return <button type="button" className="icon-button" aria-pressed={open} onClick={deck.toggle} aria-label={open ? "Hide the Run Deck" : "Show the Run Deck"} title={open ? "Hide the Run Deck" : "Show the Run Deck"}><PanelRight size={16} /></button>;
}

/** What the chat must keep when the deck grows. */
const CHAT_MIN_WIDTH = 480;
const KEY_STEP = 24;

/**
 * The deck's left edge, dragged to give a long diff more room. The width lives on
 * the deck's element for this window only: it is a passing preference, not a
 * setting worth storing.
 */
function DeckResizer({ host }: { host: HTMLElement }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [width, setWidth] = useState(() => Math.round(host.getBoundingClientRect().width));
  const room = () => (host.previousElementSibling?.getBoundingClientRect().width ?? 0) + host.getBoundingClientRect().width - CHAT_MIN_WIDTH;
  const apply = (next: number) => {
    const clamped = clampDeckWidth(next, room());
    host.style.setProperty("--deck-width", `${clamped}px`);
    setWidth(clamped);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: host.getBoundingClientRect().width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) apply(drag.current.startWidth + drag.current.startX - event.clientX);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    apply(host.getBoundingClientRect().width + (event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
  };
  return <div
    className="run-deck-resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the Run Deck"
    aria-valuenow={width}
    tabIndex={0}
    title="Drag to resize"
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={() => { host.style.removeProperty("--deck-width"); setWidth(Math.round(host.getBoundingClientRect().width)); }}
    onKeyDown={onKeyDown}
  />;
}

/** A run's results: a summary line in the chat, and the card itself in the deck while it shows this run. */
export function RunResults({ runId, changes, evidence, latest, renderFiles }: {
  runId: string;
  changes: readonly RunChange[];
  evidence: readonly RunEvidence[];
  /** Whether this is the run the deck shows by default. */
  latest: boolean;
  renderFiles: (files: ChangeGroup[], expansion: FileExpansion) => ReactNode;
}) {
  const deck = useContext(DeckContext);
  if (deck === null) throw new Error("RunResults needs a RunDeckProvider.");
  const { offer, withdraw } = deck;
  const summary = useMemo(() => resultsSummary(runResults(changes, evidence).tabs), [changes, evidence]);
  const hasResults = summary !== "";
  useEffect(() => {
    if (!latest || !hasResults) return undefined;
    offer(runId);
    return () => withdraw(runId);
  }, [hasResults, latest, offer, runId, withdraw]);
  if (!hasResults) return null;
  const showing = deck.target === runId;
  return <>
    {/* Stays visible and lit while the deck shows this run, which is how a long chat says which run that is. */}
    <button type="button" className="run-summary" aria-pressed={showing} aria-label={`${showing ? "Close" : "Show"} this run in the Run Deck: ${summary}`} onClick={() => { if (showing) deck.close(); else deck.pick(runId); }}>
      <PanelRight size={15} aria-hidden="true" />
      <span>{summary.replaceAll(", ", " · ")}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
    {showing && deck.host !== null && createPortal(<>
      {deck.inline && <DeckResizer host={deck.host} />}
      <ResultsCard
        runId={runId}
        changes={changes}
        evidence={evidence}
        docked
        headerAction={<button type="button" className="icon-button" onClick={deck.close} aria-label="Close the Run Deck" title="Close the Run Deck"><X size={15} /></button>}
        renderFiles={renderFiles}
      />
    </>, deck.host)}
  </>;
}
