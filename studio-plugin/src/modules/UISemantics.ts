import { GuiService, Players, RunService, Workspace } from "@rbxts/services";
import Utils from "./Utils";

const { getInstancePath, getInstanceReference, resolveInstance } = Utils;

const MAX_TEXT_LENGTH = 2000;

interface RuntimeUiContext {
	player: Player;
	playerGui: PlayerGui;
}

interface UiRootRequest {
	path?: string;
	ref?: string;
}

interface UiInspectionOptions {
	maxDepth: number;
	maxNodes: number;
	includeText: boolean;
	includeStyles: boolean;
}

interface UiTraversalEntry {
	instance: Instance;
	depth: number;
	semanticParent?: Instance;
}

interface UiCollectionResult {
	elements: Record<string, unknown>[];
	truncation: {
		truncated: boolean;
		reason?: "max_depth" | "max_nodes";
		returned: number;
		visited: number;
	};
}

interface UiContextResult {
	contextElements: Record<string, unknown>[];
	semanticParent?: Instance;
}

interface UiSelector {
	ref?: string;
	path?: string;
	name?: string;
	className?: string;
	role?: string;
	text?: string;
	ancestor?: unknown;
	visibleOnly: boolean;
}

interface UiRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface UiPoint {
	x: number;
	y: number;
}

function runtimeClientRequiredError(): Record<string, unknown> {
	return {
		success: false,
		errorCode: "runtime_client_required",
		error: "runtime_client_required",
		message: "UI inspection requires a running playtest client with a local player's PlayerGui.",
	};
}

function getRuntimeUiContext(): RuntimeUiContext | Record<string, unknown> {
	if (!RunService.IsRunning() || !RunService.IsClient()) {
		return runtimeClientRequiredError();
	}

	const player = Players.LocalPlayer;
	if (!player) return runtimeClientRequiredError();

	const [ok, playerGui] = pcall(() => player.FindFirstChildOfClass("PlayerGui"));
	if (!ok || !playerGui || !playerGui.IsA("PlayerGui")) {
		return runtimeClientRequiredError();
	}

	return { player, playerGui };
}

function normalizeUiInspectionOptions(requestData: Record<string, unknown>): UiInspectionOptions {
	const maxDepth = typeIs(requestData.maxDepth, "number")
		? math.clamp(math.floor(requestData.maxDepth), 0, 32)
		: 8;
	const maxNodes = typeIs(requestData.maxNodes, "number")
		? math.clamp(math.floor(requestData.maxNodes), 1, 1000)
		: 250;

	return {
		maxDepth,
		maxNodes,
		includeText: requestData.includeText !== false,
		includeStyles: requestData.includeStyles === true,
	};
}

function getRootRequest(requestData: Record<string, unknown>): UiRootRequest {
	const rawRoot = requestData.root;
	if (!typeIs(rawRoot, "table")) return {};

	const root = rawRoot as Record<string, unknown>;
	return {
		path: typeIs(root.path, "string") ? root.path : undefined,
		ref: typeIs(root.ref, "string") ? root.ref : undefined,
	};
}

function isDescendantOf(instance: Instance, ancestor: Instance): boolean {
	const [ok, result] = pcall(() => instance === ancestor || instance.IsDescendantOf(ancestor));
	return ok && result === true;
}

function resolveUiRoot(context: RuntimeUiContext, request: UiRootRequest): Instance | Record<string, unknown> {
	const root = request.ref !== undefined
		? resolveInstance(undefined, request.ref)
		: request.path !== undefined
			? resolveInstance(request.path)
			: context.playerGui;

	if (!root) {
		return {
			success: false,
			errorCode: "ui_root_not_found",
			error: "ui_root_not_found",
			// Named, and told what to do about it. The sibling
			// runtime_client_required error says "Start a playtest, wait for
			// client-N, and retry" and a caller acts on it; this one said only
			// that something did not resolve, and a caller abandoned the tool.
			message: request.ref !== undefined
				? `The requested UI root reference could not be resolved in the current playtest: ${request.ref}.`
				: `The requested UI root path could not be resolved in the current playtest: ${request.path}.`
					+ " Live UI is a copy under the local player's PlayerGui, not the StarterGui original."
					+ " Omit root to inspect the whole PlayerGui.",
		};
	}

	if (!isDescendantOf(root, context.playerGui)) {
		return {
			success: false,
			errorCode: "invalid_ui_root",
			error: "invalid_ui_root",
			message: "UI roots must be the local player's PlayerGui or one of its descendants.",
		};
	}

	return root;
}

