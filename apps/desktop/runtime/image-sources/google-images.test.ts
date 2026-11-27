import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRequest } from "./openai-images";
import {
  checkGoogleSource, geminiGenerateBody, googleAspectRatio, googleImageFamily, googleModelId, GoogleImageSource, imagenPredictBody, parseGeminiAnswer,
  parseImagenAnswer,
} from "./google-images";
import { rgbaPng } from "../test-rgba-png";

const png = rgbaPng(4, 4, () => [255, 255, 255, 255]);
const request: ImageRequest = { prompt: "a soft white glow", kind: "light", background: "transparent", size: "1024x1024", count: 2, quality: "medium" };

type Sent = { url: string; init: RequestInit };

function endpoint(answers: Array<(sent: Sent) => Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const record = { url: String(url), init: init ?? {} };
    sent.push(record);
    const answer = answers.shift();
    assert.ok(answer, `no scripted response ${sent.length}`);
    return answer(record);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/**
 * Answers copied from Google's Gemini API shape: `generateContent` reports
 * `modelVersion` and inline data under `candidates[].content.parts`, and
 * `predict` reports base64 bytes under `predictions[]`. Keep them the
 * provider's real shape, not what the parser expects.
 */
const GEMINI_ANSWER = {
  candidates: [{
    content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] },
    finishReason: "STOP",
  }],
  modelVersion: "gemini-2.5-flash-image-001",
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1_290, totalTokenCount: 1_302 },
};

const IMAGEN_ANSWER = {
  predictions: [{ bytesBase64Encoded: png.toString("base64"), mimeType: "image/png" }],
};

const MODELS = {
  models: [
    { name: "models/gemini-2.5-flash-image", displayName: "Gemini 2.5 Flash Image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/imagen-4.0-generate-001", displayName: "Imagen 4", supportedGenerationMethods: ["predict"] },
    { name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent"] },
  ],
};

const source = (fetch: typeof globalThis.fetch, model = "gemini-2.5-flash-image", retries = 0) => new GoogleImageSource({
  baseUrl: "https://generativelanguage.googleapis.com/v1beta", model, apiKey: "AIza-test-1234567890", fetch, retries,
});

test("Google's models split into Gemini and Imagen, and a size becomes the ratio each takes", () => {
  assert.equal(googleModelId("models/gemini-2.5-flash-image"), "gemini-2.5-flash-image");
  assert.equal(googleImageFamily("gemini-2.5-flash-image"), "gemini");
  assert.equal(googleImageFamily("models/imagen-4.0-generate-001"), "imagen");
  assert.equal(googleAspectRatio("1024x1024", "gemini"), "1:1");
  assert.equal(googleAspectRatio("512x512", "imagen"), "1:1");
  assert.equal(googleAspectRatio("1536x1024", "gemini"), "3:2");
  assert.equal(googleAspectRatio("1024x1536", "gemini"), "2:3");
  assert.equal(googleAspectRatio("1536x1024", "imagen"), "4:3");
  assert.equal(googleAspectRatio("1024x1536", "imagen"), "3:4");
});

test("a Gemini body carries the prompt with its background in words, the ratio and any reference", () => {
  const body = geminiGenerateBody({ ...request, count: 1, reference: { bytes: png, name: "glow.png" } });
  assert.deepEqual(body.contents, [{
    role: "user",
    parts: [
      { text: "a soft white glow, isolated on a fully transparent background" },
      { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
    ],
  }]);
  assert.deepEqual(body.generationConfig, { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } });
  assert.equal((geminiGenerateBody({ ...request, background: "black", kind: "matter" }).contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[0].text,
    "a soft white glow, on a solid pure black background with nothing else in the frame");
  // Imagen takes the prompt and how many pictures, and no reference.
  assert.deepEqual(imagenPredictBody({ ...request, count: 3 }), {
    instances: [{ prompt: "a soft white glow, isolated on a fully transparent background" }],
    parameters: { sampleCount: 3, aspectRatio: "1:1" },
  });
});

test("a Gemini model is asked once per picture and an Imagen model makes them in one call", async () => {
  const gemini = endpoint([() => json(GEMINI_ANSWER), () => json(GEMINI_ANSWER)]);
  const result = await source(gemini.fetch).generate(request, new AbortController().signal);
  assert.equal(result.images.length, 2);
  assert.ok(result.images[0].equals(png));
  assert.equal(result.model, "gemini-2.5-flash-image-001", "the model Google says answered is reported");
  assert.equal(gemini.sent.length, 2);
  assert.equal(gemini.sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
  const headers = gemini.sent[0].init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "AIza-test-1234567890");
  assert.equal(headers.authorization, undefined, "the key travels in Google's header, not in the URL");
  assert.equal(JSON.parse(String(gemini.sent[0].init.body)).generationConfig.imageConfig.aspectRatio, "1:1");

  const imagen = endpoint([() => json({ predictions: [...IMAGEN_ANSWER.predictions, ...IMAGEN_ANSWER.predictions] })]);
  const made = await source(imagen.fetch, "imagen-4.0-generate-001").generate(request, new AbortController().signal);
  assert.equal(made.images.length, 2);
  assert.equal(made.model, "imagen-4.0-generate-001");
  assert.equal(imagen.sent.length, 1, "one predict call made both pictures");
  assert.equal(imagen.sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict");
  assert.equal(JSON.parse(String(imagen.sent[0].init.body)).parameters.sampleCount, 2);
});

test("Imagen refuses a reference before spending anything on it", async () => {
  const untouched = endpoint([]);
  await assert.rejects(
    source(untouched.fetch, "imagen-4.0-generate-001").generate({ ...request, reference: { bytes: png, name: "glow.png" } }, new AbortController().signal),
    /Imagen makes a picture from the prompt alone/,
  );
  assert.equal(untouched.sent.length, 0);
});

test("a picture that is not a PNG, a blocked prompt, a refusal and an empty answer are each reported in Roqer's words", async () => {
  const jpeg = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: png.toString("base64") } }] }, finishReason: "STOP" }],
    modelVersion: "gemini-2.5-flash-image-001",
  };
  const notPng = endpoint([() => json(jpeg)]);
  await assert.rejects(source(notPng.fetch).generate(request, new AbortController().signal), /sent image\/jpeg from gemini-2\.5-flash-image; Roqer needs PNG/);

  const blocked = endpoint([() => json({ candidates: [], promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })]);
  await assert.rejects(source(blocked.fetch).generate(request, new AbortController().signal), /made no picture: the prompt was blocked \(PROHIBITED_CONTENT\)/);

  const refused = endpoint([() => json({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }, 429)]);
  await assert.rejects(source(refused.fetch).generate(request, new AbortController().signal), /status 429: Resource has been exhausted/);

  const empty = endpoint([() => json({ candidates: [] })]);
  await assert.rejects(source(empty.fetch).generate(request, new AbortController().signal), /sent no image/);
});

