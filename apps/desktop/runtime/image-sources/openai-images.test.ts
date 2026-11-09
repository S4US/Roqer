import assert from "node:assert/strict";
import test from "node:test";
import { checkImageSource, generationBody, OpenAiImageSource, promptWithBackground, type ImageRequest } from "./openai-images";
import { rgbaPng } from "../test-rgba-png";

const png = rgbaPng(4, 4, () => [255, 255, 255, 255]);
const request: ImageRequest = { prompt: "a soft white glow", kind: "light", background: "black", size: "1024x1024", count: 2, quality: "medium" };

type Sent = { url: string; init: RequestInit };

function endpoint(answers: Array<() => Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const answer = answers.shift();
    assert.ok(answer, `no scripted response ${sent.length}`);
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

test("OpenAI is asked with its own fields, and a compatible server with the common ones and the background in words", () => {
  assert.deepEqual(generationBody({ source: "openai", model: "gpt-image-1" }, { ...request, background: "transparent" }), {
    model: "gpt-image-1", prompt: "a soft white glow", n: 2, size: "1024x1024", quality: "medium", background: "transparent", output_format: "png",
  });
  assert.deepEqual(generationBody({ source: "openai", model: "gpt-image-1" }, request), {
    model: "gpt-image-1", prompt: "a soft white glow, on a solid pure black background with nothing else in the frame", n: 2, size: "1024x1024", quality: "medium", background: "opaque", output_format: "png",
  });
  assert.deepEqual(generationBody({ source: "openai-compatible", model: "flux" }, { ...request, background: "transparent" }), {
    model: "flux", prompt: "a soft white glow, isolated on a fully transparent background", n: 2, size: "1024x1024", response_format: "b64_json",
  });
  assert.equal(promptWithBackground("x", "opaque", "openai-compatible"), "x");
});

test("a generation posts JSON with the key, reads base64 pictures, and keeps the server's rewording", async () => {
  const { fetch, sent } = endpoint([() => json({ created: 1, data: [{ b64_json: png.toString("base64"), revised_prompt: "A glow." }, { b64_json: png.toString("base64") }] })]);
  const source = new OpenAiImageSource({ source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "sk-test-1234567890", fetch });
  const result = await source.generate(request, new AbortController().signal);
  assert.equal(result.images.length, 2);
  assert.ok(result.images[0].equals(png));
  assert.equal(result.revisedPrompt, "A glow.");
  assert.equal(result.model, "gpt-image-1");
  assert.equal(sent[0].url, "https://api.openai.com/v1/images/generations");
  const headers = sent[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test-1234567890");
  assert.equal(JSON.parse(String(sent[0].init.body)).n, 2);
});

test("a busy server is tried again after the wait it asks for, and a refusal is reported with the key redacted", async () => {
  const { fetch, sent } = endpoint([
    () => json({ error: { message: "slow down" } }, 429, { "retry-after-ms": "1" }),
    () => json({ data: [{ b64_json: png.toString("base64") }] }),
  ]);
  const source = new OpenAiImageSource({ source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "sk-test-1234567890", fetch, retryBaseMs: 1 });
  const result = await source.generate({ ...request, count: 1 }, new AbortController().signal);
  assert.equal(result.images.length, 1);
  assert.equal(sent.length, 2);

  const refused = endpoint([() => json({ error: { message: "Incorrect API key provided: sk-test-1234567890" } }, 401)]);
  const bad = new OpenAiImageSource({ source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "sk-test-1234567890", fetch: refused.fetch, retryBaseMs: 1 });
  await assert.rejects(bad.generate(request, new AbortController().signal), (error: Error) => {
    assert.doesNotMatch(error.message, /sk-test-1234567890/);
    assert.match(error.message, /OpenAI/);
    return true;
  });
});

test("a linked picture is fetched over https, a non-PNG is refused, and an empty answer is an error", async () => {
  const { fetch } = endpoint([
    () => json({ data: [{ url: "https://files.example.com/out.png" }] }),
    () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
  ]);
  const source = new OpenAiImageSource({ source: "openai-compatible", baseUrl: "http://localhost:7860/v1", model: "flux", apiKey: null, fetch, retryBaseMs: 1 });
  const result = await source.generate({ ...request, count: 1 }, new AbortController().signal);
  assert.ok(result.images[0].equals(png));

  const jpeg = endpoint([() => json({ data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64") }] })]);
  const jpegSource = new OpenAiImageSource({ source: "openai-compatible", baseUrl: "http://localhost:7860/v1", model: "flux", apiKey: null, fetch: jpeg.fetch, retryBaseMs: 1 });
  await assert.rejects(jpegSource.generate(request, new AbortController().signal), /not a PNG/);

  const empty = endpoint([() => json({ data: [] })]);
  const emptySource = new OpenAiImageSource({ source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "k", fetch: empty.fetch, retryBaseMs: 1 });
  await assert.rejects(emptySource.generate(request, new AbortController().signal), /sent no image/);
});

test("a reference picture goes as a file in a multipart edit, beside the same fields", async () => {
  const { fetch, sent } = endpoint([() => json({ data: [{ b64_json: png.toString("base64") }] })]);
  const source = new OpenAiImageSource({ source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "k", fetch });
  await source.generate({ ...request, count: 1, background: "transparent", reference: { bytes: png, name: "glow.png" } }, new AbortController().signal);
  assert.equal(sent[0].url, "https://api.openai.com/v1/images/edits");
  const body = sent[0].init.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("model"), "gpt-image-1");
  assert.equal(body.get("background"), "transparent");
  const file = body.get("image");
  assert.ok(file instanceof Blob);
  assert.equal(file.size, png.length);
  assert.equal((sent[0].init.headers as Record<string, string>)["content-type"], undefined, "the runtime sets the multipart boundary");
});

test("a cancelled call ends quietly instead of retrying", async () => {
  const controller = new AbortController();
  const { fetch } = endpoint([() => { controller.abort(); return json({ error: { message: "busy" } }, 503); }]);
  const source = new OpenAiImageSource({ source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "k", fetch, retryBaseMs: 1 });
  await assert.rejects(source.generate(request, controller.signal), /Run was cancelled/);
});

test("the settings test asks the server about the model and makes no picture", async () => {
  const base = { source: "openai" as const, baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: "sk-test-1234567890" };
  const known = endpoint([() => json({ id: "gpt-image-1", object: "model" })]);
  assert.deepEqual(await checkImageSource({ ...base, fetch: known.fetch }), { ok: true, message: "OpenAI answered for gpt-image-1. Image calls will use it." });
  assert.equal(known.sent[0].url, "https://api.openai.com/v1/models/gpt-image-1");
  assert.equal(known.sent[0].init.method, "GET");
  assert.equal((known.sent[0].init.headers as Record<string, string>).authorization, "Bearer sk-test-1234567890");

  const refused = endpoint([() => json({ error: { message: "Incorrect API key provided: sk-test-1234567890" } }, 401)]);
  const refusal = await checkImageSource({ ...base, fetch: refused.fetch });
  assert.equal(refusal.ok, false);
  assert.doesNotMatch(refusal.message, /sk-test-1234567890/, "the key is never echoed");

  // A compatible server without the per-model route is asked for its list.
  const compatible = { source: "openai-compatible" as const, baseUrl: "http://localhost:8000/v1", model: "flux", apiKey: null };
  const listed = endpoint([() => json({}, 404), () => json({ data: [{ id: "flux" }, { id: "sdxl" }] })]);
  assert.deepEqual(await checkImageSource({ ...compatible, fetch: listed.fetch }), { ok: true, message: "The image server lists flux. Image calls will use it." });
  assert.equal((listed.sent[0].init.headers as Record<string, string>).authorization, undefined);
  const missing = endpoint([() => json({}, 404), () => json({ data: [{ id: "sdxl" }] })]);
  assert.deepEqual(await checkImageSource({ ...compatible, fetch: missing.fetch }), { ok: false, message: "The image server does not list flux. It lists: sdxl." });
  const silent = endpoint([() => json({}, 404), () => json({}, 404)]);
  assert.equal((await checkImageSource({ ...compatible, fetch: silent.fetch })).ok, true);
  const down = endpoint([() => { throw new Error("ECONNREFUSED"); }]);
  assert.match((await checkImageSource({ ...compatible, fetch: down.fetch })).message, /could not be reached: ECONNREFUSED/);
});
