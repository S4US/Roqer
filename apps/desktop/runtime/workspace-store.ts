import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createInitialWorkspace, normalizeWorkspace, type Chat, type WorkspaceState } from "../src/model";
import { malformedWorkspace, supportsWorkspaceSchema } from "../shared/workspace-validation";
import { inlineStoredPictures, pictureRefs, PictureStore, storeInlinePictures } from "./picture-store";

const MANIFEST_FORMAT_VERSION = 1;
const WORKSPACE_SCHEMA_VERSION = 3;
const MAX_CHAT_BYTES = 64 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}\.json$/;
/**
 * A picture ref as a saved chat file spells it. Chat files are written by
 * `stableJson`, so the field has no spacing; reading refs this way needs no
 * parse, and can only find more refs than are there, never fewer.
 */
const PICTURE_REF_IN_CHAT = /"imageRef":"([0-9a-f]{64}\.(?:jpg|png))"/g;

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
  /** The saved runs' previews, as files beside the chats that refer to them. */
  readonly pictures: PictureStore;

  constructor(readonly root: string, options: { pictures?: PictureStore } = {}) {
    this.#manifestPath = join(root, "workspace-manifest.json");
    this.#previousManifestPath = join(root, "workspace-manifest.previous.json");
    this.#legacyPath = join(root, "workspace-state.json");
    this.#chatDirectory = join(root, "workspace-chats");
    this.pictures = options.pictures ?? new PictureStore(root);
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

  /**
   * Write a copy of the workspace to `destination`. The copy stands on its own:
   * every stored picture it refers to is put back inline, as it was before
   * pictures were stored apart.
   */
  async export(destination: string, state?: unknown): Promise<void> {
    return this.#serialize(async () => {
      if (state !== undefined) {
        if (!supportsWorkspaceSchema(state) || malformedWorkspace(state)) {
          throw new Error("Cannot export a workspace with an unsupported schema or malformed records.");
        }
        await atomicWrite(destination, stableJson(await inlineStoredPictures(normalizeWorkspace(state), this.pictures)));
        return;
      }
      if (this.#loaded === null) await this.#loadUnlocked();
      const exported = this.#recoveryKind === "future" && this.#lockedRaw !== undefined
        ? this.#lockedRaw
        : await inlineStoredPictures(this.#loaded ?? createInitialWorkspace(), this.pictures);
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
    return this.#adopt(normalized);
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
    return this.#adopt(normalized);
  }

  /**
   * Take a cleanly loaded workspace as the one in use. Pictures that earlier
   * builds saved inside chats move to the picture store first, and the chats
   * are saved once without them: each picture file is written before any chat
   * stops holding it, so stopping part-way loses nothing, and the next load
   * finds the work done. A workspace that needs recovery never comes here, so
   * it is left exactly as found.
   */
  async #adopt(normalized: WorkspaceState): Promise<WorkspaceState> {
    const migrated = await storeInlinePictures(normalized, this.pictures);
    this.#loaded = migrated;
    // The chats on disk still hold every picture, so a save that fails here
    // (a full disk) only leaves the move to finish on a later save.
    if (migrated !== normalized) await this.#save(migrated).catch(() => undefined);
    return this.#loaded;
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
    if (malformedWorkspace(state)) throw new Error("Cannot save a workspace containing malformed records.");
    // A picture still inline — one the renderer made without a store, or one
    // the store refused before — moves out now if the store can take it.
    const normalized = await storeInlinePictures(normalizeWorkspace(state), this.pictures);
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
    const retained = await this.#collectUnusedChats(manifest);
    this.#loaded = normalized;
    // Never while recovering: a chat that could not be read still refers to
    // its pictures, and nothing here can say which.
    if (!recovering) await this.#collectUnusedPictures(normalized, manifest, retained).catch(() => undefined);
    return { savedAt };
  }

  /**
   * Remove the pictures nothing kept refers to: no chat in use, no chat the
   * previous manifest still keeps on disk, and no recovery backup, which is
   * kept so damaged chats can be looked into later. If one of those files
   * cannot be read, nothing is removed this time.
   */
  async #collectUnusedPictures(state: WorkspaceState, current: WorkspaceManifest, retained: ReadonlySet<string>): Promise<void> {
    const referenced = pictureRefs(state);
    const inUse = new Set(current.projects.flatMap((project) => project.chats.map((chat) => chat.content)));
    for (const filename of retained) {
      if (inUse.has(filename)) continue;
      const encoded = await readFile(join(this.#chatDirectory, filename), "utf8");
      for (const match of encoded.matchAll(PICTURE_REF_IN_CHAT)) referenced.add(match[1]);
    }
    for (const ref of await this.#backupPictureRefs()) referenced.add(ref);
    await this.pictures.collect(referenced);
  }

  /** Recovery backups never change once written, so each is read for refs once. */
  readonly #backupRefs = new Map<string, readonly string[]>();

  async #backupPictureRefs(): Promise<string[]> {
    const backups = join(this.root, "workspace-recovery");
    const refs: string[] = [];
    const folders = await readdir(backups, { withFileTypes: true }).catch(() => []);
    for (const folder of folders.filter((entry) => entry.isDirectory())) {
      const files = await readdir(join(backups, folder.name), { withFileTypes: true });
      for (const file of files.filter((entry) => entry.isFile())) {
        const path = join(backups, folder.name, file.name);
        let found = this.#backupRefs.get(path);
        if (found === undefined) {
          found = [...(await readFile(path, "utf8")).matchAll(PICTURE_REF_IN_CHAT)].map((match) => match[1]);
          this.#backupRefs.set(path, found);
        }
        refs.push(...found);
      }
    }
    return refs;
  }

  /** Remove the chat files neither manifest refers to; returns the ones kept. */
  async #collectUnusedChats(current: WorkspaceManifest): Promise<Set<string>> {
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
    return retained;
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
