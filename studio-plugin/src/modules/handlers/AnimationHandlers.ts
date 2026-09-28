import Utils from "../Utils";
import Recording from "../Recording";
import { sourceRevision } from "../SourceRevision";

const { getInstancePath, resolveInstance, getInstanceReference } = Utils;
const { beginRecording, finishRecording } = Recording;

const Players = game.GetService("Players");
const Workspace = game.GetService("Workspace");

/**
 * Build and preview character animations from a compiled description.
 *
 * Core compiles and checks the pose description; the plugin only turns the
 * compiled keyframes into instances. `previewAnimation` plays them on a
 * temporary R15 dummy and reports the joints, without leaving anything behind.
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
	}
	return `kr1:${sourceRevision(out.join("\n")).sub(5)}`;
}

function countContent(sequence: KeyframeSequence) {
	let keyframes = 0;
	let poses = 0;
	for (const descendant of sequence.GetDescendants()) {
		if (descendant.IsA("Keyframe")) keyframes += 1;
		else if (descendant.IsA("Pose")) poses += 1;
	}
	return { keyframes, poses };
}

function componentsOf(cframe: CFrame): number[] {
	const out: number[] = [];
	for (const value of cframe.GetComponents()) out.push(math.round(value * 1e6) / 1e6);
	return out;
}

function destroyQuietly(instance: Instance | undefined) {
	if (instance) pcall(() => instance.Destroy());
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
		const rig = Players.CreateHumanoidModelFromDescription(new Instance("HumanoidDescription"), Enum.HumanoidRigType.R15);
		rig.Archivable = false;
		rig.PivotTo(new CFrame(0, 100000, 0));
		const root = rig.FindFirstChild("HumanoidRootPart");
		if (root && root.IsA("BasePart")) root.Anchored = true;
		rig.Parent = folder;

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
		undoable: recordingId !== undefined,
	};
}

export = {
	previewAnimation,
	buildAnimation,
};
