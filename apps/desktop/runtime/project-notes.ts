import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * What a project remembers between chats: short memories the agent or the
 * user saved, and the master plan for the whole experience.
 *
 * A chat's conversation is the agent's working memory and ends with the chat.
 * These outlive it. Every new provider process gets them in its system prompt,
 * and the agent reads and edits them with two tools, so the plan a planning
 * chat settles on is the one a building chat follows.
 *
 * One file per project, written whole through a temporary file and a rename,
 * so a crash mid-write leaves the previous version rather than half of one.
 */

import {
  MAX_MEMORIES, MAX_MEMORY_CHARS, MAX_PLAN_CHARS, type ProjectMemory, type ProjectNotes,
} from "../shared/project-notes";

export { MAX_MEMORIES, MAX_MEMORY_CHARS, MAX_PLAN_CHARS, type ProjectMemory, type ProjectNotes };

type JsonRecord = Record<string, unknown>;

export const MEMORY_TOOL_NAME = "project_memory";
export const PLAN_TOOL_NAME = "master_plan";

const EMPTY: ProjectNotes = { memories: [], plan: "", planUpdatedAt: null };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class ProjectNotesError extends Error {}

function parseStored(value: unknown): ProjectNotes {
  if (!isRecord(value)) return { ...EMPTY };
  const memories = Array.isArray(value.memories)
    ? value.memories.filter((entry): entry is ProjectMemory =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.text === "string" && typeof entry.createdAt === "string")
      .slice(0, MAX_MEMORIES)
    : [];
  return {
    memories,
    plan: typeof value.plan === "string" ? value.plan.slice(0, MAX_PLAN_CHARS) : "",
    planUpdatedAt: typeof value.planUpdatedAt === "string" ? value.planUpdatedAt : null,
  };
}

/** A short fingerprint of what the agent would be told, so a live session can tell it has gone stale. */
export function notesVersion(notes: ProjectNotes): string {
  return createHash("sha256").update(JSON.stringify([notes.memories.map((memory) => memory.text), notes.plan])).digest("hex").slice(0, 16);
}

/** A project id names a file, so only a plain id is accepted. */
function safeProjectId(projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new ProjectNotesError("That project id cannot hold notes.");
  return projectId;
}

export class ProjectNotesStore {
  private readonly cache = new Map<string, ProjectNotes>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private file(projectId: string): string {
    return path.join(this.directory, `${safeProjectId(projectId)}.json`);
  }

