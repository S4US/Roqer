import Utils from "../Utils";
import Recording from "../Recording";
import RojoPlan from "../RojoPlan";
import ScatterPlanner from "./ScatterPlanner";

const { getInstancePath, resolveInstance, getInstanceReference, convertPropertyValue, resolveParentAndName, samePropertyValue, hasUniquePath } = Utils;
const { beginRecording, finishRecording } = Recording;

/**
 * Build many instances under one root as a single, all-or-nothing change.
 *
 * The request is prepared entirely off the DataModel first: new instances are
 * created and cloned while detached, and every edit to a live instance is
 * converted and snapshotted without being applied. Any bad step therefore
 * fails before Studio has changed at all. Only then are the live changes
 * applied, inside one ChangeHistory recording, so the whole build is one undo
 * step; a failure while applying rolls back what was applied and cancels the
 * recording.
 *
 * Every write lands at or under the root, which must sit below a service. That
 * is what makes `remove` safe to offer: a batch can delete only what it could
 * have built.
 *
 * A service itself may be the root of a batch that only adds to it: creates
 * and clones, and sets on what the batch itself made. Agents kept naming
 * `ReplicatedStorage` to put a `VFX` folder in it, and an effect such as a
 * `BloomEffect` has to be a direct child of `Lighting`; neither had a root that
 * could hold it. Nothing such a batch does can touch an instance that was
 * already there, so the guarantee above still holds.
 *
 * The root itself can be removed only by a batch that does nothing else: a
 * temporary preview root is cleaned up that way, and no later step can then
 * build into something the batch has just taken away.
 */

const MAX_OPERATIONS = 500;
const MAX_NEW_INSTANCES = 2000;
const MAX_TOTAL_INSTANCES = 20000;
const MAX_REPORTED_IDS = 50;
const MAX_REPORTED_CLASSES = 12;
const MAX_TAG_LENGTH = 100;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
/** The most script source, in total, a plan carries; a batch rarely copies more than a few scripts. */
const MAX_PLANNED_SOURCE = 2_000_000;
/** The most serialized model, in base64 characters, a plan carries. */
const MAX_PLANNED_RBXM = 8_000_000;
/** Properties a plan describes on its own, so setting them is not reported as an extra. */
const PLANNED_PROPERTIES = new Set(["Name", "RunContext", "Enabled", "Disabled"]);

type Step = Record<string, unknown>;

/** A change to the live DataModel, deferred until the whole batch is prepared. */
interface LiveAction {
	apply: () => void;
	undo: () => void;
}

interface BuildState {
	root: Instance;
	/** The path the request named the root by, which resolves to it even before a new root is live. */
	rootPath: string;
	/** Every instance this batch made, so a failure can destroy them all. */
	made: Set<Instance>;
	actions: LiveAction[];
	ids: Map<string, Instance>;
	idOrder: string[];
	/** Live instances this batch removes; nothing may be built into them. */
	removed: Set<Instance>;
	tags: Set<string>;
	newInstances: number;
	totalInstances: number;
	created: number;
	cloned: number;
	updated: number;
	removedCount: number;
	scatter?: { requested: number; placed: number; attempts: number };
	/** Models this batch created with no pivot of their own; see settlePivot. */
	unsettled: Set<Model>;
	/** The root is a service, so the batch may only add to it. */
	serviceRoot: boolean;
	/** New instances attached straight to a live parent: what a service-root batch reports on. */
	added: Instance[];
	/** The live parent each of `added` goes into, for a plan made before anything is attached. */
	attachedTo: Map<Instance, Instance>;
	/** New instances given properties beyond a name, which a plan has to report. */
	decorated: Set<Instance>;
	/** Edits and removals of instances that were already live. */
	liveChanges: number;
	/** Those edits and removals, as a plan describes them. */
	liveOps: LiveOp[];
}

/** One edit or removal of a live instance, recorded for a plan. */
interface LiveOp {
	op: "set" | "remove";
	target: Instance;
	/** The new name, when a set renames it. */
	name?: string;
	/** Every other property the set assigns. */
	properties: string[];
	placement: boolean;
	tags: boolean;
	attributes: boolean;
}

/**
 * Give a Model this batch created an upright pivot.
 *
 * With no PrimaryPart and no WorldPivot, Studio chooses a model's pivot itself,
 * and its orientation follows one of the parts: a tree whose canopy cube is
 * turned 45° to read as a diamond gets a pivot tilted 45°. A clone's `rotation`
 * then sets that pivot to exactly what was asked, so "yaw 30" quietly undoes
 * the tilt, and every trunk leans 45° under a square canopy. That was a
 * recorded village run, not a hypothetical. The position Studio chose is kept;
 * only the tilt is dropped, so rotation means rotation about the vertical.
 * A model with no parts yet keeps Studio's default, since a pivot fixed now
 * would ignore whatever is built into it later.
 */
function settlePivot(state: BuildState, model: Model): void {
	if (!state.unsettled.has(model)) return;
	if (!model.FindFirstChildWhichIsA("BasePart", true)) return;
	state.unsettled.delete(model);
	model.WorldPivot = new CFrame(model.GetPivot().Position);
}

function fail(step: number, op: string, message: string): never {
	error(`step ${step} (${op}): ${message}`, 0);
}

