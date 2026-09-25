import type { AssetAttachment, WorkspaceState } from "./model";
import type { RunEvent, RunStartRequest } from "../shared/run-events";
import type { OpenStudioScriptRequest, StudioActionResult, StudioStatus } from "../shared/studio-status";
import type { ProviderLoginResult, ProviderModelCatalog, ProviderStatus } from "../shared/provider";
import type { StorageStatus } from "../shared/workspace-storage";
import type { McpServerState } from "../shared/mcp-server";
import type { AppUpdateState } from "../shared/app-update";
import type {
  CustomConnectionSave, CustomConnectionsResult, CustomModelImportResult, CustomModelTestResult,
} from "../shared/custom-providers";
import type { OpenCloudCheckResult, OpenCloudSave, OpenCloudSettingsResult } from "../shared/open-cloud";
import type { BlenderSettingsResult } from "../shared/blender";

type ProviderConnector = {
  status(): Promise<ProviderStatus>;
  login(): Promise<ProviderLoginResult>;
  submitCode(code: string): Promise<ProviderLoginResult>;
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
      blender: {
        get(): Promise<BlenderSettingsResult>;
        setEnabled(enabled: boolean): Promise<BlenderSettingsResult>;
        choose(): Promise<BlenderSettingsResult>;
        redetect(): Promise<BlenderSettingsResult>;
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
      app: {
        getDataPath(): Promise<string>;
      };
    };
  }
}

export {};
