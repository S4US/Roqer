import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRequest } from "./openai-images";
import {
  aspectRatioFor, checkOpenRouterSource, describeCapabilities, forgetOpenRouterModels, openRouterBody, OpenRouterImageSource, parseImageModels,
  picturesPerCall,
} from "./openrouter-images";
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
 * Entries copied from OpenRouter's live GET /images/models (November 2026). Keep
 * this the provider's real shape: a fixture written from what the parser
 * expects once hid a parser that read no model's fields at all.
 */
const MODELS = {
  data: [
    {
      id: "openai/gpt-image-1", name: "OpenAI: GPT Image 1",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1", "3:2", "2:3", "auto"] },
        quality: { type: "enum", values: ["auto", "low", "medium", "high"] },
        background: { type: "enum", values: ["auto", "transparent", "opaque"] },
        n: { type: "range", min: 1, max: 10 },
        input_references: { type: "range", min: 0, max: 16 },
        output_compression: { type: "range", min: 0, max: 100 },
      },
    },
    {
      id: "openai/gpt-image-2.6-flare", name: "OpenAI: GPT Image 2.6 Flare",
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"] },
        output_format: { type: "enum", values: ["png", "jpeg", "webp", "gif"] },
        quality: { type: "enum", values: ["auto", "low", "medium", "high", "xhigh", "max"] },
        background: { type: "enum", values: ["auto", "transparent", "opaque"] },
        n: { type: "range", min: 1, max: 10 },
        input_references: { type: "range", min: 0, max: 16 },
        output_compression: { type: "range", min: 0, max: 100 },
      },
    },
    {
      id: "google/gemini-2.5-flash-image", name: "Google: Nano Banana (Gemini 2.5 Flash Image)",
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] },
        n: { type: "range", min: 1, max: 1 },
        input_references: { type: "range", min: 0, max: 3 },
      },
    },
    {
      id: "google/gemini-3.1-flash-image", name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)",
      supported_parameters: {
        resolution: { type: "enum", values: ["512", "1K", "2K", "4K"] },
        aspect_ratio: { type: "enum", values: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"] },
        n: { type: "range", min: 1, max: 1 },
        input_references: { type: "range", min: 0, max: 14 },
      },
    },
    {
      id: "recraft/recraft-v4-vector", name: "Recraft: Recraft V4 Vector",
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1", "4:3", "3:4", "16:9", "9:16", "auto"] },
        output_format: { type: "enum", values: ["svg"] },
        n: { type: "range", min: 1, max: 6 },
        input_references: { type: "range", min: 0, max: 1 },
      },
    },
    { name: "no id" },
  ],
};

test.beforeEach(() => forgetOpenRouterModels());

test("the model list is read to what each model takes", () => {
  const models = parseImageModels(MODELS);
  assert.deepEqual(models.map((model) => model.id), [
    "openai/gpt-image-1", "openai/gpt-image-2.6-flare", "google/gemini-2.5-flash-image", "google/gemini-3.1-flash-image", "recraft/recraft-v4-vector",
  ]);
  assert.deepEqual(models[0].capabilities, {
    aspectRatios: ["1:1", "3:2", "2:3", "auto"], qualities: ["auto", "low", "medium", "high"],
    backgrounds: ["auto", "transparent", "opaque"], maxCount: 10, maxReferences: 16,
  });
  assert.deepEqual(models[2].capabilities, {
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], maxCount: 1, maxReferences: 3,
  });
  assert.deepEqual(models[3].capabilities.resolutions, ["512", "1K", "2K", "4K"]);
  assert.deepEqual(models[4].capabilities.outputFormats, ["svg"]);
  assert.deepEqual(parseImageModels({ nothing: true }), []);
  assert.deepEqual(parseImageModels("no"), []);
});

test("a call to a model that lists its fields sends the ratio, format, quality and background it was asked for", () => {
  const flare = parseImageModels(MODELS).find((model) => model.id === "openai/gpt-image-2.6-flare");
  assert.ok(flare);
  assert.deepEqual(openRouterBody(flare.id, { prompt: "a white star", kind: "matter", background: "transparent", size: "512x512", count: 1, quality: "low" }, flare.capabilities, 1), {
    model: "openai/gpt-image-2.6-flare", prompt: "a white star", aspect_ratio: "1:1", quality: "low", output_format: "png", background: "transparent",
  });
  assert.equal(describeCapabilities(flare.capabilities), "a transparent background, a quality, an aspect ratio, up to 10 pictures a call, reference pictures to edit");
});

