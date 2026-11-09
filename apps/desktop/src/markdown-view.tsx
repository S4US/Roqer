import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from "./markdown";
import { nextReveal, noteReveal, resumeReveal, revealEnd } from "./streaming-reveal";

/**
 * Renders assistant prose.
 *
 * Every node becomes a real React element — there is no `dangerouslySetInnerHTML`
 * anywhere on this path — so model output can never introduce markup, and the
 * only thing the reader sees of Markdown is its effect.
 *
 * Links render as text carrying their target in a tooltip rather than as
 * anchors: a run's reply is untrusted content, and nothing in the conversation
 * should be a navigation surface the reader cannot inspect first.
 */

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.value}</Fragment>;
      case "code":
        return <code className="md-inline-code" key={index}>{node.value}</code>;
      case "strong":
        return <strong key={index}><Inline nodes={node.children} /></strong>;
      case "emphasis":
        return <em key={index}><Inline nodes={node.children} /></em>;
      case "link":
        return <span className="md-link" title={node.href} key={index}><Inline nodes={node.children} /></span>;
    }
  })}</>;
}

function List({ list }: { list: ListBlock }) {
  const items = list.items.map((item, index) => <li key={index}>
    <Inline nodes={item.children} />
    {item.lists.map((nested, position) => <List list={nested} key={position} />)}
  </li>);
  return list.ordered
    ? <ol start={list.start === 1 ? undefined : list.start}>{items}</ol>
    : <ul>{items}</ul>;
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p><Inline nodes={block.children} /></p>;
    case "heading": {
      // The reply sits inside the chat, so its top heading is an h2; the class
      // carries the level the model wrote, which is what sets the size.
      const Tag = `h${Math.min(6, block.level + 1)}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className={`md-h${Math.min(4, block.level)}`}><Inline nodes={block.children} /></Tag>;
    }
    case "table":
      return <div className="md-table-wrap"><table className="md-table">
        <thead><tr>{block.header.map((cell, column) =>
          <th key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}><Inline nodes={cell} /></th>)}
        </tr></thead>
        <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, column) =>
          <td key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}><Inline nodes={cell} /></td>)}
        </tr>)}</tbody>
      </table></div>;
    case "code":
      return <pre className="md-code">
        {block.language && <span className="md-code-language">{block.language}</span>}
        <code>{block.value}</code>
      </pre>;
    case "list":
      return <List list={block} />;
    case "quote":
      return <blockquote><Inline nodes={block.children} /></blockquote>;
    case "rule":
      return <hr />;
  }
}

/**
 * A reply this long is formatted at most this often while it is revealed, so
 * re-rendering every frame never costs more than the smoothness is worth.
 */
const LONG_REPLY_CHARACTERS = 16_000;
const LONG_REPLY_RENDER_MS = 50;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Markdown for a reply, revealed smoothly while it arrives.
 *
 * Text arrives in bursts; showing each one as it lands makes the reply jump.
 * Here the shown text runs slightly behind and catches up every frame (see
 * streaming-reveal.ts), so a burst reads as an even run of characters.
 *
 * - `live`: the run's own view. It reveals from the first character, even
 *   when the whole reply arrived in one piece, as most models send it.
 * - `handoffKey`: the run. A view mounting with the key of a reveal already
 *   under way carries on from the same character: the saved reply that takes
 *   over when a run ends, or the live view of a chat opened again mid-run.
 *   Without one, a view that is not `live` shows the reply at once.
 * - `done`: the run has ended, so the rest is shown a little faster.
 *
 * A new stretch of prose, after a tool call, starts from its first character.
 * With reduced motion, text shows as it arrives.
 */
export function StreamingMarkdown({ text, live = false, done = false, handoffKey, className = "" }: {
  text: string;
  live?: boolean;
  done?: boolean;
  handoffKey?: string;
  className?: string;
}) {
  const [initial] = useState(() => {
    const resumed = handoffKey === undefined ? undefined : resumeReveal(handoffKey, text);
    if (resumed !== undefined) return resumed;
    return live && !prefersReducedMotion() ? 0 : text.length;
  });
  const [count, setCount] = useState(() => revealEnd(text, initial));
  const latest = useRef(text);
  latest.current = text;
  const doneRef = useRef(done);
  doneRef.current = done;
  const keyRef = useRef(handoffKey);
  keyRef.current = handoffKey;
  /** Characters shown, fractional so a slow frame still makes progress. */
  const shown = useRef(initial);
  /** The text `shown` counts into, to tell more of the same stretch from a new one. */
  const basis = useRef(text);
  /** The animation loop, while one is running. One loop serves every delta. */
  const frame = useRef<number | null>(null);

  // Before paint, so a new stretch never flashes in whole for one frame, and
  // so the position is recorded before a view taking over can look for it.
  useLayoutEffect(() => {
    if (!text.startsWith(basis.current.slice(0, Math.floor(shown.current)))) shown.current = 0;
    basis.current = text;
    if (prefersReducedMotion()) shown.current = text.length;
    setCount(revealEnd(text, shown.current));
    if (keyRef.current !== undefined) noteReveal(keyRef.current, text, shown.current);
    if (frame.current !== null || shown.current >= text.length) return;
    let lastFrameAt: number | null = null;
    let lastRenderAt = 0;
    const tick = (now: number) => {
      const elapsed = lastFrameAt === null ? 1000 / 60 : now - lastFrameAt;
      lastFrameAt = now;
      const arrived = latest.current.length;
      shown.current = nextReveal(shown.current, arrived, elapsed, doneRef.current);
      const caughtUp = shown.current >= arrived;
      if (caughtUp || arrived < LONG_REPLY_CHARACTERS || now - lastRenderAt >= LONG_REPLY_RENDER_MS) {
        lastRenderAt = now;
        setCount(revealEnd(latest.current, shown.current));
      }
      if (keyRef.current !== undefined) noteReveal(keyRef.current, latest.current, shown.current);
      frame.current = caughtUp ? null : window.requestAnimationFrame(tick);
    };
    frame.current = window.requestAnimationFrame(tick);
  }, [text]);
  // Stops the loop and forgets it, so a view mounted again (as StrictMode does
  // to every component in development) starts a fresh one.
  useLayoutEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  return <Markdown text={text.slice(0, count)} className={className} />;
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return <div className={`markdown ${className}`.trim()}>
    {blocks.map((block, index) => <Block block={block} key={index} />)}
  </div>;
}
