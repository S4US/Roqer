import assert from "node:assert/strict";
import test from "node:test";
import { allowedPermission } from "./window-permissions";

test("Roqer's window may use the microphone and write to the clipboard, and nothing else", () => {
  assert.equal(allowedPermission("media", true, { mediaTypes: ["audio"] }), true);
  assert.equal(allowedPermission("media", true, { mediaType: "audio" }), true, "the check asks one type at a time");
  assert.equal(allowedPermission("clipboard-sanitized-write", true, {}), true);

  assert.equal(allowedPermission("media", true, { mediaTypes: ["video"] }), false, "no camera");
  assert.equal(allowedPermission("media", true, { mediaTypes: ["audio", "video"] }), false, "sound and picture is refused whole");
  assert.equal(allowedPermission("media", true, { mediaType: "video" }), false);
  assert.equal(allowedPermission("media", true, {}), false, "a request that names no type");
  for (const permission of ["notifications", "geolocation", "clipboard-read", "display-capture", "fullscreen", "openExternal", "pointerLock", "midi"]) {
    assert.equal(allowedPermission(permission, true, {}), false, permission);
  }
});

test("a page that is not Roqer's window gets nothing", () => {
  assert.equal(allowedPermission("media", false, { mediaTypes: ["audio"] }), false);
  assert.equal(allowedPermission("clipboard-sanitized-write", false, {}), false);
});
