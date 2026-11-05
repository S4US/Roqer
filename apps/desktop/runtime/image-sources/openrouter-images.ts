import type { ImageSize } from "../../shared/image-generation";
import { isTransientStatus, refusalMessage, retryAfterMs } from "../model-api/http";
import { promptWithBackground, type GeneratedImages, type ImageRequest, type ImageSource } from "./openai-images";

/**
 * OpenRouter's image API: one key in front of many image models.
 *
 * OpenRouter does not serve OpenAI's `images/generations` route. Its own
 * route, `POST /images`, takes a prompt and a model, and a set of optional
 * fields each model accepts or not: an aspect ratio, a resolution tier, a
 * quality, an output format, a transparent background, how many pictures,
 * and reference pictures to edit. `GET /images/models` says which. So the
 * source reads the model's capabilities first and sends only what it takes;
 * what it does not take goes into the prompt's words or is left out, and a
 * model that makes one picture a call is asked once per picture.
 */

export type OpenRouterImageSourceOptions = Readonly<{
  baseUrl: string;
  model: string;
  apiKey: string | null;
  fetch?: typeof globalThis.fetch;
  retryBaseMs?: number;
  retries?: number;
  now?: () => number;
}>;

/** What one OpenRouter image model accepts, as `GET /images/models` lists it. Absent means the model did not say. */
export type OpenRouterCapabilities = Readonly<{
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  outputFormats?: readonly string[];
  qualities?: readonly string[];
  backgrounds?: readonly string[];
  /** The most pictures one call may ask for. */
  maxCount?: number;
  /** The most reference pictures one call may send. */
  maxReferences?: number;
}>;

export type OpenRouterImageModel = Readonly<{ id: string; name: string; capabilities: OpenRouterCapabilities }>;

export const OPENROUTER_LABEL = "OpenRouter";
/** OpenRouter asks apps to say who they are; neither header carries anything of the user's. */
const APP_HEADERS: Readonly<Record<string, string>> = { "HTTP-Referer": "https://github.com/S4US/Roqer", "X-Title": "Roqer" };
/** How long a fetched model list is trusted before it is read again. */
const MODELS_FRESH_MS = 10 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;

/** The model list as OpenRouter sends it, kept to what the source reads. */
export function parseImageModels(payload: unknown): OpenRouterImageModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const models: OpenRouterImageModel[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const parameters = isRecord(entry.supported_parameters) ? entry.supported_parameters : {};
    const enumOf = (name: string) => isRecord(parameters[name]) ? strings((parameters[name] as Record<string, unknown>).enum) : undefined;
    const maxOf = (name: string) => {
      const parameter = parameters[name];
      if (!isRecord(parameter)) return undefined;
      const range = Array.isArray(parameter.range) ? parameter.range : undefined;
      const max = range !== undefined ? range[range.length - 1] : parameter.max;
      return typeof max === "number" && Number.isFinite(max) ? max : undefined;
    };
    const capabilities: OpenRouterCapabilities = {
      ...(enumOf("aspect_ratio") === undefined ? {} : { aspectRatios: enumOf("aspect_ratio") }),
      ...(enumOf("resolution") === undefined ? {} : { resolutions: enumOf("resolution") }),
      ...(enumOf("output_format") === undefined ? {} : { outputFormats: enumOf("output_format") }),
      ...(enumOf("quality") === undefined ? {} : { qualities: enumOf("quality") }),
      ...(enumOf("background") === undefined ? {} : { backgrounds: enumOf("background") }),
      ...(maxOf("n") === undefined ? {} : { maxCount: maxOf("n") }),
      ...(maxOf("input_references") === undefined ? {} : { maxReferences: maxOf("input_references") }),
    };
    models.push({ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id, capabilities });
  }
  return models;
}

/** The ratio of one of Roqer's sizes, in OpenRouter's words. */
export function aspectRatioFor(size: ImageSize): string {
  return size === "1536x1024" ? "3:2" : size === "1024x1536" ? "2:3" : "1:1";
}

/** The resolution tier of one of Roqer's sizes, when the model takes one. */
function resolutionFor(size: ImageSize, resolutions: readonly string[] | undefined): string | undefined {
  if (resolutions === undefined) return undefined;
  const wanted = size === "512x512" ? ["512", "1K"] : ["1K", "1024"];
  return wanted.find((tier) => resolutions.includes(tier));
}

