import Utils from "../Utils";
import Recording from "../Recording";
import { sourceRevision } from "../SourceRevision";

const { getInstancePath, resolveInstance, resolveParentAndName, getInstanceReference, readScriptSource } = Utils;
const { beginRecording, finishRecording } = Recording;

const Players = game.GetService("Players");
const Workspace = game.GetService("Workspace");

/**
 * Build and preview character animations from a compiled description.
 *
 * Core compiles and checks the pose description; the plugin only turns the
 * compiled keyframes into instances. `previewAnimation` plays them on a
 * temporary R15 or R6 dummy, as the sequence's rig says, or on a temporary
 * copy of the model whose rig it was written for, and reports the joints,
 * without leaving anything behind.
 * `buildAnimation` writes the KeyframeSequence as one undo step, replacing a
 * sequence only when it was built here, is unchanged since, and matches the
 * revision the caller expects.
 */

const REVISION_ATTRIBUTE = "RoqerAnimationRevision";
const PREVIEW_FOLDER = "__RoqerAnimationPreview";
const MAX_KEYFRAMES = 240;
/** A keyframe's poses and their nesting: a rig's joints, at most 64, and its root. */
const MAX_POSES_PER_KEYFRAME = 65;
const MAX_POSE_DEPTH = 65;
const MAX_NAME_LENGTH = 100;
const MAX_MARKERS_PER_KEYFRAME = 16;
const MAX_MARKER_VALUE_LENGTH = 200;
const MAX_SAMPLES = 32;
const TRACK_LOAD_SECONDS = 10;

type Data = Record<string, unknown>;

interface AnimatorWithStep extends Animator {
	StepAnimations(deltaTime: number): void;
}

interface ClipProvider extends Instance {
	RegisterAnimationClip(clip: KeyframeSequence): unknown;
}

function enumItem<T extends EnumItem>(items: T[], name: unknown, what: string): T {
	for (const item of items) {
		if (item.Name === name) return item;
	}
	error(`${what} ${tostring(name)} is not valid`);
}

function checkName(value: unknown, what: string): string {
	if (!typeIs(value, "string") || value === "" || value.size() > MAX_NAME_LENGTH) {
		error(`${what} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
	}
	return value;
}

function buildPose(data: unknown, parent: Instance, depth: number, count: { value: number }) {
	if (!typeIs(data, "table")) error("every pose must be an object");
	if (depth > MAX_POSE_DEPTH) error(`poses nest at most ${MAX_POSE_DEPTH} deep`);
	count.value += 1;
	if (count.value > MAX_POSES_PER_KEYFRAME) error(`a keyframe holds at most ${MAX_POSES_PER_KEYFRAME} poses`);
	const pose = data as Data;
	const cframe = pose.cframe;
	if (!typeIs(cframe, "table") || (cframe as unknown[]).size() !== 12) error("a pose's cframe must be 12 numbers");
	const c = cframe as number[];
	for (const value of c) {
		if (!typeIs(value, "number") || value !== value || math.abs(value) === math.huge) error("a pose's cframe must be finite numbers");
	}
	const weight = pose.weight;
	if (!typeIs(weight, "number") || weight < 0 || weight > 1) error("a pose's weight must be between 0 and 1");
	const instance = new Instance("Pose");
	instance.Name = checkName(pose.part, "a pose's part");
	instance.Weight = weight;
	instance.CFrame = new CFrame(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11]);
	instance.EasingStyle = enumItem(Enum.PoseEasingStyle.GetEnumItems(), pose.easingStyle, "easing style");
	instance.EasingDirection = enumItem(Enum.PoseEasingDirection.GetEnumItems(), pose.easingDirection, "easing direction");
	const children = pose.children;
	if (children !== undefined && !typeIs(children, "table")) error("a pose's children must be an array");
	for (const child of (children as unknown[] | undefined) ?? []) buildPose(child, instance, depth + 1, count);
	instance.Parent = parent;
}

/** KeyframeMarkers, which AnimationTrack:GetMarkerReachedSignal fires at their keyframe's time. */
function buildMarkers(data: unknown, keyframe: Keyframe) {
	if (data === undefined) return;
	if (!typeIs(data, "table")) error("a keyframe's markers must be an array");
	const list = data as unknown[];
	if (list.size() > MAX_MARKERS_PER_KEYFRAME) error(`a keyframe holds at most ${MAX_MARKERS_PER_KEYFRAME} markers`);
	for (const entry of list) {
		if (!typeIs(entry, "table")) error("every marker must be an object");
		const marker = entry as Data;
		const value = marker.value;
		if (!typeIs(value, "string") || value.size() > MAX_MARKER_VALUE_LENGTH) {
			error(`a marker's value must be a string of at most ${MAX_MARKER_VALUE_LENGTH} characters`);
		}
		const instance = new Instance("KeyframeMarker");
		instance.Name = checkName(marker.name, "a marker's name");
		instance.Value = value;
		instance.Parent = keyframe;
	}
}

/** A detached KeyframeSequence from the compiled description, or an error. */
function buildSequence(data: unknown): KeyframeSequence {
	if (!typeIs(data, "table")) error("sequence must be an object");
	const description = data as Data;
	const keyframes = description.keyframes;
	if (!typeIs(keyframes, "table")) error("sequence.keyframes must be an array");
	const list = keyframes as unknown[];
	if (list.size() === 0 || list.size() > MAX_KEYFRAMES) error(`a sequence holds 1 to ${MAX_KEYFRAMES} keyframes`);
	if (!typeIs(description.loop, "boolean")) error("sequence.loop must be true or false");

	const sequence = new Instance("KeyframeSequence");
	const [ok, err] = pcall(() => {
		sequence.Name = checkName(description.name, "sequence.name");
		sequence.Loop = description.loop as boolean;
		sequence.Priority = enumItem(Enum.AnimationPriority.GetEnumItems(), description.priority, "priority");
		let previous = -1;
		for (const entry of list) {
			if (!typeIs(entry, "table")) error("every keyframe must be an object");
			const keyframe = entry as Data;
			const time = keyframe.time;
			if (!typeIs(time, "number") || time !== time || time <= previous || time > 60) {
				error("keyframe times must rise from 0 and stay within 60 seconds");
			}
			previous = time;
			const instance = new Instance("Keyframe");
			instance.Time = time;
			if (keyframe.name !== undefined) instance.Name = checkName(keyframe.name, "a keyframe's name");
			buildPose(keyframe.root, instance, 1, { value: 0 });
			buildMarkers(keyframe.markers, instance);
			instance.Parent = sequence;
		}
	});
	if (!ok) {
		sequence.Destroy();
		error(err, 0);
	}
	return sequence;
}

function formatNumber(value: number): string {
	// Adding zero folds -0 into 0, so the same pose always hashes alike.
	return string.format("%.5f", value + 0);
}

function describePose(pose: Pose, depth: number, out: string[]) {
	const c = pose.CFrame.GetComponents();
	const numbers: string[] = [];
	for (const value of c) numbers.push(formatNumber(value));
	out.push(`p:${depth}:${pose.Name}:${formatNumber(pose.Weight)}:${pose.EasingStyle.Name}:${pose.EasingDirection.Name}:${numbers.join(",")}`);
	const children = pose.GetChildren().filter((child): child is Pose => child.IsA("Pose"));
	children.sort((a, b) => a.Name < b.Name);
	for (const child of children) describePose(child, depth + 1, out);
}

/**
 * A revision of the sequence's content: its keyframes and poses as they stand,
 * not its attributes. An edit in the Animation Editor changes it.
 */
function sequenceRevision(sequence: KeyframeSequence): string {
	const out: string[] = [`s:${tostring(sequence.Loop)}:${sequence.Priority.Name}`];
	const keyframes = sequence.GetChildren().filter((child): child is Keyframe => child.IsA("Keyframe"));
	keyframes.sort((a, b) => (a.Time === b.Time ? a.Name < b.Name : a.Time < b.Time));
	for (const keyframe of keyframes) {
		out.push(`k:${formatNumber(keyframe.Time)}:${keyframe.Name}`);
		const poses = keyframe.GetChildren().filter((child): child is Pose => child.IsA("Pose"));
		poses.sort((a, b) => a.Name < b.Name);
		for (const pose of poses) describePose(pose, 1, out);
		// Only a sequence with markers hashes them, so a revision taken before
		// markers existed still matches its unchanged sequence.
		const markers = keyframe.GetChildren().filter((child): child is KeyframeMarker => child.IsA("KeyframeMarker"));
		markers.sort((a, b) => (a.Name === b.Name ? a.Value < b.Value : a.Name < b.Name));
		for (const marker of markers) out.push(`m:${marker.Name}:${marker.Value}`);
	}
	return `kr1:${sourceRevision(out.join("\n")).sub(5)}`;
}

function countContent(sequence: KeyframeSequence) {
	let keyframes = 0;
	let poses = 0;
	let markers = 0;
	for (const descendant of sequence.GetDescendants()) {
		if (descendant.IsA("Keyframe")) keyframes += 1;
		else if (descendant.IsA("Pose")) poses += 1;
		else if (descendant.IsA("KeyframeMarker")) markers += 1;
	}
	return { keyframes, poses, markers };
}

function componentsOf(cframe: CFrame): number[] {
	const out: number[] = [];
	for (const value of cframe.GetComponents()) out.push(math.round(value * 1e6) / 1e6);
	return out;
}

/**
 * A rig's animated joints, by the name of the part each moves: a Motor6D, or
 * an AnimationConstraint, which Roblox's avatar joint upgrade builds stock
 * bodies with instead.
 */