function safeRead(instance: Instance, propertyName: string): unknown | undefined {
	const object = instance as unknown as Record<string, unknown>;
	const [ok, value] = pcall(() => object[propertyName]);
	return ok ? value : undefined;
}

function safeChildren(instance: Instance): Instance[] | undefined {
	const [ok, children] = pcall(() => instance.GetChildren());
	return ok ? children : undefined;
}

function safeIdentity(instance: Instance): Record<string, unknown> | undefined {
	const [refOk, ref] = pcall(() => getInstanceReference(instance));
	const [pathOk, path] = pcall(() => getInstancePath(instance));
	if (!refOk || !pathOk) return undefined;

	return {
		ref,
		path,
		name: instance.Name,
		className: instance.ClassName,
	};
}

function vector2(value: unknown): Record<string, number> | undefined {
	if (!typeIs(value, "Vector2")) return undefined;
	return { x: value.X, y: value.Y };
}

function color3(value: unknown): Record<string, number> | undefined {
	if (!typeIs(value, "Color3")) return undefined;
	return { r: value.R, g: value.G, b: value.B };
}

function enumName(value: unknown): string | undefined {
	if (!typeIs(value, "EnumItem")) return undefined;
	return value.Name;
}

function cappedText(value: unknown): string | undefined {
	if (!typeIs(value, "string")) return undefined;
	return value.size() > MAX_TEXT_LENGTH ? value.sub(1, MAX_TEXT_LENGTH) : value;
}

function parentIdentity(instance: Instance): Record<string, unknown> {
	const parent = instance.Parent;
	if (!parent) return {};
	const identity = safeIdentity(parent);
	if (!identity) return {};
	return {
		parentRef: identity.ref,
		parentPath: identity.path,
	};
}

function isRelevantUiElement(instance: Instance): boolean {
	return instance.IsA("ScreenGui") || instance.IsA("GuiObject");
}

function uiRole(instance: Instance): string {
	if (instance.IsA("TextButton") || instance.IsA("ImageButton")) return "button";
	if (instance.IsA("TextBox")) return "input";
	if (instance.IsA("TextLabel")) return "text";
	if (instance.IsA("ScrollingFrame")) return "scroll_container";
	if (instance.IsA("ImageLabel")) return "image";
	if (instance.IsA("ViewportFrame") || instance.IsA("ScreenGui")) return "viewport";
	if (instance.IsA("GuiObject")) return "container";
	return "gui";
}

function semanticParentIdentity(instance: Instance | undefined): Record<string, unknown> {
	if (!instance) return {};
	const identity = safeIdentity(instance);
	if (!identity) return {};
	return {
		semanticParentRef: identity.ref,
		semanticParentPath: identity.path,
	};
}

function collectGuiObjectFacts(instance: GuiObject, element: Record<string, unknown>): void {
	element.visible = safeRead(instance, "Visible");
	element.absolutePosition = vector2(safeRead(instance, "AbsolutePosition"));
	element.absoluteSize = vector2(safeRead(instance, "AbsoluteSize"));
	element.absoluteRotation = safeRead(instance, "AbsoluteRotation");
	element.active = safeRead(instance, "Active");
	const engineInteractable = safeRead(instance, "Interactable");
	if (typeIs(engineInteractable, "boolean")) element.engineInteractable = engineInteractable;
	element.selectable = safeRead(instance, "Selectable");
	element.zIndex = safeRead(instance, "ZIndex");
	// Whether the element paints its own box; a transparent frame covering text hides nothing.
	element.backgroundTransparency = safeRead(instance, "BackgroundTransparency");
	element.layoutOrder = safeRead(instance, "LayoutOrder");
	element.clipsDescendants = safeRead(instance, "ClipsDescendants");
	element.anchorPoint = vector2(safeRead(instance, "AnchorPoint"));
	element.rotation = safeRead(instance, "Rotation");
}

