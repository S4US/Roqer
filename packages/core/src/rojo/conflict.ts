const MAX_LINE_CHARS = 200;
/** A preview line short enough to read, with a trailing mark when it was cut. */
const capLine = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);

/** The lines where a file and its Studio copy differ, bounded per side, for a conflict a person can review. */
export function differingLines(fileText: string, studioText: string, limit = 40) {
  const file = fileText.split(/\r?\n/);
  const studio = studioText.split(/\r?\n/);
  let start = 0;
  while (start < file.length && start < studio.length && file[start] === studio[start]) start += 1;
  // Every line matched: whatever made the hashes differ (a line ending or an
  // encoding byte split() cannot see) is not a line this can point at, so
  // report the last real line rather than one past the end of either side (a
  // trailing newline's empty final element does not count as a line).
  if (start >= file.length && start >= studio.length) {
    const realLines = (lines: string[]) => lines.length - (lines.length > 0 && lines[lines.length - 1] === '' ? 1 : 0);
    start = Math.max(0, Math.min(realLines(file), realLines(studio)) - 1);
  }
  let fileEnd = file.length;
  let studioEnd = studio.length;
  while (fileEnd > start && studioEnd > start && file[fileEnd - 1] === studio[studioEnd - 1]) {
    fileEnd -= 1;
    studioEnd -= 1;
  }
  const fileLines = file.slice(start, fileEnd);
  const studioLines = studio.slice(start, studioEnd);
  return {
    firstLine: start + 1,
    file: fileLines.slice(0, limit).map(capLine),
    studio: studioLines.slice(0, limit).map(capLine),
    truncated: fileLines.length > limit || studioLines.length > limit,
  };
}
