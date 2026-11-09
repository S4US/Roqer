import type { ImageSourceKind } from "../../shared/image-generation";
import { checkImageSource, OpenAiImageSource, type ImageSource } from "./openai-images";
import { checkOpenRouterSource, OpenRouterImageSource } from "./openrouter-images";

/** The saved settings a source is built from, with the key already decrypted. */
export type ImageSourceChoice = Readonly<{ source: ImageSourceKind; baseUrl: string; model: string; apiKey: string | null; fetch?: typeof globalThis.fetch }>;

/** The source the settings name. */
export function createImageSource(choice: ImageSourceChoice): ImageSource {
  if (choice.source === "openrouter") {
    return new OpenRouterImageSource({ baseUrl: choice.baseUrl, model: choice.model, apiKey: choice.apiKey, ...(choice.fetch === undefined ? {} : { fetch: choice.fetch }) });
  }
  return new OpenAiImageSource({ source: choice.source, baseUrl: choice.baseUrl, model: choice.model, apiKey: choice.apiKey, ...(choice.fetch === undefined ? {} : { fetch: choice.fetch }) });
}

/** Asks the settings' source about the model without making a picture. */
export function testImageSource(choice: ImageSourceChoice, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  return choice.source === "openrouter" ? checkOpenRouterSource(choice, signal) : checkImageSource(choice, signal);
}