/** One request's body, and how many pictures it asks for; the caller repeats it for the rest. */
export function openRouterBody(
  model: string,
  request: ImageRequest,
  capabilities: OpenRouterCapabilities | undefined,
  count: number,
): Record<string, unknown> {
  const takesBackground = capabilities?.backgrounds?.includes("transparent") === true;
  // A model with no background field is asked for it in words, as a
  // compatible server is; one that has the field is asked plainly.
  const prompt = promptWithBackground(request.prompt, request.background, takesBackground && request.background === "transparent" ? "openai" : "openai-compatible");
  const ratio = aspectRatioFor(request.size);
  const resolution = resolutionFor(request.size, capabilities?.resolutions);
  const body: Record<string, unknown> = { model, prompt };
  if (count > 1) body.n = count;
  if (capabilities === undefined || capabilities.aspectRatios?.includes(ratio)) body.aspect_ratio = ratio;
  if (resolution !== undefined) body.resolution = resolution;
  if (capabilities?.qualities?.includes(request.quality)) body.quality = request.quality;
  if (capabilities === undefined || capabilities.outputFormats?.includes("png")) body.output_format = "png";
  if (takesBackground) body.background = request.background === "transparent" ? "transparent" : "opaque";
  if (request.reference !== undefined && (capabilities === undefined || (capabilities.maxReferences ?? 0) >= 1)) {
    body.input_references = [{ type: "image_url", image_url: { url: `data:image/png;base64,${request.reference.bytes.toString("base64")}` } }];
  }
  return body;
}

/** How many pictures each call asks for: as many as the model allows, else one at a time. */
export function picturesPerCall(capabilities: OpenRouterCapabilities | undefined, count: number): number {
  const allowed = capabilities?.maxCount;
  return allowed === undefined ? 1 : Math.max(1, Math.min(count, Math.floor(allowed)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Run was cancelled.")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("Run was cancelled.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function headersFor(apiKey: string | null, json: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...APP_HEADERS };
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

/** Model lists read lately, by address, so a job does not ask again for each picture. */
const modelLists = new Map<string, { at: number; models: OpenRouterImageModel[] }>();

/** OpenRouter's image models at `baseUrl`; empty when the list cannot be read. Fresh lists are shared. */
export async function openRouterImageModels(
  options: Pick<OpenRouterImageSourceOptions, "baseUrl" | "apiKey" | "fetch" | "now">,
  signal?: AbortSignal,
): Promise<OpenRouterImageModel[]> {
  const now = options.now ?? Date.now;
  const cached = modelLists.get(options.baseUrl);
  if (cached !== undefined && now() - cached.at < MODELS_FRESH_MS) return cached.models;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${options.baseUrl}/images/models`, { method: "GET", headers: headersFor(options.apiKey, false), signal });
    if (!response.ok) return [];
    const models = parseImageModels(await response.json());
    if (models.length > 0) modelLists.set(options.baseUrl, { at: now(), models });
    return models;
  } catch {
    return [];
  }
}

/** For tests: forget the lists read so far. */
export function forgetOpenRouterModels(): void {
  modelLists.clear();
}

export class OpenRouterImageSource implements ImageSource {
  readonly label = OPENROUTER_LABEL;
  private readonly options: OpenRouterImageSourceOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenRouterImageSourceOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generate(request: ImageRequest, signal: AbortSignal): Promise<GeneratedImages> {
    const models = await openRouterImageModels(this.options, signal);
    const capabilities = models.find((model) => model.id === this.options.model)?.capabilities;
    const images: Buffer[] = [];
    const perCall = picturesPerCall(capabilities, request.count);
    while (images.length < request.count) {
      const wanted = Math.min(perCall, request.count - images.length);
      const body = openRouterBody(this.options.model, request, capabilities, wanted);
      const got = await this.#post(body, signal);
      if (got.length === 0) throw new Error(`${this.label} sent no image.`);
      images.push(...got.slice(0, wanted));
      // A provider that answered with fewer than asked is not asked again for
      // the rest: the next call would spend as much and likely answer alike.
      if (got.length < wanted) break;
    }
    return { images, model: this.options.model };
  }

  async #post(body: Record<string, unknown>, signal: AbortSignal): Promise<Buffer[]> {
    const retries = this.options.retries ?? 3;
    const base = this.options.retryBaseMs ?? 1_000;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error("Run was cancelled.");
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.options.baseUrl}/images`, { method: "POST", headers: headersFor(this.options.apiKey, true), body: JSON.stringify(body), signal });
      } catch (error) {
        if (signal.aborted) throw new Error("Run was cancelled.");
        if (attempt < retries) { await sleep(base * 2 ** attempt, signal); continue; }
        throw new Error(`${this.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) return this.#parse(response);
      if (isTransientStatus(response.status) && attempt < retries) {
        await sleep(Math.min(retryAfterMs(response.headers) ?? base * 2 ** attempt, 60_000), signal);
        continue;
      }
      throw new Error(await refusalMessage(response, this.label, this.options.apiKey));
    }
  }

  async #parse(response: Response): Promise<Buffer[]> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${this.label} sent a response Roqer could not read.`);
    }
    const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
    const images: Buffer[] = [];
    for (const entry of entries) {
      if (typeof entry.b64_json !== "string" || entry.b64_json === "") continue;
      const type = typeof entry.media_type === "string" ? entry.media_type : undefined;
      const bytes = Buffer.from(entry.b64_json, "base64");
      if ((type !== undefined && type !== "image/png") || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error(`${this.label} sent ${type ?? "a picture that is not a PNG"} from ${this.options.model}; Roqer needs PNG. Choose a model whose output formats include png (Test in Settings → Images lists what a model takes).`);
      }
      images.push(bytes);
    }
    return images;
  }
}

