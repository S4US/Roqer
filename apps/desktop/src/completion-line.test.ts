import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompletionLine } from "./completion-line";

const usage = { inputTokens: 2_250, outputTokens: 56, requests: 1 };

test("completion metadata and usage render as one DOM line", () => {
  const html = renderToStaticMarkup(createElement(CompletionLine, {
    metadata: "4s",
    usage,
  }));

  assert.equal(
    html,
    '<p class="run-completion-metadata" title="As the provider reported it.">4s · Used 2.3k tokens: 2.3k input, 56 output · 1 request</p>',
  );
  assert.equal((html.match(/<p/g) ?? []).length, 1);
});

test("completion metadata without usage remains one line without a usage tooltip", () => {
  assert.equal(
    renderToStaticMarkup(createElement(CompletionLine, { metadata: "Demo · 4s" })),
    '<p class="run-completion-metadata">Demo · 4s</p>',
  );
});

test("completion usage keeps the provider cost tooltip", () => {
  const html = renderToStaticMarkup(createElement(CompletionLine, {
    metadata: "Ask first · 8m 34s",
    usage: { ...usage, costUsd: 0.42 },
  }));

  assert.match(html, /title="As the provider reported it\. The price is its estimate at API list prices; on a subscription it is not what you pay\."/);
});