test("the settings test checks the model itself, then the model list, and reports what Google lists", async () => {
  const base = { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIza-test-1234567890" };
  const answered = endpoint([() => json({ name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] })]);
  const found = await checkGoogleSource({ ...base, model: "gemini-2.5-flash-image", fetch: answered.fetch });
  assert.equal(found.ok, true);
  assert.match(found.message, /answered for gemini-2\.5-flash-image/);

  const listed = endpoint([() => json({ error: { code: 404, message: "not found", status: "NOT_FOUND" } }, 404), () => json(MODELS)]);
  const imagen = await checkGoogleSource({ ...base, model: "imagen-4.0-generate-001", fetch: listed.fetch });
  assert.equal(imagen.ok, true);
  assert.match(imagen.message, /lists imagen-4\.0-generate-001/);
  assert.equal(listed.sent[1].url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");

  const unknown = endpoint([() => json({ error: { code: 404, message: "not found", status: "NOT_FOUND" } }, 404), () => json(MODELS)]);
  const missing = await checkGoogleSource({ ...base, model: "nobody/nothing", fetch: unknown.fetch });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /does not list nobody\/nothing\. Its image models include gemini-2\.5-flash-image, imagen-4\.0-generate-001/);

  const badKey = endpoint([() => json({ error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } }, 401)]);
  const refusal = await checkGoogleSource({ ...base, model: "gemini-2.5-flash-image", fetch: badKey.fetch });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /Check the API key/);
  assert.doesNotMatch(refusal.message, /AIza-test-1234567890/);
});

test("a relay's snake_case Gemini parts and Imagen's enhanced prompt are read too", () => {
  const relayed = parseGeminiAnswer({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: png.toString("base64") } }] } }] });
  assert.equal(relayed.images.length, 1);
  assert.equal(relayed.images[0].mimeType, "image/png");
  const enhanced = parseImagenAnswer({ predictions: [{ bytesBase64Encoded: png.toString("base64"), mimeType: "image/png", enhancedPrompt: "a brighter glow" }] });
  assert.equal(enhanced.revisedPrompt, "a brighter glow");
  assert.equal(enhanced.images.length, 1);
});
