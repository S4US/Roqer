import type { NormalizedUIElement, NormalizedUIInspection, UIRect } from './ui-semantics.js';

export type UIAuditSeverity = 'error' | 'warning';

export type UIAuditCode =
  | 'text_overflow'
  | 'zero_size_interactive'
  | 'element_outside_viewport'
  | 'fully_clipped_interactive'
  | 'invalid_rendered_geometry'
  | 'invalid_scroll_geometry'
  | 'text_obscured'
  | 'text_straddles_edge'
  | 'content_beyond_scroll';

export interface UIAuditIssue {
  severity: UIAuditSeverity;
  code: UIAuditCode;
  ref?: string;
  path?: string;
  message: string;
  evidence: Record<string, unknown>;
}

export interface UIAuditSummary {
  total: number;
  errors: number;
  warnings: number;
}

export interface UIAuditResult {
  success: boolean;
  error?: unknown;
  issues: UIAuditIssue[];
  summary: UIAuditSummary;
}

function issue(element: NormalizedUIElement, severity: UIAuditSeverity, code: UIAuditCode, message: string, evidence: Record<string, unknown>): UIAuditIssue {
  return { severity, code, ref: element.ref, path: element.path, message, evidence };
}

function interactiveCandidate(element: NormalizedUIElement): boolean {
  return element.role === 'button' || element.role === 'input';
}

function compareIssues(left: UIAuditIssue, right: UIAuditIssue): number {
  const severity = left.severity.localeCompare(right.severity);
  if (severity !== 0) return severity;
  const code = left.code.localeCompare(right.code);
  if (code !== 0) return code;
  const path = (left.path ?? '').localeCompare(right.path ?? '');
  if (path !== 0) return path;
  return (left.ref ?? '').localeCompare(right.ref ?? '');
}

// -- Overlap -----------------------------------------------------------------
//
// A live shop UI passed every check above with card titles hidden under their
// badges, a balance running into its "+" button, a discount label hanging off
// its price button, and a bottom row the scroll could never reach. These
// checks measure those from rendered geometry. Text is judged by where its
// letters are (TextBounds placed by its alignment), not by its whole label box,
// and an element counts as covering only when it paints something there.

/** Covered or crossed ink below this share of the text is noise, not a defect. */
const MIN_INK_SHARE = 0.15;
const MIN_INK_AREA = 16;
/** Past this share, text sitting over an element is on it, not crossing its edge. */
const ON_ELEMENT_SHARE = 0.9;
const PAINTED_BELOW = 0.95;
const EDGE_SLACK = 2;

function intersect(a: UIRect, b: UIRect): UIRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const areaOf = (rect: UIRect | null) => (rect === null ? 0 : rect.width * rect.height);

function hasText(element: NormalizedUIElement): boolean {
  return element.role === 'text' || /^Text(Label|Button|Box)$/.test(element.className);
}

/** Where a text element's letters are drawn, from its TextBounds and alignment. */
function textInk(element: NormalizedUIElement): UIRect | null {
  if (!element.rect || !hasText(element) || (element.textTransparency ?? 0) >= PAINTED_BELOW) return null;
  const bounds = element.textBounds ?? element.textState?.bounds;
  if (!bounds || !(bounds.x > 0) || !(bounds.y > 0)) return null;
  const { rect } = element;
  const x = element.textXAlignment === 'Left' ? rect.x
    : element.textXAlignment === 'Right' ? rect.x + rect.width - bounds.x
      : rect.x + (rect.width - bounds.x) / 2;
  const y = element.textYAlignment === 'Top' ? rect.y
    : element.textYAlignment === 'Bottom' ? rect.y + rect.height - bounds.y
      : rect.y + (rect.height - bounds.y) / 2;
  return { x, y, width: bounds.x, height: bounds.y };
}

/** What an element paints on screen, or null when it paints nothing (or an older plugin did not say). */
function paintedRect(element: NormalizedUIElement): UIRect | null {
  if (!element.effectiveVisible || !element.rect) return null;
  const box = element.visibleRect ?? element.rect;
  if (element.backgroundTransparency !== undefined && element.backgroundTransparency < PAINTED_BELOW) return box;
  if ((element.image || element.imageContent) && (element.imageTransparency ?? 0) < PAINTED_BELOW) return box;
  return null;
}

class UITree {
  private readonly byRef = new Map<string, NormalizedUIElement>();

