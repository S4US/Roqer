import { normalizeWorkspace, type AssetAttachment, type WorkspaceState } from "./model";
import type { StorageStatus } from "../shared/workspace-storage";
import type { McpServerState } from "../shared/mcp-server";
import type { AppUpdateState } from "../shared/app-update";
import { workspaceNeedsRecovery } from "../shared/workspace-validation";
import type { RunEvent, RunStartRequest } from "../shared/run-events";
import type { OpenStudioScriptRequest, StudioActionResult, StudioStatus } from "../shared/studio-status";
import type {
  CustomConnectionSave, CustomConnectionsResult, CustomModelImportResult, CustomModelTestResult,
} from "../shared/custom-providers";
import type { OpenCloudCheckResult, OpenCloudSave, OpenCloudSettingsResult } from "../shared/open-cloud";
import type { BlenderSettingsResult } from "../shared/blender";
import {
  providerLabel,
  type ProviderId,
  type ProviderLoginResult,
  type ProviderModelCatalog,
  type ProviderStatus,
} from "../shared/provider";

const STORAGE_KEY = "studio-workbench-workspace-v1";

export type { StudioStatus } from "../shared/studio-status";
export type { McpServerState } from "../shared/mcp-server";
export type { AppUpdateState } from "../shared/app-update";
export type { ProviderId, ProviderModelCatalog, ProviderStatus } from "../shared/provider";

/**
 * True when the renderer is running inside the Electron shell, which is the
 * only place a real agent run can happen — the MCP client, its credentials, and
 * the run engine all live in the main process. In a plain browser (renderer
 * development) the interface falls back to the clearly labelled demo run.
 */
export function hasDesktopRuntime(): boolean {
  return window.workbenchDesktop !== undefined;
}

export async function startRun(request: RunStartRequest) {
  if (!window.workbenchDesktop) {
    return { ok: false as const, message: "Agent runs need the desktop app." };
  }
  return window.workbenchDesktop.runs.start(request);
}

export async function respondToRun(runId: string, callId: string, decision: "approved" | "rejected"): Promise<boolean> {
  return window.workbenchDesktop?.runs.respond(runId, callId, decision) ?? false;
}

/** Answer a run's pending question by index into the options it offered. */
export async function answerRunQuestion(runId: string, callId: string, answerIndex: number): Promise<boolean> {
  return window.workbenchDesktop?.runs.answer(runId, callId, answerIndex) ?? false;
}

/**
 * Add a note for the running agent's next turn. False when the run has already
 * ended, in which case the words should go out as a new prompt instead.
 */
export async function steerRun(runId: string, text: string): Promise<boolean> {
  return window.workbenchDesktop?.runs.steer(runId, text) ?? false;
}

export async function cancelRun(runId: string, discard = false): Promise<void> {
  await window.workbenchDesktop?.runs.cancel(runId, discard);
}

export async function cancelRunStart(startId: string): Promise<void> {
  await window.workbenchDesktop?.runs.cancelStart(startId);
}

export async function releaseAttachments(ids: string[]): Promise<void> {
  await window.workbenchDesktop?.assets.release(ids);
}

/** Subscribe to run events. Returns an unsubscribe function. */
export function subscribeToRuns(listener: (event: RunEvent) => void): () => void {
  return window.workbenchDesktop?.runs.subscribe(listener) ?? (() => undefined);
}

function connector(provider: ProviderId) {
  if (provider === "custom") return window.workbenchDesktop?.providers.custom;
  return provider === "claude"
    ? window.workbenchDesktop?.providers.claude
    : window.workbenchDesktop?.providers.chatGpt;
}

const NO_DESKTOP = "Your own model connections need the desktop app.";

export async function listCustomConnections(): Promise<CustomConnectionsResult> {
  return window.workbenchDesktop?.customProviders.list() ?? { ok: false, message: NO_DESKTOP };
}

