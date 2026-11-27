import type { ImageSize } from "../../shared/image-generation";
import { isTransientStatus, redact, refusalMessage, retryAfterMs } from "../model-api/http";
import { promptWithBackground, type GeneratedImages, type ImageRequest, type ImageSource } from "./openai-images";

/**
 * Cloudflare Workers AI, which serves image models from several studios under
 * one account: FLUX.2 (multipart form fields), FLUX.1 schnell, Leonardo Lucid
 * Origin and Phoenix, and the older Stable Diffusion family (JSON bodies).
 *
 * The Run API makes one picture a request. FLUX and Lucid Origin answer JSON
 * with a base64 `image`; the Stable Diffusion family, DreamShaper and Phoenix
 * answer raw bytes, and the declared content type is not always the real one.
 * Because Roqer keeps PNGs, the worker turns a returned JPEG into a PNG; this
 * adapter accepts either and rejects everything else. None of these models has
 * a background or quality field, so the background is asked for in words and
 * Roqer's quality setting is not sent.
 */

export const CLOUDFLARE_LABEL = "Cloudflare";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** The most of Cloudflare's own explanation that a message carries. */
const MAX_REPORTED_TEXT = 300;

/** FLUX.2's models take multipart form fields; every other Cloudflare model takes JSON. */
const MULTIPART_PREFIX = "@cf/black-forest-labs/flux-2-";

/** FLUX.1 schnell fixes its own size, so a width and height would be refused. */
const FIXED_SIZE_PREFIX = "@cf/black-forest-labs/flux-1-schnell";

/** One model list page: the catalog is smaller than this, so one page lists all of it. */
const MAX_MODEL_RESULTS = 100;

export type CloudflareImageSourceOptions = Readonly<{
  baseUrl: string;
  accountId: string;
  model: string;
  apiKey: string | null;
  label?: string;
  fetch?: typeof globalThis.fetch;
  /** The first wait before a retry; retries double it. */
  retryBaseMs?: number;
  retries?: number;
}>;

/** The two request shapes Cloudflare's image models take. */
export type CloudflareImageFamily = "multipart" | "json";

/** A picture as Cloudflare sent it, before Roqer checks it turned into a PNG. */
type CloudflareImage = Readonly<{ bytes: Buffer; mediaType?: string }>;

/** What one Cloudflare answer holds, whether it made a picture or explained why not. */
export type CloudflareAnswer = Readonly<{
  images: readonly CloudflareImage[];
  /** Cloudflare's own words for an answer that held no picture. */
  refusal?: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPng = (bytes: Buffer): boolean => bytes.subarray(0, 8).equals(PNG_SIGNATURE);
const isJpeg = (bytes: Buffer): boolean => bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_SIGNATURE);

/** The model id as Cloudflare spells it in the Run path. */
export function cloudflareModelId(model: string): string {
  return model.trim();
}

/** FLUX.2 takes a form body; every other current model takes JSON. */
export function cloudflareImageFamily(model: string): CloudflareImageFamily {
  return cloudflareModelId(model).startsWith(MULTIPART_PREFIX) ? "multipart" : "json";
}

/** FLUX.1 schnell is the one model that fixes its own picture size. */
export function cloudflareTakesFixedSize(model: string): boolean {
  return cloudflareModelId(model).startsWith(FIXED_SIZE_PREFIX);
}

/** The width and height Cloudflare's JSON models take, from Roqer's size name. */
export function cloudflareSize(size: ImageSize): { width: number; height: number } {
  const [width, height] = size.split("x").map(Number);
  return { width, height };
}

/** The prompt Cloudflare reads: the background in words, since it has no field for it. */
export function cloudflarePrompt(request: ImageRequest): string {
  return promptWithBackground(request.prompt, request.background, "openai-compatible");
}

/** The JSON body for Lucid Origin, Phoenix and the Stable Diffusion family. */
export function cloudflareJsonBody(model: string, request: ImageRequest): Record<string, unknown> {
  const prompt = cloudflarePrompt(request);
  if (cloudflareTakesFixedSize(model)) return { prompt };
  const { width, height } = cloudflareSize(request.size);
  return { prompt, width, height };
}

/** The multipart body FLUX.2 requires, even when the prompt is all there is to send. */
export function cloudflareFormBody(request: ImageRequest): FormData {
  const form = new FormData();
  form.set("prompt", cloudflarePrompt(request));
  const { width, height } = cloudflareSize(request.size);
  form.set("width", String(width));
  form.set("height", String(height));
  return form;
}