  constructor(readonly elements: readonly NormalizedUIElement[]) {
    for (const element of elements) if (element.ref) this.byRef.set(element.ref, element);
  }

  parent(element: NormalizedUIElement): NormalizedUIElement | undefined {
    return element.parentRef ? this.byRef.get(element.parentRef) : undefined;
  }

  /** The element and its ancestors, nearest first. */
  chain(element: NormalizedUIElement): NormalizedUIElement[] {
    const chain: NormalizedUIElement[] = [];
    for (let current: NormalizedUIElement | undefined = element; current && chain.length < 256; current = this.parent(current)) {
      chain.push(current);
    }
    return chain;
  }

  isAncestor(ancestor: NormalizedUIElement, element: NormalizedUIElement): boolean {
    return this.chain(element).slice(1).includes(ancestor);
  }

  /**
   * Whether `upper` draws above `lower`, when ZIndex decides it. Under the
   * default Sibling behaviour the branches that meet under their lowest common
   * ancestor are compared; under Global, the elements themselves. Equal ZIndex
   * leaves it to child order, which the inspection does not preserve (it sorts
   * by name), and elements in different ScreenGuis are not compared: both
   * return undefined rather than a guess.
   */
  drawsAbove(upper: NormalizedUIElement, lower: NormalizedUIElement): boolean | undefined {
    const upperChain = this.chain(upper);
    const lowerChain = this.chain(lower);
    const common = upperChain.find((node) => lowerChain.includes(node));
    if (!common) return undefined;
    const global = upperChain.some((node) => node.zIndexBehavior === 'Global');
    const [a, b] = global
      ? [upper, lower]
      : [upperChain[upperChain.indexOf(common) - 1], lowerChain[lowerChain.indexOf(common) - 1]];
    if (!a || !b) return undefined;
    const za = a.zIndex ?? 1;
    const zb = b.zIndex ?? 1;
    return za === zb ? undefined : za > zb;
  }

  nearestScroller(element: NormalizedUIElement): NormalizedUIElement | undefined {
    return this.chain(element).slice(1).find((node) => node.className === 'ScrollingFrame');
  }
}

/** A second label with the same letters just offset from the first: a drop shadow or stroke, drawn on purpose. */
function isShadowOf(other: NormalizedUIElement, text: NormalizedUIElement, otherInk: UIRect, ink: UIRect): boolean {
  const same = other.text !== undefined && text.text !== undefined
    ? other.text === text.text
    : Math.abs(otherInk.width - ink.width) <= 2 && Math.abs(otherInk.height - ink.height) <= 2;
  return same && Math.abs(otherInk.x - ink.x) <= 6 && Math.abs(otherInk.y - ink.y) <= 6;
}

function overlapIssues(tree: UITree): UIAuditIssue[] {
  const issues: UIAuditIssue[] = [];
  for (const text of tree.elements) {
    if (!text.effectiveVisible) continue;
    const fullInk = textInk(text);
    const ink = fullInk && text.visibleRect ? intersect(fullInk, text.visibleRect) : null;
    if (!fullInk || !ink || areaOf(ink) < MIN_INK_AREA) continue;
    let covered: { by: NormalizedUIElement; share: number } | undefined;
    let straddled: { by: NormalizedUIElement; share: number; above: boolean | undefined } | undefined;
    for (const other of tree.elements) {
      if (other === text || tree.isAncestor(other, text) || tree.isAncestor(text, other)) continue;
      const otherInk = textInk(other);
      const painted = paintedRect(other) ?? (other.effectiveVisible ? otherInk : null);
      if (!painted) continue;
      if (otherInk && !paintedRect(other) && isShadowOf(other, text, otherInk, fullInk)) continue;
      const share = areaOf(intersect(ink, painted)) / areaOf(ink);
      if (share < MIN_INK_SHARE) continue;
      const above = tree.drawsAbove(other, text);
      if (above === true) {
        if (!covered || share > covered.share) covered = { by: other, share };
      } else if (paintedRect(other) && share < ON_ELEMENT_SHARE) {
        // Partly on and partly off a painted element collides whichever is on top.
        if (!straddled || share > straddled.share) straddled = { by: other, share, above };
      }
    }
    if (covered) {
      issues.push(issue(text, 'warning', 'text_obscured', 'Text is covered by another element drawn above it.', {
        coveredBy: covered.by.path ?? covered.by.ref, coveredShare: Math.round(covered.share * 100) / 100,
      }));
    } else if (straddled) {
      issues.push(issue(text, 'warning', 'text_straddles_edge', 'Text crosses the edge of another painted element, partly on it and partly off.', {
        over: straddled.by.path ?? straddled.by.ref, shareOn: Math.round(straddled.share * 100) / 100,
        drawOrder: straddled.above === false ? 'text above' : 'unknown (equal ZIndex)',
      }));
    }
  }
  return issues;
}

