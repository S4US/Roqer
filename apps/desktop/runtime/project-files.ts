import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  imageMediaType, isProjectFile, MAX_FILE_NOTE_CHARS, MAX_PROJECT_FILE_BYTES, MAX_PROJECT_FILES, projectFileKind,
  type ProjectFile,
} from "../shared/project-files";
import type { McpToolImage } from "./mcp-types";

/**
 * A project's shared files, on disk beside Roqer's other data.
 *
 * Each file is copied in, so a model keeps working after the original is
 * moved or a Blender job folder is cleared. One folder per project holds an
 * index and one subfolder per file, named by the file's id, so no name the
 * user or an agent chose ever decides where anything is written.
 */

export const PROJECT_FILES_TOOL_NAME = "project_files";

/** The most of a text file the agent is shown in one read. */
const MAX_READ_CHARS = 60_000;
/** The largest picture the agent is shown as an image. */
const MAX_READ_IMAGE_BYTES = 4 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class ProjectFilesError extends Error {}

/** The index format this build reads and writes. */
export const PROJECT_FILES_INDEX_VERSION = 1;

/**
 * What a read of the index found. `writable` is false when writing would lose
 * what is there: a file from a newer Roqer, kept as it is.
 */
type LoadedIndex = { files: ProjectFile[]; writable: boolean };

/** A file's folder is named `file-` and a random id; nothing else in the project folder is one. */
const FILE_FOLDER = /^file-[A-Za-z0-9_-]{1,120}$/;

function safeId(value: string, what: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ProjectFilesError(`That ${what} id is not valid.`);
  return value;
}

const MAX_NAME_CHARS = 180;

/**
 * A name for the copy: the original's base name, with nothing that could leave
 * its folder. A long name is cut in its stem so the extension, which decides
 * the file's kind, survives. Applying it twice changes nothing.
 */
export function safeName(name: string): string {
  let base = Array.from(path.basename(name), (character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character))
    .join("").trim();
  if (base.length > MAX_NAME_CHARS) {
    const ext = path.extname(base).slice(0, 20);
    base = `${base.slice(0, MAX_NAME_CHARS - ext.length).trimEnd()}${ext}`;
  }
  // Windows drops trailing dots and spaces from a file name, so none are kept.
  base = base.replace(/[. ]+$/, "");
  return (base === "" || base === "." || base === "..") ? "file" : base;
}

