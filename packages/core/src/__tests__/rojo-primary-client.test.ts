import { randomUUID } from 'crypto';
import { RojoPrimaryClient, RojoProxyState, type RojoDelegateTransport } from '../rojo/primary-client.js';
import type { RojoDelegateRequest, RojoDelegateReply } from '../rojo/primary-service.js';

describe('source authority acknowledgments (simulated primary transport)', () => {
  const epoch = randomUUID();
  const result = (body: object) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
  const errorCode = (value: { content: Array<{ text: string }> } | undefined) => JSON.parse(value!.content[0].text).errorCode;

  test('plain clients keep synchronous source/start bypass without probing capabilities', () => {
    const transport = { rojoCapabilities: jest.fn(), rojoRequest: jest.fn() };
    const client = new RojoPrimaryClient(transport, new RojoProxyState());
    expect(client.invoke('get_script_source', {})).toBeUndefined();
    expect(client.prepareStart('/api/start-playtest')).toBeUndefined();
    expect(transport.rojoCapabilities).not.toHaveBeenCalled();
    expect(transport.rojoRequest).not.toHaveBeenCalled();
  });

  test.each(['default', 'explicit'])('a %s Rojo intent refuses an old primary without running a handler', async kind => {
    const transport = { rojoCapabilities: jest.fn(async () => undefined), rojoRequest: jest.fn() };
    const client = new RojoPrimaryClient(transport, new RojoProxyState(kind === 'default' ? 'default.project.json' : undefined));
    const reply = await client.invoke(kind === 'default' ? 'set_script_source' : 'manage_instance', kind === 'default'
      ? { instancePath: 'game.Main', source: 'new' } : { action: 'link_project', project: 'default.project.json' });
    expect(errorCode(reply)).toBe('rojo_primary_outdated');
    expect(transport.rojoRequest).not.toHaveBeenCalled();
  });

  test('lost unlink ACK is reconciled once and restores the plain-client path', async () => {
    const state = new RojoProxyState();
    state.intent = true;
    state.checkpoint = { version: 1, defaultAttempted: false, bindings: [{ instanceId: 'place:42', projectFile: '/project/default.project.json' }] };
    let unlink: RojoDelegateRequest | undefined;
    const requests: RojoDelegateRequest[] = [];
    const transport: RojoDelegateTransport = {
      rojoCapabilities: async () => ({ protocol: 1, epoch }),
      rojoRequest: async packet => {
        requests.push(packet);
        if (packet.kind === 'call' && packet.args?.action === 'unlink_project') {
          unlink = packet; throw new Error('Response lost after applying unlink');
        }
        if (packet.kind === 'status') {
          expect(packet.operationId).toBe(unlink!.operationId);
          return { protocol: 1, epoch, applied: true, state: { version: 2, defaultAttempted: false, bindings: [] }, result: result({ unlinked: true }) };
        }
        return { protocol: 1, epoch, applied: true, state: { version: 3, defaultAttempted: false, bindings: [] }, result: result({ source: 'Studio only' }) };
      },
    };
    const client = new RojoPrimaryClient(transport, state);
    expect(errorCode(await client.invoke('manage_instance', { action: 'unlink_project' }))).toBe('rojo_authority_unknown');
    expect(state.uncertain).toBeDefined();
    await client.invoke('get_script_source', { instancePath: 'game.Main' });
    expect(requests.filter(r => r.args?.action === 'unlink_project' && r.kind === 'call')).toHaveLength(1);
    expect(state.checkpoint.bindings).toEqual([]);
    expect(state.intent).toBe(false);
    expect(state.uncertain).toBeUndefined();
    expect(client.invoke('get_script_source', {})).toBeUndefined();
    expect(client.prepareStart('/api/start-playtest')).toBeUndefined();
  });

  test('an unknown operation on a new epoch is not replayed', async () => {
    const state = new RojoProxyState('default.project.json');
    const transport = { rojoCapabilities: jest.fn(async () => ({ protocol: 1, epoch })), rojoRequest: jest.fn(async () => { throw new Error('Disconnected'); }) };
    const client = new RojoPrimaryClient(transport, state);
    await client.invoke('get_script_source', {});
    const pending = state.uncertain;
    transport.rojoCapabilities.mockResolvedValue({ protocol: 1, epoch: randomUUID() });
    expect(errorCode(await client.invoke('set_script_source', {}))).toBe('rojo_authority_unknown');
    expect(transport.rojoRequest).toHaveBeenCalledTimes(1);
    expect(state.uncertain).toBe(pending);
  });

  test('older replies cannot overwrite a confirmed checkpoint', async () => {
    const state = new RojoProxyState('default.project.json');
    state.checkpoint.version = 2;
    const transport = { rojoCapabilities: async () => ({ protocol: 1, epoch }), rojoRequest: async (): Promise<RojoDelegateReply> => ({
      protocol: 1, epoch, applied: true, state: { version: 1, defaultAttempted: false, bindings: [] }, result: result({ source: 'old' }),
    }) };
    const client = new RojoPrimaryClient(transport, state);
    expect(errorCode(await client.invoke('get_script_source', {}))).toBe('rojo_authority_unknown');
    expect(state.checkpoint.version).toBe(2);
    expect(state.uncertain).toBeDefined();
  });

  test('non-source lifecycle calls never use the private source protocol', () => {
    const transport = { rojoCapabilities: jest.fn(), rojoRequest: jest.fn() };
    const client = new RojoPrimaryClient(transport, new RojoProxyState('default.project.json'));
    for (const action of ['launch', 'authorize', 'complete', 'close', 'status']) expect(client.invoke('manage_instance', { action })).toBeUndefined();
    expect(client.invoke('list_place_versions', {})).toBeUndefined();
    expect(transport.rojoCapabilities).not.toHaveBeenCalled();
  });
});
