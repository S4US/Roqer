/**
 * Produces a stable, session-local revision token for exact script source.
 *
 * The source length is measured in Luau string bytes, and the hash consumes
 * those same bytes.  Keeping the length in the token makes distinct-length
 * values unambiguous even if both 32-bit hash components happen to match.
 */
export function sourceRevision(source: string): string {
	const byteLength = source.size();
	let hashA = 5381;
	let hashB = 0;

	// Independent byte-wise djb2 and sdbm recurrences. Both multiplications stay
	// below 2^53, so Luau evaluates every intermediate integer exactly.
	for (let index = 1; index <= byteLength; index++) {
		const byte = string.byte(source, index)[0];
		hashA = (hashA * 33 + byte) % 4294967296;
		hashB = (hashB * 65599 + byte) % 4294967296;
	}

	return `sr1:${tostring(byteLength)}:${string.format("%08x", hashA)}${string.format("%08x", hashB)}`;
}
