import { CornerDownLeft, MessageSquare, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { searchChats, type ChatSearchResult } from "./chat-search-model";
import type { WorkspaceState } from "./model";

/** The day a result is from, short: chats often share a name, and the day tells them apart. */
function shortDate(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** A result's text with the searched words set apart. */
function Marked({ text, marks }: { text: string; marks: ChatSearchResult["marks"] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * Search every chat, in every project, by name and by what was said in it.
 * The arrow keys move through the results, Enter opens the one marked, and
 * Escape or a click outside closes the search.
 */
export function ChatSearch({ workspace, onOpen, onClose }: {
  workspace: WorkspaceState;
  onOpen: (result: ChatSearchResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Typing stays quick in a workspace with many long chats: the list follows a beat behind.
  const deferred = useDeferredValue(query);
  const results = useMemo(() => searchChats(workspace, deferred), [workspace, deferred]);
  const listRef = useRef<HTMLDivElement>(null);
  const chosen = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${chosen}"]`)?.scrollIntoView({ block: "nearest" });
  }, [chosen, results]);

  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setActive((chosen + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
      return;
    }
    // A word still being composed (an input method) is confirmed with Enter, not opened.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && results[chosen] !== undefined) {
      event.preventDefault();
      onOpen(results[chosen]);
    }
  };

  const asked = deferred.trim() !== "";
  return <div className="modal-backdrop chat-search-backdrop" role="presentation" onMouseDown={onClose}>
    <div className="chat-search" role="dialog" aria-modal="true" aria-label="Search chats" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleKey}>
      <div className="chat-search-field">
        <Search size={17} aria-hidden="true" />
        <input
          autoFocus type="text" value={query} placeholder="Search all chats" aria-label="Search all chats"
          role="combobox" aria-expanded={results.length > 0} aria-controls="chat-search-results"
          aria-activedescendant={results.length > 0 ? `chat-search-result-${chosen}` : undefined}
          spellCheck={false} autoComplete="off"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        />
      </div>
      <div className="chat-search-results" id="chat-search-results" role="listbox" aria-label="Results" ref={listRef}>
        {!asked && <p className="chat-search-note">Search the names of your chats and everything said in them, in every project.</p>}
        {asked && results.length === 0 && <p className="chat-search-note" role="status">Nothing found for “{deferred.trim()}”.</p>}
        {results.map((result, index) => <button
          type="button" className="chat-search-result" key={`${result.chatId}:${result.messageId ?? ""}`}
          id={`chat-search-result-${index}`} data-index={index} role="option" aria-selected={index === chosen}
          onMouseMove={() => setActive(index)}
          onClick={() => onOpen(result)}
        >
          <span className="chat-search-where">
            <MessageSquare size={13} aria-hidden="true" />
            <strong>{result.messageId === undefined ? <Marked text={result.snippet} marks={result.marks} /> : result.chatTitle}</strong>
            <span>{result.projectName} · {shortDate(result.at)}</span>
          </span>
          {result.messageId !== undefined && <span className="chat-search-snippet">
            <em>{result.role === "user" ? "You" : "Roqer"}</em>
            <Marked text={result.snippet} marks={result.marks} />
          </span>}
        </button>)}
      </div>
      {results.length > 0 && <p className="chat-search-keys">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
        <span><kbd><CornerDownLeft size={11} aria-label="Enter" /></kbd> to open</span>
        <span><kbd>Esc</kbd> to close</span>
      </p>}
    </div>
  </div>;
}
