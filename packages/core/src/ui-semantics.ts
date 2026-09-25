export interface UIVector {
  x: number;
  y: number;
}

export interface UIRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UIViewport extends UIRect {
  insetTopLeft?: UIVector;
  insetBottomRight?: UIVector;
}

export interface RawUIElement {
  ref?: unknown;
  path?: unknown;
  name?: unknown;
  className?: unknown;
  parentRef?: unknown;
  parentPath?: unknown;
  semanticParentRef?: unknown;
  semanticParentPath?: unknown;
  depth?: unknown;
  visible?: unknown;
  enabled?: unknown;
  absolutePosition?: unknown;
  absoluteSize?: unknown;
  absoluteRotation?: unknown;
  active?: unknown;
  engineInteractable?: unknown;
  /** Studio-side engine hit-test result; omitted by older plugin builds. */
  inputActionable?: unknown;
  selectable?: unknown;
  zIndex?: unknown;
  backgroundTransparency?: unknown;
  layoutOrder?: unknown;
  clipsDescendants?: unknown;
  anchorPoint?: unknown;
  rotation?: unknown;
  text?: unknown;
  contentText?: unknown;
  textContent?: unknown;
  textSize?: unknown;
  textBounds?: unknown;
  textFits?: unknown;
  textWrapped?: unknown;
  textScaled?: unknown;
  textTransparency?: unknown;
  textXAlignment?: unknown;
  textYAlignment?: unknown;
  textColor3?: unknown;
  fontFace?: unknown;
  image?: unknown;
  imageContent?: unknown;
  imageTransparency?: unknown;
  imageColor3?: unknown;
  canvasPosition?: unknown;
  absoluteCanvasSize?: unknown;
  absoluteWindowSize?: unknown;
  scrollingDirection?: unknown;
  canScrollHorizontal?: unknown;
  canScrollVertical?: unknown;
  canvasSize?: unknown;
  scrollingWindow?: unknown;
  ignoreGuiInset?: unknown;
  screenInsets?: unknown;
  clipToDeviceSafeArea?: unknown;
  displayOrder?: unknown;
  zIndexBehavior?: unknown;
  [key: string]: unknown;
}