/** Why a step that takes something away cannot run under a service root, and where it can. */
function serviceRootRefusal(service: Instance, op: string): string {
	const path = getInstancePath(service);
	return `${path} is a service, and a batch whose root is a service only adds to it; ${op} needs a build root below it, such as ${path}.MyBuild (created as a Model if missing)`;
}

/**
 * A batch whose one step removes its own root: the root taken out as one undo
 * step. Undefined when the step names something else, or the root is not one
 * a batch may have, so the usual checks answer it.
 */
function removeRootAlone(path: string, root: Instance | undefined, step: Step, planOnly: boolean): Record<string, unknown> | undefined {
	const target = step.target;
	if (!typeIs(target, "string") || target === "") return undefined;
	if (target !== path && (root === undefined || resolveInstance(target, undefined) !== root)) return undefined;
	if (!root) return { error: `${path} does not exist, so there is no build root to remove. Nothing was changed.` };
	if (root === game || root.Parent === game) return undefined;
	const where = getInstancePath(root);
	if (planOnly) {
		const live = describeLive({ op: "remove", target: root, properties: [], placement: false, tags: false, attributes: false });
		return { planned: true, path: where, removedRoot: true, createdRoot: false, added: [], live: [live], liveChanges: 1, created: 0, cloned: 0 };
	}
	const recordingId = beginRecording(`Remove ${root.Name}`);
	// Parent = nil rather than Destroy, as every remove: undo puts it back.
	const [removed, reason] = pcall(() => {
		root.Parent = undefined;
	});
	if (!removed) {
		finishRecording(recordingId, false);
		return { error: `Removing ${where} failed: ${reason}. Nothing was changed.` };
	}
	finishRecording(recordingId, true);
	return { path: where, removedRoot: true, created: 0, cloned: 0, updated: 0, removed: 1, undoable: recordingId !== undefined };
}

function isLive(state: BuildState, instance: Instance): boolean {
	return !state.made.has(instance);
}

/** Keys in a stable order, so a batch applies the same way every time. */
function sortedKeys(record: Record<string, unknown>): string[] {
	const keys: string[] = [];
	for (const [key] of pairs(record)) keys.push(key as string);
	keys.sort();
	return keys;
}

function isInsideRemoved(state: BuildState, instance: Instance): boolean {
	let current: Instance | undefined = instance;
	while (current) {
		if (state.removed.has(current)) return true;
		current = current.Parent;
	}
	return false;
}

/**
 * Resolve a `$id` from an earlier step or a canonical path. Parents and
 * targets must be inside the root; a clone source may be anywhere, because
 * reading a template changes nothing.
 */
function resolveRef(state: BuildState, ref: unknown, step: number, op: string, field: string, insideRoot: boolean): Instance {
	if (!typeIs(ref, "string") || ref === "") fail(step, op, `${field} must be a path or $id`);
	const text = ref as string;
	if (text.sub(1, 1) === "$") {
		const found = state.ids.get(text.sub(2));
		if (!found) fail(step, op, `${field} ${text} names no earlier step`);
		return found;
	}
	if (text === state.rootPath) return state.root;
	const found = resolveInstance(text, undefined);
	if (!found) fail(step, op, `${field} not found: ${text}; name an instance built in this batch with $id`);
	if (insideRoot && found !== state.root && !found.IsDescendantOf(state.root)) {
		// The requested path, not the root's: a root this batch creates has no
		// parent until the batch applies, so its own path would lack the service.
		fail(step, op, `${field} ${text} is outside the build root ${state.rootPath}`);
	}
	if (isInsideRemoved(state, found)) fail(step, op, `${field} ${text} is removed earlier in this batch`);
	return found;
}

function readVector(value: unknown, step: number, op: string, field: string): [number, number, number] | undefined {
	if (value === undefined) return undefined;
	const array = value as unknown[];
	if (!typeIs(value, "table") || array.size() !== 3 ||
		!typeIs(array[0], "number") || !typeIs(array[1], "number") || !typeIs(array[2], "number")) {
		fail(step, op, `${field} must be three numbers`);
	}
	return [array[0] as number, array[1] as number, array[2] as number];
}

/**
 * The placement a step asks for, keeping whichever of position and rotation
 * it leaves out from the instance's current placement.
 */
function placement(current: CFrame, position?: [number, number, number], rotation?: [number, number, number]): CFrame {
	const at = position ? new CFrame(position[0], position[1], position[2]) : new CFrame(current.Position);
	const turn = rotation
		? CFrame.fromOrientation(math.rad(rotation[0]), math.rad(rotation[1]), math.rad(rotation[2]))
		: current.Rotation;
	return at.mul(turn);
}

function requirePlaceable(instance: Instance, step: number, op: string): void {
	if (!instance.IsA("BasePart") && !instance.IsA("Model")) {
		fail(step, op, `position, rotation, and scale apply to parts and models, not ${instance.ClassName}`);
	}
}

function currentPivot(instance: Instance, step: number, op: string): CFrame {
	requirePlaceable(instance, step, op);
	return instance.IsA("BasePart") ? instance.CFrame : (instance as Model).GetPivot();
}

function applyPivot(instance: Instance, target: CFrame): void {
	if (instance.IsA("BasePart")) instance.CFrame = target;
	else if (instance.IsA("Model")) instance.PivotTo(target);
}

