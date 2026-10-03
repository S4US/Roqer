import type { ClipSelection } from "../shared/reference-clip";
import type { AnalysisFrame } from "./clip-analysis";
import type { ClipStore } from "./clip-store";
import type { ClipSheetComposer } from "./reference-clip";

/**
 * What the attachment registry needs to turn a clip into frames, with the
 * parts that need Electron (the decoder window, and decoding JPEGs to measure
 * them) supplied by the host, so the registry stays testable without it.
 */

/** A video on disk, or an animated picture's bytes. */
export type ClipSource =
  | Readonly<{ kind: "video"; path: string }>
  | Readonly<{ kind: "image"; bytes: Buffer; mediaType: string }>;

export type ClipInfo = Readonly<{ duration: number; width: number; height: number }>;

/** A frame read from a clip: its time in the clip, as a JPEG. */
export type ClipFrame = Readonly<{ time: number; jpeg: Buffer }>;

export type ClipSupport = Readonly<{
  info(source: ClipSource): Promise<ClipInfo>;
  /** One frame at each time, `edge` pixels on the long side. */
  strip(source: ClipSource, times: readonly number[], edge: number): Promise<ClipFrame[]>;
  /** Every frame of a selection, at the rate Roqer keeps. */
  capture(source: ClipSource, selection: ClipSelection, edge: number): Promise<Readonly<{ frames: ClipFrame[] }>>;
  /** The preview the chat keeps, as a data URL; undefined when none can be made. */
  thumbnail(jpeg: Buffer): Promise<string | undefined>;
  /** A small raw frame to measure, at an effect time. */
  analysisFrame(jpeg: Buffer, time: number): Promise<AnalysisFrame>;
  /** The byte order of `analysisFrame`'s pixels. */
  pixelOrder: "rgba" | "bgra";
  store: ClipStore;
  compose: ClipSheetComposer;
}>;

/** A clip's stored frames' size: the long side scaled to `edge`, as the decoder draws them. */
export function frameSize(info: ClipInfo, edge: number): Readonly<{ width: number; height: number }> {
  const scale = Math.min(1, edge / Math.max(info.width, info.height, 1));
  return { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) };
}
