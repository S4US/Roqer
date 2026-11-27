import type { ImageSize } from "../../shared/image-generation";
import { isTransientStatus, redact, refusalMessage, retryAfterMs } from "../model-api/http";
import { promptWithBackground, type GeneratedImages, type ImageRequest, type ImageSource } from "./openai-images";

/**
 * Google's Gemini API, which serves two kinds of image model under one key
 * from Google AI Studio:
 *
 * - Gemini's native image models (`gemini-*`) answer `generateContent`. They
 *   make one picture a call, take a reference picture, and choose the aspect
 *   ratio through `imageConfig`.
 * - Imagen models (`imagen-*`) answer `predict`. One call makes up to four
 *   pictures from the prompt alone: they take no reference picture.
 *
 * Neither has a background or quality field, so the background is asked for in
 * words and Roqer's own quality setting is not sent. Both answer with PNG, and
 * a picture of any other kind is reported rather than used.
 */

export const GOOGLE_LABEL = "Google";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The most of Google's own explanation that a message carries. */
const MAX_REPORTED_TEXT = 300;

/** The model list is read in pages; this bounds a listing that never ends. */
const MAX_MODEL_PAGES = 5;

export type GoogleImageSourceOptions = Readonly<{
  baseUrl: string;
  model: string;
  apiKey: string | null;
  label?: string;
  fetch?: typeof globalThis.fetch;
  /** The first wait before a retry; retries double it. */
  retryBaseMs?: number;
  retries?: number;
}>;

/** The two request shapes Google's image models take. */
export type GoogleImageFamily = "gemini" | "imagen";

/** A picture as Google sent it, before Roqer checks it is a PNG. */
type GoogleImage = Readonly<{ bytes: Buffer; mimeType?: string }>;

/** What one Google answer holds, whether it made a picture or explained why not. */
export type GoogleAnswer = Readonly<{
  images: readonly GoogleImage[];
  /** The model Google says answered, when it says. */
  model?: string;
  /** The prompt Imagen says it enhanced, when it does. */
  revisedPrompt?: string;
  /** Google's own words for an answer that held no picture. */
  refusal?: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The model id as Google spells it in a URL: a `models/` prefix is dropped. */
export function googleModelId(model: string): string {
  return model.trim().replace(/^models\//, "");
}

/** Imagen and Gemini answer through different routes and request shapes. */
export function googleImageFamily(model: string): GoogleImageFamily {
  return /^imagen(?:-|$)/i.test(googleModelId(model)) ? "imagen" : "gemini";
}

/**
 * The aspect ratio nearest a requested size, in the set the family takes.
 * Imagen's set is smaller: a wide or tall request is asked for at 4:3 or 3:4,
 * and the result reports the size that came back.
 */
export function googleAspectRatio(size: ImageSize, family: GoogleImageFamily): string {
  if (size === "1536x1024") return family === "imagen" ? "4:3" : "3:2";
  if (size === "1024x1536") return family === "imagen" ? "3:4" : "2:3";
  return "1:1";
}

/** The prompt Google reads: the background in words, since Google has no field for it. */
export function googlePrompt(request: ImageRequest): string {
  return promptWithBackground(request.prompt, request.background, "openai-compatible");
}

/** The JSON body for Gemini's `generateContent`. */
export function geminiGenerateBody(request: ImageRequest): Record<string, unknown> {
  const parts: unknown[] = [{ text: googlePrompt(request) }];
  if (request.reference !== undefined) {
    parts.push({ inlineData: { mimeType: "image/png", data: request.reference.bytes.toString("base64") } });
  }
  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      // TEXT is what Google's own examples ask for; the picture is the part Roqer reads.
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: googleAspectRatio(request.size, "gemini") },
    },
  };
}

/** The JSON body for Imagen's `predict`; one call makes as many pictures as asked up to four. */
export function imagenPredictBody(request: ImageRequest): Record<string, unknown> {
  return {
    instances: [{ prompt: googlePrompt(request) }],
    parameters: { sampleCount: request.count, aspectRatio: googleAspectRatio(request.size, "imagen") },
  };
}

/** One `inlineData` part of a Gemini answer, camelCase or snake_case as a relay sent it. */
function imagePart(part: Record<string, unknown>): GoogleImage | undefined {
  const inline = isRecord(part.inlineData) ? part.inlineData : isRecord(part.inline_data) ? part.inline_data : undefined;
  if (inline === undefined || typeof inline.data !== "string" || inline.data === "") return undefined;
  const mimeType = typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : undefined;
  return { bytes: Buffer.from(inline.data, "base64"), ...(mimeType === undefined ? {} : { mimeType }) };
}