function applyScale(instance: Instance, scale: number): void {
	if (instance.IsA("Model")) instance.ScaleTo(instance.GetScale() * scale);
	else if (instance.IsA("BasePart")) instance.Size = instance.Size.mul(scale);
}

function readScale(value: unknown, step: number, op: string): number | undefined {
	if (value === undefined) return undefined;
	if (!typeIs(value, "number") || value < MIN_SCALE || value > MAX_SCALE) {
		fail(step, op, `scale must be a number from ${MIN_SCALE} to ${MAX_SCALE}`);
	}
	return value as number;
}

function readTags(value: unknown, step: number, op: string): string[] {
	if (value === undefined) return [];
	const tags = value as unknown[];
	if (!typeIs(value, "table")) fail(step, op, "tags must be an array of strings");
	for (const tag of tags) {
		if (!typeIs(tag, "string") || tag === "" || (tag as string).size() > MAX_TAG_LENGTH) {
			fail(step, op, `every tag must be a string of 1 to ${MAX_TAG_LENGTH} characters`);
		}
	}
	return tags as string[];
}

function readAttributes(value: unknown, step: number, op: string): Array<[string, unknown]> {
	if (value === undefined) return [];
	if (!typeIs(value, "table")) fail(step, op, "attributes must be an object");
	const entries: Array<[string, unknown]> = [];
	for (const [name, attribute] of pairs(value as Record<string, unknown>)) {
		if (!typeIs(attribute, "string") && !typeIs(attribute, "number") && !typeIs(attribute, "boolean")) {
			fail(step, op, `attribute ${name} must be a string, number, or boolean`);
		}
		entries.push([name as string, attribute]);
	}
	return entries;
}

/** Convert one requested property the same way an atomic property write does. */
function resolveProperty(state: BuildState, instance: Instance, property: string, value: unknown, step: number, op: string): unknown {
	if (property === "Parent") fail(step, op, "set the parent with the parent field, not properties.Parent");
	if (property === "Source") fail(step, op, "script Source cannot be set here; create the script, then write its source");
	if (property === "PrimaryPart") return resolveRef(state, value, step, op, "PrimaryPart", true);
	if (property === "Name") return tostring(value);
	const [success, converted] = pcall(() => convertPropertyValue(instance, property, value));
	if (!success) fail(step, op, `${property}: ${converted}`);
	return converted !== undefined ? converted : value;
}

/** Set properties, tags, attributes, and placement on an instance nothing else can see yet. */
function decorateDetached(state: BuildState, instance: Instance, step: Step, index: number, op: string): void {
	const writable = instance as unknown as Record<string, unknown>;
	if (step.name !== undefined) instance.Name = tostring(step.name);
	if (step.properties !== undefined) {
		if (!typeIs(step.properties, "table")) fail(index, op, "properties must be an object");
		const properties = step.properties as Record<string, unknown>;
		for (const property of sortedKeys(properties)) {
			// A plan reports a script's RunContext and Enabled itself, from the instance.
			if (!PLANNED_PROPERTIES.has(property)) state.decorated.add(instance);
			const resolved = resolveProperty(state, instance, property, properties[property], index, op);
			const [success, result] = pcall(() => {
				writable[property] = resolved;
			});
			if (!success) fail(index, op, `${property}: ${result}`);
		}
	}
	for (const tag of readTags(step.tags, index, op)) {
		instance.AddTag(tag);
		state.tags.add(tag);
	}
	for (const [name, value] of readAttributes(step.attributes, index, op)) {
		const [success, result] = pcall(() => instance.SetAttribute(name, value as AttributeValue));
		if (!success) fail(index, op, `attribute ${name}: ${result}`);
	}
}

/**
 * Attach a new instance to its parent: now, when the parent is itself new and
 * detached, or as a deferred live action when the parent is already in the
 * DataModel.
 */
function attach(state: BuildState, instance: Instance, parent: Instance): void {
	if (isLive(state, parent)) {
		state.added.push(instance);
		state.attachedTo.set(instance, parent);
		state.actions.push({
			apply: () => {
				instance.Parent = parent;
			},
			undo: () => {
				instance.Parent = undefined;
			},
		});
	} else {
		instance.Parent = parent;
	}
}

function registerId(state: BuildState, step: Step, instance: Instance, index: number, op: string): void {
	if (step.id === undefined) return;
	if (!typeIs(step.id, "string") || step.id === "") fail(index, op, "id must be a non-empty string");
	const id = step.id as string;
	if (state.ids.has(id)) fail(index, op, `id ${id} is already used by an earlier step`);
	state.ids.set(id, instance);
	state.idOrder.push(id);
}

function countNew(state: BuildState, instance: Instance, index: number, op: string): void {
	state.newInstances += 1;
	state.totalInstances += 1 + instance.GetDescendants().size();
	if (state.newInstances > MAX_NEW_INSTANCES) {
		fail(index, op, `a batch may add at most ${MAX_NEW_INSTANCES} instances; split the build`);
	}
	if (state.totalInstances > MAX_TOTAL_INSTANCES) {
		fail(index, op, `a batch may add at most ${MAX_TOTAL_INSTANCES} instances including descendants; split the build`);
	}
}

