import type { RunChange, RunEvidence } from "../shared/run-events";
import { groupChangesByTarget, splitChangeGroup, type ChangeGroup } from "./diff-view";
import { previewVersions } from "./preview-layout";
import { evidenceImages } from "./run-view";

/**
 * What a run left behind, as one card with a tab for each kind.
 *
 * A run that models a sword, uploads six assets, edits three scripts and checks
 * an animation twice used to put a card on screen for every one of those: an
 * upload card per asset, an open diff per file, then a wall of pictures, and
 * only then the answer. Each card was reasonable on its own; together they
 * pushed the reply a few screens down and made the chat hard to scroll back
 * through. The results now share one card, one kind at a time, with every
 * count on the tabs so nothing is out of sight for being in another tab.
 *
 * The rules — which tabs exist, what each counts, which one opens, and which
 * one a live run follows — are pure and live here so they can be tested
 * without React.
 */

export type ResultsTab = "changes" | "uploads" | "previews";

export type ResultsTabInfo = {
  id: ResultsTab;
  /** Files changed, assets uploaded, or pictures shown. */
  count: number;
  /** Lines added and removed across the files, by each file's latest write. */
  added?: number;
  removed?: number;
};

export type RunResults = {
  /** Every change that is not an upload, one group per path, in event order. */
  files: ChangeGroup[];
  /** Every upload, one group per asset, in event order. */
  uploads: ChangeGroup[];
  /** The run's pictures, as the previews panel shows them. */
  pictures: number;
  tabs: ResultsTabInfo[];
};

/** Tabs in the order they read, left to right: what changed, what went up, what it looks like. */
const TAB_ORDER: readonly ResultsTab[] = ["changes", "uploads", "previews"];

export function runResults(changes: readonly RunChange[], evidence: readonly RunEvidence[]): RunResults {
  const files = groupChangesByTarget(changes.filter((change) => change.kind !== "asset"));
  const uploads = groupChangesByTarget(changes.filter((change) => change.kind === "asset"));
  const pictures = previewVersions(evidenceImages(evidence)).shown.length;

  let added = 0;
  let removed = 0;
  for (const group of files) {
    // Summing every write to a file would report more changed lines than the
    // file has; the latest write is the one that left it as it stands.
    const { latest } = splitChangeGroup(group);
    added += latest?.addedLines ?? 0;
    removed += latest?.removedLines ?? 0;
  }

  const counts: Record<ResultsTab, number> = { changes: files.length, uploads: uploads.length, previews: pictures };
  const tabs = TAB_ORDER.filter((id) => counts[id] > 0).map((id): ResultsTabInfo => (
    id === "changes" ? { id, count: counts[id], added, removed } : { id, count: counts[id] }
  ));
  return { files, uploads, pictures, tabs };
}

/**
 * The tab a finished run opens on: the pictures when there are any, since they
 * show what the run made; otherwise the code; otherwise the uploads.
 */
const OPENING_PRIORITY: readonly ResultsTab[] = ["previews", "changes", "uploads"];

export function openingTab(tabs: readonly ResultsTabInfo[]): ResultsTab | null {
  return OPENING_PRIORITY.find((id) => tabs.some((tab) => tab.id === id)) ?? null;
}

/**
 * The tab something just arrived in, for a live run that follows its newest
 * result until the reader picks a tab. Null when nothing arrived. When several
 * kinds arrive at once, the opening priority breaks the tie.
 */
export function arrivedTab(before: readonly ResultsTabInfo[], after: readonly ResultsTabInfo[]): ResultsTab | null {
  const countOf = (tabs: readonly ResultsTabInfo[], id: ResultsTab) => tabs.find((tab) => tab.id === id)?.count ?? 0;
  return OPENING_PRIORITY.find((id) => countOf(after, id) > countOf(before, id)) ?? null;
}

/** The tab on show: the reader's, else the one being followed, as long as it still exists. */
export function shownTab(tabs: readonly ResultsTabInfo[], picked: ResultsTab | null, following: ResultsTab | null): ResultsTab | null {
  const exists = (id: ResultsTab | null): id is ResultsTab => id !== null && tabs.some((tab) => tab.id === id);
  if (exists(picked)) return picked;
  if (exists(following)) return following;
  return openingTab(tabs);
}

export const TAB_NAME: Record<ResultsTab, { one: string; many: string; title: string }> = {
  changes: { one: "file", many: "files", title: "Changes" },
  uploads: { one: "upload", many: "uploads", title: "Uploads" },
  previews: { one: "image", many: "images", title: "Previews" },
};

/** The card's accessible summary, for a reader who cannot see the tabs: "3 files, 6 uploads, 5 images". */
export function resultsSummary(tabs: readonly ResultsTabInfo[]): string {
  return tabs.map((tab) => `${tab.count} ${tab.count === 1 ? TAB_NAME[tab.id].one : TAB_NAME[tab.id].many}`).join(", ");
}

export type ModerationTone = "approved" | "pending" | "rejected" | "unknown";

export type UploadEntry = {
  key: string;
  /** The display name the upload was given, else its type and id. */
  name: string;
  /** "Model", "Image", "Audio", "Animation"; "Asset" when Roblox did not say. */
  type: string;
  assetId?: string;
  assetUrl?: string;
  /** Moderation as Roblox reported it, made readable; absent when it did not. */
  moderation?: { label: string; tone: ModerationTone };
  /** How many times this run uploaded to the same asset. */
  writes: number;
};

/**
 * The host writes an upload's display name into its summary, quoted —
 * `Uploaded “Sword” to Roblox as asset 123.` — and nowhere else, so that is
 * where the tile reads it from. A summary without one falls back to the type.
 */
const QUOTED_NAME = /“([^”]{1,120})”/;

function moderationOf(state: string | undefined): UploadEntry["moderation"] {
  if (state === undefined || state.trim() === "") return undefined;
  const words = state.trim().replace(/^MODERATION_STATE_/i, "").replace(/[_-]+/g, " ").toLowerCase();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const tone: ModerationTone = /approved|accepted|cleared/.test(words)
    ? "approved"
    : /reject|denied|moderated|blocked|failed/.test(words)
      ? "rejected"
      : /review|pending|queued|progress/.test(words)
        ? "pending"
        : "unknown";
  return { label, tone };
}

export function uploadEntry(group: ChangeGroup): UploadEntry {
  const { latest } = splitChangeGroup(group);
  const change = latest ?? group.changes[0];
  const type = change.assetType?.trim() || "Asset";
  const name = QUOTED_NAME.exec(change.summary)?.[1]
    ?? (change.assetId ? `${type} ${change.assetId}` : change.summary);
  return {
    key: group.target,
    name,
    type,
    ...(change.assetId === undefined ? {} : { assetId: change.assetId }),
    ...(change.assetUrl === undefined ? {} : { assetUrl: change.assetUrl }),
    ...(moderationOf(change.moderationState) === undefined ? {} : { moderation: moderationOf(change.moderationState) }),
    writes: group.changes.length,
  };
}
