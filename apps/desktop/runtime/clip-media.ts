import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * Serving an attached clip to the chat window's preview player.
 *
 * Choosing the part of a clip to send needs the clip to play: a strip of
 * thumbnails cannot show whether a two-second stretch holds the whole effect.
 * The main process answers the `roqer-clip` scheme with the clip's own bytes,
 * found by the attachment id the registry issued, so the chat window can play
 * a file the user attached and nothing else. A video seeks by byte ranges, so
 * every response honours one.
 */

/** A clip's bytes as the registry holds them: a file on disk, or an animated picture in memory. */
export type ClipMedia =
  | Readonly<{ path: string; mediaType: string }>
  | Readonly<{ bytes: Buffer; mediaType: string }>;

/**
 * The byte range a `Range` header asks for, inclusive; undefined for the
 * whole file (no header, or one this does not serve, such as several
 * ranges), or "invalid" for a range the file cannot satisfy.
 */
export function parseByteRange(header: string | null | undefined, size: number): Readonly<{ start: number; end: number }> | "invalid" | undefined {
  if (header === null || header === undefined || header === "") return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, from, to] = match;
  if (from === "" && to === "") return "invalid";
  if (from === "") {
    // A suffix: the last n bytes.
    const length = Number(to);
    if (length === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

const notFound = () => new Response(null, { status: 404 });

/** Answer one request for an attached clip's bytes. */
export async function serveClipMedia(request: Request, lookup: (attachmentId: string) => ClipMedia | undefined): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  if (url.hostname !== "media") return notFound();
  let id: string;
  try {
    id = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return notFound();
  }
  const media = id === "" ? undefined : lookup(id);
  if (media === undefined) return notFound();

  let size: number;
  if ("bytes" in media) {
    size = media.bytes.length;
  } else {
    try {
      const file = await stat(media.path);
      if (!file.isFile()) return notFound();
      size = file.size;
    } catch {
      return notFound();
    }
  }
  const range = parseByteRange(request.headers.get("range"), size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const headers: Record<string, string> = {
    "Content-Type": media.mediaType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(Math.max(0, end - start + 1)),
    "Cache-Control": "no-store",
    ...(range === undefined ? {} : { "Content-Range": `bytes ${start}-${end}/${size}` }),
  };
  let body: ConstructorParameters<typeof Response>[0] = null;
  if (request.method === "GET" && size > 0) {
    body = "bytes" in media
      ? new Uint8Array(media.bytes.subarray(start, end + 1))
      : Readable.toWeb(createReadStream(media.path, { start, end })) as unknown as ReadableStream<Uint8Array>;
  }
  return new Response(body, { status: range === undefined ? 200 : 206, headers });
}