export class ProjectFilesStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {}

  private projectDirectory(projectId: string): string {
    return path.join(this.directory, safeId(projectId, "project"));
  }

  private indexFile(projectId: string): string {
    return path.join(this.projectDirectory(projectId), "index.json");
  }

  /**
   * Reads and writes run one at a time, so two adds never lose each other's
   * entry and a repair is never raced by an add.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  list(projectId: string): Promise<ProjectFile[]> {
    return this.serial(async () => (await this.load(projectId)).files);
  }

  /**
   * The project's index.
   *
   * - Missing: none yet, unless file folders are there without one, which are
   *   listed again from what is on disk.
   * - Unreadable just now (locked by an indexer or antivirus on Windows): an
   *   error, so nothing is written over an index that is still there.
   * - Damaged (not JSON, or entries that are not files): kept beside it as
   *   `index.json.damaged-<time>`, and rebuilt from the valid entries plus the
   *   file folders it no longer lists, so no file is lost from the project.
   * - From a newer Roqer: read for what this build understands, never written.
   */
  private async load(projectId: string): Promise<LoadedIndex> {
    const file = this.indexFile(projectId);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProjectFilesError("The project's file list could not be read just now. Nothing was changed; try again.");
      }
      const found = await this.recover(projectId, []);
      if (found.length > 0) await this.write(projectId, found);
      return { files: found, writable: true };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    // The first builds wrote a bare array; it is read as version 1.
    const stored = Array.isArray(raw) ? { version: 1, files: raw } : raw;
    const version = isRecord(stored) && Number.isInteger(stored.version) ? stored.version as number : null;
    const entries = isRecord(stored) && Array.isArray(stored.files) ? stored.files : null;
    if (version !== null && version > PROJECT_FILES_INDEX_VERSION && entries !== null) {
      return { files: entries.filter(isProjectFile).slice(0, MAX_PROJECT_FILES), writable: false };
    }
    const valid = entries === null ? [] : entries.filter(isProjectFile).slice(0, MAX_PROJECT_FILES);
    if (version !== null && entries !== null && valid.length === entries.length && !Array.isArray(raw)) {
      return { files: valid, writable: true };
    }
    if (version === null || entries === null || valid.length !== entries.length) {
      await fs.copyFile(file, `${file}.damaged-${Date.now()}`).catch(() => undefined);
    }
    const repaired = await this.recover(projectId, valid);
    // Written now, so the damaged copy is made once rather than on every read.
    await this.write(projectId, repaired);
    return { files: repaired, writable: true };
  }

  /**
   * `known`, plus an entry for each file folder it does not list. Such a
   * folder holds the one file that was copied in; what the index said about
   * it (a note, an asset id) is gone, but the file is not.
   */
  private async recover(projectId: string, known: ProjectFile[]): Promise<ProjectFile[]> {
    const listed = new Set(known.map((entry) => entry.id));
    const folders = await fs.readdir(this.projectDirectory(projectId), { withFileTypes: true }).catch(() => []);
    const found: ProjectFile[] = [];
    for (const folder of folders) {
      if (!folder.isDirectory() || !FILE_FOLDER.test(folder.name) || listed.has(folder.name)) continue;
      const directory = path.join(this.projectDirectory(projectId), folder.name);
      const inside = (await fs.readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile());
      if (inside.length !== 1) continue;
      const stat = await fs.stat(path.join(directory, inside[0].name)).catch(() => undefined);
      if (stat === undefined) continue;
      found.push({
        id: folder.name,
        name: inside[0].name,
        size: stat.size,
        kind: projectFileKind(inside[0].name),
        addedAt: stat.mtime.toISOString(),
        addedBy: "user",
      });
    }
    found.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    return [...known, ...found].slice(0, MAX_PROJECT_FILES);
  }

  /** The index, for a change: refused when writing it would lose what a newer Roqer saved. */
  private async loadForChange(projectId: string): Promise<ProjectFile[]> {
    const loaded = await this.load(projectId);
    if (!loaded.writable) {
      throw new ProjectFilesError("This project's files were saved by a newer version of Roqer. Update Roqer to change them.");
    }
    return loaded.files;
  }

  private async write(projectId: string, files: ProjectFile[]): Promise<void> {
    const file = this.indexFile(projectId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: PROJECT_FILES_INDEX_VERSION, files }, null, 1), { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, file);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new ProjectFilesError("The project's file list could not be saved.");
    }
  }

  /** Delete every file the project holds, and its index. */
  removeProject(projectId: string): Promise<void> {
    return this.serial(() => fs.rm(this.projectDirectory(projectId), { recursive: true, force: true }));
  }

  /** Where a file's copy lives. Throws for an id the project does not have. */
  async path(projectId: string, fileId: string): Promise<{ file: ProjectFile; filePath: string }> {
    const file = (await this.list(projectId)).find((entry) => entry.id === safeId(fileId, "file"));
    if (file === undefined) throw new ProjectFilesError(`This project has no file ${fileId}. List the files to see their ids.`);
    return { file, filePath: path.join(this.projectDirectory(projectId), file.id, safeName(file.name)) };
  }

  /** Copy a file in. `name` replaces the original's name; its extension decides the kind. */
  add(projectId: string, source: string, details: { name?: string; note?: string; addedBy: "user" | "agent"; chatId?: string }): Promise<ProjectFile> {
    return this.serial(async () => {
      const stat = await fs.stat(source).catch(() => undefined);
      if (stat === undefined || !stat.isFile()) throw new ProjectFilesError(`${source} is not a file Roqer can read.`);
      if (stat.size > MAX_PROJECT_FILE_BYTES) throw new ProjectFilesError(`${path.basename(source)} is larger than ${MAX_PROJECT_FILE_BYTES / 1024 / 1024} MB.`);
      const files = await this.loadForChange(projectId);
      if (files.length >= MAX_PROJECT_FILES) throw new ProjectFilesError(`A project holds at most ${MAX_PROJECT_FILES} files. Remove some first.`);
      const name = safeName(details.name ?? path.basename(source));
      const id = `file-${randomUUID().slice(0, 12)}`;
      const folder = path.join(this.projectDirectory(projectId), id);
      await fs.mkdir(folder, { recursive: true });
      await fs.copyFile(source, path.join(folder, name));
      const entry: ProjectFile = {
        id,
        name,
        size: stat.size,
        kind: projectFileKind(name),
        addedAt: new Date().toISOString(),
        addedBy: details.addedBy,
        ...(details.chatId === undefined ? {} : { chatId: details.chatId }),
        ...(details.note === undefined || details.note.trim() === "" ? {} : { note: details.note.trim().slice(0, MAX_FILE_NOTE_CHARS) }),
      };
      await this.write(projectId, [...files, entry]);
      return entry;
    });
  }

  update(projectId: string, fileId: string, change: Partial<Pick<ProjectFile, "note" | "assetId" | "uploadedAt" | "name">>): Promise<ProjectFile> {
    return this.serial(async () => {
      const files = await this.loadForChange(projectId);
      const index = files.findIndex((entry) => entry.id === fileId);
      if (index < 0) throw new ProjectFilesError(`This project has no file ${fileId}.`);
      const current = files[index];
      let name = current.name;
      if (change.name !== undefined && safeName(change.name) !== current.name) {
        name = safeName(change.name);
        const folder = path.join(this.projectDirectory(projectId), current.id);
        await fs.rename(path.join(folder, current.name), path.join(folder, name));
      }
      const note = change.note === undefined ? current.note : change.note.trim().slice(0, MAX_FILE_NOTE_CHARS) || undefined;
      const next: ProjectFile = {
        ...current,
        name,
        kind: projectFileKind(name),
        ...(note === undefined ? {} : { note }),
        ...(change.assetId === undefined ? {} : { assetId: change.assetId }),
        ...(change.uploadedAt === undefined ? {} : { uploadedAt: change.uploadedAt }),
      };
      if (note === undefined) delete next.note;
      const updated = files.slice();
      updated[index] = next;
      await this.write(projectId, updated);
      return next;
    });
  }

  remove(projectId: string, fileId: string): Promise<void> {
    return this.serial(async () => {
      const files = await this.loadForChange(projectId);
      if (!files.some((entry) => entry.id === fileId)) return;
      await this.write(projectId, files.filter((entry) => entry.id !== fileId));
      await fs.rm(path.join(this.projectDirectory(projectId), safeId(fileId, "file")), { recursive: true, force: true });
    });
  }
}

