import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { RojoProxyState } from '../rojo/primary-client.js';
import type { RojoDelegateRequest } from '../rojo/primary-service.js';
import { sourceRevision } from '../rojo/source-revision.js';
import * as sourcemap from '../rojo/sourcemap.js';
import * as rojoServer from '../rojo/rojo-server.js';

// Real loopback HTTP, ProxyBridgeService, primary Tools, queue admission, and
// temporary project files. Studio responses are simulated at the delivery
// claim/resolve boundary; Rojo CLI output and server probing are fixtures.
// Git is real, with temporary repositories and a private empty configuration;
// caller Git failures and configuration propagation have their own regression suite.
// This suite neither launches Studio nor proves live Rojo propagation.
const INSTANCE = 'place:42';
const SCRIPT = 'game.ServerScriptService.Main';
const STUDIO_ONLY_SCRIPT = 'game.ServerScriptService.Other';
const AUTH = 'fixture-only-private-http-token';
const PHYSICAL = 'fixture-peer';
const fixtureMap = { name: 'Fixture', className: 'DataModel', children: [
  { name: 'ServerScriptService', className: 'ServerScriptService', children: [
    { name: 'Main', className: 'Script', filePaths: ['src/Main.server.luau'] },
  ] },
] };

interface ToolEnvelope { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }
const bodyOf = (value: unknown): Record<string, unknown> => {
  const envelope = value as ToolEnvelope;
  if (envelope.structuredContent) return envelope.structuredContent;
  if (envelope.content) return JSON.parse(envelope.content.find((item) => typeof item.text === 'string')!.text!);
  return value as Record<string, unknown>;
};

let directory: string;
let runFixture: jest.SpiedFunction<typeof sourcemap.execRojoWithEnvironment>;
let previousGitEnvironment: Map<string, string | undefined>;
const fixtureMaps = new Map<string, unknown>();
const hosts: Host[] = [];

interface Host {
  bridge: BridgeService;
  tools: RobloxStudioTools;
  app: RobloxStudioHttpApp;
  server: Server;
  base: string;
  studio: { source: string; otherSource: string; mainMissing: boolean; syncFile?: string };
  peer: { deferPlan?: (requestId: string, response: Record<string, unknown>) => boolean };
  calls: Array<{ endpoint: string; data: Record<string, unknown> }>;
  clients: Array<{ bridge: ProxyBridgeService; tools: RobloxStudioTools; state: RojoProxyState }>;
  detachPeer: () => void;
}