test("a request sends only the fields the model takes, and asks in words for what it does not", () => {
  const capabilitiesOf = (id: string) => parseImageModels(MODELS).find((model) => model.id === id)?.capabilities;
  const full = capabilitiesOf("openai/gpt-image-1");
  const single = capabilitiesOf("google/gemini-2.5-flash-image");
  const tiered = capabilitiesOf("google/gemini-3.1-flash-image");
  const vector = capabilitiesOf("recraft/recraft-v4-vector");
  assert.deepEqual(openRouterBody("openai/gpt-image-1", request, full, 2), {
    model: "openai/gpt-image-1", prompt: "a soft white glow", n: 2, aspect_ratio: "1:1", quality: "medium", background: "transparent",
  });
  assert.deepEqual(openRouterBody("openai/gpt-image-1", { ...request, background: "opaque", size: "1536x1024", count: 1 }, full, 1), {
    model: "openai/gpt-image-1", prompt: "a soft white glow", aspect_ratio: "3:2", quality: "medium", background: "opaque",
  });
  // No background field: asked for in words, like a compatible server; no quality or format field: left out.
  assert.deepEqual(openRouterBody("google/gemini-2.5-flash-image", request, single, 1), {
    model: "google/gemini-2.5-flash-image", prompt: "a soft white glow, isolated on a fully transparent background", aspect_ratio: "1:1",
  });
  assert.deepEqual(openRouterBody("recraft/recraft-v4-vector", { ...request, background: "black", size: "1024x1536" }, vector, 1), {
    model: "recraft/recraft-v4-vector", prompt: "a soft white glow, on a solid pure black background with nothing else in the frame",
  }, "a ratio or format the model does not list is left out");
  // A model with resolution tiers is asked for the tier nearest the size.
  assert.equal(openRouterBody("google/gemini-3.1-flash-image", { ...request, size: "512x512" }, tiered, 1).resolution, "512");
  assert.equal(openRouterBody("google/gemini-3.1-flash-image", request, tiered, 1).resolution, "1K");
  // Unknown model: the common fields, one picture a call.
  assert.deepEqual(openRouterBody("x/y", request, undefined, 1), {
    model: "x/y", prompt: "a soft white glow, isolated on a fully transparent background", aspect_ratio: "1:1", output_format: "png",
  });
  const reference = { ...request, reference: { bytes: png, name: "glow.png" } };
  const withReference = openRouterBody("openai/gpt-image-1", reference, full, 1);
  assert.deepEqual(withReference.input_references, [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }]);
  assert.equal(openRouterBody("x/y", reference, { maxReferences: 0 }, 1).input_references, undefined, "a model that takes no references is sent none");
  assert.equal(picturesPerCall(full, 3), 3);
  assert.equal(picturesPerCall(single, 3), 1);
  assert.equal(picturesPerCall(undefined, 3), 1);
  assert.equal(aspectRatioFor("512x512"), "1:1");
});

