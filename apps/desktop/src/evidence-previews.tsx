import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Camera, ChevronLeft, ChevronRight, Gamepad2, ImageIcon, Maximize2, PersonStanding, Rotate3d, TriangleAlert, X } from "lucide-react";
import { MAX_RECORDED_EVIDENCE_IMAGES, type RunChange, type RunEvidence } from "../shared/run-events";
import { ModelViewer } from "./model-viewer";
import {
  animationRigCaption, hasModelPreview, pictureCategory, previewBoxesNote, previewCaption, previewLayout, previewSource, previewSourceLabel, previewTileLabel,
  previewVersions, type PictureCategory, type PreviewTile,
} from "./preview-layout";
import { evidenceImages, previewsNotShown } from "./run-view";
import { EvidencePicture } from "./evidence-picture";

/** Which version of each picture with several is on show, by the picture's id; absent means the latest. */
type VersionChoice = {
  versions: ReadonlyMap<string, readonly RunEvidence[]>;
  chosen: Readonly<Record<string, number>>;
  onChoose: (id: string, at: number) => void;
};

function versionAt(choice: VersionChoice, evidence: RunEvidence): { list: readonly RunEvidence[]; at: number } {
  const list = choice.versions.get(evidence.id) ?? [evidence];
  const at = Math.min(Math.max(choice.chosen[evidence.id] ?? list.length - 1, 0), list.length - 1);
  return { list, at };
}

/** The version of a picture on show. */
function onShow(choice: VersionChoice, evidence: RunEvidence): RunEvidence {
  const { list, at } = versionAt(choice, evidence);
  return list[at];
}

/**
 * One kind of the pictures a run produced, as a tab of the run's Results card:
 * its screenshots of Studio and playtests in the Screenshots tab, or its
 * Blender, rig and animation previews in the Previews tab.
 *
 * Every picture is a preview the host made from what a tool returned; nothing
 * here comes from the model. The newest one leads, the earlier ones sit beside
 * it, and any picture opens the viewer at itself. Previews of one animation are
 * one picture whose versions step back and forth, not a tile each.
 */
export const PreviewsPanel = memo(function PreviewsPanel({ category, evidence, changes, chosen, onChoose }: {
  /** Which of the run's pictures this panel shows: its screenshots or its previews. */
  category: PictureCategory;
  evidence: readonly RunEvidence[];
  changes: readonly RunChange[];
  /** The version on show of each picture with several; held by the Results card so it outlives this panel. */
  chosen: Readonly<Record<string, number>>;
  onChoose: (id: string, at: number) => void;
}) {
  const { shown: images, versions } = useMemo(
    () => previewVersions(evidenceImages(evidence).filter((item) => pictureCategory(item) === category)),
    [category, evidence],
  );
  const notShown = useMemo(() => previewsNotShown(evidence, category), [category, evidence]);
  const layout = useMemo(() => previewLayout(images), [images]);
  const choice = useMemo<VersionChoice>(() => ({ versions, chosen, onChoose }), [versions, chosen, onChoose]);
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const show = useCallback((index: number, from: HTMLElement) => {
    opener.current = from;
    setOpen(index);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    // Back to the tile that opened it, so the keyboard does not lose its place.
    opener.current?.focus();
  }, []);
  if (layout === null) return null;

  const latest = images[images.length - 1];
  const latestVersions = versions.get(latest.id);
  const caption = previewCaption(onShow(choice, latest), changes);
  const boxes = previewBoxesNote(onShow(choice, latest));
  const tile = (item: PreviewTile, role: "lead" | "rail" | "even") => (
    role === "lead" && playsInline(onShow(choice, item.evidence))
      ? <LiveAnimationTile key={item.evidence.id} tile={item} count={images.length} choice={choice} paused={open !== null} onOpen={show} />
      : <PreviewTileButton key={item.evidence.id} tile={item} role={role} count={images.length} choice={choice} onOpen={show} />
  );
  return <div className="previews-panel">
    <div className="previews-body">
      {layout.kind === "lead"
        ? <div className="preview-grid" data-rail={layout.rail.length}>
          {tile(layout.lead, "lead")}
          <div className="preview-rail">{layout.rail.map((item) => tile(item, "rail"))}</div>
        </div>
        : <div className="preview-grid" data-layout={layout.kind}>{layout.tiles.map((item) => tile(item, layout.kind === "single" ? "lead" : "even"))}</div>}
      <div className="preview-caption">
        <strong>{latest.title}</strong>
        {caption && <span>{caption}</span>}
        {boxes && <BoxesNote note={boxes} />}
        {latestVersions !== undefined && <VersionStepper evidence={latest} choice={choice} />}
        {images.length > 1 && <em>Latest of {images.length}</em>}
        {notShown > 0 && <em
          className="previews-not-kept"
          title={`A run keeps up to ${MAX_RECORDED_EVIDENCE_IMAGES} pictures: the latest of each thing first, then earlier versions. The rest are listed in Activity without their picture.`}
        >{notShown} earlier {notShown === 1 ? "picture" : "pictures"} not kept</em>}
        <button type="button" className="previews-open" aria-haspopup="dialog" onClick={(event) => show(images.length - 1, event.currentTarget)}>
          Open viewer<Maximize2 size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
    {open !== null && <PreviewViewer images={images} changes={changes} choice={choice} index={open} onIndex={setOpen} onClose={close} />}
  </div>;
});