function collectScreenGuiFacts(instance: ScreenGui, element: Record<string, unknown>): void {
	element.enabled = safeRead(instance, "Enabled");
	element.ignoreGuiInset = safeRead(instance, "IgnoreGuiInset");
	const screenInsets = enumName(safeRead(instance, "ScreenInsets"));
	if (screenInsets !== undefined) element.screenInsets = screenInsets;
	element.clipToDeviceSafeArea = safeRead(instance, "ClipToDeviceSafeArea");
	element.displayOrder = safeRead(instance, "DisplayOrder");
	const zIndexBehavior = enumName(safeRead(instance, "ZIndexBehavior"));
	if (zIndexBehavior !== undefined) element.zIndexBehavior = zIndexBehavior;
}

function collectTextFacts(instance: Instance, element: Record<string, unknown>, options: UiInspectionOptions): void {
	if (!instance.IsA("TextLabel") && !instance.IsA("TextButton") && !instance.IsA("TextBox")) return;

	if (options.includeText) {
		element.text = cappedText(safeRead(instance, "Text"));
		element.contentText = cappedText(safeRead(instance, "ContentText"));
	}
	element.textSize = safeRead(instance, "TextSize");
	element.textBounds = vector2(safeRead(instance, "TextBounds"));
	element.textFits = safeRead(instance, "TextFits");
	element.textWrapped = safeRead(instance, "TextWrapped");
	element.textScaled = safeRead(instance, "TextScaled");
	element.textTransparency = safeRead(instance, "TextTransparency");
	// Where the rendered text sits inside the element's box, so the audit can tell
	// whether something covers the letters or only an empty part of the label.
	const textXAlignment = enumName(safeRead(instance, "TextXAlignment"));
	if (textXAlignment !== undefined) element.textXAlignment = textXAlignment;
	const textYAlignment = enumName(safeRead(instance, "TextYAlignment"));
	if (textYAlignment !== undefined) element.textYAlignment = textYAlignment;

	if (options.includeStyles) {
		element.textColor3 = color3(safeRead(instance, "TextColor3"));
		const fontFace = safeRead(instance, "FontFace");
		if (typeIs(fontFace, "Font")) {
			element.fontFace = {
				family: fontFace.Family,
				weight: enumName(fontFace.Weight),
				style: enumName(fontFace.Style),
			};
		}
	}
}

function collectImageFacts(instance: Instance, element: Record<string, unknown>, options: UiInspectionOptions): void {
	if (!instance.IsA("ImageLabel") && !instance.IsA("ImageButton")) return;

	element.image = safeRead(instance, "Image");
	const imageContent = safeRead(instance, "ImageContent");
	if (imageContent !== undefined) element.imageContent = tostring(imageContent);
	element.imageTransparency = safeRead(instance, "ImageTransparency");
	if (options.includeStyles) {
		element.imageColor3 = color3(safeRead(instance, "ImageColor3"));
	}
}

function collectScrollingFacts(instance: Instance, element: Record<string, unknown>): void {
	if (!instance.IsA("ScrollingFrame")) return;

	const absoluteCanvasSize = safeRead(instance, "AbsoluteCanvasSize");
	const absoluteWindowSize = safeRead(instance, "AbsoluteWindowSize");
	element.canvasPosition = vector2(safeRead(instance, "CanvasPosition"));
	element.absoluteCanvasSize = vector2(absoluteCanvasSize);
	element.absoluteWindowSize = vector2(absoluteWindowSize);
	const scrollingDirection = enumName(safeRead(instance, "ScrollingDirection"));
	if (scrollingDirection !== undefined) element.scrollingDirection = scrollingDirection;

	const canvas = vector2(absoluteCanvasSize);
	const window = vector2(absoluteWindowSize);
	if (canvas && window) {
		element.canScrollHorizontal = canvas.x > window.x;
		element.canScrollVertical = canvas.y > window.y;
	}
}

