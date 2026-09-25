import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createInitialWorkspace, normalizeWorkspace, type Chat, type WorkspaceState } from "../src/model";
import { malformedWorkspace, supportsWorkspaceSchema } from "../shared/workspace-validation";

const MANIFEST_FORMAT_VERSION = 1;
const WORKSPACE_SCHEMA_VERSION = 3;
const MAX_CHAT_BYTES = 64 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}\.json$/;

type ChatReference = Omit<Chat, "messages"> & { content: string };
type WorkspaceManifest = Omit<WorkspaceState, "projects"> & {
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  projects: Array<Omit<WorkspaceState["projects"][number], "chats"> & { chats: ChatReference[] }>;
};

type RecoveryKind = "corrupt" | "future" | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stableJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readBounded(path: string, maximum: number): Promise<string> {
  const info = await stat(path);
  if (info.size > maximum) {
    throw new Error(`${basename(path)} is ${info.size} bytes; the per-chat limit is ${maximum} bytes. Export or shorten that chat before saving.`);
  }
  return readFile(path, "utf8");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class WorkspaceStore {
  readonly #manifestPath: string;
  readonly #legacyPath: string;
  readonly #previousManifestPath: string;
  readonly #chatDirectory: string;
  #required = false;
  #message: string | null = null;
  #recoveryKind: RecoveryKind = null;
  #recoverySources: string[] = [];
  #lockedRaw: unknown = undefined;
  #loaded: WorkspaceState | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {
    this.#manifestPath = join(root, "workspace-manifest.json");
    this.#previousManifestPath = join(root, "workspace-manifest.previous.json");
    this.#legacyPath = join(root, "workspace-state.json");
    this.#chatDirectory = join(root, "workspace-chats");
  }

  status(): { required: boolean; message: string | null } {
    return { required: this.#required, message: this.#message };
  }

  async load(): Promise<unknown> {
    return this.#serialize(async () => {
      this.#clearRecovery();
      if (await exists(this.#manifestPath)) return this.#loadManifest();
      if (await exists(this.#legacyPath)) return this.#loadLegacy();
      this.#loaded = createInitialWorkspace();
      return this.#loaded;
    });
  }

  async save(state: unknown): Promise<{ savedAt: string }> {
    return this.#serialize(() => this.#save(state));
  }

  async recover(): Promise<unknown> {
    return this.#serialize(async () => {
      if (!this.#required) return this.#loaded ?? this.#loadUnlocked();
      if (this.#recoveryKind === "future") {
        throw new Error("This workspace was written by a newer app version and cannot be recovered safely. Update the app or export it without replacing the original.");
      }
      const state = this.#loaded ?? createInitialWorkspace();
      const backupDirectory = join(this.root, "workspace-recovery", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
      await mkdir(backupDirectory, { recursive: true });
      for (const source of this.#recoverySources) {
        if (await exists(source)) await copyFile(source, join(backupDirectory, basename(source)));
      }
      await this.#save(state, true);
      this.#clearRecovery();
      return state;
    });
  }

  async export(destination: string, state?: unknown): Promise<void> {
    return this.#serialize(async () => {
      if (state !== undefined) {
        if (!supportsWorkspaceSchema(state) || malformedWorkspace(state)) {
          throw new Error("Cannot export a workspace with an unsupported schema or malformed records.");
        }
        await atomicWrite(destination, stableJson(normalizeWorkspace(state)));
        return;
      }
      if (this.#loaded === null) await this.#loadUnlocked();
      const exported = this.#recoveryKind === "future" && this.#lockedRaw !== undefined
        ? this.#lockedRaw
        : this.#loaded ?? createInitialWorkspace();
      await atomicWrite(destination, stableJson(exported));
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #loadUnlocked(): Promise<WorkspaceState> {
    if (await exists(this.#manifestPath)) return this.#loadManifest();
    if (await exists(this.#legacyPath)) return this.#loadLegacy();
    this.#loaded = createInitialWorkspace();
    return this.#loaded;
  }

  async #loadLegacy(): Promise<WorkspaceState> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#legacyPath, "utf8"));
    } catch {
      return this.#lock(createInitialWorkspace(), "The legacy workspace file is not valid JSON. Recovery is required before it can be replaced.", "corrupt", [this.#legacyPath]);
    }
    if (isRecord(raw) && typeof raw.schemaVersion === "number" && raw.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
      return this.#lock(createInitialWorkspace(), `Workspace schema ${raw.schemaVersion} is newer than supported schema ${WORKSPACE_SCHEMA_VERSION}.`, "future", [this.#legacyPath], raw);
    }
    if (!supportsWorkspaceSchema(raw)) {
      return this.#lock(createInitialWorkspace(), "The legacy workspace has an unsupported schema version.", "corrupt", [this.#legacyPath]);
    }
    const normalized = normalizeWorkspace(raw);
    if (malformedWorkspace(raw)) {
      return this.#lock(normalized, "Some malformed workspace records could not be loaded. Review the salvaged workspace, then recover explicitly.", "corrupt", [this.#legacyPath]);
    }
    this.#loaded = normalized;
    return normalized;
  }

  async #loadManifest(): Promise<WorkspaceState> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#manifestPath, "utf8"));
    } catch {
      return this.#lock(createInitialWorkspace(), "The workspace manifest is not valid JSON. Recovery is required before saving.", "corrupt", [this.#manifestPath]);
    }
    if (!isRecord(raw) || typeof raw.formatVersion !== "number") {
      return this.#lock(createInitialWorkspace(), "The workspace manifest has an invalid format.", "corrupt", [this.#manifestPath]);
    }
    if (raw.formatVersion > MANIFEST_FORMAT_VERSION || (typeof raw.schemaVersion === "number" && raw.schemaVersion > WORKSPACE_SCHEMA_VERSION)) {
      return this.#lock(createInitialWorkspace(), "The workspace was written by a newer app version.", "future", [this.#manifestPath], raw);
    }
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) {
      return this.#lock(createInitialWorkspace(), "The workspace manifest has an unsupported schema version.", "corrupt", [this.#manifestPath]);
    }
    if (raw.formatVersion !== MANIFEST_FORMAT_VERSION || !Array.isArray(raw.projects)) {
      return this.#lock(createInitialWorkspace(), "The workspace manifest has an unsupported or malformed format.", "corrupt", [this.#manifestPath]);
    }

    let damaged = false;
    const sources = [this.#manifestPath];
    const projects = [] as WorkspaceState["projects"];
    for (const project of raw.projects) {
      if (!isRecord(project) || !Array.isArray(project.chats)) { damaged = true; continue; }
      const chats: Chat[] = [];
      for (const reference of project.chats) {
        if (!isRecord(reference) || typeof reference.content !== "string" || !HASH_PATTERN.test(reference.content)) { damaged = true; continue; }
        const chatPath = join(this.#chatDirectory, reference.content);
        sources.push(chatPath);
        try {
          const encoded = await readBounded(chatPath, MAX_CHAT_BYTES);
          if (`${digest(encoded)}.json` !== reference.content) throw new Error("digest mismatch");
          const chatRaw: unknown = JSON.parse(encoded);
          const chatWorkspace = { ...raw, projects: [{ ...project, chats: [chatRaw] }] };
          delete (chatWorkspace as Record<string, unknown>).formatVersion;
          const parsedChatWorkspace = normalizeWorkspace(chatWorkspace);
          const candidate = parsedChatWorkspace.projects[0]?.chats[0];
          if (!candidate || malformedWorkspace(chatWorkspace)) throw new Error("invalid chat");
          chats.push(candidate);
        } catch {
          damaged = true;
          const metadata = { ...reference };
          delete (metadata as Partial<ChatReference>).content;
          if (typeof metadata.id === "string" && typeof metadata.title === "string" && typeof metadata.createdAt === "string" && typeof metadata.updatedAt === "string") {
            chats.push({
              id: metadata.id,
              title: metadata.title,
              createdAt: metadata.createdAt,
              updatedAt: metadata.updatedAt,
              titleSetByUser: metadata.titleSetByUser === true ? true : undefined,
              messages: [],
            });
          }
        }
      }
      projects.push({ ...project, chats } as WorkspaceState["projects"][number]);
    }
    const assembled = { ...raw, projects };
    delete (assembled as Record<string, unknown>).formatVersion;
    const normalized = normalizeWorkspace(assembled);
    damaged ||= malformedWorkspace(assembled);
    if (damaged) return this.#lock(normalized, "One or more workspace records or chat files were missing, corrupt, or invalid. Review the salvaged workspace, then recover explicitly.", "corrupt", sources);
    this.#loaded = normalized;
    return normalized;
  }

  async #save(state: unknown, recovering = false): Promise<{ savedAt: string }> {
    if (this.#loaded === null) await this.#loadUnlocked();
    if (this.#required && !recovering) throw new Error(this.#message ?? "Workspace recovery is required before saving.");
    if (isRecord(state) && typeof state.schemaVersion === "number" && state.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
      throw new Error(`Cannot save future workspace schema ${state.schemaVersion}.`);
    }
    if (!supportsWorkspaceSchema(state)) {
      throw new Error("Cannot save a workspace with an unsupported schema version.");
    }
    const normalized = normalizeWorkspace(state);
    if (malformedWorkspace(state)) throw new Error("Cannot save a workspace containing malformed records.");
    await mkdir(this.#chatDirectory, { recursive: true });
    const projects: WorkspaceManifest["projects"] = [];
    for (const project of normalized.projects) {
      const references: ChatReference[] = [];
      for (const chat of project.chats) {
        const encoded = stableJson(chat);
        if (Buffer.byteLength(encoded) > MAX_CHAT_BYTES) throw new Error(`Chat ${chat.id} exceeds the ${MAX_CHAT_BYTES}-byte per-chat limit. Export or shorten it before saving.`);
        const filename = `${digest(encoded)}.json`;
        const path = join(this.#chatDirectory, filename);
        if (await exists(path)) {
          const existing = await readFile(path, "utf8").catch(() => "");
          if (existing !== encoded) await atomicWrite(path, encoded);
        } else await atomicWrite(path, encoded);
        references.push({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          ...(chat.titleSetByUser === true ? { titleSetByUser: true } : {}),
          content: filename,
        });
      }
      projects.push({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        chats: references,
      });
    }
    const savedAt = new Date().toISOString();
    const manifest: WorkspaceManifest = { ...normalized, formatVersion: MANIFEST_FORMAT_VERSION, projects };
    const previous = await readFile(this.#manifestPath, "utf8").catch(() => null);
    if (previous !== null) await atomicWrite(this.#previousManifestPath, previous);
    await atomicWrite(this.#manifestPath, stableJson(manifest));
    await this.#collectUnusedChats(manifest);
    this.#loaded = normalized;
    return { savedAt };
  }

  async #collectUnusedChats(current: WorkspaceManifest): Promise<void> {
    const retained = new Set(current.projects.flatMap((project) => project.chats.map((chat) => chat.content)));
    try {
      const previous: unknown = JSON.parse(await readFile(this.#previousManifestPath, "utf8"));
      if (isRecord(previous) && Array.isArray(previous.projects)) {
        for (const project of previous.projects) if (isRecord(project) && Array.isArray(project.chats)) {
          for (const chat of project.chats) if (isRecord(chat) && typeof chat.content === "string" && HASH_PATTERN.test(chat.content)) retained.add(chat.content);
        }
      }
    } catch { /* A missing or damaged previous snapshot retains nothing. */ }
    for (const filename of await readdir(this.#chatDirectory)) {
      if (HASH_PATTERN.test(filename) && !retained.has(filename)) await unlink(join(this.#chatDirectory, filename));
    }
  }

  #lock(state: WorkspaceState, message: string, kind: Exclude<RecoveryKind, null>, sources: string[], raw?: unknown): WorkspaceState {
    this.#required = true;
    this.#message = message;
    this.#recoveryKind = kind;
    this.#recoverySources = [...new Set(sources)];
    this.#lockedRaw = raw;
    this.#loaded = state;
    return state;
  }

  #clearRecovery(): void {
    this.#required = false;
    this.#message = null;
    this.#recoveryKind = null;
    this.#recoverySources = [];
    this.#lockedRaw = undefined;
  }
}
