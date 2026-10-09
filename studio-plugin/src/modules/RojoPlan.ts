import Utils from "./Utils";
import { sourceRevision } from "./SourceRevision";

/**
 * What a plan (planOnly) needs about instances so the host can save a change
 * to a linked Rojo project instead of applying it: the revision of every
 * script under an instance, to compare against the files before they move or
 * go, and a new instance tree serialized as an .rbxm file.
 */

// SerializationService and EncodingService are not in @rbxts/types' services
// barrel; see SerializationHandlers for the same untyped lookups.
type SerializationServiceShape = {
	SerializeInstancesAsync(this: SerializationServiceShape, instances: Instance[]): buffer;
};
type EncodingServiceShape = {
	Base64Encode(this: EncodingServiceShape, input: buffer): buffer;
};

const MAX_PLANNED_SCRIPTS = 200;

/** Every script at or under `instance`, with the revision of what Studio holds now (including an unsaved edit). */
function scriptRevisions(instance: Instance): { scripts: Array<{ path: string; revision: string }>; omitted?: number } {
	const scripts: Array<{ path: string; revision: string }> = [];
	let omitted = 0;
	for (const item of [instance, ...instance.GetDescendants()]) {
		if (!item.IsA("LuaSourceContainer")) continue;
		if (scripts.size() >= MAX_PLANNED_SCRIPTS) {
			omitted += 1;
			continue;
		}
		scripts.push({ path: Utils.getInstancePath(item), revision: sourceRevision(Utils.readScriptSource(item)) });
	}
	return omitted > 0 ? { scripts, omitted } : { scripts };
}

/** One instance and its descendants as a base64 .rbxm, or why not; it may be detached, as a planned instance is. */
function serializeBase64(instance: Instance): { base64: string } | { error: string } {
	const [ok, result] = pcall(() => {
		const serialization = (game as unknown as { GetService(name: string): SerializationServiceShape }).GetService("SerializationService");
		const encoding = (game as unknown as { GetService(name: string): EncodingServiceShape }).GetService("EncodingService");
		return buffer.tostring(encoding.Base64Encode(serialization.SerializeInstancesAsync([instance])));
	});
	return ok ? { base64: result as string } : { error: tostring(result) };
}

export = {
	scriptRevisions,
	serializeBase64,
};
