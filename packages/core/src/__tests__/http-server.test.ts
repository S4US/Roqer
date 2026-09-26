import request from 'supertest';
import { TOOL_HANDLERS, createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { detectStudioPlatform } from '../studio-platform.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

class HttpTestBridgeService extends BridgeService {
  protected override notifyInstanceRegistered(): void {
    // HTTP route tests do not need managed-Studio lifecycle association.
  }
}

const READY_BODY = {
  pluginSessionId: 'session-1',
  physicalSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
};

const TEST_SERVER_CONFIG = {
  name: 'robloxstudio-mcp',
  version: READY_BODY.pluginVersion,
  tools: [],
};

describe('HTTP Server', () => {
  let app: RobloxStudioHttpApp;
  let bridge: HttpTestBridgeService;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    bridge = new HttpTestBridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge, undefined, TEST_SERVER_CONFIG);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  describe('Health Check', () => {
    test('returns health status', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'robloxstudio-mcp',
        serverName: 'robloxstudio-mcp',
        capabilities: {
          studioLifecycle: {
            protocolVersion: 3,
            endpoint: '/mcp/manage_instance',
          },
        },
        pluginConnected: false,
        mcpServerActive: false,
        activeEventStreams: 0,
      });
    });

    test('advertises Studio lifecycle only when manage_instance is callable', async () => {
      const inspectorApp = createHttpServer(
        tools,
        bridge,
        new Set(['get_place_info']),
        { name: 'robloxstudio-mcp-inspector', version: '2.0.0', tools: [] },
      );

      const response = await request(inspectorApp).get('/health').expect(200);
      expect(response.body.serverName).toBe('robloxstudio-mcp-inspector');
      expect(response.body.capabilities.studioLifecycle).toBeUndefined();
      await request(inspectorApp).post('/mcp/manage_instance').send({ action: 'status' }).expect(404);
    });

    test('advertises the live process-identity launcher capability', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.body.capabilities.studioLifecycle).toMatchObject({
        hostPlatform: expect.any(String),
        windowsInteropAvailable: expect.any(Boolean),
        processIdentity: {
          supported: expect.any(Boolean),
          launcher: expect.any(String),
        },
      });
    });

    test('returns a structured guaranteed pre-spawn rejection when process identity is unavailable', async () => {
      const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
      const unsupportedTools = new RobloxStudioTools(bridge);
      Object.defineProperty(unsupportedTools, 'instanceManager', {
        value: new StudioInstanceManager({
          registryDir,
          platformCapabilities: detectStudioPlatform({
            platform: 'linux',
            kernelVersion: 'Linux version 6.8.0-generic',
            windowsInteropAvailable: false,
          }),
          processAdapter: {
            currentBootId: () => 'boot-1',
            observeStudioProcesses: () => ({
              status: 'ok',
              observedAt: Date.now(),
              processes: [],
            }),
          },
        }),
      });
      const unsupportedApp = createHttpServer(
        unsupportedTools,
        bridge,
        new Set(['manage_instance']),
      );

      try {
        const health = await request(unsupportedApp).get('/health').expect(200);
        expect(health.body.capabilities.studioLifecycle.processIdentity).toMatchObject({
          supported: false,
          launcher: 'unavailable',
        });

        const response = await request(unsupportedApp)
          .post('/mcp/manage_instance')
          .send({
            action: 'launch',
            source: 'baseplate',
            require_process_identity: true,
          })
          .expect(409);
        expect(response.body).toEqual(expect.objectContaining({
          error: 'process_identity_unavailable',
          launch_stage: 'pre_spawn',
          process_created: false,
          safe_to_fallback: true,
          launcher: 'unavailable',
          message: expect.stringContaining('require_process_identity'),
          remediation: expect.any(String),
        }));
      } finally {
        fs.rmSync(registryDir, { recursive: true, force: true });
      }
    });
  });

  describe('Tool Handlers', () => {
    test('a tool result marked as an error keeps the mark over HTTP, and a success stays a bare object', async () => {
      const failed = { path: 'operations/op-1', done: true, error: { code: 'Internal', message: 'Unknown Error' }, status: 'failed' };
      const uploadAsset = jest.spyOn(tools, 'uploadAsset')
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(failed) }], isError: true } as never)
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ ...failed, error: undefined, status: 'complete' }) }] });

      const refused = await request(app).post('/mcp/upload_asset').send({ action: 'status', operationId: 'op-1' }).expect(200);
      expect(refused.body).toEqual({ content: [], structuredContent: failed, isError: true });

      const complete = await request(app).post('/mcp/upload_asset').send({ action: 'status', operationId: 'op-1' }).expect(200);
      expect(complete.body).toEqual({ path: 'operations/op-1', done: true, status: 'complete' });
      expect(uploadAsset).toHaveBeenCalledTimes(2);
    });

    test('get_script_source only accepts line_range for range selection', async () => {
      const getScriptSource = jest.fn(async () => ({ content: [] }));
      const fakeTools = { getScriptSource } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.get_script_source(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-12',
        instance_id: 'place:test',
        instanceRef: 'iref:test:1',
      });
      expect(getScriptSource).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 10, 12, 'place:test', 'iref:test:1');

      await TOOL_HANDLERS.get_script_source(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        startLine: 20,
        endLine: 25,
        lineRange: '30-35',
        instance_id: 'place:test',
      });
      expect(getScriptSource).toHaveBeenLastCalledWith('game.ServerScriptService.Main', undefined, undefined, 'place:test', undefined);
    });

    test('set_script_source forwards the revision and stable Instance reference', async () => {
      const setScriptSource = jest.fn(async () => ({ content: [] }));
      const fakeTools = { setScriptSource } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.set_script_source(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        instanceRef: 'iref:test:1',
        source: 'print("updated")',
        expectedRevision: 'sr1:14:12345678',
        instance_id: 'place:test',
      });

      expect(setScriptSource).toHaveBeenCalledWith(
        'game.ServerScriptService.Main',
        'print("updated")',
        'place:test',
        'sr1:14:12345678',
        'iref:test:1',
      );
    });

    test('script line tools parse line_range through the shared handler helpers', async () => {
      const editScriptLines = jest.fn(async () => ({ content: [] }));
      const deleteScriptLines = jest.fn(async () => ({ content: [] }));
      const fakeTools = { editScriptLines, deleteScriptLines } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        line_range: '42',
        instance_id: 'place:test',
        instanceRef: 'iref:test:1',
      });
      expect(editScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 'old', 'new', 42, 'place:test', 'iref:test:1');

      // A closed range is accepted when it covers exactly the lines old_string
      // spans, so the parameter means the same thing it does on the other line
      // tools. The anchor is still the first of those lines.
      await TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'first\nsecond\nthird',
        new_string: 'replacement',
        line_range: '42-44',
        instance_id: 'place:test',
      });
      expect(editScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 'first\nsecond\nthird', 'replacement', 42, 'place:test', undefined);

      // Text ending in a newline is covered by either reading of its last line.
      for (const range of ['42-43', '42-44']) {
        await TOOL_HANDLERS.edit_script_lines(fakeTools, {
          instancePath: 'game.ServerScriptService.Main',
          old_string: 'first\nsecond\n',
          new_string: '',
          line_range: range,
          instance_id: 'place:test',
        });
        expect(editScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 'first\nsecond\n', '', 42, 'place:test', undefined);
      }

      await TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-12',
        instance_id: 'place:test',
      });
      expect(deleteScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 10, 12, 'place:test', undefined, undefined);

      // The read revision travels with a line-addressed delete.
      await TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-12',
        instance_id: 'place:test',
        expectedRevision: 'rev-read',
      });
      expect(deleteScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 10, 12, 'place:test', undefined, 'rev-read');

      await TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        startLine: 99,
        instance_id: 'place:test',
      });
      expect(editScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 'old', 'new', undefined, 'place:test', undefined);
    });

    test('edit_script_batch anchors every edit with the same rule a single edit uses', async () => {
      const editScriptBatch = jest.fn(async () => ({ content: [] }));
      const fakeTools = { editScriptBatch } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.edit_script_batch(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        instanceRef: 'iref:test:1',
        expectedRevision: 'sr1:14:12345678',
        edits: [
          { old_string: 'first', new_string: 'FIRST', line_range: '42' },
          { old_string: 'second', new_string: 'SECOND' },
        ],
        instance_id: 'place:test',
      });

      expect(editScriptBatch).toHaveBeenLastCalledWith(
        'game.ServerScriptService.Main',
        [
          { old_string: 'first', new_string: 'FIRST', startLine: 42 },
          { old_string: 'second', new_string: 'SECOND' },
        ],
        'place:test',
        'sr1:14:12345678',
        'iref:test:1',
      );
    });

    test('edit_script_batch refuses a per-edit range that disagrees with its old_string', async () => {
      const editScriptBatch = jest.fn(async () => ({ content: [] }));
      const fakeTools = { editScriptBatch } as unknown as RobloxStudioTools;

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.edit_script_batch(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        expectedRevision: 'sr1:14:12345678',
        edits: [
          { old_string: 'fine', new_string: 'ok' },
          { old_string: 'old', new_string: 'new', line_range: '10-12' },
        ],
      }))).rejects.toThrow(/edit 2 line_range "10-12" disagrees with old_string/);
      expect(editScriptBatch).not.toHaveBeenCalled();
    });

    test('edit_script_batch refuses to place several matches without a read revision', async () => {
      // A batch resolves every old_string against one source the caller read,
      // so a script that moved underneath would place all of them somewhere the
      // caller never looked. Refused before anything reaches Studio.
      const tools = new RobloxStudioTools(new BridgeService());

      await expect(tools.editScriptBatch('game.ServerScriptService.Main', [
        { old_string: 'a', new_string: 'b' },
      ])).rejects.toThrow(/expectedRevision is required/);

      await expect(tools.editScriptBatch('game.ServerScriptService.Main', [], undefined, 'sr1:1:1'))
        .rejects.toThrow(/non-empty edits array/);
    });

    test('script line tools reject unsupported line_range shapes', async () => {
      const editScriptLines = jest.fn(async () => ({ content: [] }));
      const deleteScriptLines = jest.fn(async () => ({ content: [] }));
      const fakeTools = { editScriptLines, deleteScriptLines } as unknown as RobloxStudioTools;

      // The range says three lines, old_string covers one: refused rather than
      // applied to whichever lines old_string happens to sit on.
      await expect(Promise.resolve().then(() => TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        line_range: '10-12',
      }))).rejects.toThrow(/disagrees with old_string, which covers lines 10-10/);
      expect(editScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        line_range: '10-',
      }))).rejects.toThrow(/closed range/);
      expect(editScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-',
      }))).rejects.toThrow(/requires line_range/);
      expect(deleteScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '0',
      }))).rejects.toThrow(/line_range must/);
      expect(deleteScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '12-10',
      }))).rejects.toThrow(/line_range must/);
      expect(deleteScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        startLine: 10,
        endLine: 12,
      }))).rejects.toThrow(/requires line_range/);
      expect(deleteScriptLines).not.toHaveBeenCalled();
    });

    test('multiplayer handler forwards only supported start arguments', async () => {
      const multiplayerPlaytest = jest.fn(async () => ({ content: [] }));
      const fakeTools = { multiplayerPlaytest } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.multiplayer_playtest(fakeTools, {
        action: 'start',
        numPlayers: 2,
        timeout: 5,
        instance_id: 'place:test',
      });
      expect(multiplayerPlaytest).toHaveBeenLastCalledWith('start', 2, undefined, undefined, undefined, 5, 'place:test');
    });

    test('selection handler forwards the lifecycle action and options together', async () => {
      const selection = jest.fn(async () => ({ content: [] }));
      const fakeTools = { selection } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.selection(fakeTools, {
        action: 'view',
        path: 'game.Workspace.Subject',
        padding: 1.25,
        instance_id: 'place:test',
      });

      expect(selection).toHaveBeenLastCalledWith(
        'view',
        expect.objectContaining({
          action: 'view',
          path: 'game.Workspace.Subject',
          padding: 1.25,
          instance_id: 'place:test',
        }),
        'place:test',
      );
    });

    test('inspect_ui forwards bounded semantic options and client routing', async () => {
      const inspectUi = jest.fn(async () => ({ content: [] }));
      const fakeTools = { inspectUi } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.inspect_ui(fakeTools, {
        mode: 'audit',
        root: { ref: 'ir:client:1' },
        visible_only: true,
        max_depth: 6,
        max_nodes: 120,
        include_text: false,
        include_styles: true,
        target: 'client-2',
        instance_id: 'place:test',
      });

      expect(inspectUi).toHaveBeenCalledWith(
        'audit',
        { ref: 'ir:client:1' },
        true,
        6,
        120,
        false,
        true,
        'client-2',
        'place:test',
      );
    });

    test('interact_ui forwards selector, action data, and client routing', async () => {
      const interactUi = jest.fn(async () => ({ content: [] }));
      const fakeTools = { interactUi } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.interact_ui(fakeTools, {
        action: 'set_scroll',
        selector: { ref: 'ir:client:2', role: 'scroll_container' },
        text: undefined,
        canvas_position: { x: 12, y: 34 },
        target: 'client-2',
        instance_id: 'place:test',
      });

      expect(interactUi).toHaveBeenCalledWith(
        'set_scroll',
        { ref: 'ir:client:2', role: 'scroll_container' },
        undefined,
        { x: 12, y: 34 },
        'client-2',
        'place:test',
      );
    });

    test('grep_scripts uses only usePattern for pattern mode', async () => {
      const grepScripts = jest.fn(async () => ({ content: [] }));
      const fakeTools = { grepScripts } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.grep_scripts(fakeTools, {
        pattern: 'foo|bar',
        isRegex: true,
        instance_id: 'place:test',
      });
      expect(grepScripts).toHaveBeenLastCalledWith('foo|bar', expect.objectContaining({
        usePattern: undefined,
      }), 'place:test');

      await TOOL_HANDLERS.grep_scripts(fakeTools, {
        pattern: 'foo|bar',
        usePattern: true,
        instance_id: 'place:test',
      });
      expect(grepScripts).toHaveBeenLastCalledWith('foo|bar', expect.objectContaining({
        usePattern: true,
      }), 'place:test');
    });
  });

  describe('Plugin Connection Management', () => {
    test('does not expose the retired polling transport', async () => {
      await request(app).get('/poll').expect(404);
    });

    test('plugin ready notification', async () => {
      const response = await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(response.body).toMatchObject({ success: true, assignedRole: 'edit', instanceId: 'place:test' });
      expect(app.isPluginConnected()).toBe(true);
    });

    test('maps logical clients to a physical server session and rejects logical event streams', async () => {
      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'server-session',
        physicalSessionId: 'server-session',
        role: 'server',
        isRunning: true,
      }).expect(200);
      const clientReady = await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'client-session',
        physicalSessionId: 'server-session',
        role: 'client',
        isRunning: true,
      }).expect(200);

      expect(clientReady.body.assignedRole).toBe('client-1');
      expect(bridge.getInstanceBySessionId('client-session')?.physicalSessionId).toBe('server-session');
      const publicStatus = await request(app).get('/status').expect(200);
      expect(publicStatus.body.instances[0]).not.toHaveProperty('physicalSessionId');
      expect(publicStatus.body.instances[1]).not.toHaveProperty('physicalSessionId');
      const logicalEvents = await request(app)
        .get('/events?pluginSessionId=client-session')
        .expect(409);
      expect(logicalEvents.body).toEqual({
        error: 'logical_session_has_no_event_stream',
        physicalSessionId: 'server-session',
      });
      await request(app).get('/events?pluginSessionId=unknown-session').expect(404, {
        error: 'unknown_session',
        knownInstance: false,
      });
      await request(app)
        .post('/disconnect')
        .send({ pluginSessionId: 'server-session' })
        .expect(200);
      expect(bridge.getInstanceBySessionId('server-session')).toBeUndefined();
      expect(bridge.getInstanceBySessionId('client-session')).toBeUndefined();
    });

    test('rejects logical clients without a matching physical server owner', async () => {
      const missingOwner = await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'client-session',
        physicalSessionId: 'missing-server',
        role: 'client',
        isRunning: true,
      }).expect(409);
      expect(missingOwner.body).toMatchObject({
        success: false,
        error: 'physical_session_unavailable',
      });
      expect(bridge.getInstanceBySessionId('client-session')).toBeUndefined();

      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'edit-session',
        physicalSessionId: 'edit-session',
      }).expect(200);
      const nonServerOwner = await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'client-session',
        physicalSessionId: 'edit-session',
        role: 'client',
        isRunning: true,
      }).expect(409);
      expect(nonServerOwner.body.error).toBe('physical_session_unavailable');
      expect(bridge.getInstanceBySessionId('client-session')).toBeUndefined();
    });

    test('rejects physical client and logical non-client roles', async () => {
      const physicalClient = await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'client-session',
        physicalSessionId: 'client-session',
        role: 'client',
        isRunning: true,
      }).expect(400);
      expect(physicalClient.body).toMatchObject({
        success: false,
        error: 'invalid_session_topology',
      });

      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'server-session',
        physicalSessionId: 'server-session',
        role: 'server',
        isRunning: true,
      }).expect(200);
      const logicalEdit = await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'logical-edit',
        physicalSessionId: 'server-session',
        role: 'edit',
      }).expect(400);
      expect(logicalEdit.body).toMatchObject({
        success: false,
        error: 'invalid_session_topology',
      });
    });

    test('rejects a plugin whose version does not match the bundled server', async () => {
      const versionedApp = createHttpServer(
        tools,
        bridge,
        undefined,
        { name: 'robloxstudio-mcp', version: '2.0.0', tools: [] },
      );
      const mismatch = await request(versionedApp).post('/ready').send({
        ...READY_BODY,
        pluginVersion: '1.9.0',
      }).expect(426);
      expect(mismatch.body).toMatchObject({
        success: false,
        error: 'plugin_version_mismatch',
        pluginVersion: '1.9.0',
        serverVersion: '2.0.0',
      });
      expect(bridge.getInstances()).toEqual([]);

      await request(versionedApp).post('/ready').send({
        ...READY_BODY,
        pluginVersion: '2.0.0',
      }).expect(200);
      const health = await request(versionedApp).get('/health').expect(200);
      expect(health.body).toMatchObject({
        serverVersion: '2.0.0',
        pluginConnected: true,
      });
      expect(health.body.instances[0]).toMatchObject({
        pluginVersion: '2.0.0',
        pluginVariant: 'main',
        serverVersion: '2.0.0',
      });
      expect(health.body).not.toHaveProperty('versionMismatch');
    });

    test('refuses a plugin of the other edition so the inspector stays read-only', async () => {
      const inspectorApp = createHttpServer(tools, bridge, undefined, {
        ...TEST_SERVER_CONFIG,
        name: 'robloxstudio-mcp-inspector',
        pluginVariant: 'inspector',
      });
      const fullPlugin = await request(inspectorApp).post('/ready').send(READY_BODY).expect(409);
      expect(fullPlugin.body).toMatchObject({
        success: false,
        error: 'plugin_variant_mismatch',
        pluginVariant: 'main',
        expectedVariant: 'inspector',
      });
      expect(bridge.getInstances()).toEqual([]);
      await request(inspectorApp).post('/ready').send({ ...READY_BODY, pluginVariant: 'inspector' }).expect(200);
      await inspectorApp.cleanup();

      const fullApp = createHttpServer(tools, new HttpTestBridgeService(), undefined, {
        ...TEST_SERVER_CONFIG,
        pluginVariant: 'main',
      });
      const inspectorPlugin = await request(fullApp).post('/ready')
        .send({ ...READY_BODY, pluginVariant: 'inspector' }).expect(409);
      expect(inspectorPlugin.body.error).toBe('plugin_variant_mismatch');
      await fullApp.cleanup();
    });

    test('an inspector primary will not forward raw endpoints for the full edition', async () => {
      const inspectorApp = createHttpServer(tools, bridge, undefined, {
        ...TEST_SERVER_CONFIG,
        name: 'robloxstudio-mcp-inspector',
        pluginVariant: 'inspector',
      });
      const write = {
        endpoint: '/api/set-properties',
        data: { instancePath: 'game.Workspace.Part', properties: { Name: 'Changed' } },
        targetInstanceId: 'place:test',
        targetRole: 'edit',
      };
      for (const body of [{ ...write, pluginVariant: 'main' }, write]) {
        const refused = await request(inspectorApp).post('/proxy').send(body).expect(409);
        expect(refused.body.error).toBe('edition_mismatch');
      }
      expect(bridge.getPendingRequestCount()).toBe(0);
      await inspectorApp.cleanup();
    });

    test('rejects /ready when the server has no version contract', async () => {
      const configlessApp = createHttpServer(tools, bridge);
      const response = await request(configlessApp).post('/ready').send(READY_BODY).expect(503);
      expect(response.body).toMatchObject({
        success: false,
        error: 'server_version_unavailable',
      });
      expect(bridge.getInstances()).toEqual([]);
      await configlessApp.cleanup();
    });

    test('rejects /ready without required fields', async () => {
      const response = await request(app).post('/ready').send({ role: 'client' }).expect(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'missing_ready_fields',
        message: '/ready missing required field(s): pluginSessionId, physicalSessionId, instanceId, pluginVersion, pluginVariant',
        missingFields: ['pluginSessionId', 'physicalSessionId', 'instanceId', 'pluginVersion', 'pluginVariant'],
        request: { role: 'client' },
      });
    });

    test('rejects duplicate (instanceId, role) on /ready', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const dup = await request(app)
        .post('/ready')
        .send({ ...READY_BODY, pluginSessionId: 'session-2', physicalSessionId: 'session-2' })
        .expect(409);
      expect(dup.body).toMatchObject({
        success: false,
        error: 'duplicate_instance_role',
        message: 'Another plugin is already registered as (place:test, edit).',
        request: {
          instanceId: 'place:test',
          role: 'edit',
          placeId: 0,
          placeName: 'TestPlace',
          dataModelName: 'TestPlace',
          isRunning: false,
        },
        existing: {
          instanceId: 'place:test',
          role: 'edit',
        },
      });
    });

    test('plugin disconnect by pluginSessionId', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(app.isPluginConnected()).toBe(true);
      const response = await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(false);
    });

    test('unregisters every peer for an instance id for proxy cleanup', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'session-server',
        physicalSessionId: 'session-server',
        role: 'server',
        isRunning: true,
      }).expect(200);

      const response = await request(app)
        .post('/unregister-instance-id')
        .send({ instanceId: 'place:test' })
        .expect(200);

      expect(response.body).toMatchObject({ success: true });
      expect(response.body.removed.map((inst: { role: string }) => inst.role).sort()).toEqual(['edit', 'server']);
      expect(app.isPluginConnected()).toBe(false);
    });

    test('disconnect rejects pending requests targeting that tuple', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const p1 = bridge.sendRequest('/api/test1', {}, 'place:test', 'edit');
      const p2 = bridge.sendRequest('/api/test2', {}, 'place:test', 'edit');
      p1.catch(() => {});
      p2.catch(() => {});
      expect(bridge.getPendingRequestCount()).toBe(2);
      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    test('stale instance detection via unregister', () => {
      bridge.registerInstance({
        pluginSessionId: 'stale-1',
        physicalSessionId: 'stale-1',
        instanceId: 'place:s',
        role: 'edit',
      });
      expect(app.isPluginConnected()).toBe(true);
      bridge.unregisterInstance('stale-1');
      expect(app.isPluginConnected()).toBe(false);
    });
  });


  describe('Response Handling', () => {
    test('acknowledges accepted and repeated successful responses', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const requestPromise = bridge.sendRequest('/api/test', {}, 'place:test', 'edit');
      const pending = bridge.claimNextRequestForPhysical('session-1', 'test-success-response')!;

      const accepted = await request(app)
        .post('/response')
        .send({ requestId: pending.requestId, response: { result: 'success' } })
        .expect(200);
      expect(accepted.body).toEqual({ success: true, disposition: 'accepted' });

      const repeated = await request(app)
        .post('/response')
        .send({ requestId: pending.requestId, response: { result: 'duplicate' } })
        .expect(200);
      expect(repeated.body).toEqual({ success: true, disposition: 'already_settled' });
      await expect(requestPromise).resolves.toEqual({ result: 'success' });
    });

    test('treats an empty-string error as an accepted rejection', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const requestPromise = bridge.sendRequest('/api/test', {}, 'place:test', 'edit');
      requestPromise.catch(() => {});
      const pending = bridge.claimNextRequestForPhysical('session-1', 'test-error-response')!;

      const response = await request(app)
        .post('/response')
        .send({ requestId: pending.requestId, error: '' })
        .expect(200);
      expect(response.body).toEqual({ success: true, disposition: 'accepted' });
      await expect(requestPromise).rejects.toBe('');
    });

    test('reports an unknown settlement with HTTP 404', async () => {
      const response = await request(app)
        .post('/response')
        .send({ requestId: 'never-issued', response: { result: 'late' } })
        .expect(404);
      expect(response.body).toEqual({ success: false, disposition: 'unknown' });
    });

    test('rejects malformed request IDs with HTTP 400', async () => {
      for (const body of [{}, { requestId: '' }, { requestId: 42 }, { requestId: null }]) {
        const response = await request(app).post('/response').send(body).expect(400);
        expect(response.body).toEqual({
          success: false,
          error: 'invalid_request_id',
        });
      }
    });
  });

  describe('MCP Server State', () => {
    test('tracks activity', async () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);
      app.trackMCPActivity();
      expect(app.isMCPServerActive()).toBe(true);
    });

    test('times out after inactivity', () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);
      const original = Date.now;
      Date.now = jest.fn(() => original() + 31000);
      expect(app.isMCPServerActive()).toBe(false);
      Date.now = original;
    });
  });

  describe('Status Endpoint', () => {
    test('returns current status', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const response = await request(app).get('/status').expect(200);
      expect(response.body).toMatchObject({ pluginConnected: true, mcpServerActive: true });
      expect(response.body.instances).toHaveLength(1);
      expect(response.body.instances[0]).toMatchObject({
        instanceId: 'place:test',
        role: 'edit',
        placeName: 'TestPlace',
      });
    });
  });
});