/** What a Gemini `generateContent` answer holds. */
export function parseGeminiAnswer(payload: unknown): GoogleAnswer {
  if (!isRecord(payload)) return { images: [] };
  const model = typeof payload.modelVersion === "string" ? payload.modelVersion : undefined;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter(isRecord) : [];
  const images: GoogleImage[] = [];
  const notes: string[] = [];
  let refusal: string | undefined;
  for (const candidate of candidates) {
    const content = isRecord(candidate.content) ? candidate.content : undefined;
    const parts = content !== undefined && Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
    for (const part of parts) {
      const image = imagePart(part);
      if (image !== undefined) {
        if (image.bytes.length > 0) images.push(image);
        else refusal ??= "an image Roqer could not decode";
      } else if (typeof part.text === "string" && part.text.trim() !== "") {
        notes.push(part.text.trim());
      }
    }
    const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : undefined;
    if (finish !== undefined && finish !== "STOP" && finish !== "FINISH_REASON_STOP") {
      const detail = typeof candidate.finishMessage === "string" ? `: ${candidate.finishMessage}` : "";
      refusal ??= `${finish}${detail}`;
    }
  }
  const feedback = isRecord(payload.promptFeedback) ? payload.promptFeedback : undefined;
  if (images.length === 0 && refusal === undefined) {
    const blocked = feedback !== undefined && typeof feedback.blockReason === "string" ? feedback.blockReason : undefined;
    if (blocked !== undefined) refusal = `the prompt was blocked (${blocked})`;
    else if (notes.length > 0) refusal = notes[0];
  }
  return { images, ...(model === undefined ? {} : { model }), ...(refusal === undefined ? {} : { refusal }) };
}

/** What an Imagen `predict` answer holds. */
export function parseImagenAnswer(payload: unknown): GoogleAnswer {
  if (!isRecord(payload)) return { images: [] };
  const predictions = Array.isArray(payload.predictions) ? payload.predictions.filter(isRecord) : [];
  const images: GoogleImage[] = [];
  let revisedPrompt: string | undefined;
  let refusal: string | undefined;
  for (const prediction of predictions) {
    if (revisedPrompt === undefined && typeof prediction.enhancedPrompt === "string" && prediction.enhancedPrompt !== "") {
      revisedPrompt = prediction.enhancedPrompt.slice(0, 2_000);
    }
    const data = typeof prediction.bytesBase64Encoded === "string" ? prediction.bytesBase64Encoded
      : typeof prediction.bytes_base64_encoded === "string" ? prediction.bytes_base64_encoded : undefined;
    if (data !== undefined && data !== "") {
      const mimeType = typeof prediction.mimeType === "string" ? prediction.mimeType
        : typeof prediction.mime_type === "string" ? prediction.mime_type : undefined;
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > 0) images.push({ bytes, ...(mimeType === undefined ? {} : { mimeType }) });
      else refusal ??= "an image Roqer could not decode";
      continue;
    }
    if (refusal === undefined) {
      const filtered = typeof prediction.raiFilteredReason === "string" ? prediction.raiFilteredReason : undefined;
      if (filtered !== undefined && filtered !== "") refusal = filtered;
    }
  }
  return { images, ...(revisedPrompt === undefined ? {} : { revisedPrompt }), ...(refusal === undefined ? {} : { refusal }) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Run was cancelled.")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("Run was cancelled.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class GoogleImageSource implements ImageSource {
  readonly label: string;
  private readonly options: GoogleImageSourceOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GoogleImageSourceOptions) {
    this.options = options;
    this.label = options.label ?? GOOGLE_LABEL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generate(request: ImageRequest, signal: AbortSignal): Promise<GeneratedImages> {
    const family = googleImageFamily(this.options.model);
    if (family === "imagen" && request.reference !== undefined) {
      throw new Error(`${this.label} cannot vary a picture with ${this.options.model}: Imagen makes a picture from the prompt alone. Choose a Gemini image model to edit or vary an earlier output.`);
    }
    const images: Buffer[] = [];
    let model = this.options.model;
    let revisedPrompt: string | undefined;
    while (images.length < request.count) {
      // Gemini answers one picture a call; Imagen takes how many are still wanted.
      const wanted = family === "imagen" ? request.count - images.length : 1;
      const body = family === "imagen" ? imagenPredictBody({ ...request, count: wanted }) : geminiGenerateBody(request);
      const answer = await this.#call(family, body, signal);
      if (answer.model !== undefined) model = answer.model;
      if (revisedPrompt === undefined) revisedPrompt = answer.revisedPrompt;
      const got = this.#png(answer);
      images.push(...got.slice(0, wanted));
      // A model that answered with fewer than asked is not asked again for the
      // rest: the next call would spend as much and likely answer alike.
      if (got.length < wanted) break;
    }
    return { images: images.slice(0, request.count), model, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) };
  }

  /** The PNGs in an answer, or the reason there is none, in Roqer's words. */
  #png(answer: GoogleAnswer): Buffer[] {
    if (answer.images.length === 0) {
      throw new Error(answer.refusal === undefined
        ? `${this.label} sent no image.`
        : `${this.label} made no picture: ${redact(answer.refusal, this.options.apiKey).slice(0, MAX_REPORTED_TEXT)}.`);
    }
    const images: Buffer[] = [];
    for (const image of answer.images) {
      if ((image.mimeType !== undefined && !image.mimeType.startsWith("image/png")) || !image.bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error(`${this.label} sent ${image.mimeType ?? "a picture that is not a PNG"} from ${this.options.model}; Roqer needs PNG output.`);
      }
      images.push(image.bytes);
    }
    return images;
  }

  /** One request, retried while Google is busy or failing, in Google's own words when it refuses. */
  async #call(family: GoogleImageFamily, body: Record<string, unknown>, signal: AbortSignal): Promise<GoogleAnswer> {
    const route = family === "imagen" ? "predict" : "generateContent";
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(googleModelId(this.options.model))}:${route}`;
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (this.options.apiKey !== null) headers["x-goog-api-key"] = this.options.apiKey;
    const retries = this.options.retries ?? 3;
    const base = this.options.retryBaseMs ?? 1_000;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error("Run was cancelled.");
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      } catch (error) {
        if (signal.aborted) throw new Error("Run was cancelled.");
        if (attempt < retries) { await sleep(base * 2 ** attempt, signal); continue; }
        throw new Error(`${this.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`${this.label} sent a response Roqer could not read.`);
        }
        return family === "imagen" ? parseImagenAnswer(payload) : parseGeminiAnswer(payload);
      }
      if (isTransientStatus(response.status) && attempt < retries) {
        const wait = Math.min(retryAfterMs(response.headers) ?? base * 2 ** attempt, 60_000);
        await sleep(wait, signal);
        continue;
      }
      throw new Error(await refusalMessage(response, this.label, this.options.apiKey));
    }
  }
}

