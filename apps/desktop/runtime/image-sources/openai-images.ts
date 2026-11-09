import type { ImageBackground, ImageKind, ImageQuality, ImageSize, ImageSourceKind } from "../../shared/image-generation";
import { isTransientStatus, refusalMessage, retryAfterMs } from "../model-api/http";

/**
 * OpenAI's image API, and any server that speaks its shape.
 *
 * One request makes one to four pictures. OpenAI's own models take a quality
 * and a transparent background as fields; a compatible server is sent the
 * fields every such server takes, and asked for the background in words. A
 * busy or failing server is tried again a few times, waiting as long as it
 * asks; a refusal is reported in its own words with the key redacted.
 */

export type ImageRequest = Readonly<{
  prompt: string;
  kind: ImageKind;
  background: ImageBackground;
  size: ImageSize;
  count: number;
  quality: ImageQuality;
  /** A picture to vary: an earlier output or an attachment, as bytes. */
  reference?: Readonly<{ bytes: Buffer; name: string }>;
}>;

export type GeneratedImages = Readonly<{
  images: readonly Buffer[];
  model: string;
  /** The prompt the server says it drew from, when it rewrote it. */
  revisedPrompt?: string;
}>;

export interface ImageSource {
  readonly label: string;
  generate(request: ImageRequest, signal: AbortSignal): Promise<GeneratedImages>;
}

export type OpenAiImageSourceOptions = Readonly<{
  source: ImageSourceKind;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  label?: string;
  fetch?: typeof globalThis.fetch;
  /** The first wait before a retry; retries double it. */
  retryBaseMs?: number;
  retries?: number;
}>;

/** A picture a server links to rather than sends: fetched over HTTPS, within a bound. */
const MAX_LINKED_IMAGE_BYTES = 24 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the words of the prompt must carry when the server has no field for it. */
export function promptWithBackground(prompt: string, background: ImageBackground, source: ImageSourceKind): string {
  const trimmed = prompt.trim();
  if (background === "black") return `${trimmed}, on a solid pure black background with nothing else in the frame`;
  if (background === "transparent" && source === "openai-compatible") return `${trimmed}, isolated on a fully transparent background`;
  return trimmed;
}

