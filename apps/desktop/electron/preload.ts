import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import {
  isProviderInstallResult,
  isProviderLoginResult,
  isProviderModelCatalog,
  isProviderStatus,
  providerLabel,
  type ProviderId,
  type ProviderInstallResult,
  type ProviderLoginResult,
  type ProviderModelCatalog,
  type ProviderStatus,
} from "../shared/provider";
import { isProviderLimits, NO_LIMITS, type ProviderLimits } from "../shared/provider-limits";
import { isAppUpdateState, isAppVersion, type AppUpdateState } from "../shared/app-update";
import { isMcpServerState, type McpServerState } from "../shared/mcp-server";
import { isEvidencePictureRef, isRunEvent, type RunEvent, type RunStartRequest } from "../shared/run-events";
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
import { isRojoResult, type RojoResult } from "../shared/rojo";
import { isModelPreviewResult, type ModelPreviewResult } from "../shared/model-preview";
import { isEvidencePictureResult, type EvidencePictureResult } from "../shared/evidence-picture";
import { isProjectNotesResult, type ProjectNotesResult } from "../shared/project-notes";
import { isProjectFile, type ProjectFile, type ProjectFilesResult, type SendToStudioResult } from "../shared/project-files";

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
    /** Wait for a sign-in that finishes in the browser, which `login` started. */
    waitForLogin: async (): Promise<ProviderLoginResult> => {
      const value: unknown = await ipcRenderer.invoke("provider:login-wait", provider);
      return isProviderLoginResult(value)
        ? value
        : { ok: false, message: `The ${label} sign-in request returned an invalid result.` };
    },
    /** Open the fallback sign-in page, for when the browser the CLI opens did not appear. */
    openLogin: async (): Promise<ProviderLoginResult> => {
      const value: unknown = await ipcRenderer.invoke("provider:login-open", provider);
      return isProviderLoginResult(value)
        ? value
        : { ok: false, message: `The ${label} sign-in request returned an invalid result.` };
    },
    cancelLogin: async (): Promise<ProviderLoginResult> => {
      const value: unknown = await ipcRenderer.invoke("provider:login-cancel", provider);
      return isProviderLoginResult(value)
        ? value
        : { ok: false, message: `The ${label} sign-in request returned an invalid result.` };
    },
    /** Install the client this subscription runs through; the main process asks the user first. */
    install: async (): Promise<ProviderInstallResult> => {
      const value: unknown = await ipcRenderer.invoke("provider:install", provider);
      return isProviderInstallResult(value)
        ? value
        : { ok: false, message: `The ${label} install request returned an invalid result.` };
    },
    /** The plan's usage limits; `none` when the provider reported nothing. */
    limits: async (): Promise<ProviderLimits> => {
      const value: unknown = await ipcRenderer.invoke("provider:limits", provider);
      return isProviderLimits(value) ? value : NO_LIMITS;
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

async function rojoRequest(channel: string, ...args: unknown[]): Promise<RojoResult> {
  const value: unknown = await ipcRenderer.invoke(channel, ...args);
  return isRojoResult(value) ? value : { ok: false, message: "Roqer returned an invalid Rojo link." };
}

/**
 * The Rojo link for a place. The renderer never names a project file itself:
 * `choose` opens the main process's own file dialog, `linkRecent` names a
 * project only by its index into the main process's own recent list, and
 * `openFolder` opens a folder the main process already holds -- no call here
 * ever carries a path.
 */
const rojo = {
  get: (instanceId: string | null) => rojoRequest("rojo:get", instanceId),
  choose: (instanceId: string) => rojoRequest("rojo:choose", instanceId),
  linkRecent: (instanceId: string, index: number) => rojoRequest("rojo:link-recent", { instanceId, index }),
  unlink: (instanceId: string) => rojoRequest("rojo:unlink", instanceId),
  forget: (instanceId: string) => rojoRequest("rojo:forget", instanceId),
  retry: (instanceId: string) => rojoRequest("rojo:retry", instanceId),
  openFolder: (instanceId: string) => rojoRequest("rojo:open-folder", instanceId),
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

const chats = {
  /**
   * Forget the provider conversations a chat keeps, after a manual compact.
   * False when a run is working on the chat right now.
   */
  compact: (chatId: string): Promise<boolean> => ipcRenderer.invoke("chat:compact", chatId),
  /**
   * Compact the chat's saved Claude conversation now, as `/compact` does.
   * `noSession` when there is none to compact.
   */
  compactModel: async (projectId: string, chatId: string): Promise<{ ok: boolean; message: string; noSession?: true }> => {
    const value: unknown = await ipcRenderer.invoke("chat:compact-model", { projectId, chatId });
    if (typeof value !== "object" || value === null) return { ok: false, message: "Compacting returned an invalid answer." };
    const answer = value as { ok?: unknown; message?: unknown; noSession?: unknown };
    return typeof answer.ok === "boolean" && typeof answer.message === "string"
      ? { ok: answer.ok, message: answer.message, ...(answer.noSession === true ? { noSession: true as const } : {}) }
      : { ok: false, message: "Compacting returned an invalid answer." };
  },
};

/** A files answer, checked: a failure's message, or a value the check accepts. */
function filesAnswer<T>(value: unknown, check: (inner: unknown) => inner is T): ProjectFilesResult<T> {
  if (typeof value !== "object" || value === null) return { ok: false, message: "Project files returned an invalid answer." };
  const answer = value as { ok?: unknown; value?: unknown; message?: unknown };
  if (answer.ok === false) return { ok: false, message: typeof answer.message === "string" ? answer.message : "Project files failed." };
  return answer.ok === true && check(answer.value) ? { ok: true, value: answer.value } : { ok: false, message: "Project files returned an invalid answer." };
}

const isFileList = (value: unknown): value is ProjectFile[] => Array.isArray(value) && value.every(isProjectFile);
const isTrue = (value: unknown): value is true => value === true;
const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

function notesAnswer(value: unknown): ProjectNotesResult {
  return isProjectNotesResult(value) ? value : { ok: false, message: "The project notes returned an invalid answer." };
}

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
    /** Attach a dropped or pasted video, whose bytes the renderer already holds. */
    attachVideo: (name: string, bytes: ArrayBuffer) =>
      ipcRenderer.invoke("assets:attach-video", { name, bytes }),
    /** Thumbnails over an attached clip, or over `range` of it. */
    clipStrip: (id: string, count: number, range?: { start: number; end: number }) =>
      ipcRenderer.invoke("assets:clip-strip", { id, count, range }),
    clipFrame: (id: string, time: number) => ipcRenderer.invoke("assets:clip-frame", { id, time }),
    /** Read the frames of the part of a clip the user chose. */
    selectClip: (id: string, selection: { start: number; end: number; slow: number }) =>
      ipcRenderer.invoke("assets:clip-select", { id, selection }),
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
    antigravity: connector("antigravity"),
    custom: connector("custom"),
  },
  customProviders,
  openCloud,
  blender,
  rojo,
  runs,
  chats,
  previews: {
    /** A Blender result's 3D preview, by the opaque id its evidence carries. */
    loadModel: async (id: string): Promise<ModelPreviewResult> => {
      const value: unknown = await ipcRenderer.invoke("previews:model", id);
      return isModelPreviewResult(value) ? value : { ok: false, reason: "invalid" };
    },
    /** A saved run's picture, by the ref its evidence carries; never a path. */
    loadPicture: async (ref: string): Promise<EvidencePictureResult> => {
      if (!isEvidencePictureRef(ref)) return { ok: false, reason: "invalid" };
      const value: unknown = await ipcRenderer.invoke("previews:picture", ref);
      return isEvidencePictureResult(value) ? value : { ok: false, reason: "invalid" };
    },
  },
  /** The project's memory and master plan. Every answer is checked before the window sees it. */
  notes: {
    get: async (projectId: string): Promise<ProjectNotesResult> => notesAnswer(await ipcRenderer.invoke("notes:get", projectId)),
    setPlan: async (projectId: string, plan: string): Promise<ProjectNotesResult> =>
      notesAnswer(await ipcRenderer.invoke("notes:set-plan", projectId, plan)),
    addMemory: async (projectId: string, text: string): Promise<ProjectNotesResult> =>
      notesAnswer(await ipcRenderer.invoke("notes:add-memory", projectId, text)),
    updateMemory: async (projectId: string, id: string, text: string): Promise<ProjectNotesResult> =>
      notesAnswer(await ipcRenderer.invoke("notes:update-memory", projectId, id, text)),
    removeMemory: async (projectId: string, id: string): Promise<ProjectNotesResult> =>
      notesAnswer(await ipcRenderer.invoke("notes:remove-memory", projectId, id)),
  },
  /** The project's shared files. Paths of dropped files are read here, where the File objects are. */
  files: {
    list: async (projectId: string) => filesAnswer(await ipcRenderer.invoke("files:list", projectId), isFileList),
    addDropped: async (projectId: string, dropped: File[], chatId: string | null) => {
      const paths = dropped.map((file) => webUtils.getPathForFile(file)).filter((entry) => entry !== "");
      if (paths.length === 0) return { ok: false as const, message: "Those files could not be read. Drop files from your computer." };
      return filesAnswer(await ipcRenderer.invoke("files:add", projectId, paths, chatId ?? undefined), isFileList);
    },
    pick: async (projectId: string, chatId: string | null) =>
      filesAnswer(await ipcRenderer.invoke("files:pick", projectId, chatId ?? undefined), isFileList),
    remove: async (projectId: string, fileId: string) => filesAnswer(await ipcRenderer.invoke("files:remove", projectId, fileId), isTrue),
    note: async (projectId: string, fileId: string, note: string) =>
      filesAnswer(await ipcRenderer.invoke("files:note", projectId, fileId, note), isProjectFile),
    read: async (projectId: string, fileId: string) => filesAnswer(await ipcRenderer.invoke("files:read", projectId, fileId), isBytes),
    reveal: async (projectId: string, fileId: string) => filesAnswer(await ipcRenderer.invoke("files:reveal", projectId, fileId), isTrue),
    savePreview: async (projectId: string, previewId: string, chatId: string | null) =>
      filesAnswer(await ipcRenderer.invoke("files:save-preview", projectId, previewId, chatId ?? undefined), isProjectFile),
    sendToStudio: async (source: { projectId: string; fileId: string } | { previewId: string }, endpoint: string, instanceId: string | null): Promise<SendToStudioResult> => {
      const value: unknown = await ipcRenderer.invoke("studio:send-model", { source, endpoint, instanceId });
      if (typeof value !== "object" || value === null) return { ok: false, message: "Studio returned an invalid answer." };
      const answer = value as { ok?: unknown; message?: unknown; assetId?: unknown };
      return typeof answer.ok === "boolean" && typeof answer.message === "string"
        ? { ok: answer.ok, message: answer.message, ...(typeof answer.assetId === "string" ? { assetId: answer.assetId } : {}) }
        : { ok: false, message: "Studio returned an invalid answer." };
    },
    subscribe: (listener: (projectId: string) => void) => {
      const forward = (_event: IpcRendererEvent, projectId: unknown) => { if (typeof projectId === "string") listener(projectId); };
      ipcRenderer.on("files:changed", forward);
      return () => { ipcRenderer.removeListener("files:changed", forward); };
    },
  },
  app: {
    getDataPath: () => ipcRenderer.invoke("app:data-path"),
    /** The running build's version, or null when the answer was not one. */
    version: async (): Promise<string | null> => {
      const value: unknown = await ipcRenderer.invoke("app:version");
      return isAppVersion(value) ? value : null;
    },
    /**
     * Put a report of the Studio connection on the clipboard. The main process
     * writes it; the window never receives the log it is made from.
     */
    copyDiagnostics: async (endpoint: string): Promise<boolean> =>
      (await ipcRenderer.invoke("app:copy-diagnostics", endpoint)) === true,
    /** Show the bridge's log in the file manager. No path crosses this bridge. */
    showBridgeLog: async (): Promise<boolean> =>
      (await ipcRenderer.invoke("app:show-bridge-log")) === true,
  },
});
