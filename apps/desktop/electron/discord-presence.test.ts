import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Socket } from "node:net";

import {
  DiscordPresence,
  decodeFrames,
  encodeFrame,
  ipcSocketPath,
  presenceActivity,
} from "./discord-presence";

/** A socket that records what was written and lets a test drive the other end. */
class FakeSocket extends EventEmitter {
  readonly written: unknown[] = [];
  destroyed = false;

  write(chunk: Buffer): boolean {
    const { frames } = decodeFrames(chunk);
    for (const frame of frames) this.written.push(frame.payload);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Answer the handshake the way a running Discord client does. */
  ready(): void {
    this.emit("data", encodeFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
  }

  commands(): string[] {
    return this.written.flatMap((payload) => {
      const command = (payload as { cmd?: unknown }).cmd;
      return typeof command === "string" ? [command] : [];
    });
  }

  activities(): unknown[] {
    return this.written.flatMap((payload) => {
      const record = payload as { cmd?: unknown; args?: { activity?: unknown } };
      return record.cmd === "SET_ACTIVITY" ? [record.args?.activity] : [];
    });
  }
}

function harness(options: { now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const presence = new DiscordPresence({
    clientId: "test-client",
    now: options.now,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      // A real connection resolves on the next turn, and a test that skipped
      // that would never exercise the handshake ordering.
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as Socket;
    },
  });
  return { presence, sockets };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("the activity says the app is open and never what it is working on", () => {
  const working = presenceActivity(true, 1_000);
  // Naming AI is the point of the line: without it the entry describes every
  // Roblox developer rather than what Roqer is.
  assert.equal(working.details, "Building in Roblox Studio with AI");
  assert.equal(working.state, "Working on a task");
  assert.equal(presenceActivity(false, 1_000).state, "Idle");
  // The whole payload, because anything naming the customer's project would be
  // broadcast to every server they are in.
  assert.doesNotMatch(JSON.stringify(working), /place|script|task list|model|prompt/i);
  // The button is the only reason this is worth shipping: a name with no route
  // to the project advertises nothing.
  assert.deepEqual(working.buttons, [{ label: "Get Roqer", url: "https://github.com/S4US/Roqer" }]);
});

test("frames round-trip, and a partial one waits for the rest", () => {
  const frame = encodeFrame(1, { cmd: "SET_ACTIVITY" });
  assert.equal(frame.readInt32LE(0), 1);
  assert.equal(frame.readInt32LE(4), frame.length - 8);

  const split = decodeFrames(frame.subarray(0, 10));
  assert.equal(split.frames.length, 0);
  assert.equal(split.rest.length, 10);

  const whole = decodeFrames(Buffer.concat([split.rest, frame.subarray(10), encodeFrame(3, {})]));
  assert.deepEqual(whole.frames.map((entry) => entry.opcode), [1, 3]);
  assert.equal(whole.rest.length, 0);
});

test("a desynchronised stream is dropped rather than allocated against", () => {
  const header = Buffer.allocUnsafe(8);
  header.writeInt32LE(1, 0);
  header.writeInt32LE(50_000_000, 4);
  const decoded = decodeFrames(header);
  assert.deepEqual(decoded.frames, []);
  assert.equal(decoded.rest.length, 0);
});

test("a body that is not JSON does not throw out of the socket callback", () => {
  const header = Buffer.allocUnsafe(8);
  header.writeInt32LE(1, 0);
  header.writeInt32LE(3, 4);
  const decoded = decodeFrames(Buffer.concat([header, Buffer.from("{ x", "utf8")]));
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0]?.payload, undefined);
});

test("the socket path is a Discord IPC pipe", () => {
  const path = ipcSocketPath(0);
  assert.match(path, process.platform === "win32" ? /discord-ipc-0$/ : /\/discord-ipc-0$/);
  assert.notEqual(ipcSocketPath(1), path);
});

test("enabling handshakes first and only then sets the activity", async () => {
  const { presence, sockets } = harness();
  presence.setEnabled(true);
  await settle();
  const socket = sockets[0];
  assert.ok(socket);
  // Handshake only: an activity sent before READY is one Discord discards.
  assert.deepEqual(socket.activities(), []);
  assert.deepEqual(socket.written[0], { v: 1, client_id: "test-client" });

  socket.ready();
  assert.deepEqual(socket.commands(), ["SET_ACTIVITY"]);
  assert.equal((socket.activities()[0] as { state: string }).state, "Idle");
  presence.dispose();
});

test("a run switches the state, and an unchanged state is not resent", async () => {
  let clock = 100_000;
  const { presence, sockets } = harness({ now: () => clock });
  presence.setEnabled(true);
  await settle();
  const socket = sockets[0];
  assert.ok(socket);
  socket.ready();

  clock += 10_000;
  presence.setRunning(true);
  assert.equal((socket.activities().at(-1) as { state: string }).state, "Working on a task");

  // Setting the same thing twice is not an update, so it never reaches the
  // rate limit Discord applies to activity changes.
  const sent = socket.activities().length;
  presence.setRunning(true);
  assert.equal(socket.activities().length, sent);

  clock += 10_000;
  presence.setRunning(false);
  assert.equal((socket.activities().at(-1) as { state: string }).state, "Idle");
  presence.dispose();
});

test("rapid changes are coalesced rather than queued", async () => {
  let clock = 100_000;
  const { presence, sockets } = harness({ now: () => clock });
  presence.setEnabled(true);
  await settle();
  const socket = sockets[0];
  assert.ok(socket);
  socket.ready();
  const afterReady = socket.activities().length;

  // Inside the floor, so nothing goes out yet: an activity is a current fact
  // and the queue would only deliver stale ones.
  presence.setRunning(true);
  presence.setRunning(false);
  presence.setRunning(true);
  assert.equal(socket.activities().length, afterReady);

  clock += 5_000;
  await new Promise((resolve) => setTimeout(resolve, 60));
  presence.setRunning(false);
  presence.setRunning(true);
  assert.equal((socket.activities().at(-1) as { state: string }).state, "Working on a task");
  presence.dispose();
});

test("turning it off clears the profile rather than just dropping the socket", async () => {
  const { presence, sockets } = harness();
  presence.setEnabled(true);
  await settle();
  const socket = sockets[0];
  assert.ok(socket);
  socket.ready();

  presence.setEnabled(false);
  // A null activity is what removes the entry. Closing the socket alone leaves
  // the last state standing until Discord notices, which is exactly what
  // somebody who turned the setting off does not want.
  assert.equal(socket.activities().at(-1), null);
  assert.equal(socket.destroyed, true);
});

test("a refused socket walks the other indexes before waiting", async () => {
  const { presence, sockets } = harness();
  presence.setEnabled(true);
  await settle();
  // Discord listens on the first free index, so a stale pipe at zero must not
  // read as Discord being absent.
  sockets[0]?.emit("error", new Error("ECONNREFUSED"));
  await settle();
  assert.equal(sockets.length, 2);
  presence.dispose();
});

test("a build with no application registered has no presence to enable", () => {
  const presence = new DiscordPresence({ clientId: "" });
  assert.equal(presence.available, false);
  // And enabling it connects to nothing, rather than leaving a setting that
  // reports success and does nothing.
  presence.setEnabled(true);
  presence.dispose();
});
