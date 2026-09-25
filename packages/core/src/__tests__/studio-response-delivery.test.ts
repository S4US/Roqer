import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';
import { encodeEventFrames, type StudioRequestEvent } from '../studio-transport.js';

interface HttpRequest {
  Url: string;
  Method: string;
  Headers?: Record<string, string>;
  Body?: string;
}

interface HttpResponse {
  Success: boolean;
  StatusCode: number;
  Body: string;
}

interface ScheduledTask {
  delay: number;
  callback: () => void;
}

interface MockSignal<T extends unknown[]> {
  Connect(callback: (...args: T) => void): { Disconnect(): void };
  fire(...args: T): void;
}

interface MockWebStreamClient {
  Opened: MockSignal<[number, Record<string, string>]>;
  MessageReceived: MockSignal<[string]>;
  Error: MockSignal<[number, string]>;
  Closed: MockSignal<[]>;
  Close(): void;
}

interface StudioEventStreamModule {
  start(options: {
    serverUrl: string;
    dispatchRequest(request: Record<string, unknown>): unknown;
    onStatus(status: Record<string, unknown>): void;
    onHeartbeat(timestamp: number): void;
    onReady(response: Record<string, unknown>): void;
    onTransportUpdate(update: Record<string, unknown>): void;
  }): void;
  refresh(): void;
  stop(): void;
}

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: never[]) => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

/**
 * The subset of Lua patterns the plugin uses, as a JavaScript regular
 * expression: character classes, anchors, and the four quantifiers. Anything
 * else throws, so a new pattern in the plugin fails here loudly instead of
 * silently matching as literal text.
 */
function luaPatternToRegExp(pattern: string): RegExp {
  const classes: Record<string, string> = { s: '\\s', d: '\\d', a: '[A-Za-z]', w: '[A-Za-z0-9]', p: '[!-/:-@[-`{-~]' };
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '%') {
      const next = pattern[index + 1];
      index += 1;
      if (next === undefined) throw new Error(`Malformed Lua pattern: ${pattern}`);
      if (classes[next] !== undefined) source += classes[next];
      else if (/[A-Za-z0-9]/.test(next)) throw new Error(`Unsupported Lua pattern class %${next} in ${pattern}`);
      else source += `\\${next}`;
    } else if (char === '^' && index === 0) {
      source += '^';
    } else if (char === '$' && index === pattern.length - 1) {
      source += '$';
    } else if (char === '+' || char === '*' || char === '?') {
      source += char;
    } else if (char === '-') {
      source += '*?';
    } else if (char === '.') {
      source += '[\\s\\S]';
    } else if (char === '[' || char === '(' || char === ')') {
      throw new Error(`Unsupported Lua pattern syntax ${char} in ${pattern}`);
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    }
  }
  return new RegExp(source, 'g');
}

/** Luau's `string` library as the plugin uses it: 1-based and inclusive. */
const luauString = {
  sub(value: string, start: number, finish?: number): string {
    const from = start > 0 ? start - 1 : Math.max(0, value.length + start);
    const to = finish === undefined ? value.length : (finish >= 0 ? finish : value.length + finish + 1);
    return value.slice(from, Math.max(from, to));
  },
  find(value: string, pattern: string, init = 1, plain = false): [number, number] | [undefined] {
    if (!plain) throw new Error('The test harness supports only plain string.find.');
    const index = value.indexOf(pattern, Math.max(0, init - 1));
    return index < 0 ? [undefined] : [index + 1, index + pattern.length];
  },
  gsub(value: string, pattern: string, replacement: string): [string, number] {
    let count = 0;
    const replaced = value.replace(luaPatternToRegExp(pattern), () => {
      count += 1;
      return replacement;
    });
    return [replaced, count];
  },
};

function createSignal<T extends unknown[]>(): MockSignal<T> {
  const callbacks = new Set<(...args: T) => void>();
  return {
    Connect(callback) {
      callbacks.add(callback);
      return { Disconnect: () => callbacks.delete(callback) };
    },
    fire(...args) {
      for (const callback of callbacks) callback(...args);
    },
  };
}