test("a generation reads the model list once, posts to /images with the app headers, and gathers the pictures", async () => {
  const picture = { b64_json: png.toString("base64"), media_type: "image/png" };
  const { fetch, sent } = endpoint([
    () => json(MODELS),
    () => json({ created: 1, data: [picture, picture] }),
  ]);
  const source = new OpenRouterImageSource({ baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-image-1", apiKey: "sk-or-test-123456", fetch });
  const result = await source.generate(request, new AbortController().signal);
  assert.equal(result.images.length, 2);
  assert.ok(result.images[0].equals(png));
  assert.equal(result.model, "openai/gpt-image-1");
  assert.equal(sent[0].url, "https://openrouter.ai/api/v1/images/models");
  assert.equal(sent[1].url, "https://openrouter.ai/api/v1/images");
  const headers = sent[1].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-or-test-123456");
  assert.equal(headers["X-Title"], "Roqer");
  assert.equal(JSON.parse(String(sent[1].init.body)).n, 2);

  // A model that makes one picture a call is asked once per picture, from the list already read.
  const again = endpoint([() => json({ data: [picture] }), () => json({ data: [picture] })]);
  const single = new OpenRouterImageSource({ baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash-image", apiKey: "sk-or-test-123456", fetch: again.fetch });
  assert.equal((await single.generate(request, new AbortController().signal)).images.length, 2);
  assert.equal(again.sent.length, 2, "two pictures, two calls, no second list");
  assert.equal(JSON.parse(String(again.sent[0].init.body)).n, undefined);
});

test("a picture that is not a PNG, a refusal, and an empty answer are each reported in Roqer's words", async () => {
  const jpeg = { b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64"), media_type: "image/jpeg" };
  const notPng = endpoint([() => json(MODELS), () => json({ data: [jpeg] })]);
  const source = (fetch: typeof globalThis.fetch, model = "openai/gpt-image-1") => new OpenRouterImageSource({ baseUrl: "https://openrouter.ai/api/v1", model, apiKey: "sk-or-test-123456", fetch, retries: 0 });
  await assert.rejects(source(notPng.fetch).generate(request, new AbortController().signal), /sent image\/jpeg from openai\/gpt-image-1; Roqer needs PNG/);
  // A list that cannot be read leaves the model unknown; the call itself still goes out.
  forgetOpenRouterModels();
  const refused = endpoint([() => json({ data: [] }, 500), () => json({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } }, 402)]);
  await assert.rejects(source(refused.fetch).generate(request, new AbortController().signal), /Insufficient credits/);
  forgetOpenRouterModels();
  const empty = endpoint([() => json({ data: [] }, 500), () => json({ created: 1, data: [] })]);
  await assert.rejects(source(empty.fetch).generate(request, new AbortController().signal), /sent no image/);
});

test("the settings test says whether OpenRouter lists the model as an image model, and what it takes", async () => {
  const base = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test-123456" };
  const listed = endpoint([() => json(MODELS)]);
  const full = await checkOpenRouterSource({ ...base, model: "openai/gpt-image-1", fetch: listed.fetch });
  assert.equal(full.ok, true);
  assert.match(full.message, /lists openai\/gpt-image-1 as an image model\. It takes a transparent background, a quality, an aspect ratio, up to 10 pictures a call, reference pictures to edit\./);
  const opaque = await checkOpenRouterSource({ ...base, model: "google/gemini-2.5-flash-image", fetch: endpoint([() => json(MODELS)]).fetch });
  assert.equal(opaque.ok, true);
  assert.match(opaque.message, /no transparent background, so light and matter textures come back opaque/);
  const vector = await checkOpenRouterSource({ ...base, model: "recraft/recraft-v4-vector", fetch: endpoint([() => json(MODELS)]).fetch });
  assert.equal(vector.ok, false);
  assert.match(vector.message, /no PNG output/);
  const chatOnly = endpoint([() => json(MODELS), () => json({ data: [{ id: "anthropic/claude-sonnet-4" }] })]);
  const chat = await checkOpenRouterSource({ ...base, model: "anthropic/claude-sonnet-4", fetch: chatOnly.fetch });
  assert.equal(chat.ok, false);
  assert.match(chat.message, /has anthropic\/claude-sonnet-4, but not as an image model\. Its image models include openai\/gpt-image-1/);
  const unknown = endpoint([() => json(MODELS), () => json({ data: [] })]);
  assert.match((await checkOpenRouterSource({ ...base, model: "nobody/nothing", fetch: unknown.fetch })).message, /does not list nobody\/nothing/);
  const badKey = endpoint([() => json({ error: { code: 401, message: "No auth credentials found" } }, 401)]);
  const refusal = await checkOpenRouterSource({ ...base, model: "openai/gpt-image-1", fetch: badKey.fetch });
  assert.equal(refusal.ok, false);
  assert.doesNotMatch(refusal.message, /sk-or-test-123456/);
  assert.equal(describeCapabilities({}), "no transparent background, so light and matter textures come back opaque, one picture a call");
});
