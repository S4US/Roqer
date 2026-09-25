import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

/**
 * Roqer's entry in a Discord profile.
 *
 * Roblox developers live in Discord, so the member list of every server they
 * are in is where this product is most cheaply seen. That is the whole reason
 * the feature exists, and it is also the reason to be careful with it: presence
 * is broadcast to everyone who can see the profile, so what it says has to be
 * something the person running it would have been willing to announce.
 *
 * So it says only that Roqer is open and whether it is busy. No place name, no
 * script, no task title, no model. A developer with an unreleased game would be
 * right to be angry if their project's name turned up in a member list, and it
 * would sit badly beside a product whose retention promise is that it does not
 * keep the customer's content.
 *
 * There is no dependency behind this. The wire format is an eight-byte header
 * and a JSON body over a local pipe, the two libraries that wrap it are
 * unmaintained or heavy, and a socket this small is cheaper to own than to
 * import.
 */

declare const __ROQER_DISCORD_CLIENT_ID__: string | undefined;

/**
 * The Discord application this presence belongs to, from the developer portal.
 *
 * Embedded by `electron/build.mjs` because a
 * packaged app has no environment to read: taken from `process.env` at runtime
 * this would be empty in every build that ships, and the setting would be a
 * switch wired to nothing. Public by design -- every client that connects sends
 * it -- so it belongs in the repository rather than in a secret.
 *
 * Empty means the feature is off, which is what an unregistered build should
 * get: a setting that reports success while doing nothing is worse than one
 * that is not offered.
 */
export const DISCORD_CLIENT_ID =
  (typeof __ROQER_DISCORD_CLIENT_ID__ === "string" ? __ROQER_DISCORD_CLIENT_ID__ : undefined) ??
  process.env.ROQER_DISCORD_CLIENT_ID ?? "";

/** Where the project lives, which is the only reason the button exists. */
const DOWNLOAD_URL = "https://github.com/S4US/Roqer";

/**
 * Discord accepts about five activity updates in twenty seconds. Roqer sends
 * one when a run starts and one when it ends, so a user chaining short runs is
 * the only way to approach that. The floor coalesces those into the latest
 * state rather than queueing them, because an activity is a current fact and a
 * stale one is worth nothing.
 */
const MIN_UPDATE_INTERVAL_MS = 4_000;

/** Reconnect backoff. Discord is frequently not running, and that is not an error. */
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** Discord listens on up to ten sockets, and any of them may be the live one. */
const MAX_SOCKET_INDEX = 9;

export function ipcSocketPath(index: number): string {
  return process.platform === "win32"
    ? `\\\\?\\pipe\\discord-ipc-${index}`
    : `${process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? "/tmp"}/discord-ipc-${index}`.replace(/\/+/g, "/");
}

export type PresenceActivity = Readonly<{
  details: string;
  state: string;
  timestamps: Readonly<{ start: number }>;
  assets: Readonly<{ large_image: string; large_text: string }>;
  buttons: readonly Readonly<{ label: string; url: string }>[];
}>;

/**
 * What the profile card says. Two states and nothing else: everything that
 * would make this more informative would also make it something the person
 * running it did not agree to publish.
 *
 * The unchanging line carries the explanation, because a name in a member list
 * tells nobody what Roqer is and this is the first place a stranger can find
 * out. It names AI deliberately: without it the entry reads as somebody using
 * Studio, which describes every Roblox developer and sells nothing.
 */
export function presenceActivity(running: boolean, startedAt: number): PresenceActivity {
  return {
    details: "Building in Roblox Studio with AI",
    state: running ? "Working on a task" : "Idle",
    timestamps: { start: startedAt },
    assets: { large_image: "roqer", large_text: "Roqer — AI agent for Roblox Studio" },
    // Shown to people viewing the profile and never to the person running it,
    // which is worth remembering when somebody reports the button missing.
    buttons: [{ label: "Get Roqer", url: DOWNLOAD_URL }],
  };
}

export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export type DecodedFrame = Readonly<{ opcode: number; payload: unknown }>;

/**
 * Pull whole frames out of a growing buffer.
 *
 * Returns what is left as well as what was read, because a socket delivers
 * bytes rather than messages and half a header is the ordinary case rather than
 * a fault. A body that is not JSON is surfaced as an undefined payload instead
 * of throwing: this runs inside a socket callback in the main process, and a
 * throw there takes down more than the presence.
 */
export function decodeFrames(buffered: Buffer): Readonly<{ frames: readonly DecodedFrame[]; rest: Buffer }> {
  const frames: DecodedFrame[] = [];
  let rest = buffered;
  for (;;) {
    if (rest.length < 8) break;
    const opcode = rest.readInt32LE(0);
    const length = rest.readInt32LE(4);
    // A negative or absurd length is a desynchronised stream, and reading on
    // from it would allocate against a number the other side never meant.
    if (length < 0 || length > 1_000_000) return { frames, rest: Buffer.alloc(0) };
    if (rest.length < 8 + length) break;
    const body = rest.subarray(8, 8 + length).toString("utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      payload = undefined;
    }
    frames.push({ opcode, payload });
    rest = rest.subarray(8 + length);
  }
  return { frames, rest };
}

export type PresenceOptions = Readonly<{
  clientId?: string;
  /** Injected so the socket can be faked; defaults to a real local connection. */
  connect?: (path: string) => Socket;
  now?: () => number;
  /** Reports a failure worth knowing about. Never called for "Discord is not running". */
  onError?: (error: Error) => void;
}>;

