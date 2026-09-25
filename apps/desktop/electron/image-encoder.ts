import { nativeImage, type NativeImage } from "electron";
import {
  MAX_TURN_IMAGE_BASE64,
  type TurnImageMediaType,
} from "../runtime/model-api/turn-contract";

import type { EncodedImage, ImageEncoder } from "../runtime/attachment-context";
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

/**
 * The long edge a picture is scaled down to. Past roughly this size no provider
 * resolves more detail from a screenshot; it only costs more to send and more
 * to bill.
 */
const MAX_IMAGE_EDGE = 1568;

/** Progressively smaller retries for an image that will not fit at full size. */
const FALLBACK_EDGES = [1024, 768];

/** JPEG qualities tried, best first, when a lossless encoding is too large. */
const JPEG_QUALITIES = [82, 62, 45];

const THUMBNAIL_EDGE = 320;
const THUMBNAIL_QUALITIES = [70, 50];

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
 * Encode an attached image, downscaling until it fits the wire contract.
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

  const lossless = mediaType !== "image/jpeg";
  for (const edge of [MAX_IMAGE_EDGE, ...FALLBACK_EDGES]) {
    const candidate = scaled(source, edge);
    const encoded = encodeWithin(candidate, lossless);
    if (encoded === undefined) continue;
    return {
      mediaType: encoded.mediaType,
      data: encoded.buffer.toString("base64"),
      ...(() => {
        const preview = thumbnail(source);
        return preview === undefined ? {} : { thumbnailDataUrl: preview };
      })(),
    };
  }
  throw new Error(`“${name}” could not be made small enough to send.`);
};