function prepareCreate(state: BuildState, step: Step, index: number): void {
	const op = "create";
	if (!typeIs(step.className, "string") || step.className === "") fail(index, op, "className is required");
	const parent = step.parent === undefined ? state.root : resolveRef(state, step.parent, index, op, "parent", true);
	const [success, created] = pcall(() => new Instance(step.className as keyof CreatableInstances));
	if (!success || !created) fail(index, op, `cannot create ${step.className}: ${created}`);
	const instance = created as Instance;
	state.made.add(instance);
	countNew(state, instance, index, op);
	decorateDetached(state, instance, step, index, op);
	const properties = typeIs(step.properties, "table") ? (step.properties as Record<string, unknown>) : {};
	if (instance.IsA("Model") && properties.PrimaryPart === undefined && properties.WorldPivot === undefined) {
		state.unsettled.add(instance);
	}
	const position = readVector(step.position, index, op, "position");
	const rotation = readVector(step.rotation, index, op, "rotation");
	if (position || rotation) {
		if (!instance.IsA("BasePart")) {
			fail(index, op, `position and rotation place a created part; ${step.className} has none yet, so place its parts`);
		}
		applyPivot(instance, placement(instance.CFrame, position, rotation));
	}
	attach(state, instance, parent);
	registerId(state, step, instance, index, op);
	state.created += 1;
}

function prepareClone(state: BuildState, step: Step, index: number): void {
	const op = "clone";
	const source = resolveRef(state, step.source, index, op, "source", false);
	const parent = step.parent === undefined ? state.root : resolveRef(state, step.parent, index, op, "parent", true);
	let transforms: Step[] = [{}];
	if (step.transforms !== undefined) {
		if (!typeIs(step.transforms, "table") || (step.transforms as Step[]).size() === 0) {
			fail(index, op, "transforms must be a non-empty array");
		}
		transforms = step.transforms as Step[];
	}
	if (step.id !== undefined && transforms.size() > 1) {
		fail(index, op, "id names one instance; give an id only to a single clone");
	}
	// A template made earlier in this batch is complete by the time it is cloned.
	if (source.IsA("Model")) settlePivot(state, source);
	for (const transform of transforms) {
		if (!typeIs(transform, "table")) fail(index, op, "every transform must be an object");
		const [success, copied] = pcall(() => source.Clone());
		if (!success || !copied) fail(index, op, `${getInstancePath(source)} cannot be cloned (is Archivable off?)`);
		const instance = copied as Instance;
		state.made.add(instance);
		countNew(state, instance, index, op);
		decorateDetached(state, instance, step, index, op);
		const position = readVector(transform.position, index, op, "position");
		const rotation = readVector(transform.rotation, index, op, "rotation");
		const scale = readScale(transform.scale, index, op);
		if (scale !== undefined) {
			requirePlaceable(instance, index, op);
			applyScale(instance, scale);
		}
		if (position || rotation) applyPivot(instance, placement(currentPivot(instance, index, op), position, rotation));
		// A plan cannot describe a placement, or the properties a copy carries
		// beyond a name and children (a script's are reported; a Folder has none).
		if (scale !== undefined || position || rotation) state.decorated.add(instance);
		for (const copied of [instance, ...instance.GetDescendants()]) {
			if (!copied.IsA("LuaSourceContainer") && !copied.IsA("Folder")) state.decorated.add(copied);
		}
		attach(state, instance, parent);
		registerId(state, step, instance, index, op);
		state.cloned += 1;
	}
}

/** Plan edits to a live instance: convert and snapshot now, apply later. */
function prepareLiveSet(state: BuildState, target: Instance, step: Step, index: number, op: string): void {
	const writable = target as unknown as Record<string, unknown>;
	const properties: Record<string, unknown> = {};
	if (step.properties !== undefined) {
		if (!typeIs(step.properties, "table")) fail(index, op, "properties must be an object");
		for (const [property, value] of pairs(step.properties as Record<string, unknown>)) {
			properties[property as string] = value;
		}
	}
	if (step.name !== undefined) properties.Name = step.name;

	for (const property of sortedKeys(properties)) {
		const [readable, previous] = pcall(() => writable[property]);
		if (!readable) fail(index, op, `cannot read ${property}: ${previous}`);
		const requested = resolveProperty(state, target, property, properties[property], index, op);
		state.actions.push({
			apply: () => {
				writable[property] = requested;
				if (!samePropertyValue(writable[property], requested)) {
					error(`${getInstancePath(target)}.${property} did not take the requested value`, 0);
				}
			},
			undo: () => {
				// A write that was refused left the value alone; writing it back
				// through the same setter would only fail again.
				if (samePropertyValue(writable[property], previous)) return;
				writable[property] = previous;
			},
		});
	}

	const position = readVector(step.position, index, op, "position");
	const rotation = readVector(step.rotation, index, op, "rotation");
	if (position || rotation) {
		const before = currentPivot(target, index, op);
		const after = placement(before, position, rotation);
		state.actions.push({
			apply: () => applyPivot(target, after),
			undo: () => applyPivot(target, before),
		});
	}

	for (const tag of readTags(step.tags, index, op)) {
		state.tags.add(tag);
		if (target.HasTag(tag)) continue;
		state.actions.push({
			apply: () => target.AddTag(tag),
			undo: () => target.RemoveTag(tag),
		});
	}
	const attributes = readAttributes(step.attributes, index, op);
	for (const [name, value] of attributes) {
		const previous = target.GetAttribute(name);
		state.actions.push({
			apply: () => target.SetAttribute(name, value as AttributeValue),
			undo: () => target.SetAttribute(name, previous),
		});
	}

	const others: string[] = [];
	for (const property of sortedKeys(properties)) if (property !== "Name") others.push(property);
	state.liveOps.push({
		op: "set",
		target,
		name: properties.Name !== undefined ? tostring(properties.Name) : undefined,
		properties: others,
		placement: position !== undefined || rotation !== undefined,
		tags: readTags(step.tags, index, op).size() > 0,
		attributes: attributes.size() > 0,
	});
}

