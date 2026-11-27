import type { ImageSourceKind } from "../../shared/image-generation";
import { checkCloudflareSource, CloudflareImageSource } from "./cloudflare-images";
import { checkGoogleSource, GoogleImageSource } from "./google-images";
import { checkImageSource, OpenAiImageSource, type ImageSource } from "./openai-images";
import { checkOpenRouterSource, OpenRouterImageSource } from "./openrouter-images";

/** The saved settings a source is built from, with the key already decrypted. */
export type ImageSourceChoice = Readonly<{
  source: ImageSourceKind;
  baseUrl: string;
  model: string;
  accountId?: string;
  apiKey: string | null;
  fetch?: typeof globalThis.fetch;
}>;

/** The source the settings name. */
export function createImageSource(choice: ImageSourceChoice): ImageSource {
  if (choice.source === "openrouter") {
    return new OpenRouterImageSource({ baseUrl: choice.baseUrl, model: choice.model, apiKey: choice.apiKey, ...(choice.fetch === undefined ? {} : { fetch: choice.fetch }) });
  }
  if (choice.source === "google") {
    return new GoogleImageSource({ baseUrl: choice.baseUrl, model: choice.model, apiKey: choice.apiKey, ...(choice.fetch === undefined ? {} : { fetch: choice.fetch }) });
  }
  if (choice.source === "cloudflare") {
    return new CloudflareImageSource({
      baseUrl: choice.baseUrl, accountId: choice.accountId ?? "", model: choice.model, apiKey: choice.apiKey,
      ...(choice.fetch === undefined ? {} : { fetch: choice.fetch }),
    });
  }
  return new OpenAiImageSource({ source: choice.source, baseUrl: choice.baseUrl, model: choice.model, apiKey: choice.apiKey, ...(choice.fetch === undefined ? {} : { fetch: choice.fetch }) });
}

/** Asks the settings' source about the model without making a picture. */
export function testImageSource(choice: ImageSourceChoice, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  if (choice.source === "openrouter") return checkOpenRouterSource(choice, signal);
  if (choice.source === "google") return checkGoogleSource(choice, signal);
  if (choice.source === "cloudflare") return checkCloudflareSource({ ...choice, accountId: choice.accountId ?? "" }, signal);
  return checkImageSource(choice, signal);
}
