import { nativeImage, type NativeImage } from "electron";
import {
  MAX_TURN_IMAGE_BASE64,
  type TurnImageMediaType,
} from "../runtime/model-api/turn-contract";

import { imageAsAttached, MAX_ATTACHED_IMAGE_EDGE, type EncodedImage, type ImageEncoder } from "../runtime/attachment-context";
import type { AnalysisFrame, CropBox } from "../runtime/clip-analysis";
import type { McpToolImage } from "../runtime/mcp-types";
import type { ClipSheetComposer } from "../runtime/reference-clip";
import { drawLabel, labelScale } from "../runtime/sheet-labels";
import { isEvidenceImage } from "../shared/run-events";
import { MAX_ATTACHMENT_THUMBNAIL_CHARACTERS } from "../shared/workspace-validation";

/**
 * Prepare an attached picture for a model turn.
 *
 * Two jobs, both native: shrink a screenshot to something worth sending, and
 * make the small preview the chat keeps afterwards. This lives beside the other
 * Electron integration rather than in `runtime/` because `nativeImage` is the
 * one decoder available without adding an image library, and `runtime/` is
 * meant to stay testable without importing Electron.
 */

/** Progressively smaller retries for an image that will not fit at full size. */
const FALLBACK_EDGES = [1024, 768];

/** JPEG qualities tried, best first, when a lossless encoding is too large. */
const JPEG_QUALITIES = [82, 62, 45];

const THUMBNAIL_EDGE = 320;
const THUMBNAIL_QUALITIES = [70, 50];

/**
 * Evidence previews are shown in the answer and opened larger on click, so they
 * are kept at twice an attachment thumbnail's size, then smaller if they must.
 */
const EVIDENCE_PREVIEW_EDGES = [640, 480];
const EVIDENCE_PREVIEW_QUALITIES = [72, 55, 40];

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function fits(buffer: Buffer): boolean {
  return base64Length(buffer.byteLength) <= MAX_TURN_IMAGE_BASE64;
}

/** Scale to a long edge, preserving aspect ratio. Never scales up. */
function scaled(image: NativeImage, edge: number): NativeImage {
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest <= edge || longest === 0) return image;
  return size.width >= size.height
    ? image.resize({ width: edge, quality: "good" })
    : image.resize({ height: edge, quality: "good" });
}

/**
 * The smallest faithful encoding that fits.
 *
 * PNG is tried first for a source that was already lossless, because a
 * screenshot of text stays sharp that way; JPEG is the fallback rather than the
 * default so that a picture is only degraded when it has to be.
 */
function encodeWithin(
  image: NativeImage,
  lossless: boolean,
): Readonly<{ mediaType: TurnImageMediaType; buffer: Buffer }> | undefined {
  if (lossless) {
    const png = image.toPNG();
    if (png.byteLength > 0 && fits(png)) return { mediaType: "image/png", buffer: png };
  }
  for (const quality of JPEG_QUALITIES) {
    const jpeg = image.toJPEG(quality);
    if (jpeg.byteLength > 0 && fits(jpeg)) return { mediaType: "image/jpeg", buffer: jpeg };
  }
  return undefined;
}

function thumbnail(image: NativeImage): string | undefined {
  const preview = scaled(image, THUMBNAIL_EDGE);
  for (const quality of THUMBNAIL_QUALITIES) {
    const jpeg = preview.toJPEG(quality);
    if (jpeg.byteLength === 0) continue;
    const url = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    if (url.length <= MAX_ATTACHMENT_THUMBNAIL_CHARACTERS) return url;
  }
  return undefined;
}

/**
 * Encode an attached image, downscaling until it fits the wire contract. A
 * PNG or JPEG that already fits goes as it was attached (`imageAsAttached`).
 *
 * A format `nativeImage` cannot decode — WebP and GIF, which it does not read
 * from a buffer — is passed through untouched when it already fits, since the
 * provider decodes it perfectly well. Only a picture that neither decodes here
 * nor fits as it stands is refused, and then with a reason the user can act on.
 */
