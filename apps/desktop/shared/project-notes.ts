/** A project's memory and master plan, as the main process stores them and the window shows them. */

export type ProjectMemory = { id: string; text: string; createdAt: string };

export type ProjectNotes = {
  memories: ProjectMemory[];
  plan: string;
  /** When the plan was last written, or null when it never was. */
  planUpdatedAt: string | null;
};

export type ProjectNotesResult = { ok: true; notes: ProjectNotes } | { ok: false; message: string };

export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 1_000;
export const MAX_PLAN_CHARS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isProjectNotesResult(value: unknown): value is ProjectNotesResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.message === "string";
  if (value.ok !== true || !isRecord(value.notes)) return false;
  const notes = value.notes;
  return typeof notes.plan === "string" &&
    (notes.planUpdatedAt === null || typeof notes.planUpdatedAt === "string") &&
    Array.isArray(notes.memories) &&
    notes.memories.every((memory) => isRecord(memory) && typeof memory.id === "string" &&
      typeof memory.text === "string" && typeof memory.createdAt === "string");
}
