/** The lines where a file and its Studio copy differ, bounded per side, for a conflict a person can review. */
export function differingLines(fileText: string, studioText: string, limit = 40) {
  const file = fileText.split(/\r?\n/);
  const studio = studioText.split(/\r?\n/);
  let start = 0;
  while (start < file.length && start < studio.length && file[start] === studio[start]) start += 1;
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
    file: fileLines.slice(0, limit),
    studio: studioLines.slice(0, limit),
    truncated: fileLines.length > limit || studioLines.length > limit,
  };
}
