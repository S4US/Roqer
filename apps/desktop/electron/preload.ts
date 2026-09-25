import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  isProviderLoginResult,
  isProviderModelCatalog,
  isProviderStatus,
  providerLabel,
  type ProviderId,
  type ProviderLoginResult,
  type ProviderModelCatalog,
  type ProviderStatus,
} from "../shared/provider";
import { isAppUpdateState, type AppUpdateState } from "../shared/app-update";
import { isMcpServerState, type McpServerState } from "../shared/mcp-server";
import { isRunEvent, type RunEvent, type RunStartRequest } from "../shared/run-events";
import {
  isStudioActionResult,
  type OpenStudioScriptRequest,
  type StudioActionResult,
} from "../shared/studio-status";
import { isStorageStatus, type StorageStatus } from "../shared/workspace-storage";
import {
  isCustomConnectionsResult,
  isCustomModelImportResult,
  isCustomModelTestResult,
  type CustomConnectionSave,
  type CustomConnectionsResult,
  type CustomModelImportResult,
  type CustomModelTestResult,
} from "../shared/custom-providers";
import {
  isOpenCloudCheckResult,
  isOpenCloudSettingsResult,
  type OpenCloudCheckResult,
  type OpenCloudSave,
  type OpenCloudSettingsResult,
} from "../shared/open-cloud";
import { isBlenderSettingsResult, type BlenderSettingsResult } from "../shared/blender";

/**
 * The renderer's only route to the desktop runtime.
 *
 * Two rules shape this file. The renderer never receives the raw
 * `IpcRendererEvent` (it carries `sender`, which is a way back into the main
 * process), and it never receives MCP credentials — the auth token is resolved
 * in the main process and never crosses this boundary.
 */

export type RunStartResult =
  | { ok: true; runId: string }
  | { ok: false; message: string };

