import { BridgeService, REQUEST_TIMEOUT, REQUEST_TIMEOUT_AFTER_DELIVERY } from '../bridge-service.js';
import { StudioHttpClient } from '../tools/studio-client.js';

function failingBridge(message: string): BridgeService {
  const bridge = new BridgeService();
  bridge.sendRequest = async () => {
    throw new Error(message);
  };
  return bridge;
}

describe('Studio client timeouts', () => {
  test('a request nobody took says the plugin is not answering', async () => {
    const client = new StudioHttpClient(failingBridge(REQUEST_TIMEOUT));
    await expect(client.request('/api/delete-script-lines', {}, 'place:1', 'edit'))
      .rejects.toThrow(/plugin connection timeout/);
  });

  test('a request Studio took says the change may have landed', async () => {
    const client = new StudioHttpClient(failingBridge(REQUEST_TIMEOUT_AFTER_DELIVERY));
    const failure = client.request('/api/delete-script-lines', {}, 'place:1', 'edit');
    await expect(failure).rejects.toThrow(/received \/api\/delete-script-lines but did not answer in time/);
    await expect(failure).rejects.toThrow(/Read the target back before repeating/);
  });

  test('the same holds when a proxy-mode server wraps the primary\'s error', async () => {
    const wrapped = `Proxy request failed (500): {"error":"${REQUEST_TIMEOUT_AFTER_DELIVERY}"}`;
    const client = new StudioHttpClient(failingBridge(wrapped));
    await expect(client.request('/api/insert-script-lines', {}, 'place:1', 'edit'))
      .rejects.toThrow(/may already have been applied/);
  });
});

describe('an older plugin', () => {
  function answering(response: unknown): BridgeService {
    const bridge = new BridgeService();
    bridge.sendRequest = async () => response;
    return bridge;
  }

  test('an endpoint the plugin has no handler for says the plugin is older than the server', async () => {
    const client = new StudioHttpClient(answering({ error: 'Unknown endpoint: /api/animation-rig' }));
    await expect(client.request('/api/animation-rig', {}, 'place:1', 'edit')).resolves.toEqual({
      error: 'The Studio plugin is older than this MCP server: it has no /api/animation-rig, so nothing was done. '
        + 'Reinstall the plugin from this server\'s build, restart Studio, and try again.',
      errorCode: 'plugin_outdated',
    });
  });

  test('any other answer, an error included, comes back as the plugin gave it', async () => {
    const refusal = { error: 'game.Workspace.Guard already exists.', errorCode: 'target_exists' };
    await expect(new StudioHttpClient(answering(refusal)).request('/api/animation-rig', {}, 'place:1', 'edit')).resolves.toEqual(refusal);
    // Another endpoint's name in the message is not this request's.
    const other = { error: 'Unknown endpoint: /api/other' };
    await expect(new StudioHttpClient(answering(other)).request('/api/animation-rig', {}, 'place:1', 'edit')).resolves.toEqual(other);
    await expect(new StudioHttpClient(answering(undefined)).request('/api/animation-rig', {}, 'place:1', 'edit')).resolves.toBeUndefined();
  });
});
