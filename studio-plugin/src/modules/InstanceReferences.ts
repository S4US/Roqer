/**
 * Session-local, opaque handles for Instances returned to an MCP client.
 *
 * The maps deliberately retain object identity rather than paths or DebugIds:
 * a handle continues to identify an Instance after it is renamed or moved, but
 * never grants access once that Instance leaves the current DataModel.
 */
const httpService = game.GetService("HttpService");
const sessionNamespace = httpService.GenerateGUID(false).gsub("-", "")[0].sub(1, 16);

let nextReferenceId = 0;
const referencesByInstance = new Map<Instance, string>();
const instancesByReference = new Map<string, Instance>();

function isLiveDataModelInstance(instance: Instance): boolean {
	const [ok, isDescendant] = pcall(() => instance === game || instance.IsDescendantOf(game));
	return ok && isDescendant === true;
}

function getInstanceReference(instance: Instance): string {
	if (!isLiveDataModelInstance(instance)) {
		error("Cannot create an instance reference for an Instance outside game.");
	}

	const existingReference = referencesByInstance.get(instance);
	if (existingReference !== undefined) return existingReference;

	nextReferenceId += 1;
	const instanceReference = `ir:${sessionNamespace}:${nextReferenceId}`;
	referencesByInstance.set(instance, instanceReference);
	instancesByReference.set(instanceReference, instance);
	return instanceReference;
}

function resolveInstanceReference(instanceRef: string): Instance | undefined {
	const instance = instancesByReference.get(instanceRef);
	if (instance === undefined) return undefined;

	if (isLiveDataModelInstance(instance)) return instance;

	// Discard invalid entries so a later reparent cannot revive an old handle.
	instancesByReference.delete(instanceRef);
	referencesByInstance.delete(instance);
	return undefined;
}

export = {
	getInstanceReference,
	resolveInstanceReference,
};