function animatedJoints(rig: Instance): Map<string, Instance> {
	const joints = new Map<string, Instance>();
	for (const descendant of rig.GetDescendants()) {
		if (descendant.IsA("AnimationConstraint")) {
			const attachment = descendant.Attachment1;
			if (attachment && attachment.Parent) joints.set(attachment.Parent.Name, descendant);
		} else if (descendant.IsA("Motor6D") && descendant.Part1) {
			joints.set(descendant.Part1.Name, descendant);
		}
	}
	return joints;
}

function destroyQuietly(instance: Instance | undefined) {
	if (instance) pcall(() => instance.Destroy());
}

const MAX_PROPS = 8;

/**
 * Give a preview dummy the props the animation moves, rigged as a game rigs
 * them: a part moved by a Motor6D from a body part, whose C0 is the given
 * one, placed at the named attachment's position when there is one, and
 * whose C1 is the identity. An attachment's own turn is not used: R15's
 * grips are turned and R6's are not, and a prop points the same way on both.
 */
function addProps(rig: Model, data: unknown) {
	if (data === undefined) return;
	if (!typeIs(data, "table") || (data as unknown[]).size() > MAX_PROPS) error(`props must be an array of at most ${MAX_PROPS}`);
	for (const entry of data as unknown[]) {
		if (!typeIs(entry, "table")) error("every prop must be an object");
		const prop = entry as Data;
		const name = checkName(prop.part, "a prop's part");
		const parentName = checkName(prop.parent, "a prop's parent");
		const body = rig.FindFirstChild(parentName);
		if (!body || !body.IsA("BasePart")) error(`the preview dummy has no ${parentName} to hold ${name}`);
		const c = prop.c0;
		if (!typeIs(c, "table") || (c as unknown[]).size() !== 12) error("a prop's c0 must be 12 numbers");
		const n = c as number[];
		for (const value of n) {
			if (!typeIs(value, "number") || value !== value || math.abs(value) === math.huge) error("a prop's c0 must be finite numbers");
		}
		let c0 = new CFrame(n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8], n[9], n[10], n[11]);
		if (prop.attachment !== undefined) {
			const attachment = body.FindFirstChild(checkName(prop.attachment, "a prop's attachment"));
			if (!attachment || !attachment.IsA("Attachment")) error(`the preview dummy's ${parentName} has no ${tostring(prop.attachment)}`);
			c0 = new CFrame(attachment.Position).mul(c0.Rotation);
		}
		const part = new Instance("Part");
		part.Name = name;
		part.Size = new Vector3(0.2, 0.2, 0.2);
		part.CanCollide = false;
		part.CanQuery = false;
		part.CanTouch = false;
		part.Massless = true;
		part.Transparency = 1;
		part.CFrame = body.CFrame.mul(c0);
		const motor = new Instance("Motor6D");
		motor.Name = name;
		motor.Part0 = body;
		motor.Part1 = part;
		motor.C0 = c0;
		motor.C1 = new CFrame();
		motor.Parent = body;
		part.Parent = rig;
	}
}

function previewAnimation(requestData: Data) {
	const times = requestData.sampleTimes;
	if (!typeIs(times, "table") || (times as unknown[]).size() === 0 || (times as unknown[]).size() > MAX_SAMPLES) {
		return { error: `sampleTimes must hold 1 to ${MAX_SAMPLES} times` };
	}
	const sampleTimes = times as number[];
	let last = -1;
	for (const time of sampleTimes) {
		if (!typeIs(time, "number") || time < last) return { error: "sampleTimes must be numbers in rising order" };
		last = time;
	}

	// A model's own rig is previewed on a copy of the model, and only while its
	// rig is as it was when the animation was checked.
	let model: AnimatedModel | undefined;
	if (requestData.model !== undefined) {
		const request = requestData.model;
		if (!typeIs(request, "table")) return { error: "model must be {path, revision}.", errorCode: "invalid_arguments" };
		const found = animatedModel((request as Data).path);
		if ("error" in found) return found;
		const reading = readModelRig(found);
		if ("error" in reading) return reading;
		if (reading.revision !== (request as Data).revision) {
			return { error: `${reading.path}'s rig has changed since the animation was checked against it; check it again.`, errorCode: "stale_rig" };
		}
		const refusal = copyRefusal(found.model);
		if (refusal !== undefined) return { error: `${refusal}.`, errorCode: "model_not_copyable" };
		model = found;
	}

	const [built, sequenceOrError] = pcall(() => buildSequence(requestData.sequence));
	if (!built) return { error: tostring(sequenceOrError) };
	const sequence = sequenceOrError as KeyframeSequence;

	// A dummy must be in the DataModel for its Animator to play; outside a
	// ChangeHistory recording, this temporary folder leaves no undo step.
	for (const child of Workspace.GetChildren()) {
		if (child.Name === PREVIEW_FOLDER && child.IsA("Folder")) destroyQuietly(child);
	}
	let folder: Folder | undefined;
	let animation: Animation | undefined;
	let track: AnimationTrack | undefined;
	const [ok, result] = pcall(() => {
		const provider = game.GetService("AnimationClipProvider" as keyof Services) as unknown as ClipProvider;
		const id = tostring(provider.RegisterAnimationClip(sequence));
		folder = new Instance("Folder");
		folder.Name = PREVIEW_FOLDER;
		folder.Archivable = false;
		folder.Parent = Workspace;
		let rig: Model;
		let root: Instance | undefined;
		if (model) {
			rig = model.model.Clone();
			// Nothing in the copy runs: it is only posed.
			for (const descendant of rig.GetDescendants()) {
				if (descendant.IsA("BaseScript")) descendant.Enabled = false;
			}
			// Its root is the one part its joints hang from, as its reading found:
			// a copy's Humanoid does not know its root part until it is placed.
			const roots = jointRoots(modelJoints(rig));
			if (roots.size() !== 1) error("the copy of the model does not hang from one root");
			root = roots[0];
		} else {
			const rigType = (requestData.sequence as Data).rig === "R6" ? Enum.HumanoidRigType.R6 : Enum.HumanoidRigType.R15;
			rig = Players.CreateHumanoidModelFromDescription(new Instance("HumanoidDescription"), rigType);
			root = rig.FindFirstChild("HumanoidRootPart");
		}
		rig.Archivable = false;
		rig.PivotTo(new CFrame(0, 100000, 0));
		if (root && root.IsA("BasePart")) root.Anchored = true;
		rig.Parent = folder;
		if (!model) addProps(rig, requestData.props);

		const joints = animatedJoints(rig);
		const controller = rig.FindFirstChildOfClass("Humanoid") ?? rig.FindFirstChildOfClass("AnimationController");
		if (!controller) error("the preview dummy has no Humanoid");
		let animator = controller.FindFirstChildOfClass("Animator");
		if (!animator) {
			animator = new Instance("Animator");
			animator.Parent = controller;
		}
		const stepper = animator as AnimatorWithStep;
		animation = new Instance("Animation");
		animation.AnimationId = id;
		track = animator.LoadAnimation(animation);
		track.Play(0);
		const deadline = os.clock() + TRACK_LOAD_SECONDS;
		while (track.Length === 0 && os.clock() < deadline) task.wait(0.05);
		if (track.Length === 0) error("the preview track never loaded");

		const samples: { time: number; transforms: Record<string, number[]> }[] = [];
		stepper.StepAnimations(0);
		let current = 0;
		for (const time of sampleTimes) {
			if (time > current) stepper.StepAnimations(time - current);
			current = time;
			const transforms: Record<string, number[]> = {};
			for (const [part, joint] of joints) {
				transforms[part] = componentsOf((joint as unknown as { Transform: CFrame }).Transform);
			}
			samples.push({ time: track.TimePosition, transforms });
		}
		return { length: track.Length, samples };
	});

	if (track) {
		const playing = track;
		pcall(() => playing.Stop(0));
	}
	destroyQuietly(track);
	destroyQuietly(animation);
	destroyQuietly(folder);
	destroyQuietly(sequence);
	if (!ok) return { error: `${tostring(result)}.` };
	return result;
}

function buildAnimation(requestData: Data) {
	const parentPath = requestData.parentPath;
	if (!typeIs(parentPath, "string") || parentPath === "") return { error: "parentPath is required" };
	const expectedRevision = requestData.expectedRevision;
	if (expectedRevision !== undefined && !typeIs(expectedRevision, "string")) {
		return { error: "expectedRevision must be a string" };
	}
	const parent = resolveInstance(parentPath, undefined);
	if (!parent) return { error: `${parentPath} does not exist; create it first. Nothing was built.` };
	if (parent === game) return { error: "Choose a parent below game, such as game.ServerStorage. Nothing was built." };

	const [built, sequenceOrError] = pcall(() => buildSequence(requestData.sequence));
	if (!built) return { error: `${tostring(sequenceOrError)}. Nothing was built.` };
	const sequence = sequenceOrError as KeyframeSequence;
	const refuse = (body: Data) => {
		sequence.Destroy();
		return body;
	};

	const namesake = parent.GetChildren().filter((child) => child.Name === sequence.Name);
	if (namesake.size() > 1) {
		return refuse({ error: `${parentPath} holds ${namesake.size()} children named ${sequence.Name}; rename all but one first. Nothing was built.`, errorCode: "ambiguous_target" });
	}
	const existing = namesake[0];
	let currentRevision: string | undefined;
	if (existing) {
		if (!existing.IsA("KeyframeSequence")) {
			return refuse({ error: `${getInstancePath(existing)} is a ${existing.ClassName}, not a KeyframeSequence; choose another name. Nothing was built.`, errorCode: "target_not_animation" });
		}
		const stamp = existing.GetAttribute(REVISION_ATTRIBUTE);
		if (!typeIs(stamp, "string")) {
			return refuse({ error: `${getInstancePath(existing)} was not built by this tool, so it is not replaced; choose another name. Nothing was built.`, errorCode: "target_not_built_here" });
		}
		currentRevision = sequenceRevision(existing);
		if (currentRevision !== stamp) {
			return refuse({ error: `${getInstancePath(existing)} was edited after it was built, so it is not replaced; keep the edit, or delete it and build again. Nothing was built.`, errorCode: "animation_edited_since_build", currentRevision });
		}
		if (expectedRevision === undefined) {
			return refuse({ error: `${getInstancePath(existing)} already exists; pass its revision as expected_revision to replace it. Nothing was built.`, errorCode: "revision_required", currentRevision });
		}
		if (expectedRevision !== currentRevision) {
			return refuse({ error: `${getInstancePath(existing)} changed since that revision; build again with the current one. Nothing was built.`, errorCode: "revision_conflict", currentRevision });
		}
	} else if (expectedRevision !== undefined) {
		return refuse({ error: `No sequence named ${sequence.Name} is in ${parentPath} to replace; omit expected_revision to create it. Nothing was built.`, errorCode: "revision_conflict" });
	}

	const revision = sequenceRevision(sequence);
	sequence.SetAttribute(REVISION_ATTRIBUTE, revision);

	const recordingId = beginRecording(`Build animation ${sequence.Name}`);
	const [applied, applyError] = pcall(() => {
		if (existing) existing.Parent = undefined;
		sequence.Parent = parent;
	});
	if (!applied) {
		pcall(() => {
			sequence.Parent = undefined;
			if (existing) existing.Parent = parent;
		});
		finishRecording(recordingId, false);
		sequence.Destroy();
		return { error: `Writing the animation failed: ${tostring(applyError)}. The previous state was restored.` };
	}
	finishRecording(recordingId, true);

	const readBack = countContent(sequence);
	return {
		path: getInstancePath(sequence),
		instanceRef: getInstanceReference(sequence),
		revision: sequenceRevision(sequence),
		stampMatches: sequenceRevision(sequence) === revision,
		replaced: existing !== undefined,
		keyframes: readBack.keyframes,
		poses: readBack.poses,
		markers: readBack.markers,
		undoable: recordingId !== undefined,
	};
}

