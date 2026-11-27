import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRequest } from "./openai-images";
import {
  checkCloudflareSource, cloudflareFormBody, cloudflareImageFamily, cloudflareJsonBody, cloudflareSize, cloudflareTakesFixedSize, CloudflareImageSource,
  parseCloudflareAnswer,
} from "./cloudflare-images";
import { rgbaPng } from "../test-rgba-png";

const png = rgbaPng(4, 4, () => [255, 255, 255, 255]);
/** A JPEG's opening bytes: enough for the adapter to recognize one without decoding it. */
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF", "ascii"), Buffer.alloc(32)]);
const accountId = "023e105f4ecef8ad9ca31a8372d0c353";
const baseUrl = "https://api.cloudflare.com/client/v4/accounts";
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

/** The Run API's JSON shape, copied from Cloudflare's own answers. */
const RUN_ANSWER = { result: { image: png.toString("base64") }, success: true, errors: [], messages: [] };
/** Cloudflare's real shape: a UUID in `id` and the model name the Run path takes in `name`. */
const MODELS = {
  result: [
    { id: "5cdffa8e-1b1e-48e8-85f1-ab9b943cdd32", name: "@cf/black-forest-labs/flux-2-klein-4b" },
    { id: "e580c765-810c-4da3-936c-a2808892f14c", name: "@cf/black-forest-labs/flux-2-dev" },
    { id: "9e087485-23dc-47fa-997d-f5bfafc0c7cc", name: "@cf/leonardo/lucid-origin" },
    { id: "fd81c856-07a9-4965-9241-a124f369826c", name: "@cf/meta/llama-3.1-8b-instruct" },
  ],
  success: true,
  errors: [],
};

const source = (fetch: typeof globalThis.fetch, model = "@cf/black-forest-labs/flux-2-klein-4b", retries = 0) => new CloudflareImageSource({
  baseUrl, accountId, model, apiKey: "cf-test-1234567890", fetch, retries,
});

test("Cloudflare splits FLUX.2 from the JSON models and builds each body", () => {
  assert.equal(cloudflareImageFamily("@cf/black-forest-labs/flux-2-klein-4b"), "multipart");
  assert.equal(cloudflareImageFamily("@cf/black-forest-labs/flux-2-dev"), "multipart");
  assert.equal(cloudflareImageFamily("@cf/leonardo/lucid-origin"), "json");
  assert.equal(cloudflareImageFamily("@cf/black-forest-labs/flux-1-schnell"), "json");
  assert.equal(cloudflareTakesFixedSize("@cf/black-forest-labs/flux-1-schnell"), true);
  assert.equal(cloudflareTakesFixedSize("@cf/leonardo/lucid-origin"), false);
  assert.deepEqual(cloudflareSize("1536x1024"), { width: 1_536, height: 1_024 });
  assert.deepEqual(cloudflareSize("1024x1536"), { width: 1_024, height: 1_536 });

  const prompt = "a soft white glow, isolated on a fully transparent background";
  assert.deepEqual(cloudflareJsonBody("@cf/leonardo/lucid-origin", request), { prompt, width: 1_024, height: 1_024 });
  assert.deepEqual(cloudflareJsonBody("@cf/black-forest-labs/flux-1-schnell", request), { prompt });

  const form = cloudflareFormBody(request);
  assert.equal(form.get("prompt"), prompt);
  assert.equal(form.get("width"), "1024");
  assert.equal(form.get("height"), "1024");
  assert.equal(form.get("steps"), null, "Cloudflare's defaults are left alone");

  const black = cloudflareJsonBody("@cf/leonardo/phoenix-1.0", { ...request, background: "black", kind: "matter" });
  assert.equal(black.prompt, "a soft white glow, on a solid pure black background with nothing else in the frame");
});

