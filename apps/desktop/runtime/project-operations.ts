import type { LocalOperation } from "./local-operations";
import type { McpToolImage, McpToolOutcome } from "./mcp-types";
import { MEMORY_TOOL_NAME, PLAN_TOOL_NAME, ProjectNotesError, runProjectNotesTool, type ProjectNotesStore } from "./project-notes";
import { PROJECT_FILES_TOOL_NAME, ProjectFilesError, runProjectFilesTool, type ProjectFilesToolContext } from "./project-files";

/**
 * The project's notes and shared files, as operations Roqer runs on this
 * machine for a run.
 *
 * They go through the run engine like a Studio call or a Blender job, which
 * is what makes each call a step in the run the user can see, and puts each
 * change under the run's approval mode: Read only refuses it, Ask first asks.
 * Reading them is a read (see `isProjectDataRead`).
 */
export function projectDataOperations(options: {
  notes?: { store: ProjectNotesStore; projectId: string };
  files?: ProjectFilesToolContext;
  /** Told after a call saved or changed a file, so the window can show it. */
  filesChanged?(): void;
}): Array<[string, LocalOperation]> {
  const operations: Array<[string, LocalOperation]> = [];
  const { notes, files } = options;
  if (notes !== undefined) {
    for (const tool of [MEMORY_TOOL_NAME, PLAN_TOOL_NAME]) {
      operations.push([tool, (args) => answer(async () => ({ text: await runProjectNotesTool(notes.store, notes.projectId, tool, args) }))]);
    }
  }
  if (files !== undefined) {
    operations.push([PROJECT_FILES_TOOL_NAME, (args) => answer(async () => {
      const result = await runProjectFilesTool(files, args);
      if (result.changed) options.filesChanged?.();
      return result;
    })]);
  }
  return operations;
}

/**
 * A call's outcome. A refusal the model can act on (a wrong id, a missing
 * passage) is answered with its reason; anything else with a plain failure,
 * since a run should not end because a note could not be saved.
 */
async function answer(work: () => Promise<{ text: string; images?: readonly McpToolImage[] }>): Promise<McpToolOutcome> {
  const started = Date.now();
  try {
    const { text, images } = await work();
    return {
      ok: true,
      data: undefined,
      text,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      httpStatus: 200,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof ProjectNotesError || error instanceof ProjectFilesError
      ? error.message
      : "Roqer could not read or save the project's data just now. Nothing was changed.";
    if (!(error instanceof ProjectNotesError || error instanceof ProjectFilesError)) console.error("Roqer project data operation failed", error);
    return { ok: false, data: undefined, text: message, message, httpStatus: 200, durationMs: Date.now() - started };
  }
}
