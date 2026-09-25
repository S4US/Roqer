import {
  createUISnapshot,
  normalizeUIInspection,
  type RawUIElement,
} from '../ui-semantics.js';

function element(overrides: Partial<RawUIElement> = {}): RawUIElement {
  return {
    ref: 'ref',
    path: 'game.PlayerGui.Root.Item',
    name: 'Item',
    className: 'Frame',
    absolutePosition: { x: 0, y: 0 },
    absoluteSize: { x: 20, y: 20 },
    ...overrides,
  };
}

function inspection(elements: RawUIElement[], viewport = { x: 0, y: 0, width: 100, height: 100 }) {
  return { success: true, source: 'client', root: 'game.PlayerGui.Root', viewport, elements };
}

describe('normalizeUIInspection', () => {
  test('honors hidden ancestors and disabled ScreenGuis', () => {
    const result = normalizeUIInspection(inspection([
      element({ ref: 'screen', path: 'game.PlayerGui.Root', className: 'ScreenGui', enabled: false }),
      element({ ref: 'hidden', path: 'game.PlayerGui.Root.Hidden', visible: false }),
      element({ ref: 'nested', path: 'game.PlayerGui.Root.Hidden.Button', className: 'TextButton', parentRef: 'hidden' }),
      element({ ref: 'screen-child', path: 'game.PlayerGui.Root.ScreenButton', className: 'TextButton', parentRef: 'screen' }),
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements.find((item) => item.ref === 'nested')?.effectiveVisible).toBe(false);
    expect(result.elements.find((item) => item.ref === 'screen-child')?.effectiveVisible).toBe(false);
    expect(result.elements.find((item) => item.ref === 'nested')?.visibleRect).toBeNull();
  });

  test('uses context-only ancestors for a selected root without returning them', () => {
    const withContext = normalizeUIInspection({
      success: true,
      viewport: { width: 100, height: 100 },
      elements: [element({ ref: 'selected', path: 'game.PlayerGui.Screen.Selected.Button', className: 'TextButton', semanticParentRef: 'screen' })],
      contextElements: [element({ ref: 'screen', path: 'game.PlayerGui.Screen', className: 'ScreenGui', enabled: false })],
    });

    expect(withContext.success).toBe(true);
    if (!withContext.success) return;
    expect(withContext.elements).toHaveLength(1);
    expect(withContext.elements[0]).toMatchObject({ ref: 'selected', effectiveVisible: false, visibleRect: null });
    expect(withContext.elements.map((item) => item.ref)).not.toContain('screen');
  });

  test('uses GUI inset coordinates when clipping rendered bounds', () => {
    const result = normalizeUIInspection({
      success: true,
      viewport: { width: 100, height: 100, insetTopLeft: { x: 0, y: 20 } },
      elements: [element({
        ref: 'button',
        path: 'game.PlayerGui.Screen.Button',
        className: 'TextButton',
        absolutePosition: { x: 10, y: -10 },
        absoluteSize: { x: 40, y: 20 },
      })],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.viewport).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
    expect(result.elements[0]).toMatchObject({
      effectiveVisible: true,
      visibleRect: { x: 10, y: -10, width: 40, height: 20 },
      visibleFraction: 1,
    });
  });

  test('prefers semantic parents over non-GUI actual parents for external clipping ancestors', () => {
    const result = normalizeUIInspection({
      success: true,
      viewport: { width: 100, height: 100 },
      elements: [element({
        ref: 'button', path: 'game.PlayerGui.Screen.Clip.Folder.Button', className: 'TextButton',
        parentRef: 'folder', semanticParentRef: 'clip', absolutePosition: { x: 60, y: 0 },
      })],
      contextElements: [
        element({ ref: 'folder', path: 'game.PlayerGui.Screen.Clip.Folder', className: 'Folder', parentRef: 'clip' }),
        element({ ref: 'clip', path: 'game.PlayerGui.Screen.Clip', className: 'Frame', clipsDescendants: true, absoluteSize: { x: 50, y: 50 } }),
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      semanticParentRef: 'clip', visibleRect: null, clipped: true, clippedByAncestor: true,
    });
    expect(createUISnapshot(result).success && createUISnapshot(result).elements).toHaveLength(1);
  });

  test('clips through ancestors and calculates a bounded visible fraction', () => {
    const result = normalizeUIInspection(inspection([
      element({ ref: 'clip', path: 'game.Root.Clip', clipsDescendants: true, absoluteSize: { x: 50, y: 50 } }),
      element({ ref: 'child', path: 'game.Root.Clip.Child', className: 'TextButton', parentRef: 'clip', absoluteSize: { x: 100, y: 50 } }),
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements.find((item) => item.ref === 'child')).toMatchObject({
      visibleRect: { x: 0, y: 0, width: 50, height: 50 },
      visibleFraction: 0.5,
      clipped: true,
      interactable: true,
    });
  });

  test('tracks viewport intersection and offscreen elements', () => {
    const result = normalizeUIInspection(inspection([
      element({ ref: 'partial', path: 'game.Root.Partial', absolutePosition: { x: 80, y: 0 }, absoluteSize: { x: 40, y: 20 } }),
      element({ ref: 'outside', path: 'game.Root.Outside', absolutePosition: { x: 150, y: 0 } }),
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements.find((item) => item.ref === 'partial')).toMatchObject({ insideViewport: true, visibleFraction: 0.5 });
    expect(result.elements.find((item) => item.ref === 'outside')).toMatchObject({ insideViewport: false, visibleRect: null, visibleFraction: 0 });
  });

  test('uses ScrollingFrame windows as clipping boundaries and marks content requiring scrolling', () => {
    const result = normalizeUIInspection(inspection([
      element({
        ref: 'scroll', path: 'game.Root.Scroll', className: 'ScrollingFrame',
        absoluteSize: { x: 50, y: 50 }, canvasPosition: { x: 0, y: 0 },
        absoluteCanvasSize: { x: 50, y: 200 }, absoluteWindowSize: { x: 50, y: 50 },
      }),
      element({
        ref: 'below-fold', path: 'game.Root.Scroll.BelowFold', className: 'TextButton', parentRef: 'scroll',
        absolutePosition: { x: 0, y: 70 }, absoluteSize: { x: 20, y: 20 },
      }),
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements.find((item) => item.ref === 'below-fold')).toMatchObject({
      inScrollingWindow: true,
      requiresScrolling: true,
      visibleRect: null,
      clipped: true,
    });
  });

  test('derives stable roles and only marks visible enabled controls as interactable', () => {
    const result = normalizeUIInspection(inspection([
      element({ ref: 'button', path: 'game.Root.Button', className: 'TextButton' }),
      element({ ref: 'input', path: 'game.Root.Input', className: 'TextBox', active: false }),
      element({ ref: 'image', path: 'game.Root.Image', className: 'ImageLabel' }),
      element({ ref: 'label', path: 'game.Root.Label', className: 'TextLabel' }),
      element({ ref: 'scroll', path: 'game.Root.Scroll', className: 'ScrollingFrame' }),
      element({ ref: 'screen', path: 'game.Root.Screen', className: 'ScreenGui' }),
      element({ ref: 'viewport', path: 'game.Root.Viewport', className: 'ViewportFrame' }),
      element({ ref: 'frame', path: 'game.Root.Frame', className: 'Frame' }),
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const roles = Object.fromEntries(result.elements.map((item) => [item.ref, item.role]));
    expect(roles).toEqual({ button: 'button', frame: 'container', image: 'image', input: 'input', label: 'text', screen: 'viewport', scroll: 'scroll_container', viewport: 'viewport' });
    expect(result.elements.find((item) => item.ref === 'button')?.interactable).toBe(true);
    expect(result.elements.find((item) => item.ref === 'input')?.interactable).toBe(false);
  });

  test('uses the raw inputActionable hit-test result without changing the public interactable field', () => {
    const result = normalizeUIInspection(inspection([
      element({ ref: 'missing', path: 'game.Root.Missing', className: 'TextButton', active: true, engineInteractable: true }),
      element({ ref: 'actionable', path: 'game.Root.Actionable', className: 'TextButton', active: true, engineInteractable: true, inputActionable: true }),
      element({ ref: 'occluded', path: 'game.Root.Occluded', className: 'TextButton', active: true, engineInteractable: true, inputActionable: false }),
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements.find((item) => item.ref === 'missing')?.interactable).toBe(true);
    expect(result.elements.find((item) => item.ref === 'actionable')?.interactable).toBe(true);
    expect(result.elements.find((item) => item.ref === 'occluded')?.interactable).toBe(false);
    expect(result.elements.find((item) => item.ref === 'occluded')).not.toHaveProperty('inputActionable');
  });

  test('filters only after all visibility derivation and can omit text/style facts', () => {
    const result = normalizeUIInspection(inspection([
      element({ ref: 'visible', path: 'game.Root.Visible', className: 'TextLabel', text: 'Hello', textSize: 18, image: 'rbxasset://icon', zIndex: 4 }),
      element({ ref: 'hidden', path: 'game.Root.Hidden', visible: false, className: 'TextLabel', text: 'Nope' }),
    ]), { visibleOnly: true, includeText: false, includeStyles: false });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.elements.map((item) => item.ref)).toEqual(['visible']);
    expect(result.elements[0].text).toBeUndefined();
    expect(result.elements[0].textSize).toBe(18);
    expect(result.elements[0].image).toBe('rbxasset://icon');
    expect(result.elements[0].styles).toBeUndefined();
  });

  test('preserves Studio viewport, GUI, text, image, and scrolling facts alongside derived state', () => {
    const result = normalizeUIInspection({
      success: true,
      viewport: { width: 320, height: 180, insetTopLeft: { x: 0, y: 36 }, insetBottomRight: { x: 0, y: 0 } },
      elements: [
        element({
          ref: 'screen', path: 'game.Root', className: 'ScreenGui', enabled: true, ignoreGuiInset: false,
          screenInsets: 'CoreUISafeInsets', clipToDeviceSafeArea: true, displayOrder: 5,
        }),
        element({
          ref: 'rich', path: 'game.Root.Rich', className: 'TextButton', parentRef: 'screen', visible: true, active: true,
          engineInteractable: true, selectable: true, zIndex: 7, layoutOrder: 2, clipsDescendants: false,
          anchorPoint: { x: 0.5, y: 0.5 }, rotation: 5, absoluteRotation: 5,
          text: 'Play', contentText: 'Play', textSize: 20, textBounds: { x: 40, y: 20 }, textFits: true,
          textWrapped: true, textScaled: false, textTransparency: 0.1, textColor3: { r: 1, g: 1, b: 1 },
          fontFace: { family: 'rbxasset://fonts/families/Roboto.json', weight: 'Bold', style: 'Normal' },
          image: 'rbxasset://icon', imageContent: 'rbxasset://icon', imageTransparency: 0.2, imageColor3: { r: 1, g: 0, b: 0 },
        }),
        element({
          ref: 'scroll', path: 'game.Root.Scroll', className: 'ScrollingFrame', parentRef: 'screen',
          canvasPosition: { x: 2, y: 3 }, absoluteCanvasSize: { x: 200, y: 300 }, absoluteWindowSize: { x: 100, y: 100 },
          scrollingDirection: 'XY', canScrollHorizontal: true, canScrollVertical: true,
        }),
      ],
    }, { includeStyles: true });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.viewport).toEqual({ x: 0, y: 0, width: 320, height: 180, insetTopLeft: { x: 0, y: 36 }, insetBottomRight: { x: 0, y: 0 } });
    expect(result.elements.find((item) => item.ref === 'screen')).toMatchObject({ enabled: true, ignoreGuiInset: false, screenInsets: 'CoreUISafeInsets', clipToDeviceSafeArea: true, displayOrder: 5 });
    expect(result.elements.find((item) => item.ref === 'rich')).toMatchObject({
      visible: true, active: true, engineInteractable: true, selectable: true, zIndex: 7, layoutOrder: 2,
      clipsDescendants: false, anchorPoint: { x: 0.5, y: 0.5 }, rotation: 5, absoluteRotation: 5,
      text: 'Play', contentText: 'Play', textSize: 20, textBounds: { x: 40, y: 20 }, textFits: true,
      textWrapped: true, textScaled: false, textTransparency: 0.1,
      image: 'rbxasset://icon', imageContent: 'rbxasset://icon', imageTransparency: 0.2,
    });
    expect(result.elements.find((item) => item.ref === 'rich')?.textColor3).toEqual({ r: 1, g: 1, b: 1 });
    expect(result.elements.find((item) => item.ref === 'scroll')).toMatchObject({
      canvasPosition: { x: 2, y: 3 }, absoluteCanvasSize: { x: 200, y: 300 }, absoluteWindowSize: { x: 100, y: 100 },
      scrollingDirection: 'XY', canScrollHorizontal: true, canScrollVertical: true,
    });
  });

  test('creates deterministic snapshots independent of raw element order', () => {
    const first = normalizeUIInspection(inspection([
      element({ ref: 'b', path: 'game.Root.B', className: 'TextLabel', text: 'B', zIndex: 9 }),
      element({ ref: 'a', path: 'game.Root.A', className: 'TextLabel', text: 'A', zIndex: 1 }),
    ]));
    const second = normalizeUIInspection(inspection([
      element({ ref: 'a', path: 'game.Root.A', className: 'TextLabel', text: 'A', zIndex: 1 }),
      element({ ref: 'b', path: 'game.Root.B', className: 'TextLabel', text: 'B', zIndex: 9 }),
    ]));

    expect(createUISnapshot(first)).toEqual(createUISnapshot(second));
    const snapshot = createUISnapshot(first);
    expect(snapshot.success && snapshot.elements[0]).toMatchObject({ path: 'game.Root.A', text: { content: 'A' } });
    expect(snapshot.success && snapshot.elements[0]).not.toHaveProperty('styles');
  });

  test('handles malformed geometry and error responses deterministically without throwing', () => {
    expect(() => normalizeUIInspection(inspection([
      element({ ref: 'bad', absolutePosition: { x: Number.NaN, y: 0 }, absoluteSize: { x: 10, y: 10 } }),
    ]))).not.toThrow();
    const malformed = normalizeUIInspection(inspection([
      element({ ref: 'bad', absolutePosition: { x: Number.NaN, y: 0 }, absoluteSize: { x: 10, y: 10 } }),
    ]));
    expect(malformed.success && malformed.elements[0]).toMatchObject({ rect: null, hasInvalidRenderedGeometry: true, visibleFraction: 0 });
    const failure = normalizeUIInspection({ success: false, error: { code: 'studio_unavailable' }, detail: 'preserve me' });
    expect(failure).toEqual({ success: false, error: { code: 'studio_unavailable' }, detail: 'preserve me' });
  });
});