export async function saveCustomConnection(connection: CustomConnectionSave): Promise<CustomConnectionsResult> {
  return window.workbenchDesktop?.customProviders.save(connection) ?? { ok: false, message: NO_DESKTOP };
}

export async function removeCustomConnection(id: string): Promise<CustomConnectionsResult> {
  return window.workbenchDesktop?.customProviders.remove(id) ?? { ok: false, message: NO_DESKTOP };
}

export async function testCustomModel(connectionId: string, modelId: string): Promise<CustomModelTestResult> {
  return window.workbenchDesktop?.customProviders.test(connectionId, modelId) ?? { ok: false, message: NO_DESKTOP };
}

export async function importCustomModels(connectionId: string): Promise<CustomModelImportResult> {
  return window.workbenchDesktop?.customProviders.importModels(connectionId) ?? { ok: false, message: NO_DESKTOP };
}

const NO_DESKTOP_OPEN_CLOUD = "Roblox Open Cloud settings need the desktop app.";

export async function getOpenCloudSettings(): Promise<OpenCloudSettingsResult> {
  return window.workbenchDesktop?.openCloud.get() ?? { ok: false, message: NO_DESKTOP_OPEN_CLOUD };
}

export async function saveOpenCloudSettings(save: OpenCloudSave): Promise<OpenCloudSettingsResult> {
  return window.workbenchDesktop?.openCloud.save(save) ?? { ok: false, message: NO_DESKTOP_OPEN_CLOUD };
}

export async function checkOpenCloudKey(): Promise<OpenCloudCheckResult> {
  return window.workbenchDesktop?.openCloud.check() ?? { ok: false, message: NO_DESKTOP_OPEN_CLOUD };
}

const NO_DESKTOP_BLENDER = "The Blender worker needs the desktop app.";

export async function getBlenderSettings(): Promise<BlenderSettingsResult> {
  return window.workbenchDesktop?.blender.get() ?? { ok: false, message: NO_DESKTOP_BLENDER };
}

export async function setBlenderEnabled(enabled: boolean): Promise<BlenderSettingsResult> {
  return window.workbenchDesktop?.blender.setEnabled(enabled) ?? { ok: false, message: NO_DESKTOP_BLENDER };
}

export async function chooseBlender(): Promise<BlenderSettingsResult> {
  return window.workbenchDesktop?.blender.choose() ?? { ok: false, message: NO_DESKTOP_BLENDER };
}

export async function redetectBlender(): Promise<BlenderSettingsResult> {
  return window.workbenchDesktop?.blender.redetect() ?? { ok: false, message: NO_DESKTOP_BLENDER };
}

export async function getProviderStatus(provider: ProviderId): Promise<ProviderStatus> {
  const bridge = connector(provider);
  if (!bridge) return { kind: "unavailable", message: `${providerLabel(provider)} needs the desktop app.` };
  return bridge.status();
}

export async function loginProvider(provider: ProviderId): Promise<ProviderLoginResult> {
  const bridge = connector(provider);
  if (!bridge) return { ok: false, message: `${providerLabel(provider)} sign-in needs the desktop app.` };
  return bridge.login();
}

/** Finish a sign-in that came back with `awaitingCode`. */
export async function submitProviderCode(provider: ProviderId, code: string): Promise<ProviderLoginResult> {
  const bridge = connector(provider);
  if (!bridge) return { ok: false, message: `${providerLabel(provider)} sign-in needs the desktop app.` };
  return bridge.submitCode(code);
}

export async function getProviderModels(provider: ProviderId): Promise<ProviderModelCatalog> {
  const bridge = connector(provider);
  if (!bridge) {
    return { models: [], defaultModelId: null, message: `${providerLabel(provider)} needs the desktop app.` };
  }
  return bridge.models();
}

function loopbackEndpoint(value: string): URL | null {
  try {
    const endpoint = new URL(value);
    const hosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    return endpoint.protocol === "http:" && hosts.has(endpoint.hostname) ? endpoint : null;
  } catch {
    return null;
  }
}

