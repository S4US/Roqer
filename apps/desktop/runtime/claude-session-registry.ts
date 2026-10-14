import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Which saved Claude Code session holds each chat's conversation.
 *
 * Claude Code writes every session to disk and can resume one by id in a new
 * process, tool results and all, compacting it itself when it fills. Roqer
 * keeps the id per chat, so a run that failed or was cancelled, an idle
 * process that was closed, a changed model or effort, or a restart of the app
 * all continue the same conversation instead of starting over from a bounded
 * text replay.
 */

type JsonRecord = Record<string, unknown>;

export type ClaudeChatSession = {
  /** Claude Code's session id. */
  sessionId: string;
  /** The last prompt written to the session, to find where the chat moved on without it. */
  lastPrompt: string | null;
  /** The Studio place the session last worked in. */
  instanceId: string | null;
  /** The model the session last ran on, for compaction. */
  model: string | null;
  /**
   * The version of the project notes the conversation was last given, so a
   * resumed session is sent them again only when they changed. Null after a
   * compaction, which may have summarized them away.
   */
  notesVersion: string | null;
  updatedAt: string;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEntry(value: unknown): ClaudeChatSession | null {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId)) return null;
  return {
    sessionId: value.sessionId,
    lastPrompt: typeof value.lastPrompt === "string" ? value.lastPrompt : null,
    instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
    model: typeof value.model === "string" ? value.model : null,
    notesVersion: typeof value.notesVersion === "string" ? value.notesVersion : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

export class ClaudeSessionRegistry {
  private entries: Map<string, ClaudeChatSession> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Maps read while the file could not be, which are never written back over it. */
  private readonly unreadable = new WeakSet<Map<string, ClaudeChatSession>>();

  private async load(): Promise<Map<string, ClaudeChatSession>> {
    if (this.entries) return this.entries;
    const entries = new Map<string, ClaudeChatSession>();
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      if (isRecord(parsed) && isRecord(parsed.chats)) {
        for (const [chatId, value] of Object.entries(parsed.chats)) {
          const entry = parseEntry(value);
          if (entry) entries.set(chatId, entry);
        }
      }
    } catch (error) {
      // Missing or damaged: every chat starts a new session, which is what it
      // did before sessions were kept at all. Unreadable just now (locked):
      // this run starts a new session, and the file is left for the next read.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unreadable.add(entries);
        return entries;
      }
    }
    this.entries = entries;
    return entries;
  }

  private async save(entries: Map<string, ClaudeChatSession>): Promise<void> {
    if (this.unreadable.has(entries)) return;
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, chats: Object.fromEntries(entries) }, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      await fs.rename(temporary, this.file);
    } catch {
      // A lost write costs one chat its continuity on the next restart, not
      // the run in progress, so it is not allowed to fail the run.
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  get(chatId: string): Promise<ClaudeChatSession | undefined> {
    return this.enqueue(async () => (await this.load()).get(chatId));
  }

  /** Record the chat's session, creating the entry or merging into it. */
  update(chatId: string, change: Partial<ClaudeChatSession> & { sessionId: string }): Promise<ClaudeChatSession> {
    return this.enqueue(async () => {
      const entries = await this.load();
      const current = entries.get(chatId);
      const next: ClaudeChatSession = {
        lastPrompt: null, instanceId: null, model: null, notesVersion: null,
        ...(current?.sessionId === change.sessionId ? current : {}),
        ...change,
        updatedAt: new Date().toISOString(),
      };
      entries.set(chatId, next);
      await this.save(entries);
      return next;
    });
  }

  forget(chatId: string): Promise<void> {
    return this.enqueue(async () => {
      const entries = await this.load();
      if (entries.delete(chatId)) await this.save(entries);
    });
  }
}
