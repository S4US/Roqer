import { BridgeService } from '../bridge-service.js';
import { OpenCloudClient } from '../opencloud-client.js';
import { RobloxStudioTools } from '../tools/index.js';

function textBody(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (!text) throw new Error('Expected a text tool result');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('Open Cloud upload operations', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reads a durable operation by either its ID or returned path', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      path: 'operations/upload-123',
      done: false,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new OpenCloudClient({ apiKey: 'test-key', baseUrl: 'https://apis.roblox.test' });

    await expect(client.getAssetOperation('upload-123')).resolves.toMatchObject({ done: false });
    await expect(client.getAssetOperation('operations/upload-123')).resolves.toMatchObject({ done: false });

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'https://apis.roblox.test/assets/v1/operations/upload-123',
      'https://apis.roblox.test/assets/v1/operations/upload-123',
    ]);
  });

  test('rejects an operation path that could escape the endpoint', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const client = new OpenCloudClient({ apiKey: 'test-key', baseUrl: 'https://apis.roblox.test' });

    await expect(client.getAssetOperation('../assets/123')).rejects.toThrow('operation ID is not valid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns the latest pending operation when the bounded initial poll ends', async () => {
    const client = new OpenCloudClient({ apiKey: 'test-key', baseUrl: 'https://apis.roblox.test' });
    jest.spyOn(client, 'getAssetOperation').mockResolvedValue({
      path: 'operations/still-processing',
      done: false,
    });

    const result = await (client as unknown as {
      pollOperation(path: string, attempts: number, intervalMs: number): Promise<unknown>;
    }).pollOperation('operations/still-processing', 1, 0);

    expect(result).toEqual({ path: 'operations/still-processing', done: false });
  });

  test('status checks return normalized operation and moderation fields', async () => {
    const tools = new RobloxStudioTools(new BridgeService()) as unknown as {
      openCloudClient: {
        hasApiKey(): boolean;
        getAssetOperation(operationId: string): Promise<unknown>;
      };
      uploadAsset(
        filePath?: string,
        assetType?: string,
        displayName?: string,
        description?: string,
        userId?: string,
        groupId?: string,
        action?: string,
        operationId?: string,
      ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    tools.openCloudClient = {
      hasApiKey: () => true,
      getAssetOperation: jest.fn(async () => ({
        path: 'operations/upload-456',
        done: true,
        response: {
          assetId: '987654321',
          displayName: 'Village kit',
          assetType: 'Model',
          moderationResult: { moderationState: 'Approved' },
        },
      })),
    };

    const result = await tools.uploadAsset(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'status',
      'upload-456',
    );

    expect(textBody(result)).toMatchObject({
      operation_id: 'upload-456',
      status: 'complete',
      asset_id: '987654321',
      moderation_state: 'Approved',
      done: true,
    });
    expect(tools.openCloudClient.getAssetOperation).toHaveBeenCalledWith('upload-456');
  });

  test('status checks preserve a failed operation without starting another upload', async () => {
    const tools = new RobloxStudioTools(new BridgeService()) as unknown as {
      openCloudClient: {
        hasApiKey(): boolean;
        getAssetOperation(operationId: string): Promise<unknown>;
      };
      uploadAsset(
        filePath?: string,
        assetType?: string,
        displayName?: string,
        description?: string,
        userId?: string,
        groupId?: string,
        action?: string,
        operationId?: string,
      ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    tools.openCloudClient = {
      hasApiKey: () => true,
      getAssetOperation: jest.fn(async () => ({
        path: 'operations/upload-failed',
        done: true,
        error: { code: 7, message: 'Asset moderation rejected the upload' },
      })),
    };

    const result = await tools.uploadAsset(
      undefined, undefined, undefined, undefined, undefined, undefined,
      'status', 'upload-failed',
    );

    expect(textBody(result)).toEqual({
      path: 'operations/upload-failed',
      done: true,
      error: { code: 7, message: 'Asset moderation rejected the upload' },
      operation_id: 'upload-failed',
      status: 'failed',
    });
    expect(result.isError).toBe(true);
    expect(tools.openCloudClient.getAssetOperation).toHaveBeenCalledTimes(1);
  });

  type DecalTools = {
    openCloudClient: {
      hasApiKey(): boolean;
      getAssetOperation(operationId: string): Promise<unknown>;
    };
    _callSingle(endpoint: string, data: unknown, target: string | undefined, instance_id?: string): Promise<unknown>;
    uploadAsset(
      filePath?: string,
      assetType?: string,
      displayName?: string,
      description?: string,
      userId?: string,
      groupId?: string,
      action?: string,
      operationId?: string,
      instance_id?: string,
    ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  };

  test('a finished Decal status check resolves its image ID through the addressed place', async () => {
    const tools = new RobloxStudioTools(new BridgeService()) as unknown as DecalTools;
    tools.openCloudClient = {
      hasApiKey: () => true,
      getAssetOperation: jest.fn(async () => ({
        path: 'operations/icon-1',
        done: true,
        response: {
          assetId: '111',
          displayName: 'Barrel icon',
          assetType: 'Decal',
          moderationResult: { moderationState: 'Approved' },
        },
      })),
    };
    const callSingle = jest.fn(async () => ({ returnValue: '222' }));
    tools._callSingle = callSingle;

    const result = await tools.uploadAsset(
      undefined, undefined, undefined, undefined, undefined, undefined,
      'status', 'icon-1', 'place:2',
    );

    expect(textBody(result)).toMatchObject({ status: 'complete', asset_id: '111', decalId: '111', imageId: '222' });
    expect(callSingle).toHaveBeenCalledWith('/api/execute-luau', expect.objectContaining({ code: expect.stringContaining('LoadAsset(111)') }), 'edit', 'place:2');
  });

  test('a status check for a Model does not touch Studio', async () => {
    const tools = new RobloxStudioTools(new BridgeService()) as unknown as DecalTools;
    tools.openCloudClient = {
      hasApiKey: () => true,
      getAssetOperation: jest.fn(async () => ({
        path: 'operations/model-1',
        done: true,
        response: { assetId: '333', displayName: 'Barrel', assetType: 'Model' },
      })),
    };
    const callSingle = jest.fn(async () => ({ returnValue: '444' }));
    tools._callSingle = callSingle;

    const result = await tools.uploadAsset(
      undefined, undefined, undefined, undefined, undefined, undefined,
      'status', 'model-1', 'place:2',
    );

    expect(textBody(result)).not.toHaveProperty('imageId');
    expect(callSingle).not.toHaveBeenCalled();
  });
});