// -- The agent's tool --------------------------------------------------------

export function projectFilesToolDefinition() {
  return {
    name: PROJECT_FILES_TOOL_NAME,
    description: [
      "The project's shared files: models, pictures, plans and other documents the user dropped in or a chat saved. Every chat in the project can use every file; the ones the user shared with this chat are marked.",
      "list: every file with its id, kind, size, note, and the Roblox asset id once uploaded.",
      "read {id}: a text file's contents, or a picture to look at. A model is not read: pass its path to the blender tool's inspect_file to see it from any angle.",
      "path {id}: the file's absolute path, for blender inspect_file, a Blender script to import, or upload_asset.",
      "save {path, name?, note?}: copy a file you made (a Blender export from a job's output folder) into the project, so the user can view it, send it to Studio, and other chats can use it. Give it a clear name and a one-line note.",
      "note {id, note}: set what a file is.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "path", "save", "note"] },
        id: { type: "string", description: "The file's id, from list. For read, path and note." },
        path: { type: "string", description: "save: the absolute path of the file to copy in." },
        name: { type: "string", description: "save: the name to keep it under, with its extension." },
        note: { type: "string", description: `save, note: what the file is, at most ${MAX_FILE_NOTE_CHARS} characters.` },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export type ProjectFilesToolContext = {
  store: ProjectFilesStore;
  projectId: string;
  chatId?: string;
  /** The files the user shared with this chat. */
  shared: readonly string[];
  /** Folders `save` may copy from; anything else is refused. */
  saveRoots: readonly string[];
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function describeProjectFile(file: ProjectFile, shared: readonly string[], chatId?: string): string {
  const parts = [`${file.id} · ${file.name} · ${file.kind} · ${sizeLabel(file.size)}`];
  if (shared.includes(file.id)) parts.push("shared with this chat");
  if (file.chatId !== undefined && file.chatId === chatId) parts.push("added in this chat");
  else if (file.addedBy === "agent") parts.push("saved by another chat");
  if (file.assetId !== undefined) parts.push(`uploaded as asset ${file.assetId}`);
  if (file.note !== undefined) parts.push(`note: ${file.note}`);
  return `- ${parts.join(" · ")}`;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new ProjectFilesError(`project_files needs ${what}.`);
  return value.trim();
};

export async function runProjectFilesTool(
  context: ProjectFilesToolContext,
  args: JsonRecord,
): Promise<{ text: string; images?: McpToolImage[]; changed: boolean }> {
  const { store, projectId } = context;
  switch (args.action) {
    case "list": {
      const files = await store.list(projectId);
      if (files.length === 0) return { text: "The project has no files yet. The user can drop files into the Files panel, and you can save your work with project_files save.", changed: false };
      return { text: [`${files.length} project file${files.length === 1 ? "" : "s"}:`, ...files.map((file) => describeProjectFile(file, context.shared, context.chatId))].join("\n"), changed: false };
    }
    case "path": {
      const { file, filePath } = await store.path(projectId, text(args.id, "id"));
      return { text: `${file.name}: ${filePath}`, changed: false };
    }
    case "read": {
      const { file, filePath } = await store.path(projectId, text(args.id, "id"));
      if (file.kind === "image") {
        const mediaType = imageMediaType(file.name);
        if (mediaType === "image/gif" || mediaType === null) return { text: `${file.name} is a picture Roqer cannot show you. Its path: ${filePath}`, changed: false };
        if (file.size > MAX_READ_IMAGE_BYTES) return { text: `${file.name} is too large to show (${sizeLabel(file.size)}). Its path: ${filePath}`, changed: false };
        const data = (await fs.readFile(filePath)).toString("base64");
        return { text: `${file.name}, attached.`, images: [{ data, mediaType: mediaType as McpToolImage["mediaType"] }], changed: false };
      }
      if (file.kind === "model") {
        return { text: `${file.name} is a 3D model. Look at it with the blender tool: inspect_file "${filePath}", with views for the angles you need.`, changed: false };
      }
      if (file.kind === "other") return { text: `${file.name} is not a text file. Its path: ${filePath}`, changed: false };
      // Only the start is read: a text file can be hundreds of megabytes.
      const handle = await fs.open(filePath, "r");
      let content: string;
      try {
        const buffer = Buffer.alloc(Math.min(file.size, MAX_READ_CHARS * 4));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      const cut = content.length > MAX_READ_CHARS || file.size > MAX_READ_CHARS * 4;
      return { text: `${file.name}${cut ? ` (the first ${MAX_READ_CHARS.toLocaleString("en-US")} characters of ${sizeLabel(file.size)})` : ""}:\n\n${content.slice(0, MAX_READ_CHARS)}`, changed: false };
    }
    case "save": {
      const source = text(args.path, "path: the absolute path of the file to save");
      if (!path.isAbsolute(source) || !context.saveRoots.some((root) => within(root, source))) {
        throw new ProjectFilesError("project_files save copies files Roqer made, such as a Blender job's exports; that path is outside them.");
      }
      const file = await store.add(projectId, source, {
        ...(typeof args.name === "string" && args.name.trim() !== "" ? { name: args.name } : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
        addedBy: "agent",
        ...(context.chatId === undefined ? {} : { chatId: context.chatId }),
      });
      return { text: `Saved ${file.name} to the project as ${file.id}. The user can view it in 3D and send it to Studio from the Files panel.`, changed: true };
    }
    case "note": {
      const file = await store.update(projectId, text(args.id, "id"), { note: typeof args.note === "string" ? args.note : "" });
      return { text: `Noted ${file.name}.`, changed: true };
    }
    default:
      throw new ProjectFilesError("project_files action must be list, read, path, save or note.");
  }
}

/** Told with each message: the files the user put in front of this chat. */
export function sharedFilesNotice(files: readonly ProjectFile[], shared: readonly string[]): string | null {
  const chosen = files.filter((file) => shared.includes(file.id));
  if (chosen.length === 0) return null;
  return [
    "[Roqer: the user shared these project files with this chat. Read them with project_files read (models: blender inspect_file) when they bear on the request.]",
    ...chosen.map((file) => describeProjectFile(file, shared)),
  ].join("\n");
}