function collectUiElement(
	instance: Instance,
	depth: number,
	options: UiInspectionOptions,
	semanticParent?: Instance,
): Record<string, unknown> | undefined {
	if (!isRelevantUiElement(instance)) return undefined;
	const identity = safeIdentity(instance);
	if (!identity) return undefined;

	const element: Record<string, unknown> = {
		...identity,
		...parentIdentity(instance),
		...semanticParentIdentity(semanticParent),
		depth,
	};

	if (instance.IsA("ScreenGui")) collectScreenGuiFacts(instance, element);
	if (instance.IsA("GuiObject")) collectGuiObjectFacts(instance, element);
	if ((instance.IsA("GuiButton") || instance.IsA("TextBox"))) {
		const playerGui = findContainingPlayerGui(instance);
		if (playerGui) element.inputActionable = getUiTargetState(instance, playerGui).actionable === true;
	}
	collectTextFacts(instance, element, options);
	collectImageFacts(instance, element, options);
	collectScrollingFacts(instance, element);
	return element;
}

function sortChildren(children: Instance[]): void {
	children.sort((a, b) => {
		if (a.Name !== b.Name) return a.Name < b.Name;
		if (a.ClassName !== b.ClassName) return a.ClassName < b.ClassName;
		return getInstancePath(a) < getInstancePath(b);
	});
}

function hasChildren(instance: Instance): boolean {
	const children = safeChildren(instance);
	return children !== undefined && children.size() > 0;
}

function rectFromGuiObject(instance: GuiObject): UiRect | undefined {
	const position = safeRead(instance, "AbsolutePosition");
	const size = safeRead(instance, "AbsoluteSize");
	if (!typeIs(position, "Vector2") || !typeIs(size, "Vector2")) return undefined;
	return { x: position.X, y: position.Y, width: size.X, height: size.Y };
}

function intersectRects(left: UiRect, right: UiRect): UiRect | undefined {
	const x = math.max(left.x, right.x);
	const y = math.max(left.y, right.y);
	const maxX = math.min(left.x + left.width, right.x + right.width);
	const maxY = math.min(left.y + left.height, right.y + right.height);
	if (maxX <= x || maxY <= y) return undefined;
	return { x, y, width: maxX - x, height: maxY - y };
}

function viewportRect(): UiRect | undefined {
	const camera = Workspace.CurrentCamera;
	if (!camera) return undefined;
	const size = camera.ViewportSize;
	if (size.X <= 0 || size.Y <= 0) return undefined;
	const [insetOk, topLeftInset] = pcall(() => GuiService.GetGuiInset());
	const inset = insetOk && typeIs(topLeftInset, "Vector2") ? topLeftInset : new Vector2(0, 0);
	return { x: -inset.X, y: -inset.Y, width: size.X, height: size.Y };
}

function isEnabledAndVisible(instance: Instance): boolean {
	if (instance.IsA("ScreenGui")) return safeRead(instance, "Enabled") !== false;
	if (instance.IsA("GuiObject")) return safeRead(instance, "Visible") !== false;
	return true;
}

function findContainingPlayerGui(instance: Instance): PlayerGui | undefined {
	let current: Instance | undefined = instance.Parent;
	while (current) {
		if (current.IsA("PlayerGui")) return current;
		current = current.Parent;
	}
	return undefined;
}

function isInputBlockingGuiObject(instance: GuiObject): boolean {
	if (safeRead(instance, "Interactable") === false) return false;
	if (instance.IsA("GuiButton") || instance.IsA("TextBox")) return true;
	return safeRead(instance, "Active") === true;
}

function isEffectivelyVisible(instance: Instance, playerGui: PlayerGui): boolean {
	let current: Instance | undefined = instance;
	while (current && current !== playerGui) {
		if (!isEnabledAndVisible(current)) return false;
		current = current.Parent;
	}
	return current === playerGui;
}

function interactionProbePoints(bounds: UiRect): UiPoint[] {
	return [
		{ x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 },
		{ x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.25 },
		{ x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.25 },
		{ x: bounds.x + bounds.width * 0.25, y: bounds.y + bounds.height * 0.75 },
		{ x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.75 },
	];
}

