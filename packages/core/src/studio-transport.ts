import { randomUUID } from 'node:crypto';

export interface StudioSession {
  logicalSessionId: string;
  physicalSessionId: string;
}

export interface StudioQueuedRequest {
  requestId: string;
  logicalSessionId: string;
  target: string;
  endpoint: string;
  data: unknown;
}

export interface StudioTransportQueue {
  claimNextRequestForPhysical(physicalSessionId: string, claimOwner: string): StudioQueuedRequest | null;
  releaseDeliveryClaims(claimOwner: string): void;
  onRequestAvailable(listener: (physicalSessionId: string) => void): () => void;
  onSessionClosed(listener: (session: StudioSession) => void): () => void;
  setDeliveryActive(physicalSessionId: string, owner: string, active: boolean): void;
  updateInstanceActivity(pluginSessionId: string): void;
}


export interface StudioRequestEvent {
  kind: 'request';
  requestId: string;
  logicalSessionId: string;
  target: string;
  endpoint: string;
  data: unknown;
}

export interface StudioStatusEvent {
  kind: 'status';
  knownInstance: boolean;
  mcpConnected: boolean;
  serverVersion?: string;
  pluginVersion?: string;
  pluginVariant?: string;
}

export interface StudioHeartbeatEvent {
  kind: 'heartbeat';
  timestamp: number;
}

/**
 * One piece of an event too large to send whole.
 *
 * Studio's SSE client hands the plugin whatever each socket read returned,
 * not one event per message: a script write of 16,739 bytes arrived as 16,372
 * and then 367, neither of which parses, so the plugin discarded both and the
 * bridge timed the request out thirty seconds later. That was every write of
 * a script over roughly 15 KB, reported as "Studio plugin connection timeout".
 * The plugin now splits what it receives on the blank line that ends an SSE
 * event, whatever the read boundaries were; and the bridge sends a large event
 * as pieces that each fit well inside one read, which the plugin joins back by
 * `id` and `index` before decoding. The pieces are written together, so they
 * arrive together -- one read holding several frames is the case the plugin's
 * splitting exists for.
 */
export interface StudioChunkEvent {
  kind: 'chunk';
  id: string;
  index: number;
  count: number;
  data: string;
}

export type StudioServerEvent = StudioRequestEvent | StudioStatusEvent | StudioHeartbeatEvent | StudioChunkEvent;

/**
 * The most an SSE frame may carry, in bytes of the `data:` line. Well under
 * the 16,384 the client was observed to split at, with room for the frame's
 * own prefix and for the chunk envelope around a piece.
 */
export const MAX_EVENT_FRAME_BYTES = 12_000;

/**
 * Encode an event as the frames to write. One frame when it fits, otherwise
 * chunk frames each guaranteed under the bound after their own encoding --
 * a piece of JSON re-escaped inside a JSON string can grow, so the piece is
 * shrunk until the frame fits rather than sized by arithmetic.
 */
export function encodeEventFrames(event: StudioServerEvent, maxFrameBytes = MAX_EVENT_FRAME_BYTES): string[] {
  const json = JSON.stringify(event);
  const frame = (payload: string): string => `data: ${payload}\n\n`;
  if (Buffer.byteLength(json) <= maxFrameBytes) return [frame(json)];

  const id = randomUUID();
  const pieces: string[] = [];
  let offset = 0;
  while (offset < json.length) {
    let length = Math.min(maxFrameBytes, json.length - offset);
    let piece = json.slice(offset, offset + length);
    // Placeholder count and index so the envelope measured is the one sent.
    while (Buffer.byteLength(chunkJson(id, 0, 0, piece)) > maxFrameBytes && length > 1) {
      length = Math.ceil(length / 2);
      piece = json.slice(offset, offset + length);
    }
    // Never cut between the halves of a surrogate pair: each piece is decoded
    // on its own before the join, and half a character decodes to garbage.
    const last = piece.charCodeAt(piece.length - 1);
    if (last >= 0xd800 && last <= 0xdbff && piece.length > 1) piece = piece.slice(0, -1);
    pieces.push(piece);
    offset += piece.length;
  }
  return pieces.map((piece, index) => frame(chunkJson(id, index, pieces.length, piece)));
}

function chunkJson(id: string, index: number, count: number, data: string): string {
  const chunk: StudioChunkEvent = { kind: 'chunk', id, index, count, data };
  return JSON.stringify(chunk);
}

export interface EventStreamSink {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close' | 'error' | 'drain', listener: () => void): this;
  removeListener(event: 'close' | 'error' | 'drain', listener: () => void): this;
}

export interface EventStreamHandle {
  readonly physicalSessionId: string;
  close(): void;
}

interface ActiveEventStream {
  physicalSessionId: string;
  claimOwner: string;
  sink: EventStreamSink;
  status: () => StudioStatusEvent;
  heartbeatTimer?: NodeJS.Timeout;
  closed: boolean;
  blocked: boolean;
  statusPending: boolean;
  lastStatusJson?: string;
  onClose: () => void;
  onDrain: () => void;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_ACTIVE_EVENT_STREAMS = 64;

/** Persistent SSE downstream adapter, multiplexed by physical Studio peer. */
export class SseStudioTransport {
  private readonly streams = new Map<string, ActiveEventStream>();
  private readonly unsubscribeRequestAvailable: () => void;
  private readonly unsubscribeSessionClosed: () => void;
  private nextGeneration = 0;

