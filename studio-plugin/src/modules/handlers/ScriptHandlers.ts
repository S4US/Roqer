import Utils from "../Utils";
import Recording from "../Recording";
import { sourceRevision } from "../SourceRevision";

const { getInstancePath, getInstanceByPath, getInstanceReference, resolveInstance, readScriptSource, applyScriptSource, splitLines, joinLines } = Utils;
const { beginRecording, finishRecording } = Recording;

const SOURCE_TRUNCATE_CHAR_BUDGET = 25000;
const SOURCE_TRUNCATE_LINE_BUDGET = 400;
const SOURCE_TRUNCATE_TO_LINES = 300;

function getTopServiceName(instance: Instance): string {
	let topServiceInst: Instance = instance;
	while (topServiceInst.Parent && topServiceInst.Parent !== game) {
		topServiceInst = topServiceInst.Parent;
	}
	return topServiceInst.Name;
}

function sliceLines(lines: string[], startLine: number, endLine: number): string[] {
	const selectedLines: string[] = [];
	for (let i = startLine; i <= endLine; i++) {
		selectedLines.push(lines[i - 1] ?? "");
	}
	return selectedLines;
}

function numberLines(lines: string[], lineOffset: number): string {
	const numberedLines: string[] = [];
	for (let i = 0; i < lines.size(); i++) {
		numberedLines.push(`${i + lineOffset}: ${lines[i]}`);
	}
	return numberedLines.join("\n");
}

function getScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const startLine = requestData.startLine as number | undefined;
	const endLine = requestData.endLine as number | undefined;

	if (!instancePath) return { error: "Instance path is required" };

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const fullSource = readScriptSource(instance);
		const [lines, hasTrailingNewline] = splitLines(fullSource);
		const totalLineCount = lines.size();
		const explicitRange = startLine !== undefined || endLine !== undefined;
		const shouldTruncate = !explicitRange &&
			(fullSource.size() > SOURCE_TRUNCATE_CHAR_BUDGET || totalLineCount > SOURCE_TRUNCATE_LINE_BUDGET);
		const returnedStartLine = explicitRange ? math.max(1, startLine ?? 1) : 1;
		const returnedEndLine = shouldTruncate
			? math.min(SOURCE_TRUNCATE_TO_LINES, totalLineCount)
			: explicitRange ? math.min(totalLineCount, endLine ?? totalLineCount) : totalLineCount;
		const selectedLines = (explicitRange || shouldTruncate)
			? sliceLines(lines, returnedStartLine, returnedEndLine)
			: lines;
		const sourceToReturn = explicitRange
			? joinLines(selectedLines, hasTrailingNewline && returnedEndLine === totalLineCount)
			: shouldTruncate ? selectedLines.join("\n") : fullSource;

		const resp: Record<string, unknown> = {
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
			className: instance.ClassName,
			name: instance.Name,
			source: sourceToReturn,
			numberedSource: numberLines(selectedLines, returnedStartLine),
			sourceLength: fullSource.size(),
			lineCount: totalLineCount,
			startLine: returnedStartLine,
			endLine: returnedEndLine,
			isPartial: explicitRange,
			truncated: shouldTruncate,
			revision: sourceRevision(fullSource),
		};

		if (shouldTruncate) {
			resp.note = `Script truncated to first ${returnedEndLine} of ${totalLineCount} lines (${fullSource.size()} chars). Use line_range to read specific sections.`;
		}

		if (instance.IsA("BaseScript")) {
			resp.enabled = instance.Enabled;
		}

		resp.topService = getTopServiceName(instance);

		return resp;
	});

	if (success) {
		return result;
	} else {
		return { error: `Failed to get script source: ${result}` };
	}
}

function setScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const newSource = requestData.source;
	const expectedRevision = requestData.expectedRevision;

	if (!instancePath || !typeIs(newSource, "string") || !typeIs(expectedRevision, "string")) {
		return { error: "Instance path, source, and expectedRevision are required; call get_script_source before replacing source" };
	}

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	// Communication has already JSON-decoded the transport payload; source text is exact at this boundary.
	const sourceToSet = newSource;
	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) {
		return { error: `Failed to read script source before updating: ${readResult}` };
	}
	const observedSource = readResult as string;
	const observedRevision = sourceRevision(observedSource);
	if (observedRevision !== expectedRevision) {
		return {
			error: "Source revision conflict; the script changed after it was read. Read it again and retry.",
			errorCode: "source_revision_conflict",
			expectedRevision,
			actualRevision: observedRevision,
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
		};
	}

	const recordingId = beginRecording(`Set script source: ${instance.Name}`);
	const oldSourceLength = observedSource.size();
	const applyResult = applyScriptSource(instance, sourceToSet, observedSource);

	if (applyResult.success) {
		finishRecording(recordingId, true);
		return {
			success: true,
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
			oldSourceLength, newSourceLength: sourceToSet.size(),
			previousRevision: observedRevision,
			revision: sourceRevision(sourceToSet),
			method: applyResult.method,
			message: `Script source updated successfully (${applyResult.method === "UpdateSourceAsync" ? "editor-safe" : "direct assignment"})`,
		};
	}

	finishRecording(recordingId, false);
	return {
		error: `Failed to set script source: ${applyResult.error}`,
	};
}

/** Byte offset of the first character of `line`, or undefined past the end. */
function offsetAtLine(source: string, line: number): number | undefined {
	if (line < 1) return undefined;
	let offset = 1;
	let currentLine = 1;
	while (currentLine < line) {
		const [nlPos] = string.find(source, "\n", offset, true);
		if (nlPos === undefined) return undefined;
		offset = (nlPos as number) + 1;
		currentLine++;
	}
	return offset;
}

/**
 * Where an edit's `old_string` sits in the source.
 *
 * `startLine` is a hint rather than a coordinate: it drifts by a line whenever
 * the range the caller read and the range it edited disagree. So a single
 * occurrence is trusted with or without an anchor, and the anchor chooses
 * between real occurrences instead of demanding one at an exact offset. Only a
 * genuinely ambiguous edit gives up. Roqer picks the occurrence it previews the
 * same way, so what a user approves in the diff is what gets applied here.
 */
function findMatchStart(source: string, oldString: string, startLine: number | undefined): number {
	const searchLen = oldString.size();
	if (searchLen === 0) error("old_string must not be empty.");

	const anchor = startLine === undefined ? undefined : offsetAtLine(source, startLine);

	// Scanned rather than collected so a short old_string in a long script does
	// not build a table of every occurrence just to pick one of them.
	let count = 0;
	let best: number | undefined;
	let bestDistance = 0;
	let searchPos = 1;
	while (true) {
		const [foundStart] = string.find(source, oldString, searchPos, true);
		if (foundStart === undefined) break;
		const at = foundStart as number;
		count++;
		if (anchor === undefined) {
			if (best === undefined) best = at;
		} else {
			const distance = math.abs(at - anchor);
			if (best === undefined || distance < bestDistance) {
				best = at;
				bestDistance = distance;
			}
		}
		searchPos = at + searchLen;
	}

	if (count === 0) {
		error("old_string not found in script. Read it with get_script_source and copy the exact text, including indentation.");
	}
	if (count === 1) return best as number;
	if (startLine === undefined) {
		error(`old_string matches ${count} locations. Provide more surrounding context, or pass line_range to anchor the edit to a specific line.`);
	}
	if (anchor === undefined) {
		error(`old_string matches ${count} locations and line_range ${startLine} is past the end of the script. Provide more surrounding context.`);
	}
	return best as number;
}

function editScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const oldString = requestData.old_string as string;
	const newString = requestData.new_string as string;
	const startLine = requestData.startLine as number | undefined;

	if (!instancePath || oldString === undefined || newString === undefined) {
		return { error: "Instance path, old_string, and new_string are required" };
	}

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Edit script: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
		const searchLen = oldString.size();
		const matchStart = findMatchStart(source, oldString, startLine);

		// Byte-slice replacement avoids Lua pattern escaping (safe for multi-byte chars like em dashes).
		const newSource = string.sub(source, 1, matchStart - 1) + newString + string.sub(source, matchStart + searchLen);

		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true,
			instancePath,
			method: applyResult.method,
			previousRevision: sourceRevision(source),
			revision: sourceRevision(newSource),
			message: "Script edited successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to edit script: ${result}` };
}

