import { NO_LIMITS, type ProviderLimits, type UsageWindow } from "../shared/provider-limits";

/** What a provider reported, before Roqer stamps the time it heard it. */
export type LimitsReport = Readonly<{ windows: readonly UsageWindow[]; limitReached: boolean }>;

/**
 * The last usage a provider reported, read again at most once per interval.
 *
 * A failed or unreadable read keeps the previous report, which still carries
 * the time it was heard, so the interface can say how old it is; with no
 * report at all it is `none`. Nothing is estimated between reads.
 */
export class LimitsCache<Report extends LimitsReport> {
  private readonly fetch: () => Promise<Report | null>;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private report: (Report & { observedAt: number }) | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;
  private generation = 0;

  constructor(options: { fetch: () => Promise<Report | null>; intervalMs: number; now?: () => number }) {
    this.fetch = options.fetch;
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? Date.now;
  }

  /** The last report, as the contract the renderer receives. */
  async read(): Promise<ProviderLimits> {
    if (this.now() - this.lastAttemptAt >= this.intervalMs) {
      this.reading ??= this.refresh().finally(() => { this.reading = null; });
      await this.reading;
    }
    const report = this.report;
    if (report === null) return NO_LIMITS;
    return { kind: "reported", observedAt: report.observedAt, windows: report.windows, limitReached: report.limitReached };
  }

  /** The report as held, for a provider that pushes updates to compare against. */
  get latest(): Report | null {
    return this.report;
  }

  /** Take a report the provider pushed, heard now. */
  replace(report: Report): void {
    this.report = { ...report, observedAt: this.now() };
  }

  /** Drop what is known, because the account may have changed. */
  forget(): void {
    this.generation += 1;
    this.report = null;
    this.lastAttemptAt = Number.NEGATIVE_INFINITY;
  }

  private async refresh(): Promise<void> {
    const generation = this.generation;
    this.lastAttemptAt = this.now();
    let report: Report | null;
    try {
      report = await this.fetch();
    } catch {
      // Signed out, a client without the request, or the service is down.
      return;
    }
    // A read that began before `forget` belongs to the account that was forgotten.
    if (generation !== this.generation || report === null) return;
    this.replace(report);
  }
}