/** A built sequence, confirmed unchanged since its build, with who owns the place. */
function animationPublishInfo(requestData: Data) {
	const path = requestData.path;
	if (!typeIs(path, "string") || path === "") return { error: "path is required." };
	const target = resolveInstance(path, undefined);
	if (!target) return { error: `${path} does not exist.` };
	if (!target.IsA("KeyframeSequence")) return { error: `${path} is a ${target.ClassName}, not a KeyframeSequence.`, errorCode: "target_not_animation" };
	const stamp = target.GetAttribute(REVISION_ATTRIBUTE);
	if (!typeIs(stamp, "string")) {
		return { error: `${path} was not built by this tool; build it first, so its motion is checked.`, errorCode: "target_not_built_here" };
	}
	const revision = sequenceRevision(target);
	if (revision !== stamp) {
		return { error: `${path} was edited after it was built; build it again, so the published motion is the checked one.`, errorCode: "animation_edited_since_build" };
	}
	return {
		path: getInstancePath(target),
		name: target.Name,
		revision,
		placeCreatorType: game.CreatorType.Name,
		placeCreatorId: game.CreatorId,
		placeId: game.PlaceId,
	};
}

/** The published asset as Roblox serves it back, compared with the revision that was built. */
function animationReadBack(requestData: Data) {
	const assetId = requestData.assetId;
	const expected = requestData.expectedRevision;
	if (!typeIs(assetId, "string") || assetId.match("^%d+$")[0] === undefined) return { error: "assetId must be digits." };
	const [ok, fetched] = pcall(() =>
		game.GetService("KeyframeSequenceProvider").GetKeyframeSequenceAsync(`rbxassetid://${assetId}`),
	);
	if (!ok || !typeIs(fetched, "Instance") || !fetched.IsA("KeyframeSequence")) {
		return { error: `Roblox did not return the published animation: ${tostring(fetched)}` };
	}
	const revision = sequenceRevision(fetched);
	const counts = countContent(fetched);
	fetched.Destroy();
	return { revision, matches: revision === expected, keyframes: counts.keyframes, poses: counts.poses, markers: counts.markers };
}

const LOADER_NAME = "RoqerAnimate";
const WIRE_SLOTS = ["idle", "walk", "run", "jump", "fall", "climb", "swim", "swimidle", "sit"];
/** The loader's whole code. It never changes; the animation IDs are its attributes. */
const LOADER_SOURCE = `-- Built by Roqer. Sets each character's default Animate script to the
-- animation IDs held in this script's attributes, one per Animate slot
-- (idle, walk, run, jump, fall, climb, swim, swimidle, sit). Roqer's animation
-- tool changes the attributes; this code stays as it is.
local Players = game:GetService("Players")

local function apply(character)
	local animate = character:WaitForChild("Animate", 10)
	if not animate then
		return
	end
	for slot, id in script:GetAttributes() do
		local folder = animate:FindFirstChild(slot)
		if folder and typeof(id) == "string" then
			for _, child in folder:GetChildren() do
				if child:IsA("Animation") then
					child.AnimationId = id
				end
			end
		end
	end
end

local function watch(player)
	player.CharacterAdded:Connect(apply)
	if player.Character then
		task.spawn(apply, player.Character)
	end
end

Players.PlayerAdded:Connect(watch)
for _, player in Players:GetPlayers() do
	watch(player)
end
`;

function animationWire(requestData: Data) {
	const slot = requestData.slot;
	const animationId = requestData.animationId;
	const expectedId = requestData.expectedId;
	if (!typeIs(slot, "string") || !WIRE_SLOTS.includes(slot)) return { error: `slot must be one of ${WIRE_SLOTS.join(", ")}.` };
	if (!typeIs(animationId, "string") || animationId.match("^rbxassetid://%d+$")[0] === undefined) {
		return { error: "animationId must be rbxassetid://<digits>." };
	}
	if (expectedId !== undefined && !typeIs(expectedId, "string")) return { error: "expectedId must be a string." };

	const service = game.GetService("ServerScriptService");
	const named = service.GetChildren().filter((child) => child.Name === LOADER_NAME);
	if (named.size() > 1) {
		return { error: `ServerScriptService holds ${named.size()} children named ${LOADER_NAME}; keep one. Nothing was wired.`, errorCode: "ambiguous_target" };
	}
	const existing = named[0];
	if (existing && (!existing.IsA("Script") || readScriptSource(existing) !== LOADER_SOURCE)) {
		return { error: `${getInstancePath(existing)} is not the loader this tool installs, or its code was changed; it is left alone. Nothing was wired.`, errorCode: "loader_modified" };
	}
	const current = existing?.GetAttribute(slot);
	const currentId = typeIs(current, "string") ? current : undefined;
	if (currentId !== undefined && expectedId === undefined) {
		return { error: `The ${slot} slot already holds ${currentId}; pass it as expected_id to replace it. Nothing was wired.`, errorCode: "expected_id_required", currentId };
	}
	if (currentId !== expectedId) {
		return {
			error: currentId === undefined
				? `The ${slot} slot holds nothing yet; omit expected_id. Nothing was wired.`
				: `The ${slot} slot holds ${currentId}, not ${expectedId}; someone changed it. Nothing was wired.`,
			errorCode: "animation_id_changed",
			currentId: currentId ?? false,
		};
	}

	const recordingId = beginRecording(`Wire ${slot} animation`);
	let loader = existing as Script | undefined;
	const installed = loader === undefined;
	const [applied, applyError] = pcall(() => {
		if (!loader) {
			const created = new Instance("Script");
			created.Name = LOADER_NAME;
			created.Source = LOADER_SOURCE;
			created.SetAttribute(slot, animationId);
			created.Parent = service;
			loader = created;
		} else {
			loader.SetAttribute(slot, animationId);
		}
	});
	if (!applied) {
		pcall(() => {
			if (installed && loader) loader.Destroy();
			else if (loader) loader.SetAttribute(slot, currentId);
		});
		finishRecording(recordingId, false);
		return { error: `Wiring failed: ${tostring(applyError)}. The previous state was restored.` };
	}
	finishRecording(recordingId, true);
	const wired = loader as Script;
	return {
		loader: getInstancePath(wired),
		installed,
		slot,
		animationId: wired.GetAttribute(slot),
		previousId: currentId ?? false,
		readBackMatches: wired.GetAttribute(slot) === animationId && readScriptSource(wired) === LOADER_SOURCE,
		undoable: recordingId !== undefined,
		...(installed ? { loaderSource: LOADER_SOURCE } : {}),
	};
}

/**
 * On a playtest client: report what the character's Animate slot holds and is
 * playing, then play the animation on the character as the player sees it and
 * sample its joints on the Animator's own clock.
 */
function animationVerify(requestData: Data) {
	const player = Players.LocalPlayer;
	if (!player) return { error: "This is not a playtest client." };
	let character = player.Character;
	const deadline = os.clock() + 10;
	while (!character && os.clock() < deadline) {
		task.wait(0.1);
		character = player.Character;
	}
	if (!character) return { error: "The player has no character yet." };
	const humanoid = character.WaitForChild("Humanoid", 10) as Humanoid | undefined;
	const animator = humanoid?.WaitForChild("Animator", 10) as Animator | undefined;
	if (!humanoid || !animator) return { error: "The character has no Humanoid with an Animator." };

	const slot = requestData.slot;
	let wiredIds: string[] | undefined;
	let playingIds: string[] | undefined;
	if (typeIs(slot, "string")) {
		wiredIds = [];
		const folder = character.FindFirstChild("Animate")?.FindFirstChild(slot);
		for (const child of folder?.GetChildren() ?? []) {
			if (child.IsA("Animation")) wiredIds.push(child.AnimationId);
		}
		// Read before the verification track starts, so it cannot count itself.
		playingIds = [];
		for (const playing of animator.GetPlayingAnimationTracks()) {
			playingIds.push(playing.Animation ? playing.Animation.AnimationId : "");
		}
	}

	const played = playAndSample(character, animator, requestData, "the character");
	if ("error" in played) return played;
	return { ...played, rigType: humanoid.RigType.Name, ...(wiredIds ? { wiredIds, playingIds } : {}) };
}

