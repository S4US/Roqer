import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_DISCORD_CLIENT_ID,
  resolveDiscordClientId,
} from "./build-config.mjs";

test("an unregistered build embeds no Discord application, which turns the presence off", () => {
  assert.equal(resolveDiscordClientId(undefined), PRODUCTION_DISCORD_CLIENT_ID);
  assert.equal(resolveDiscordClientId("   "), "");
});

test("a Discord application id is checked at build time rather than at the socket", () => {
  assert.equal(resolveDiscordClientId(" 1234567890123456789 "), "1234567890123456789");
  // Otherwise a mistyped build variable fails as a refused connection, which
  // looks exactly like Discord being closed.
  for (const value of ["not-an-id", "12345", "1234567890123456789012345678", "123456789012345678,"]) {
    assert.throws(() => resolveDiscordClientId(value), /must be a Discord application id/);
  }
});
