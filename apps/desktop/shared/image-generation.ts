/**
 * The opt-in image tool, as the main process and the renderer both see it.
 *
 * Roqer can ask an image model for a picture: a particle sprite, a light
 * texture, an icon, a decal, a tileable surface. The model is the user's own,
 * through a key they entered or a server they run, and the tool is offered
 * only while they turned it on. A call spends their key or plan and sends the
 * prompt to a third party, so it is irreversible: it asks in every mode but
 * Full auto, and a run keeps a bounded number of pictures whatever the mode.
 */

/** The run-engine operation an image call travels as: approved and cancelled like any tool. */
export const IMAGE_OPERATION = "generate_image";

/** The model-facing tool name, offered only while an image source is on. */
export const IMAGE_TOOL_NAME = "image";

export const MAX_IMAGE_PROMPT_CHARACTERS = 2_000;
export const MAX_IMAGES_PER_CALL = 4;
/** Pictures one run may make, in every mode: a bound on spend and disk, not a product limit. */
export const MAX_IMAGES_PER_RUN = 24;

export const IMAGE_KINDS = ["light", "matter", "icon", "decal", "tile"] as const;
export type ImageKind = typeof IMAGE_KINDS[number];

export const IMAGE_BACKGROUNDS = ["transparent", "black", "opaque"] as const;
export type ImageBackground = typeof IMAGE_BACKGROUNDS[number];

export const IMAGE_SIZES = ["512x512", "1024x1024", "1536x1024", "1024x1536"] as const;
export type ImageSize = typeof IMAGE_SIZES[number];

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = typeof IMAGE_QUALITIES[number];

/** A job's id, which a later call names in `reference.output` to vary one of its pictures. */
export const IMAGE_JOB_ID_PATTERN = "^[0-9a-f]{8}$";
/** A file stem the model chooses: plain, lower case, so the file is what the result named. */
export const IMAGE_NAME_PATTERN = "^[a-z][a-z0-9_]{0,31}$";

export function isImageJobId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(IMAGE_JOB_ID_PATTERN).test(value);
}

export function isImageOutputName(value: unknown): value is string {
  return typeof value === "string" && new RegExp(IMAGE_NAME_PATTERN).test(value);
}

export const isImageKind = (value: unknown): value is ImageKind => IMAGE_KINDS.includes(value as ImageKind);
export const isImageBackground = (value: unknown): value is ImageBackground => IMAGE_BACKGROUNDS.includes(value as ImageBackground);
export const isImageSize = (value: unknown): value is ImageSize => IMAGE_SIZES.includes(value as ImageSize);
export const isImageQuality = (value: unknown): value is ImageQuality => IMAGE_QUALITIES.includes(value as ImageQuality);

/** What a kind is drawn on unless the call says otherwise: light on black, matter and icons on transparent, the rest opaque. */
export function defaultBackground(kind: ImageKind): ImageBackground {
  if (kind === "light") return "black";
  if (kind === "matter" || kind === "icon") return "transparent";
  return "opaque";
}

export function defaultSize(kind: ImageKind): ImageSize {
  return kind === "icon" ? "512x512" : "1024x1024";
}

/**
 * Where pictures come from: OpenAI's image API; OpenRouter's image API, which
 * fronts many image models under one key; Google's Gemini API, which serves
 * Gemini's native image models and Imagen; Cloudflare's Workers AI, which
 * serves FLUX, Leonardo and Stability image models under an account; or any
 * server that speaks OpenAI's shape (a local one included).
 */
export const IMAGE_SOURCE_KINDS = ["openai", "openrouter", "google", "cloudflare", "openai-compatible"] as const;
export type ImageSourceKind = typeof IMAGE_SOURCE_KINDS[number];
export const isImageSourceKind = (value: unknown): value is ImageSourceKind => IMAGE_SOURCE_KINDS.includes(value as ImageSourceKind);