function hitTestActionablePoint(
	instance: GuiObject,
	playerGui: PlayerGui,
	visibleBounds: UiRect,
): UiPoint | false | undefined {
	for (const point of interactionProbePoints(visibleBounds)) {
		const [hitTestOk, hits] = pcall(() => playerGui.GetGuiObjectsAtPosition(point.x, point.y));
		if (!hitTestOk || !typeIs(hits, "table")) return undefined;

		for (const hit of hits as GuiObject[]) {
			if (!isEffectivelyVisible(hit, playerGui)) continue;
			if (hit === instance) return point;
			if (isDescendantOf(hit, instance)) {
				if (isInputBlockingGuiObject(hit)) break;
				continue;
			}
			if (isDescendantOf(instance, hit)) continue;
			if (isInputBlockingGuiObject(hit)) break;
		}
	}
	return false;
}

function getUiTargetState(instance: Instance, playerGui: PlayerGui): Record<string, unknown> {
	if (!instance.IsA("GuiObject")) {
		return { actionable: false, reason: "not_gui_object" };
	}

	const bounds = rectFromGuiObject(instance);
	if (!bounds) return { actionable: false, reason: "invalid_geometry" };
	if (bounds.width <= 0 || bounds.height <= 0) {
		return { actionable: false, reason: "zero_size", bounds };
	}

	let visibleBounds = viewportRect();
	if (!visibleBounds) return { actionable: false, reason: "invalid_viewport", bounds };
	let current: Instance | undefined = instance;
	while (current && current !== playerGui) {
		if (!isEnabledAndVisible(current)) {
			return { actionable: false, reason: "hidden", bounds, visibleBounds: undefined };
		}
		if (current !== instance && current.IsA("GuiObject")) {
			const clips = safeRead(current, "ClipsDescendants") === true || current.IsA("ScrollingFrame");
			if (clips) {
				const clipBounds = current.IsA("ScrollingFrame")
					? (() => {
						const position = safeRead(current, "AbsolutePosition");
						const windowSize = safeRead(current, "AbsoluteWindowSize");
						return typeIs(position, "Vector2") && typeIs(windowSize, "Vector2")
							? { x: position.X, y: position.Y, width: windowSize.X, height: windowSize.Y }
							: undefined;
					})()
					: rectFromGuiObject(current);
				if (clipBounds) visibleBounds = intersectRects(visibleBounds, clipBounds);
			}
		}
		if (!visibleBounds) {
			return { actionable: false, reason: "fully_clipped", bounds, visibleBounds: undefined };
		}
		current = current.Parent;
	}
	if (current !== playerGui) {
		return { actionable: false, reason: "detached_from_player_gui", bounds, visibleBounds: undefined };
	}

	visibleBounds = intersectRects(visibleBounds, bounds);
	if (!visibleBounds) return { actionable: false, reason: "fully_clipped", bounds, visibleBounds: undefined };
	if (safeRead(instance, "Interactable") === false) {
		return { actionable: false, visible: true, reason: "engine_not_interactable", bounds, visibleBounds };
	}
	if (safeRead(instance, "Active") === false) {
		return { actionable: false, visible: true, reason: "inactive", bounds, visibleBounds };
	}
	const interactionPoint = hitTestActionablePoint(instance, playerGui, visibleBounds);
	if (interactionPoint === false) {
		return { actionable: false, visible: true, reason: "occluded", bounds, visibleBounds };
	}

	// Older clients and unusual runtime states can reject hit testing. Keep the previous
	// center-point behavior in that case, while successful hit tests always provide a
	// verified exposed probe point.
	return {
		actionable: true,
		visible: true,
		bounds,
		visibleBounds,
		interactionPoint: interactionPoint ?? interactionProbePoints(visibleBounds)[0],
	};
}

function getUiSelector(requestData: Record<string, unknown>): UiSelector {
	const raw = typeIs(requestData.selector, "table")
		? requestData.selector as Record<string, unknown>
		: requestData;
	return {
		ref: typeIs(raw.ref, "string") ? raw.ref : undefined,
		path: typeIs(raw.path, "string") ? raw.path : undefined,
		name: typeIs(raw.name, "string") ? raw.name : undefined,
		className: typeIs(raw.class, "string") ? raw.class : undefined,
		role: typeIs(raw.role, "string") ? raw.role : undefined,
		text: typeIs(raw.text, "string") ? raw.text : undefined,
		ancestor: raw.ancestor,
		visibleOnly: raw.visible_only === true || raw.visibleOnly === true,
	};
}

