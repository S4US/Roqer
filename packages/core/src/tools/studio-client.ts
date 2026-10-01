import { BridgeService, REQUEST_TIMEOUT, REQUEST_TIMEOUT_AFTER_DELIVERY } from '../bridge-service.js';

export class StudioHttpClient {
  private bridge: BridgeService;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
  }

  async request(
    endpoint: string,
    data: any,
    targetInstanceId: string,
    targetRole: string,
    timeoutMs?: number,
  ): Promise<any> {
    try {
      const response = await this.bridge.sendRequest(endpoint, data, targetInstanceId, targetRole, timeoutMs);
      // A plugin built before this server added an endpoint has no handler
      // for it, and says only "Unknown endpoint". Said plainly, so neither the
      // agent nor the user takes it for a fault in the place and works round it.
      if (response?.error === `Unknown endpoint: ${endpoint}`) {
        return {
          error: `The Studio plugin is older than this MCP server: it has no ${endpoint}, so nothing was done. `
            + 'Reinstall the plugin from this server\'s build, restart Studio, and try again.',
          errorCode: 'plugin_outdated',
        };
      }
      return response;
    } catch (error) {
      // Checked by content rather than equality: a proxy-mode server receives
      // the primary's error wrapped in its own proxy failure text.
      const message = error instanceof Error ? error.message : '';
      if (message.includes(REQUEST_TIMEOUT_AFTER_DELIVERY)) {
        throw new Error(
          `Studio received ${endpoint} but did not answer in time, so it may already have been applied. `
          + 'Read the target back before repeating a change.'
        );
      }
      if (message.includes(REQUEST_TIMEOUT)) {
        throw new Error(
          'Studio plugin connection timeout. Make sure the Roblox Studio plugin is running and activated.'
        );
      }
      throw error;
    }
  }
}