function prepareSet(state: BuildState, step: Step, index: number): void {
	const op = "set";
	const target = resolveRef(state, step.target, index, op, "target", true);
	if (state.serviceRoot && isLive(state, target)) {
		fail(index, op, `${getInstancePath(target)} was already there, and a batch whose root is the service ${getInstancePath(state.root)} only adds to it; change it with a build root below the service`);
	}
	if (isLive(state, target)) {
		prepareLiveSet(state, target, step, index, op);
		state.liveChanges += 1;
	} else {
		decorateDetached(state, target, step, index, op);
		const properties = typeIs(step.properties, "table") ? (step.properties as Record<string, unknown>) : {};
		const position = readVector(step.position, index, op, "position");
		const rotation = readVector(step.rotation, index, op, "rotation");
		if (target.IsA("Model")) {
			// A pivot the batch set itself is the author's; otherwise settle it before turning it.
			if (properties.PrimaryPart !== undefined || properties.WorldPivot !== undefined) state.unsettled.delete(target);
			else if (position || rotation) settlePivot(state, target);
		}
		if (position || rotation) {
			applyPivot(target, placement(currentPivot(target, index, op), position, rotation));
			state.decorated.add(target);
		}
	}
	state.updated += 1;
}

function prepareRemove(state: BuildState, step: Step, index: number): void {
	const op = "remove";
	if (state.serviceRoot) fail(index, op, serviceRootRefusal(state.root, op));
	const target = resolveRef(state, step.target, index, op, "target", true);
	if (target === state.root) {
		fail(index, op, `the build root itself can be removed only by a batch with no other step: send {op: "remove", target: "${state.rootPath}"} alone`);
	}
	if (!isLive(state, target)) fail(index, op, "an instance created in this batch cannot be removed; leave its step out");
	const previousParent = target.Parent;
	state.removed.add(target);
	// Parent = nil rather than Destroy: Studio's own delete does the same, and it
	// is what lets undo, and a failed batch, put the instance back.
	state.actions.push({
		apply: () => {
			target.Parent = undefined;
		},
		undo: () => {
			target.Parent = previousParent;
		},
	});
	state.removedCount += 1;
	state.liveChanges += 1;
	state.liveOps.push({ op: "remove", target, properties: [], placement: false, tags: false, attributes: false });
}

/** Prepare a complete replacement while the previous scatter remains live. */
function prepareScatter(state: BuildState, step: Step, index: number): void {
	const op = "scatter";
	if (state.serviceRoot) fail(index, op, serviceRootRefusal(state.root, op));
	const requireUniquePath = (instance: Instance) => {
		let current: Instance | undefined = instance;
		while (current && current.Parent) {
			let matches = 0;
			for (const sibling of current.Parent.GetChildren()) if (sibling.Name === current.Name) matches += 1;
			if (matches !== 1) fail(index, op, `${getInstancePath(current)} is ambiguous; use unique sibling names`);
			current = current.Parent;
		}
	};
	if (isLive(state, state.root)) requireUniquePath(state.root);
	else {
		const rootParent = resolveParentAndName(state.rootPath).parent;
		if (rootParent) requireUniquePath(rootParent);
	}
	const name = step.name;
	if (!typeIs(name, "string") || name === "" || name.size() > 100 ||
		name.split(".").size() > 1 || name.split("/").size() > 1 || name.split("\\").size() > 1) {
		fail(index, op, "name must be a unique group name of 1 to 100 characters without path separators");
	}
	if (step.replace !== undefined && !typeIs(step.replace, "boolean")) fail(index, op, "replace must be boolean");
	for (const field of ["className", "source", "target", "properties", "position", "transforms"]) {
		if (step[field] !== undefined) fail(index, op, `${field} is not supported by scatter`);
	}
	// Validate all decorations before doing any potentially expensive sampling.
	readTags(step.tags, index, op);
	readAttributes(step.attributes, index, op);
	const parent = step.parent === undefined ? state.root : resolveRef(state, step.parent, index, op, "parent", true);
	requireUniquePath(parent);
	let previous: Instance | undefined;
	for (const child of parent.GetChildren()) {
		if (child.Name !== name) continue;
		if (previous) fail(index, op, `multiple children named ${name}; resolve the ambiguous group first`);
		previous = child;
	}
	if (previous && (!step.replace || !previous.IsA("Model") ||
		!previous.HasTag("RoqerScatter") || previous.GetAttribute("RoqerScatterVersion") !== 1)) {
		fail(index, op, `${name} already exists; replace requires an owned version 1 scatter Model`);
	}
	const [planned, result] = pcall(() => ScatterPlanner.planScatter(step, (path) => {
		const instance = resolveRef(state, path, index, op, "scatter input", false);
		requireUniquePath(instance);
		return instance;
	}, previous));
	if (!planned) fail(index, op, tostring(result));
	const plan = result as ReturnType<typeof ScatterPlanner.planScatter>;
	const group = new Instance("Model");
	group.Name = name;
	state.made.add(group);
	countNew(state, group, index, op);
	group.AddTag("RoqerScatter");
	group.SetAttribute("RoqerScatterVersion", 1);
	group.SetAttribute("RoqerScatterSeed", step.seed as number);
	state.tags.add("RoqerScatter");
	for (let i = 0; i < plan.placements.size(); i++) {
		const item = plan.placements[i];
		const [success, copied] = pcall(() => item.source.Clone());
		if (!success || !copied) fail(index, op, `${getInstancePath(item.source)} cannot be cloned`);
		const instance = copied as Instance;
		state.made.add(instance);
		countNew(state, instance, index, op);
		decorateDetached(state, instance, { tags: step.tags, attributes: step.attributes }, index, op);
		instance.Name = `Item_${i + 1}`;
		if (item.kit !== undefined) {
			instance.AddTag("RoqerKit");
			instance.SetAttribute("RoqerKit", item.kit);
			state.tags.add("RoqerKit");
		}
		// Studio clamps unsupported Part sizes. A successful Size assignment
		// alone does not prove the planned footprint or bottom offset survived.
		const sizes = new Map<BasePart, Vector3>();
		if (instance.IsA("BasePart")) sizes.set(instance, instance.Size);
		else {
			for (const descendant of instance.GetDescendants()) {
				if (descendant.IsA("BasePart")) sizes.set(descendant, descendant.Size);
			}
		}
		applyScale(instance, item.scale);
		for (const [part, size] of sizes) {
			const expected = size.mul(item.scale);
			if (!samePropertyValue(part.Size.X, expected.X) || !samePropertyValue(part.Size.Y, expected.Y) || !samePropertyValue(part.Size.Z, expected.Z)) {
				fail(index, op, "Studio clamped a scaled template size; use larger parts or a smaller scale range");
			}
		}
		applyPivot(instance, placement(currentPivot(instance, index, op), item.position, item.rotation));
		const applied = currentPivot(instance, index, op).Position;
		if (!samePropertyValue(applied.X, item.position[0]) || !samePropertyValue(applied.Y, item.position[1]) || !samePropertyValue(applied.Z, item.position[2])) {
			fail(index, op, "Studio did not accept the planned scatter position");
		}
		instance.Parent = group;
		state.cloned += 1;
	}
	registerId(state, step, group, index, op);
	if (previous) prepareRemove(state, { target: getInstancePath(previous) }, index);
	attach(state, group, parent);
	state.created += 1;
	state.scatter = { requested: plan.requested, placed: plan.placements.size(), attempts: plan.attempts };
}