export const encodeAttachmentImage: ImageEncoder = async ({ bytes, mediaType, name }): Promise<EncodedImage> => {
  const source = nativeImage.createFromBuffer(bytes);
  if (source.isEmpty()) {
    const data = bytes.toString("base64");
    if (data.length <= MAX_TURN_IMAGE_BASE64) return { mediaType, data };
    throw new Error(`“${name}” could not be resized here. Save it as a PNG or JPEG and attach it again.`);
  }

  const preview = thumbnail(source);
  const withPreview = (image: EncodedImage): EncodedImage => preview === undefined ? image : { ...image, thumbnailDataUrl: preview };
  const attached = imageAsAttached(bytes, source.getSize());
  if (attached !== undefined) return withPreview(attached);

  const lossless = mediaType !== "image/jpeg";
  for (const edge of [MAX_ATTACHED_IMAGE_EDGE, ...FALLBACK_EDGES]) {
    const candidate = scaled(source, edge);
    const encoded = encodeWithin(candidate, lossless);
    if (encoded === undefined) continue;
    return withPreview({ mediaType: encoded.mediaType, data: encoded.buffer.toString("base64") });
  }
  throw new Error(`“${name}” could not be made small enough to send.`);
};

/**
 * The largest image Claude Code passes a model unchanged: 2000 x 2000 for
 * Opus 5.5, read from its model table. A sheet is drawn as wide as a frame
 * sent alone would reach the model (a 2246-pixel frame arrives at 2000), so
 * with two frames to a row each shows at half that width, and a sheet of up to
 * eight frames costs about what two frames sent alone do.
 */
const CONTACT_SHEET_WIDTH = 2000;
const CONTACT_SHEET_MAX_HEIGHT = 2000;
/**
 * Qualities tried, best first. Claude Code re-encodes an image over 512,000
 * bytes at a quality of its own choosing, so a sheet is kept under that.
 */
const CONTACT_SHEET_QUALITIES = [85, 78, 70, 62];
const CONTACT_SHEET_MAX_BYTES = 500_000;

/**
 * What a sheet may add to its frames: a crop for each, a label drawn in each
 * tile's corner, and `wide`, for tiles as wide as the sheet allows rather than
 * a sheet as wide as one frame. A cropped frame is narrow, and in a sheet only
 * as wide as itself its tiles would be too small to read.
 */
export type ContactSheetOptions = Readonly<{
  crops?: readonly (CropBox | undefined)[];
  labels?: readonly string[];
  wide?: boolean;
}>;

/** The part of a frame a crop box names, in whole pixels, or the frame when there is none. */
function cropped(frame: NativeImage, crop: CropBox | undefined): NativeImage {
  if (crop === undefined) return frame;
  const { width, height } = frame.getSize();
  const x = Math.max(0, Math.min(width - 1, Math.round(crop.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(crop.y * height)));
  const rect = {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(crop.width * width))),
    height: Math.max(1, Math.min(height - y, Math.round(crop.height * height))),
  };
  return frame.crop(rect);
}

/**
 * Several frames as one image, `columns` to a row, left to right and top to
 * bottom, each scaled to its tile. A model reads an image at a cost set by its
 * pixels, and every image stays in the conversation for the rest of the run,
 * so eight full-size frames cost about four times one sheet of them. Each
 * frame shows at half the width it would have alone; the caller offers full
 * frames for when that detail matters. Undefined when a frame does not decode
 * here, or the sheet cannot be kept small enough; the caller then sends the
 * frames as they are.
 *
 * A frame may be cropped first (a reference clip, to where its effect is), and
 * a tile may carry a label in its top-left corner: its number and time, so the
 * model reads which frame it is looking at rather than counting tiles.
 */
