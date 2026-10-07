import type { RunEvent } from "../shared/run-events";

/**
 * Getting the person back when a run stops to wait for them, or stops for good.
 *
 * A question or an approval pauses the run until it is answered, and the
 * person is usually somewhere else by then: in Studio, looking at what the run
 * just did. Inside the window the card says so; outside it, nothing did. So
 * while a run waits on a window that is not in front, its taskbar button
 * flashes and a system notification says what is being asked. Clicking the
 * notification only brings the window forward: the answer is still given there,
 * on the card, through the same checks as ever.
 *
 * A run that ends while the window is away is announced the same way, once:
 * a long build is exactly what someone leaves running and goes to Studio for,
 * and without this they found out it had finished, or failed, only by coming
 * back to look. The notice goes when they come back. A run the person stopped
 * is not announced; they know.
 *
 * Free of Electron so it can be tested; the window and the notifications are
 * handed in.
 */

export type AttentionNotice = { title: string; body: string };

/** A notification on screen, or in the system's list of them. */
export type ShownNotice = { close(): void };

export type AttentionSurface = {
  isFocused(): boolean;
  /** Start or stop flashing the window's taskbar button. */
  flash(on: boolean): void;
  /** Show a notification, or null when the system cannot. Clicking it calls `onClick`. */
  notify(notice: AttentionNotice, onClick: () => void): ShownNotice | null;
  /** Bring the window to the front. */
  bringForward(): void;
};

/** Enough for a sentence; a tool summary is not bounded, and a notification has no room for more. */
export const MAX_NOTICE_BODY_CHARS = 200;

const QUESTION_TITLE = "Roqer needs a decision";
const APPROVAL_TITLE = "Roqer needs your approval";

type RunCompleted = Extract<RunEvent, { type: "run-completed" }>;

export class RunAttention {
  /** What each run is waiting on, by run and call, with the notification shown for it. */
  private readonly waiting = new Map<string, { runId: string; notice: ShownNotice | null }>();
  /** The latest run that ended while the window was away, until the person comes back. */
  private ended: { notice: ShownNotice | null } | null = null;
  private flashing = false;

  constructor(private readonly surface: AttentionSurface) {}

  /** Every event of every run, as it is emitted. */
  observe(event: RunEvent): void {
    switch (event.type) {
      case "question-asked":
        this.wait(event.runId, event.question.callId, { title: QUESTION_TITLE, body: event.question.question });
        return;
      case "approval-requested":
        this.wait(event.runId, event.callId, { title: APPROVAL_TITLE, body: event.proposal.summary });
        return;
      case "question-answered":
      case "approval-resolved":
        this.settle(waitKey(event.runId, event.callId));
        return;
      case "run-completed":
        this.endRun(event.runId);
        this.announceEnd(event);
        return;
      default:
    }
  }

  /**
   * The window came to the front. The card is in view now, so the taskbar
   * stops asking; the notification of a decision stays listed until the
   * decision is made. A run's end has nothing left to decide, so its
   * notification goes now.
   */
  focused(): void {
    this.dismissEnded();
    this.setFlash(false);
  }

  /**
   * Forget everything a run was waiting on. A cancelled approval is never
   * resolved by an event of its own, so the run's end is what clears it.
   * Safe to call more than once.
   */
  endRun(runId: string): void {
    for (const [key, entry] of this.waiting) {
      if (entry.runId === runId) this.settle(key);
    }
  }

  /** Forget every run, as when the window closes. */
  clear(): void {
    this.dismissEnded();
    for (const key of [...this.waiting.keys()]) this.settle(key);
    this.setFlash(false);
  }

  private announceEnd(event: RunCompleted): void {
    if (event.outcome === "cancelled" || this.surface.isFocused()) return;
    // Only the latest end is worth a notice; an older one is out of date.
    this.dismissEnded();
    this.ended = { notice: this.surface.notify(boundedNotice(endNotice(event)), () => this.surface.bringForward()) };
    this.setFlash(true);
  }

  private dismissEnded(): void {
    this.ended?.notice?.close();
    this.ended = null;
  }

  private wait(runId: string, callId: string, notice: AttentionNotice): void {
    const key = waitKey(runId, callId);
    if (this.waiting.has(key)) return;
    // Someone looking at the window sees the card; telling them twice is noise.
    const away = !this.surface.isFocused();
    const shown = away ? this.surface.notify(boundedNotice(notice), () => this.surface.bringForward()) : null;
    this.waiting.set(key, { runId, notice: shown });
    if (away) this.setFlash(true);
  }

  private settle(key: string): void {
    const entry = this.waiting.get(key);
    if (entry === undefined) return;
    this.waiting.delete(key);
    entry.notice?.close();
    // An end not yet seen keeps the taskbar asking.
    if (this.waiting.size === 0 && this.ended === null) this.setFlash(false);
  }

  private setFlash(on: boolean): void {
    if (this.flashing === on) return;
    this.flashing = on;
    this.surface.flash(on);
  }
}

function waitKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

/**
 * What an ended run's notice says. "Finished" is claimed only as far as the
 * host's own check of the run allows: a run whose check found something says
 * so in the title, since the title may be all that is read.
 */
function endNotice(event: RunCompleted): AttentionNotice {
  const title = event.outcome === "completed"
    ? event.verification.verified ? "Roqer finished" : "Roqer finished, with something to check"
    : event.outcome === "refused" ? "Roqer stopped" : "Roqer could not finish";
  return { title, body: firstLine(event.summary) || "Open Roqer to see what it did." };
}

/** The summary's first line without its Markdown, which a notification shows as typed. */
function firstLine(markdown: string): string {
  const line = markdown.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry !== "") ?? "";
  return line.replace(/^(#{1,6}|[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim();
}

function boundedNotice(notice: AttentionNotice): AttentionNotice {
  const body = notice.body.trim();
  return {
    title: notice.title,
    body: body.length <= MAX_NOTICE_BODY_CHARS ? body : `${body.slice(0, MAX_NOTICE_BODY_CHARS - 1).trimEnd()}…`,
  };
}