/**
 * A new instance and everything under it as the batch would add it, for a
 * caller that decides where the batch belongs before anything is applied (a
 * linked Rojo project saves new scripts to files instead). Extras are what a
 * name, class, and source cannot carry. A tree with no script in it, at the
 * top or directly under one that has scripts, also comes serialized as an
 * .rbxm (or with why it could not be), since that is the file it would be.
 */
function describeNew(
	state: BuildState,
	instance: Instance,
	idOf: Map<Instance, string>,
	budget: { source: number; rbxm: number; serialize: boolean },
	serializable: boolean,
): Record<string, unknown> {
	const node: Record<string, unknown> = { name: instance.Name, className: instance.ClassName };
	const id = idOf.get(instance);
	if (id !== undefined) node.id = id;
	const hasScript = instance.IsA("LuaSourceContainer") || instance.FindFirstChildWhichIsA("LuaSourceContainer", true) !== undefined;
	// Serializing costs time and payload, so only a plan asked for it does.
	if (budget.serialize && serializable && !hasScript) {
		const serialized = RojoPlan.serializeBase64(instance);
		if ("error" in serialized) node.rbxmError = serialized.error;
		else {
			budget.rbxm -= serialized.base64.size();
			if (budget.rbxm >= 0) node.rbxm = serialized.base64;
			else node.rbxmError = "the batch's models are too large to plan; build fewer at once";
		}
	}
	const extras: string[] = [];
	if (instance.IsA("LuaSourceContainer")) {
		const source = (instance as unknown as { Source: string }).Source;
		// The plan stays bounded: past the budget a source is left out, which the caller sees as an extra.
		budget.source -= source.size();
		if (budget.source >= 0) node.source = source;
		else extras.push("source too long to plan");
	}
	if (instance.IsA("BaseScript")) {
		node.runContext = instance.RunContext.Name;
		if (!instance.Enabled) node.disabled = true;
	}
	if (state.decorated.has(instance)) extras.push("properties");
	if (instance.GetTags().size() > 0) extras.push("tags");
	if (instance.GetAttributes().size() > 0) extras.push("attributes");
	if (extras.size() > 0) node.extras = extras;
	const children = instance.GetChildren();
	if (children.size() > 0) node.children = children.map((child) => describeNew(state, child, idOf, budget, hasScript));
	return node;
}

/** A live instance a plan edits or removes, with every script under it for the caller to compare against files. */
function describeLive(change: LiveOp): Record<string, unknown> {
	const target = change.target;
	const revisions = RojoPlan.scriptRevisions(target);
	return {
		op: change.op,
		path: getInstancePath(target),
		className: target.ClassName,
		uniquePath: hasUniquePath(target),
		descendants: target.GetDescendants().size(),
		scripts: revisions.scripts,
		...(revisions.omitted !== undefined ? { scriptsOmitted: revisions.omitted } : {}),
		...(change.op === "set"
			? {
				...(change.name !== undefined ? { name: change.name } : {}),
				properties: change.properties,
				placement: change.placement,
				tags: change.tags,
				attributes: change.attributes,
			}
			: {}),
	};
}

