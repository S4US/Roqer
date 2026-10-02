/**
 * Whether a script's new source compiles, said with the write that saved it.
 *
 * A typo in a written script used to surface only when a playtest ran it,
 * several calls later and as runtime output the agent had to connect back to
 * the write. `loadstring` compiles a chunk without running it, so the parse
 * error and its line can come back with the write itself.
 *
 * The write still lands. A line edit can leave a script mid-change on purpose,
 * one step of several, and refusing it would break that. Only the compile is
 * judged: types and unknown members are not.
 */

/** Names the chunk so its errors read `source:12: message`, whatever the first line holds. */
const CHUNK_NAME = "=source";
const CHUNK_ERROR = "^source:(%d+): (.*)$";

export interface ScriptSyntaxError {
	line?: number;
	message: string;
}

/**
 * Nothing when the source compiles; `syntaxError` when it does not; and
 * `syntaxCheck: "unavailable"` when this Studio cannot compile a chunk for the
 * plugin, so a write is never reported as checked when it was not.
 */
export interface SyntaxReport {
	syntaxError?: ScriptSyntaxError;
	syntaxCheck?: "unavailable";
}

export function checkSyntax(source: string): SyntaxReport {
	// Never falls back to requiring a ModuleScript, as execute_luau does when
	// loadstring is off: that runs the code, and a check must not.
	let compiled: (() => unknown) | undefined;
	let compileError: string | undefined;
	const [called] = pcall(() => {
		const [fn, err] = loadstring(source, CHUNK_NAME);
		compiled = fn;
		compileError = err;
	});
	if (!called) return { syntaxCheck: "unavailable" };
	if (compiled !== undefined) return {};
	const raw = tostring(compileError);
	const [unavailable] = string.find(raw, "not available", 1, true);
	if (unavailable !== undefined) return { syntaxCheck: "unavailable" };
	const [lineText, message] = string.match(raw, CHUNK_ERROR);
	const line = lineText === undefined ? undefined : tonumber(lineText);
	if (line === undefined || message === undefined) return { syntaxError: { message: raw } };
	return { syntaxError: { line, message: tostring(message) } };
}