async function createHarness(
  postResponse: (request: HttpRequest, attempt: number) => HttpResponse,
): Promise<{
  module: StudioEventStreamModule;
  stream: MockWebStreamClient;
  scheduled: ScheduledTask[];
  responseBodies: string[];
  dispatchRequest: jest.Mock;
  emitRequest(requestId: string): void;
}> {
  const scheduled: ScheduledTask[] = [];
  const responseBodies: string[] = [];
  let responseAttempt = 0;
  const stream: MockWebStreamClient = {
    Opened: createSignal(),
    MessageReceived: createSignal(),
    Error: createSignal(),
    Closed: createSignal(),
    Close: jest.fn(),
  };
  const httpService = {
    JSONEncode: (value: unknown) => JSON.stringify(value),
    JSONDecode: (value: string) => JSON.parse(value),
    RequestAsync: (request: HttpRequest): HttpResponse => {
      if (request.Url.endsWith('/ready')) {
        return {
          Success: true,
          StatusCode: 200,
          Body: JSON.stringify({
            success: true,
            assignedRole: 'edit',
            instanceId: 'studio-instance',
            serverVersion: 'test',
          }),
        };
      }
      if (request.Url.endsWith('/response')) {
        responseBodies.push(request.Body!);
        responseAttempt += 1;
        return postResponse(request, responseAttempt);
      }
      throw new Error(`Unexpected request: ${request.Url}`);
    },
    CreateWebStreamClient: () => stream,
  };
  const dependencies: Plugin = {
    name: 'studio-response-delivery-dependencies',
    setup(build) {
      build.onResolve({ filter: /^@rbxts\/services$/ }, () => ({
        path: 'services',
        namespace: 'studio-response-delivery',
      }));
      build.onResolve({ filter: /^\.\/HttpDiagnostics$/ }, () => ({
        path: 'HttpDiagnostics',
        namespace: 'studio-response-delivery',
      }));
      build.onResolve({ filter: /^\.\/PluginSession$/ }, () => ({
        path: 'PluginSession',
        namespace: 'studio-response-delivery',
      }));
      build.onLoad({ filter: /.*/, namespace: 'studio-response-delivery' }, (args) => {
        if (args.path === 'services') {
          return { contents: 'export const HttpService = globalThis.__HTTP_SERVICE__;', loader: 'js' };
        }
        if (args.path === 'HttpDiagnostics') {
          return {
            contents: 'export default { formatRequestFailure: (_url, _completed, value) => String(value) };',
            loader: 'js',
          };
        }
        return {
          contents: `export default {
            id: 'plugin-session',
            getInstanceId: () => 'studio-instance',
            getRole: () => 'edit',
            createReadyPayload: () => ({})
          };`,
          loader: 'js',
        };
      });
    },
  };
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/StudioEventStream.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [dependencies],
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    __HTTP_SERVICE__: httpService,
    Enum: { WebStreamClientType: { SSE: 'SSE' } },
    math: {
      min: Math.min,
      max: Math.max,
      pow: Math.pow,
      floor: Math.floor,
    },
    task: {
      spawn: (callback: () => void) => callback(),
      delay: (delay: number, callback: () => void) => scheduled.push({ delay, callback }),
    },
    tick: () => 0,
    pcall: robloxPcall,
    typeIs: (value: unknown, expected: string) => {
      if (expected === 'table') return value !== null && typeof value === 'object';
      return typeof value === expected;
    },
    tostring: (value: unknown) => String(value),
    warn: jest.fn(),
    print: jest.fn(),
    string: luauString,
  });
  // roblox-ts compiles string methods to the same library calls, so the
  // method forms route through the one shim rather than a second copy.
  vm.runInContext(`
    String.prototype.gsub = function(pattern, replacement) { return string.gsub(String(this), pattern, replacement); };
    String.prototype.sub = function(start, finish) { return string.sub(String(this), start, finish); };
    String.prototype.size = function() { return this.length; };
    Array.prototype.size = function() { return this.length; };
    // roblox-ts gives Map a size() method where JavaScript has a getter.
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    Object.defineProperty(Map.prototype, 'size', { value: function() { return mapSize.call(this); } });
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as StudioEventStreamModule & { default?: StudioEventStreamModule };
  const eventStream = loaded.default ?? loaded;
  const dispatchRequest = jest.fn((request: Record<string, unknown>) => ({
    success: true,
    requestId: request.requestId,
  }));
  eventStream.start({
    serverUrl: 'http://127.0.0.1:19191',
    dispatchRequest,
    onStatus: jest.fn(),
    onHeartbeat: jest.fn(),
    onReady: jest.fn(),
    onTransportUpdate: jest.fn(),
  });
  stream.Opened.fire(200, {});

  return {
    module: eventStream,
    stream,
    scheduled,
    responseBodies,
    dispatchRequest,
    emitRequest(requestId: string) {
      stream.MessageReceived.fire(JSON.stringify({
        kind: 'request',
        requestId,
        logicalSessionId: 'logical-session',
        target: 'edit',
        endpoint: '/test',
        data: {},
      }));
    },
  };
}

describe('Studio response delivery', () => {
  test('retries the exact encoded response after a lost acknowledgement without redispatching', async () => {
    const harness = await createHarness((_request, attempt) => {
      if (attempt === 1) throw new Error('acknowledgement lost');
      return {
        Success: true,
        StatusCode: 200,
        Body: JSON.stringify({ success: true, disposition: 'already_settled' }),
      };
    });

    harness.emitRequest('request-1');
    harness.emitRequest('request-1');

    const retry = harness.scheduled.find((scheduled) => scheduled.delay === 0.5);
    expect(retry).toBeDefined();
    retry!.callback();
    harness.emitRequest('request-1');

    expect(harness.stream.Close).not.toHaveBeenCalled();
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(2);
    expect(harness.responseBodies[1]).toBe(harness.responseBodies[0]);
  });

  test('treats a non-2xx unknown disposition as terminal', async () => {
    const harness = await createHarness(() => ({
      Success: false,
      StatusCode: 404,
      Body: JSON.stringify({ success: false, disposition: 'unknown' }),
    }));

    harness.emitRequest('expired-request');
    harness.emitRequest('expired-request');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.scheduled.some((scheduled) => scheduled.delay === 0.5)).toBe(false);
  });

  test('accepts the legacy 2xx success acknowledgement without retrying', async () => {
    const harness = await createHarness(() => ({
      Success: true,
      StatusCode: 200,
      Body: JSON.stringify({ success: true }),
    }));

    harness.emitRequest('legacy-request');
    harness.emitRequest('legacy-request');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.scheduled.some((scheduled) => scheduled.delay === 0.5)).toBe(false);
  });

  test('does not evict an unacknowledged response when more than 256 results are pending', async () => {
    const harness = await createHarness(() => {
      throw new Error('server unavailable');
    });

    for (let index = 0; index < 257; index += 1) {
      harness.emitRequest(`request-${index}`);
    }
    harness.emitRequest('request-0');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(257);
    expect(harness.responseBodies).toHaveLength(257);
  });
});

describe('Studio stream framing', () => {
  const acknowledged = () => ({
    Success: true,
    StatusCode: 200,
    Body: JSON.stringify({ success: true, disposition: 'accepted' }),
  });

  function requestEvent(requestId: string, source: string): StudioRequestEvent {
    return {
      kind: 'request',
      requestId,
      logicalSessionId: 'logical-session',
      target: 'edit',
      endpoint: '/api/execute-luau',
      data: { code: source },
    };
  }

  function dispatchedCode(harness: { dispatchRequest: jest.Mock }, call = 0): unknown {
    const request = harness.dispatchRequest.mock.calls[call]?.[0] as { data?: { code?: unknown } } | undefined;
    return request?.data?.code;
  }

  // The bridge writes every chunk frame of one event together, so the plugin
  // saw a 15 KB request as one read holding two frames and discarded it.
  test('a large request whose chunk frames arrive in one read is dispatched whole', async () => {
    const harness = await createHarness(acknowledged);
    const code = `print("${'x'.repeat(15_000)}")`;
    const frames = encodeEventFrames(requestEvent('large-one-read', code));
    expect(frames.length).toBeGreaterThan(1);

    harness.stream.MessageReceived.fire(frames.join(''));

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(dispatchedCode(harness)).toBe(code);
  });

  // Studio hands over whatever each socket read returned, so a frame can be
  // cut anywhere, including inside its JSON and between the two newlines.
  test('frames cut at arbitrary read boundaries are reassembled once', async () => {
    const harness = await createHarness(acknowledged);
    const code = `print("${'y'.repeat(30_000)}")`;
    const stream = encodeEventFrames(requestEvent('large-split-reads', code)).join('');
    // The last cut lands inside the final frame's JSON, so nothing is whole yet.
    const cuts = [1, 7_001, 12_010, 12_011, 25_000, stream.length - 40];
    let previous = 0;
    for (const cut of cuts) {
      harness.stream.MessageReceived.fire(stream.slice(previous, cut));
      previous = cut;
    }
    expect(harness.dispatchRequest).not.toHaveBeenCalled();

    // Everything but the final newline: the frame decodes, so it is taken
    // without waiting for its terminator...
    harness.stream.MessageReceived.fire(stream.slice(previous, stream.length - 1));
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(dispatchedCode(harness)).toBe(code);

    // ...and the terminator arriving on its own is skipped, not a second event.
    harness.stream.MessageReceived.fire(stream.slice(stream.length - 1));
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('two small events in one read are both dispatched, in order', async () => {
    const harness = await createHarness(acknowledged);
    const read = [
      ...encodeEventFrames(requestEvent('first', 'print(1)')),
      ...encodeEventFrames(requestEvent('second', 'print(2)')),
    ].join('');

    harness.stream.MessageReceived.fire(read);

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(2);
    expect(dispatchedCode(harness, 0)).toBe('print(1)');
    expect(dispatchedCode(harness, 1)).toBe('print(2)');
  });
});
