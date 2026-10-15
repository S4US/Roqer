import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_BUSY, RunClaims, RunHolds, STUDIO_PLACE_BUSY } from "./run-claims";

test("one run holds a key at a time, and a second is refused until the first releases it", () => {
  const places = new RunClaims();
  const first = places.claim("place-a");
  assert.ok(first, "the first run gets the place");
  assert.equal(places.claim("place-a"), null, "a second run on the same place is refused");
  assert.equal(places.holds("place-a"), true);

  places.release(first);
  assert.equal(places.holds("place-a"), false);
  assert.ok(places.claim("place-a"), "a released place can be claimed again");
});

test("different keys are claimed independently", () => {
  const places = new RunClaims();
  assert.ok(places.claim("place-a"));
  assert.ok(places.claim("place-b"), "another place is not blocked by the first");
});

test("a stale release cannot free a key another run has since claimed", () => {
  const places = new RunClaims();
  const old = places.claim("place-a");
  places.release(old);
  const next = places.claim("place-a");
  assert.ok(next);

  places.release(old);
  assert.equal(places.holds("place-a"), true, "the new holder keeps the place");
  assert.equal(places.claim("place-a"), null);
});

test("releasing twice is harmless, so a cancelled start and its own clean-up can both release", () => {
  const chats = new RunClaims();
  const claim = chats.claim("chat-a");
  chats.release(claim);
  chats.release(claim);
  assert.equal(chats.holds("chat-a"), false);
  assert.ok(chats.claim("chat-a"));
});

test("a run with no Studio place claims nothing and releases nothing", () => {
  const places = new RunClaims();
  places.release(null);
  assert.ok(places.claim("place-a"), "releasing nothing leaves the place free to claim");
});

const held = (result: ReturnType<RunHolds["begin"]>) => {
  assert.ok(result.ok, "the run is let start");
  return result.hold;
};

test("grid runs can share a place, but keep their chat and release only their own claim", () => {
  const holds = new RunHolds();
  const first = held(holds.begin("chat-a", "place-a"));
  const second = held(holds.begin("chat-b", "place-a", true));
  assert.deepEqual(holds.begin("chat-b", "place-a", true), { ok: false, message: CHAT_BUSY });
  assert.deepEqual(holds.begin("chat-c", "place-a"), { ok: false, message: STUDIO_PLACE_BUSY });
  first.release();
  first.release();
  assert.deepEqual(holds.begin("chat-c", "place-a"), { ok: false, message: STUDIO_PLACE_BUSY });
  second.release();
  assert.ok(holds.begin("chat-c", "place-a").ok);
});

test("grid runs share a place discovered during startup and cannot bind after cancellation", () => {
  const holds = new RunHolds();
  const first = held(holds.begin("chat-a", null, true));
  const second = held(holds.begin("chat-b", null, true));
  assert.equal(first.holdPlace("place-a"), true);
  assert.equal(second.holdPlace("place-a"), true);
  assert.equal(second.holdPlace("place-b"), false);
  first.release();
  assert.equal(first.holdPlace("place-b"), false);
  assert.deepEqual(holds.begin("chat-c", "place-a"), { ok: false, message: STUDIO_PLACE_BUSY });
  second.release();
  assert.ok(holds.begin("chat-c", "place-a").ok);
});

test("a chat takes one run at a time, even on different places", () => {
  const holds = new RunHolds();
  const first = held(holds.begin("chat-a", "place-a"));
  assert.deepEqual(holds.begin("chat-a", "place-b"), { ok: false, message: CHAT_BUSY });
  assert.deepEqual(holds.begin("chat-a", null), { ok: false, message: CHAT_BUSY });
  assert.equal(holds.chatBusy("chat-a"), true);

  first.release();
  assert.equal(holds.chatBusy("chat-a"), false);
  assert.ok(holds.begin("chat-a", "place-b").ok);
});

test("two chats cannot write one place, and the refused chat holds nothing", () => {
  const holds = new RunHolds();
  held(holds.begin("chat-a", "place-a"));
  assert.deepEqual(holds.begin("chat-b", "place-a"), { ok: false, message: STUDIO_PLACE_BUSY });
  assert.equal(holds.chatBusy("chat-b"), false, "the refused start let go of its chat");
  assert.ok(holds.begin("chat-b", "place-b").ok, "another place is free");
});

test("this chat's own stopping run is reported as that, not as another chat", () => {
  const holds = new RunHolds();
  held(holds.begin("chat-a", "place-a"));
  assert.deepEqual(holds.begin("chat-a", "place-a"), { ok: false, message: CHAT_BUSY });
});

test("a run sent with no place holds the place its start binds it to", () => {
  const holds = new RunHolds();
  const unpinned = held(holds.begin("chat-a", null));
  assert.equal(unpinned.holdPlace("place-a"), true);
  assert.deepEqual(holds.begin("chat-b", "place-a"), { ok: false, message: STUDIO_PLACE_BUSY });

  const second = held(holds.begin("chat-c", null));
  assert.equal(second.holdPlace("place-a"), false, "a second unpinned run cannot bind to a place already held");
  second.release();

  unpinned.release();
  assert.ok(holds.begin("chat-b", "place-a").ok, "the place is free once the run ends");
});

test("a released hold cannot take a place afterwards", () => {
  const holds = new RunHolds();
  const cancelled = held(holds.begin("chat-a", null));
  cancelled.release();
  assert.equal(cancelled.holdPlace("place-a"), false);
  assert.ok(holds.begin("chat-b", "place-a").ok, "the place was never taken");
});

test("releasing a hold twice cannot free what a later run took", () => {
  const holds = new RunHolds();
  const old = held(holds.begin("chat-a", "place-a"));
  old.release();
  held(holds.begin("chat-a", "place-a"));

  old.release();
  assert.equal(holds.chatBusy("chat-a"), true);
  assert.deepEqual(holds.begin("chat-b", "place-a"), { ok: false, message: STUDIO_PLACE_BUSY });
});