/** What the batch would do, with nothing applied: the new instances under each live parent, and how many live ones it edits or removes. */
function describePlan(state: BuildState, path: string, createdRoot: boolean, rootParent: Instance | undefined, serialize: boolean): Record<string, unknown> {
	const idOf = new Map<Instance, string>();
	for (const [id, instance] of state.ids) idOf.set(instance, id);
	const budget = { source: MAX_PLANNED_SOURCE, rbxm: MAX_PLANNED_RBXM, serialize };
	const tops: Array<[Instance, Instance]> = [];
	if (createdRoot && rootParent) tops.push([state.root, rootParent]);
	else for (const instance of state.added) {
		const parent = state.attachedTo.get(instance);
		if (parent) tops.push([instance, parent]);
	}
	return {
		planned: true,
		path: createdRoot ? path : getInstancePath(state.root),
		createdRoot,
		...(state.serviceRoot ? { serviceRoot: true } : {}),
		added: tops.map(([instance, parent]) => ({
			parentPath: getInstancePath(parent),
			parentUnique: hasUniquePath(parent),
			nameTaken: parent.FindFirstChild(instance.Name) !== undefined,
			node: describeNew(state, instance, idOf, budget, true),
		})),
		live: state.liveOps.map(describeLive),
		liveChanges: state.liveChanges,
		created: state.created,
		cloned: state.cloned,
		updated: state.updated,
		removed: state.removedCount,
	};
}

function destroyMade(state: BuildState): void {
	for (const instance of state.made) pcall(() => instance.Destroy());
}

function round(value: number): number {
	return math.floor(value * 100 + 0.5) / 100;
}

/** What the root holds once the batch has landed, read from the live tree. */
function summarize(state: BuildState): Record<string, unknown> {
	const classes: Record<string, number> = {};
	const tagCounts: Record<string, number> = {};
	let descendants = 0;
	let parts = 0;
	let minX = math.huge, minY = math.huge, minZ = math.huge;
	let maxX = -math.huge, maxY = -math.huge, maxZ = -math.huge;
	// Under a service root the root's descendants are the whole service (all
	// of Workspace, say), so only what this batch added is counted and bounded.
	let reported: Instance[] = state.root.GetDescendants();
	if (state.serviceRoot) {
		reported = [];
		for (const top of state.added) {
			reported.push(top);
			for (const descendant of top.GetDescendants()) reported.push(descendant);
		}
	}
	for (const instance of reported) {
		descendants += 1;
		classes[instance.ClassName] = (classes[instance.ClassName] ?? 0) + 1;
		for (const tag of state.tags) {
			if (instance.HasTag(tag)) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
		}
		if (instance.IsA("BasePart")) {
			parts += 1;
			const frame = instance.CFrame;
			const half = instance.Size.div(2);
			const right = frame.RightVector, up = frame.UpVector, look = frame.LookVector;
			const extentX = math.abs(right.X) * half.X + math.abs(up.X) * half.Y + math.abs(look.X) * half.Z;
			const extentY = math.abs(right.Y) * half.X + math.abs(up.Y) * half.Y + math.abs(look.Y) * half.Z;
			const extentZ = math.abs(right.Z) * half.X + math.abs(up.Z) * half.Y + math.abs(look.Z) * half.Z;
			const center = frame.Position;
			minX = math.min(minX, center.X - extentX);
			minY = math.min(minY, center.Y - extentY);
			minZ = math.min(minZ, center.Z - extentZ);
			maxX = math.max(maxX, center.X + extentX);
			maxY = math.max(maxY, center.Y + extentY);
			maxZ = math.max(maxZ, center.Z + extentZ);
		}
	}

	// The most common classes only: a build of hundreds of parts should not
	// return a line per class it happens to contain once.
	const topClasses: Record<string, number> = {};
	for (let picked = 0; picked < MAX_REPORTED_CLASSES; picked++) {
		let best: string | undefined;
		for (const [className, count] of pairs(classes)) {
			if (topClasses[className] === undefined && (best === undefined || count > classes[best])) best = className;
		}
		if (best === undefined) break;
		topClasses[best] = classes[best];
	}

	const ids: Record<string, string> = {};
	for (let i = 0; i < state.idOrder.size() && i < MAX_REPORTED_IDS; i++) {
		const id = state.idOrder[i];
		const instance = state.ids.get(id);
		if (instance) ids[id] = getInstancePath(instance);
	}

	return {
		descendants,
		classes: topClasses,
		tags: tagCounts,
		ids,
		...(state.idOrder.size() > MAX_REPORTED_IDS ? { idsOmitted: state.idOrder.size() - MAX_REPORTED_IDS } : {}),
		...(parts > 0
			? {
				bounds: {
					min: [round(minX), round(minY), round(minZ)],
					max: [round(maxX), round(maxY), round(maxZ)],
					size: [round(maxX - minX), round(maxY - minY), round(maxZ - minZ)],
				},
			}
			: {}),
	};
}