function instanceMatchesText(instance: Instance, text: string): boolean {
	if (!instance.IsA("TextLabel") && !instance.IsA("TextButton") && !instance.IsA("TextBox")) return false;
	return safeRead(instance, "Text") === text || safeRead(instance, "ContentText") === text;
}

function matchesAncestorValue(instance: Instance, value: unknown): boolean {
	if (typeIs(value, "string")) {
		if (instance.Name === value || instance.ClassName === value || uiRole(instance) === value || instanceMatchesText(instance, value)) {
			return true;
		}
		if (!value.match("^ir:")[0] && !value.match("^game[%.%[]")[0]) return false;
		const identity = safeIdentity(instance);
		return identity?.ref === value || identity?.path === value;
	}
	if (!typeIs(value, "table")) return false;
	const selector = value as Record<string, unknown>;
	const identity = safeIdentity(instance);
	if (typeIs(selector.ref, "string") && identity?.ref !== selector.ref) return false;
	if (typeIs(selector.path, "string") && identity?.path !== selector.path) return false;
	if (typeIs(selector.name, "string") && instance.Name !== selector.name) return false;
	if (typeIs(selector.class, "string") && instance.ClassName !== selector.class) return false;
	if (typeIs(selector.role, "string") && uiRole(instance) !== selector.role) return false;
	if (typeIs(selector.text, "string") && !instanceMatchesText(instance, selector.text)) return false;
	return true;
}

function hasMatchingAncestor(instance: Instance, ancestor: unknown, playerGui: PlayerGui): boolean {
	let current = instance.Parent;
	while (current && current !== playerGui) {
		if (matchesAncestorValue(current, ancestor)) return true;
		current = current.Parent;
	}
	return false;
}

function matchesUiSelector(instance: Instance, selector: UiSelector, playerGui: PlayerGui): boolean {
	if (selector.name !== undefined && instance.Name !== selector.name) return false;
	if (selector.className !== undefined && instance.ClassName !== selector.className) return false;
	if (selector.role !== undefined && uiRole(instance) !== selector.role) return false;
	if (selector.text !== undefined && !instanceMatchesText(instance, selector.text)) return false;
	if (selector.ancestor !== undefined && !hasMatchingAncestor(instance, selector.ancestor, playerGui)) return false;
	if (selector.visibleOnly && getUiTargetState(instance, playerGui).visible !== true) return false;
	if (selector.ref !== undefined || selector.path !== undefined) {
		const identity = safeIdentity(instance);
		if (!identity) return false;
		if (selector.ref !== undefined && identity.ref !== selector.ref) return false;
		if (selector.path !== undefined && identity.path !== selector.path) return false;
	}
	return true;
}

function sortedRelevantUiElements(playerGui: PlayerGui): Instance[] {
	const found: Instance[] = [];
	const stack: Instance[] = [playerGui];
	while (stack.size() > 0) {
		const current = stack.pop() as Instance;
		if (current !== playerGui && isRelevantUiElement(current)) found.push(current);
		const children = safeChildren(current);
		if (!children) continue;
		sortChildren(children);
		for (let i = children.size() - 1; i >= 0; i--) stack.push(children[i]);
	}
	return found;
}

function resolveUiSelector(context: RuntimeUiContext, selector: UiSelector): Instance[] {
	let candidates: Instance[];
	if (selector.ref !== undefined) {
		const resolved = resolveInstance(undefined, selector.ref);
		candidates = resolved && isDescendantOf(resolved, context.playerGui) ? [resolved] : [];
	} else if (selector.path !== undefined) {
		const resolved = resolveInstance(selector.path);
		candidates = resolved && isDescendantOf(resolved, context.playerGui) ? [resolved] : [];
	} else {
		candidates = sortedRelevantUiElements(context.playerGui);
	}

	const matches: Instance[] = [];
	for (const candidate of candidates) {
		if (isRelevantUiElement(candidate) && matchesUiSelector(candidate, selector, context.playerGui)) {
			matches.push(candidate);
		}
	}
	matches.sort((a, b) => getInstancePath(a) < getInstancePath(b));
	return matches;
}