/** An element past its ScrollingFrame's canvas: scrolling can never bring it into view. */
function beyondScrollIssues(tree: UITree): UIAuditIssue[] {
  const issues: UIAuditIssue[] = [];
  const beyond = new Set<NormalizedUIElement>();
  for (const element of tree.elements) {
    if (!element.rect || element.visible === false) continue;
    const scroller = tree.nearestScroller(element);
    if (!scroller?.rect || !scroller.absoluteCanvasSize) continue;
    const canvasLeft = scroller.rect.x - (scroller.canvasPosition?.x ?? 0);
    const canvasTop = scroller.rect.y - (scroller.canvasPosition?.y ?? 0);
    const overBottom = element.rect.y + element.rect.height - (canvasTop + scroller.absoluteCanvasSize.y);
    const overRight = element.rect.x + element.rect.width - (canvasLeft + scroller.absoluteCanvasSize.x);
    if (overBottom <= EDGE_SLACK && overRight <= EDGE_SLACK) continue;
    beyond.add(element);
    // Report the outermost piece only: a card past the canvas, not each of its children too.
    const parent = tree.parent(element);
    if (parent && beyond.has(parent)) continue;
    issues.push(issue(element, 'warning', 'content_beyond_scroll', 'Content extends past its ScrollingFrame canvas, where no scrolling can reach it.', {
      scrollingFrame: scroller.path ?? scroller.ref,
      pastBottom: Math.max(0, Math.round(overBottom)),
      pastRight: Math.max(0, Math.round(overRight)),
    }));
  }
  return issues;
}

/** Reports only explicit, high-confidence semantic UI defects. */
export function auditUI(normalized: NormalizedUIInspection): UIAuditResult {
  if (!normalized.success) {
    return { success: false, error: normalized.error, issues: [], summary: { total: 0, errors: 0, warnings: 0 } };
  }
  const issues: UIAuditIssue[] = [];
  for (const element of normalized.elements) {
    if (element.hasInvalidRenderedGeometry) {
      issues.push(issue(element, 'error', 'invalid_rendered_geometry', 'Rendered geometry is missing, non-finite, or negative.', { rect: element.rect }));
    }
    if (element.hasInvalidScrollGeometry) {
      issues.push(issue(element, 'error', 'invalid_scroll_geometry', 'ScrollingFrame canvas or window geometry is invalid.', {
        canvasPosition: element.canvasPosition,
        absoluteCanvasSize: element.absoluteCanvasSize,
        absoluteWindowSize: element.absoluteWindowSize,
      }));
    }
    if (element.textState && element.textState.fits === false) {
      issues.push(issue(element, 'warning', 'text_overflow', 'Text is explicitly reported as not fitting.', {
        fits: element.textState.fits,
      }));
    }
    if (interactiveCandidate(element) && element.effectiveVisible && element.rect && (element.rect.width === 0 || element.rect.height === 0)) {
      issues.push(issue(element, 'warning', 'zero_size_interactive', 'Interactive control has zero rendered width or height.', { rect: element.rect }));
    }
    if (element.effectiveVisible && element.rect && element.rect.width > 0 && element.rect.height > 0 && !element.insideViewport) {
      issues.push(issue(element, 'warning', 'element_outside_viewport', 'Visible element does not intersect the viewport.', { rect: element.rect }));
    }
    if (interactiveCandidate(element) && element.effectiveVisible && element.rect && element.clippedByAncestor && element.visibleRect === null && !element.requiresScrolling) {
      issues.push(issue(element, 'warning', 'fully_clipped_interactive', 'Interactive control is fully clipped by an ancestor.', { rect: element.rect }));
    }
  }
  const tree = new UITree(normalized.elements);
  issues.push(...overlapIssues(tree), ...beyondScrollIssues(tree));
  issues.sort(compareIssues);
  return {
    success: true,
    issues,
    summary: {
      total: issues.length,
      errors: issues.filter((item) => item.severity === 'error').length,
      warnings: issues.filter((item) => item.severity === 'warning').length,
    },
  };
}