type PlayedSamples = { length: number; samples: { time: number; transforms: Record<string, number[]> }[] };

/**
 * Play an animation on a rig's Animator as a game would, above whatever else
 * it plays, and sample the rig's joints on the Animator's own clock; then stop
 * it, leaving nothing behind. The animation is the published animationId, or
 * a temporary clip built from the compiled sequence.
 */
function playAndSample(rig: Instance, animator: Animator, requestData: Data, what: string): PlayedSamples | { error: string } {
	let sequence: KeyframeSequence | undefined;
	let animation: Animation | undefined;
	let track: AnimationTrack | undefined;
	const [ok, result] = pcall(() => {
		let id = requestData.animationId;
		if (!typeIs(id, "string")) {
			sequence = buildSequence(requestData.sequence);
			const provider = game.GetService("AnimationClipProvider" as keyof Services) as unknown as ClipProvider;
			id = tostring(provider.RegisterAnimationClip(sequence));
		}
		const joints = animatedJoints(rig);
		animation = new Instance("Animation");
		animation.AnimationId = id as string;
		track = animator.LoadAnimation(animation);
		track.Priority = Enum.AnimationPriority.Action4;
		track.Play(0);
		const loadDeadline = os.clock() + TRACK_LOAD_SECONDS;
		while (track.Length === 0 && os.clock() < loadDeadline) task.wait(0.05);
		if (track.Length === 0) error(`the animation never loaded on ${what}`);
		const count = 10;
		const gap = math.max(track.Length, 0.2) / (count + 1);
		const samples: { time: number; transforms: Record<string, number[]> }[] = [];
		for (let index = 0; index < count; index++) {
			task.wait(gap);
			if (!track.IsPlaying) break;
			const transforms: Record<string, number[]> = {};
			for (const [part, joint] of joints) {
				transforms[part] = componentsOf((joint as unknown as { Transform: CFrame }).Transform);
			}
			samples.push({ time: track.TimePosition, transforms });
		}
		return { length: track.Length, samples };
	});

	if (track) {
		const playing = track;
		pcall(() => playing.Stop(0));
	}
	destroyQuietly(track);
	destroyQuietly(animation);
	destroyQuietly(sequence);
	if (!ok) return { error: `${tostring(result)}.` };
	return result as PlayedSamples;
}

// -- Models: NPCs and creatures -------------------------------------------------

const MODEL_LOADER_NAME = "RoqerModelAnimate";
/** The states a model's loader plays, by how fast the model moves. */
const MODEL_STATES = ["idle", "walk", "run"];
/** The fastest ground speed a gait may be wired with, in studs a second. */
const MAX_GROUND_SPEED = 200;
/**
 * The model loader's whole code. It never changes; the animations are its
 * attributes. It is a server Script inside the model, so every copy of the
 * model carries it and what it plays reaches every client.
 */
const MODEL_LOADER_SOURCE = `-- Built by Roqer (RoqerModelAnimate 1). Plays this model's idle, walk and run
-- animations by how fast the model moves. They are this script's attributes:
-- idle, walk and run hold animation IDs, and walkSpeed and runSpeed the ground
-- speed in studs a second each was written for, so its feet keep pace. Roqer's
-- animation tool sets them; this code stays as it is.
local RunService = game:GetService("RunService")

local model = script.Parent
local humanoid = model:FindFirstChildOfClass("Humanoid")
local controller = humanoid or model:FindFirstChildOfClass("AnimationController")
if not controller then
	warn(script:GetFullName() .. ": " .. model.Name .. " has no Humanoid or AnimationController to animate")
	return
end
local animator = controller:FindFirstChildOfClass("Animator")
if not animator then
	animator = Instance.new("Animator")
	animator.Parent = controller
end

local PRIORITY = {
	idle = Enum.AnimationPriority.Idle,
	walk = Enum.AnimationPriority.Movement,
	run = Enum.AnimationPriority.Movement,
}
-- Seconds to cross-fade from one state to the next.
local FADE = 0.2
-- Studs a second below which the model stands.
local STANDING = 0.5
-- How far a gait may be slowed down or sped up to keep pace with the model.
local SLOWEST, FASTEST = 0.5, 2

local tracks = {}
local current = nil

local function load(state)
	local old = tracks[state]
	if old then
		old:Stop(0)
		old:Destroy()
		tracks[state] = nil
	end
	if current == state then
		current = nil
	end
	local id = script:GetAttribute(state)
	if typeof(id) ~= "string" or id == "" then
		return
	end
	local animation = Instance.new("Animation")
	animation.AnimationId = id
	local ok, track = pcall(animator.LoadAnimation, animator, animation)
	if not ok then
		warn(script:GetFullName() .. ": the " .. state .. " animation " .. id .. " did not load: " .. tostring(track))
		return
	end
	track.Priority = PRIORITY[state]
	track.Looped = true
	tracks[state] = track
end

for state in PRIORITY do
	load(state)
end
script.AttributeChanged:Connect(function(name)
	if PRIORITY[name] then
		load(name)
	end
end)

local function choose(speed)
	if speed < STANDING then
		return "idle"
	end
	local walkSpeed, runSpeed = script:GetAttribute("walkSpeed"), script:GetAttribute("runSpeed")
	if tracks.walk and tracks.run and typeof(walkSpeed) == "number" and typeof(runSpeed) == "number" then
		return if speed > (walkSpeed + runSpeed) / 2 then "run" else "walk"
	end
	return if tracks.walk then "walk" elseif tracks.run then "run" else "idle"
end

-- A Humanoid reports its speed; anything else is timed from frame to frame.
local running = 0
if humanoid then
	humanoid.Running:Connect(function(speed)
		running = speed
	end)
end
local measured, last = 0, nil

RunService.Heartbeat:Connect(function(dt)
	local speed = running
	if not humanoid then
		local root = model.PrimaryPart
		local position = root and root.Position
		if position and last and dt > 0 then
			local moved = (position - last) * Vector3.new(1, 0, 1)
			measured += (moved.Magnitude / dt - measured) * math.min(1, dt * 5)
		end
		last = position
		speed = measured
	end
	local state = choose(speed)
	if state ~= current then
		local previous = current and tracks[current]
		if previous then
			previous:Stop(FADE)
		end
		if tracks[state] then
			tracks[state]:Play(FADE)
		end
		current = state
	end
	local track = tracks[state]
	local written = script:GetAttribute(state .. "Speed")
	if track and state ~= "idle" and typeof(written) == "number" and written > 0 then
		track:AdjustSpeed(math.clamp(speed / written, SLOWEST, FASTEST))
	end
end)
`;

type AnimatedModel = { model: Model; controller: Humanoid | AnimationController };
type Refusal = { error: string; errorCode: string };

/**
 * The model the path names, when a loader can animate it: a Model with a
 * Humanoid or an AnimationController, and not a player's character, whose own
 * Animate script the slots are for.
 */
function animatedModel(path: unknown): AnimatedModel | Refusal {
	if (!typeIs(path, "string") || path === "") return { error: "model is required.", errorCode: "invalid_arguments" };
	const target = resolveInstance(path, undefined);
	if (!target) return { error: `${path} does not exist.`, errorCode: "model_not_found" };
	if (!target.IsA("Model")) return { error: `${path} is a ${target.ClassName}, not a Model.`, errorCode: "target_not_model" };
	if (target.IsDescendantOf(game.GetService("StarterPlayer"))) {
		return { error: `${path} is a player's character; wire its Animate slots with slot and no model.`, errorCode: "player_character" };
	}
	const controller = target.FindFirstChildOfClass("Humanoid") ?? target.FindFirstChildOfClass("AnimationController");
	if (!controller) {
		return { error: `${path} has no Humanoid or AnimationController to animate; rig it first.`, errorCode: "model_not_rigged" };
	}
	return { model: target, controller };
}

/** The model's loader, if it has one, when it is the one loader this tool installs and its code is unchanged. */
function modelLoader(model: Model): { loader?: Script } | Refusal {
	const named = model.GetChildren().filter((child) => child.Name === MODEL_LOADER_NAME);
	if (named.size() > 1) {
		return { error: `${getInstancePath(model)} holds ${named.size()} children named ${MODEL_LOADER_NAME}; keep one.`, errorCode: "ambiguous_target" };
	}
	const existing = named[0];
	if (existing && (!existing.IsA("Script") || readScriptSource(existing) !== MODEL_LOADER_SOURCE)) {
		return { error: `${getInstancePath(existing)} is not the loader this tool installs, or its code was changed; it is left alone.`, errorCode: "loader_modified" };
	}
	return { loader: existing as Script | undefined };
}

/**
 * Set one state of a model's loader to a published animation, installing the
 * loader in the model when it has none. As with the character loader, a state
 * is replaced only when the caller names the ID it holds now, and the gait's
 * ground speed, which paces it, is replaced along with its ID.
 */