function compactUiTarget(instance: Instance, playerGui: PlayerGui): Record<string, unknown> {
	const state = getUiTargetState(instance, playerGui);
	return {
		...safeIdentity(instance),
		role: uiRole(instance),
		bounds: state.bounds,
		visibleBounds: state.visibleBounds,
		effectiveVisible: isEffectivelyVisible(instance, playerGui),
		actionable: state.actionable === true,
	};
}

function findNearestScrollingFrame(instance: Instance, playerGui: PlayerGui): ScrollingFrame | undefined {
	let current: Instance | undefined = instance;
	while (current && current !== playerGui) {
		if (current.IsA("ScrollingFrame")) return current;
		current = current.Parent;
	}
	return undefined;
}

function scrollingGeometry(instance: ScrollingFrame): Record<string, unknown> | undefined {
	const canvasSize = safeRead(instance, "AbsoluteCanvasSize");
	const windowSize = safeRead(instance, "AbsoluteWindowSize");
	const position = safeRead(instance, "CanvasPosition");
	if (!typeIs(canvasSize, "Vector2") || !typeIs(windowSize, "Vector2") || !typeIs(position, "Vector2")) return undefined;
	return {
		canvasSize,
		windowSize,
		position,
		maxX: math.max(0, canvasSize.X - windowSize.X),
		maxY: math.max(0, canvasSize.Y - windowSize.Y),
	};
}

function waitForUiRender(): boolean {
	const [ok] = pcall(() => RunService.RenderStepped.Wait());
	return ok;
}

function setScrollingFramePosition(instance: ScrollingFrame, x: number, y: number): Record<string, unknown> {
	waitForUiRender();
	const geometry = scrollingGeometry(instance);
	if (!geometry) return { success: false, error: "scroll_geometry_unavailable" };
	const appliedPosition = new Vector2(
		math.clamp(x, 0, geometry.maxX as number),
		math.clamp(y, 0, geometry.maxY as number),
	);
	const [setOk, setError] = pcall(() => {
		instance.CanvasPosition = appliedPosition;
	});
	if (!setOk) return { success: false, error: `scroll_position_set_failed: ${tostring(setError)}` };
	waitForUiRender();
	const verified = safeRead(instance, "CanvasPosition");
	if (!typeIs(verified, "Vector2") || math.abs(verified.X - appliedPosition.X) > 1 || math.abs(verified.Y - appliedPosition.Y) > 1) {
		return { success: false, error: "scroll_position_verification_failed" };
	}
	return {
		success: true,
		canvasPosition: vector2(verified),
		maxCanvasPosition: { x: geometry.maxX, y: geometry.maxY },
	};
}

function scrollInstanceIntoView(instance: Instance, playerGui: PlayerGui): Record<string, unknown> {
	const scroll = findNearestScrollingFrame(instance, playerGui);
	if (!scroll) return { success: false, error: "scrolling_ancestor_not_found" };
	const targetState = getUiTargetState(instance, playerGui);
	const targetBounds = targetState.bounds as UiRect | undefined;
	if (!targetBounds) return { success: false, error: "target_geometry_unavailable" };
	waitForUiRender();
	const geometry = scrollingGeometry(scroll);
	const scrollBounds = rectFromGuiObject(scroll);
	if (!geometry || !scrollBounds) return { success: false, error: "scroll_geometry_unavailable" };
	const windowSize = geometry.windowSize as Vector2;
	const window = { x: scrollBounds.x, y: scrollBounds.y, width: windowSize.X, height: windowSize.Y };
	const currentPosition = geometry.position as Vector2;
	let x = currentPosition.X;
	let y = currentPosition.Y;
	if (targetBounds.x < window.x) x += targetBounds.x - window.x;
	else if (targetBounds.x + targetBounds.width > window.x + window.width) x += targetBounds.x + targetBounds.width - (window.x + window.width);
	if (targetBounds.y < window.y) y += targetBounds.y - window.y;
	else if (targetBounds.y + targetBounds.height > window.y + window.height) y += targetBounds.y + targetBounds.height - (window.y + window.height);

	const result = setScrollingFramePosition(scroll, x, y);
	if (result.success !== true) return result;
	const verifiedState = getUiTargetState(instance, playerGui);
	if (verifiedState.visibleBounds === undefined) {
		return { success: false, error: "scroll_into_view_verification_failed" };
	}
	return { ...result, revealed: true, scrollingFrame: safeIdentity(scroll) };
}

