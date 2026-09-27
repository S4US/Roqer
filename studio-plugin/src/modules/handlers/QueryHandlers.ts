import Utils from "../Utils";

const { getInstancePath, getInstanceByPath, getInstanceReference, resolveInstance, readScriptSource } = Utils;

interface TreeNode {
	name: string;
	className: string;
	path?: string;
	instanceRef?: string;
	children: TreeNode[];
	hasSource?: boolean;
	scriptType?: string;
	enabled?: boolean;
}

function getFileTree(requestData: Record<string, unknown>) {
	const path = (requestData.path as string) ?? "";
	const startInstance = getInstanceByPath(path);

	if (!startInstance) {
		return { error: `Path not found: ${path}` };
	}

	function buildTree(instance: Instance, depth: number): TreeNode {
		if (depth > 10) {
			return { name: instance.Name, className: instance.ClassName, children: [] };
		}

		const node: TreeNode = {
			name: instance.Name,
			className: instance.ClassName,
			path: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
			children: [],
		};

		if (instance.IsA("LuaSourceContainer")) {
			node.hasSource = true;
			node.scriptType = instance.ClassName;
			if (instance.IsA("BaseScript")) {
				node.enabled = instance.Enabled;
			}
		}

		for (const child of instance.GetChildren()) {
			node.children.push(buildTree(child, depth + 1));
		}

		return node;
	}

	return {
		tree: buildTree(startInstance, 0),
		timestamp: tick(),
	};
}

function searchFiles(requestData: Record<string, unknown>) {
	const query = requestData.query as string;
	const searchType = (requestData.searchType as string) ?? "name";

	if (!query) return { error: "Query is required" };

	const results: { name: string; className: string; path: string; hasSource: boolean; enabled?: boolean }[] = [];

	function searchRecursive(instance: Instance) {
		let match = false;

		if (searchType === "name") {
			match = instance.Name.lower().find(query.lower())[0] !== undefined;
		} else if (searchType === "type") {
			match = instance.ClassName.lower().find(query.lower())[0] !== undefined;
		} else if (searchType === "content" && instance.IsA("LuaSourceContainer")) {
			match = readScriptSource(instance).lower().find(query.lower())[0] !== undefined;
		}

		if (match) {
			const entry: { name: string; className: string; path: string; hasSource: boolean; enabled?: boolean } = {
				name: instance.Name,
				className: instance.ClassName,
				path: getInstancePath(instance),
				hasSource: instance.IsA("LuaSourceContainer"),
			};
			if (instance.IsA("BaseScript")) {
				entry.enabled = instance.Enabled;
			}
			results.push(entry);
		}

		for (const child of instance.GetChildren()) {
			searchRecursive(child);
		}
	}

	searchRecursive(game);

	return { results, query, searchType, count: results.size() };
}

function getPlaceInfo(_requestData: Record<string, unknown>) {
	const dataModelName = game.Name;
	let placeName = dataModelName;

	if (game.PlaceId > 0) {
		const MarketplaceService = game.GetService("MarketplaceService");
		const [ok, info] = pcall(() => MarketplaceService.GetProductInfo(game.PlaceId));
		if (ok && info !== undefined) {
			const name = (info as { Name?: string }).Name;
			if (typeIs(name, "string") && name !== "") {
				placeName = name;
			}
		}
	}

	return {
		placeName,
		dataModelName,
		placeId: game.PlaceId,
		gameId: game.GameId,
		jobId: game.JobId,
		workspace: {
			name: game.Workspace.Name,
			className: game.Workspace.ClassName,
		},
	};
}

function searchObjects(requestData: Record<string, unknown>) {
	const query = requestData.query as string;
	const searchType = (requestData.searchType as string) ?? "name";
	const propertyName = requestData.propertyName as string | undefined;

	if (!query) return { error: "Query is required" };

	const results: { name: string; className: string; path: string; instanceRef: string }[] = [];

	function searchRecursive(instance: Instance) {
		let match = false;

		if (searchType === "name") {
			match = instance.Name.lower().find(query.lower())[0] !== undefined;
		} else if (searchType === "class") {
			match = instance.ClassName.lower().find(query.lower())[0] !== undefined;
		} else if (searchType === "property" && propertyName) {
			const [success, value] = pcall(() => tostring((instance as unknown as Record<string, unknown>)[propertyName]));
			if (success) {
				match = (value as string).lower().find(query.lower())[0] !== undefined;
			}
		}

		if (match) {
			results.push({
				name: instance.Name,
				className: instance.ClassName,
				path: getInstancePath(instance),
				instanceRef: getInstanceReference(instance),
			});
		}

		for (const child of instance.GetChildren()) {
			searchRecursive(child);
		}
	}

	searchRecursive(game);

	return { results, query, searchType, count: results.size() };
}