const runs = {
  start: (request: RunStartRequest): Promise<RunStartResult> =>
    ipcRenderer.invoke("run:start", request),
  respond: (runId: string, callId: string, decision: "approved" | "rejected"): Promise<boolean> =>
    ipcRenderer.invoke("run:respond", { runId, callId, decision }),
  /**
   * Answer a question by index into the options the model offered. An index
   * rather than text, so nothing the renderer composes reaches the provider.
   */
  answer: (runId: string, callId: string, answerIndex: number): Promise<boolean> =>
    ipcRenderer.invoke("run:answer", { runId, callId, answerIndex }),
  /**
   * Add a note for the model's next turn. Text, deliberately: this is the user
   * speaking mid-run, with the same standing as the prompt that started it,
   * and it reaches the model labelled as the user's words. Resolves false when
   * the run has already ended, so the renderer can send the same words as a
   * new prompt instead.
   */
  steer: (runId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke("run:steer", { runId, text }),
  cancel: (runId: string, discard = false): Promise<void> =>
    ipcRenderer.invoke("run:cancel", { runId, discard }),
  cancelStart: (startId: string): Promise<void> => ipcRenderer.invoke("run:cancel-start", startId),
  /**
   * Subscribe to the run event stream. Returns an unsubscribe function.
   * Events that fail validation are dropped rather than delivered, so a
   * malformed payload can never reach the reducer.
   */
  subscribe: (listener: (event: RunEvent) => void): (() => void) => {
    const forward = (_event: IpcRendererEvent, payload: unknown) => {
      if (isRunEvent(payload)) listener(payload);
    };
    ipcRenderer.on("run:event", forward);
    return () => {
      ipcRenderer.off("run:event", forward);
    };
  },
};

/**
 * One connector per managed sign-in. The provider id is bound here rather than
 * passed by the renderer's callers, so a page cannot ask for a provider that
 * the bridge does not expose.
 */
function connector(provider: ProviderId) {
  const label = providerLabel(provider);
  return {
    status: async (): Promise<ProviderStatus> => {
      const value: unknown = await ipcRenderer.invoke("provider:status", provider);
      return isProviderStatus(value)
        ? value
        : { kind: "unavailable", message: `The ${label} provider returned an invalid status.` };
    },
    login: async (): Promise<ProviderLoginResult> => {
      const value: unknown = await ipcRenderer.invoke("provider:login", provider);
      return isProviderLoginResult(value)
        ? value
        : { ok: false, message: `The ${label} sign-in request returned an invalid result.` };
    },
    /** Finish a sign-in that returned `awaitingCode`. */
    submitCode: async (code: string): Promise<ProviderLoginResult> => {
      const value: unknown = await ipcRenderer.invoke("provider:login-code", { provider, code });
      return isProviderLoginResult(value)
        ? value
        : { ok: false, message: `The ${label} sign-in request returned an invalid result.` };
    },
    models: async (): Promise<ProviderModelCatalog> => {
      const value: unknown = await ipcRenderer.invoke("provider:models", provider);
      return isProviderModelCatalog(value)
        ? value
        : { models: [], defaultModelId: null, message: `The ${label} provider returned an invalid model catalog.` };
    },
  };
}

async function connectionsRequest(channel: string, ...args: unknown[]): Promise<CustomConnectionsResult> {
  const value: unknown = await ipcRenderer.invoke(channel, ...args);
  return isCustomConnectionsResult(value)
    ? value
    : { ok: false, message: "Roqer returned invalid model connections." };
}

async function openCloudRequest(channel: string, ...args: unknown[]): Promise<OpenCloudSettingsResult> {
  const value: unknown = await ipcRenderer.invoke(channel, ...args);
  return isOpenCloudSettingsResult(value) ? value : { ok: false, message: "Roqer returned invalid Open Cloud settings." };
}

/**
 * The user's Roblox Open Cloud key and creator. As with model connections, the
 * key goes in with `save` and never comes back out.
 */
const openCloud = {
  get: () => openCloudRequest("open-cloud:get"),
  save: (save: OpenCloudSave) => openCloudRequest("open-cloud:save", save),
  check: async (): Promise<OpenCloudCheckResult> => {
    const value: unknown = await ipcRenderer.invoke("open-cloud:check");
    return isOpenCloudCheckResult(value) ? value : { ok: false, message: "The key check returned an invalid result." };
  },
};

async function blenderRequest(channel: string, ...args: unknown[]): Promise<BlenderSettingsResult> {
  const value: unknown = await ipcRenderer.invoke(channel, ...args);
  return isBlenderSettingsResult(value) ? value : { ok: false, message: "Roqer returned an invalid Blender setting." };
}

/**
 * The local Blender worker. The renderer can switch it on or off and ask the
 * main process to look for Blender or open its own file dialog; it can never
 * name the executable itself.
 */
const blender = {
  get: () => blenderRequest("blender:get"),
  setEnabled: (enabled: boolean) => blenderRequest("blender:set-enabled", enabled),
  choose: () => blenderRequest("blender:choose"),
  redetect: () => blenderRequest("blender:redetect"),
};

/**
 * The user's own model connections. A key goes in with `save` and never comes
 * back out: what returns says only whether one is stored.
 */
const customProviders = {
  list: () => connectionsRequest("custom-providers:list"),
  save: (connection: CustomConnectionSave) => connectionsRequest("custom-providers:save", connection),
  remove: (id: string) => connectionsRequest("custom-providers:remove", id),
  test: async (connectionId: string, modelId: string): Promise<CustomModelTestResult> => {
    const value: unknown = await ipcRenderer.invoke("custom-providers:test", { connectionId, modelId });
    return isCustomModelTestResult(value) ? value : { ok: false, message: "The model test returned an invalid result." };
  },
  importModels: async (connectionId: string): Promise<CustomModelImportResult> => {
    const value: unknown = await ipcRenderer.invoke("custom-providers:import", connectionId);
    return isCustomModelImportResult(value) ? value : { ok: false, message: "The model list returned an invalid result." };
  },
};

contextBridge.exposeInMainWorld("workbenchDesktop", {
  storage: {
    load: () => ipcRenderer.invoke("workspace:load"),
    save: (state: unknown) => ipcRenderer.invoke("workspace:save", state),
    // Fire before the renderer is destroyed; the main process drains its
    // ordered save queue before allowing the application to quit.
    flush: (state: unknown): void => ipcRenderer.send("workspace:flush", state),
    status: async (): Promise<StorageStatus> => {
      const status: unknown = await ipcRenderer.invoke("workspace:status");
      if (!isStorageStatus(status)) throw new Error("Storage returned an invalid recovery status.");
      return status;
    },
    recover: () => ipcRenderer.invoke("workspace:recover"),
    export: (state?: unknown): Promise<boolean> => ipcRenderer.invoke("workspace:export", state),
  },
  assets: {
    pick: () => ipcRenderer.invoke("assets:pick"),
    /** Attach a pasted or dropped image, whose bytes the renderer already holds. */
    attachImage: (name: string, mediaType: string, bytes: ArrayBuffer) =>
      ipcRenderer.invoke("assets:attach-image", { name, mediaType, bytes }),
    release: (ids: string[]): Promise<void> => ipcRenderer.invoke("assets:release", ids),
  },
  updates: {
    state: async (): Promise<AppUpdateState> => {
      const value: unknown = await ipcRenderer.invoke("update:state");
      return isAppUpdateState(value)
        ? value
        : { kind: "failed", message: "Roqer returned an invalid update state." };
    },
    /** Restart into a downloaded update. Resolves false when none is staged. */
    install: (): Promise<boolean> => ipcRenderer.invoke("update:install"),
    subscribe: (listener: (state: AppUpdateState) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: unknown) => {
        if (isAppUpdateState(payload)) listener(payload);
      };
      ipcRenderer.on("update:state", forward);
      return () => {
        ipcRenderer.off("update:state", forward);
      };
    },
  },
  bridge: {
    state: async (): Promise<McpServerState> => {
      const value: unknown = await ipcRenderer.invoke("mcp:state");
      return isMcpServerState(value)
        ? value
        : { kind: "failed", message: "Roqer returned an invalid Studio bridge state." };
    },
    restart: async (): Promise<McpServerState> => {
      const value: unknown = await ipcRenderer.invoke("mcp:restart");
      return isMcpServerState(value)
        ? value
        : { kind: "failed", message: "Roqer returned an invalid Studio bridge state." };
    },
    /** Subscribe to bridge state changes. Returns an unsubscribe function. */
    subscribe: (listener: (state: McpServerState) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: unknown) => {
        if (isMcpServerState(payload)) listener(payload);
      };
      ipcRenderer.on("mcp:state", forward);
      return () => {
        ipcRenderer.off("mcp:state", forward);
      };
    },
  },
  studio: {
    getStatus: (endpoint: string) => ipcRenderer.invoke("studio:status", endpoint),
    openScript: async (request: OpenStudioScriptRequest): Promise<StudioActionResult> => {
      const value: unknown = await ipcRenderer.invoke("studio:open-script", request);
      return isStudioActionResult(value)
        ? value
        : { ok: false, message: "Studio returned an invalid open-script result." };
    },
  },
  providers: {
    chatGpt: connector("chatgpt"),
    claude: connector("claude"),
    custom: connector("custom"),
  },
  customProviders,
  openCloud,
  blender,
  runs,
  app: {
    getDataPath: () => ipcRenderer.invoke("app:data-path"),
  },
});
