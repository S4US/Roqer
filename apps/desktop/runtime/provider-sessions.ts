/**
 * Provider conversations kept alive between the messages of one chat.
 *
 * A subscription planner used to start a fresh Claude Code process or Codex
 * thread for every message and replay the chat as plain text. That replay
 * carries what was said but none of what was read — every script, tree, and
 * log a run looked at is gone — so each follow-up re-inspected Studio before it
 * could act, and paid for the replayed transcript again without the provider's
 * prompt cache. Keeping the provider's own conversation for the next message
 * gives the model its tool results back and lets the provider cache and
 * compact the context it already holds.
 *
 * The store is deliberately small. A run *takes* its chat's session, owning it
 * exclusively while it works, and *puts* it back only after a clean finish; a
 * run that fails, stalls, or is cancelled closes it instead, because what the
 * provider holds after that is not something the chat's record describes. A
 * session nobody takes within `idleMs` is closed: past the provider's prompt
 * cache, resuming a long context would re-bill all of it, and a short replay is
 * cheaper.
 *
 * Nothing here is persisted. A restart of the app starts every chat from the
 * replayed transcript, exactly as before.
 */

export interface ProviderSession {
  close(): void | Promise<void>;
}

/** Half an hour: inside the providers' longest prompt-cache window, and short enough not to hoard processes. */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export class ProviderSessionStore<T extends ProviderSession> {
  private readonly idleMs: number;
  private readonly entries = new Map<string, { session: T; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: { idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_SESSION_IDLE_MS;
  }

  /** Remove and return the chat's session. The caller now owns it. */
  take(chatId: string): T | undefined {
    const entry = this.entries.get(chatId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(chatId);
    return entry.session;
  }

  /** Hand a session back for the chat's next message, replacing (and closing) any other. */
  put(chatId: string, session: T): void {
    const previous = this.take(chatId);
    if (previous !== undefined && previous !== session) void closeQuietly(previous);
    const timer = setTimeout(() => {
      if (this.entries.get(chatId)?.session === session) this.drop(chatId);
    }, this.idleMs);
    // An idle session is never a reason for the app to stay running.
    timer.unref?.();
    this.entries.set(chatId, { session, timer });
  }

  /** Close the chat's session, if it has one. */
  drop(chatId: string): void {
    const session = this.take(chatId);
    if (session !== undefined) void closeQuietly(session);
  }

  /** Close every session, for sign-out, a lost provider process, or quitting. */
  async closeAll(): Promise<void> {
    const sessions = [...this.entries.keys()].map((chatId) => this.take(chatId)!);
    await Promise.all(sessions.map(closeQuietly));
  }

  get size(): number {
    return this.entries.size;
  }
}

async function closeQuietly(session: ProviderSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // Closing is cleanup. A session that cannot close cleanly is still gone
    // from the store, which is what the next message depends on.
  }
}