function getInstanceProperties(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const excludeSource = (requestData.excludeSource as boolean) ?? false;
	if (!instancePath) return { error: "Instance path is required" };

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };

	const properties: Record<string, unknown> = {};
	const [success, result] = pcall(() => {
		const basicProps = ["Name", "ClassName", "Parent"];
		for (const prop of basicProps) {
			const [propSuccess, propValue] = pcall(() => {
				const val = (instance as unknown as Record<string, unknown>)[prop];
				if (prop === "Parent" && val) return getInstancePath(val as Instance);
				if (val === undefined) return "nil";
				return tostring(val);
			});
			if (propSuccess) properties[prop] = propValue;
		}

		const commonProps = [
			"Size", "Position", "Rotation", "CFrame", "Anchored", "CanCollide",
			"Transparency", "BrickColor", "Material", "Color", "Text", "TextColor3",
			"BackgroundColor3", "Image", "ImageColor3", "Visible", "Active", "ZIndex",
			"BorderSizePixel", "BackgroundTransparency", "ImageTransparency",
			"TextTransparency", "Value", "Enabled", "Brightness", "Range", "Shadows",
			"Face", "SurfaceType",
		];

		for (const prop of commonProps) {
			const [propSuccess, propValue] = pcall(() => {
				const val = (instance as unknown as Record<string, unknown>)[prop];
				if (typeOf(val) === "UDim2") {
					const udim = val as UDim2;
					return {
						X: { Scale: udim.X.Scale, Offset: udim.X.Offset },
						Y: { Scale: udim.Y.Scale, Offset: udim.Y.Offset },
						_type: "UDim2",
					};
				}
				return tostring(val);
			});
			if (propSuccess) properties[prop] = propValue;
		}

		if (instance.IsA("LuaSourceContainer")) {
			if (!excludeSource) {
				properties.Source = readScriptSource(instance);
			} else {
				const src = readScriptSource(instance);
				properties.SourceLength = src.size();
				properties.LineCount = Utils.splitLines(src)[0].size();
			}
			if (instance.IsA("BaseScript")) {
				properties.Enabled = tostring(instance.Enabled);
			}
		}

		if (instance.IsA("Part")) {
			properties.Shape = tostring(instance.Shape);
		}

		if (instance.IsA("BasePart")) {
			properties.TopSurface = tostring(instance.TopSurface);
			properties.BottomSurface = tostring(instance.BottomSurface);
		}

		if (instance.IsA("MeshPart")) {
			properties.MeshId = tostring(instance.MeshId);
			properties.TextureID = tostring(instance.TextureID);
		}

		if (instance.IsA("SpecialMesh")) {
			properties.MeshId = tostring(instance.MeshId);
			properties.TextureId = tostring(instance.TextureId);
			properties.MeshType = tostring(instance.MeshType);
		}

		if (instance.IsA("Sound")) {
			properties.SoundId = tostring(instance.SoundId);
			properties.TimeLength = tostring(instance.TimeLength);
			properties.IsPlaying = tostring(instance.IsPlaying);
		}

		if (instance.IsA("Animation")) {
			properties.AnimationId = tostring(instance.AnimationId);
		}

		if (instance.IsA("Decal") || instance.IsA("Texture")) {
			properties.Texture = tostring((instance as Decal | Texture).Texture);
		}

		if (instance.IsA("Shirt")) {
			properties.ShirtTemplate = tostring(instance.ShirtTemplate);
		} else if (instance.IsA("Pants")) {
			properties.PantsTemplate = tostring(instance.PantsTemplate);
		} else if (instance.IsA("ShirtGraphic")) {
			properties.Graphic = tostring(instance.Graphic);
		}

		properties.ChildCount = tostring(instance.GetChildren().size());
	});

	if (success) {
		return {
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
			className: instance.ClassName,
			properties,
		};
	} else {
		return { error: `Failed to get properties: ${result}` };
	}
}