test("FLUX.2 takes a form body, one request per picture, with the token in the header", async () => {
  const sent = endpoint([() => json(RUN_ANSWER), () => json(RUN_ANSWER)]);
  const result = await source(sent.fetch).generate(request, new AbortController().signal);
  assert.equal(result.images.length, 2);
  assert.ok(result.images[0].equals(png));
  assert.equal(result.model, "@cf/black-forest-labs/flux-2-klein-4b");
  assert.equal(sent.sent.length, 2, "the Run API makes one picture a call");
  assert.equal(sent.sent[0].url, `${baseUrl}/${accountId}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
  const headers = sent.sent[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer cf-test-1234567890");
  assert.equal(JSON.stringify(headers).includes("cf-test-1234567890"), true);
  assert.equal(sent.sent[0].url.includes("cf-test-1234567890"), false, "the token never travels in the URL");
  const form = sent.sent[0].init.body as FormData;
  assert.equal(form.get("prompt"), "a soft white glow, isolated on a fully transparent background");
  assert.equal(form.get("width"), "1024");
});

test("a JSON model is posted a JSON body with the width and height", async () => {
  const sent = endpoint([() => json(RUN_ANSWER)]);
  const result = await source(sent.fetch, "@cf/leonardo/lucid-origin").generate({ ...request, count: 1, size: "1536x1024" }, new AbortController().signal);
  assert.equal(result.images.length, 1);
  assert.equal(sent.sent[0].url, `${baseUrl}/${accountId}/ai/run/@cf/leonardo/lucid-origin`);
  const headers = sent.sent[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(sent.sent[0].init.body)), {
    prompt: "a soft white glow, isolated on a fully transparent background", width: 1_536, height: 1_024,
  });
});

test("a raw JPEG answer is kept as the bytes Cloudflare sent, for the worker to turn into a PNG", async () => {
  const sent = endpoint([() => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } })]);
  const result = await source(sent.fetch, "@cf/leonardo/phoenix-1.0").generate({ ...request, count: 1 }, new AbortController().signal);
  assert.equal(result.images.length, 1);
  assert.ok(result.images[0].equals(jpeg));
});

test("an answer that is neither PNG nor JPEG is refused in Roqer's words", async () => {
  const sent = endpoint([() => json({ result: { image: Buffer.from("not a picture").toString("base64") }, success: true, errors: [] })]);
  await assert.rejects(source(sent.fetch, "@cf/leonardo/lucid-origin").generate({ ...request, count: 1 }, new AbortController().signal),
    /Cloudflare sent a picture that is not a PNG or a JPEG from @cf\/leonardo\/lucid-origin; Roqer needs PNG or JPEG output/);
});

test("Cloudflare's own refusal and a missing answer are reported", async () => {
  const refused = endpoint([() => json({ result: {}, success: false, errors: [{ code: 5_000, message: "Model not found" }], messages: [] })]);
  await assert.rejects(source(refused.fetch).generate({ ...request, count: 1 }, new AbortController().signal), /made no picture: Model not found/);

  const empty = endpoint([() => json({ result: {}, success: true, errors: [], messages: [] })]);
  await assert.rejects(source(empty.fetch).generate({ ...request, count: 1 }, new AbortController().signal), /sent no image/);
});

test("a reference is refused before spending anything, and an empty account id is refused", async () => {
  const untouched = endpoint([]);
  const touched = source(untouched.fetch);
  await assert.rejects(touched.generate({ ...request, reference: { bytes: png, name: "glow.png" } }, new AbortController().signal),
    /Cloudflare cannot vary a picture with @cf\/black-forest-labs\/flux-2-klein-4b.*Choose Google's Gemini or OpenAI/);
  assert.equal(untouched.sent.length, 0);

  const noAccount = endpoint([]);
  const unset = new CloudflareImageSource({ baseUrl, accountId: "", model: "@cf/black-forest-labs/flux-2-klein-4b", apiKey: "cf-test-1234567890", fetch: noAccount.fetch });
  await assert.rejects(unset.generate(request, new AbortController().signal), /Cloudflare needs an account ID/);
  assert.equal(noAccount.sent.length, 0);
});

test("Cloudflare being busy is retried; a refusal carries its words and not the token", async () => {
  const busy = endpoint([() => json({ errors: [{ code: 10_000, message: "busy" }], success: false }, 429), () => json(RUN_ANSWER)]);
  const result = await source(busy.fetch, "@cf/black-forest-labs/flux-2-klein-4b", 1).generate({ ...request, count: 1 }, new AbortController().signal);
  assert.equal(result.images.length, 1);
  assert.equal(busy.sent.length, 2);

  const refused = endpoint([() => json({ errors: [{ code: 10_000, message: "Authentication error" }], success: false }, 401)]);
  await assert.rejects(source(refused.fetch).generate({ ...request, count: 1 }, new AbortController().signal), (error: Error) => {
    assert.match(error.message, /Authentication error/);
    assert.match(error.message, /Check the API key/);
    assert.doesNotMatch(error.message, /cf-test-1234567890/);
    return true;
  });
});

test("the settings test asks the model list and reports what Cloudflare lists", async () => {
  const listed = endpoint([() => json(MODELS)]);
  const found = await checkCloudflareSource({ baseUrl, accountId, apiKey: "cf-test-1234567890", model: "@cf/black-forest-labs/flux-2-klein-4b", fetch: listed.fetch });
  assert.equal(found.ok, true);
  assert.match(found.message, /Cloudflare lists @cf\/black-forest-labs\/flux-2-klein-4b/);
  assert.equal(listed.sent[0].url, `${baseUrl}/${accountId}/ai/models/search?per_page=100`);

  const unknown = endpoint([() => json(MODELS)]);
  const missing = await checkCloudflareSource({ baseUrl, accountId, apiKey: "cf-test-1234567890", model: "nobody/nothing", fetch: unknown.fetch });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /does not list nobody\/nothing\. Its image models include @cf\/black-forest-labs\/flux-2-klein-4b, @cf\/black-forest-labs\/flux-2-dev, @cf\/leonardo\/lucid-origin/);

  const noAccount = endpoint([]);
  const unset = await checkCloudflareSource({ baseUrl, accountId: "", apiKey: "cf-test-1234567890", model: "@cf/black-forest-labs/flux-2-klein-4b", fetch: noAccount.fetch });
  assert.equal(unset.ok, false);
  assert.match(unset.message, /Save your Cloudflare account ID first/);
  assert.equal(noAccount.sent.length, 0);

  const badKey = endpoint([() => json({ errors: [{ code: 10_000, message: "Authentication error" }], success: false }, 401)]);
  const refusal = await checkCloudflareSource({ baseUrl, accountId, apiKey: "cf-test-1234567890", model: "@cf/black-forest-labs/flux-2-klein-4b", fetch: badKey.fetch });
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /Check the API key/);
  assert.doesNotMatch(refusal.message, /cf-test-1234567890/);
});

test("the JSON parser reads the result image, its errors and an empty answer", () => {
  assert.equal(parseCloudflareAnswer(RUN_ANSWER).images.length, 1);
  const failed = parseCloudflareAnswer({ result: {}, success: false, errors: [{ code: 5_000, message: "No such model" }] });
  assert.equal(failed.images.length, 0);
  assert.equal(failed.refusal, "No such model");
  const empty = parseCloudflareAnswer({ result: {}, success: true, errors: [] });
  assert.equal(empty.images.length, 0);
  assert.equal(empty.refusal, undefined);
});