function animationWireModel(requestData: Data) {
	const state = requestData.state;
	const animationId = requestData.animationId;
	const expectedId = requestData.expectedId;
	const groundSpeed = requestData.groundSpeed;
	if (!typeIs(state, "string") || !MODEL_STATES.includes(state)) return { error: `state must be one of ${MODEL_STATES.join(", ")}.` };
	if (!typeIs(animationId, "string") || animationId.match("^rbxassetid://%d+$")[0] === undefined) {
		return { error: "animationId must be rbxassetid://<digits>." };
	}
	if (expectedId !== undefined && !typeIs(expectedId, "string")) return { error: "expectedId must be a string." };
	if (groundSpeed !== undefined && (state === "idle" || !typeIs(groundSpeed, "number") || !(groundSpeed > 0 && groundSpeed <= MAX_GROUND_SPEED))) {
		return { error: `groundSpeed is for walk and run, above 0 and at most ${MAX_GROUND_SPEED} studs a second.` };
	}

	const found = animatedModel(requestData.model);
	if ("error" in found) return { ...found, error: `${found.error} Nothing was wired.` };
	const model = found.model;
	const loaded = modelLoader(model);
	if ("error" in loaded) return { ...loaded, error: `${loaded.error} Nothing was wired.` };
	const existing = loaded.loader;

	const current = existing?.GetAttribute(state);
	const currentId = typeIs(current, "string") ? current : undefined;
	if (currentId !== undefined && expectedId === undefined) {
		return { error: `${model.Name}'s ${state} already holds ${currentId}; pass it as expected_id to replace it. Nothing was wired.`, errorCode: "expected_id_required", currentId };
	}
	if (currentId !== expectedId) {
		return {
			error: currentId === undefined
				? `${model.Name}'s ${state} holds nothing yet; omit expected_id. Nothing was wired.`
				: `${model.Name}'s ${state} holds ${currentId}, not ${expectedId}; someone changed it. Nothing was wired.`,
			errorCode: "animation_id_changed",
			currentId: currentId ?? false,
		};
	}

	const speedAttribute = `${state}Speed`;
	const paced = state !== "idle";
	const previousSpeed = existing?.GetAttribute(speedAttribute);
	const recordingId = beginRecording(`Wire ${model.Name} ${state} animation`);
	let loader = existing;
	const installed = loader === undefined;
	const [applied, applyError] = pcall(() => {
		if (!loader) {
			const created = new Instance("Script");
			created.Name = MODEL_LOADER_NAME;
			created.Source = MODEL_LOADER_SOURCE;
			created.SetAttribute(state, animationId);
			if (paced) created.SetAttribute(speedAttribute, groundSpeed as number | undefined);
			created.Parent = model;
			loader = created;
		} else {
			loader.SetAttribute(state, animationId);
			if (paced) loader.SetAttribute(speedAttribute, groundSpeed as number | undefined);
		}
	});
	if (!applied) {
		pcall(() => {
			if (installed && loader) {
				loader.Destroy();
			} else if (loader) {
				loader.SetAttribute(state, currentId);
				if (paced) loader.SetAttribute(speedAttribute, previousSpeed as number | undefined);
			}
		});
		finishRecording(recordingId, false);
		return { error: `Wiring failed: ${tostring(applyError)}. The previous state was restored.` };
	}
	finishRecording(recordingId, true);
	const wired = loader as unknown as Script;
	const readSpeed = wired.GetAttribute(speedAttribute);
	return {
		model: getInstancePath(model),
		controller: found.controller.ClassName,
		loader: getInstancePath(wired),
		installed,
		slot: state,
		animationId: wired.GetAttribute(state),
		previousId: currentId ?? false,
		...(paced ? { groundSpeed: typeIs(readSpeed, "number") ? readSpeed : false } : {}),
		readBackMatches: wired.GetAttribute(state) === animationId
			&& (!paced || readSpeed === groundSpeed)
			&& readScriptSource(wired) === MODEL_LOADER_SOURCE,
		undoable: recordingId !== undefined,
		...(installed ? { loaderSource: MODEL_LOADER_SOURCE } : {}),
	};
}

/** The longest a watch lasts, for a model something else moves. */
const WATCH_SECONDS = 20;
/** A watch ends sooner once it has seen the model move, and stand, each for this long without a break. */
const WATCH_STRETCH_SECONDS = 2;
/** Studs a second at or above which a model moves, and at or below which it stands, as verify's judge counts them. */
const MOVING_SPEED = 1;
const STANDING_SPEED = 0.2;
/** Seconds a walk to a position may take: Humanoid:MoveTo gives up after 8. */
const WALK_SECONDS = 9;
/** Samples taken a tenth of a second apart once a walk ends, while the model stands. */
const STANDING_SAMPLES = 15;

type LoaderStates = { unchanged: boolean; ids: Record<string, string>; speeds: Record<string, number> };

/** What the model's loader holds, to tell which of its states is playing. */
function loaderStates(model: Model): LoaderStates | undefined {
	const loader = model.FindFirstChild(MODEL_LOADER_NAME);
	if (!loader || !loader.IsA("Script")) return undefined;
	const ids: Record<string, string> = {};
	const speeds: Record<string, number> = {};
	for (const state of MODEL_STATES) {
		const id = loader.GetAttribute(state);
		if (typeIs(id, "string")) ids[state] = id;
		const speed = loader.GetAttribute(`${state}Speed`);
		if (typeIs(speed, "number")) speeds[state] = speed;
	}
	return { unchanged: readScriptSource(loader) === MODEL_LOADER_SOURCE, ids, speeds };
}

function horizontal(vector: Vector3): number {
	return new Vector3(vector.X, 0, vector.Z).Magnitude;
}

function round2(value: number): number {
	return math.round(value * 100) / 100;
}

type MovementSample = { t: number; phase: string; speed: number; playing: string | false; pace?: number };

/**
 * Sample, a tenth of a second apart, how fast the model moves, which of the
 * loader's tracks carries the most weight, and at what pace it plays: while
 * the model walks to the target and then stands, or, with no target, while
 * whatever moves it does, until it has been seen moving and standing.
 */
function observeModel(model: Model, humanoid: Humanoid | undefined, animator: Animator, ids: Set<string>, target: Vector3 | undefined) {
	const root = humanoid?.RootPart ?? model.PrimaryPart;
	if (!root) return { error: `${getInstancePath(model)} has no root part to follow; set its PrimaryPart.` };
	if (target && !humanoid) return { error: "position walks a model's Humanoid; move a model without one some other way, and verify it without position." };
	if (target && root.Anchored) return { error: `${getInstancePath(model)}'s root part is anchored, so it cannot walk.` };
	const samples: MovementSample[] = [];
	const started = os.clock();
	let last = root.Position;
	/** Takes one sample, and returns the speed it measured and the seconds since the last. */
	const sample = (phase: string): [number, number] => {
		const elapsed = task.wait(0.1);
		const position = root.Position;
		const speed = humanoid ? horizontal(root.AssemblyLinearVelocity) : horizontal(position.sub(last)) / math.max(elapsed, 0.001);
		last = position;
		let best: AnimationTrack | undefined;
		for (const track of animator.GetPlayingAnimationTracks()) {
			const id = track.Animation ? track.Animation.AnimationId : "";
			if (ids.has(id) && (!best || track.WeightCurrent > best.WeightCurrent)) best = track;
		}
		samples.push({
			t: round2(os.clock() - started),
			phase,
			speed: round2(speed),
			playing: best && best.Animation ? best.Animation.AnimationId : false,
			...(best ? { pace: round2(best.Speed) } : {}),
		});
		return [speed, elapsed];
	};
	if (!target) {
		// A patrol walks a leg and pauses at its end, so the watch lasts until
		// it has seen a stretch of each, not a fixed time a long leg outlasts.
		let moving = 0;
		let standing = 0;
		let sawMoving = false;
		let sawStanding = false;
		while (os.clock() - started < WATCH_SECONDS && !(sawMoving && sawStanding)) {
			const [speed, elapsed] = sample("watching");
			moving = speed >= MOVING_SPEED ? moving + elapsed : 0;
			standing = speed <= STANDING_SPEED ? standing + elapsed : 0;
			if (moving >= WATCH_STRETCH_SECONDS) sawMoving = true;
			if (standing >= WATCH_STRETCH_SECONDS) sawStanding = true;
		}
		return { mode: "watched", samples };
	}
	const walker = humanoid as Humanoid;
	let reached: boolean | undefined;
	const connection = walker.MoveToFinished.Connect((value) => {
		reached = value;
	});
	walker.MoveTo(target);
	while (reached === undefined && os.clock() - started < WALK_SECONDS) sample("moving");
	connection.Disconnect();
	for (let index = 0; index < STANDING_SAMPLES; index++) sample("standing");
	return { mode: "walked", reached: reached === true, samples };
}

/**
 * On the playtest's server, where a model's loader runs: play the checked
 * animation on the model and sample its joints, and watch which of the
 * loader's states plays as the model moves and stands, walking it to a
 * target first when one is given.
 */
function animationVerifyModel(requestData: Data) {
	const found = animatedModel(requestData.model);
	if ("error" in found) return found;
	const { model, controller } = found;
	const humanoid = controller.IsA("Humanoid") ? controller : undefined;
	// A model's loader makes its Animator when it has none; give it a moment.
	let animator = controller.FindFirstChildOfClass("Animator");
	const deadline = os.clock() + 3;
	while (!animator && os.clock() < deadline) {
		task.wait(0.1);
		animator = controller.FindFirstChildOfClass("Animator");
	}
	if (!animator) return { error: `${getInstancePath(model)} has no Animator in the playtest, and no loader made one.` };

	const loader = loaderStates(model);
	const result: Data = { ...(humanoid ? { rigType: humanoid.RigType.Name } : {}), loader: loader ?? false };
	if (requestData.animationId !== undefined || requestData.sequence !== undefined) {
		const played = playAndSample(model, animator, requestData, getInstancePath(model));
		if ("error" in played) return played;
		result.length = played.length;
		result.samples = played.samples;
	}
	const observe = requestData.observe;
	if (observe === "walk" || observe === "watch") {
		let target: Vector3 | undefined;
		if (observe === "walk") {
			const point = requestData.target;
			if (!typeIs(point, "table") || (point as unknown[]).size() !== 3) return { error: "target must be [x, y, z]." };
			const [x, y, z] = point as number[];
			for (const value of [x, y, z]) {
				if (!typeIs(value, "number") || value !== value || math.abs(value) === math.huge) return { error: "target must be three finite numbers." };
			}
			target = new Vector3(x, y, z);
		}
		const ids = new Set<string>();
		for (const state of MODEL_STATES) {
			const id = loader?.ids[state];
			if (id !== undefined) ids.add(id);
		}
		const observation = observeModel(model, humanoid, animator, ids, target);
		if ("error" in observation) return observation;
		result.observation = observation;
	}
	return result;
}