export async function loadWorkspace(): Promise<unknown> {
  if (window.workbenchDesktop) return window.workbenchDesktop.storage.load();
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (!saved) return null;
  try {
    const parsed: unknown = JSON.parse(saved);
    browserStorageStatus = { required: workspaceNeedsRecovery(parsed), message: workspaceNeedsRecovery(parsed) ? "Saved chats need recovery. The original is preserved until you choose to recover." : null };
    return parsed;
  } catch {
    browserStorageStatus = { required: true, message: "Saved chats could not be read. Recovery will preserve a backup before resetting the workspace." };
    return null;
  }
}

let browserStorageStatus: StorageStatus = { required: false, message: null };

export async function getStorageStatus(): Promise<StorageStatus> {
  return window.workbenchDesktop ? window.workbenchDesktop.storage.status() : browserStorageStatus;
}

export async function recoverWorkspace(): Promise<unknown> {
  if (window.workbenchDesktop) return window.workbenchDesktop.storage.recover();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  let state: unknown;
  try { state = JSON.parse(raw ?? "null"); } catch { state = null; }
  if (typeof state === "object" && state !== null && "schemaVersion" in state && typeof state.schemaVersion === "number" && state.schemaVersion > 3) {
    throw new Error("These chats were saved by a newer app. Update Roqer before opening them.");
  }
  if (raw !== null) window.localStorage.setItem(`${STORAGE_KEY}-recovery-${Date.now()}`, raw);
  const restored = normalizeWorkspace(state);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
  browserStorageStatus = { required: false, message: null };
  return restored;
}

export async function exportWorkspace(state?: WorkspaceState): Promise<boolean> {
  if (window.workbenchDesktop) return window.workbenchDesktop.storage.export(state);
  const contents = state === undefined ? window.localStorage.getItem(STORAGE_KEY) ?? "null" : JSON.stringify(state, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "roqer-chats.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}

export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  if (window.workbenchDesktop) {
    await window.workbenchDesktop.storage.save(state);
    return;
  }
  if (browserStorageStatus.required) throw new Error(browserStorageStatus.message ?? "Recover saved chats before saving.");
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Hand the latest snapshot to native persistence before page teardown. */
export function flushWorkspace(state: WorkspaceState): void {
  if (window.workbenchDesktop) {
    window.workbenchDesktop.storage.flush(state);
    return;
  }
  if (!browserStorageStatus.required) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Image formats the agent can be given. Anything else stays a plain file. */
export const ATTACHABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const BROWSER_PREVIEW_EDGE = 320;

/**
 * A small preview for renderer development, where there is no main process to
 * make one. It is only ever a preview: a browser run is the labelled demo, so
 * nothing here is sent to a model.
 */
async function browserPreview(file: Blob): Promise<string | undefined> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => resolve(null);
      element.src = url;
    });
    if (!image || image.naturalWidth === 0) return undefined;
    const scale = Math.min(1, BROWSER_PREVIEW_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Attach an image the renderer already holds, from a paste or a drop.
 *
 * The desktop app hands the bytes to the main process, which downscales them,
 * keeps them for the run, and returns the preview the chat will store.
 */
export async function attachImage(file: Blob, name: string): Promise<AssetAttachment> {
  if (!ATTACHABLE_IMAGE_TYPES.has(file.type)) {
    throw new Error("Attach a PNG, JPEG, WebP, or GIF image.");
  }
  if (window.workbenchDesktop) {
    return window.workbenchDesktop.assets.attachImage(name, file.type, await file.arrayBuffer());
  }
  return {
    id: `asset-${crypto.randomUUID()}`,
    name,
    size: file.size,
    addedAt: new Date().toISOString(),
    mediaType: file.type,
    ...await (async () => {
      const preview = await browserPreview(file);
      return preview === undefined ? {} : { thumbnailDataUrl: preview };
    })(),
  };
}

export async function pickAsset(): Promise<AssetAttachment | null> {
  if (window.workbenchDesktop) return window.workbenchDesktop.assets.pick();

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rbxm,.rbxmx,.txt,.md,.lua,.luau,.zip,.png,.jpg,.jpeg,.webp,.ogg,.mp3,.wav";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve({
        id: `asset-${crypto.randomUUID()}`,
        name: file.name,
        size: file.size,
        addedAt: new Date().toISOString(),
      });
    };
    input.click();
  });
}

