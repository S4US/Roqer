import { diagnoseRuntimePeers } from '../runtime-peer-diagnosis.js';

const URL = 'http://127.0.0.1:58741';

function reportWith(report: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  return { success: true, playStartRequested: true, playtestRunning: true, report, ...extra };
}

describe('diagnoseRuntimePeers', () => {
  test('names the error the play server could not register with', () => {
    const detail = `RequestAsync threw for ${URL}/ready: HttpError: ConnectFail`;
    const result = diagnoseRuntimePeers(
      reportWith({ stage: 'retrying', at: 10, url: URL, detail }),
      ['edit'],
      ['server', 'client-1'],
      60,
    );
    expect(result).toEqual({
      diagnosis: `The MCP plugin in the play server could not register with the bridge at ${URL}: ${detail}`,
      runtimePeer: { stage: 'retrying', playtestRunning: true, url: URL, detail },
    });
  });

  test('says when the plugin had not reported from a running play server, and for how long that was', () => {
    const result = diagnoseRuntimePeers(reportWith(undefined), ['edit'], ['server', 'client-1'], 60);
    expect(result.runtimePeer).toEqual({ stage: 'none', playtestRunning: true });
    expect(result.diagnosis).toBe(
      'Studio is running the playtest, but after 60 s the MCP plugin had not reported from the play server: it had not started there.',
    );
    // A short wait is only evidence for that long.
    expect(diagnoseRuntimePeers(reportWith(undefined), ['edit'], ['server'], 0.25).diagnosis).toContain('after 0.3 s');
  });

  test('says when Studio is not running the playtest at all', () => {
    const result = diagnoseRuntimePeers(reportWith(undefined, { playtestRunning: false }), ['edit'], ['server'], 60);
    expect(result.diagnosis).toBe('Studio is not running the playtest, and the MCP plugin never reported from its play server.');
  });

  test('puts the error Studio ended the playtest with first', () => {
    const result = diagnoseRuntimePeers(
      reportWith({ stage: 'loaded', at: 10 }, { playtestRunning: false, playModeError: 'a previous one is still in progress' }),
      ['edit'],
      ['server'],
      60,
    );
    expect(result.diagnosis).toBe('Studio ended the playtest with an error: a previous one is still in progress');
    expect(result.runtimePeer).toMatchObject({ stage: 'loaded', playModeError: 'a previous one is still in progress' });
  });

  test('tells a hung connection from one that was never tried', () => {
    expect(diagnoseRuntimePeers(reportWith({ stage: 'connecting', at: 10, url: URL }), ['edit'], ['server'], 60).diagnosis)
      .toBe(`The MCP plugin in the play server is still waiting for the bridge at ${URL} to answer.`);
    expect(diagnoseRuntimePeers(reportWith({ stage: 'loaded', at: 10 }), ['edit'], ['server'], 60).diagnosis)
      .toBe('The MCP plugin started in the play server but had not tried to reach the bridge after 60 s.');
    expect(diagnoseRuntimePeers(reportWith({ stage: 'failed', at: 10, detail: 'boom' }), ['edit'], ['server'], 60).diagnosis)
      .toBe('The MCP plugin in the play server could not start its connection: boom');
  });

  test('names the client that did not register after the server did', () => {
    const result = diagnoseRuntimePeers(
      reportWith({ stage: 'registered', at: 10, url: URL, role: 'server' }),
      ['edit', 'server'],
      ['server', 'client-1'],
      60,
    );
    expect(result.diagnosis).toBe(
      'The play server registered, but client-1 did not: the play server\'s plugin registers each player that joins.',
    );
  });

  test('adds that the playtest ended when the report outlived it', () => {
    const result = diagnoseRuntimePeers(
      reportWith({ stage: 'registered', at: 10, role: 'server' }, { playtestRunning: false }),
      ['edit'],
      ['server'],
      60,
    );
    expect(result.diagnosis).toBe(
      'The MCP plugin in the play server registered as server, but the bridge no longer lists it. Studio is no longer running the playtest.',
    );
  });

  test('reports an edit plugin that could not be asked, or has no start on record', () => {
    expect(diagnoseRuntimePeers({ error: 'Studio plugin connection timeout.' }, ['edit'], ['server'], 60)).toEqual({
      diagnosis: 'The edit plugin could not say what the play server\'s plugin did: Studio plugin connection timeout.',
      runtimePeer: { stage: 'unavailable' },
    });
    expect(diagnoseRuntimePeers({ success: true, playStartRequested: false }, ['edit'], ['server'], 60).runtimePeer)
      .toEqual({ stage: 'unavailable' });
    expect(diagnoseRuntimePeers(undefined, ['edit'], ['server'], 60).runtimePeer).toEqual({ stage: 'unavailable' });
  });

  test('ignores a malformed report and bounds long text', () => {
    expect(diagnoseRuntimePeers(reportWith({ stage: 'exploded', at: 10 }), ['edit'], ['server'], 60).runtimePeer.stage)
      .toBe('none');
    const long = 'x'.repeat(2000);
    const result = diagnoseRuntimePeers(reportWith({ stage: 'retrying', at: 10, detail: long }), ['edit'], ['server'], 60);
    expect(result.runtimePeer.detail).toBe(`${'x'.repeat(400)}...`);
  });
});
