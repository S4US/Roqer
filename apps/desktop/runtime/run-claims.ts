/**
 * What a run holds while it starts and works: its chat, and the Roblox Studio
 * place it writes.
 *
 * Several chats can run at once, but a chat takes one run at a time, because
 * its provider conversation is kept per chat and two runs would interleave
 * their turns in it. A Studio place takes one writing run at a time, because
 * two runs editing the same place could overwrite each other's work. A run
 * claims what it holds before it does anything that waits, so two starts that
 * arrive together cannot both get it. The claim is released when that run ends
 * or when its start fails or is cancelled. A release only frees the key if it
 * still holds the claim it was given, so a stale release cannot free a key
 * someone else took.
 */

export type RunClaim = Readonly<{ key: string; token: symbol }>;

export class RunClaims {
  private readonly holders = new Map<string, symbol>();

  /** The claim for `key`, or null when another run already holds it. */
  claim(key: string): RunClaim | null {
    if (this.holders.has(key)) return null;
    const token = Symbol(key);
    this.holders.set(key, token);
    return { key, token };
  }

  /** Free the key, if this claim still holds it. A null claim (a run with no place) does nothing. */
  release(claim: RunClaim | null): void {
    if (claim !== null && this.holders.get(claim.key) === claim.token) this.holders.delete(claim.key);
  }

  holds(key: string): boolean {
    return this.holders.has(key);
  }
}

export const CHAT_BUSY = "This chat's previous run is still stopping. Try again in a moment.";
export const STUDIO_PLACE_BUSY = "Another chat is already working in this Roblox Studio place. Wait for it to finish, or choose a different place for this chat.";

/** What one run holds, from its start until it ends. */
export type RunHold = {
  /**
   * Hold the place a run with none was bound to once its start found one.
   * False, holding nothing more, when another run has that place.
   */
  holdPlace(instanceId: string): boolean;
  /** Let go of the chat and the place. Safe to call more than once. */
  release(): void;
};

/**
 * Every run's chat and Studio place, so the main process enforces one run per
 * chat and one writing run per place. It also counts the runs on each model
 * provider, so signing out of a provider can wait for them.
 */
export class RunHolds {
  private readonly chats = new RunClaims();
  private readonly places = new RunClaims();
  private readonly providers = new Map<string, number>();

  /**
   * Claim the chat and, when the run names one, its place. Nothing is held when
   * either is refused. The chat is checked first, so a run of this same chat
   * that is still stopping is reported as that, not as another chat. The
   * provider, when named, counts as in use until the hold is released.
   */
  begin(chatId: string, instanceId: string | null, provider?: string): { ok: true; hold: RunHold } | { ok: false; message: string } {
    const chat = this.chats.claim(chatId);
    if (chat === null) return { ok: false, message: CHAT_BUSY };
    let place: RunClaim | null = null;
    if (instanceId !== null) {
      place = this.places.claim(instanceId);
      if (place === null) {
        this.chats.release(chat);
        return { ok: false, message: STUDIO_PLACE_BUSY };
      }
    }
    if (provider !== undefined) this.providers.set(provider, (this.providers.get(provider) ?? 0) + 1);
    let released = false;
    const hold: RunHold = {
      holdPlace: (id) => {
        // A released hold takes nothing more, or the place would never be let go.
        if (released) return false;
        if (place !== null) return place.key === id;
        place = this.places.claim(id);
        return place !== null;
      },
      release: () => {
        if (!released && provider !== undefined) {
          const left = (this.providers.get(provider) ?? 1) - 1;
          if (left > 0) this.providers.set(provider, left);
          else this.providers.delete(provider);
        }
        released = true;
        this.chats.release(chat);
        this.places.release(place);
      },
    };
    return { ok: true, hold };
  }

  /** Whether a run is starting or working in the chat. */
  chatBusy(chatId: string): boolean {
    return this.chats.holds(chatId);
  }

  /** Whether a run is starting or working on the provider. */
  providerBusy(provider: string): boolean {
    return this.providers.has(provider);
  }
}
