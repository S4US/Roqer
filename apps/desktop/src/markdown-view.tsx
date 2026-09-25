import { Fragment, useMemo } from "react";
import { parseMarkdown, type InlineNode, type MarkdownBlock } from "./markdown";

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

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p><Inline nodes={block.children} /></p>;
    case "heading": {
      const Tag = `h${Math.min(4, block.level + 2)}` as "h3" | "h4" | "h5" | "h6";
      return <Tag><Inline nodes={block.children} /></Tag>;
    }
    case "code":
      return <pre className="md-code">
        {block.language && <span className="md-code-language">{block.language}</span>}
        <code>{block.value}</code>
      </pre>;
    case "list":
      return block.ordered
        ? <ol>{block.items.map((item, index) => <li key={index}><Inline nodes={item} /></li>)}</ol>
        : <ul>{block.items.map((item, index) => <li key={index}><Inline nodes={item} /></li>)}</ul>;
    case "quote":
      return <blockquote><Inline nodes={block.children} /></blockquote>;
    case "rule":
      return <hr />;
  }
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return <div className={`markdown ${className}`.trim()}>
    {blocks.map((block, index) => <Block block={block} key={index} />)}
  </div>;
}
