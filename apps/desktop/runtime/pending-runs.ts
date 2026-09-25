/** Owns cancellation before a RunSession exists, including a closing window. */
export class PendingRuns {
  private readonly entries = new Map<number, Map<string, AbortController>>();

  begin(owner: number, id: string): { signal: AbortSignal; finish(): void } {
    const entries = this.entries.get(owner) ?? new Map<string, AbortController>();
    if (entries.has(id)) throw new Error("This run is already starting.");
    const controller = new AbortController();
    entries.set(id, controller);
    this.entries.set(owner, entries);
    return {
      signal: controller.signal,
      finish: () => {
        if (entries.get(id) === controller) entries.delete(id);
        if (entries.size === 0 && this.entries.get(owner) === entries) this.entries.delete(owner);
      },
    };
  }

  cancel(owner: number, id: string): void {
    this.entries.get(owner)?.get(id)?.abort();
  }

  cancelOwner(owner: number): void {
    for (const controller of this.entries.get(owner)?.values() ?? []) controller.abort();
    this.entries.delete(owner);
  }

  cancelAll(): void {
    for (const owner of this.entries.keys()) this.cancelOwner(owner);
  }
}