// -- Stock NPC bodies -----------------------------------------------------------

/** The rig types rig makes a stock NPC body of. */
const STOCK_RIGS = ["R15", "R6"];
/** Frames a new body gets to settle in the place; it has once two frames running move it less than this. */
const SETTLE_FRAMES = 10;
const SETTLED_STUDS = 0.001;
/** How far from where they were asked the read-back may find the feet. */
const FEET_TOLERANCE = 0.05;

/** A model's lowest point, under the middle of its bounding box. */
function footing(model: Model): Vector3 {
	const [box, size] = model.GetBoundingBox();
	return box.Position.sub(new Vector3(0, size.Y / 2, 0));
}

/** An asset ID as the model loader holds it, from either form an Animate script's Animation carries. */
function loaderAssetId(value: string): string | undefined {
	const [plain] = value.match("^rbxassetid://(%d+)$");
	if (typeIs(plain, "string")) return `rbxassetid://${plain}`;
	const [linked] = value.match("^https?://www%.roblox%.com/[Aa]sset/%?[Ii][Dd]=(%d+)$");
	return typeIs(linked, "string") ? `rbxassetid://${linked}` : undefined;
}

/**
 * The animation a stock body's Animate script plays for a state: of the
 * Animations in the state's slot, the one with the most weight, which is the
 * one Animate mostly plays.
 */
function stockAnimation(animate: Instance, state: string): string | undefined {
	const slot = animate.FindFirstChild(state);
	if (!slot) return undefined;
	let best: string | undefined;
	let bestWeight = -math.huge;
	for (const child of slot.GetChildren()) {
		if (!child.IsA("Animation")) continue;
		const id = loaderAssetId(child.AnimationId);
		const weight = child.FindFirstChild("Weight");
		const value = weight && weight.IsA("NumberValue") ? weight.Value : 1;
		if (id !== undefined && value > bestWeight) {
			best = id;
			bestWeight = value;
		}
	}
	return best;
}

/**
 * Make a stock R15 or R6 NPC body at a path that names nothing yet: Roblox's
 * default body, with its feet at a position, animated by the model loader
 * holding the idle, walk and run the body's own Animate script carries.
 * Animate is left out: it is a LocalScript, which runs only under a player,
 * so on an NPC it plays nothing. The body is made outside the place, so a
 * failure leaves nothing behind, and goes in as one undo step, read back:
 * each way the read-back differs from what was made is named.
 */
function animationRig(requestData: Data) {
	const path = requestData.model;
	const stock = requestData.stock;
	if (!typeIs(path, "string") || path === "") return { error: "model is required.", errorCode: "invalid_arguments" };
	if (!typeIs(stock, "string") || !STOCK_RIGS.includes(stock)) return { error: "stock must be R15 or R6.", errorCode: "invalid_arguments" };
	let feet = new Vector3(0, 0, 0);
	if (requestData.position !== undefined) {
		const point = requestData.position;
		if (!typeIs(point, "table") || (point as unknown[]).size() !== 3) return { error: "position must be [x, y, z].", errorCode: "invalid_arguments" };
		const [x, y, z] = point as number[];
		for (const value of [x, y, z]) {
			if (!typeIs(value, "number") || value !== value || math.abs(value) === math.huge) {
				return { error: "position must be three finite numbers.", errorCode: "invalid_arguments" };
			}
		}
		feet = new Vector3(x, y, z);
	}

	const { parent, name } = resolveParentAndName(path);
	if (!parent || name === undefined) {
		return { error: `${path} names no place for a model: its parent does not exist. Nothing was made.`, errorCode: "parent_not_found" };
	}
	const starterPlayer = game.GetService("StarterPlayer");
	if (parent === starterPlayer || parent.IsDescendantOf(starterPlayer)) {
		return { error: `${path} is under StarterPlayer, where a model is a player's character; rig makes an NPC. Nothing was made.`, errorCode: "player_character" };
	}
	if (parent.FindFirstChild(name)) {
		return { error: `${path} already exists; rig makes a new NPC at a path that names nothing. Nothing was made.`, errorCode: "target_exists" };
	}

	const rigType = stock === "R6" ? Enum.HumanoidRigType.R6 : Enum.HumanoidRigType.R15;
	const [made, bodyOrError] = pcall(() => Players.CreateHumanoidModelFromDescription(new Instance("HumanoidDescription"), rigType));
	if (!made) return { error: `Studio could not make the body: ${tostring(bodyOrError)}. Nothing was made.` };
	const body = bodyOrError as Model;
	const animate = body.FindFirstChild("Animate");
	const ids: Record<string, string> = {};
	const missing: string[] = [];
	for (const state of MODEL_STATES) {
		const id = animate ? stockAnimation(animate, state) : undefined;
		if (id !== undefined) ids[state] = id;
		else missing.push(state);
	}

	const recordingId = beginRecording(`Make NPC ${name}`);
	let loader: Script | undefined;
	const [applied, applyError] = pcall(() => {
		body.Name = name;
		if (animate) animate.Destroy();
		const created = new Instance("Script");
		created.Name = MODEL_LOADER_NAME;
		created.Source = MODEL_LOADER_SOURCE;
		for (const [state, id] of pairs(ids)) created.SetAttribute(state, id);
		created.Parent = body;
		loader = created;
		// An NPC walks: its root is never anchored.
		const root = body.FindFirstChild("HumanoidRootPart");
		if (root && root.IsA("BasePart")) root.Anchored = false;
		body.PivotTo(body.GetPivot().add(feet.sub(footing(body))));
		body.Parent = parent;
		// A stock body settles as it enters the place, its joints fitting its
		// limbs to its root, which moves its feet; so it is stood again once
		// it has stopped moving.
		let settled = footing(body);
		let still = 0;
		for (let frame = 0; frame < SETTLE_FRAMES && still < 2; frame++) {
			task.wait();
			const now = footing(body);
			still = now.sub(settled).Magnitude < SETTLED_STUDS ? still + 1 : 0;
			settled = now;
		}
		body.PivotTo(body.GetPivot().add(feet.sub(settled)));
	});
	if (!applied) {
		pcall(() => body.Destroy());
		finishRecording(recordingId, false);
		return { error: `Making the NPC failed: ${tostring(applyError)}. Nothing was made.` };
	}
	finishRecording(recordingId, true);

	const humanoid = body.FindFirstChildOfClass("Humanoid");
	const states = loaderStates(body);
	let parts = 0;
	for (const descendant of body.GetDescendants()) {
		if (descendant.IsA("BasePart")) parts += 1;
	}
	const joints = animatedJoints(body).size();
	const [, size] = body.GetBoundingBox();
	const standing = footing(body);
	const feetAt = [round2(standing.X), round2(standing.Y), round2(standing.Z)];
	const mismatches: string[] = [];
	if (body.Parent !== parent) mismatches.push(`it is not in ${getInstancePath(parent)}`);
	if (!humanoid) mismatches.push("it has no Humanoid");
	else if (humanoid.RigType !== rigType) mismatches.push(`its Humanoid is ${humanoid.RigType.Name}, not ${stock}`);
	if (joints === 0) mismatches.push("it has no Motor6D or AnimationConstraint joints to animate");
	if (!states) mismatches.push("it has no loader");
	else {
		if (!states.unchanged) mismatches.push("its loader's code is not the loader's");
		for (const state of MODEL_STATES) {
			if (states.ids[state] !== ids[state]) mismatches.push(`its loader's ${state} is not the one Animate carried`);
		}
	}
	if (body.FindFirstChild("Animate")) mismatches.push("its Animate script is still in it");
	const off = standing.sub(feet).Magnitude;
	if (off > FEET_TOLERANCE) mismatches.push(`its feet stand at [${feetAt.join(", ")}], ${round2(off)} studs from where they were asked`);
	return {
		model: getInstancePath(body),
		rigType: humanoid ? humanoid.RigType.Name : false,
		parts,
		joints,
		height: round2(size.Y),
		feet: feetAt,
		walkSpeed: humanoid ? humanoid.WalkSpeed : false,
		loader: getInstancePath(loader as unknown as Script),
		states: states ? states.ids : {},
		...(missing.size() > 0 ? { missingStates: missing } : {}),
		animateRemoved: animate !== undefined,
		readBackMatches: mismatches.size() === 0,
		...(mismatches.size() > 0 ? { mismatches } : {}),
		undoable: recordingId !== undefined,
		loaderSource: MODEL_LOADER_SOURCE,
	};
}

/** Roblox's classic head, which ships with Studio; the stock rig's own dynamic head cannot be read. */
const CLASSIC_HEAD = "rbxasset://avatar/heads/head.mesh";
const MAX_RIG_FACES = 4000;

function round4(value: number): number {
	return math.round(value * 10000) / 10000;
}

/**
 * The stock R15 dummy's real meshes, for the animation preview: each body
 * part's mesh, and the classic head, as triangles in the part's own frame,
 * scaled to the part's size. Nothing is left in the place: the dummy is never
 * parented, and each mesh is destroyed once read.
 */