  private async read(projectId: string): Promise<ProjectNotes> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    let notes: ProjectNotes;
    try {
      notes = parseStored(JSON.parse(await fs.readFile(this.file(projectId), "utf8")) as unknown);
    } catch (error) {
      if (error instanceof ProjectNotesError) throw error;
      notes = { ...EMPTY };
    }
    this.cache.set(projectId, notes);
    return notes;
  }

  private async write(projectId: string, next: ProjectNotes): Promise<ProjectNotes> {
    const file = this.file(projectId);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new ProjectNotesError("The project notes could not be saved.");
    }
    this.cache.set(projectId, next);
    return next;
  }

  get(projectId: string): Promise<ProjectNotes> {
    return this.enqueue(() => this.read(projectId));
  }

  addMemory(projectId: string, text: string): Promise<ProjectNotes> {
    return this.enqueue(async () => {
      const trimmed = text.trim();
      if (trimmed === "") throw new ProjectNotesError("A memory needs some text.");
      if (trimmed.length > MAX_MEMORY_CHARS) throw new ProjectNotesError(`A memory is at most ${MAX_MEMORY_CHARS} characters. Save the gist.`);
      const current = await this.read(projectId);
      if (current.memories.length >= MAX_MEMORIES) {
        throw new ProjectNotesError(`This project already holds ${MAX_MEMORIES} memories. Remove ones that no longer hold first.`);
      }
      const memory: ProjectMemory = { id: `mem-${randomUUID().slice(0, 8)}`, text: trimmed, createdAt: new Date().toISOString() };
      return this.write(projectId, { ...current, memories: [...current.memories, memory] });
    });
  }

  updateMemory(projectId: string, id: string, text: string): Promise<ProjectNotes> {
    return this.enqueue(async () => {
      const trimmed = text.trim();
      if (trimmed === "") throw new ProjectNotesError("A memory needs some text.");
      if (trimmed.length > MAX_MEMORY_CHARS) throw new ProjectNotesError(`A memory is at most ${MAX_MEMORY_CHARS} characters.`);
      const current = await this.read(projectId);
      if (!current.memories.some((memory) => memory.id === id)) throw new ProjectNotesError(`No memory has the id ${id}.`);
      return this.write(projectId, {
        ...current,
        memories: current.memories.map((memory) => memory.id === id ? { ...memory, text: trimmed } : memory),
      });
    });
  }

  removeMemory(projectId: string, id: string): Promise<ProjectNotes> {
    return this.enqueue(async () => {
      const current = await this.read(projectId);
      if (!current.memories.some((memory) => memory.id === id)) throw new ProjectNotesError(`No memory has the id ${id}.`);
      return this.write(projectId, { ...current, memories: current.memories.filter((memory) => memory.id !== id) });
    });
  }

  setPlan(projectId: string, plan: string): Promise<ProjectNotes> {
    return this.enqueue(async () => {
      if (plan.length > MAX_PLAN_CHARS) throw new ProjectNotesError(`The master plan is at most ${MAX_PLAN_CHARS.toLocaleString("en-US")} characters.`);
      const current = await this.read(projectId);
      return this.write(projectId, { ...current, plan, planUpdatedAt: new Date().toISOString() });
    });
  }

  /** Replace one exact passage of the plan, so a small change does not rewrite the whole document. */
  editPlan(projectId: string, oldText: string, newText: string): Promise<ProjectNotes> {
    return this.enqueue(async () => {
      const current = await this.read(projectId);
      if (oldText === "") throw new ProjectNotesError("old_text must not be empty. Use action \"write\" to replace the whole plan.");
      const first = current.plan.indexOf(oldText);
      if (first < 0) throw new ProjectNotesError("old_text was not found in the master plan. Read it again and copy the passage exactly.");
      if (current.plan.indexOf(oldText, first + 1) >= 0) throw new ProjectNotesError("old_text appears more than once in the master plan. Include more surrounding text.");
      const plan = `${current.plan.slice(0, first)}${newText}${current.plan.slice(first + oldText.length)}`;
      if (plan.length > MAX_PLAN_CHARS) throw new ProjectNotesError(`The master plan is at most ${MAX_PLAN_CHARS.toLocaleString("en-US")} characters.`);
      return this.write(projectId, { ...current, plan, planUpdatedAt: new Date().toISOString() });
    });
  }
}

function renderMemories(notes: ProjectNotes): string {
  return notes.memories.length === 0
    ? "(no memories saved yet)"
    : notes.memories.map((memory) => `- [${memory.id}] ${memory.text}`).join("\n");
}

function renderPlan(notes: ProjectNotes): string {
  return notes.plan.trim() === "" ? "(no master plan written yet)" : notes.plan;
}

/** The system prompt block every new session of the project starts with. */
export function projectNotesPrompt(notes: ProjectNotes): string {
  return [
    "<project-notes>",
    "This project keeps notes that outlive any one chat. The user can read and edit them in Roqer.",
    `- Project memory: short facts worth knowing in every future chat (decisions, conventions, where things live, preferences the user stated, pitfalls already hit). Save one with \`${MEMORY_TOOL_NAME}\` when you learn something durable that is not obvious from the place itself; remove or update one that turns out wrong. Do not save transient progress or what the place already shows.`,
    `- Master plan: the design of the whole experience (pitch, core loop, mechanics with their numbers, controls, art direction, and a status for each part). Follow it when building. Read and edit it with \`${PLAN_TOOL_NAME}\`. When the user settles a design decision, or a part of the plan is built, update the plan to match; never silently contradict it. If the user asks for something that conflicts with it, point out the conflict.`,
    "",
    "<project-memory>",
    renderMemories(notes),
    "</project-memory>",
    "",
    "<master-plan>",
    renderPlan(notes),
    "</master-plan>",
    "</project-notes>",
  ].join("\n");
}