function buildInstances(requestData: Record<string, unknown>) {
	const path = requestData.path;
	const operations = requestData.operations as Step[] | undefined;
	if (!typeIs(path, "string") || path === "") return { error: "path (the build root) is required" };
	if (!typeIs(operations, "table") || operations.size() === 0) {
		return { error: "operations must be a non-empty array" };
	}
	if (operations.size() > MAX_OPERATIONS) {
		return { error: `a batch may have at most ${MAX_OPERATIONS} operations; split the build` };
	}
	if (operations.size() > 1) {
		for (const step of operations) {
			if (typeIs(step, "table") && step.op === "scatter") {
				return { error: "scatter must be the only step in a batch; commit ground and templates first" };
			}
		}
	}

	// planOnly prepares and describes the batch, then discards it: nothing is applied or recorded.
	const planOnly = requestData.planOnly === true;
	let root = resolveInstance(path as string, undefined);
	const only = operations.size() === 1 ? operations[0] : undefined;
	if (typeIs(only, "table") && only.op === "remove") {
		const removal = removeRootAlone(path as string, root, only, planOnly);
		if (removal !== undefined) return removal;
	}
	let createdRoot = false;
	let rootParent: Instance | undefined;
	let serviceRoot = false;
	const made = new Set<Instance>();
	const actions: LiveAction[] = [];
	if (root) {
		if (root === game) {
			return { error: "game cannot be a build root; choose one below a service, such as game.Workspace.MyBuild" };
		}
		if (root.Parent === game) {
			// Refused before anything is prepared, naming a root below the service
			// that was named: an agent building templates into ReplicatedStorage
			// gains nothing from a Workspace path.
			for (const step of operations) {
				const op = typeIs(step, "table") ? step.op : undefined;
				if (op === "remove" || op === "scatter") return { error: serviceRootRefusal(root, op) };
			}
			serviceRoot = true;
		}
	} else {
		const target = resolveParentAndName(path as string);
		if (target.name === undefined) {
			return { error: `${path} is not below a service; choose a build root below one, such as game.Workspace.MyBuild` };
		}
		if (!target.parent) {
			return { error: `${path} does not exist, and neither does its parent; create the parent first` };
		}
		const parent = target.parent;
		const model = new Instance("Model");
		model.Name = target.name;
		made.add(model);
		actions.push({
			apply: () => {
				model.Parent = parent;
			},
			undo: () => {
				model.Parent = undefined;
			},
		});
		root = model;
		createdRoot = true;
		rootParent = parent;
	}

	const state: BuildState = {
		root,
		rootPath: path as string,
		made,
		actions,
		ids: new Map(),
		idOrder: [],
		removed: new Set(),
		tags: new Set(),
		newInstances: 0,
		totalInstances: 0,
		created: 0,
		cloned: 0,
		updated: 0,
		removedCount: 0,
		unsettled: new Set(),
		serviceRoot,
		added: [],
		attachedTo: new Map(),
		decorated: new Set(),
		liveChanges: 0,
		liveOps: [],
	};

	const [prepared, prepareError] = pcall(() => {
		for (let i = 0; i < operations.size(); i++) {
			const step = operations[i];
			const index = i + 1;
			if (!typeIs(step, "table")) fail(index, "?", "every operation must be an object");
			const op = step.op;
			if (op === "create") prepareCreate(state, step, index);
			else if (op === "clone") prepareClone(state, step, index);
			else if (op === "set") prepareSet(state, step, index);
			else if (op === "remove") prepareRemove(state, step, index);
			else if (op === "scatter") prepareScatter(state, step, index);
			else fail(index, tostring(op), "op must be create, clone, set, remove, or scatter");
		}
		for (const model of state.unsettled) settlePivot(state, model);
	});
	if (!prepared) {
		destroyMade(state);
		return { error: `${tostring(prepareError)}. Nothing was changed.` };
	}
	if (planOnly) {
		const plan = describePlan(state, path as string, createdRoot, rootParent, requestData.serialize === true);
		destroyMade(state);
		return plan;
	}

	const recordingId = beginRecording(`Build ${root.Name}`);
	const applied: LiveAction[] = [];
	for (const action of state.actions) {
		const [success, result] = pcall(() => {
			// Pushed first so an action that fails halfway is undone too.
			applied.push(action);
			action.apply();
		});
		if (!success) {
			const failures: string[] = [];
			for (let i = applied.size() - 1; i >= 0; i--) {
				const [undone, undoError] = pcall(applied[i].undo);
				if (!undone) failures.push(tostring(undoError));
			}
			finishRecording(recordingId, false);
			destroyMade(state);
			return {
				error: `Applying the build failed: ${result}. ${failures.size() === 0
					? "Every applied change was rolled back."
					: `Rollback was incomplete: ${failures.join("; ")}`}`,
				rolledBack: failures.size() === 0,
			};
		}
	}
	finishRecording(recordingId, true);

	return {
		path: getInstancePath(root),
		...(state.scatter ? { scatter: state.scatter } : {}),
		instanceRef: getInstanceReference(root),
		createdRoot,
		// Its counts and bounds cover what the batch added, not the whole service.
		...(serviceRoot ? { serviceRoot: true } : {}),
		created: state.created,
		cloned: state.cloned,
		updated: state.updated,
		removed: state.removedCount,
		undoable: recordingId !== undefined,
		...summarize(state),
	};
}

export = {
	buildInstances,
};