/** The ids Google's model list holds, `models/` prefix removed. */
function listedModels(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  return payload.models.filter(isRecord)
    .map((model) => typeof model.name === "string" ? googleModelId(model.name) : "")
    .filter((id) => id !== "");
}

/** Whether Google answers for the saved model, without making a picture. */
export async function checkGoogleSource(
  options: Pick<GoogleImageSourceOptions, "baseUrl" | "model" | "apiKey" | "label" | "fetch">,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const label = options.label ?? GOOGLE_LABEL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey !== null) headers["x-goog-api-key"] = options.apiKey;
  const base = options.baseUrl.replace(/\/+$/, "");
  const get = (route: string) => fetchImpl(`${base}${route}`, { method: "GET", headers, signal });
  const modelId = googleModelId(options.model);

  let response: Response;
  try {
    response = await get(`/models/${encodeURIComponent(modelId)}`);
  } catch (error) {
    return { ok: false, message: `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.ok) return { ok: true, message: `${label} answered for ${options.model}. Image calls will use it.` };
  if (response.status !== 404) return { ok: false, message: await refusalMessage(response, label, options.apiKey) };

  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    let listing: Response;
    try {
      listing = await get(`/models?pageSize=1000${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`);
    } catch (error) {
      return { ok: false, message: `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!listing.ok) return { ok: false, message: await refusalMessage(listing, label, options.apiKey) };
    let payload: unknown;
    try {
      payload = await listing.json();
    } catch {
      return { ok: false, message: `${label} sent a model list Roqer could not read.` };
    }
    ids.push(...listedModels(payload));
    const next = isRecord(payload) && typeof payload.nextPageToken === "string" && payload.nextPageToken !== "" ? payload.nextPageToken : undefined;
    if (next === undefined) break;
    pageToken = next;
  }
  if (ids.includes(modelId)) return { ok: true, message: `${label} lists ${options.model}. Image calls will use it.` };

  const imageModels = ids.filter((id) => id.startsWith("imagen") || id.includes("image"));
  const shown = imageModels.slice(0, 8).join(", ");
  return {
    ok: false,
    message: imageModels.length === 0
      ? `${label} does not list ${options.model}, and lists no image models for this key; check the model id, and that the key is from Google AI Studio.`
      : `${label} does not list ${options.model}. Its image models include ${shown}${imageModels.length > 8 ? ", …" : ""}.`,
  };
}
