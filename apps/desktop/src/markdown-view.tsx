import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from "./markdown";

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

/** How often a reply that is still streaming is re-rendered as Markdown. */
const STREAMING_RENDER_MS = 160;

/**
 * Markdown for a reply that is still arriving. Parsing the whole document on
 * every delta would make a long reply quadratic, so the formatted view
 * catches up with the text a few times a second instead. The reader sees
 * formatting as it streams, not asterisks until the run ends.
 */
export function StreamingMarkdown({ text, className = "" }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  latest.current = text;
  // A throttle, not a debounce: a new delta does not push the render back, so
  // text that streams without a pause still updates a few times a second.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (shown === text || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, STREAMING_RENDER_MS);
  }, [text, shown]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return <Markdown text={shown} className={className} />;
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return <div className={`markdown ${className}`.trim()}>
    {blocks.map((block, index) => <Block block={block} key={index} />)}
  </div>;
}
