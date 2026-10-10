jest.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: jest.fn(() => ({ close: async () => {} })) }));
jest.mock('../auth.js', () => ({ resolveAuthToken: () => ({ token: 'promotion-fixture-private-token', source: 'env' }) }));
jest.mock('../http-server.js', () => ({ ...jest.requireActual('../http-server.js'), createHttpServer: jest.fn(), listenWithRetry: jest.fn() }));
import { createHttpServer, listenWithRetry, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioMCPServer } from '../server.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import type { RojoProxyState } from '../rojo/primary-client.js';
import type { Server } from 'http';

describe('source intent during asynchronous promotion (simulated listen/stdio, actual server control flow)', () => {
  test.each([false, true])('intent changed during bind=%s', async changing => {
    jest.useFakeTimers();
    const processEvents = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const priorProcess = new Map(processEvents.map(event => [event, process.listeners(event)]));
    const priorStdin = new Map(['end', 'close'].map(event => [event, process.stdin.listeners(event)]));
    const originalEnvironment = { ROBLOX_STUDIO_PORT: process.env.ROBLOX_STUDIO_PORT,
      ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: process.env.ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS,
      ROBLOX_STUDIO_REQUIRE_PRIMARY: process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY };
    const apps: Array<{ cleanup: jest.Mock; setMCPServerActive: jest.Mock }> = [];
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ instances: [] }) } as Response);
    jest.mocked(createHttpServer).mockImplementation(() => {
      const app = { cleanup: jest.fn(async () => {}), setMCPServerActive: jest.fn(),
        trackMCPActivity: () => {}, isPluginConnected: () => false, isMCPServerActive: () => true };
      apps.push(app); return app as unknown as RobloxStudioHttpApp;
    });
    let release!: (result: { server: Server; port: number }) => void;
    const binding = new Promise<{ server: Server; port: number }>(resolve => { release = resolve; });
    jest.mocked(listenWithRetry).mockRejectedValueOnce(new Error('Port in use')).mockImplementationOnce(() => binding);
    const close = jest.fn((callback?: () => void) => { callback?.(); return serverHandle; });
    const serverHandle = { close } as unknown as Server;
    process.env.ROBLOX_STUDIO_PORT = '54321';
    process.env.ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS = '100';
    delete process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY;
    const server = new RobloxStudioMCPServer({ name: 'promotion-fixture', version: '3.0.3', tools: [] });
    const internal = server as unknown as { bridge: object; tools: object; rojoClientState: RojoProxyState };
    try {
      await server.run();
      const previousBridge = internal.bridge, previousTools = internal.tools;
      expect(previousBridge).toBeInstanceOf(ProxyBridgeService);
      jest.advanceTimersByTime(100);
      expect(listenWithRetry).toHaveBeenCalledTimes(2);
      if (changing) { internal.rojoClientState.intent = true; internal.rojoClientState.busy = true; }
      release({ server: serverHandle, port: 54321 });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
      if (changing) {
        expect(internal.bridge).toBe(previousBridge); expect(internal.tools).toBe(previousTools);
        expect(close).toHaveBeenCalledTimes(1); expect(apps[1].cleanup).toHaveBeenCalledTimes(1);
        expect(apps[1].setMCPServerActive).not.toHaveBeenCalled();
      } else {
        expect(internal.bridge).not.toBe(previousBridge);
        expect(internal.bridge).not.toBeInstanceOf(ProxyBridgeService);
        expect(apps[1].setMCPServerActive).toHaveBeenCalledWith(true);
      }
    } finally {
      internal.rojoClientState.busy = false;
      const shutdown = process.listeners('SIGTERM').find(listener => !priorProcess.get('SIGTERM')!.includes(listener));
      if (shutdown) await (shutdown as () => Promise<void>)();
      for (const event of processEvents) for (const listener of process.listeners(event)) if (!priorProcess.get(event)!.includes(listener)) process.removeListener(event, listener);
      for (const [event, previous] of priorStdin) for (const listener of process.stdin.listeners(event)) if (!previous.includes(listener)) process.stdin.removeListener(event, listener as () => void);
      for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); jest.clearAllMocks();
    }
  });
});