/** The JSON body for a generation, by source: OpenAI's own fields, or the common ones. */
export function generationBody(options: Pick<OpenAiImageSourceOptions, "source" | "model">, request: ImageRequest): Record<string, unknown> {
  const prompt = promptWithBackground(request.prompt, request.background, options.source);
  if (options.source === "openai") {
    return {
      model: options.model,
      prompt,
      n: request.count,
      size: request.size,
      quality: request.quality,
      background: request.background === "transparent" ? "transparent" : "opaque",
      output_format: "png",
    };
  }
  return { model: options.model, prompt, n: request.count, size: request.size, response_format: "b64_json" };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Run was cancelled.")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("Run was cancelled.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class OpenAiImageSource implements ImageSource {
  readonly label: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly options: OpenAiImageSourceOptions;

  constructor(options: OpenAiImageSourceOptions) {
    this.options = options;
    this.label = options.label ?? (options.source === "openai" ? "OpenAI" : "the image server");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generate(request: ImageRequest, signal: AbortSignal): Promise<GeneratedImages> {
    const { apiKey } = this.options;
    const retries = this.options.retries ?? 3;
    const base = this.options.retryBaseMs ?? 1_000;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error("Run was cancelled.");
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(request), this.init(request, signal));
      } catch (error) {
        if (signal.aborted) throw new Error("Run was cancelled.");
        if (attempt < retries) { await sleep(base * 2 ** attempt, signal); continue; }
        throw new Error(`${this.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) return this.parse(response, signal);
      if (isTransientStatus(response.status) && attempt < retries) {
        const wait = Math.min(retryAfterMs(response.headers) ?? base * 2 ** attempt, 60_000);
        await sleep(wait, signal);
        continue;
      }
      throw new Error(await refusalMessage(response, this.label, apiKey));
    }
  }

  private url(request: ImageRequest): string {
    return `${this.options.baseUrl}/images/${request.reference === undefined ? "generations" : "edits"}`;
  }

  private init(request: ImageRequest, signal: AbortSignal): RequestInit {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.options.apiKey !== null) headers.authorization = `Bearer ${this.options.apiKey}`;
    if (request.reference === undefined) {
      headers["content-type"] = "application/json";
      return { method: "POST", headers, body: JSON.stringify(generationBody(this.options, request)), signal };
    }
    // An edit carries the picture to vary as a file, beside the same fields.
    const form = new FormData();
    const body = generationBody(this.options, request);
    for (const [key, value] of Object.entries(body)) form.append(key, String(value));
    form.append("image", new Blob([new Uint8Array(request.reference.bytes)], { type: "image/png" }), request.reference.name);
    return { method: "POST", headers, body: form, signal };
  }

  private async parse(response: Response, signal: AbortSignal): Promise<GeneratedImages> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${this.label} sent a response Roqer could not read.`);
    }
    const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
    if (entries.length === 0) throw new Error(`${this.label} sent no image.`);
    const images: Buffer[] = [];
    let revisedPrompt: string | undefined;
    for (const entry of entries) {
      if (typeof entry.revised_prompt === "string" && revisedPrompt === undefined) revisedPrompt = entry.revised_prompt.slice(0, 2_000);
      if (typeof entry.b64_json === "string" && entry.b64_json !== "") {
        const bytes = Buffer.from(entry.b64_json, "base64");
        if (bytes.length === 0) throw new Error(`${this.label} sent an image Roqer could not decode.`);
        images.push(bytes);
      } else if (typeof entry.url === "string") {
        images.push(await this.fetchLinked(entry.url, signal));
      }
    }
    if (images.length === 0) throw new Error(`${this.label} sent no image bytes.`);
    for (const bytes of images) {
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error(`${this.label} sent an image that is not a PNG; Roqer needs PNG output (OpenAI's output_format png, or a server set to png).`);
      }
    }
    const model = isRecord(payload) && typeof payload.model === "string" ? payload.model : this.options.model;
    return { images, model, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) };
  }

  private async fetchLinked(url: string, signal: AbortSignal): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${this.label} linked to an image at an address Roqer could not read.`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"))) {
      throw new Error(`${this.label} linked to an image over a connection Roqer does not fetch (${parsed.protocol}).`);
    }
    const response = await this.fetchImpl(parsed, { signal });
    if (!response.ok) throw new Error(`${this.label} linked to an image Roqer could not fetch (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_LINKED_IMAGE_BYTES) throw new Error(`${this.label} linked to an image outside Roqer's size bound.`);
    return bytes;
  }
}

/**
 * Whether the server answers for the saved model, without making a picture:
 * `GET /models/{model}`, and when the server has no such route, `GET /models`.
 * An OpenAI-compatible server that lists no models still passes, with a
 * message saying the first image call is the real test.
 */
export async function checkImageSource(
  options: Pick<OpenAiImageSourceOptions, "source" | "baseUrl" | "model" | "apiKey" | "label" | "fetch">,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const label = options.label ?? (options.source === "openai" ? "OpenAI" : "The image server");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey !== null) headers.authorization = `Bearer ${options.apiKey}`;
  const get = (route: string) => fetchImpl(`${options.baseUrl}${route}`, { method: "GET", headers, signal });
  let response: Response;
  try {
    response = await get(`/models/${encodeURIComponent(options.model)}`);
  } catch (error) {
    return { ok: false, message: `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.ok) return { ok: true, message: `${label} answered for ${options.model}. Image calls will use it.` };
  if (response.status !== 404) return { ok: false, message: await refusalMessage(response, label, options.apiKey) };
  let listing: Response;
  try {
    listing = await get("/models");
  } catch (error) {
    return { ok: false, message: `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (listing.status === 404) {
    return { ok: true, message: `${label} answered, but does not list its models, so the first image call is the test of ${options.model}.` };
  }
  if (!listing.ok) return { ok: false, message: await refusalMessage(listing, label, options.apiKey) };
  let payload: unknown;
  try {
    payload = await listing.json();
  } catch {
    return { ok: false, message: `${label} sent a model list Roqer could not read.` };
  }
  const ids = isRecord(payload) && Array.isArray(payload.data)
    ? payload.data.filter(isRecord).map((entry) => entry.id).filter((id): id is string => typeof id === "string")
    : [];
  if (ids.includes(options.model)) return { ok: true, message: `${label} lists ${options.model}. Image calls will use it.` };
  const shown = ids.slice(0, 8).join(", ");
  return {
    ok: false,
    message: ids.length === 0
      ? `${label} lists no models; check the address and the model name.`
      : `${label} does not list ${options.model}. It lists: ${shown}${ids.length > 8 ? ", …" : ""}.`,
  };
}