/** What a JSON answer from the Run API holds. */
export function parseCloudflareAnswer(payload: unknown): CloudflareAnswer {
  if (!isRecord(payload)) return { images: [] };
  const result = isRecord(payload.result) ? payload.result : undefined;
  const image = result !== undefined && typeof result.image === "string" ? result.image
    : typeof payload.image === "string" ? payload.image : undefined;
  if (image !== undefined && image !== "") {
    const bytes = Buffer.from(image, "base64");
    if (bytes.length > 0) return { images: [{ bytes }] };
  }
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  const note = errors.find((error) => typeof error.message === "string" && error.message !== "");
  const refusal = note !== undefined && typeof note.message === "string"
    ? note.message
    : payload.success === false ? "Cloudflare reported a failure without a reason" : undefined;
  return { images: [], ...(refusal === undefined ? {} : { refusal }) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Run was cancelled.")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("Run was cancelled.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class CloudflareImageSource implements ImageSource {
  readonly label: string;
  private readonly options: CloudflareImageSourceOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CloudflareImageSourceOptions) {
    this.options = options;
    this.label = options.label ?? CLOUDFLARE_LABEL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generate(request: ImageRequest, signal: AbortSignal): Promise<GeneratedImages> {
    if (request.reference !== undefined) {
      throw new Error(`${this.label} cannot vary a picture with ${this.options.model}: Roqer sends Cloudflare's image models the prompt alone. Choose Google's Gemini or OpenAI to edit or vary an earlier output.`);
    }
    if (this.options.accountId.trim() === "") throw new Error(`${this.label} needs an account ID. Save it in Settings → Images.`);
    const family = cloudflareImageFamily(this.options.model);
    const images: Buffer[] = [];
    while (images.length < request.count) {
      // The Run API answers one picture a request, so each seems its own call.
      const answer = await this.#call(family, request, signal);
      images.push(...this.#pictures(answer));
    }
    return { images: images.slice(0, request.count), model: this.options.model };
  }

  /** The pictures in an answer, or the reason there is none, in Roqer's words. */
  #pictures(answer: CloudflareAnswer): Buffer[] {
    if (answer.images.length === 0) {
      throw new Error(answer.refusal === undefined
        ? `${this.label} sent no image.`
        : `${this.label} made no picture: ${redact(answer.refusal, this.options.apiKey).slice(0, MAX_REPORTED_TEXT)}.`);
    }
    const images: Buffer[] = [];
    for (const image of answer.images) {
      if (!isPng(image.bytes) && !isJpeg(image.bytes)) {
        throw new Error(`${this.label} sent ${image.mediaType ?? "a picture that is not a PNG or a JPEG"} from ${this.options.model}; Roqer needs PNG or JPEG output.`);
      }
      images.push(image.bytes);
    }
    return images;
  }

  /** One request, retried while Cloudflare is busy or failing, in its own words when it refuses. */
  async #call(family: CloudflareImageFamily, request: ImageRequest, signal: AbortSignal): Promise<CloudflareAnswer> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(this.options.accountId.trim())}/ai/run/${this.options.model}`;
    const headers: Record<string, string> = { accept: "application/json, image/*" };
    if (this.options.apiKey !== null) headers.authorization = `Bearer ${this.options.apiKey}`;
    let body: string | FormData;
    if (family === "multipart") {
      body = cloudflareFormBody(request);
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(cloudflareJsonBody(this.options.model, request));
    }
    const retries = this.options.retries ?? 3;
    const base = this.options.retryBaseMs ?? 1_000;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error("Run was cancelled.");
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "POST", headers, body, signal });
      } catch (error) {
        if (signal.aborted) throw new Error("Run was cancelled.");
        if (attempt < retries) { await sleep(base * 2 ** attempt, signal); continue; }
        throw new Error(`${this.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) {
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.includes("application/json")) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw new Error(`${this.label} sent a response Roqer could not read.`);
          }
          return parseCloudflareAnswer(payload);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const mediaType = contentType.startsWith("image/") ? contentType.split(";")[0] : undefined;
        if (bytes.length === 0) return { images: [] };
        return { images: [{ bytes, ...(mediaType === undefined ? {} : { mediaType }) }] };
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

/**
 * The model names Cloudflare's list holds. Cloudflare puts a UUID in `id` and
 * the name the Run path takes (`@cf/...`) in `name`, so `name` is what the
 * settings test has to compare; `id` is only a fallback for an older answer.
 */
function listedModels(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.result)) return [];
  return payload.result.filter(isRecord)
    .map((model) => typeof model.name === "string" && model.name !== "" ? model.name : typeof model.id === "string" ? model.id : "")
    .filter((name) => name !== "");
}

/** Whether Cloudflare answers for the saved model, without making a picture. */
export async function checkCloudflareSource(
  options: Pick<CloudflareImageSourceOptions, "baseUrl" | "accountId" | "model" | "apiKey" | "label" | "fetch">,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const label = options.label ?? CLOUDFLARE_LABEL;
  const accountId = options.accountId.trim();
  if (accountId === "") return { ok: false, message: "Save your Cloudflare account ID first." };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey !== null) headers.authorization = `Bearer ${options.apiKey}`;
  const base = options.baseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(accountId)}/ai/models/search?per_page=${MAX_MODEL_RESULTS}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal });
  } catch (error) {
    return { ok: false, message: `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { ok: false, message: await refusalMessage(response, label, options.apiKey) };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, message: `${label} sent a model list Roqer could not read.` };
  }
  if (!isRecord(payload) || !Array.isArray(payload.result)) {
    return { ok: false, message: `${label} sent a model list Roqer could not read.` };
  }
  const ids = listedModels(payload);
  const model = cloudflareModelId(options.model);
  if (ids.includes(model)) return { ok: true, message: `${label} lists ${model}. Image calls will use it.` };

  const imageModels = ids.filter((id) => /black-forest-labs|leonardo|stable-diffusion|dreamshaper/i.test(id));
  const shown = imageModels.slice(0, 8).join(", ");
  return {
    ok: false,
    message: imageModels.length === 0
      ? `${label} does not list ${model} for this account; check the model id, the account ID, and that the API token has Workers AI Read and Edit.`
      : `${label} does not list ${model}. Its image models include ${shown}${imageModels.length > 8 ? ", …" : ""}.`,
  };
}
