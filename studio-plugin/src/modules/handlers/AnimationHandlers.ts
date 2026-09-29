import Utils from "../Utils";
import Recording from "../Recording";
import { sourceRevision } from "../SourceRevision";

const { getInstancePath, resolveInstance, getInstanceReference, readScriptSource } = Utils;
const { beginRecording, finishRecording } = Recording;

const Players = game.GetService("Players");
const Workspace = game.GetService("Workspace");

/**
 * Build and preview character animations from a compiled description.
 *
 * Core compiles and checks the pose description; the plugin only turns the
 * compiled keyframes into instances. `previewAnimation` plays them on a
 * temporary R15 or R6 dummy, as the sequence's rig says, and reports the
 * joints, without leaving anything behind.
 * `buildAnimation` writes the KeyframeSequence as one undo step, replacing a
 * sequence only when it was built here, is unchanged since, and matches the
 * revision the caller expects.
 */

const REVISION_ATTRIBUTE = "RoqerAnimationRevision";
const PREVIEW_FOLDER = "__RoqerAnimationPreview";
const MAX_KEYFRAMES = 240;
const MAX_POSES_PER_KEYFRAME = 32;
const MAX_POSE_DEPTH = 8;
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

function destroyQuietly(instance: Instance | undefined) {
	if (instance) pcall(() => instance.Destroy());
}

const MAX_PROPS = 8;

/**
 * Give a preview dummy the props the animation moves, rigged as a game rigs
 * them: a part moved by a Motor6D from a body part, whose C0 is the named
 * attachment's CFrame, or the given one, and whose C1 is the identity.
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
		let c0: CFrame;
		if (prop.attachment !== undefined) {
			const attachment = body.FindFirstChild(checkName(prop.attachment, "a prop's attachment"));
			if (!attachment || !attachment.IsA("Attachment")) error(`the preview dummy's ${parentName} has no ${tostring(prop.attachment)}`);
			c0 = attachment.CFrame;
		} else {
			const c = prop.c0;
			if (!typeIs(c, "table") || (c as unknown[]).size() !== 12) error("a prop's c0 must be 12 numbers");
			const n = c as number[];
			for (const value of n) {
				if (!typeIs(value, "number") || value !== value || math.abs(value) === math.huge) error("a prop's c0 must be finite numbers");
			}
			c0 = new CFrame(n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8], n[9], n[10], n[11]);
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
		const rigType = (requestData.sequence as Data).rig === "R6" ? Enum.HumanoidRigType.R6 : Enum.HumanoidRigType.R15;
		const rig = Players.CreateHumanoidModelFromDescription(new Instance("HumanoidDescription"), rigType);
		rig.Archivable = false;
		rig.PivotTo(new CFrame(0, 100000, 0));
		const root = rig.FindFirstChild("HumanoidRootPart");
		if (root && root.IsA("BasePart")) root.Anchored = true;
		rig.Parent = folder;
		addProps(rig, requestData.props);

		const joints = new Map<string, Instance>();
		for (const descendant of rig.GetDescendants()) {
			if (descendant.IsA("AnimationConstraint")) {
				const attachment = descendant.Attachment1;
				if (attachment && attachment.Parent) joints.set(attachment.Parent.Name, descendant);
			} else if (descendant.IsA("Motor6D") && descendant.Part1) {
				joints.set(descendant.Part1.Name, descendant);
			}
		}
		const humanoid = rig.FindFirstChildOfClass("Humanoid");
		if (!humanoid) error("the preview dummy has no Humanoid");
		let animator = humanoid.FindFirstChildOfClass("Animator");
		if (!animator) {
			animator = new Instance("Animator");
			animator.Parent = humanoid;
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
		const joints = new Map<string, Instance>();
		for (const descendant of character!.GetDescendants()) {
			if (descendant.IsA("AnimationConstraint")) {
				const attachment = descendant.Attachment1;
				if (attachment && attachment.Parent) joints.set(attachment.Parent.Name, descendant);
			} else if (descendant.IsA("Motor6D") && descendant.Part1) {
				joints.set(descendant.Part1.Name, descendant);
			}
		}
		animation = new Instance("Animation");
		animation.AnimationId = id as string;
		track = animator.LoadAnimation(animation);
		track.Priority = Enum.AnimationPriority.Action4;
		track.Play(0);
		const loadDeadline = os.clock() + TRACK_LOAD_SECONDS;
		while (track.Length === 0 && os.clock() < loadDeadline) task.wait(0.05);
		if (track.Length === 0) error("the animation never loaded on the character");
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
	return { ...(result as object), rigType: humanoid.RigType.Name, ...(wiredIds ? { wiredIds, playingIds } : {}) };
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

export = {
	previewAnimation,
	buildAnimation,
	animationRigMeshes,
	animationPublishInfo,
	animationReadBack,
	animationWire,
	animationVerify,
};