export const DEFAULT_IMAGE_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** OpenAI's image model through OpenRouter: it takes a transparent background, which the light and matter kinds need. */
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-image-1";
/** The Gemini API, whose key from Google AI Studio reaches Gemini's image models and Imagen. */
export const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Gemini's fast native image model, the one Google calls Nano Banana; an Imagen id also works. */
export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-image";
/** Workers AI's run endpoint root; the account id is appended as the next path segment. */
export const DEFAULT_CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4/accounts";
/** FLUX.2's fast model: the cheapest Cloudflare picture worth starting from for game assets. */
export const DEFAULT_CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

/** The address a source is reached at unless the user names one; a compatible server has no default. */
export function defaultImageBaseUrl(source: ImageSourceKind): string | undefined {
  if (source === "openai") return DEFAULT_IMAGE_BASE_URL;
  if (source === "openrouter") return DEFAULT_OPENROUTER_BASE_URL;
  if (source === "google") return DEFAULT_GOOGLE_BASE_URL;
  if (source === "cloudflare") return DEFAULT_CLOUDFLARE_BASE_URL;
  return undefined;
}

export function defaultImageModel(source: ImageSourceKind): string | undefined {
  if (source === "openai") return DEFAULT_IMAGE_MODEL;
  if (source === "openrouter") return DEFAULT_OPENROUTER_MODEL;
  if (source === "google") return DEFAULT_GOOGLE_MODEL;
  if (source === "cloudflare") return DEFAULT_CLOUDFLARE_MODEL;
  return undefined;
}

/** OpenAI, OpenRouter, Google and Cloudflare refuse a call without a key; a server of the user's own may take none. */
export function imageSourceNeedsKey(source: ImageSourceKind): boolean {
  return source === "openai" || source === "openrouter" || source === "google" || source === "cloudflare";
}

export function imageSourceLabel(source: ImageSourceKind): string {
  if (source === "openai") return "OpenAI";
  if (source === "openrouter") return "OpenRouter";
  if (source === "google") return "Google";
  if (source === "cloudflare") return "Cloudflare";
  return "the image server";
}
export const MAX_IMAGE_MODEL_CHARS = 100;
/** Cloudflare's account id is a short dashboard token; this bounds what is kept, not what is typical. */
export const MAX_IMAGE_ACCOUNT_CHARS = 64;
/** Keys run to a couple of hundred characters; this bounds what is kept, not what is typical. */
export const MAX_IMAGE_KEY_CHARACTERS = 4_096;

/** Cloudflare's account id, the one Workers AI shows next to its API token; empty means not saved yet. */
export function isImageAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IMAGE_ACCOUNT_CHARS && /^[A-Za-z0-9_-]*$/.test(value);
}

/** One model the Settings form offers by name, with a line on why it is worth choosing. */
export type ImageModelPreset = Readonly<{ id: string; name: string; detail: string }>;

/**
 * Model suggestions per source, so the model field does not start empty. The
 * Cloudflare list is picked for game assets: FLUX.2 Klein 4B and 9B for quick
 * iteration, FLUX.2 Dev for the most detail, Lucid Origin for graphic icons and
 * readable text, Phoenix for concept art, and FLUX.1 Schnell for cheap drafts.
 */
