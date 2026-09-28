import {
  BLENDER_PREVIEW_TITLE, SCREENSHOT_VIEW_LABEL, SCREENSHOT_VIEW_PLAYTEST,
  type RunChange, type RunEvidence,
} from "../shared/run-events";

/**
 * How the previews card lays out a run's pictures.
 *
 * Pure, so the arrangement for every count is tested without React. The newest
 * picture leads, because it shows where the run ended, which is what the answer
 * describes; the earlier ones sit beside it, oldest first.
 */

export type PreviewSource = "studio" | "playtest" | "blender" | "other";

export type PreviewTile = {
  /** Position in the run's pictures, oldest first; the viewer opens here. */
  index: number;
  evidence: RunEvidence;
  /** Set on the last rail tile when more pictures than fit are hidden behind it. */
  hidden?: number;
};

export type PreviewLayout =
  | { kind: "single"; tiles: [PreviewTile] }
  | { kind: "pair"; tiles: [PreviewTile, PreviewTile] }
  | { kind: "lead"; lead: PreviewTile; rail: PreviewTile[] };

/** Beside the lead there is room for three; past that the last one says how many more. */
const RAIL_SLOTS = 3;

export function previewLayout(images: readonly RunEvidence[]): PreviewLayout | null {
  const tiles = images.map((evidence, index): PreviewTile => ({ index, evidence }));
  if (tiles.length === 0) return null;
  if (tiles.length === 1) return { kind: "single", tiles: [tiles[0]] };
  if (tiles.length === 2) return { kind: "pair", tiles: [tiles[0], tiles[1]] };
  const lead = tiles[tiles.length - 1];
  const earlier = tiles.slice(0, -1);
  if (earlier.length <= RAIL_SLOTS) return { kind: "lead", lead, rail: earlier };
  const rail = earlier.slice(0, RAIL_SLOTS);
  rail[RAIL_SLOTS - 1] = { ...rail[RAIL_SLOTS - 1], hidden: earlier.length - (RAIL_SLOTS - 1) };
  return { kind: "lead", lead, rail };
}

/** Where a picture came from, as the host recorded it. */
export function previewSource(evidence: RunEvidence): PreviewSource {
  if (evidence.title === BLENDER_PREVIEW_TITLE) return "blender";
  if (evidence.kind !== "screenshot") return "other";
  const view = evidence.metadata?.find((entry) => entry.label === SCREENSHOT_VIEW_LABEL)?.value;
  return view === SCREENSHOT_VIEW_PLAYTEST ? "playtest" : "studio";
}

/** The short label on a tile. */
export function previewSourceLabel(evidence: RunEvidence): string {
  switch (previewSource(evidence)) {
    case "blender": return "Blender · before upload";
    case "playtest": return "Playtest";
    case "studio": return "Studio";
    default: return evidence.title;
  }
}

/** A readable name for what a change touched: no `game.` prefix, and at most the last two parts of a long path. */
export function shortTarget(target: string): string {
  const path = target.startsWith("game.") ? target.slice("game.".length) : target;
  if (path.length <= 48) return path;
  const parts = path.split(".");
  return parts.length > 2 ? `…${parts.slice(-2).join(".")}` : `…${path.slice(-46)}`;
}

/** What a change did, as a phrase: "building Workspace.Handcart". */
function changePhrase(change: RunChange): string {
  switch (change.kind) {
    case "script-source": return `editing ${shortTarget(change.target)}`;
    case "properties": return `setting properties on ${shortTarget(change.target)}`;
    case "instance": return `building ${shortTarget(change.target)}`;
    case "asset": return change.assetId ? `uploading asset ${change.assetId}` : "an upload";
  }
}

/**
 * When a picture was taken, from what the host recorded: during this run's
 * playtest, and after which change. Undefined when there is nothing to say.
 */
export function previewCaption(evidence: RunEvidence, changes: readonly RunChange[]): string | undefined {
  const parts: string[] = [];
  if (previewSource(evidence) === "playtest") parts.push("during the playtest");
  const change = evidence.afterChangeId === undefined
    ? undefined
    : changes.find((item) => item.id === evidence.afterChangeId);
  if (change !== undefined) parts.push(`after ${changePhrase(change)}`);
  return parts.length === 0 ? undefined : `Taken ${parts.join(", ")}`;
}

/** Whether a picture also opens in 3D: a Blender result whose model the host kept a preview of. */
export function hasModelPreview(evidence: RunEvidence): boolean {
  return evidence.modelPreviewId !== undefined && previewSource(evidence) === "blender";
}

/** The accessible name of a tile. */
export function previewTileLabel(tile: PreviewTile, count: number): string {
  const what = tile.hidden !== undefined
    ? `and ${tile.hidden - 1} more`
    : hasModelPreview(tile.evidence) ? "with a 3D view" : "";
  return `Open image ${tile.index + 1} of ${count}, ${tile.evidence.title}${what ? `, ${what}` : ""}`;
}
