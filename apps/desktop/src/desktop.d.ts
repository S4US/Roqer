import type { AssetAttachment, WorkspaceState } from "./model";
import type { RunEvent, RunStartRequest } from "../shared/run-events";
import type { OpenStudioScriptRequest, StudioActionResult, StudioStatus } from "../shared/studio-status";
import type { ProviderInstallResult, ProviderLoginResult, ProviderModelCatalog, ProviderStatus } from "../shared/provider";
import type { ProviderLimits } from "../shared/provider-limits";
import type { StorageStatus } from "../shared/workspace-storage";
import type { McpServerState } from "../shared/mcp-server";
import type { AppUpdateState } from "../shared/app-update";
import type {
  CustomConnectionSave, CustomConnectionsResult, CustomModelImportResult, CustomModelTestResult,
} from "../shared/custom-providers";
import type { OpenCloudCheckResult, OpenCloudSave, OpenCloudSettingsResult } from "../shared/open-cloud";
import type { BlenderSettingsResult } from "../shared/blender";
import type { RojoResult } from "../shared/rojo";
import type { ModelPreviewResult } from "../shared/model-preview";
import type { EvidencePictureResult } from "../shared/evidence-picture";
import type { ClipSelection } from "../shared/reference-clip";
import type { ProjectNotesResult } from "../shared/project-notes";
import type { ProjectFile, ProjectFilesResult, SendToStudioResult } from "../shared/project-files";

type ProviderConnector = {
  status(): Promise<ProviderStatus>;
  login(): Promise<ProviderLoginResult>;
  submitCode(code: string): Promise<ProviderLoginResult>;
  waitForLogin(): Promise<ProviderLoginResult>;
  openLogin(): Promise<ProviderLoginResult>;
  cancelLogin(): Promise<ProviderLoginResult>;
  install(): Promise<ProviderInstallResult>;
  limits(): Promise<ProviderLimits>;
  models(): Promise<ProviderModelCatalog>;
};

declare global {
  interface Window {
    workbenchDesktop?: {
      storage: {
        load(): Promise<unknown>;
        save(state: WorkspaceState): Promise<{ savedAt: string }>;
        flush(state: WorkspaceState): void;
        status(): Promise<StorageStatus>;
        recover(): Promise<unknown>;
        export(state?: WorkspaceState): Promise<boolean>;
      };
      assets: {
        pick(): Promise<AssetAttachment | null>;
        attachImage(name: string, mediaType: string, bytes: ArrayBuffer): Promise<AssetAttachment>;
        attachVideo(name: string, bytes: ArrayBuffer): Promise<AssetAttachment>;
        clipStrip(id: string, count: number, range?: { start: number; end: number }): Promise<Array<{ time: number; dataUrl: string }>>;
        clipFrame(id: string, time: number): Promise<string>;
        selectClip(id: string, selection: ClipSelection): Promise<AssetAttachment>;
        release(ids: string[]): Promise<void>;
      };
      updates: {
        state(): Promise<AppUpdateState>;
        install(): Promise<boolean>;
        subscribe(listener: (state: AppUpdateState) => void): () => void;
      };
      bridge: {
        state(): Promise<McpServerState>;
        restart(): Promise<McpServerState>;
        subscribe(listener: (state: McpServerState) => void): () => void;
      };
      studio: {
        getStatus(endpoint: string): Promise<StudioStatus>;
        openScript(request: OpenStudioScriptRequest): Promise<StudioActionResult>;
      };
      providers: {
        chatGpt: ProviderConnector;
        claude: ProviderConnector;
        antigravity: ProviderConnector;
        custom: ProviderConnector;
      };
      customProviders: {
        list(): Promise<CustomConnectionsResult>;
        save(connection: CustomConnectionSave): Promise<CustomConnectionsResult>;
        remove(id: string): Promise<CustomConnectionsResult>;
        test(connectionId: string, modelId: string): Promise<CustomModelTestResult>;
        importModels(connectionId: string): Promise<CustomModelImportResult>;
      };
      openCloud: {
        get(): Promise<OpenCloudSettingsResult>;
        save(save: OpenCloudSave): Promise<OpenCloudSettingsResult>;
        check(): Promise<OpenCloudCheckResult>;
      };
      previews: {
        loadModel(id: string): Promise<ModelPreviewResult>;
        loadPicture(ref: string): Promise<EvidencePictureResult>;
      };
      blender: {
        get(): Promise<BlenderSettingsResult>;
        setEnabled(enabled: boolean): Promise<BlenderSettingsResult>;
        choose(): Promise<BlenderSettingsResult>;
        redetect(): Promise<BlenderSettingsResult>;
      };
      rojo: {
        get(instanceId: string | null): Promise<RojoResult>;
        choose(instanceId: string): Promise<RojoResult>;
        linkRecent(instanceId: string, index: number): Promise<RojoResult>;
        unlink(instanceId: string): Promise<RojoResult>;
        forget(instanceId: string): Promise<RojoResult>;
        retry(instanceId: string): Promise<RojoResult>;
        openFolder(instanceId: string): Promise<RojoResult>;
      };
      runs: {
        start(request: RunStartRequest): Promise<{ ok: true; runId: string } | { ok: false; message: string }>;
        respond(runId: string, callId: string, decision: "approved" | "rejected"): Promise<boolean>;
        answer(runId: string, callId: string, answerIndex: number): Promise<boolean>;
        steer(runId: string, text: string): Promise<boolean>;
        cancel(runId: string, discard?: boolean): Promise<void>;
        cancelStart(startId: string): Promise<void>;
        subscribe(listener: (event: RunEvent) => void): () => void;
      };
      notes: {
        get(projectId: string): Promise<ProjectNotesResult>;
        setPlan(projectId: string, plan: string): Promise<ProjectNotesResult>;
        addMemory(projectId: string, text: string): Promise<ProjectNotesResult>;
        updateMemory(projectId: string, id: string, text: string): Promise<ProjectNotesResult>;
        removeMemory(projectId: string, id: string): Promise<ProjectNotesResult>;
      };
      files: {
        list(projectId: string): Promise<ProjectFilesResult<ProjectFile[]>>;
        addDropped(projectId: string, dropped: File[], chatId: string | null): Promise<ProjectFilesResult<ProjectFile[]>>;
        pick(projectId: string, chatId: string | null): Promise<ProjectFilesResult<ProjectFile[]>>;
        remove(projectId: string, fileId: string): Promise<ProjectFilesResult<true>>;
        note(projectId: string, fileId: string, note: string): Promise<ProjectFilesResult<ProjectFile>>;
        read(projectId: string, fileId: string): Promise<ProjectFilesResult<Uint8Array>>;
        reveal(projectId: string, fileId: string): Promise<ProjectFilesResult<true>>;
        savePreview(projectId: string, previewId: string, chatId: string | null): Promise<ProjectFilesResult<ProjectFile>>;
        sendToStudio(source: { projectId: string; fileId: string } | { previewId: string }, endpoint: string, instanceId: string | null): Promise<SendToStudioResult>;
        subscribe(listener: (projectId: string) => void): () => void;
      };
      chats: {
        compact(chatId: string): Promise<boolean>;
        compactModel(projectId: string, chatId: string): Promise<{ ok: boolean; message: string; noSession?: true }>;
      };
      app: {
        getDataPath(): Promise<string>;
        version(): Promise<string | null>;
        copyDiagnostics(endpoint: string): Promise<boolean>;
        showBridgeLog(): Promise<boolean>;
      };
    };
  }
}

export {};