export const IMAGE_MODEL_PRESETS: Readonly<Record<ImageSourceKind, readonly ImageModelPreset[]>> = {
  openai: [],
  openrouter: [],
  google: [],
  cloudflare: [
    { id: "@cf/black-forest-labs/flux-2-klein-4b", name: "FLUX.2 Klein 4B", detail: "fast drafts and variations" },
    { id: "@cf/black-forest-labs/flux-2-klein-9b", name: "FLUX.2 Klein 9B", detail: "more detail than 4B, still quick" },
    { id: "@cf/black-forest-labs/flux-2-dev", name: "FLUX.2 Dev", detail: "the most detail, slower" },
    { id: "@cf/leonardo/lucid-origin", name: "Leonardo Lucid Origin", detail: "graphic icons and readable text" },
    { id: "@cf/leonardo/phoenix-1.0", name: "Leonardo Phoenix", detail: "concept art and coherent text" },
    { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 Schnell", detail: "very fast, cheap drafts at a fixed size" },
  ],
  "openai-compatible": [],
};

export function imageModelPresets(source: ImageSourceKind): readonly ImageModelPreset[] {
  return IMAGE_MODEL_PRESETS[source];
}

/**
 * Where the image tool stands.
 * - `ready`: on, with a source that can be called.
 * - `off`: set up but not turned on.
 * - `missing`: on or off, but the source needs a key or an account and none is saved.
 */
export type ImageSettingsState = "ready" | "off" | "missing";

export type ImageSettingsView = Readonly<{
  enabled: boolean;
  source: ImageSourceKind;
  baseUrl: string;
  model: string;
  /** Cloudflare's account id; empty for the sources that do not use one. */
  accountId: string;
  hasKey: boolean;
  quality: ImageQuality;
  state: ImageSettingsState;
  /** One sentence for Settings. */
  message: string;
  /** Set once after the saved file was damaged and moved aside. */
  damagedNotice?: string;
}>;

/** A save from Settings. `apiKey` absent keeps the saved key, `null` removes it, a string replaces it. */
export type ImageSettingsSave = Readonly<{
  enabled?: boolean;
  source?: ImageSourceKind;
  baseUrl?: string;
  model?: string;
  accountId?: string;
  apiKey?: string | null;
  quality?: ImageQuality;
}>;

export type ImageSettingsResult =
  | Readonly<{ ok: true; settings: ImageSettingsView }>
  | Readonly<{ ok: false; message: string }>;

/** What Test found: a sentence either way. */
export type ImageTestResult = Readonly<{ ok: boolean; message: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STATES: readonly ImageSettingsState[] = ["ready", "off", "missing"];

export function isImageSettingsResult(value: unknown): value is ImageSettingsResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.message === "string";
  if (value.ok !== true || !isRecord(value.settings)) return false;
  const settings = value.settings;
  return typeof settings.enabled === "boolean" && isImageSourceKind(settings.source) &&
    typeof settings.baseUrl === "string" && typeof settings.model === "string" &&
    typeof settings.accountId === "string" &&
    typeof settings.hasKey === "boolean" && isImageQuality(settings.quality) &&
    STATES.includes(settings.state as ImageSettingsState) && typeof settings.message === "string" &&
    (settings.damagedNotice === undefined || typeof settings.damagedNotice === "string");
}

export function isImageTestResult(value: unknown): value is ImageTestResult {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string";
}

/** A save as the window sends it, checked field by field; anything else is refused whole. */
export function parseImageSettingsSave(value: unknown): { save: ImageSettingsSave } | { message: string } {
  if (!isRecord(value)) return { message: "The image settings were not valid." };
  const save: Record<string, unknown> = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") return { message: "enabled must be true or false." };
    save.enabled = value.enabled;
  }
  if (value.source !== undefined) {
    if (!isImageSourceKind(value.source)) return { message: "Choose OpenAI, OpenRouter, Google, Cloudflare or an OpenAI-compatible server." };
    save.source = value.source;
  }
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== "string" || value.baseUrl.length > 2_048) return { message: "The server address is not valid." };
    save.baseUrl = value.baseUrl.trim();
  }
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || value.model.trim() === "" || value.model.length > MAX_IMAGE_MODEL_CHARS) return { message: "The model name is not valid." };
    save.model = value.model.trim();
  }
  if (value.accountId !== undefined) {
    if (typeof value.accountId !== "string") return { message: "The Cloudflare account ID is not valid." };
    const accountId = value.accountId.trim();
    if (!isImageAccountId(accountId)) return { message: "The Cloudflare account ID is not valid." };
    save.accountId = accountId;
  }
  if (value.apiKey !== undefined) {
    if (value.apiKey !== null && (typeof value.apiKey !== "string" || value.apiKey.length > MAX_IMAGE_KEY_CHARACTERS)) return { message: "The key is not valid." };
    save.apiKey = value.apiKey;
  }
  if (value.quality !== undefined) {
    if (!isImageQuality(value.quality)) return { message: "quality must be low, medium or high." };
    save.quality = value.quality;
  }
  return { save: save as ImageSettingsSave };
}
