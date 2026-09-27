import assert from "node:assert/strict";
import test from "node:test";

import { describesUpdateFeed } from "./update-feed";

test("a GitHub Releases feed is a feed, though it has no url", () => {
  // Exactly what electron-builder writes for Roqer's own publish settings.
  assert.equal(describesUpdateFeed([
    "owner: S4US",
    "repo: Roqer",
    "provider: github",
    "updaterCacheDirName: '@roqerdesktop-updater'",
    "",
  ].join("\n")), true);
});

test("a generic feed needs its url", () => {
  assert.equal(describesUpdateFeed("provider: generic\nurl: https://example.com/roqer\n"), true);
  assert.equal(describesUpdateFeed("provider: generic\nupdaterCacheDirName: x\n"), false);
});

test("a file naming no provider, or a GitHub one without its repository, is no feed", () => {
  assert.equal(describesUpdateFeed(""), false);
  assert.equal(describesUpdateFeed("updaterCacheDirName: '@roqerdesktop-updater'\n"), false);
  assert.equal(describesUpdateFeed("provider: github\nowner: S4US\n"), false);
  assert.equal(describesUpdateFeed("provider: github\nowner: ''\nrepo: Roqer\n"), false);
});