/** That a preview drew some of the model's parts as boxes, not their meshes; the full reason on hover. */
function BoxesNote({ note }: { note: string }) {
  return <span className="preview-boxes" title={note}><TriangleAlert size={13} aria-hidden="true" /><span>{note}</span></span>;
}

function SourceIcon({ evidence, size }: { evidence: RunEvidence; size: number }) {
  switch (previewSource(evidence)) {
    case "blender": return <Box size={size} aria-hidden="true" />;
    case "animation":
    case "rig": return <PersonStanding size={size} aria-hidden="true" />;
    case "playtest": return <Gamepad2 size={size} aria-hidden="true" />;
    default: return <Camera size={size} aria-hidden="true" />;
  }
}

/**
 * Steps through a picture's versions, newest last: "Version 3 of 6". The card
 * and the viewer share the choice, so the viewer opens on the version the card
 * shows.
 */
function VersionStepper({ evidence, choice }: { evidence: RunEvidence; choice: VersionChoice }) {
  const { list, at } = versionAt(choice, evidence);
  return <span className="preview-versions" role="group" aria-label="Versions">
    <button type="button" onClick={() => choice.onChoose(evidence.id, at - 1)} disabled={at <= 0} aria-label="Earlier version">
      <ChevronLeft size={13} aria-hidden="true" />
    </button>
    <span aria-live="polite">Version {at + 1} of {list.length}</span>
    <button type="button" onClick={() => choice.onChoose(evidence.id, at + 1)} disabled={at >= list.length - 1} aria-label="Later version">
      <ChevronRight size={13} aria-hidden="true" />
    </button>
  </span>;
}

/** An animation leads the card as itself, playing, rather than as its contact sheet. */
function playsInline(evidence: RunEvidence): boolean {
  const source = previewSource(evidence);
  return (source === "animation" || source === "rig") && hasModelPreview(evidence);
}

/**
 * The card's lead animation, playing in the answer with its playback bar.
 *
 * Chromium keeps only a handful of WebGL contexts alive, so the 3D view is
 * mounted only while the tile is on screen and the full viewer is closed;
 * otherwise the tile shows the contact sheet. A long chat of animations thus
 * holds one or two live views at most.
 */
function LiveAnimationTile({ tile, count, choice, paused, onOpen }: {
  tile: PreviewTile;
  count: number;
  choice: VersionChoice;
  paused: boolean;
  onOpen: (index: number, from: HTMLElement) => void;
}) {
  const evidence = onShow(choice, tile.evidence);
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="preview-tile" data-role="lead" data-source={previewSource(evidence)} data-live="true" ref={host}>
    {visible && !paused
      ? <ModelViewer key={evidence.id} evidence={evidence} onShowPicture={() => undefined} compact />
      : <EvidencePicture evidence={evidence} />}
    <span className="preview-chip">
      <span className="preview-chip-index">{tile.index + 1}</span>
      <SourceIcon evidence={evidence} size={13} />
      <span>{previewSourceLabel(evidence)}</span>
    </span>
    <button
      type="button"
      className="preview-expand"
      aria-label={previewTileLabel(tile, count, versionAt(choice, tile.evidence).list.length)}
      aria-haspopup="dialog"
      onClick={(event) => onOpen(tile.index, event.currentTarget)}
    >
      <Maximize2 size={14} aria-hidden="true" />
    </button>
  </div>;
}

function PreviewTileButton({ tile, role, count, choice, onOpen }: {
  tile: PreviewTile;
  role: "lead" | "rail" | "even";
  count: number;
  choice: VersionChoice;
  onOpen: (index: number, from: HTMLElement) => void;
}) {
  const evidence = onShow(choice, tile.evidence);
  const versions = versionAt(choice, tile.evidence).list.length;
  const source = previewSource(evidence);
  return <button
    type="button"
    className="preview-tile"
    data-role={role}
    data-source={source}
    aria-label={previewTileLabel(tile, count, versions)}
    aria-haspopup="dialog"
    onClick={(event) => onOpen(tile.index, event.currentTarget)}
  >
    <EvidencePicture evidence={evidence} />
    {/* A tile that stands for several pictures is labelled by its count alone. */}
    {tile.hidden === undefined && <span className="preview-chip">
      <span className="preview-chip-index">{tile.index + 1}</span>
      <SourceIcon evidence={evidence} size={role === "rail" ? 12 : 13} />
      <span>{previewSourceLabel(evidence)}{versions > 1 && ` · ${versions} versions`}</span>
    </span>}
    {tile.hidden === undefined && hasModelPreview(evidence) && <span className="preview-badge" aria-hidden="true">
      <Rotate3d size={role === "rail" ? 11 : 12} />3D
    </span>}
    {role === "lead" && <span className="preview-expand" aria-hidden="true"><Maximize2 size={14} /></span>}
    {tile.hidden !== undefined && <span className="preview-more" aria-hidden="true">+{tile.hidden}</span>}
  </button>;
}

