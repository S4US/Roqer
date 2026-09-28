import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Camera, ChevronLeft, ChevronRight, Gamepad2, ImageIcon, Maximize2, Rotate3d, X } from "lucide-react";
import type { RunChange, RunEvidence } from "../shared/run-events";
import { ModelViewer } from "./model-viewer";
import {
  hasModelPreview, previewCaption, previewLayout, previewSource, previewSourceLabel, previewTileLabel, type PreviewTile,
} from "./preview-layout";
import { evidenceImages } from "./run-view";

/**
 * The pictures a run produced, in the answer: Studio screenshots and Blender
 * previews, in one card that reads like the Activity card above it.
 *
 * Every picture is a preview the host made from what a tool returned; nothing
 * here comes from the model. The newest one leads, the earlier ones sit beside
 * it, and any picture opens the viewer at itself.
 */
export const PreviewsCard = memo(function PreviewsCard({ evidence, changes }: {
  evidence: readonly RunEvidence[];
  changes: readonly RunChange[];
}) {
  const images = useMemo(() => evidenceImages(evidence), [evidence]);
  const layout = useMemo(() => previewLayout(images), [images]);
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
  const caption = previewCaption(latest, changes);
  const tile = (item: PreviewTile, role: "lead" | "rail" | "even") => (
    <PreviewTileButton key={item.evidence.id} tile={item} role={role} count={images.length} onOpen={show} />
  );
  return <section className="previews-card" aria-label="Previews">
    <div className="previews-header">
      <ImageIcon size={15} aria-hidden="true" />
      <strong>Previews</strong>
      <span>{images.length === 1 ? "1 image" : `${images.length} images`}</span>
      <button type="button" className="previews-open" aria-haspopup="dialog" onClick={(event) => show(images.length - 1, event.currentTarget)}>
        Open viewer<Maximize2 size={13} aria-hidden="true" />
      </button>
    </div>
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
        {images.length > 1 && <em>Latest of {images.length}</em>}
      </div>
    </div>
    {open !== null && <PreviewViewer images={images} changes={changes} index={open} onIndex={setOpen} onClose={close} />}
  </section>;
});

function SourceIcon({ evidence, size }: { evidence: RunEvidence; size: number }) {
  switch (previewSource(evidence)) {
    case "blender": return <Box size={size} aria-hidden="true" />;
    case "playtest": return <Gamepad2 size={size} aria-hidden="true" />;
    default: return <Camera size={size} aria-hidden="true" />;
  }
}

function PreviewTileButton({ tile, role, count, onOpen }: {
  tile: PreviewTile;
  role: "lead" | "rail" | "even";
  count: number;
  onOpen: (index: number, from: HTMLElement) => void;
}) {
  const source = previewSource(tile.evidence);
  return <button
    type="button"
    className="preview-tile"
    data-role={role}
    data-source={source}
    aria-label={previewTileLabel(tile, count)}
    aria-haspopup="dialog"
    onClick={(event) => onOpen(tile.index, event.currentTarget)}
  >
    <img src={tile.evidence.imageDataUrl} alt="" draggable={false} />
    {/* A tile that stands for several pictures is labelled by its count alone. */}
    {tile.hidden === undefined && <span className="preview-chip">
      <span className="preview-chip-index">{tile.index + 1}</span>
      <SourceIcon evidence={tile.evidence} size={role === "rail" ? 12 : 13} />
      <span>{previewSourceLabel(tile.evidence)}</span>
    </span>}
    {tile.hidden === undefined && hasModelPreview(tile.evidence) && <span className="preview-badge" aria-hidden="true">
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
function PreviewViewer({ images, changes, index, onIndex, onClose }: {
  images: readonly RunEvidence[];
  changes: readonly RunChange[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const current = images[Math.min(index, images.length - 1)];
  const atStart = index <= 0;
  const atEnd = index >= images.length - 1;
  const caption = previewCaption(current, changes);
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
        <span>{caption ?? (previewSource(current) !== "blender"
          ? previewSourceLabel(current)
          : inModel
            ? "The job's model in 3D, on Roblox's axes; not in the place yet"
            : "Rendered by Blender from the job's output; not in the place yet")}</span>
      </div>
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
          ? <ModelViewer key={current.id} evidence={current} onShowPicture={showPicture} />
          : <img src={current.imageDataUrl} alt={current.title} draggable={false} />}
      </div>
      {images.length > 1 && <button type="button" className="preview-viewer-step" onClick={() => onIndex(index + 1)} disabled={atEnd} aria-label="Next image"><ChevronRight size={20} /></button>}
    </div>
    {images.length > 1 && <div className="preview-viewer-strip">
      {images.map((item, position) => <button
        type="button"
        key={item.id}
        className="preview-viewer-thumb"
        data-source={previewSource(item)}
        aria-current={position === index ? "true" : undefined}
        aria-label={`Show image ${position + 1}, ${item.title}${hasModelPreview(item) ? ", with a 3D view" : ""}`}
        onClick={() => onIndex(position)}
      >
        <span>
          <img src={item.imageDataUrl} alt="" draggable={false} />
          {hasModelPreview(item) && <i className="preview-badge" aria-hidden="true"><Rotate3d size={10} />3D</i>}
        </span>
        <em>{position + 1} · {previewSourceLabel(item)}</em>
      </button>)}
    </div>}
  </div>, document.body);
}
