import { PROXY_TIMEOUT_GRACE_MS, ProxyBridgeService } from '../proxy-bridge-service.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS } from '../bridge-service.js';
import type { PluginInstance, PublicPluginInstance } from '../bridge-service.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';

function publicInstance(instance: PluginInstance): PublicPluginInstance {
  return {
    instanceId: instance.instanceId,
    role: instance.role,
    placeId: instance.placeId,
    placeName: instance.placeName,
    dataModelName: instance.dataModelName,
    isRunning: instance.isRunning,
    pluginVersion: instance.pluginVersion,
    pluginVariant: instance.pluginVariant,
    serverVersion: instance.serverVersion,
    lastActivity: instance.lastActivity,
    connectedAt: instance.connectedAt,
  };
}

describe('ProxyBridgeService', () => {
  test('replays cached peers and reports peers discovered after subscription', async () => {
    const now = Date.now();
    const instances: PluginInstance[] = [
      {
        pluginSessionId: 'edit-session',
        physicalSessionId: 'edit-session',
        instanceId: 'anon:proxy-place',
        role: 'edit',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'ProxyPlace',
        isRunning: false,
        pluginVersion: '2.21.0',
        pluginVariant: 'main',
        serverVersion: '2.21.0',
        lastActivity: now,
        connectedAt: now,
      },
    ];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      if (String(input) === 'http://primary/instances') {
        return { ok: true, json: async () => ({ instances: instances.map((instance) => ({ ...instance })) }) } as any;
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      const observed: string[] = [];
      proxy.onInstanceRegistered((instance) => observed.push(`${instance.instanceId}:${instance.role}`));
      expect(observed).toEqual(['anon:proxy-place:edit']);

      instances.push({
        ...instances[0],
        pluginSessionId: 'server-session',
        physicalSessionId: 'server-session',
        role: 'server',
        isRunning: true,
        connectedAt: now + 1,
      });
      await (proxy as any).refreshInstances();
      expect(observed).toEqual(['anon:proxy-place:edit', 'anon:proxy-place:server']);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('unregisterInstanceIdEverywhere removes peers from the primary bridge', async () => {
    const now = Date.now();
    const instances: PluginInstance[] = [
      {
        pluginSessionId: 'edit-session',
        physicalSessionId: 'edit-session',
        instanceId: 'anon:proxy-place',
        role: 'edit',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'ProxyPlace',
        isRunning: false,
        pluginVersion: '2.20.0',
        pluginVariant: 'main',
        serverVersion: '2.20.0',
        lastActivity: now,
        connectedAt: now,
      },
      {
        pluginSessionId: 'server-session',
        physicalSessionId: 'server-session',
        instanceId: 'anon:proxy-place',
        role: 'server',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'Game',
        isRunning: true,
        pluginVersion: '2.20.0',
        pluginVariant: 'main',
        serverVersion: '2.20.0',
        lastActivity: now,
        connectedAt: now,
      },
    ];
    const removed = instances.map(publicInstance);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url === 'http://primary/instances') {
        return { ok: true, json: async () => ({ instances }) } as any;
      }
      if (url === 'http://primary/unregister-instance-id') {
        expect(init).toMatchObject({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(String(init.body))).toEqual({ instanceId: 'anon:proxy-place' });
        return { ok: true, json: async () => ({ success: true, removed }) } as any;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      expect(proxy.getPublicInstances().map((inst) => inst.role).sort()).toEqual(['edit', 'server']);
      await expect(proxy.unregisterInstanceIdEverywhere('anon:proxy-place')).resolves.toEqual(removed);
      expect(proxy.getPublicInstances()).toEqual([]);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  describe('waiting for Studio', () => {
    // A primary that takes every forwarded request and never answers, until
    // the proxy gives up; `failure` replaces the abort with an error of its own.
    function silentPrimary(failure?: Error) {
      const forwarded: Record<string, unknown>[] = [];
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === 'http://primary/instances') {
          return { ok: true, json: async () => ({ instances: [] }) } as unknown as Response;
        }
        if (url === 'http://primary/proxy') {
          forwarded.push(JSON.parse(String(init?.body)));
          if (failure) throw failure;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
            });
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      return { fetchMock, forwarded };
    }

    function outcomeOf(request: Promise<unknown>) {
      const outcome: { error?: Error; settled: boolean } = { settled: false };
      request.then(
        () => { outcome.settled = true; },
        (error: Error) => { outcome.settled = true; outcome.error = error; },
      );
      return outcome;
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    test('forwards the wait its tool asked for, and outlasts the primary', async () => {
      jest.useFakeTimers();
      const { fetchMock, forwarded } = silentPrimary();
      const proxy = new ProxyBridgeService('http://primary');
      try {
        const outcome = outcomeOf(proxy.sendRequest('/api/generate-model', { prompt: 'wolf' }, 'place:1', 'edit', 120_000));
        expect(forwarded).toEqual([expect.objectContaining({ endpoint: '/api/generate-model', timeoutMs: 120_000 })]);

        // The primary's own timeout, which knows whether Studio took the
        // request, must be able to answer first.
        await jest.advanceTimersByTimeAsync(120_000);
        expect(outcome.settled).toBe(false);

        await jest.advanceTimersByTimeAsync(PROXY_TIMEOUT_GRACE_MS);
        expect(outcome.error?.message).toMatch(/^Proxy request timeout: .* \/api\/generate-model after 125 s\./);
        expect(outcome.error?.message).toMatch(/Studio may already have received it/);
      } finally {
        proxy.stop();
        fetchMock.mockRestore();
      }
    });

    test('a call with no wait of its own leaves the primary its default', async () => {
      jest.useFakeTimers();
      const { fetchMock, forwarded } = silentPrimary();
      const proxy = new ProxyBridgeService('http://primary');
      try {
        const outcome = outcomeOf(proxy.sendRequest('/api/get-script-source', {}, 'place:1', 'edit'));
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).not.toHaveProperty('timeoutMs');

        await jest.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
        expect(outcome.settled).toBe(false);
        await jest.advanceTimersByTimeAsync(PROXY_TIMEOUT_GRACE_MS);
        expect(outcome.error?.message).toMatch(/^Proxy request timeout: /);
      } finally {
        proxy.stop();
        fetchMock.mockRestore();
      }
    });

    test("Node's own limit on waiting for an answer reads as the same timeout", async () => {
      const headersTimeout = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      });
      const { fetchMock } = silentPrimary(headersTimeout);
      const proxy = new ProxyBridgeService('http://primary');
      try {
        await expect(proxy.sendRequest('/api/generate-model', {}, 'place:1', 'edit', MAX_REQUEST_TIMEOUT_MS))
          .rejects.toThrow(/^Proxy request timeout: .* \/api\/generate-model after \d+ s\. Studio may already have received it/);
      } finally {
        proxy.stop();
        fetchMock.mockRestore();
      }
    });

    test('a failure that is not a timeout is passed on as it is', async () => {
      const refused = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
      const { fetchMock } = silentPrimary(refused);
      const proxy = new ProxyBridgeService('http://primary');
      try {
        await expect(proxy.sendRequest('/api/generate-model', {}, 'place:1', 'edit', 60_000)).rejects.toBe(refused);
      } finally {
        proxy.stop();
        fetchMock.mockRestore();
      }
    });

    test('every Studio wait a tool may ask for fits through a proxy', () => {
      const limits = TOOL_DEFINITIONS.flatMap((tool) => {
        const timeout = (tool.inputSchema as { properties?: Record<string, { maximum?: unknown }> }).properties?.timeout_ms;
        return typeof timeout?.maximum === 'number' ? [{ tool: tool.name, maximum: timeout.maximum }] : [];
      });
      expect(limits.map((limit) => limit.tool)).toContain('generate_model');
      for (const limit of limits) {
        expect({ tool: limit.tool, fits: limit.maximum <= MAX_REQUEST_TIMEOUT_MS }).toEqual({ tool: limit.tool, fits: true });
      }
    });
  });
});