function animationRigMeshes() {
	const assets = game.GetService("AssetService");
	const rig = Players.CreateHumanoidModelFromDescription(new Instance("HumanoidDescription"), Enum.HumanoidRigType.R15);
	const parts: Record<string, { positions: number[]; normals: number[] }> = {};
	const [ok, err] = pcall(() => {
		for (const child of rig.GetChildren()) {
			if (!child.IsA("MeshPart")) continue;
			const head = child.Name === "Head";
			const mesh = assets.CreateEditableMeshAsync(Content.fromUri(head ? CLASSIC_HEAD : child.MeshId));
			const faces = mesh.GetFaces() as number[];
			if (faces.size() > MAX_RIG_FACES) {
				mesh.Destroy();
				error(`${child.Name}'s mesh has ${faces.size()} faces`);
			}
			// The body meshes span their MeshSize; the classic head spans its own
			// bounds. Either is stretched onto the part's size, about its centre.
			let min = new Vector3(math.huge, math.huge, math.huge);
			let max = new Vector3(-math.huge, -math.huge, -math.huge);
			for (const vertex of mesh.GetVertices() as number[]) {
				const position = mesh.GetPosition(vertex);
				min = min.Min(position);
				max = max.Max(position);
			}
			const extent = head ? max.sub(min) : child.MeshSize;
			const centre = head ? min.add(max).div(2) : Vector3.zero;
			const scale = new Vector3(child.Size.X / extent.X, child.Size.Y / extent.Y, child.Size.Z / extent.Z);
			const positions: number[] = [];
			const normals: number[] = [];
			for (const face of faces) {
				const corners = mesh.GetFaceVertices(face) as number[];
				const faceNormals = mesh.GetFaceNormals(face) as number[];
				if (corners.size() !== 3 || faceNormals.size() !== 3) continue;
				for (let corner = 0; corner < 3; corner++) {
					const position = mesh.GetPosition(corners[corner]).sub(centre).mul(scale);
					const normal = mesh.GetNormal(faceNormals[corner]) ?? Vector3.yAxis;
					positions.push(round4(position.X), round4(position.Y), round4(position.Z));
					normals.push(round4(normal.X), round4(normal.Y), round4(normal.Z));
				}
			}
			mesh.Destroy();
			parts[child.Name] = { positions, normals };
		}
	});
	rig.Destroy();
	if (!ok) return { error: `The stock rig's meshes could not be read: ${tostring(err)}` };
	return { parts, head: "classic" };
}

// -- Rigs read from models ------------------------------------------------------

/** The RoqerRig attribute: what a model's geometry cannot say about its rig. */
const RIG_ATTRIBUTE = "RoqerRig";
/** Roqer's bounds on a rig it reads, for summaries and previews; not the engine's. */
const MAX_RIG_JOINTS = 64;
const MAX_RIG_PARTS = 128;
const MAX_WELDED_PARTS = 256;
/** A part at least this transparent is not drawn, as a HumanoidRootPart is not. */
const HIDDEN_TRANSPARENCY = 0.95;

type RigJointReading = { name: string; part0: BasePart; part1: BasePart; c0: CFrame; c1: CFrame };
type WeldedReading = { name: string; to: string; offset: number[]; size: number[]; shape: string; mesh?: string };
type RigReading = {
	path: string;
	revision: string;
	rootPart: string;
	controller: "Humanoid" | "AnimationController";
	hipHeight?: number;
	parts: { name: string; size: number[]; shape: string; mesh?: string; hidden?: boolean }[];
	joints: { name: string; part0: string; part1: string; c0: number[]; c1: number[] }[];
	declarations?: string;
	welded?: WeldedReading[];
	weldedLeftOut?: number;
};

/** How the previews draw a part: Roblox's own shape, or its box for anything else. */
function partShape(part: BasePart): string {
	if (part.IsA("WedgePart")) return "Wedge";
	if (part.IsA("Part")) {
		if (part.Shape === Enum.PartType.Ball) return "Ball";
		if (part.Shape === Enum.PartType.Cylinder) return "Cylinder";
		if (part.Shape === Enum.PartType.Wedge) return "Wedge";
	}
	return "Block";
}

/** A MeshPart's mesh, which the previews draw it with once core has read it; a mesh is not read here. */
function meshOf(part: BasePart): { mesh?: string } {
	return part.IsA("MeshPart") && part.MeshId !== "" ? { mesh: part.MeshId } : {};
}

function sizeOf(part: BasePart): number[] {
	return [part.Size.X, part.Size.Y, part.Size.Z].map((value) => math.round(value * 1e6) / 1e6);
}

/**
 * The joints the Animator drives in a model: its Motor6Ds, and its
 * AnimationConstraints, whose frames are their attachments'. Only joints
 * between two of the model's own parts are the model's rig.
 */
function modelJoints(model: Model): RigJointReading[] {
	const joints: RigJointReading[] = [];
	for (const descendant of model.GetDescendants()) {
		if (descendant.IsA("Motor6D")) {
			const [part0, part1] = [descendant.Part0, descendant.Part1];
			if (!part0 || !part1 || !part0.IsDescendantOf(model) || !part1.IsDescendantOf(model)) continue;
			joints.push({ name: descendant.Name, part0, part1, c0: descendant.C0, c1: descendant.C1 });
		} else if (descendant.IsA("AnimationConstraint")) {
			const [a0, a1] = [descendant.Attachment0, descendant.Attachment1];
			const part0 = a0?.Parent;
			const part1 = a1?.Parent;
			if (!a0 || !a1 || !part0 || !part1 || !part0.IsA("BasePart") || !part1.IsA("BasePart")) continue;
			if (!part0.IsDescendantOf(model) || !part1.IsDescendantOf(model)) continue;
			joints.push({ name: descendant.Name, part0, part1, c0: a0.CFrame, c1: a1.CFrame });
		}
	}
	return joints;
}

/** The parts joints hang from that no joint moves: one, on a rig that is one tree. */
function jointRoots(joints: RigJointReading[]): BasePart[] {
	const moved = new Set<BasePart>();
	for (const joint of joints) moved.add(joint.part1);
	const roots: BasePart[] = [];
	for (const joint of joints) {
		if (!moved.has(joint.part0) && !roots.includes(joint.part0)) roots.push(joint.part0);
	}
	return roots;
}

/**
 * The part a model's joints hang from: a Humanoid's root part; under an
 * AnimationController, the one part joints hang from that none moves,
 * preferring the model's PrimaryPart.
 */
function rigRoot(model: Model, controller: Humanoid | AnimationController, joints: RigJointReading[]): BasePart | string {
	if (controller.IsA("Humanoid")) {
		return controller.RootPart ?? `${getInstancePath(model)}'s Humanoid has no root part; give it a HumanoidRootPart`;
	}
	const roots = jointRoots(joints);
	const primary = model.PrimaryPart;
	if (primary && roots.includes(primary)) return primary;
	if (roots.size() === 1) return roots[0];
	if (roots.size() === 0) return `${getInstancePath(model)}'s joints hang from no part that none of them moves`;
	const names = roots.map((root) => root.Name).join(", ");
	return `${getInstancePath(model)}'s joints hang from ${roots.size()} parts that nothing moves (${names}); set its PrimaryPart to the one the rig hangs from`;
}

/** The two parts a weld holds together, when it is one: a Weld, ManualWeld, Snap, Glue, WeldConstraint or RigidConstraint. */
function weldedPair(instance: Instance): [BasePart, BasePart] | undefined {
	let pair: [Instance | undefined, Instance | undefined] | undefined;
	if (instance.IsA("Weld") || instance.IsA("ManualWeld") || instance.IsA("Snap") || instance.IsA("Glue")) {
		pair = [instance.Part0, instance.Part1];
	} else if (instance.IsA("WeldConstraint")) {
		pair = [instance.Part0, instance.Part1];
	} else if (instance.IsA("RigidConstraint")) {
		pair = [instance.Attachment0?.Parent, instance.Attachment1?.Parent];
	}
	if (!pair) return undefined;
	const [a, b] = pair;
	return a && b && a.IsA("BasePart") && b.IsA("BasePart") ? [a, b] : undefined;
}

/**
 * The visible parts welded to the rig's parts, directly or through each other,
 * each by the rig part it moves with and where it sits on it; the largest
 * MAX_WELDED_PARTS of them.
 */
function weldedParts(model: Model, rigParts: Set<BasePart>): { welded: WeldedReading[]; leftOut: number } {
	const neighbours = new Map<BasePart, BasePart[]>();
	const link = (a: BasePart, b: BasePart) => {
		const list = neighbours.get(a) ?? [];
		list.push(b);
		neighbours.set(a, list);
	};
	for (const descendant of model.GetDescendants()) {
		const pair = weldedPair(descendant);
		if (!pair || !pair[0].IsDescendantOf(model) || !pair[1].IsDescendantOf(model)) continue;
		link(pair[0], pair[1]);
		link(pair[1], pair[0]);
	}
	const host = new Map<BasePart, BasePart>();
	const queue: BasePart[] = [];
	for (const part of rigParts) queue.push(part);
	for (let index = 0; index < queue.size(); index++) {
		const part = queue[index];
		const reached = rigParts.has(part) ? part : host.get(part)!;
		for (const neighbour of neighbours.get(part) ?? []) {
			if (rigParts.has(neighbour) || host.has(neighbour)) continue;
			host.set(neighbour, reached);
			queue.push(neighbour);
		}
	}
	const visible: BasePart[] = [];
	for (const [part] of host) {
		if (part.Transparency < HIDDEN_TRANSPARENCY) visible.push(part);
	}
	const volume = (part: BasePart) => part.Size.X * part.Size.Y * part.Size.Z;
	visible.sort((a, b) => (volume(a) === volume(b) ? getInstancePath(a) < getInstancePath(b) : volume(a) > volume(b)));
	const welded: WeldedReading[] = [];
	for (let index = 0; index < math.min(visible.size(), MAX_WELDED_PARTS); index++) {
		const part = visible[index];
		const to = host.get(part)!;
		welded.push({ name: part.Name, to: to.Name, offset: componentsOf(to.CFrame.ToObjectSpace(part.CFrame)), size: sizeOf(part), shape: partShape(part), ...meshOf(part) });
	}
	return { welded, leftOut: visible.size() - welded.size() };
}