/**
 * Every picture of the run, one at a time, over the whole window.
 *
 * Rendered into the document body, because a message is a containing block for
 * fixed positioning. Escape closes it and the arrow keys move through it; the
 * tile that opened it gets the focus back. A Blender result whose model has a
 * 3D preview opens in 3D, and the picture is one switch away.
 */
function PreviewViewer({ images, changes, choice, index, onIndex, onClose }: {
  images: readonly RunEvidence[];
  changes: readonly RunChange[];
  choice: VersionChoice;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const picture = images[Math.min(index, images.length - 1)];
  const current = onShow(choice, picture);
  const atStart = index <= 0;
  const atEnd = index >= images.length - 1;
  const caption = previewCaption(current, changes);
  const boxes = previewBoxesNote(current);
  // The picture the reader switched to the still for; any other opens in 3D.
  const [pictureAt, setPictureAt] = useState<number | null>(null);
  const pictureButton = useRef<HTMLButtonElement>(null);
  const model = hasModelPreview(current);
  const inModel = model && pictureAt !== index;
  const showPicture = useCallback(() => {
    setPictureAt(index);
    pictureButton.current?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onIndex(index - 1);
      } else if (event.key === "ArrowRight" && index < images.length - 1) {
        event.preventDefault();
        onIndex(index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, index, onClose, onIndex]);

  return createPortal(<div className="preview-viewer" role="dialog" aria-modal="true" aria-label={`${current.title}, image ${index + 1} of ${images.length}`}>
    <div className="preview-viewer-bar">
      <span className="preview-viewer-count">{index + 1} of {images.length}</span>
      <div className="preview-viewer-title">
        <strong><SourceIcon evidence={current} size={15} />{current.title}</strong>
        <span>{caption ?? (previewSource(current) === "animation"
          ? inModel
            ? `The animation on ${animationRigCaption(current)}, as checked`
            : "Moments of the animation, from two views"
          : previewSource(current) === "rig"
            ? inModel
              ? `Every joint of ${animationRigCaption(current)} turning a little each way; no check judged it`
              : "Every joint at rest and turned each way, from two views"
          : previewSource(current) !== "blender"
            ? previewSourceLabel(current)
            : inModel
              ? "The job's model in 3D, on Roblox's axes; not in the place yet"
              : "Rendered by Blender from the job's output; not in the place yet")}</span>
        {boxes && <BoxesNote note={boxes} />}
      </div>
      {choice.versions.has(picture.id) && <VersionStepper evidence={picture} choice={choice} />}
      {model && <div className="preview-viewer-mode" role="group" aria-label="Show as">
        <button type="button" aria-pressed={inModel} onClick={() => setPictureAt(null)}><Rotate3d size={14} aria-hidden="true" />3D</button>
        <button type="button" aria-pressed={!inModel} onClick={showPicture} ref={pictureButton}><ImageIcon size={14} aria-hidden="true" />Picture</button>
      </div>}
      <p className="preview-viewer-keys" aria-hidden="true">
        {images.length > 1 && <><kbd>←</kbd><kbd>→</kbd> to move · </>}<kbd>Esc</kbd> to close
      </p>
      <button type="button" className="preview-viewer-close" onClick={onClose} aria-label="Close the viewer" autoFocus><X size={20} /></button>
    </div>
    <div className="preview-viewer-stage">
      {images.length > 1 && <button type="button" className="preview-viewer-step" onClick={() => onIndex(index - 1)} disabled={atStart} aria-label="Previous image"><ChevronLeft size={20} /></button>}
      <div className="preview-viewer-frame" data-view={inModel ? "model" : "picture"}>
        {inModel
          ? <ModelViewer key={current.id} evidence={current} onShowPicture={showPicture} autoplay />
          : <EvidencePicture evidence={current} alt={current.title} />}
      </div>
      {images.length > 1 && <button type="button" className="preview-viewer-step" onClick={() => onIndex(index + 1)} disabled={atEnd} aria-label="Next image"><ChevronRight size={20} /></button>}
    </div>
    {images.length > 1 && <div className="preview-viewer-strip">
      {images.map((picture, position) => {
        const item = onShow(choice, picture);
        return <button
          type="button"
          key={picture.id}
          className="preview-viewer-thumb"
          data-source={previewSource(item)}
          aria-current={position === index ? "true" : undefined}
          aria-label={`Show image ${position + 1}, ${item.title}${hasModelPreview(item) ? ", with a 3D view" : ""}`}
          onClick={() => onIndex(position)}
        >
          <span>
            <EvidencePicture evidence={item} />
            {hasModelPreview(item) && <i className="preview-badge" aria-hidden="true"><Rotate3d size={10} />3D</i>}
          </span>
          <em>{position + 1} · {previewSourceLabel(item)}</em>
        </button>;
      })}
    </div>}
  </div>, document.body);
}
