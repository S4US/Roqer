import Utils from "../Utils";
import Recording from "../Recording";

const { getInstancePath, resolveInstance, getInstanceReference, convertPropertyValue, samePropertyValue } = Utils;
const { beginRecording, finishRecording } = Recording;

interface PropertyChange {
	property: string;
	previous: unknown;
	requested: unknown;
}

interface RollbackFailure {
	property: string;
	error: string;
}

function readProperty(instance: Record<string, unknown>, property: string): unknown {
	const [success, value] = pcall(() => instance[property]);
	if (!success) error(`Unable to read ${property}: ${value}`);
	return value;
}

function resolvePropertyValue(instance: Instance, property: string, value: unknown): unknown {
	if ((property === "Parent" || property === "PrimaryPart") && typeIs(value, "string")) {
		const referenced = resolveInstance(value as string, undefined);
		if (!referenced) error(`${property} reference not found: ${value}`);
		return referenced;
	}
	if (property === "Name") return tostring(value);

	const converted = convertPropertyValue(instance, property, value);
	return converted !== undefined ? converted : value;
}

function rollback(instance: Record<string, unknown>, applied: PropertyChange[]): RollbackFailure[] {
	const failures: RollbackFailure[] = [];
	for (let index = applied.size() - 1; index >= 0; index--) {
		const change = applied[index];
		const [success, result] = pcall(() => {
			if (samePropertyValue(instance[change.property], change.previous)) return;
			instance[change.property] = change.previous;
			if (!samePropertyValue(instance[change.property], change.previous)) {
				error(`restored value did not match the original value (actual=${tostring(instance[change.property])}, expected=${tostring(change.previous)})`);
			}
		});
		if (!success) failures.push({ property: change.property, error: tostring(result) });
	}
	return failures;
}

function setProperties(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string | undefined;
	const instanceRef = requestData.instanceRef as string | undefined;
	const properties = requestData.properties as Record<string, unknown>;

	if ((!instancePath && !instanceRef) || !properties || !typeIs(properties, "table")) {
		return { error: "Instance path or instance reference and properties object are required" };
	}

	const instance = resolveInstance(instancePath, instanceRef);
	const target = instancePath ?? instanceRef ?? "requested instance";
	if (!instance) {
		return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${target}` };
	}

	const propertyNames: string[] = [];
	let hasParent = false;
	for (const [property] of pairs(properties)) {
		if (property === "Parent") {
			hasParent = true;
		} else {
			propertyNames.push(property as string);
		}
	}
	// Parenting can make an instance inaccessible or trigger engine side effects,
	// so it is deliberately applied after all other assignments.
	propertyNames.sort();
	if (hasParent) propertyNames.push("Parent");

	if (propertyNames.includes("Source")) {
		return {
			error: "Source cannot be set through set_properties; use set_script_source instead",
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
		};
	}

	const inst = instance as unknown as Record<string, unknown>;
	const changes: PropertyChange[] = [];
	const results: Record<string, unknown>[] = [];

	// Convert and snapshot every value before opening a recording or changing state.
	for (const property of propertyNames) {
		const [success, result] = pcall(() => {
			const previous = readProperty(inst, property);
			const requested = resolvePropertyValue(instance, property, properties[property]);
			return { previous, requested };
		});
		if (!success) {
			return {
				error: `Atomic set_properties preflight failed for ${property}: ${result}`,
				instancePath: getInstancePath(instance),
				instanceRef: getInstanceReference(instance),
				summary: { total: propertyNames.size(), succeeded: 0, failed: propertyNames.size() },
				results: [{ property, success: false, error: tostring(result) }],
			};
		}
		const prepared = result as { previous: unknown; requested: unknown };
		changes.push({ property, previous: prepared.previous, requested: prepared.requested });
		results.push({ property, success: true });
	}

	const recordingId = beginRecording("Set multiple properties");
	const applied: PropertyChange[] = [];
	for (const change of changes) {
		const [success, result] = pcall(() => {
			// Include the currently attempted property so a setter that mutates before
			// failing is restored too.
			applied.push(change);
			inst[change.property] = change.requested;
			if (!samePropertyValue(inst[change.property], change.requested)) {
				error(`assigned value did not match the requested value (actual=${tostring(inst[change.property])}, requested=${tostring(change.requested)})`);
			}
		});
		if (!success) {
			const rollbackFailures = rollback(inst, applied);
			finishRecording(recordingId, false);
			const rollbackSummary = rollbackFailures.size() === 0
				? "All requested properties were rolled back."
				: "Rollback was incomplete.";
			const rollbackDetail = rollbackFailures.size() > 0
				? ` Rollback failures: ${rollbackFailures.map((failure) => `${failure.property}: ${failure.error}`).join("; ")}`
				: "";
			return {
				error: `Atomic set_properties failed for ${change.property}: ${result}. ${rollbackSummary}${rollbackDetail}`,
				instancePath: getInstancePath(instance),
				instanceRef: getInstanceReference(instance),
				summary: { total: changes.size(), succeeded: 0, failed: changes.size() },
				results: [{ property: change.property, success: false, error: tostring(result) }],
				rolledBack: rollbackFailures.size() === 0,
				rollbackFailures,
			};
		}
	}

	finishRecording(recordingId, true);

	return {
		instancePath: getInstancePath(instance),
		instanceRef: getInstanceReference(instance),
		summary: { total: changes.size(), succeeded: changes.size(), failed: 0 },
		results,
	};
}

export = {
	setProperties,
};