/** What a session that started before the notes changed is told on its next message. */
export function projectNotesUpdate(notes: ProjectNotes): string {
  return [
    "[Roqer: the project notes were changed since you last saw them (the user may have edited them in Roqer). They now read:]",
    "<project-memory>",
    renderMemories(notes),
    "</project-memory>",
    "<master-plan>",
    renderPlan(notes),
    "</master-plan>",
  ].join("\n");
}

export function memoryToolDefinition(): { name: string; description: string; inputSchema: JsonRecord } {
  return {
    name: MEMORY_TOOL_NAME,
    description: [
      "Read or change this project's memory: short facts that every future chat in the project starts with.",
      "action \"list\" returns every memory with its id. \"add\" saves `text` as a new memory. \"update\" replaces the text of memory `id`. \"remove\" deletes memory `id`.",
      `Keep each memory to one fact, at most ${MAX_MEMORY_CHARS} characters. Save what is durable and not obvious from the place: decisions, conventions, preferences the user stated, pitfalls already hit. Check the list in your system prompt first so you do not save a duplicate.`,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "update", "remove"] },
        text: { type: "string", description: "The memory, for add and update." },
        id: { type: "string", description: "The memory's id, for update and remove." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export function planToolDefinition(): { name: string; description: string; inputSchema: JsonRecord } {
  return {
    name: PLAN_TOOL_NAME,
    description: [
      "Read or change this project's master plan: the design document for the whole experience, shared by every chat in the project.",
      "action \"read\" returns the current plan. \"write\" replaces the whole plan with `content` (use it to create the plan or restructure it). \"edit\" replaces the exact passage `old_text` with `new_text` (use it for small changes, such as a status or a number).",
      `Markdown. At most ${MAX_PLAN_CHARS.toLocaleString("en-US")} characters. Keep a status for each part (idea, building, done, needs fixing) so any chat can see what is left.`,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "edit"] },
        content: { type: "string", description: "The whole new plan, for write." },
        old_text: { type: "string", description: "The exact passage to replace, for edit." },
        new_text: { type: "string", description: "What replaces it, for edit." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

const text = (args: JsonRecord, key: string): string => {
  const value = args[key];
  if (typeof value !== "string") throw new ProjectNotesError(`${key} is required and must be a string.`);
  return value;
};

/** Answer one call to either notes tool. Throws a message the model can act on. */
export async function runProjectNotesTool(store: ProjectNotesStore, projectId: string, name: string, args: JsonRecord): Promise<string> {
  const action = args.action;
  if (name === MEMORY_TOOL_NAME) {
    if (action === "list") return renderMemories(await store.get(projectId));
    if (action === "add") {
      const notes = await store.addMemory(projectId, text(args, "text"));
      return `Saved as ${notes.memories.at(-1)!.id}.`;
    }
    if (action === "update") {
      await store.updateMemory(projectId, text(args, "id"), text(args, "text"));
      return "Memory updated.";
    }
    if (action === "remove") {
      await store.removeMemory(projectId, text(args, "id"));
      return "Memory removed.";
    }
    throw new ProjectNotesError("action must be list, add, update, or remove.");
  }
  if (name === PLAN_TOOL_NAME) {
    if (action === "read") return renderPlan(await store.get(projectId));
    if (action === "write") {
      const notes = await store.setPlan(projectId, text(args, "content"));
      return `Master plan saved (${notes.plan.length.toLocaleString("en-US")} characters).`;
    }
    if (action === "edit") {
      await store.editPlan(projectId, text(args, "old_text"), text(args, "new_text"));
      return "Master plan updated.";
    }
    throw new ProjectNotesError("action must be read, write, or edit.");
  }
  throw new ProjectNotesError(`Unknown notes tool ${name}.`);
}