function formatComponents(values: number[]): string {
	return values.map((value) => formatNumber(value)).join(",");
}

/**
 * A revision of the rig as read: everything the compiler, the checks and the
 * previews take from it. A build compares it with the one its checks used.
 */
function rigRevision(reading: Omit<RigReading, "revision">): string {
	const out: string[] = [`c:${reading.controller}:${reading.rootPart}:${formatNumber(reading.hipHeight ?? 0)}`];
	for (const part of reading.parts) out.push(`p:${part.name}:${formatComponents(part.size)}:${part.shape}:${tostring(part.hidden === true)}`);
	for (const joint of reading.joints) out.push(`j:${joint.name}:${joint.part0}:${joint.part1}:${formatComponents(joint.c0)}:${formatComponents(joint.c1)}`);
	for (const piece of reading.welded ?? []) out.push(`w:${piece.name}:${piece.to}:${formatComponents(piece.offset)}:${formatComponents(piece.size)}:${piece.shape}`);
	out.push(`d:${reading.declarations ?? ""}`);
	return `rr1:${sourceRevision(out.join("\n")).sub(5)}`;
}

/**
 * Read a model's rig as the Animator will drive it: its joints, the parts they
 * join with their sizes and shapes, what is welded to them, its controller and
 * root, and its RoqerRig declarations; bounded, and read-only.
 */
function readModelRig(target: AnimatedModel): RigReading | Refusal {
	const { model, controller } = target;
	const path = getInstancePath(model);
	const joints = modelJoints(model);
	if (joints.size() === 0) {
		return { error: `${path} has no Motor6D or AnimationConstraint joints between its parts to animate.`, errorCode: "model_not_rigged" };
	}
	if (joints.size() > MAX_RIG_JOINTS) {
		return { error: `${path} has ${joints.size()} joints; Roqer animates a rig of at most ${MAX_RIG_JOINTS}.`, errorCode: "rig_too_large" };
	}
	const root = rigRoot(model, controller, joints);
	if (typeIs(root, "string")) return { error: `${root}.`, errorCode: "rig_root" };
	const rigParts = new Set<BasePart>([root]);
	for (const joint of joints) {
		rigParts.add(joint.part0);
		rigParts.add(joint.part1);
	}
	if (rigParts.size() > MAX_RIG_PARTS) {
		return { error: `${path}'s joints join ${rigParts.size()} parts; Roqer animates a rig of at most ${MAX_RIG_PARTS}.`, errorCode: "rig_too_large" };
	}
	const declared = model.GetAttribute(RIG_ATTRIBUTE);
	if (declared !== undefined && !typeIs(declared, "string")) {
		return { error: `${path}'s ${RIG_ATTRIBUTE} attribute is a ${typeOf(declared)}; it must be the declarations' JSON text.`, errorCode: "invalid_declarations" };
	}
	const parts: RigReading["parts"] = [];
	for (const part of rigParts) {
		parts.push({ name: part.Name, size: sizeOf(part), shape: partShape(part), ...meshOf(part), ...(part.Transparency >= HIDDEN_TRANSPARENCY ? { hidden: true } : {}) });
	}
	parts.sort((a, b) => a.name < b.name);
	const { welded, leftOut } = weldedParts(model, rigParts);
	const reading: Omit<RigReading, "revision"> = {
		path,
		rootPart: root.Name,
		controller: controller.IsA("Humanoid") ? "Humanoid" : "AnimationController",
		...(controller.IsA("Humanoid") ? { hipHeight: math.round(controller.HipHeight * 1e6) / 1e6 } : {}),
		parts,
		joints: joints.map((joint) => ({
			name: joint.name,
			part0: joint.part0.Name,
			part1: joint.part1.Name,
			c0: componentsOf(joint.c0),
			c1: componentsOf(joint.c1),
		})),
		...(declared !== undefined ? { declarations: declared } : {}),
		...(welded.size() > 0 ? { welded } : {}),
		...(leftOut > 0 ? { weldedLeftOut: leftOut } : {}),
	};
	return { ...reading, revision: rigRevision(reading) };
}

/** Read the rig of the model at requestData.model: read-only, for check and build. */
function animationReadRig(requestData: Data) {
	const target = animatedModel(requestData.model);
	if ("error" in target) return target;
	return readModelRig(target);
}

/** Whether an instance, or anything in it, is what a copy of a rig needs: a part, a joint, a weld, an attachment or its controller. */
function holdsRig(instance: Instance): boolean {
	const needed = (candidate: Instance) =>
		candidate.IsA("BasePart") || candidate.IsA("JointInstance") || candidate.IsA("WeldConstraint") || candidate.IsA("Constraint")
		|| candidate.IsA("Attachment") || candidate.IsA("Humanoid") || candidate.IsA("AnimationController") || candidate.IsA("Animator");
	if (needed(instance)) return true;
	for (const descendant of instance.GetDescendants()) if (needed(descendant)) return true;
	return false;
}

/**
 * Why a copy of the model would not preview it faithfully, if it would not: a
 * copy leaves out what cannot be archived, and a joint or weld in the copy
 * that held it, or held a part outside the model, still holds the original's
 * part, which moving the copy would move.
 */
function copyRefusal(model: Model): string | undefined {
	const path = getInstancePath(model);
	if (!model.Archivable) return `${path} cannot be archived, so it cannot be copied to preview on`;
	for (const descendant of model.GetDescendants()) {
		if (!descendant.Archivable && holdsRig(descendant)) {
			return `${getInstancePath(descendant)} cannot be archived, so a copy of ${path} would leave it out; make it archivable to preview on the model`;
		}
		let held: (Instance | undefined)[] = [];
		if (descendant.IsA("JointInstance") || descendant.IsA("WeldConstraint") || descendant.IsA("NoCollisionConstraint")) {
			held = [descendant.Part0, descendant.Part1];
		} else if (descendant.IsA("Constraint")) {
			held = [descendant.Attachment0?.Parent, descendant.Attachment1?.Parent];
		}
		for (const part of held) {
			if (part && !part.IsDescendantOf(model)) {
				return `${getInstancePath(descendant)} holds ${getInstancePath(part)}, outside ${path}, which a copy's ${descendant.ClassName} would still hold`;
			}
		}
	}
	return undefined;
}

/** The most meshes one read hands over, and the most triangles in each: Roqer's bounds for previews. */
const MAX_MESHES_PER_READ = 8;
const MAX_MODEL_MESH_FACES = 3000;

/** One mesh's triangles in its own space, each corner with its normal, and its bounds; or why not. */
function readMesh(id: string): Data {
	const assets = game.GetService("AssetService");
	const mesh = assets.CreateEditableMeshAsync(Content.fromUri(id));
	const [ok, result] = pcall(() => {
		const faces = mesh.GetFaces() as number[];
		if (faces.size() > MAX_MODEL_MESH_FACES) {
			return { error: `it has ${faces.size()} triangles; a preview draws a mesh of at most ${MAX_MODEL_MESH_FACES}` };
		}
		let min = new Vector3(math.huge, math.huge, math.huge);
		let max = new Vector3(-math.huge, -math.huge, -math.huge);
		const positions: number[] = [];
		const normals: number[] = [];
		for (const face of faces) {
			const corners = mesh.GetFaceVertices(face) as number[];
			const faceNormals = mesh.GetFaceNormals(face) as number[];
			if (corners.size() !== 3 || faceNormals.size() !== 3) continue;
			for (let corner = 0; corner < 3; corner++) {
				const position = mesh.GetPosition(corners[corner]);
				const normal = mesh.GetNormal(faceNormals[corner]) ?? Vector3.yAxis;
				min = min.Min(position);
				max = max.Max(position);
				positions.push(round4(position.X), round4(position.Y), round4(position.Z));
				normals.push(round4(normal.X), round4(normal.Y), round4(normal.Z));
			}
		}
		if (positions.size() === 0) return { error: "it has no triangles" };
		return { positions, normals, min: [round4(min.X), round4(min.Y), round4(min.Z)], max: [round4(max.X), round4(max.Y), round4(max.Z)] };
	});
	mesh.Destroy();
	if (!ok) error(result, 0);
	return result as Data;
}

/**
 * Meshes of a model's MeshParts for the animation preview, by mesh ID: each as
 * triangles in the mesh's own space with its bounds, which core stretches onto
 * each part's size as Studio does. A mesh Studio will not hand over, or one
 * too large to draw, comes back as why. Read-only: nothing enters the place.
 */
function animationReadMeshes(requestData: Data) {
	const ids = requestData.meshes;
	if (!typeIs(ids, "table") || (ids as unknown[]).size() === 0 || (ids as unknown[]).size() > MAX_MESHES_PER_READ) {
		return { error: `meshes must list 1 to ${MAX_MESHES_PER_READ} mesh IDs.`, errorCode: "invalid_arguments" };
	}
	const meshes: Record<string, Data> = {};
	for (const id of ids as unknown[]) {
		if (!typeIs(id, "string") || id === "" || id.size() > 200) {
			return { error: "every mesh ID must be a string of 1 to 200 characters.", errorCode: "invalid_arguments" };
		}
		const [ok, result] = pcall(() => readMesh(id));
		meshes[id] = ok ? (result as Data) : { error: `Studio would not hand it over: ${tostring(result)}` };
	}
	return { meshes };
}

export = {
	previewAnimation,
	animationReadMeshes,
	animationReadRig,
	buildAnimation,
	animationRigMeshes,
	animationPublishInfo,
	animationReadBack,
	animationWire,
	animationVerify,
	animationWireModel,
	animationVerifyModel,
	animationRig,
};
