export type SyncState = 'synced' | 'pending' | 'diverged';

/** Where one expected change stands in Studio: arrived, not yet, or something else is there. */
export type CheckState = 'done' | 'before' | 'other';

/**
 * Waits for Rojo to make a set of saved changes in Studio, reading every one
 * each round: synced once all have arrived. At the deadline it is diverged if
 * any shows something else instead, and pending otherwise; a set half
 * delivered is still only pending, since Rojo applies its changes in no set order.
 */
export async function waitForAll(
  readStates: () => Promise<CheckState[]>,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SyncState> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const states = await readStates().catch((): CheckState[] => []);
    if (states.length > 0 && states.every((state) => state === 'done')) return 'synced';
    if (now() >= deadline) return states.includes('other') ? 'diverged' : 'pending';
    await sleep(intervalMs);
  }
}

/**
 * Waits for Rojo to carry a saved file into Studio, by reading the script's
 * revision until it is the new one. A revision that is neither old nor new
 * means Studio changed on its own, which is reported rather than overwritten.
 */
export async function waitForStudio(
  readRevision: () => Promise<string | undefined>,
  previous: string,
  next: string,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SyncState> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const revision = await readRevision().catch(() => undefined);
    if (revision === next) return 'synced';
    if (revision !== undefined && revision !== previous) return 'diverged';
    if (now() >= deadline) return 'pending';
    await sleep(intervalMs);
  }
}