/** How the app updates itself. Only a packaged desktop build can. */
export async function getUpdateState(): Promise<AppUpdateState> {
  if (!window.workbenchDesktop) {
    return { kind: "unsupported", message: "Updates need the desktop app." };
  }
  return window.workbenchDesktop.updates.state();
}

/** Restart into a downloaded update. Resolves false when none is staged. */
export async function installUpdate(): Promise<boolean> {
  return window.workbenchDesktop?.updates.install() ?? false;
}

/** Subscribe to update state changes. Returns an unsubscribe function. */
export function subscribeToUpdates(listener: (state: AppUpdateState) => void): () => void {
  return window.workbenchDesktop?.updates.subscribe(listener) ?? (() => undefined);
}

/**
 * The local MCP bridge Roqer runs for itself.
 *
 * In renderer development there is no main process to run one, so the state is
 * reported honestly as unavailable rather than pretending a bridge exists.
 */
export async function getBridgeState(): Promise<McpServerState> {
  if (!window.workbenchDesktop) {
    return { kind: "failed", message: "The Studio bridge needs the desktop app." };
  }
  return window.workbenchDesktop.bridge.state();
}

export async function restartBridge(): Promise<McpServerState> {
  if (!window.workbenchDesktop) {
    return { kind: "failed", message: "The Studio bridge needs the desktop app." };
  }
  return window.workbenchDesktop.bridge.restart();
}

/** Subscribe to bridge state changes. Returns an unsubscribe function. */
export function subscribeToBridge(listener: (state: McpServerState) => void): () => void {
  return window.workbenchDesktop?.bridge.subscribe(listener) ?? (() => undefined);
}

export async function getStudioStatus(endpoint: string): Promise<StudioStatus> {
  if (window.workbenchDesktop) return window.workbenchDesktop.studio.getStatus(endpoint);

  const validatedEndpoint = loopbackEndpoint(endpoint);
  if (!validatedEndpoint) {
    return { kind: "offline", endpoint, message: "Use a local HTTP MCP endpoint" };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1_800);
  try {
    const response = await fetch(new URL("/health", validatedEndpoint), { signal: controller.signal });
    if (!response.ok) throw new Error("MCP unavailable");
    const health = await response.json() as Record<string, unknown>;
    const instances = Array.isArray(health.instances) ? health.instances : [];
    const first = instances[0] as Record<string, unknown> | undefined;
    return {
      kind: health.pluginConnected ? "connected" : "bridge-only",
      endpoint,
      placeName: typeof first?.placeName === "string" ? first.placeName : undefined,
      instanceCount: typeof health.instanceCount === "number" ? health.instanceCount : 0,
      serverVersion: typeof health.serverVersion === "string" ? health.serverVersion : undefined,
      mode: first?.isRunning ? "Playtest" : "Edit",
      message: health.pluginConnected ? "Studio connected" : "Waiting for Roblox Studio",
    };
  } catch {
    return { kind: "offline", endpoint, message: "MCP is not running" };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function openScriptInStudio(request: OpenStudioScriptRequest): Promise<StudioActionResult> {
  if (!window.workbenchDesktop) {
    return { ok: false, message: "Opening scripts in Studio needs the desktop app." };
  }
  return window.workbenchDesktop.studio.openScript(request);
}