function searchByProperty(requestData: Record<string, unknown>) {
	const propertyName = requestData.propertyName as string;
	const propertyValue = requestData.propertyValue as string;

	if (!propertyName || !propertyValue) {
		return { error: "Property name and value are required" };
	}

	const results: { name: string; className: string; path: string; instanceRef: string; propertyValue: string }[] = [];

	function searchRecursive(instance: Instance) {
		const [success, value] = pcall(() => tostring((instance as unknown as Record<string, unknown>)[propertyName]));
		if (success && (value as string).lower().find(propertyValue.lower())[0] !== undefined) {
			results.push({
				name: instance.Name,
				className: instance.ClassName,
				path: getInstancePath(instance),
				instanceRef: getInstanceReference(instance),
				propertyValue: value as string,
			});
		}
		for (const child of instance.GetChildren()) {
			searchRecursive(child);
		}
	}

	searchRecursive(game);
	return { propertyName, propertyValue, results, count: results.size() };
}

function getClassInfo(requestData: Record<string, unknown>) {
	const className = requestData.className as string;
	if (!className) return { error: "Class name is required" };

	let [success, tempInstance] = pcall(() => new Instance(className as keyof CreatableInstances));
	let isService = false;

	if (!success) {
		const [serviceSuccess, serviceInstance] = pcall(() =>
			game.GetService(className as keyof Services),
		);
		if (serviceSuccess && serviceInstance) {
			success = true;
			tempInstance = serviceInstance as unknown as Instance;
			isService = true;
		}
	}

	if (!success) return { error: `Invalid class name: ${className}` };

	const classInfo: {
		className: string;
		isService: boolean;
		properties: string[];
		methods: string[];
		events: string[];
	} = { className, isService, properties: [], methods: [], events: [] };

	const commonProps = [
		"Name", "ClassName", "Parent", "Size", "Position", "Rotation", "CFrame",
		"Anchored", "CanCollide", "Transparency", "BrickColor", "Material", "Color",
		"Text", "TextColor3", "BackgroundColor3", "Image", "ImageColor3", "Visible",
		"Active", "ZIndex", "BorderSizePixel", "BackgroundTransparency",
		"ImageTransparency", "TextTransparency", "Value", "Enabled", "Brightness",
		"Range", "Shadows",
	];

	for (const prop of commonProps) {
		const [propSuccess] = pcall(() => (tempInstance as unknown as Record<string, unknown>)[prop]);
		if (propSuccess) classInfo.properties.push(prop);
	}

	const commonMethods = [
		"Destroy", "Clone", "FindFirstChild", "FindFirstChildOfClass",
		"GetChildren", "IsA", "IsAncestorOf", "IsDescendantOf", "WaitForChild",
	];

	for (const method of commonMethods) {
		const [methodSuccess] = pcall(() => (tempInstance as unknown as Record<string, unknown>)[method]);
		if (methodSuccess) classInfo.methods.push(method);
	}

	if (!isService) {
		(tempInstance as Instance).Destroy();
	}

	return classInfo;
}

// get_project_structure stops expanding entries once its result would pass
// this many characters of JSON, well inside what an agent host passes to a
// model in one tool result. The count is an estimate made before encoding.
const STRUCTURE_BUDGET_CHARS = 16_000;
// An entry's instanceRef is minted only once the entry is listed.
const INSTANCE_REF_CHARS = 48;
const CHILDREN_KEY_CHARS = 14;
const UNEXPANDED_CHARS = 32;
const RESULT_FIELDS_CHARS = 320;

function estimatedJsonChars(value: unknown): number {
	const kind = typeOf(value);
	if (kind === "string") return (value as string).size() + 2;
	if (kind === "number") return 12;
	if (kind === "boolean") return 5;
	if (kind === "table") {
		let size = 2;
		for (const [key, item] of pairs(value as Record<string | number, unknown>)) {
			size += (typeIs(key, "string") ? key.size() + 3 : 0) + estimatedJsonChars(item) + 1;
		}
		return size;
	}
	return 4;
}

