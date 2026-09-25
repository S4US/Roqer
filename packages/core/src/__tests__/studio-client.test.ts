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
