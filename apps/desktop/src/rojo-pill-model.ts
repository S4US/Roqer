import type { RojoPillStateKind, RojoResult, RojoView } from "../shared/rojo";

/**
 * View -> display logic for the Rojo pill, kept out of `rojo-pill.tsx` so it
 * is tested without rendering anything.
 *
 * The pill is always shown, even with nothing Rojo-related to say, so its own
 * users can find it; a quiet "no place" or "not linked" pill is itself the
 * answer to "is this place linked?". The table here mirrors the design spec's
 * §4.1 exactly, in the state `rojoPillState` (in `shared/rojo.ts`) already
 * picked -- this module only turns that state, plus the fields the view
 * carries for it, into the pill's label and colour.
 */

/** The pill's colour, as the state table assigns it; CSS reads this off a `state-<kind>` class rather than a prop. */
export type RojoPillDot = "none" | "accent" | "green" | "amber" | "red";

export type RojoPillVisual = Readonly<{
  label: string;
  dot: RojoPillDot;
  /** Only the `detected` row is dashed, inviting a click the way an empty state does. */
  dashed: boolean;
  /** `no-place` and `not-linked` read as quiet background facts, not something asking for attention. */
  muted: boolean;
}>;

/** Longest a short problem gets before a popover (not this pill) is the only place to read the rest. */
const MAX_PILL_MESSAGE_CHARS = 40;

/** A one-sentence failure, trimmed to what the pill itself has room for. */
export function shortRojoMessage(message: string | undefined): string {
  const text = (message ?? "").trim();
  if (text === "") return "a problem";
  return text.length > MAX_PILL_MESSAGE_CHARS ? `${text.slice(0, MAX_PILL_MESSAGE_CHARS - 1).trimEnd()}…` : text;
}

const PROJECT_FILE_FALLBACK = "a project";

export function rojoPillVisual(view: RojoView): RojoPillVisual {
  switch (view.state) {
    case "no-place":
      return { label: "Rojo · no place", dot: "none", dashed: false, muted: true };
    case "not-linked":
      return { label: "Rojo · not linked", dot: "none", dashed: false, muted: true };
    case "detected":
      return { label: "Link Rojo project", dot: "accent", dashed: true, muted: false };
    case "linked-running":
      return { label: `Rojo · ${view.project?.fileName ?? PROJECT_FILE_FALLBACK}`, dot: "green", dashed: false, muted: false };
    case "linked-stopped":
      return { label: "Rojo not running", dot: "amber", dashed: false, muted: false };
    case "error":
      return { label: `Rojo · ${shortRojoMessage(view.message)}`, dot: "red", dashed: false, muted: false };
  }
}

/** Whether a state's popover offers any action at all: `no-place` has nothing to act on. */
export function rojoPillActionable(state: RojoPillStateKind): boolean {
  return state !== "no-place";
}

/** Whether a state's popover is the "linked" layout (project + Open folder/Change/Unlink). */
export function rojoPillLinked(state: RojoPillStateKind): boolean {
  return state === "linked-running" || state === "linked-stopped";
}

/**
 * The popover's note once linked, naming the place the way the approved
 * mockup does ("Linked to Creator Empire · relinks automatically"): a
 * published place relinks after a restart, an unpublished one only lasts the
 * Studio session. `placeName` is display-only and comes from the renderer's
 * own Studio connection state (`RojoView` carries no place name), so a
 * missing one falls back to "this place" rather than leaving a blank.
 */
export function rojoLinkedNote(published: boolean, placeName?: string): string {
  const place = placeName ?? "this place";
  return published
    ? `Linked to ${place} · relinks automatically after a restart.`
    : `Linked to ${place} · until this Studio session closes.`;
}

/**
 * The view to show while nothing has loaded yet, or when the desktop runtime
 * is unavailable -- the same `no-place` pill a disconnected app shows, since
 * there is equally nothing to act on.
 */
export const EMPTY_ROJO_VIEW: RojoView = { instanceId: null, published: false, state: "no-place", recent: [] };

/**
 * The view to render from a `RojoResult`. Every call the pill makes resolves
 * a view on success, and `RojoConnection` attaches one to most failures too
 * (e.g. a failed "Change project..." keeps the still-working link's own
 * view, per item 3 -- not an `error` state); a result with neither is a
 * refusal that never reached a real instance (an untrusted sender, a stale
 * id), which the normal UI flow should not produce, so it falls back to an
 * `error` view carrying that message rather than silently keeping the old one.
 *
 * A failure's own message is never dropped just because a view came with
 * it: it is laid onto the kept view, so the popover can still say what went
 * wrong even while it keeps showing the link that is still actually working.
 */
export function viewFromResult(result: RojoResult, instanceId: string | null): RojoView {
  if (result.view !== undefined) return result.ok ? result.view : { ...result.view, message: result.message };
  return { instanceId, published: false, state: "error", recent: [], message: result.ok ? undefined : result.message };
}

/**
 * The view `rojo-pill.tsx`'s `apply` falls back to when the IPC call itself
 * rejects -- not a normal `{ ok: false }` result, but a thrown error (a
 * dropped renderer/main channel, for instance). Kept here, pure, so the
 * fallback is tested without rendering anything, the same reason the rest of
 * this module exists.
 */
export function errorViewFromRejection(error: unknown, instanceId: string | null): RojoView {
  const message = error instanceof Error ? error.message : "Rojo could not complete that request.";
  return { instanceId, published: false, state: "error", recent: [], message };
}