function project(name: string, content = 'local x = 1\n') {
  const root = path.join(directory, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const projectFile = path.join(root, 'default.project.json');
  const file = path.join(root, 'src/Main.server.luau');
  fs.writeFileSync(projectFile, JSON.stringify({ name, tree: { $className: 'DataModel' } }));
  fs.writeFileSync(file, content);
  execFileSync('git', ['init', '--quiet', root], { timeout: 10_000, windowsHide: true, stdio: 'pipe' });
  fixtureMaps.set(root, fixtureMap);
  return { root, projectFile: fs.realpathSync.native(projectFile), file };
}

async function host(variant: 'main' | 'inspector' = 'main'): Promise<Host> {
  const bridge = new BridgeService();
  const tools = new RobloxStudioTools(bridge);
  const app = createHttpServer(tools, bridge, undefined, { name: 'fixture-rojo-http', version: '3.0.3', tools: [], pluginVariant: variant }, { authToken: AUTH });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const studio: Host['studio'] = { source: 'local x = 1\n', otherSource: 'local other = 1\n', mainMissing: false };
  const peer: Host['peer'] = {};
  const calls: Host['calls'] = [];
  const detachPeer = bridge.onRequestAvailable((physical) => {
    if (physical !== PHYSICAL) return;
    for (;;) {
      const request = bridge.claimNextRequestForPhysical(PHYSICAL, 'fixture-delivery');
      if (!request) return;
      const data = request.data as Record<string, unknown>;
      calls.push({ endpoint: request.endpoint, data });
      const other = data.instancePath === STUDIO_ONLY_SCRIPT;
      const observedSource = other ? studio.otherSource
        : studio.syncFile && fs.existsSync(studio.syncFile) ? fs.readFileSync(studio.syncFile, 'utf8') : studio.source;
      const identity = { instancePath: other ? STUDIO_ONLY_SCRIPT : SCRIPT, instanceRef: other ? 'ref:fixture-other' : 'ref:fixture-main', className: 'Script', uniquePath: true };
      let response: Record<string, unknown>;
      if (request.endpoint === '/api/get-script-source') {
        response = !other && studio.mainMissing
          ? { error: data.instanceRef ? `Instance reference is invalid or no longer live: ${data.instanceRef}` : `Instance not found: ${SCRIPT}` }
          : { ...identity, source: observedSource, numberedSource: `1: ${observedSource}`, lineCount: 1, revision: sourceRevision(observedSource) };
      } else if (request.endpoint === '/api/edit-script-lines' || request.endpoint === '/api/set-script-source') {
        const source = request.endpoint === '/api/set-script-source'
          ? String(data.source) : observedSource.replace(String(data.old_string), String(data.new_string));
        response = { ...identity, previousRevision: sourceRevision(observedSource), revision: sourceRevision(source) };
        if (data.planOnly === true) response = { ...response, planned: true, source };
        else { if (other) studio.otherSource = source; else studio.source = source; response.success = true; }
        if (data.planOnly === true && peer.deferPlan?.(request.requestId, response)) continue;
      } else if (request.endpoint === '/api/start-playtest' || request.endpoint === '/api/multiplayer-test-start') {
        // Reaching this reply proves admission allowed actual delivery. The
        // simulated peer deliberately declines to create runtime sessions.
        response = { success: false, error: 'fixture_peer_received_start', fixtureDispatch: true };
      } else response = { error: `Unexpected simulated Studio endpoint: ${request.endpoint}` };
      bridge.resolveRequest(request.requestId, response);
    }
  });
  bridge.registerInstance({ pluginSessionId: PHYSICAL, physicalSessionId: PHYSICAL, instanceId: INSTANCE, placeId: 42,
    role: 'edit', placeName: 'Fixture', dataModelName: 'Fixture', isRunning: false,
    pluginVersion: '3.0.3', serverVersion: '3.0.3', pluginVariant: variant });
  const result: Host = { bridge, tools, app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, studio, peer, calls, clients: [], detachPeer };
  hosts.push(result);
  return result;
}

async function proxy(primary: Host, defaultProject?: string) {
  const state = new RojoProxyState(defaultProject);
  const bridge = new ProxyBridgeService(primary.base, AUTH, 'main', state.clientId);
  const tools = new RobloxStudioTools(bridge, { rojoProject: defaultProject, rojoClientState: state });
  const result = { bridge, tools, state };
  primary.clients.push(result);
  await bridge.waitForInitialRefresh();
  return result;
}

async function http(primary: Host, route: string, payload?: unknown, options: { auth?: boolean; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${primary.base}${route}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...(options.auth === false ? {} : { 'X-MCP-Auth': AUTH }), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function packet(epoch: string, toolName = 'get_script_source', args: Record<string, unknown> = { instancePath: SCRIPT, instance_id: INSTANCE }) {
  return { protocol: 1, clientId: randomUUID(), operationId: randomUUID(), epoch, kind: 'call', toolName, args,
    cwd: directory, environment: {}, state: { version: 0, defaultAttempted: false, bindings: [] }, pluginVariant: 'main' };
}

beforeEach(() => {
  directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer primary http ')));
  previousGitEnvironment = new Map(Object.keys(process.env).filter(name => name.toUpperCase().startsWith('GIT_')).map(name => [name, process.env[name]]));
  for (const name of previousGitEnvironment.keys()) delete process.env[name];
  const configuration = path.join(directory, 'gitconfig-empty');
  fs.writeFileSync(configuration, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = configuration;
  fixtureMaps.clear();
  const run = async (args: string[], cwd: string) => args[0] === '--version' ? 'Rojo 7.6.1' : JSON.stringify(fixtureMaps.get(cwd) ?? fixtureMap);
  runFixture = jest.spyOn(sourcemap, 'execRojoWithEnvironment').mockImplementation(run);
  jest.spyOn(sourcemap, 'execRojo').mockImplementation(run);
  jest.spyOn(rojoServer, 'probeRojoServer').mockResolvedValue({ reachable: false });
});

afterEach(async () => {
  for (const primary of hosts.splice(0)) {
    for (const client of primary.clients) {
      await client.tools.releaseRojoClient().catch(() => {});
      client.bridge.stop();
      await client.tools.settled();
    }
    await primary.tools.settled();
    primary.detachPeer();
    primary.bridge.clearAllPendingRequests();
    await primary.app.cleanup();
    primary.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => primary.server.close((error) => error ? reject(error) : resolve()));
  }
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (name.toUpperCase().startsWith('GIT_')) delete process.env[name];
  for (const [name, value] of previousGitEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe('primary source ownership through actual loopback HTTP (Studio and Rojo CLI fixtures)', () => {
  test('two proxy links/unlinks are isolated, while primary local Tools and HTTP share their own scope', async () => {
    const primary = await host();
    const aProject = project('A');
    const bProject = project('B', 'different disk text\n');
    const localProject = project('Local');
    const a = await proxy(primary);
    const b = await proxy(primary);
    expect(bodyOf(await a.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: path.relative(process.cwd(), aProject.projectFile) })).linked).toBe(true);
    expect(bodyOf(await b.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: bProject.projectFile })).linked).toBe(true);
    expect(a.state.checkpoint.bindings[0].projectFile).toBe(aProject.projectFile);
    expect(b.state.checkpoint.bindings[0].projectFile).toBe(bProject.projectFile);
    expect(bodyOf(await a.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).toMatchObject({ persistence: 'file', fileMatchesStudio: true,
      revision: sourceRevision('local x = 1\n'), fileRevision: sourceRevision('local x = 1\n') });
    expect(bodyOf(await b.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).toMatchObject({ persistence: 'file', fileMatchesStudio: false,
      revision: sourceRevision('local x = 1\n'), fileRevision: sourceRevision('different disk text\n') });
    expect(bodyOf(await primary.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: localProject.projectFile })).linked).toBe(true);
    expect(bodyOf((await http(primary, '/mcp/get_script_source', { instancePath: SCRIPT, instance_id: INSTANCE })).body).persistence).toBe('file');
    expect(bodyOf((await http(primary, '/mcp/manage_instance', { action: 'unlink_project', instance_id: INSTANCE })).body).unlinked).toBe(true);
    expect(bodyOf(await primary.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).not.toHaveProperty('persistence');
    expect(bodyOf(await a.tools.manageInstance({ action: 'unlink_project', instance_id: INSTANCE })).unlinked).toBe(true);
    expect(a.state.checkpoint.bindings).toEqual([]);
    expect(bodyOf(await a.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).not.toHaveProperty('persistence');
    expect(bodyOf(await b.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).toMatchObject({ persistence: 'file', fileMatchesStudio: false });
    expect(b.state.checkpoint.bindings[0].projectFile).toBe(bProject.projectFile);
  });

  test('each proxy consumes only its own lazy default attempt, and unlink does not retry it', async () => {
    const primary = await host();
    const aProject = project('DefaultA');
    const bProject = project('DefaultB');
    const a = await proxy(primary, path.relative(process.cwd(), aProject.projectFile));
    const b = await proxy(primary, bProject.projectFile);
    for (const client of [a, b]) {
      expect(bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE)).persistence).toBe('file');
      expect(bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE)).persistence).toBe('file');
      expect(client.state.checkpoint.defaultAttempted).toBe(true);
    }
    expect(runFixture.mock.calls.filter(([args, cwd]) => args[0] === '--version' && cwd === aProject.root)).toHaveLength(1);
    expect(runFixture.mock.calls.filter(([args, cwd]) => args[0] === '--version' && cwd === bProject.root)).toHaveLength(1);
    await a.tools.manageInstance({ action: 'unlink_project', instance_id: INSTANCE });
    expect(bodyOf(await a.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).not.toHaveProperty('persistence');
    expect(a.state.checkpoint.defaultAttempted).toBe(true);
    expect(a.state.checkpoint.bindings).toEqual([]);
    expect(bodyOf(await b.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE)).persistence).toBe('file');
    expect(bodyOf(await primary.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).not.toHaveProperty('persistence');
  });

  test('a failed proxy default is ACKed once and later calls keep the original unlinked behavior', async () => {
    const primary = await host();
    const client = await proxy(primary, path.join(directory, 'missing.project.json'));
    expect(bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE)).errorCode).toBe('rojo_link_invalid');
    expect(client.state.checkpoint.defaultAttempted).toBe(true);
    expect(bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).not.toHaveProperty('error');
    expect(client.state.checkpoint.bindings).toEqual([]);
    expect(runFixture).not.toHaveBeenCalled();
  });

  test('private capability and delegation enforce auth, origin and matching edition before source invocation', async () => {
    const primary = await host();
    expect((await http(primary, '/proxy-rojo', undefined, { auth: false })).status).toBe(401);
    expect((await http(primary, '/proxy-rojo', {}, { auth: false })).status).toBe(401);
    expect((await http(primary, '/proxy-rojo', undefined, { headers: { Origin: 'https://untrusted.invalid' } })).status).toBe(403);
    const capability = await http(primary, '/proxy-rojo');
    expect(capability.status).toBe(200);
    expect(capability.body).toMatchObject({ protocol: 1, epoch: expect.any(String) });
    const wrongEdition = await http(primary, '/proxy-rojo', { ...packet(String(capability.body.epoch)), pluginVariant: 'inspector' });
    expect(wrongEdition.status).toBe(409);
    expect(primary.calls).toHaveLength(0);
    const read = await http(primary, '/proxy-rojo', packet(String(capability.body.epoch)));
    expect(read.body.applied).toBe(true);
    expect(bodyOf(read.body.result).revision).toBe(sourceRevision(primary.studio.source));
    expect(primary.calls.filter((call) => call.endpoint === '/api/get-script-source')).toHaveLength(1);
  });

  test('inspector private reads work but hidden writes, explicit links, defaults and checkpoint replay are refused', async () => {
    const primary = await host('inspector');
    const fixture = project('Inspector');
    const epoch = String((await http(primary, '/proxy-rojo')).body.epoch);
    const readPacket = { ...packet(epoch), pluginVariant: 'inspector' };
    expect((await http(primary, '/proxy-rojo', readPacket)).body.applied).toBe(true);
    const before = primary.calls.length;
    const forbidden = [
      { ...packet(epoch, 'set_script_source', { instancePath: SCRIPT, instance_id: INSTANCE, source: 'bad', expectedRevision: 'old' }), pluginVariant: 'inspector' },
      { ...packet(epoch, 'manage_instance', { action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile }), pluginVariant: 'inspector' },
      { ...packet(epoch), pluginVariant: 'inspector', defaultProject: fixture.projectFile },
      { ...packet(epoch), pluginVariant: 'inspector', state: { version: 0, defaultAttempted: false, bindings: [{ instanceId: INSTANCE, projectFile: fixture.projectFile,
        studioOwner: { physicalSessionId: PHYSICAL, instanceId: INSTANCE } }] } },
    ];
    for (const request of forbidden) expect((await http(primary, '/proxy-rojo', request)).body).toMatchObject({ applied: false, errorCode: 'read_only_inspector' });
    expect(primary.calls).toHaveLength(before);
    expect(runFixture).not.toHaveBeenCalled();
    expect(primary.tools.rojo.hasLinks()).toBe(false);
    expect(fs.readFileSync(fixture.file, 'utf8')).toBe('local x = 1\n');
  });

  test('proxy file commit enters the primary ledger and blocks fresh normal and raw solo/multi starts until current observations match', async () => {
    const primary = await host();
    const fixture = project('Written');
    const writer = await proxy(primary);
    await writer.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile });
    const result = bodyOf(await writer.tools.editScriptLines(SCRIPT, 'x = 1', 'x = 2', undefined, INSTANCE));
    expect(result).toMatchObject({ success: true, saved: { sync: 'pending' } });
    expect(fs.readFileSync(fixture.file, 'utf8')).toBe('local x = 2\n');
    expect(primary.studio.source).toBe('local x = 1\n');
    expect(primary.tools.rojo.hasLinks()).toBe(false); // Delegated bindings are not merged into local ownership.
    expect(primary.calls.filter((call) => call.endpoint === '/api/edit-script-lines' && call.data.planOnly !== true)).toHaveLength(0);
    const fresh = await proxy(primary);
    const capabilities = jest.spyOn(fresh.bridge, 'rojoCapabilities');
    const pendingNormal = [
      bodyOf(await fresh.tools.soloPlaytest('start', 'run', 0.01, INSTANCE)),
      bodyOf(await fresh.tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 0.01, INSTANCE)),
    ];
    const pendingRaw: unknown[] = [];
    for (const endpoint of ['/api/start-playtest', '/api/multiplayer-test-start']) {
      const refusal = await http(primary, '/proxy', { endpoint, targetInstanceId: INSTANCE, targetRole: 'edit', pluginVariant: 'main', data: {} });
      pendingRaw.push(refusal.body.response);
    }
    expect(primary.calls.filter((call) => call.endpoint.endsWith('start-playtest') || call.endpoint.endsWith('multiplayer-test-start'))).toHaveLength(0);
    expect(capabilities).not.toHaveBeenCalled(); // A fresh, unconfigured caller still reaches the primary ledger.
    primary.studio.source = fs.readFileSync(fixture.file, 'utf8');
    expect(bodyOf(await fresh.tools.soloPlaytest('start', 'run', 0.01, INSTANCE)).error).toBe('fixture_peer_received_start');
    expect(bodyOf(await fresh.tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 0.01, INSTANCE)).error).toBe('fixture_peer_received_start');
    for (const endpoint of ['/api/start-playtest', '/api/multiplayer-test-start']) {
      const admitted = await http(primary, '/proxy', { endpoint, targetInstanceId: INSTANCE, targetRole: 'edit', pluginVariant: 'main', data: {} });
      expect(admitted.body.response).toMatchObject({ fixtureDispatch: true, error: 'fixture_peer_received_start' });
    }
    expect(primary.calls.filter((call) => call.endpoint === '/api/start-playtest')).toHaveLength(2);
    expect(primary.calls.filter((call) => call.endpoint === '/api/multiplayer-test-start')).toHaveLength(2);
    for (const refusal of [...pendingNormal, ...pendingRaw]) expect(refusal).toMatchObject({ success: false, errorCode: 'rojo_sync_pending' });
  });

  test('lost unlink ACK is reconciled by status over HTTP without invoking unlink a second time', async () => {
    const primary = await host();
    const fixture = project('LostAck');
    const client = await proxy(primary);
    await client.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile });
    const invoke = jest.spyOn(primary.tools, 'manageInstance');
    const actual = client.bridge.rojoRequest.bind(client.bridge);
    const requests: RojoDelegateRequest[] = [];
    let lost = false;
    jest.spyOn(client.bridge, 'rojoRequest').mockImplementation(async (request) => {
      requests.push(request);
      const reply = await actual(request); // Complete the real HTTP operation first.
      if (!lost && request.kind === 'call' && request.args?.action === 'unlink_project') {
        lost = true;
        throw new Error('Fixture loses an already applied ACK');
      }
      return reply;
    });
    expect(bodyOf(await client.tools.manageInstance({ action: 'unlink_project', instance_id: INSTANCE })).errorCode).toBe('rojo_authority_unknown');
    expect(client.state.uncertain).toBeDefined();
    expect(client.state.checkpoint.bindings).toHaveLength(1);
    expect(bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE))).not.toHaveProperty('persistence');
    expect(requests.filter((request) => request.kind === 'call' && request.args?.action === 'unlink_project')).toHaveLength(1);
    expect(requests.filter((request) => request.kind === 'status')).toHaveLength(1);
    expect(requests.find((request) => request.kind === 'status')?.operationId).toBe(requests[0].operationId);
    expect(invoke.mock.calls.filter(([request]) => request.action === 'unlink_project')).toHaveLength(1);
    expect(client.state.checkpoint.bindings).toEqual([]);
    expect(client.state.uncertain).toBeUndefined();
    expect(client.state.intent).toBe(false);
  });

  test('delegated missing and ambiguous routing errors retain the ordinary transport code and instance choices', async () => {
    const primary = await host();
    const fixture = project('Routing');
    const client = await proxy(primary);
    await client.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile });
    const missing = await http(primary, '/mcp/get_script_source', { instancePath: SCRIPT, instance_id: 'place:999' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: 'unrecognized_instance_id', instances: [{ instance_id: INSTANCE, role: 'edit' }] });
    const delegatedMissing = bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, 'place:999'));

    primary.bridge.registerInstance({ pluginSessionId: 'fixture-second-peer', physicalSessionId: 'fixture-second-peer', instanceId: 'place:84', placeId: 84,
      role: 'edit', placeName: 'Other Fixture', dataModelName: 'Other Fixture', isRunning: false,
      pluginVersion: '3.0.3', serverVersion: '3.0.3', pluginVariant: 'main' });
    // No proxy refresh is required: source targeting must resolve at the primary.
    const ambiguous = await http(primary, '/mcp/get_script_source', { instancePath: SCRIPT });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body).toMatchObject({ error: 'multiple_instances_connected', instances: expect.arrayContaining([
      expect.objectContaining({ instance_id: INSTANCE }), expect.objectContaining({ instance_id: 'place:84' }),
    ]) });
    const delegatedAmbiguous = bodyOf(await client.tools.getScriptSource(SCRIPT));
    expect(delegatedMissing).toEqual(missing.body);
    expect(delegatedAmbiguous).toEqual(ambiguous.body);
  });

  test('generic handler failures preserve the bounded ordinary 500 body without logging private context', async () => {
    const primary = await host();
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = jest.spyOn(primary.tools, 'getScriptSource').mockRejectedValue(new Error('x'.repeat(700)));
    const ordinary = await http(primary, '/mcp/get_script_source', { instancePath: SCRIPT, instance_id: INSTANCE });
    expect(ordinary.status).toBe(500);
    expect(ordinary.body).toEqual({ error: 'tool_failed', message: 'x'.repeat(500) });
    errorLog.mockClear();
    const epoch = String((await http(primary, '/proxy-rojo')).body.epoch);
    const privateMarker = 'FIXTURE_PRIVATE_ENV_VALUE_DO_NOT_LOG';
    const delegated = await http(primary, '/proxy-rojo', { ...packet(epoch), environment: { PATH: privateMarker } });
    expect(delegated.status).toBe(200);
    expect(delegated.body.applied).toBe(true); // Handler failure still ACKs the consumed scope state.
    expect(bodyOf(delegated.body.result)).toEqual(ordinary.body);
    expect(JSON.stringify(delegated.body)).not.toContain(privateMarker);
    expect(errorLog).not.toHaveBeenCalled();
    const invalid = await http(primary, '/proxy-rojo', { ...packet(epoch), environment: { OPENAI_API_KEY: privateMarker } });
    expect(invalid.body).toMatchObject({ applied: false, errorCode: 'rojo_context_invalid' });
    expect(JSON.stringify(invalid.body)).not.toContain(privateMarker);
    expect(errorLog).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test.each(['explicit', 'default'] as const)('a %s-linked HTTP call cancelled before plan reply never dispatches the Studio-only mutation', async (mode) => {
    const primary = await host();
    const fixture = project(`Cancelled-${mode}`);
    const client = await proxy(primary, mode === 'default' ? fixture.projectFile : undefined);
    if (mode === 'default') await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE);
    else await client.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile });
    expect(client.state.checkpoint.bindings).toHaveLength(1);
    let releasePlan: (() => void) | undefined;
    let sawPlan!: () => void;
    const planClaimed = new Promise<void>((resolve) => { sawPlan = resolve; });
    primary.peer.deferPlan = (requestId, response) => {
      releasePlan = () => { primary.bridge.resolveRequest(requestId, response); };
      sawPlan();
      return true;
    };
    let sawServerCancellation!: () => void;
    const serverCancelled = new Promise<void>((resolve) => { sawServerCancellation = resolve; });
    const onRequest = (request: import('http').IncomingMessage, response: import('http').ServerResponse) => {
      if (request.method === 'POST' && request.url === '/proxy-rojo') response.once('close', sawServerCancellation);
    };
    primary.server.on('request', onRequest);
    const controller = new AbortController();
    const operation = { ...packet(client.state.epoch!, 'edit_script_lines', {
      instancePath: STUDIO_ONLY_SCRIPT, instance_id: INSTANCE, old_string: 'other = 1', new_string: 'other = 2',
    }), clientId: client.state.clientId, defaultProject: client.state.defaultProject, state: client.state.checkpoint };
    try {
      const pending = fetch(`${primary.base}/proxy-rojo`, {
        method: 'POST', headers: { 'X-MCP-Auth': AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(operation), signal: controller.signal,
      }).catch((error: unknown) => error);
      await planClaimed;
      controller.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      await serverCancelled; // Server-side signal is aborted before the held reply is delivered.
      releasePlan!();
      const completed = await http(primary, '/proxy-rojo', { ...operation, kind: 'status' });
      expect(completed.body.applied).toBe(true);
      expect(completed.body.result).toMatchObject({ isError: true });
      const edits = primary.calls.filter((call) => call.endpoint === '/api/edit-script-lines');
      expect(edits).toHaveLength(1);
      expect(edits[0].data).toMatchObject({ instancePath: STUDIO_ONLY_SCRIPT, planOnly: true });
      expect(primary.studio.otherSource).toBe('local other = 1\n');
      expect(fs.readFileSync(fixture.file, 'utf8')).toBe('local x = 1\n');
    } finally {
      controller.abort();
      releasePlan?.();
      primary.peer.deferPlan = undefined;
      primary.server.off('request', onRequest);
    }
  });

  test('actual tracked Tools callbacks retire only both-gone plus fresh unmapped ownership, then start reaches the peer', async () => {
    const primary = await host();
    const fixture = project('Retired');
    const writer = await proxy(primary);
    await writer.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile });
    // The peer fixture reads newly saved disk bytes as already propagated Studio
    // source, so the real write pipeline records a synced commit immediately.
    primary.studio.syncFile = fixture.file;
    expect(bodyOf(await writer.tools.editScriptLines(SCRIPT, 'x = 1', 'x = 2', undefined, INSTANCE))).toMatchObject({ success: true, saved: { sync: 'synced' } });
    expect(fs.readFileSync(fixture.file, 'utf8')).toBe('local x = 2\n');
    primary.studio.source = 'local x = 2\n';
    primary.studio.syncFile = undefined;
    fs.unlinkSync(fixture.file);
    const rawStart = async (endpoint: string) => (await http(primary, '/proxy', {
      endpoint, targetInstanceId: INSTANCE, targetRole: 'edit', pluginVariant: 'main', data: {},
    })).body.response;
    expect(await rawStart('/api/start-playtest')).toMatchObject({ success: false, errorCode: 'rojo_sync_unknown' }); // Disk alone disappeared.
    primary.studio.mainMissing = true;
    expect(await rawStart('/api/start-playtest')).toMatchObject({ success: false, errorCode: 'rojo_sync_unknown' }); // Old map still claims the absent file.
    const oldRefReads = primary.calls.filter((call) => call.endpoint === '/api/get-script-source' && call.data.instanceRef === 'ref:fixture-main').length;
    const oldPathReads = primary.calls.filter((call) => call.endpoint === '/api/get-script-source' && call.data.instanceRef === undefined).length;
    fixtureMaps.set(fixture.root, { name: 'Retired', className: 'DataModel', children: [] });
    expect(await rawStart('/api/start-playtest')).toMatchObject({ fixtureDispatch: true, error: 'fixture_peer_received_start' });
    expect(primary.calls.filter((call) => call.endpoint === '/api/get-script-source' && call.data.instanceRef === 'ref:fixture-main')).toHaveLength(oldRefReads + 1);
    expect(primary.calls.filter((call) => call.endpoint === '/api/get-script-source' && call.data.instanceRef === undefined)).toHaveLength(oldPathReads + 1);
    const checkedReads = primary.calls.filter((call) => call.endpoint === '/api/get-script-source').length;
    const checkedCli = runFixture.mock.calls.length;
    expect(await rawStart('/api/multiplayer-test-start')).toMatchObject({ fixtureDispatch: true });
    expect(primary.calls.filter((call) => call.endpoint === '/api/get-script-source')).toHaveLength(checkedReads); // The confirmed old record was actually retired.
    expect(runFixture).toHaveBeenCalledTimes(checkedCli);
  });

  test.each(['same-physical', 'replaced-physical'] as const)('confirmed binding cache replay checks the %s Studio owner', async (mode) => {
    const primary = await host();
    const fixture = project(`Replay-${mode}`);
    const client = await proxy(primary);
    const linked = bodyOf(await client.tools.manageInstance({ action: 'link_project', instance_id: INSTANCE, project: fixture.projectFile }));
    expect(linked).toMatchObject({ linked: true, instance_id: INSTANCE });
    expect(client.state.checkpoint.bindings[0]).toMatchObject({ studioOwner: { physicalSessionId: PHYSICAL, instanceId: INSTANCE } });
    await client.tools.releaseRojoClient(); // Release server cache; keep this live client's confirmed checkpoint.
    const before = primary.calls.length;
    if (mode === 'replaced-physical') {
      primary.bridge.unregisterInstance(PHYSICAL);
      primary.bridge.registerInstance({ pluginSessionId: 'replacement-peer', physicalSessionId: 'replacement-peer', instanceId: INSTANCE, placeId: 42,
        role: 'edit', placeName: 'Reappearing Fixture Id', dataModelName: 'Reappearing Fixture Id', isRunning: false,
        pluginVersion: '3.0.3', serverVersion: '3.0.3', pluginVariant: 'main' });
    }
    const read = bodyOf(await client.tools.getScriptSource(SCRIPT, undefined, undefined, INSTANCE));
    if (mode === 'same-physical') {
      expect(read).toMatchObject({ persistence: 'file', fileMatchesStudio: true, fileRevision: sourceRevision('local x = 1\n') });
      expect(client.state.checkpoint.bindings[0]).toMatchObject({ projectFile: fixture.projectFile, studioOwner: { physicalSessionId: PHYSICAL, instanceId: INSTANCE } });
      expect(primary.calls).toHaveLength(before + 1);
    } else {
      expect(read).toMatchObject({ errorCode: 'rojo_binding_owner_unknown' });
      expect(primary.calls).toHaveLength(before); // No read or mutation was sent to the unrelated physical session.
      expect(client.state.uncertain).toBeDefined();
    }
    expect(fs.readFileSync(fixture.file, 'utf8')).toBe('local x = 1\n');
  });
});