function collectUiContext(root: Instance, playerGui: PlayerGui, options: UiInspectionOptions): UiContextResult {
	if (root === playerGui) return { contextElements: [] };

	const ancestors: Instance[] = [];
	let current = root.Parent;
	while (current && current !== playerGui) {
		if (isRelevantUiElement(current)) ancestors.unshift(current);
		current = current.Parent;
	}

	const contextElements: Record<string, unknown>[] = [];
	for (let i = 0; i < ancestors.size(); i++) {
		const element = collectUiElement(
			ancestors[i],
			i - ancestors.size(),
			options,
			i > 0 ? ancestors[i - 1] : undefined,
		);
		if (element) contextElements.push(element);
	}

	return {
		contextElements,
		semanticParent: ancestors[ancestors.size() - 1],
	};
}

function collectUiElements(
	root: Instance,
	options: UiInspectionOptions,
	rootSemanticParent?: Instance,
): UiCollectionResult {
	const elements: Record<string, unknown>[] = [];
	const stack: UiTraversalEntry[] = [{ instance: root, depth: 0, semanticParent: rootSemanticParent }];
	let visited = 0;
	let reason: "max_depth" | "max_nodes" | undefined;

	while (stack.size() > 0) {
		const entry = stack.pop() as UiTraversalEntry;
		visited += 1;

		const element = collectUiElement(entry.instance, entry.depth, options, entry.semanticParent);
		if (element) {
			elements.push(element);
			if (elements.size() >= options.maxNodes) {
				if (stack.size() > 0 || hasChildren(entry.instance)) reason = "max_nodes";
				break;
			}
		}

		if (entry.depth >= options.maxDepth) {
			if (hasChildren(entry.instance)) reason = "max_depth";
			continue;
		}

		const children = safeChildren(entry.instance);
		if (!children) continue;
		sortChildren(children);
		const childSemanticParent = isRelevantUiElement(entry.instance)
			? entry.instance
			: entry.semanticParent;
		for (let i = children.size() - 1; i >= 0; i--) {
			stack.push({
				instance: children[i],
				depth: entry.depth + 1,
				semanticParent: childSemanticParent,
			});
		}
	}

	return {
		elements,
		truncation: {
			truncated: reason !== undefined,
			reason,
			returned: elements.size(),
			visited,
		},
	};
}

function getViewport(): Record<string, unknown> {
	const [insetOk, topLeftInset, bottomRightInset] = pcall(() => GuiService.GetGuiInset());
	const topLeft = insetOk ? (topLeftInset as Vector2) : new Vector2(0, 0);
	const bottomRight = insetOk ? (bottomRightInset as Vector2) : new Vector2(0, 0);
	const camera = Workspace.CurrentCamera;
	const viewportSize = camera ? camera.ViewportSize : new Vector2(0, 0);

	return {
		width: viewportSize.X,
		height: viewportSize.Y,
		insetTopLeft: vector2(topLeft),
		insetBottomRight: vector2(bottomRight),
	};
}

function guiPointToWindowPoint(point: Record<string, number>): Record<string, number> {
	const [insetOk, topLeftInset] = pcall(() => GuiService.GetGuiInset());
	if (!insetOk || !typeIs(topLeftInset, "Vector2")) return { x: point.x, y: point.y };
	return {
		x: point.x + topLeftInset.X,
		y: point.y + topLeftInset.Y,
	};
}

export = {
	getRuntimeUiContext,
	getRootRequest,
	resolveUiRoot,
	normalizeUiInspectionOptions,
	safeIdentity,
	isRelevantUiElement,
	uiRole,
	collectUiElement,
	collectUiContext,
	collectUiElements,
	getUiSelector,
	resolveUiSelector,
	getUiTargetState,
	compactUiTarget,
	findNearestScrollingFrame,
	setScrollingFramePosition,
	scrollInstanceIntoView,
	guiPointToWindowPoint,
	getViewport,
};