/** What a model takes, in a line for Settings. */
export function describeCapabilities(capabilities: OpenRouterCapabilities): string {
  const parts = [
    ...(capabilities.backgrounds?.includes("transparent") ? ["a transparent background"] : ["no transparent background, so light and matter textures come back opaque"]),
    ...(capabilities.qualities !== undefined ? ["a quality"] : []),
    ...(capabilities.aspectRatios !== undefined ? ["an aspect ratio"] : []),
    ...(capabilities.maxCount !== undefined && capabilities.maxCount > 1 ? [`up to ${capabilities.maxCount} pictures a call`] : ["one picture a call"]),
    ...(capabilities.maxReferences !== undefined && capabilities.maxReferences > 0 ? ["reference pictures to edit"] : []),
    ...(capabilities.outputFormats !== undefined && !capabilities.outputFormats.includes("png") ? ["no PNG output, which Roqer needs"] : []),
  ];
  return parts.join(", ");
}

/** Whether OpenRouter lists the saved model as an image model, and what it takes; makes no picture. */
export async function checkOpenRouterSource(
  options: Pick<OpenRouterImageSourceOptions, "baseUrl" | "model" | "apiKey" | "fetch">,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let listing: Response;
  try {
    listing = await fetchImpl(`${options.baseUrl}/images/models`, { method: "GET", headers: headersFor(options.apiKey, false), signal });
  } catch (error) {
    return { ok: false, message: `${OPENROUTER_LABEL} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!listing.ok) return { ok: false, message: await refusalMessage(listing, OPENROUTER_LABEL, options.apiKey) };
  let models: OpenRouterImageModel[];
  try {
    models = parseImageModels(await listing.json());
  } catch {
    return { ok: false, message: `${OPENROUTER_LABEL} sent a model list Roqer could not read.` };
  }
  const found = models.find((model) => model.id === options.model);
  if (found !== undefined) {
    const takesPng = found.capabilities.outputFormats === undefined || found.capabilities.outputFormats.includes("png");
    return { ok: takesPng, message: `${OPENROUTER_LABEL} lists ${options.model} as an image model. It takes ${describeCapabilities(found.capabilities)}.` };
  }
  const examples = models.slice(0, 6).map((model) => model.id).join(", ");
  let listed = false;
  try {
    const all = await fetchImpl(`${options.baseUrl}/models`, { method: "GET", headers: headersFor(options.apiKey, false), signal });
    if (all.ok) {
      const payload: unknown = await all.json();
      listed = isRecord(payload) && Array.isArray(payload.data) && payload.data.some((entry) => isRecord(entry) && entry.id === options.model);
    }
  } catch {
    // The image list is the answer; the full list only sharpens the message.
  }
  return {
    ok: false,
    message: listed
      ? `${OPENROUTER_LABEL} has ${options.model}, but not as an image model. Its image models include ${examples}.`
      : `${OPENROUTER_LABEL} does not list ${options.model}. Its image models include ${examples}.`,
  };
}
