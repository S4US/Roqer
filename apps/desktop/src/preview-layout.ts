import {
  ANIMATION_NAME_LABEL, ANIMATION_PREVIEW_TITLE, ANIMATION_RIG_LABEL, BLENDER_MODEL_LABEL, BLENDER_PREVIEW_TITLE, RIG_RANGE_SHEET_TITLE, SCREENSHOT_VIEW_LABEL,
  SCREENSHOT_VIEW_PLAYTEST, type RunChange, type RunEvidence,
} from "../shared/run-events";

/**
 * How the previews card lays out a run's pictures.
 *
 * Pure, so the arrangement for every count is tested without React. The newest
 * picture leads, because it shows where the run ended, which is what the answer
 * describes; the earlier ones sit beside it, oldest first.
 */

export type PreviewSource = "studio" | "playtest" | "blender" | "animation" | "rig" | "other";

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

export type PreviewVersions = {
  /** One picture for each thing shown, in the order the latest of each was taken. */
  shown: RunEvidence[];
  /** Every version of a shown picture that has more than one, oldest first, by the shown picture's id. */
  versions: ReadonlyMap<string, readonly RunEvidence[]>;
};

/**
 * What a picture is of, so every picture of one thing is a version of it: the
 * subject the host recorded (a Blender model by the job lineage it was built
 * in), else an animation by its name, else a Blender model by the file it was
 * written to. An agent revising a wave or a sword checks it again and again,
 * and each check is the same thing, newer. Anything else — a screenshot, a
 * render, a preview recorded before models were named — is a thing of its own.
 */
export function previewSubject(evidence: RunEvidence): string {
  const source = previewSource(evidence);
  // The host's own word on what the picture is of wins; the names below are
  // for runs saved before it gave one.
  if (evidence.subject !== undefined) return `${source}:subject:${evidence.subject}`;
  const label = source === "animation" ? ANIMATION_NAME_LABEL : source === "blender" ? BLENDER_MODEL_LABEL : source === "rig" ? ANIMATION_RIG_LABEL : undefined;
  const name = label === undefined ? undefined : evidence.metadata?.find((entry) => entry.label === label)?.value;
  return name === undefined ? `picture:${evidence.id}` : `${source}:${name}`;
}

/**
 * The run's pictures as the card shows them: one per thing pictured, sitting
 * where its latest version was taken and showing that version, with the
 * earlier versions a step away.
 */
export function previewVersions(images: readonly RunEvidence[]): PreviewVersions {
  const groups = new Map<string, RunEvidence[]>();
  const last = new Map<string, number>();
  images.forEach((evidence, index) => {
    const key = previewSubject(evidence);
    groups.set(key, [...(groups.get(key) ?? []), evidence]);
    last.set(key, index);
  });
  const ordered = [...groups.entries()].sort(([a], [b]) => last.get(a)! - last.get(b)!).map(([, group]) => group);
  return {
    shown: ordered.map((group) => group[group.length - 1]),
    versions: new Map(ordered.filter((group) => group.length > 1).map((group) => [group[group.length - 1].id, group])),
  };
}

/**
 * Which of a run's pictures it shows and keeps, when it took more than `max`.
 *
 * The budget goes to distinct things first: the latest picture of each thing,
 * newest thing first. Only what is left goes to earlier versions, newest first.
 * So revisions of one model never push a different model or screenshot out,
 * and the pictures a run ended on are always among those kept. Returns the ids
 * kept.
 */
export function keptPreviewIds(images: readonly RunEvidence[], max: number): Set<string> {
  const latest = new Map<string, number>();
  images.forEach((evidence, index) => latest.set(previewSubject(evidence), index));
  const newestFirst = images.map((evidence, index) => ({ evidence, index })).reverse();
  const isLatest = ({ evidence, index }: { evidence: RunEvidence; index: number }) => latest.get(previewSubject(evidence)) === index;
  return new Set([...newestFirst.filter(isLatest), ...newestFirst.filter((entry) => !isLatest(entry))]
    .slice(0, Math.max(0, max))
    .map(({ evidence }) => evidence.id));
}

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
  if (evidence.title === ANIMATION_PREVIEW_TITLE) return "animation";
  if (evidence.title === RIG_RANGE_SHEET_TITLE) return "rig";
  if (evidence.kind !== "screenshot") return "other";
  const view = evidence.metadata?.find((entry) => entry.label === SCREENSHOT_VIEW_LABEL)?.value;
  return view === SCREENSHOT_VIEW_PLAYTEST ? "playtest" : "studio";
}

/**
 * The rig an animation's preview was drawn on, as a label says it: R15, R6, or
 * the model whose own rig it is, by its name. Undefined for a preview recorded
 * before the rig was.
 */
export function animationRig(evidence: RunEvidence): string | undefined {
  const rig = evidence.metadata?.find((entry) => entry.label === ANIMATION_RIG_LABEL)?.value;
  if (rig === undefined || rig === "") return undefined;
  return rig === "R15" || rig === "R6" ? rig : rig.split(".").pop() || rig;
}

/** The rig an animation's 3D preview plays on, as its caption says it. */
export function animationRigCaption(evidence: RunEvidence): string {
  const rig = animationRig(evidence);
  if (rig === undefined) return "its rig";
  return rig === "R15" || rig === "R6" ? `the ${rig} rig` : `${rig}'s own rig`;
}

/** The short label on a tile. */
export function previewSourceLabel(evidence: RunEvidence): string {
  switch (previewSource(evidence)) {
    case "blender": return "Blender · before upload";
    case "animation": {
      const rig = animationRig(evidence);
      return rig === undefined ? "Animation" : `Animation · ${rig}`;
    }
    case "rig": {
      const rig = animationRig(evidence);
      return rig === undefined ? "Range sheet" : `Range sheet · ${rig}`;
    }
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

/**
 * Whether a picture also opens in 3D: a Blender result, or an animation's
 * contact sheet, whose model the host kept a preview of.
 */
export function hasModelPreview(evidence: RunEvidence): boolean {
  const source = previewSource(evidence);
  return evidence.modelPreviewId !== undefined && (source === "blender" || source === "animation");
}

/** The accessible name of a tile. */
export function previewTileLabel(tile: PreviewTile, count: number, versions = 1): string {
  const what = tile.hidden !== undefined
    ? [`and ${tile.hidden - 1} more`]
    : [...(versions > 1 ? [`${versions} versions`] : []), ...(hasModelPreview(tile.evidence) ? ["with a 3D view"] : [])];
  return `Open image ${tile.index + 1} of ${count}, ${[tile.evidence.title, ...what].join(", ")}`;
}