/**
 * Holds one connection to a local Discord client and keeps it in step with
 * whether Roqer is running something.
 *
 * Every failure here is silent by design. Discord not being installed, not
 * being open, or closing mid-session are all ordinary, and none of them is
 * something to tell a Roblox developer about while they are working.
 */
export class DiscordPresence {
  private readonly clientId: string;
  private readonly connect: (path: string) => Socket;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;
  private readonly startedAt: number;

  private socket: Socket | undefined;
  // Annotated because `Buffer.alloc` and `Buffer.subarray` disagree about their
  // backing-store type parameter, and the field holds both in turn.
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ready = false;
  private enabled = false;
  private running = false;
  private disposed = false;
  private socketIndex = 0;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  private lastSentAt = 0;
  /** What was last put on the wire, so an unchanged state is not resent. */
  private sentState: string | undefined;

  constructor(options: PresenceOptions = {}) {
    this.clientId = options.clientId ?? DISCORD_CLIENT_ID;
    this.connect = options.connect ?? ((path) => createConnection(path));
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.startedAt = this.now();
  }

  /** Whether this build can have a presence at all. */
  get available(): boolean {
    return this.clientId.length > 0;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || !this.available || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.attempt = 0;
      this.socketIndex = 0;
      this.open();
      return;
    }
    // Turning it off has to reach the profile, not just this process: a stale
    // "Building in Roblox Studio" left behind by a closed socket is exactly
    // what somebody who turned the setting off does not want.
    this.clearActivity();
    this.close();
  }

  setRunning(running: boolean): void {
    if (this.disposed || running === this.running) return;
    this.running = running;
    this.push();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearActivity();
    this.close();
  }

  private open(): void {
    if (this.disposed || !this.enabled || this.socket !== undefined) return;
    let socket: Socket;
    try {
      socket = this.connect(ipcSocketPath(this.socketIndex));
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    this.buffered = Buffer.alloc(0);
    this.ready = false;

    socket.on("connect", () => {
      this.attempt = 0;
      this.write(OP_HANDSHAKE, { v: 1, client_id: this.clientId });
    });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    // Both end the connection, and neither is worth reporting: a Discord that
    // is not running refuses every socket, which is the common case.
    socket.on("error", () => this.dropped());
    socket.on("close", () => this.dropped());
  }

  private receive(chunk: Buffer): void {
    const { frames, rest } = decodeFrames(Buffer.concat([this.buffered, chunk]));
    this.buffered = rest;
    for (const frame of frames) {
      if (frame.opcode === OP_PING) {
        this.write(OP_PONG, frame.payload ?? {});
        continue;
      }
      if (frame.opcode === OP_CLOSE) {
        this.dropped();
        return;
      }
      if (frame.opcode !== OP_FRAME) continue;
      const payload = frame.payload;
      if (typeof payload !== "object" || payload === null) continue;
      const event = (payload as { evt?: unknown }).evt;
      if (event === "READY") {
        this.ready = true;
        this.sentState = undefined;
        this.push();
      }
    }
  }

  /**
   * A refused socket is the ordinary case, so the next index is tried before
   * any waiting happens: Discord listens on the first free one, and a stale
   * pipe at index 0 would otherwise look like Discord being absent.
   */
  private dropped(): void {
    const hadSocket = this.socket !== undefined;
    this.close();
    if (this.disposed || !this.enabled || !hadSocket) return;
    if (this.socketIndex < MAX_SOCKET_INDEX) {
      this.socketIndex += 1;
      this.open();
      return;
    }
    this.socketIndex = 0;
    this.retry();
  }

  private retry(): void {
    if (this.disposed || !this.enabled || this.reconnectTimer !== undefined) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
    // The app must be able to quit while this is pending.
    this.reconnectTimer.unref?.();
  }

  private close(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.updateTimer !== undefined) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.sentState = undefined;
    this.buffered = Buffer.alloc(0);
    if (socket === undefined) return;
    socket.removeAllListeners();
    try {
      socket.destroy();
    } catch {
      // Already gone, which is the state this was aiming for.
    }
  }

  /** Send the current state, coalescing anything inside the rate floor. */
  private push(): void {
    if (!this.ready || this.socket === undefined) return;
    const activity = presenceActivity(this.running, this.startedAt);
    const encoded = JSON.stringify(activity);
    if (encoded === this.sentState) return;
    const since = this.now() - this.lastSentAt;
    if (since < MIN_UPDATE_INTERVAL_MS) {
      if (this.updateTimer !== undefined) return;
      this.updateTimer = setTimeout(() => {
        this.updateTimer = undefined;
        this.push();
      }, MIN_UPDATE_INTERVAL_MS - since);
      this.updateTimer.unref?.();
      return;
    }
    this.sentState = encoded;
    this.lastSentAt = this.now();
    this.setActivity(activity);
  }

  private clearActivity(): void {
    if (!this.ready || this.socket === undefined) return;
    this.setActivity(null);
  }

  private setActivity(activity: PresenceActivity | null): void {
    this.write(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity },
      nonce: randomUUID(),
    });
  }

  private write(opcode: number, payload: unknown): void {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return;
    try {
      socket.write(encodeFrame(opcode, payload));
    } catch (error) {
      // A write that fails has already closed the socket in every case that
      // matters; the listener will reconnect. Reported because unlike a refused
      // connection this one is not the ordinary case.
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