const MAX_BATCH_EDITS = 20;

/**
 * Apply several exact edits to one script as a single transaction.
 *
 * Three independent edits used to mean three writes, three undo entries, three
 * revisions, and three read-backs on the host side. Worse, each one invalidated
 * the source the caller had read, so the second and third edits were resolved
 * against a script the caller could no longer describe.
 *
 * Every `old_string` here is located in the *same* source the caller read, all
 * matches are resolved before anything is written, overlapping edits are
 * refused outright, and one `applyScriptSource` produces one revision. Either
 * every edit lands or none does.
 */
function editScriptBatch(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const edits = requestData.edits as Array<Record<string, unknown>> | undefined;
	const expectedRevision = requestData.expectedRevision;

	if (!instancePath || edits === undefined || !typeIs(edits, "table")) {
		return { error: "Instance path and a non-empty edits array are required" };
	}
	if (!typeIs(expectedRevision, "string")) {
		return { error: "expectedRevision is required; call get_script_source before editing" };
	}
	if (edits.size() === 0) return { error: "edits must contain at least one edit" };
	if (edits.size() > MAX_BATCH_EDITS) {
		return { error: `edits may contain at most ${MAX_BATCH_EDITS} entries; ${edits.size()} were supplied` };
	}

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) return { error: `Failed to read script source before editing: ${readResult}` };
	const source = readResult as string;
	const observedRevision = sourceRevision(source);
	if (expectedRevision !== observedRevision) {
		return {
			error: "Source revision conflict; the script changed after it was read. Read it again and retry.",
			errorCode: "source_revision_conflict",
			expectedRevision,
			actualRevision: observedRevision,
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
		};
	}

	const recordingId = beginRecording(`Edit script (${edits.size()} edits): ${instance.Name}`);

	const [success, result] = pcall(() => {
		// Resolved against the one source every edit was written against, before
		// any of them is applied. An edit located after an earlier one had already
		// shifted the text is an edit the caller never asked for.
		const resolved: Array<{ start: number; finish: number; replacement: string; index: number }> = [];
		for (let index = 0; index < edits.size(); index++) {
			const edit = edits[index];
			const oldString = edit.old_string;
			const newString = edit.new_string;
			if (!typeIs(oldString, "string") || !typeIs(newString, "string")) {
				error(`Edit ${index + 1} needs string old_string and new_string.`);
			}
			const startLine = typeIs(edit.startLine, "number") ? (edit.startLine as number) : undefined;
			const [matchSuccess, matchResult] = pcall(() => findMatchStart(source, oldString as string, startLine));
			if (!matchSuccess) error(`Edit ${index + 1}: ${matchResult}`);
			const start = matchResult as number;
			resolved.push({
				start,
				finish: start + (oldString as string).size() - 1,
				replacement: newString as string,
				index,
			});
		}

		table.sort(resolved, (left, right) => left.start < right.start);
		for (let i = 1; i < resolved.size(); i++) {
			if (resolved[i].start <= resolved[i - 1].finish) {
				error(`Edits ${resolved[i - 1].index + 1} and ${resolved[i].index + 1} overlap in the script. Combine them into one edit.`);
			}
		}

		// Built forwards from the untouched source, so no offset ever shifts.
		const pieces: string[] = [];
		let cursor = 1;
		for (const edit of resolved) {
			pieces.push(string.sub(source, cursor, edit.start - 1));
			pieces.push(edit.replacement);
			cursor = edit.finish + 1;
		}
		pieces.push(string.sub(source, cursor));
		const newSource = pieces.join("");

		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true,
			instancePath: getInstancePath(instance),
			instanceRef: getInstanceReference(instance),
			editsApplied: resolved.size(),
			method: applyResult.method,
			previousRevision: observedRevision,
			revision: sourceRevision(newSource),
			message: `Applied ${resolved.size()} edits in one transaction`,
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to edit script: ${result}` };
}

/**
 * A line-addressed edit's optional compare-and-set. Line numbers mean
 * something only against the source they were read from, so when the caller
 * says which revision that was and the script has moved on since, the edit is
 * refused with the same conflict set_script_source reports, instead of landing
 * on whatever those lines now hold.
 */
function lineEditConflict(instance: LuaSourceContainer, expectedRevision: unknown): Record<string, unknown> | undefined {
	if (expectedRevision === undefined) return undefined;
	if (!typeIs(expectedRevision, "string")) return { error: "expectedRevision must be the revision get_script_source returned" };
	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) return { error: `Failed to read script source before editing: ${readResult}` };
	const observedRevision = sourceRevision(readResult as string);
	if (observedRevision === expectedRevision) return undefined;
	return {
		error: "Source revision conflict; the script changed after it was read. Read it again and retry.",
		errorCode: "source_revision_conflict",
		expectedRevision,
		actualRevision: observedRevision,
		instancePath: getInstancePath(instance),
		instanceRef: getInstanceReference(instance),
	};
}

function insertScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const afterLine = (requestData.afterLine as number) ?? 0;
	const newContent = requestData.newContent as string;

	if (!instancePath || !newContent) return { error: "Instance path and newContent are required" };

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}
	const conflict = lineEditConflict(instance, requestData.expectedRevision);
	if (conflict) return conflict;

	const recordingId = beginRecording(`Insert script lines after line ${afterLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
		const [lines, hadTrailingNewline] = splitLines(source);
		const totalLines = lines.size();

		if (afterLine < 0 || afterLine > totalLines) error(`afterLine out of range (0-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < afterLine; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = afterLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true, instancePath,
			insertedAfterLine: afterLine,
			linesInserted: newLines.size(),
			newLineCount: resultLines.size(),
			method: applyResult.method,
			previousRevision: sourceRevision(source),
			revision: sourceRevision(newSource),
			message: "Script lines inserted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to insert script lines: ${result}` };
}

function deleteScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const instanceRef = requestData.instanceRef as string | undefined;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;

	if (!instancePath || !startLine || !endLine) {
		return { error: "Instance path, startLine, and endLine are required" };
	}

	const instance = resolveInstance(instancePath, instanceRef);
	if (!instance) return { error: instanceRef ? `Instance reference is invalid or no longer live: ${instanceRef}` : `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}
	const conflict = lineEditConflict(instance, requestData.expectedRevision);
	if (conflict) return conflict;

	const recordingId = beginRecording(`Delete script lines ${startLine}-${endLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
		const [lines, hadTrailingNewline] = splitLines(source);
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const resultLines: string[] = [];
		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true, instancePath,
			deletedLines: { startLine, endLine },
			linesDeleted: endLine - startLine + 1,
			newLineCount: resultLines.size(),
			method: applyResult.method,
			previousRevision: sourceRevision(source),
			revision: sourceRevision(newSource),
			message: "Script lines deleted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to delete script lines: ${result}` };
}

function escapeLuaPattern(s: string): string {
	return s.gsub("([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1")[0];
}

function escapeLuaReplacement(s: string): string {
	return s.gsub("%%", "%%%%")[0];
}

function caseInsensitiveLiteralReplace(src: string, searchStr: string, repl: string): [string, number] {
	const lowerSrc = src.lower();
	const lowerSearch = searchStr.lower();
	const parts: string[] = [];
	let lastEnd = 1;
	const searchLen = lowerSearch.size();
	let pos = 1;
	let replCount = 0;

	while (true) {
		const [foundStart] = string.find(lowerSrc, lowerSearch, pos, true);
		if (foundStart === undefined) break;
		parts.push(string.sub(src, lastEnd, foundStart - 1));
		parts.push(repl);
		lastEnd = foundStart + searchLen;
		pos = foundStart + searchLen;
		replCount++;
	}
	parts.push(string.sub(src, lastEnd));
	return [parts.join(""), replCount];
}

function findAndReplaceInScripts(requestData: Record<string, unknown>) {
	const searchPattern = requestData.pattern as string;
	const replacement = requestData.replacement as string;

	if (!searchPattern) return { error: "pattern is required" };
	if (replacement === undefined) return { error: "replacement is required" };

	const caseSensitive = (requestData.caseSensitive as boolean) ?? false;
	const usePattern = (requestData.usePattern as boolean) ?? false;
	const searchPath = (requestData.path as string) ?? "";
	const classFilter = requestData.classFilter as string | undefined;
	const dryRun = (requestData.dryRun as boolean) ?? false;
	const maxReplacements = (requestData.maxReplacements as number) ?? 1000;

	if (!caseSensitive && usePattern) {
		return { error: "Case-insensitive Lua pattern replacement is not supported. Use caseSensitive: true with usePattern: true, or use literal matching." };
	}

	const startInstance = searchPath !== "" ? getInstanceByPath(searchPath) : game;
	if (!startInstance) return { error: `Path not found: ${searchPath}` };

	interface ScriptChange {
		instancePath: string;
		name: string;
		className: string;
		replacements: number;
		error?: string;
	}

	const changes: ScriptChange[] = [];
	let totalReplacements = 0;
	let scriptsSearched = 0;
	let hitLimit = false;

	const recordingId = dryRun ? undefined : beginRecording("Find and replace in scripts");

	function processInstance(instance: Instance) {
		if (hitLimit) return;

		const matchesClass = classFilter === undefined
			|| instance.ClassName.lower().find(classFilter.lower())[0] !== undefined;
		if (instance.IsA("LuaSourceContainer") && matchesClass) {
			scriptsSearched++;
			const source = readScriptSource(instance);

			let newSource: string;
			let replCount: number;

			if (usePattern) {
				const [result, count] = string.gsub(source, searchPattern, replacement);
				newSource = result;
				replCount = count;
			} else if (caseSensitive) {
				const escaped = escapeLuaPattern(searchPattern);
				const escapedRepl = escapeLuaReplacement(replacement);
				const [result, count] = string.gsub(source, escaped, escapedRepl);
				newSource = result;
				replCount = count;
			} else {
				[newSource, replCount] = caseInsensitiveLiteralReplace(source, searchPattern, replacement);
			}

			if (replCount > 0) {
				if (totalReplacements + replCount > maxReplacements) {
					hitLimit = true;
					return;
				}

				const applyResult = dryRun
					? undefined
					: applyScriptSource(instance, newSource, source);
				if (applyResult !== undefined && !applyResult.success) {
					changes.push({
						instancePath: getInstancePath(instance),
						name: instance.Name,
						className: instance.ClassName,
						replacements: 0,
						error: applyResult.error ?? "Script write failed verification",
					});
				} else {
					totalReplacements += replCount;
					changes.push({
						instancePath: getInstancePath(instance),
						name: instance.Name,
						className: instance.ClassName,
						replacements: replCount,
					});
				}
			}
		}

		for (const child of instance.GetChildren()) {
			if (hitLimit) return;
			processInstance(child);
		}
	}

	const [traversalSuccess, traversalResult] = pcall(() => processInstance(startInstance));

	const failedScripts = changes.filter((change) => change.error !== undefined).size();
	const scriptsModified = changes.size() - failedScripts;
	if (recordingId !== undefined) {
		finishRecording(recordingId, scriptsModified > 0);
	}

	return {
		success: traversalSuccess && failedScripts === 0,
		error: traversalSuccess ? undefined : `Script traversal failed: ${traversalResult}`,
		dryRun,
		pattern: searchPattern,
		replacement,
		totalReplacements,
		scriptsSearched,
		scriptsModified,
		scriptsFailed: failedScripts,
		changes,
		truncated: hitLimit,
	};
}

export = {
	getScriptSource,
	setScriptSource,
	editScriptLines,
	editScriptBatch,
	insertScriptLines,
	deleteScriptLines,
	findAndReplaceInScripts,
};