function getProjectStructure(requestData: Record<string, unknown>) {
	const startPath = (requestData.path as string) ?? "";
	const instanceRef = requestData.instanceRef as string | undefined;
	const maxDepth = (requestData.maxDepth as number) ?? 3;
	const showScriptsOnly = (requestData.scriptsOnly as boolean) ?? false;

	if (startPath === "" || startPath === "game") {
		const services: Record<string, unknown>[] = [];
		const mainServices = [
			"Workspace", "ServerScriptService", "ServerStorage", "ReplicatedStorage",
			"ReplicatedFirst", "StarterGui", "StarterPack", "StarterPlayer", "Players",
		];

		for (const serviceName of mainServices) {
			const [svcOk, service] = pcall(() => game.GetService(serviceName as keyof Services));
			if (svcOk && service) {
				services.push({
					name: service.Name,
					className: service.ClassName,
					path: getInstancePath(service as Instance),
					instanceRef: getInstanceReference(service as Instance),
					childCount: (service as Instance).GetChildren().size(),
					hasChildren: (service as Instance).GetChildren().size() > 0,
				});
			}
		}

		return {
			type: "service_overview",
			services,
			timestamp: tick(),
			note: "Use path parameter to explore specific locations (e.g., 'game.ServerScriptService')",
		};
	}

	const startInstance = resolveInstance(startPath, instanceRef);
	if (!startInstance) {
		return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Path not found: ${startPath}` };
	}

	// Scripts often sit under containers that are not Folders: StarterPlayerScripts,
	// a ScreenGui, a Tool, a Model, an Actor. Keeping only scripts and Folders hid
	// every one of those, and every script beneath it, so a scripts-only listing
	// keeps any child that is a script or holds one.
	function isScriptOrHoldsOne(instance: Instance): boolean {
		return instance.IsA("LuaSourceContainer") || instance.FindFirstChildWhichIsA("LuaSourceContainer", true) !== undefined;
	}

	function describe(instance: Instance): Record<string, unknown> {
		const node: Record<string, unknown> = {
			name: instance.Name,
			className: instance.ClassName,
			path: getInstancePath(instance),
		};

		if (instance.IsA("LuaSourceContainer")) {
			node.hasSource = true;
			node.scriptType = instance.ClassName;
			if (instance.IsA("BaseScript")) {
				node.enabled = instance.Enabled;
			}
		}

		if (instance.IsA("GuiObject")) {
			node.visible = instance.Visible;
			if (instance.IsA("Frame") || instance.IsA("ScreenGui")) {
				node.guiType = "container";
			} else if (instance.IsA("TextLabel") || instance.IsA("TextButton")) {
				node.guiType = "text";
				const textInst = instance as TextLabel | TextButton;
				if (textInst.Text !== "") node.text = textInst.Text;
			} else if (instance.IsA("ImageLabel") || instance.IsA("ImageButton")) {
				node.guiType = "image";
			}
		}

		return node;
	}

	function listedChildren(instance: Instance): Instance[] {
		const children = instance.GetChildren();
		return showScriptsOnly ? children.filter(isScriptOrHoldsOne) : children;
	}

	type Entry = { instance: Instance; node: Record<string, unknown> };
	// One way to list an entry's children: every child, or (past 20 children)
	// a count per class with three examples of each. A plan that does not fit
	// the budget may name the class summary to use instead.
	type Plan = {
		owner: Entry;
		entries: Entry[];
		nodes: Record<string, unknown>[];
		summary?: Record<string, unknown>[];
		// Each summary row's children, in the same order.
		groups?: Instance[][];
		childCount: number;
		cost: number;
		order: number;
		fallback?: Plan;
	};

	function entryFor(instance: Instance): Entry {
		return { instance, node: describe(instance) };
	}

	function entryCost(entry: Entry): number {
		return estimatedJsonChars(entry.node) + INSTANCE_REF_CHARS;
	}

	function everyChildPlan(owner: Entry, children: Instance[], order: number): Plan {
		const entries = children.map(entryFor);
		let cost = CHILDREN_KEY_CHARS;
		for (const entry of entries) cost += entryCost(entry);
		return { owner, entries, nodes: entries.map((entry) => entry.node), childCount: children.size(), cost, order };
	}

	function groupedPlan(owner: Entry, children: Instance[], order: number): Plan {
		// Classes in the order they first appear, so the listing is stable.
		const classNames: string[] = [];
		const classGroups = new Map<string, Instance[]>();
		for (const child of children) {
			const cn = child.ClassName;
			let group = classGroups.get(cn);
			if (group === undefined) {
				group = [];
				classGroups.set(cn, group);
				classNames.push(cn);
			}
			group.push(child);
		}

		const summary: Record<string, unknown>[] = [];
		const groups: Instance[][] = [];
		const entries: Entry[] = [];
		const nodes: Record<string, unknown>[] = [];
		let cost = CHILDREN_KEY_CHARS;
		for (const cn of classNames) {
			const classChildren = classGroups.get(cn)!;
			groups.push(classChildren);
			summary.push({
				className: cn,
				count: classChildren.size(),
				examples: [classChildren[0]?.Name, classChildren[1]?.Name],
			});
			const limit = math.min(3, classChildren.size());
			for (let i = 0; i < limit; i++) {
				const entry = entryFor(classChildren[i]);
				entries.push(entry);
				nodes.push(entry.node);
				cost += entryCost(entry);
			}
			if (classChildren.size() > 3) {
				const more = {
					name: `... ${classChildren.size() - 3} more ${cn} objects`,
					className: "MoreIndicator",
					path: `${owner.node.path} [${cn} children]`,
					note: "Use specific path to explore these objects",
				};
				nodes.push(more);
				cost += estimatedJsonChars(more);
			}
		}
		cost += estimatedJsonChars(summary);
		return { owner, entries, nodes, summary, groups, childCount: children.size(), cost, order };
	}

	function planFor(owner: Entry, children: Instance[], order: number): Plan {
		if (children.size() <= 20) return everyChildPlan(owner, children, order);
		if (!showScriptsOnly) return groupedPlan(owner, children, order);
		// A scripts-only listing is read for the names of the scripts, so it
		// lists every one where it can, and too many to list are summarised by
		// class with as many names as the budget has room for.
		const plan = everyChildPlan(owner, children, order);
		plan.fallback = groupedPlan(owner, children, order);
		return plan;
	}

	// The tree is listed a level at a time, so every entry near the root is
	// shown before any entry deeper down, and it stops expanding entries once
	// the result reaches its budget. Listed depth-first, one large subtree used
	// to fill the result on its own and the whole result was cut down after
	// the fact, dropping its siblings.
	const root = entryFor(startInstance);
	root.node.instanceRef = getInstanceReference(startInstance);
	let used = entryCost(root) + RESULT_FIELDS_CHARS;
	let reachedMaxDepth = false;
	let reachedBudget = false;

	function commit(plan: Plan, nextLevel: Entry[]) {
		if (plan.summary !== undefined) plan.owner.node.childSummary = plan.summary;
		for (const entry of plan.entries) {
			entry.node.instanceRef = getInstanceReference(entry.instance);
			nextLevel.push(entry);
		}
		plan.owner.node.children = plan.nodes;
		used += plan.cost;
	}

	// Adds names from each class to a summary's examples until the room is
	// spent, and returns the room used.
	function nameMore(plan: Plan, room: number): number {
		const summary = plan.summary!;
		const groups = plan.groups!;
		let added = 0;
		for (let i = 0; i < summary.size(); i++) {
			const examples = summary[i].examples as string[];
			const group = groups[i];
			for (let k = examples.size(); k < group.size(); k++) {
				const cost = group[k].Name.size() + 3;
				if (added + cost > room) return added;
				examples.push(group[k].Name);
				added += cost;
			}
		}
		return added;
	}

	function leaveUnexpanded(entry: Entry, childCount: number) {
		entry.node.childCount = childCount;
		entry.node.hasMore = true;
		used += UNEXPANDED_CHARS;
	}

	let level: Entry[] = [root];
	for (let depth = 0; level.size() > 0; depth++) {
		const plans: Plan[] = [];
		for (const entry of level) {
			const children = listedChildren(entry.instance);
			if (children.size() === 0) continue;
			if (depth >= maxDepth) {
				leaveUnexpanded(entry, children.size());
				reachedMaxDepth = true;
				continue;
			}
			plans.push(planFor(entry, children, plans.size()));
		}

		// Cheapest first, so the budget expands as many entries as it can.
		plans.sort((a, b) => a.cost < b.cost || (a.cost === b.cost && a.order < b.order));
		const nextLevel: Entry[] = [];
		const leftover: Plan[] = [];
		for (const plan of plans) {
			if (used + plan.cost <= STRUCTURE_BUDGET_CHARS) commit(plan, nextLevel);
			else leftover.push(plan);
		}
		const summarised: Plan[] = [];
		for (const plan of leftover) {
			const summary = plan.fallback;
			// The requested entry's own children are always listed.
			if (summary !== undefined && (used + summary.cost <= STRUCTURE_BUDGET_CHARS || depth === 0)) {
				commit(summary, nextLevel);
				summarised.push(summary);
			} else if (depth === 0) {
				commit(plan, nextLevel);
			} else {
				leaveUnexpanded(plan.owner, plan.childCount);
				reachedBudget = true;
			}
		}
		// Every summary at this level is in before any of them names more.
		for (const summary of summarised) {
			used += nameMore(summary, STRUCTURE_BUDGET_CHARS - used);
		}
		level = nextLevel;
	}

	const result = root.node;
	result.requestedPath = startPath;
	result.maxDepth = maxDepth;
	result.scriptsOnly = showScriptsOnly;
	result.timestamp = tick();
	if (reachedMaxDepth || reachedBudget) {
		result.note = reachedBudget
			? "Entries with hasMore list only their childCount; the deepest were left unexpanded to keep this result small. Pass one as path to see its children."
			: "Entries with hasMore list only their childCount; pass one as path to see its children.";
	}

	return result;
}

// Split a Lua pattern on TOP-LEVEL "|" into alternatives. Lua patterns have no
// alternation operator, so "foo|bar" would otherwise be matched as the literal
// text "foo|bar" and silently never hit. "%|" stays a literal pipe, and "%bxy"
// keeps both balanced-match delimiter characters.
function splitLuaAlternation(pattern: string): string[] {
	const parts: string[] = [];
	let current = "";
	let i = 1;
	const n = pattern.size();
	let inCharClass = false;
	while (i <= n) {
		const c = string.sub(pattern, i, i);
		if (c === "%") {
			if (string.sub(pattern, i + 1, i + 1) === "b") {
				current += string.sub(pattern, i, math.min(i + 3, n));
				i += 4;
				continue;
			}
			// Preserve an escape pair (e.g. %|, %., %d) intact.
			current += string.sub(pattern, i, i + 1);
			i += 2;
		} else if (c === "[") {
			inCharClass = true;
			current += c;
			i += 1;
		} else if (c === "]") {
			inCharClass = false;
			current += c;
			i += 1;
		} else if (c === "|" && !inCharClass) {
			parts.push(current);
			current = "";
			i += 1;
		} else {
			current += c;
			i += 1;
		}
	}
	parts.push(current);
	return parts;
}

// Return the earliest match across alternatives (mirrors regex alternation).
function findFirstPattern(line: string, alternatives: string[]): [number | undefined, number | undefined] {
	let bestStart: number | undefined;
	let bestEnd: number | undefined;
	for (const alt of alternatives) {
		if (alt === "") continue;
		const [s, e] = string.find(line, alt);
		if (s !== undefined && (bestStart === undefined || s < bestStart)) {
			bestStart = s;
			bestEnd = e as number;
		}
	}
	return [bestStart, bestEnd];
}

function grepScripts(requestData: Record<string, unknown>) {
	const pattern = requestData.pattern as string;
	if (!pattern) return { error: "pattern is required" };

	const usePattern = (requestData.usePattern as boolean) ?? false;
	if (usePattern && requestData.caseSensitive === false) {
		return {
			error: "Case-insensitive Lua pattern search is not supported. Omit caseSensitive or pass caseSensitive: true with usePattern: true, or use literal search.",
		};
	}

	const caseSensitive = usePattern ? true : ((requestData.caseSensitive as boolean) ?? false);
	const contextLines = (requestData.contextLines as number) ?? 0;
	const maxResults = (requestData.maxResults as number) ?? 100;
	const maxResultsPerScript = (requestData.maxResultsPerScript as number) ?? 0;
	const filesOnly = (requestData.filesOnly as boolean) ?? false;
	const searchPath = (requestData.path as string) ?? "";
	const classFilter = requestData.classFilter as string | undefined;

	const startInstance = searchPath !== "" ? getInstanceByPath(searchPath) : game;
	if (!startInstance) return { error: `Path not found: ${searchPath}` };

	// Prepare pattern for matching
	const searchPattern = caseSensitive ? pattern : pattern.lower();
	// Pre-split top-level "|" alternation once (pattern mode only).
	const patternAlternatives = usePattern ? splitLuaAlternation(searchPattern) : undefined;

	interface LineMatch {
		line: number;
		column: number;
		text: string;
		before: string[];
		after: string[];
	}

	interface ScriptResult {
		instancePath: string;
		name: string;
		className: string;
		enabled?: boolean;
		matches: LineMatch[];
	}

	const results: ScriptResult[] = [];
	let totalMatches = 0;
	let scriptsSearched = 0;
	let hitLimit = false;

	function searchInstance(instance: Instance) {
		if (hitLimit) return;

		if (instance.IsA("LuaSourceContainer")) {
			// Apply class filter
			if (classFilter) {
				if (!instance.ClassName.lower().find(classFilter.lower())[0]) return;
			}

			scriptsSearched++;
			const source = readScriptSource(instance);
			const [lines] = Utils.splitLines(source);
			const scriptMatches: LineMatch[] = [];
			let scriptMatchCount = 0;

			for (let i = 0; i < lines.size(); i++) {
				if (hitLimit) break;
				if (maxResultsPerScript > 0 && scriptMatchCount >= maxResultsPerScript) break;

				const line = lines[i];
				const searchLine = caseSensitive ? line : line.lower();

				let matchStart: number | undefined;
				let matchEnd: number | undefined;

				if (usePattern) {
					[matchStart, matchEnd] = findFirstPattern(searchLine, patternAlternatives!);
				} else {
					[matchStart, matchEnd] = string.find(searchLine, searchPattern, 1, true);
				}

				if (matchStart !== undefined) {
					scriptMatchCount++;
					totalMatches++;

					if (totalMatches > maxResults) {
						hitLimit = true;
						break;
					}

					if (!filesOnly) {
						// Gather context lines
						const before: string[] = [];
						const after: string[] = [];

						if (contextLines > 0) {
							const beforeStart = math.max(0, i - contextLines);
							for (let j = beforeStart; j < i; j++) {
								before.push(lines[j]);
							}
							const afterEnd = math.min(lines.size() - 1, i + contextLines);
							for (let j = i + 1; j <= afterEnd; j++) {
								after.push(lines[j]);
							}
						}

						scriptMatches.push({
							line: i + 1, // 1-indexed
							column: matchStart,
							text: line,
							before,
							after,
						});
					}
				}
			}

			if (scriptMatchCount > 0) {
				const scriptResult: ScriptResult = {
					instancePath: getInstancePath(instance),
					name: instance.Name,
					className: instance.ClassName,
					matches: scriptMatches,
				};
				if (instance.IsA("BaseScript")) {
					scriptResult.enabled = instance.Enabled;
				}
				results.push(scriptResult);
			}
		}

		for (const child of instance.GetChildren()) {
			if (hitLimit) return;
			searchInstance(child);
		}
	}

	searchInstance(startInstance);

	return {
		results,
		pattern,
		totalMatches: hitLimit ? `>${maxResults}` : totalMatches,
		scriptsSearched,
		scriptsMatched: results.size(),
		truncated: hitLimit,
		options: { caseSensitive, contextLines, usePattern, filesOnly, maxResults, maxResultsPerScript },
	};
}

export = {
    getFileTree,
    searchFiles,
    getPlaceInfo,
    searchObjects,
    getInstanceProperties,
    searchByProperty,
    getClassInfo,
    getProjectStructure,
    grepScripts,
};
