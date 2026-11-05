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

/** The list as OpenRouter sends it: one model with every field, one that makes a single picture and no transparency, one with no parameters. */
const MODELS = {
  data: [
    {
      id: "openai/gpt-image-1", name: "OpenAI: GPT Image 1",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: {
        aspect_ratio: { enum: ["1:1", "3:2", "2:3", "auto"] },
        output_format: { enum: ["png", "jpeg", "webp"] },
        quality: { enum: ["auto", "low", "medium", "high"] },
        background: { enum: ["auto", "transparent", "opaque"] },
        n: { range: [1, 10] },
        input_references: { range: [0, 16] },
      },
    },
    {
      id: "google/gemini-2.5-flash-image", name: "Google: Nano Banana",
      supported_parameters: { aspect_ratio: { enum: ["1:1", "16:9"] }, output_format: { enum: ["png", "jpeg"] }, n: { range: [1, 1] } },
    },
    { id: "recraft/recraft-v4-vector", name: "Recraft V4 Vector", supported_parameters: { output_format: { enum: ["svg"] } } },
    { name: "no id" },
  ],
};

test.beforeEach(() => forgetOpenRouterModels());

test("the model list is read to what each model takes", () => {
  const models = parseImageModels(MODELS);
  assert.deepEqual(models.map((model) => model.id), ["openai/gpt-image-1", "google/gemini-2.5-flash-image", "recraft/recraft-v4-vector"]);
  assert.deepEqual(models[0].capabilities, {
    aspectRatios: ["1:1", "3:2", "2:3", "auto"], outputFormats: ["png", "jpeg", "webp"], qualities: ["auto", "low", "medium", "high"],
    backgrounds: ["auto", "transparent", "opaque"], maxCount: 10, maxReferences: 16,
  });
  assert.deepEqual(models[1].capabilities, { aspectRatios: ["1:1", "16:9"], outputFormats: ["png", "jpeg"], maxCount: 1 });
  assert.deepEqual(models[2].capabilities, { outputFormats: ["svg"] });
  assert.deepEqual(parseImageModels({ nothing: true }), []);
  assert.deepEqual(parseImageModels("no"), []);
});

test("a request sends only the fields the model takes, and asks in words for what it does not", () => {
  const [full, single] = parseImageModels(MODELS).map((model) => model.capabilities);
  assert.deepEqual(openRouterBody("openai/gpt-image-1", request, full, 2), {
    model: "openai/gpt-image-1", prompt: "a soft white glow", n: 2, aspect_ratio: "1:1", quality: "medium", output_format: "png", background: "transparent",
  });
  assert.deepEqual(openRouterBody("openai/gpt-image-1", { ...request, background: "opaque", size: "1536x1024", count: 1 }, full, 1), {
    model: "openai/gpt-image-1", prompt: "a soft white glow", aspect_ratio: "3:2", quality: "medium", output_format: "png", background: "opaque",
  });
  // No background field: asked for in words, like a compatible server; no quality field: left out.
  assert.deepEqual(openRouterBody("google/gemini-2.5-flash-image", request, single, 1), {
    model: "google/gemini-2.5-flash-image", prompt: "a soft white glow, isolated on a fully transparent background", aspect_ratio: "1:1", output_format: "png",
  });
  assert.deepEqual(openRouterBody("google/gemini-2.5-flash-image", { ...request, background: "black", size: "1024x1536" }, single, 1), {
    model: "google/gemini-2.5-flash-image", prompt: "a soft white glow, on a solid pure black background with nothing else in the frame", output_format: "png",
  }, "a ratio the model does not list is left out");
  // Unknown model: the common fields, one picture a call.
  assert.deepEqual(openRouterBody("x/y", request, undefined, 1), {
    model: "x/y", prompt: "a soft white glow, isolated on a fully transparent background", aspect_ratio: "1:1", output_format: "png",
  });
  const reference = { ...request, reference: { bytes: png, name: "glow.png" } };
  const withReference = openRouterBody("openai/gpt-image-1", reference, full, 1);
  assert.deepEqual(withReference.input_references, [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }]);
  assert.equal(openRouterBody("google/gemini-2.5-flash-image", reference, single, 1).input_references, undefined, "a model that takes no references is sent none");
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
