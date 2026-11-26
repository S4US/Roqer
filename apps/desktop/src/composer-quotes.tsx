import { Reply, X } from "lucide-react";
import type { ComposerQuote } from "./message-quote";

/**
 * The passages quoted in the message being written, above the box: one row
 * each, with whether it has a reply of its own. Opening a row shows the whole
 * passage and a field for that reply. Enter or Escape closes it again.
 */
export function ComposerQuotes({ quotes, editingId, onEdit, onReply, onRemove, onDone }: {
  quotes: readonly ComposerQuote[];
  /** The quote whose reply is being written, if any. */
  editingId: string | null;
  onEdit: (id: string) => void;
  onReply: (id: string, reply: string) => void;
  onRemove: (id: string) => void;
  /** The reply being written is finished: close it and go back to the message box. */
  onDone: () => void;
}) {
  if (quotes.length === 0) return null;
  return <div className="composer-quotes" role="group" aria-label="Quotes in this message">
    {quotes.map((quote) => quote.id === editingId
      ? <div className="composer-quote composer-quote-open" key={quote.id}>
        <Reply size={15} aria-hidden="true" />
        <div className="composer-quote-body">
          <blockquote>{quote.text}</blockquote>
          <textarea
            autoFocus rows={2} value={quote.reply}
            placeholder="Your reply to this passage (optional)" aria-label="Your reply to this passage"
            onChange={(event) => onReply(quote.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); onDone(); }
              // A word still being composed (an input method) is confirmed with Enter, not closed.
              else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onDone(); }
            }}
          />
        </div>
        <button type="button" className="small-button" onClick={onDone}>Done</button>
        <button type="button" className="icon-button" onClick={() => onRemove(quote.id)} aria-label="Remove this quote" title="Remove this quote"><X size={14} /></button>
      </div>
      : <div className="composer-quote" key={quote.id}>
        <button type="button" className="composer-quote-main" onClick={() => onEdit(quote.id)}
          title={quote.reply.trim() === "" ? "Add a reply to this passage" : `Your reply: ${quote.reply.trim()}`}>
          <Reply size={15} aria-hidden="true" />
          <span className="composer-quote-text">“{quote.text.replace(/\s+/g, " ")}”</span>
          <span className="composer-quote-badge" data-replied={quote.reply.trim() !== "" || undefined}>{quote.reply.trim() === "" ? "Add reply" : "With reply"}</span>
        </button>
        <button type="button" className="icon-button" onClick={() => onRemove(quote.id)} aria-label="Remove this quote" title="Remove this quote"><X size={14} /></button>
      </div>)}
  </div>;
}