  constructor(private readonly queue: StudioTransportQueue) {
    this.unsubscribeRequestAvailable = queue.onRequestAvailable((physicalSessionId) => {
      const stream = this.streams.get(physicalSessionId);
      if (stream) this.pump(stream);
    });
    this.unsubscribeSessionClosed = queue.onSessionClosed((route) => {
      if (route.logicalSessionId === route.physicalSessionId) {
        this.closePhysical(route.physicalSessionId);
      }
    });
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  canOpen(physicalSessionId: string): boolean {
    return this.streams.has(physicalSessionId) || this.streams.size < MAX_ACTIVE_EVENT_STREAMS;
  }

  open(
    physicalSessionId: string,
    sink: EventStreamSink,
    status: () => StudioStatusEvent,
  ): EventStreamHandle | undefined {
    if (!this.canOpen(physicalSessionId)) return undefined;

    this.nextGeneration += 1;
    const claimOwner = `sse:${physicalSessionId}:${this.nextGeneration}`;
    const stream: ActiveEventStream = {
      physicalSessionId,
      claimOwner,
      sink,
      status,
      closed: false,
      blocked: false,
      statusPending: true,
      onClose: () => this.closeStream(stream),
      onDrain: () => {
        if (stream.closed) return;
        stream.blocked = false;
        this.pump(stream);
      },
    };

    this.queue.setDeliveryActive(physicalSessionId, claimOwner, true);
    this.queue.updateInstanceActivity(physicalSessionId);
    const replaced = this.streams.get(physicalSessionId);
    if (replaced) this.closeStream(replaced, true);

    this.streams.set(physicalSessionId, stream);
    sink.on('close', stream.onClose);
    sink.on('error', stream.onClose);
    sink.on('drain', stream.onDrain);
    stream.heartbeatTimer = setInterval(() => {
      if (!stream.closed && !stream.blocked) {
        this.queue.updateInstanceActivity(physicalSessionId);
        stream.statusPending = true;
        this.pump(stream);
        if (!stream.blocked) {
          this.write(stream, { kind: 'heartbeat', timestamp: Date.now() });
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    stream.heartbeatTimer.unref();
    this.pump(stream);

    return {
      physicalSessionId,
      close: () => this.closeStream(stream, true),
    };
  }

  refreshStatus(physicalSessionId?: string): void {
    if (physicalSessionId !== undefined) {
      const stream = this.streams.get(physicalSessionId);
      if (stream) {
        stream.lastStatusJson = undefined;
        stream.statusPending = true;
        this.pump(stream);
      }
      return;
    }
    for (const stream of this.streams.values()) {
      stream.lastStatusJson = undefined;
      stream.statusPending = true;
      this.pump(stream);
    }
  }

  closePhysical(physicalSessionId: string): void {
    const stream = this.streams.get(physicalSessionId);
    if (stream) this.closeStream(stream, true);
  }

  close(): void {
    for (const stream of Array.from(this.streams.values())) {
      this.closeStream(stream, true);
    }
    this.unsubscribeRequestAvailable();
    this.unsubscribeSessionClosed();
  }

  private pump(stream: ActiveEventStream): void {
    if (stream.closed || stream.blocked || this.streams.get(stream.physicalSessionId) !== stream) return;

    if (stream.statusPending) {
      stream.statusPending = false;
      let status: StudioStatusEvent;
      try {
        status = stream.status();
      } catch {
        this.closeStream(stream);
        return;
      }
      const statusJson = JSON.stringify(status);
      if (statusJson !== stream.lastStatusJson) {
        stream.lastStatusJson = statusJson;
        if (!this.write(stream, status)) return;
      }
    }

    while (!stream.closed && !stream.blocked) {
      const request = this.queue.claimNextRequestForPhysical(stream.physicalSessionId, stream.claimOwner);
      if (!request) return;
      const event: StudioRequestEvent = {
        kind: 'request',
        requestId: request.requestId,
        logicalSessionId: request.logicalSessionId,
        target: request.target,
        endpoint: request.endpoint,
        data: request.data === undefined ? null : request.data,
      };
      if (!this.write(stream, event)) return;
    }
  }

  private write(stream: ActiveEventStream, event: StudioServerEvent): boolean {
    if (stream.closed) return false;
    try {
      // Every frame of a chunked event is written in one go: the pieces are
      // only useful together, and a backpressure pause between them would
      // leave the plugin holding half a request. The sink buffers what the
      // socket cannot take yet, and `blocked` pauses the *next* event.
      let writable = true;
      for (const frame of encodeEventFrames(event)) {
        if (!stream.sink.write(frame)) writable = false;
      }
      if (!writable) stream.blocked = true;
      return writable;
    } catch {
      this.closeStream(stream);
      return false;
    }
  }

  private closeStream(stream: ActiveEventStream, endSink = false): void {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.heartbeatTimer);
    stream.sink.removeListener('close', stream.onClose);
    stream.sink.removeListener('error', stream.onClose);
    stream.sink.removeListener('drain', stream.onDrain);
    if (this.streams.get(stream.physicalSessionId) === stream) {
      this.streams.delete(stream.physicalSessionId);
    }
    this.queue.updateInstanceActivity(stream.physicalSessionId);
    this.queue.setDeliveryActive(stream.physicalSessionId, stream.claimOwner, false);
    this.queue.releaseDeliveryClaims(stream.claimOwner);
    if (endSink) {
      try {
        stream.sink.end();
      } catch {
        // The peer may already have destroyed the response.
      }
    }
  }
}
