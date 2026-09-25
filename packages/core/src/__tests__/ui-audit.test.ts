import { auditUI } from '../ui-audit.js';
import { normalizeUIInspection, type RawUIElement } from '../ui-semantics.js';

function element(overrides: Partial<RawUIElement> = {}): RawUIElement {
  return {
    ref: 'ref', path: 'game.Root.Item', className: 'Frame',
    absolutePosition: { x: 0, y: 0 }, absoluteSize: { x: 20, y: 20 },
    ...overrides,
  };
}

function audit(elements: RawUIElement[]) {
  return auditUI(normalizeUIInspection({ success: true, viewport: { x: 0, y: 0, width: 100, height: 100 }, elements }));
}

describe('auditUI', () => {
  test('reports every high-confidence code with deterministic summary and ordering', () => {
    const result = audit([
      element({ ref: 'overflow', path: 'game.Root.Overflow', className: 'TextLabel', textFits: false }),
      element({ ref: 'zero', path: 'game.Root.Zero', className: 'TextButton', absoluteSize: { x: 0, y: 10 } }),
      element({ ref: 'outside', path: 'game.Root.Outside', absolutePosition: { x: 120, y: 0 } }),
      element({ ref: 'clip', path: 'game.Root.Clip', clipsDescendants: true, absoluteSize: { x: 10, y: 10 } }),
      element({ ref: 'clipped-button', path: 'game.Root.Clip.Button', className: 'TextButton', parentRef: 'clip', absolutePosition: { x: 30, y: 0 } }),
      element({ ref: 'bad-render', path: 'game.Root.BadRender', absolutePosition: { x: Number.POSITIVE_INFINITY, y: 0 } }),
      element({ ref: 'bad-scroll', path: 'game.Root.BadScroll', className: 'ScrollingFrame', absoluteCanvasSize: { x: -1, y: 0 } }),
    ]);

    expect(result.success).toBe(true);
    expect(result.issues.map((item) => item.code).sort()).toEqual([
      'element_outside_viewport',
      'fully_clipped_interactive',
      'invalid_rendered_geometry',
      'invalid_scroll_geometry',
      'text_overflow',
      'zero_size_interactive',
    ]);
    expect(result.summary).toEqual({ total: 6, errors: 2, warnings: 4 });
    expect(result.issues).toEqual([...result.issues].sort((left, right) => {
      const a = `${left.severity}\u0000${left.code}\u0000${left.path ?? ''}\u0000${left.ref ?? ''}`;
      const b = `${right.severity}\u0000${right.code}\u0000${right.path ?? ''}\u0000${right.ref ?? ''}`;
      return a.localeCompare(b);
    }));
    expect(result.issues.every((item) => item.message.length > 0 && item.evidence)).toBe(true);
  });

  test('does not flag a valid visible button and preserves inspection failures', () => {
    const good = audit([
      element({ ref: 'good', path: 'game.Root.Good', className: 'TextButton', active: true, engineInteractable: true, textFits: true }),
    ]);
    expect(good).toMatchObject({ success: true, issues: [], summary: { total: 0, errors: 0, warnings: 0 } });

    const failed = auditUI(normalizeUIInspection({ success: false, error: { code: 'no_runtime' } }));
    expect(failed).toEqual({ success: false, error: { code: 'no_runtime' }, issues: [], summary: { total: 0, errors: 0, warnings: 0 } });
  });

  test('does not flag an interactive control intentionally below the fold in a scrolling window', () => {
    const result = audit([
      element({ ref: 'scroll', path: 'game.Root.Scroll', className: 'ScrollingFrame', absoluteSize: { x: 50, y: 50 }, absoluteWindowSize: { x: 50, y: 50 } }),
      element({ ref: 'below-fold', path: 'game.Root.Scroll.BelowFold', className: 'TextButton', parentRef: 'scroll', absolutePosition: { x: 0, y: 70 } }),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({ total: 0, errors: 0, warnings: 0 });
  });
});

describe('auditUI overlap and scroll reach', () => {
  // From a live "polished simulator shop": card titles under their badges, a
  // balance under its "+" button, "-20%" hanging off its price button, and a
  // bottom row past the end of the scroll. Every one passed the audit before.
  const card = (overrides: Partial<RawUIElement> = {}) => element({
    ref: 'card', path: 'game.Shop.Card', className: 'Frame', backgroundTransparency: 0,
    absolutePosition: { x: 0, y: 0 }, absoluteSize: { x: 100, y: 80 }, ...overrides,
  });
  const title = (overrides: Partial<RawUIElement> = {}) => element({
    ref: 'title', path: 'game.Shop.Card.Title', className: 'TextLabel', parentRef: 'card', backgroundTransparency: 1,
    absolutePosition: { x: 0, y: 0 }, absoluteSize: { x: 100, y: 20 }, textBounds: { x: 80, y: 14 },
    text: '1,000 Coins', textFits: true, ...overrides,
  });
  const badge = (overrides: Partial<RawUIElement> = {}) => element({
    ref: 'badge', path: 'game.Shop.Card.Badge', className: 'Frame', parentRef: 'card', backgroundTransparency: 0,
    absolutePosition: { x: 60, y: 0 }, absoluteSize: { x: 40, y: 18 }, ...overrides,
  });
  const codes = (result: ReturnType<typeof audit>) => result.issues.map((item) => `${item.code}:${item.ref}`);
  const viewport = (elements: RawUIElement[]) =>
    auditUI(normalizeUIInspection({ success: true, viewport: { x: 0, y: 0, width: 400, height: 400 }, elements }));

  test('a badge drawn over a title\'s letters is reported with what covers them', () => {
    const result = viewport([card(), title(), badge({ zIndex: 2 })]);
    expect(codes(result)).toEqual(['text_obscured:title']);
    expect(result.issues[0].evidence).toMatchObject({ coveredBy: 'game.Shop.Card.Badge' });
    // At equal ZIndex the inspection cannot say which is on top, but letters
    // partly under a badge collide either way.
    const unknown = viewport([card(), title(), badge()]);
    expect(codes(unknown)).toEqual(['text_straddles_edge:title']);
    expect(unknown.issues[0].evidence).toMatchObject({ drawOrder: 'unknown (equal ZIndex)' });
  });

  test('covering only the empty part of a label, or with nothing painted, is not reported', () => {
    // Left-aligned letters stop at x 80... here at 40, before the badge begins.
    expect(codes(viewport([card(), title({ textXAlignment: 'Left', textBounds: { x: 40, y: 14 } }), badge()]))).toEqual([]);
    // A transparent layout frame over the text paints nothing.
    expect(codes(viewport([card(), title(), badge({ backgroundTransparency: 1 })]))).toEqual([]);
    // An older plugin that does not report transparency is not guessed at.
    expect(codes(viewport([card(), title(), badge({ backgroundTransparency: undefined })]))).toEqual([]);
  });

  test('draw order decides who covers whom', () => {
    // A higher ZIndex on the title puts its letters on top, crossing onto the badge.
    const above = viewport([card(), title({ zIndex: 3 }), badge()]);
    expect(codes(above)).toEqual(['text_straddles_edge:title']);
    expect(above.issues[0].evidence).toMatchObject({ drawOrder: 'text above' });
    // Under Global behaviour ZIndex compares the elements themselves.
    const global = viewport([
      element({ ref: 'gui', path: 'game.Shop', className: 'ScreenGui', zIndexBehavior: 'Global', absoluteSize: { x: 400, y: 400 } }),
      card({ parentRef: 'gui' }), title({ zIndex: 5 }), badge({ zIndex: 2 }),
    ]);
    expect(codes(global)).toEqual(['text_straddles_edge:title']);
  });

  test('text on its own button, fully on a sibling background, or with its drop shadow is not reported', () => {
    const button = element({
      ref: 'buy', path: 'game.Shop.Card.Buy', className: 'TextButton', parentRef: 'card', backgroundTransparency: 0,
      absolutePosition: { x: 10, y: 50 }, absoluteSize: { x: 80, y: 24 }, textBounds: { x: 30, y: 14 }, text: '49',
    });
    const plate = element({
      ref: 'plate', path: 'game.Shop.Card.Plate', className: 'ImageLabel', parentRef: 'card', image: 'rbxassetid://1',
      absolutePosition: { x: 0, y: 20 }, absoluteSize: { x: 100, y: 30 },
    });
    const onPlate = element({
      ref: 'amount', path: 'game.Shop.Card.Amount', className: 'TextLabel', parentRef: 'card', backgroundTransparency: 1,
      absolutePosition: { x: 0, y: 25 }, absoluteSize: { x: 100, y: 20 }, textBounds: { x: 50, y: 14 }, text: 'x2',
    });
    const shadow = title({ ref: 'shadow', path: 'game.Shop.Card.TitleShadow', absolutePosition: { x: 2, y: 2 } });
    expect(codes(viewport([card(), plate, onPlate, button, shadow, title()]))).toEqual([]);
  });

  test('a label hanging off the edge of the button beneath it is reported', () => {
    const button = element({
      ref: 'buy', path: 'game.Shop.Card.Buy', className: 'ImageButton', parentRef: 'card', backgroundTransparency: 0,
      absolutePosition: { x: 20, y: 50 }, absoluteSize: { x: 70, y: 24 },
    });
    const discount = element({
      ref: 'discount', path: 'game.Shop.Card.Discount', className: 'TextLabel', parentRef: 'card', backgroundTransparency: 1,
      absolutePosition: { x: 0, y: 52 }, absoluteSize: { x: 40, y: 20 }, textBounds: { x: 36, y: 14 }, text: '-20%',
    });
    const result = viewport([card(), button, discount]);
    expect(codes(result)).toEqual(['text_straddles_edge:discount']);
    expect(result.issues[0].evidence).toMatchObject({ over: 'game.Shop.Card.Buy' });
  });

  test('content past the end of its scroll canvas is reported once, at its outermost piece', () => {
    const scroller = element({
      ref: 'scroll', path: 'game.Shop.Scroll', className: 'ScrollingFrame', clipsDescendants: true,
      absolutePosition: { x: 0, y: 0 }, absoluteSize: { x: 200, y: 100 },
      absoluteWindowSize: { x: 200, y: 100 }, absoluteCanvasSize: { x: 200, y: 100 }, canvasPosition: { x: 0, y: 0 },
    });
    const lastRow = element({
      ref: 'row', path: 'game.Shop.Scroll.Row', parentRef: 'scroll', absolutePosition: { x: 0, y: 70 }, absoluteSize: { x: 200, y: 50 },
    });
    const cardInRow = element({
      ref: 'pass', path: 'game.Shop.Scroll.Row.Pass', parentRef: 'row', absolutePosition: { x: 0, y: 70 }, absoluteSize: { x: 60, y: 50 },
    });
    const result = viewport([scroller, lastRow, cardInRow]);
    expect(codes(result)).toEqual(['content_beyond_scroll:row']);
    expect(result.issues[0].evidence).toMatchObject({ pastBottom: 20, pastRight: 0 });
    // A canvas tall enough to scroll to it is fine.
    const tall = viewport([element({ ...scroller, absoluteCanvasSize: { x: 200, y: 130 } }), lastRow, cardInRow]);
    expect(codes(tall).filter((code) => code.startsWith('content_beyond_scroll'))).toEqual([]);
  });
});