export interface RawUIInspection {
  success?: unknown;
  source?: unknown;
  root?: unknown;
  viewport?: unknown;
  elements?: unknown;
  contextElements?: unknown;
  limits?: unknown;
  truncation?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export type UIRole = 'button' | 'text' | 'image' | 'input' | 'scroll_container' | 'viewport' | 'container' | 'gui';

export interface NormalizedUIText {
  content?: string;
  contentText?: string;
  bounds?: UIVector;
  fits?: boolean;
  wrapped?: boolean;
  scaled?: boolean;
  transparency?: number;
}

export interface NormalizedUIStyles {
  absoluteRotation?: number;
  zIndex?: number;
  layoutOrder?: number;
  anchorPoint?: UIVector;
  rotation?: number;
  selectable?: boolean;
}

export interface NormalizedUIElement {
  ref?: string;
  path?: string;
  name?: string;
  className: string;
  parentRef?: string;
  parentPath?: string;
  semanticParentRef?: string;
  semanticParentPath?: string;
  depth?: number;
  role: UIRole;
  visible?: boolean;
  enabled?: boolean;
  active?: boolean;
  engineInteractable?: boolean;
  selectable?: boolean;
  zIndex?: number;
  backgroundTransparency?: number;
  layoutOrder?: number;
  clipsDescendants?: boolean;
  anchorPoint?: UIVector;
  rotation?: number;
  absoluteRotation?: number;
  ignoreGuiInset?: boolean;
  screenInsets?: string;
  clipToDeviceSafeArea?: boolean;
  displayOrder?: number;
  /** A ScreenGui's ZIndexBehavior: `Sibling` (the default) or `Global`. */
  zIndexBehavior?: string;
  text?: string;
  contentText?: string;
  textSize?: number;
  textBounds?: UIVector;
  textFits?: boolean;
  textWrapped?: boolean;
  textScaled?: boolean;
  textTransparency?: number;
  textXAlignment?: string;
  textYAlignment?: string;
  textColor3?: Record<string, unknown>;
  fontFace?: Record<string, unknown>;
  image?: string;
  imageContent?: string;
  imageTransparency?: number;
  imageColor3?: Record<string, unknown>;
  canvasPosition?: UIVector;
  absoluteCanvasSize?: UIVector;
  absoluteWindowSize?: UIVector;
  scrollingDirection?: string;
  canScrollHorizontal?: boolean;
  canScrollVertical?: boolean;
  rect: UIRect | null;
  effectiveVisible: boolean;
  visibleRect: UIRect | null;
  visibleFraction: number;
  insideViewport: boolean;
  clipped: boolean;
  inScrollingWindow: boolean;
  requiresScrolling: boolean;
  interactable: boolean;
  hasInvalidRenderedGeometry: boolean;
  hasInvalidScrollGeometry: boolean;
  textState?: NormalizedUIText;
  styles?: NormalizedUIStyles;
  /** Internal audit detail, kept semantic rather than raw engine state. */
  clippedByAncestor: boolean;
}

export interface NormalizedUIInspectionSuccess {
  success: true;
  source?: unknown;
  root?: unknown;
  viewport: UIViewport | null;
  elements: NormalizedUIElement[];
  limits?: unknown;
  truncation?: unknown;
}

export interface NormalizedUIInspectionFailure {
  success: false;
  error?: unknown;
  [key: string]: unknown;
}

export type NormalizedUIInspection = NormalizedUIInspectionSuccess | NormalizedUIInspectionFailure;

export interface NormalizeUIInspectionOptions {
  visibleOnly?: boolean;
  includeText?: boolean;
  includeStyles?: boolean;
}

export interface UISnapshotElement {
  ref?: string;
  path?: string;
  className: string;
  role: UIRole;
  rect: UIRect | null;
  visibleRect: UIRect | null;
  effectiveVisible: boolean;
  visibleFraction: number;
  insideViewport: boolean;
  clipped: boolean;
  inScrollingWindow: boolean;
  requiresScrolling: boolean;
  interactable: boolean;
  text?: NormalizedUIText;
}

export interface UISnapshotSuccess {
  success: true;
  root?: unknown;
  viewport: UIViewport | null;
  truncation?: unknown;
  elements: UISnapshotElement[];
}

export type UISnapshot = UISnapshotSuccess | NormalizedUIInspectionFailure;

interface DerivedElement {
  raw: RawUIElement;
  element: NormalizedUIElement;
  returned: boolean;
  rect: UIRect | null;
  hasGeometryFacts: boolean;
  geometryInvalid: boolean;
  scrollWindow: UIRect | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function vector(value: unknown): UIVector | undefined {
  if (!isRecord(value)) return undefined;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function rect(value: unknown): UIRect | undefined {
  if (!isRecord(value)) return undefined;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

function rawRect(value: unknown): UIRect | undefined {
  const direct = rect(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  const position = vector(value.position ?? value.absolutePosition);
  const size = vector(value.size ?? value.absoluteSize);
  if (!position || !size || size.x < 0 || size.y < 0) return undefined;
  return { x: position.x, y: position.y, width: size.x, height: size.y };
}

function viewportRect(value: unknown): UIViewport | undefined {
  if (!isRecord(value)) return undefined;
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (width === undefined || height === undefined || width < 0 || height < 0) return rawRect(value);
  const x = finiteNumber(value.x) ?? 0;
  const y = finiteNumber(value.y) ?? 0;
  return {
    x, y, width, height,
    insetTopLeft: vector(value.insetTopLeft),
    insetBottomRight: vector(value.insetBottomRight),
  };
}

function renderedRect(raw: RawUIElement): UIRect | undefined {
  const position = vector(raw.absolutePosition);
  const size = vector(raw.absoluteSize);
  if (!position || !size || size.x < 0 || size.y < 0) return undefined;
  return { x: position.x, y: position.y, width: size.x, height: size.y };
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function intersects(first: UIRect, second: UIRect): UIRect | null {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function contains(outer: UIRect, inner: UIRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}

function equalRect(first: UIRect, second: UIRect): boolean {
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

function area(value: UIRect): number {
  return value.width * value.height;
}

function roleFor(className: string): UIRole {
  if (className === 'TextButton' || className === 'ImageButton') return 'button';
  if (className === 'TextBox') return 'input';
  if (className === 'TextLabel') return 'text';
  if (className === 'ImageLabel') return 'image';
  if (className === 'ScrollingFrame') return 'scroll_container';
  if (className === 'ScreenGui' || className === 'ViewportFrame') return 'viewport';
  if (className === 'Frame' || className === 'CanvasGroup' || className === 'BillboardGui' || className === 'SurfaceGui') return 'container';
  return className.endsWith('Gui') ? 'gui' : 'container';
}

function compareElements(left: RawUIElement, right: RawUIElement): number {
  const keys = [
    stringValue(left.path) ?? '', stringValue(left.ref) ?? '', stringValue(left.className) ?? '', stringValue(left.name) ?? '',
    stringValue(right.path) ?? '', stringValue(right.ref) ?? '', stringValue(right.className) ?? '', stringValue(right.name) ?? '',
  ];
  for (let index = 0; index < 4; index++) {
    const comparison = keys[index].localeCompare(keys[index + 4]);
    if (comparison !== 0) return comparison;
  }
  const depth = (finiteNumber(left.depth) ?? 0) - (finiteNumber(right.depth) ?? 0);
  if (depth !== 0) return depth;
  const leftPosition = vector(left.absolutePosition);
  const rightPosition = vector(right.absolutePosition);
  const parentPath = (stringValue(left.parentPath) ?? '').localeCompare(stringValue(right.parentPath) ?? '');
  if (parentPath !== 0) return parentPath;
  const parentRef = (stringValue(left.parentRef) ?? '').localeCompare(stringValue(right.parentRef) ?? '');
  if (parentRef !== 0) return parentRef;
  const positionX = (leftPosition?.x ?? Number.NEGATIVE_INFINITY) - (rightPosition?.x ?? Number.NEGATIVE_INFINITY);
  if (positionX !== 0) return positionX;
  const positionY = (leftPosition?.y ?? Number.NEGATIVE_INFINITY) - (rightPosition?.y ?? Number.NEGATIVE_INFINITY);
  if (positionY !== 0) return positionY;
  const leftSize = vector(left.absoluteSize);
  const rightSize = vector(right.absoluteSize);
  return (leftSize?.x ?? Number.NEGATIVE_INFINITY) - (rightSize?.x ?? Number.NEGATIVE_INFINITY) ||
    (leftSize?.y ?? Number.NEGATIVE_INFINITY) - (rightSize?.y ?? Number.NEGATIVE_INFINITY) ||
    (stringValue(left.textContent) ?? stringValue(left.text) ?? '').localeCompare(stringValue(right.textContent) ?? stringValue(right.text) ?? '');
}

function textFor(raw: RawUIElement): NormalizedUIText | undefined {
  const compound = isRecord(raw.text) ? raw.text : undefined;
  const content = stringValue(raw.text) ?? stringValue(raw.textContent) ?? stringValue(compound?.content);
  const contentText = stringValue(raw.contentText);
  const bounds = vector(raw.textBounds) ?? vector(compound?.bounds);
  const fits = booleanValue(raw.textFits) ?? booleanValue(compound?.fits);
  const wrapped = booleanValue(raw.textWrapped);
  const scaled = booleanValue(raw.textScaled);
  const transparency = finiteNumber(raw.textTransparency);
  if (content === undefined && contentText === undefined && !bounds && fits === undefined && wrapped === undefined && scaled === undefined && transparency === undefined) return undefined;
  return { content, contentText, bounds, fits, wrapped, scaled, transparency };
}

function stylesFor(raw: RawUIElement): NormalizedUIStyles | undefined {
  const styles: NormalizedUIStyles = {
    absoluteRotation: finiteNumber(raw.absoluteRotation),
    zIndex: finiteNumber(raw.zIndex),
    layoutOrder: finiteNumber(raw.layoutOrder),
    anchorPoint: vector(raw.anchorPoint),
    rotation: finiteNumber(raw.rotation),
    selectable: booleanValue(raw.selectable),
  };
  return Object.values(styles).some((value) => value !== undefined) ? styles : undefined;
}

function scrollingWindowFor(raw: RawUIElement, fallback: UIRect | null): UIRect | null {
  if (raw.scrollingWindow !== undefined) return rawRect(raw.scrollingWindow) ?? null;
  const window = vector(raw.absoluteWindowSize);
  if (window && window.x >= 0 && window.y >= 0 && fallback) {
    return { x: fallback.x, y: fallback.y, width: window.x, height: window.y };
  }
  return fallback;
}

function isScrollGeometryInvalid(raw: RawUIElement): boolean {
  if (stringValue(raw.className) !== 'ScrollingFrame') return false;
  const hasCanvasPosition = hasOwn(raw, 'canvasPosition');
  const hasCanvasSize = hasOwn(raw, 'absoluteCanvasSize') || hasOwn(raw, 'canvasSize');
  const canvasSize = raw.absoluteCanvasSize ?? raw.canvasSize;
  const hasWindowSize = hasOwn(raw, 'absoluteWindowSize');
  const hasWindow = hasOwn(raw, 'scrollingWindow');
  return (hasCanvasPosition && !vector(raw.canvasPosition)) ||
    (hasCanvasSize && (!vector(canvasSize) || (vector(canvasSize)?.x ?? 0) < 0 || (vector(canvasSize)?.y ?? 0) < 0)) ||
    (hasWindowSize && (!vector(raw.absoluteWindowSize) || (vector(raw.absoluteWindowSize)?.x ?? 0) < 0 || (vector(raw.absoluteWindowSize)?.y ?? 0) < 0)) ||
    (hasWindow && !rawRect(raw.scrollingWindow));
}

function parentFor(item: DerivedElement, byRef: Map<string, DerivedElement>, byPath: Map<string, DerivedElement>): DerivedElement | undefined {
  const semanticRef = stringValue(item.raw.semanticParentRef);
  const semanticPath = stringValue(item.raw.semanticParentPath);
  const ref = stringValue(item.raw.parentRef);
  const path = stringValue(item.raw.parentPath);
  return (semanticRef ? byRef.get(semanticRef) : undefined) ??
    (semanticPath ? byPath.get(semanticPath) : undefined) ??
    (ref ? byRef.get(ref) : undefined) ??
    (path ? byPath.get(path) : undefined);
}

/**
 * Converts engine facts into a deterministic, comparison-friendly UI model. It is deliberately
 * tolerant of partial responses: unusable geometry becomes null rather than throwing.
 */
export function normalizeUIInspection(raw: RawUIInspection, options: NormalizeUIInspectionOptions = {}): NormalizedUIInspection {
  if (!isRecord(raw)) return { success: false, error: raw };
  if (raw.success === false || raw.error !== undefined && raw.success !== true) {
    return { ...raw, success: false };
  }

  const viewport = viewportRect(raw.viewport) ?? null;
  const geometryViewport = viewport ? {
    x: viewport.x - (viewport.insetTopLeft?.x ?? 0),
    y: viewport.y - (viewport.insetTopLeft?.y ?? 0),
    width: viewport.width,
    height: viewport.height,
  } : null;
  const returnedRawElements = Array.isArray(raw.elements)
    ? raw.elements.filter(isRecord).map((value) => value as RawUIElement).sort(compareElements)
    : [];
  const contextRawElements = Array.isArray(raw.contextElements)
    ? raw.contextElements.filter(isRecord).map((value) => value as RawUIElement).sort(compareElements)
    : [];
  const derived: DerivedElement[] = [...returnedRawElements.map((item) => ({ item, returned: true })), ...contextRawElements.map((item) => ({ item, returned: false }))].map(({ item, returned }) => {
    const className = stringValue(item.className) ?? '';
    const geometryFacts = hasOwn(item, 'absolutePosition') || hasOwn(item, 'absoluteSize');
    const elementRect = renderedRect(item) ?? null;
    const geometryInvalid = geometryFacts && !elementRect;
    const element: NormalizedUIElement = {
      ref: stringValue(item.ref),
      path: stringValue(item.path),
      name: stringValue(item.name),
      className,
      parentRef: stringValue(item.parentRef),
      parentPath: stringValue(item.parentPath),
      semanticParentRef: stringValue(item.semanticParentRef),
      semanticParentPath: stringValue(item.semanticParentPath),
      depth: finiteNumber(item.depth),
      role: roleFor(className),
      visible: booleanValue(item.visible),
      enabled: booleanValue(item.enabled),
      active: booleanValue(item.active),
      engineInteractable: booleanValue(item.engineInteractable),
      selectable: booleanValue(item.selectable),
      zIndex: finiteNumber(item.zIndex),
      backgroundTransparency: finiteNumber(item.backgroundTransparency),
      layoutOrder: finiteNumber(item.layoutOrder),
      clipsDescendants: booleanValue(item.clipsDescendants),
      anchorPoint: vector(item.anchorPoint),
      rotation: finiteNumber(item.rotation),
      absoluteRotation: finiteNumber(item.absoluteRotation),
      ignoreGuiInset: booleanValue(item.ignoreGuiInset),
      screenInsets: stringValue(item.screenInsets),
      clipToDeviceSafeArea: booleanValue(item.clipToDeviceSafeArea),
      displayOrder: finiteNumber(item.displayOrder),
      zIndexBehavior: stringValue(item.zIndexBehavior),
      text: options.includeText === false ? undefined : stringValue(item.text) ?? stringValue(item.textContent),
      contentText: options.includeText === false ? undefined : stringValue(item.contentText),
      textSize: finiteNumber(item.textSize),
      textBounds: vector(item.textBounds),
      textFits: booleanValue(item.textFits),
      textWrapped: booleanValue(item.textWrapped),
      textScaled: booleanValue(item.textScaled),
      textTransparency: finiteNumber(item.textTransparency),
      textXAlignment: stringValue(item.textXAlignment),
      textYAlignment: stringValue(item.textYAlignment),
      textColor3: options.includeStyles === false || !isRecord(item.textColor3) ? undefined : item.textColor3,
      fontFace: options.includeStyles === false || !isRecord(item.fontFace) ? undefined : item.fontFace,
      image: stringValue(item.image),
      imageContent: stringValue(item.imageContent),
      imageTransparency: finiteNumber(item.imageTransparency),
      imageColor3: options.includeStyles === false || !isRecord(item.imageColor3) ? undefined : item.imageColor3,
      canvasPosition: vector(item.canvasPosition),
      absoluteCanvasSize: vector(item.absoluteCanvasSize) ?? vector(item.canvasSize),
      absoluteWindowSize: vector(item.absoluteWindowSize),
      scrollingDirection: stringValue(item.scrollingDirection),
      canScrollHorizontal: booleanValue(item.canScrollHorizontal),
      canScrollVertical: booleanValue(item.canScrollVertical),
      rect: elementRect,
      effectiveVisible: false,
      visibleRect: null,
      visibleFraction: 0,
      insideViewport: false,
      clipped: false,
      inScrollingWindow: false,
      requiresScrolling: false,
      interactable: false,
      hasInvalidRenderedGeometry: geometryInvalid,
      hasInvalidScrollGeometry: isScrollGeometryInvalid(item),
      textState: textFor({
        ...item,
        text: options.includeText === false ? undefined : item.text,
        textContent: options.includeText === false ? undefined : item.textContent,
        contentText: options.includeText === false ? undefined : item.contentText,
      }),
      styles: options.includeStyles === false ? undefined : stylesFor(item),
      clippedByAncestor: false,
    };
    return { raw: item, element, returned, rect: elementRect, hasGeometryFacts: geometryFacts, geometryInvalid, scrollWindow: scrollingWindowFor(item, elementRect) };
  });

  const byRef = new Map<string, DerivedElement>();
  const byPath = new Map<string, DerivedElement>();
  for (const item of derived) {
    if (item.element.ref && !byRef.has(item.element.ref)) byRef.set(item.element.ref, item);
    if (item.element.path && !byPath.has(item.element.path)) byPath.set(item.element.path, item);
  }

  for (const item of derived) {
    const ancestors: DerivedElement[] = [];
    const seen = new Set<DerivedElement>([item]);
    for (let parent = parentFor(item, byRef, byPath); parent && !seen.has(parent); parent = parentFor(parent, byRef, byPath)) {
      ancestors.push(parent);
      seen.add(parent);
    }
    const lineage = [...ancestors, item];
    item.element.effectiveVisible = lineage.every((entry) => {
      const className = stringValue(entry.raw.className);
      if (className === 'ScreenGui' && booleanValue(entry.raw.enabled) === false) return false;
      return booleanValue(entry.raw.visible) !== false;
    });

    if (!item.rect || !item.element.effectiveVisible) continue;
    let visible = item.rect;
    let clipped = false;
    let ancestorClipped = false;
    let inScrollingWindow = false;
    let requiresScrolling = false;
    if (geometryViewport) {
      const next = intersects(visible, geometryViewport);
      if (!next || !equalRect(next, visible)) clipped = true;
      visible = next ?? { x: 0, y: 0, width: 0, height: 0 };
      item.element.insideViewport = next !== null;
    } else {
      item.element.insideViewport = true;
    }

    for (const ancestor of ancestors) {
      if (!visible.width || !visible.height) break;
      const ancestorIsScroll = ancestor.element.role === 'scroll_container';
      const shouldClip = booleanValue(ancestor.raw.clipsDescendants) === true || ancestorIsScroll;
      if (!shouldClip) continue;
      const boundary = ancestorIsScroll ? ancestor.scrollWindow : ancestor.rect;
      if (!boundary) continue;
      if (ancestorIsScroll) {
        inScrollingWindow = true;
        if (!contains(boundary, item.rect)) requiresScrolling = true;
      }
      const next = intersects(visible, boundary);
      if (!next || !equalRect(next, visible)) {
        clipped = true;
        ancestorClipped = true;
      }
      visible = next ?? { x: 0, y: 0, width: 0, height: 0 };
    }

    const visibleRect = visible.width > 0 && visible.height > 0 ? visible : null;
    item.element.visibleRect = visibleRect;
    item.element.visibleFraction = visibleRect && area(item.rect) > 0 ? Math.max(0, Math.min(1, area(visibleRect) / area(item.rect))) : 0;
    item.element.clipped = clipped;
    item.element.clippedByAncestor = ancestorClipped;
    item.element.inScrollingWindow = inScrollingWindow;
    item.element.requiresScrolling = requiresScrolling;
    item.element.interactable = (item.element.role === 'button' || item.element.role === 'input') &&
      booleanValue(item.raw.engineInteractable) !== false && booleanValue(item.raw.active) !== false &&
      booleanValue(item.raw.inputActionable) !== false && visibleRect !== null;
  }

  const elements = derived.filter((item) => item.returned).map((item) => item.element)
    .filter((item) => !options.visibleOnly || item.effectiveVisible && item.visibleRect !== null);
  return {
    success: true,
    source: raw.source,
    root: raw.root,
    viewport,
    elements,
    limits: raw.limits,
    truncation: raw.truncation,
  };
}

/** Creates a small, stable representation for UI comparisons and regression baselines. */
export function createUISnapshot(normalized: NormalizedUIInspection): UISnapshot {
  if (!normalized.success) return normalized;
  return {
    success: true,
    root: normalized.root,
    viewport: normalized.viewport,
    truncation: normalized.truncation,
    elements: normalized.elements
      .map((element) => ({
        ref: element.ref,
        path: element.path,
        className: element.className,
        role: element.role,
        rect: element.rect,
        visibleRect: element.visibleRect,
        effectiveVisible: element.effectiveVisible,
        visibleFraction: element.visibleFraction,
        insideViewport: element.insideViewport,
        clipped: element.clipped,
        inScrollingWindow: element.inScrollingWindow,
        requiresScrolling: element.requiresScrolling,
        interactable: element.interactable,
        text: element.textState,
      }))
      .sort((left, right) => `${left.path ?? ''}\u0000${left.ref ?? ''}`.localeCompare(`${right.path ?? ''}\u0000${right.ref ?? ''}`)),
  };
}