export async function composeContactSheet(images: readonly McpToolImage[], columns: number, options: ContactSheetOptions = {}): Promise<McpToolImage | undefined> {
  const decoded = images.map((image) => nativeImage.createFromBuffer(Buffer.from(image.data, "base64")));
  if (decoded.length === 0 || decoded.some((frame) => frame.isEmpty())) return undefined;
  const frames = decoded.map((frame, index) => cropped(frame, options.crops?.[index]));
  const rows = Math.ceil(frames.length / columns);
  // As wide as a frame sent alone would reach the model, so a frame is never
  // enlarged, unless the rows would then be taller than allowed; a wide sheet
  // gives each tile up to its widest frame's own width instead. Each row gets
  // a whole number of pixels: the resize rounds a tile's height, and three
  // rows of 666.67 would otherwise round to 2001.
  const aspect = Math.max(...frames.map((frame) => frame.getSize().height / Math.max(1, frame.getSize().width)));
  const widest = Math.max(...frames.map((frame) => frame.getSize().width));
  const seenWidth = Math.min(CONTACT_SHEET_WIDTH, options.wide === true ? widest * columns : widest);
  const tileWidth = Math.floor(Math.min(seenWidth / columns, Math.floor(CONTACT_SHEET_MAX_HEIGHT / rows) / aspect));
  const tiles = frames.map((frame) => frame.resize({ width: tileWidth, quality: "good" }));
  const tileHeight = Math.max(...tiles.map((tile) => tile.getSize().height));
  const width = tileWidth * columns;
  const height = tileHeight * rows;
  // BGRA, as nativeImage's bitmaps are; untouched tiles stay opaque black.
  const sheet = Buffer.alloc(width * height * 4);
  for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;
  tiles.forEach((tile, index) => {
    const { width: w, height: h } = tile.getSize();
    const bitmap = tile.toBitmap();
    const left = (index % columns) * tileWidth;
    const top = Math.floor(index / columns) * tileHeight;
    for (let y = 0; y < h; y++) {
      bitmap.copy(sheet, ((top + y) * width + left) * 4, y * w * 4, (y + 1) * w * 4);
    }
    const label = options.labels?.[index];
    if (label !== undefined && label !== "") {
      const scale = labelScale(tileWidth);
      const inset = 2 * scale;
      // Kept inside the tile, so a narrow one clips its label rather than its neighbour's frame.
      drawLabel(sheet, width, height, left + inset, top + inset, label.slice(0, Math.max(1, Math.floor((tileWidth - inset * 2) / (6 * scale)) - 1)), scale);
    }
  });
  const composed = nativeImage.createFromBitmap(sheet, { width, height });
  for (const quality of CONTACT_SHEET_QUALITIES) {
    const jpeg = composed.toJPEG(quality);
    if (jpeg.byteLength > 0 && jpeg.byteLength <= CONTACT_SHEET_MAX_BYTES && fits(jpeg)) {
      return { data: jpeg.toString("base64"), mediaType: "image/jpeg" };
    }
  }
  return undefined;
}

/**
 * A reference clip's frames as one sheet, cropped to where the clip changes
 * and each labelled with its number and time.
 */
export const composeClipSheet: ClipSheetComposer = (frames, { columns, labels, crop }) => composeContactSheet(
  frames.map((jpeg) => ({ data: jpeg.toString("base64"), mediaType: "image/jpeg" })),
  columns,
  { labels, crops: frames.map(() => crop), wide: true },
);

/** The preview an attached clip keeps in the chat, made from one of its frames. */
export async function clipThumbnail(jpeg: Buffer): Promise<string | undefined> {
  const source = nativeImage.createFromBuffer(jpeg);
  return source.isEmpty() ? undefined : thumbnail(source);
}

/** The long side of a frame measured for a clip's timing and colours. */
const ANALYSIS_EDGE = 160;

/** A clip frame made small and raw for measuring: BGRA, as Electron's bitmaps are. */
export async function clipAnalysisFrame(jpeg: Buffer, time: number): Promise<AnalysisFrame> {
  const source = nativeImage.createFromBuffer(jpeg);
  if (source.isEmpty()) throw new Error("A frame of the clip could not be read back.");
  const small = scaled(source, ANALYSIS_EDGE);
  const { width, height } = small.getSize();
  return { time, width, height, pixels: new Uint8Array(small.toBitmap()) };
}

/**
 * The preview kept with image evidence: a screenshot or a Blender preview,
 * scaled down and re-encoded as JPEG so it fits the saved-record bound.
 *
 * Undefined when the image does not decode here or cannot be made small
 * enough. The evidence is then kept without a picture; the tool call itself is
 * unaffected.
 */
export async function previewToolImage(image: McpToolImage): Promise<string | undefined> {
  const source = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
  if (source.isEmpty()) return undefined;
  for (const edge of EVIDENCE_PREVIEW_EDGES) {
    const preview = scaled(source, edge);
    for (const quality of EVIDENCE_PREVIEW_QUALITIES) {
      const jpeg = preview.toJPEG(quality);
      if (jpeg.byteLength === 0) continue;
      const url = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      if (isEvidenceImage(url)) return url;
    }
  }
  return undefined;
}
