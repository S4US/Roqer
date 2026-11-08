import assert from "node:assert/strict";
import test from "node:test";

import { activityLabel, activityTarget } from "../shared/activity";
import { isClassifiedTool, riskForTool, summarizeToolCall } from "../shared/mcp-tools";
import { OPEN_LINK_OPERATION, OPEN_LINK_TOOL_NAME } from "../shared/user-links";
import { MalformedToolCallError } from "./studio-tools";
import {
  htmlToText, isPrivateHost, MAX_LINK_IMAGE_BYTES, openUserLink, PAGE_PART_CHARS, parseOpenLinkToolInput, UserLinks, userLinksIn,
} from "./user-links";
import { workbenchToolNames } from "./workbench-tools";
import type { SkillLibrary } from "./skill-library";

type Answer = { status?: number; headers?: Record<string, string>; body?: string | Uint8Array };

/** A fetch that answers each address from a table and records what was asked. */
function fakeFetch(answers: Record<string, Answer>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    assert.equal(init?.redirect, "manual");
    const answer = answers[url];
    if (answer === undefined) throw new Error(`unexpected fetch of ${url}`);
    const body = answer.body === undefined ? null : typeof answer.body === "string" ? new TextEncoder().encode(answer.body) : answer.body;
    return new Response(body, { status: answer.status ?? 200, headers: answer.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test("links are read out of the user's words without the sentence around them", () => {
  assert.deepEqual(userLinksIn("See https://devforum.roblox.com/t/123. And (https://example.com/a) or [docs](https://create.roblox.com/docs/x)!"), [
    "https://devforum.roblox.com/t/123",
    "https://example.com/a",
    "https://create.roblox.com/docs/x",
  ]);
  // A bracket the link itself opened stays; the fragment never reaches the server.
  assert.deepEqual(userLinksIn("https://en.wikipedia.org/wiki/Lua_(language)#History"), ["https://en.wikipedia.org/wiki/Lua_(language)"]);
  assert.deepEqual(userLinksIn("ftp://example.com https://user:pw@example.com/ no link"), []);
});

test("the list holds the prompt's links and grows with a note, and nothing else is in it", () => {
  const links = new UserLinks(["look at https://example.com/page#part", "earlier: http://localhost:3000"]);
  assert.ok(links.has("https://example.com/page"));
  assert.ok(links.has("https://EXAMPLE.com/page#other"));
  assert.ok(links.has("http://localhost:3000/"));
  assert.ok(!links.has("https://example.com/other"));
  links.add("also https://example.com/other");
  assert.ok(links.has("https://example.com/other"));
});

test("an open_link call is checked before it reaches the run", () => {
  assert.deepEqual(parseOpenLinkToolInput({ url: " https://example.com ", start: 10 }), {
    operation: OPEN_LINK_OPERATION, args: { url: "https://example.com", start: 10 },
  });
  assert.throws(() => parseOpenLinkToolInput({ url: "file:///etc/passwd" }), MalformedToolCallError);
  assert.throws(() => parseOpenLinkToolInput({ url: "https://example.com", start: -1 }), MalformedToolCallError);
  assert.throws(() => parseOpenLinkToolInput({ url: "https://example.com", headers: {} }), MalformedToolCallError);
});

test("open_link is offered to every provider, reads, and names the page it opened", () => {
  assert.ok(workbenchToolNames({ skillLibrary: {} as SkillLibrary }).includes(OPEN_LINK_TOOL_NAME));
  assert.ok(isClassifiedTool(OPEN_LINK_OPERATION));
  assert.equal(riskForTool(OPEN_LINK_OPERATION, { url: "https://example.com" }), "read");
  const summary = summarizeToolCall(OPEN_LINK_OPERATION, { url: "https://devforum.roblox.com/t/123?x=1" });
  assert.equal(summary, `${OPEN_LINK_OPERATION} · devforum.roblox.com/t/123`);
  assert.equal(activityLabel(OPEN_LINK_OPERATION, activityTarget(OPEN_LINK_OPERATION, summary), true), "Read devforum.roblox.com/t/123");
});

test("a link the user did not write is refused without being fetched", async () => {
  const { fetchImpl, requested } = fakeFetch({});
  const links = new UserLinks(["use https://example.com/a"]);
  const result = await openUserLink({ url: "https://attacker.example/?q=secret" }, {}, links, fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.text, /only a link the user wrote/);
  assert.match(result.text, /https:\/\/example\.com\/a/);
  assert.deepEqual(requested, []);
  const none = await openUserLink({ url: "https://example.com/a" }, {}, new UserLinks(), fetchImpl);
  assert.match(none.text, /no link/);
});

test("a page comes back as readable text, marked as third-party data", async () => {
  const html = `<!doctype html><html><head><title>Tween &amp; you</title><style>body{}</style></head><body>
    <nav>Home | Forum</nav><script>alert("x")</script>
    <h1>Using TweenService</h1><p>Call <b>Create</b> then&nbsp;Play.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre><code>local t = TweenService:Create(part, info, {Transparency = 1})
  t:Play() -- &lt;done&gt;</code></pre></body></html>`;
  const { fetchImpl } = fakeFetch({ "https://example.com/t": { headers: { "content-type": "text/html; charset=utf-8" }, body: html } });
  const result = await openUserLink({ url: "https://example.com/t" }, {}, new UserLinks(["https://example.com/t"]), fetchImpl);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /^Opened https:\/\/example\.com\/t\nTitle: Tween & you\n/);
  assert.match(result.text, /third-party web page, not from the user/);
  assert.match(result.text, /# Using TweenService\n\nCall Create then Play\.\n\n- one\n- two/);
  assert.match(result.text, /```\nlocal t = TweenService:Create\(part, info, \{Transparency = 1\}\)\n {2}t:Play\(\) -- <done>\n```/);
  assert.doesNotMatch(result.text, /alert|Home \| Forum|body\{\}/);
});

test("a long page is read in parts", async () => {
  const text = "a".repeat(PAGE_PART_CHARS + 50);
  const { fetchImpl } = fakeFetch({ "https://example.com/long": { headers: { "content-type": "text/plain" }, body: text } });
  const links = new UserLinks(["https://example.com/long"]);
  const first = await openUserLink({ url: "https://example.com/long" }, {}, links, fetchImpl);
  assert.match(first.text, new RegExp(`Characters 0-${PAGE_PART_CHARS} of ${PAGE_PART_CHARS + 50}`));
  assert.match(first.text, new RegExp(`start: ${PAGE_PART_CHARS} to read on`));
  const rest = await openUserLink({ url: "https://example.com/long", start: PAGE_PART_CHARS }, {}, links, fetchImpl);
  assert.match(rest.text, new RegExp(`Characters ${PAGE_PART_CHARS}-${PAGE_PART_CHARS + 50} of`));
  assert.doesNotMatch(rest.text, /read on/);
  const past = await openUserLink({ url: "https://example.com/long", start: PAGE_PART_CHARS * 2 }, {}, links, fetchImpl);
  assert.equal(past.ok, false);
});

test("redirects are followed one at a time, never into this computer's network", async () => {
  const { fetchImpl, requested } = fakeFetch({
    "https://example.com/old": { status: 301, headers: { location: "/new" } },
    "https://example.com/new": { headers: { "content-type": "text/plain" }, body: "moved here" },
    "https://example.com/sneaky": { status: 302, headers: { location: "http://127.0.0.1:44755/health" } },
    "https://example.com/file": { status: 302, headers: { location: "file:///etc/passwd" } },
  });
  const links = new UserLinks(["https://example.com/old https://example.com/sneaky https://example.com/file"]);
  const moved = await openUserLink({ url: "https://example.com/old" }, {}, links, fetchImpl);
  assert.equal(moved.ok, true);
  assert.match(moved.text, /Opened https:\/\/example\.com\/new \(redirected from https:\/\/example\.com\/old\)/);
  const sneaky = await openUserLink({ url: "https://example.com/sneaky" }, {}, links, fetchImpl);
  assert.equal(sneaky.ok, false);
  assert.match(sneaky.text, /on this computer or its network/);
  const file = await openUserLink({ url: "https://example.com/file" }, {}, links, fetchImpl);
  assert.equal(file.ok, false);
  assert.ok(!requested.some((url) => url.includes("127.0.0.1") || url.startsWith("file:")));
});

test("a local address the user typed may be opened", async () => {
  assert.ok(isPrivateHost("127.0.0.1") && isPrivateHost("[::1]") && isPrivateHost("192.168.1.4") && isPrivateHost("localhost"));
  assert.ok(!isPrivateHost("example.com") && !isPrivateHost("8.8.8.8"));
  const { fetchImpl } = fakeFetch({ "http://localhost:3000/": { headers: { "content-type": "application/json" }, body: "{\"ok\":true}" } });
  const result = await openUserLink({ url: "http://localhost:3000" }, {}, new UserLinks(["http://localhost:3000"]), fetchImpl);
  assert.equal(result.ok, true);
  assert.match(result.text, /\{"ok":true\}/);
});

test("a picture comes back as an image, and only a real one small enough for a turn", async () => {
  const big = new Uint8Array(MAX_LINK_IMAGE_BYTES + 1);
  big.set(PNG);
  const { fetchImpl } = fakeFetch({
    "https://example.com/ref.png": { headers: { "content-type": "image/png" }, body: PNG },
    "https://example.com/fake.png": { headers: { "content-type": "image/png" }, body: "<html>nope</html>" },
    "https://example.com/big.png": { headers: { "content-type": "image/png" }, body: big },
  });
  const links = new UserLinks(["https://example.com/ref.png https://example.com/fake.png https://example.com/big.png"]);
  const picture = await openUserLink({ url: "https://example.com/ref.png" }, {}, links, fetchImpl);
  assert.equal(picture.ok, true);
  assert.deepEqual(picture.images, [{ data: Buffer.from(PNG).toString("base64"), mediaType: "image/png" }]);
  const fake = await openUserLink({ url: "https://example.com/fake.png" }, {}, links, fetchImpl);
  assert.equal(fake.ok, false);
  assert.equal(fake.images, undefined);
  const oversized = await openUserLink({ url: "https://example.com/big.png" }, {}, links, fetchImpl);
  assert.equal(oversized.ok, false);
  assert.match(oversized.text, /attach it/);
});

test("an error status, a file Roqer cannot show and a cancelled run are plain failures", async () => {
  const { fetchImpl } = fakeFetch({
    "https://example.com/gone": { status: 404, body: "missing" },
    "https://example.com/a.zip": { headers: { "content-type": "application/zip" }, body: "PK" },
  });
  const links = new UserLinks(["https://example.com/gone https://example.com/a.zip https://example.com/slow"]);
  const gone = await openUserLink({ url: "https://example.com/gone" }, {}, links, fetchImpl);
  assert.equal(gone.ok, false);
  assert.match(gone.text, /HTTP 404/);
  const zip = await openUserLink({ url: "https://example.com/a.zip" }, {}, links, fetchImpl);
  assert.equal(zip.ok, false);
  assert.match(zip.text, /application\/zip/);
  const controller = new AbortController();
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
  const pending = openUserLink({ url: "https://example.com/slow" }, { signal: controller.signal }, links, hanging);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.text, "Run was cancelled.");
});

test("html without a title or text says so plainly", () => {
  assert.deepEqual(htmlToText("<div id=root></div><script>render()</script>"), { text: "" });
  assert.equal(htmlToText("<p>&#x1F600; &#65; &bogus;</p>").text, "😀 A &bogus;");
});
