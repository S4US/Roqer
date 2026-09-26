import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadAgentRuntime, type AgentRuntime } from "../runtime/agent-definition";
import { createChatGptPlanner, type CodexThread } from "../runtime/chatgpt-planner";
import { createAgentLoopPlanner, type AgentLoopSession } from "../runtime/agent-loop";
import { toolOutputBudgetFor } from "../runtime/agent-loop-history";
import { CustomProviderStore } from "../runtime/custom-provider-store";
import { bridgeEnvironment, checkOpenCloudKey } from "../runtime/open-cloud";
import { BlenderSettings } from "../runtime/blender-settings";
import { BlenderWorker } from "../runtime/blender-worker";
import { withLocalOperations } from "../runtime/local-operations";
import type { McpCallOptions, McpToolOutcome } from "../runtime/mcp-types";
import { BLENDER_OPERATION, type BlenderSettingsResult, type BlenderSettingsView } from "../shared/blender";
import { OpenCloudStore, type OpenCloudResolved } from "../runtime/open-cloud-store";
import {
  parseOpenCloudSave,
  type OpenCloudBridgeUse,
  type OpenCloudCheckResult,
  type OpenCloudSettingsResult,
} from "../shared/open-cloud";
import {
  createCustomTransport, customModelCatalog, customProviderStatus, customTransportKey, findCustomModel, listEndpointModels,
  testCustomModel,
} from "../runtime/custom-provider";
import {
  isCustomConnectionId,
  isCustomModelId,
  parseCustomConnectionSave,
  parseCustomModelKey,
  type CustomConnection,
  type CustomConnectionsResult,
  type CustomModel,
  type CustomModelImportResult,
  type CustomModelTestResult,
} from "../shared/custom-providers";
import { ClaudeCodeClient } from "../runtime/claude-cli";
import { createClaudePlanner, type ClaudeSession } from "../runtime/claude-planner";
import { ProviderSessionStore } from "../runtime/provider-sessions";
import { CodexAppServerClient } from "../runtime/codex-app-server";
import { createInspectionPlanner } from "../runtime/inspection-planner";
import { McpClient } from "../runtime/mcp-client";
import { McpEndpointError } from "../runtime/mcp-types";
import {
  RunSession, type BridgeRecovery, type BridgeRecoveryHost, type Planner,
} from "../runtime/run-engine";
import { PendingRuns } from "../runtime/pending-runs";
import { WorkspaceStore } from "../runtime/workspace-store";
import { adoptPreviousUserData, PREVIOUS_USER_DATA_SEGMENTS } from "../runtime/user-data-location";
import { RunJournal } from "../runtime/run-journal";
import { BridgeLog } from "../runtime/bridge-log";
import { AttachmentRegistry, MAX_IMAGE_SOURCE_BYTES } from "../runtime/attachment-context";
import { encodeAttachmentImage } from "./image-encoder";
import { DiscordPresence } from "./discord-presence";
import { McpServerProcess } from "../runtime/mcp-server-process";
import { mcpServerMessage, type McpServerState } from "../shared/mcp-server";
import type { AppUpdateState } from "../shared/app-update";
import { mergeRecoveredRuns } from "../runtime/recovered-runs";
import { createInitialWorkspace, normalizeWorkspace, type WorkspaceState } from "../src/model";
import type { ApprovalMode } from "../shared/policy";
import { isConversationContext } from "../shared/conversation";
import type { RunEvent, RunStartRequest } from "../shared/run-events";
import {
  isEnabledProvider,
  isReasoningEffort,
  providerLabel,
  type ProviderId,
  type ProviderLoginResult,
  type ProviderModelCatalog,
  type ProviderStatus,
} from "../shared/provider";
import type { OpenStudioScriptRequest, StudioActionResult, StudioStatus } from "../shared/studio-status";
import { electronSecretProtector } from "./secret-protector";

const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:58741";
const HEALTH_TIMEOUT_MS = 1_800;
const smokeTest = process.env.WORKBENCH_SMOKE_TEST === "1";

let saveQueue: Promise<unknown> = Promise.resolve();
let waitingForShutdownBeforeQuit = false;
let shutdownFinishedForQuit = false;

/**
 * Only windows this process created may drive the runtime. Without this an
 * embedded frame or a webview could invoke the run channel.
 */
const trustedSenders = new Set<number>();
const runSessions = new Map<string, RunSession>();
const runExecutions = new Set<Promise<unknown>>();
const pendingRuns = new PendingRuns();
const attachments = new AttachmentRegistry(encodeAttachmentImage);
const discardedRuns = new Set<string>();
const journalRuns = new Set<string>();
const completedRuns = new Set<string>();
let journalFailure: string | undefined;
let shuttingDown = false;
let workspaceStore: WorkspaceStore | undefined;
let journal: RunJournal | undefined;
let bridgeLogFile: BridgeLog | undefined;
let storageReady: Promise<void> | undefined;
let recoveredView: WorkspaceState | undefined;

function store(): WorkspaceStore {
  return workspaceStore ??= new WorkspaceStore(app.getPath("userData"));
}

/**
 * Everything the Studio bridge writes, on disk. The supervisor keeps a few
 * lines in memory for a failed start; this is for the bridge that ran for an
 * hour and then died, whose reason is otherwise lost with the process.
 */
function bridgeLog(): BridgeLog {
  return bridgeLogFile ??= new BridgeLog(path.join(app.getPath("userData"), "bridge.log"), {
    onError: (error) => console.error("Roqer could not write the bridge log", error),
  });
}

function runJournal(): RunJournal {
  return journal ??= new RunJournal(path.join(app.getPath("userData"), "run-journal"), (error) => {
    if (journalFailure) return;
    journalFailure = "Run progress could not be saved. The run was stopped; export your chats and check available disk space before restarting Roqer.";
    console.error("Roqer could not save run progress; stopping active runs", error);
    for (const session of runSessions.values()) session.cancel(journalFailure);
    cancelAllRuns();
  });
}

async function initializeStorage(): Promise<void> {
  storageReady ??= (async () => {
    const state = normalizeWorkspace(await store().load());
    const recovered = await runJournal().recover();
    if (recovered.length === 0) return;
    const merged = mergeRecoveredRuns(state, recovered);
    if (store().status().required) {
      recoveredView = merged;
      recovered.forEach((entry) => journalRuns.add(entry.message.run!.runId));
    }
    else {
      await store().save(merged);
      await runJournal().acknowledge(recovered.map((entry) => entry.message.run!.runId));
    }
  })();
  return storageReady.catch((error) => { storageReady = undefined; throw error; });
}
let codexAppServer: CodexAppServerClient | null = null;
let claudeCode: ClaudeCodeClient | null = null;
/**
 * Each chat's subscription conversation, kept between its messages so a
 * follow-up does not replay the chat or re-read Studio. In memory only.
 */
const claudeSessions = new ProviderSessionStore<ClaudeSession>();
const codexThreads = new ProviderSessionStore<CodexThread>();
const customConversations = new ProviderSessionStore<AgentLoopSession>();
let agentRuntimePromise: Promise<AgentRuntime> | null = null;
let customProviderStore: CustomProviderStore | null = null;

/** The user's own model connections, with their keys encrypted by the OS. */
function customProviders(): CustomProviderStore {
  customProviderStore ??= new CustomProviderStore({
    file: path.join(app.getPath("userData"), "custom-providers.json"),
    protector: electronSecretProtector,
  });
  return customProviderStore;
}

let openCloudStore: OpenCloudStore | null = null;

/** The user's Roblox Open Cloud key and creator, with the key encrypted by the OS. */
function openCloud(): OpenCloudStore {
  openCloudStore ??= new OpenCloudStore({
    file: path.join(app.getPath("userData"), "open-cloud.json"),
    protector: electronSecretProtector,
  });
  return openCloudStore;
}

if (process.env.WORKBENCH_USER_DATA) {
  app.setPath("userData", process.env.WORKBENCH_USER_DATA);
} else {
  // Before anything reads it: the folder was named after the old package name,
  // and moving it here is what keeps a user's chats and settings after the
  // rename. See runtime/user-data-location.ts.
  const current = app.getPath("userData");
  const chosen = adoptPreviousUserData(current, path.join(app.getPath("appData"), ...PREVIOUS_USER_DATA_SEGMENTS));
  if (chosen !== current) app.setPath("userData", chosen);
}

/**
 * The Discord profile entry, driven from here because the main process is the
 * only place that knows both the saved preference and whether a run is going.
 *
 * Learned from the workspace rather than from an IPC channel of its own: the
 * preference already travels on every load and save, and a second path for the
 * same fact could only disagree with the first.
 */
const presence = new DiscordPresence();

function applyPresencePreference(state: unknown): void {
  if (!presence.available) return;
  const preferences = (state as { preferences?: { discordPresence?: unknown } } | null)?.preferences;
  // Absent means a workspace saved before the setting existed, which
  // `normalizeWorkspace` reads as on. Undefined here must read the same way, or
  // the presence would be off until the first save rewrote the file.
  presence.setEnabled(preferences?.discordPresence !== false);
}

async function loadState(): Promise<unknown> {
  await initializeStorage();
  const state = recoveredView ?? await store().load();
  applyPresencePreference(state);
  return state;
}

async function writeState(state: unknown): Promise<{ savedAt: string }> {
  await initializeStorage();
  applyPresencePreference(state);
  const result = await store().save(state);
  const recorded = normalizeWorkspace(state).projects.flatMap((project) => project.chats.flatMap((chat) =>
    chat.messages.flatMap((message) => message.run && journalRuns.has(message.run.runId) && completedRuns.has(message.run.runId) ? [message.run.runId] : [])));
  if (recorded.length > 0) {
    await runJournal().acknowledge(recorded);
    recorded.forEach((id) => { journalRuns.delete(id); completedRuns.delete(id); });
  }
  return result;
}

function queueStateWrite(state: unknown): Promise<{ savedAt: string }> {
  const operation = saveQueue.then(() => writeState(state));
  saveQueue = operation.catch(() => undefined);
  return operation;
}

function saveState(event: IpcMainInvokeEvent, state: unknown): Promise<{ savedAt: string }> {
  if (!isTrusted(event.sender)) throw new Error("This window may not save the workspace.");
  return queueStateWrite(state).then((saved) => {
    followTheme(savedTheme(state));
    return saved;
  });
}

async function recoverState(event: IpcMainInvokeEvent): Promise<unknown> {
  if (!isTrusted(event.sender)) throw new Error("This window may not recover the workspace.");
  await initializeStorage();
  const state = normalizeWorkspace(await store().recover());
  const recovered = await runJournal().recover();
  const merged = mergeRecoveredRuns(state, recovered);
  await store().save(merged);
  await runJournal().acknowledge(recovered.map((entry) => entry.message.run!.runId));
  recoveredView = undefined;
  return merged;
}

async function exportState(event: IpcMainInvokeEvent, state: unknown): Promise<boolean> {
  if (!isTrusted(event.sender)) throw new Error("This window may not export the workspace.");
  await initializeStorage();
  const result = await dialog.showSaveDialog({
    title: "Export chats", defaultPath: "roqer-chats.json",
    filters: [{ name: "Roqer workspace", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return false;
  await store().export(result.filePath, state);
  return true;
}

/** Last-chance renderer flush used while its window is unloading. */
function flushState(event: IpcMainEvent, state: unknown): void {
  if (!isTrusted(event.sender)) return;
  void queueStateWrite(state).catch((error) => {
    console.error("Roqer could not flush workspace state", error);
  });
}

/** Wait until no renderer save was appended during the previous event turn. */
async function drainStateWrites(): Promise<void> {
  let observed: Promise<unknown>;
  do {
    observed = saveQueue;
    await observed;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (saveQueue !== observed);
}

async function pickAsset(event: IpcMainInvokeEvent) {
  if (!isTrusted(event.sender)) throw new Error("This window may not select files.");
  const result = await dialog.showOpenDialog({
    title: "Attach an asset pack",
    properties: ["openFile"],
    filters: [
      { name: "Roblox, text and media assets", extensions: ["rbxm", "rbxmx", "txt", "md", "lua", "luau", "zip", "png", "jpg", "jpeg", "webp", "ogg", "mp3", "wav"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  if (!isTrusted(event.sender)) return null;
  return attachments.register(result.filePaths[0]);
}

/**
 * Register an image the renderer already holds â€” a pasted screenshot, or a file
 * dropped onto the composer. Its bytes cross the bridge because the renderer
 * has no path to hand over in either case, and giving it one would mean handing
 * the less-trusted side a filesystem location it did not have before.
 */
async function attachImage(event: IpcMainInvokeEvent, payload: unknown) {
  if (!isTrusted(event.sender)) throw new Error("This window may not attach images.");
  if (!isRecord(payload)) throw new Error("The attachment request was not valid.");
  const { name, mediaType, bytes } = payload;
  // Sent as a plain ArrayBuffer, which structured cloning preserves, so its
  // size is checked before it is copied into a Buffer.
  if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
    throw new Error("The attached image was not readable.");
  }
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength > MAX_IMAGE_SOURCE_BYTES) throw new Error("That image is too large to attach.");
  return attachments.registerImage({
    name: typeof name === "string" ? name : "",
    mediaType,
    bytes: Buffer.from(view),
  });
}

/**
 * Constructing a client reads the auth token from disk, and the renderer polls
 * the connection every few seconds, so the most recent client is kept. Caching
 * exactly one entry keeps the common case free without growing as the user
 * edits the endpoint in settings.
 */
let cachedClient: { endpoint: string; client: McpClient } | null = null;

function clientFor(endpoint: string): McpClient {
  if (cachedClient?.endpoint === endpoint) return cachedClient.client;
  const client = new McpClient({ endpoint, healthTimeoutMs: HEALTH_TIMEOUT_MS });
  cachedClient = { endpoint, client };
  return client;
}

// -- Local MCP bridge ------------------------------------------------------

/**
 * Where the bundled MCP bridge lives.
 *
 * A packaged build carries the server beside the app; a development checkout
 * runs the one in the workspace. `undefined` means this build has no bridge to
 * start, which is a real state rather than a crash: the app still works against
 * a bridge someone started themselves.
 */
function resolveMcpServerEntry(): string | undefined {
  const configured = process.env.WORKBENCH_MCP_SERVER_ENTRY?.trim();
  const candidates = configured
    ? [configured]
    : [
      path.join(process.resourcesPath, "mcp-server", "dist", "index.js"),
      path.join(__dirname, "..", "..", "..", "packages", "robloxstudio-mcp", "dist", "index.js"),
    ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

let mcpServer: McpServerProcess | undefined;
let mcpServerState: McpServerState = { kind: "stopped" };

function mcpServerProcess(): McpServerProcess | undefined {
  if (mcpServer) return mcpServer;
  const entry = resolveMcpServerEntry();
  if (entry === undefined) return undefined;

  const endpoint = DEFAULT_MCP_ENDPOINT;
  mcpServer = new McpServerProcess({
    endpoint,
    // The bridge is Node, and Electron already ships one. Running it through
    // this binary is what lets the app work on a machine with no Node
    // installed, which is every machine an installer will land on.
    //
    // `--auto-install-plugin` puts the Studio plugin in place, which is the
    // other half of a working install: the app cannot reach Studio without it,
    // and a customer should never have to install it by hand. The MCP package
    // owns that operation â€” it verifies the artifact's embedded version and
    // variant, writes it atomically under a lock, and does nothing when the
    // installed copy already matches â€” so Roqer asks for it rather than
    // reimplementing it. Running on every launch is what keeps the plugin in
    // step with an app update.
    //
    // The saved Open Cloud key and creator go in the environment, which is
    // where the bridge reads them and where, unlike its command line, other
    // processes cannot list them.
    spawnServer: () => spawn(process.execPath, [entry, "--auto-install-plugin"], {
      env: bridgeEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: "1" }, bridgeOpenCloud),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
    // The same operation on its own, for the case where a bridge is already
    // listening and Roqer adopts it rather than starting one. That bridge
    // belongs to someone else and may never have installed the plugin â€” a
    // developer's own session, or anything else holding the port â€” and without
    // this the app would run with no way to reach Studio and nothing said about
    // why.
    installPlugin: () => spawn(process.execPath, [entry, "--install-bundled-plugin"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
    probe: async (target) => (await clientFor(target).health()).reachable,
    onState: (state) => {
      mcpServerState = state;
      if (state.kind === "failed") console.error("Roqer could not run the Studio bridge:", state.message);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send("mcp:state", state);
      }
    },
    onOutput: (line) => void bridgeLog().write(line),
  });
  return mcpServer;
}

/** How long a restarted bridge is given for Studio's plugin to find it again. */
const PLUGIN_RECONNECT_WAIT_MS = 15_000;
const PLUGIN_RECONNECT_POLL_MS = 500;

/**
 * What a run gets to ask when a tool call found nothing at its endpoint.
 *
 * Only the bridge Roqer supervises can be recovered: a run pointed anywhere
 * else has nobody to ask, and gets nothing. After a restart the plugin needs a
 * few seconds to find the new bridge, and the run is held for them, so the
 * model's next call sees Studio rather than an empty instance list it would
 * have to explain.
 */
function bridgeRecoveryFor(endpoint: string): BridgeRecoveryHost | undefined {
  if (endpoint !== DEFAULT_MCP_ENDPOINT) return undefined;
  const server = mcpServerProcess();
  if (!server) return undefined;
  return {
    recover: async (): Promise<BridgeRecovery> => {
      const { state, restarted } = await server.recover();
      if (state.kind !== "running" && state.kind !== "adopted") {
        return { kind: "unavailable", message: mcpServerMessage(state) };
      }
      if (!restarted) return { kind: "answering" };
      const client = clientFor(endpoint);
      const deadline = Date.now() + PLUGIN_RECONNECT_WAIT_MS;
      let studioConnected = (await client.health()).pluginConnected;
      while (!studioConnected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PLUGIN_RECONNECT_POLL_MS));
        studioConnected = (await client.health()).pluginConnected;
      }
      return { kind: "restarted", studioConnected };
    },
  };
}

/**
 * Start the bridge without blocking startup. A window that opens while the
 * bridge is still coming up shows it as starting, which is the truth, rather
 * than waiting on a blank screen for a process that may never answer.
 */
function startMcpServer(): void {
  const server = mcpServerProcess();
  if (!server) {
    mcpServerState = {
      kind: "failed",
      message: "This build does not include the Studio bridge. Start one yourself to connect Studio.",
    };
    return;
  }
  void loadBridgeOpenCloud().then(() => server.start()).catch((error) => {
    mcpServerState = {
      kind: "failed",
      message: error instanceof Error ? error.message : "The Studio bridge could not be started.",
    };
  });
}

// -- Local Blender worker --------------------------------------------------

let blenderSettingsStore: BlenderSettings | null = null;

/** Whether the Blender worker is on, and which Blender it runs. */
function blenderSettings(): BlenderSettings {
  blenderSettingsStore ??= new BlenderSettings({ file: path.join(app.getPath("userData"), "blender.json") });
  return blenderSettingsStore;
}

/**
 * One approved Blender job. The engine has already classified and approved
 * it; this checks the worker is still on, then runs it in its own job folder
 * under Roqer's data folder. Its saved scene can be continued only by later
 * jobs in the same chat, so the chat is the worker's scope, hashed so the job
 * folders do not carry the chat's own id.
 */
async function runBlenderJob(args: Record<string, unknown>, options: McpCallOptions, chatId: string): Promise<McpToolOutcome> {
  const executable = await blenderSettings().ready().catch(() => undefined);
  if (executable === undefined) {
    const message = "Blender is turned off in Roqer's Settings, so the job did not run. Ask the user to turn it on, or build the asset from parts instead.";
    return { ok: false, data: undefined, text: message, httpStatus: 200, errorCode: "blender_off", message, durationMs: 0 };
  }
  const worker = new BlenderWorker({
    executable,
    jobsRoot: path.join(app.getPath("userData"), "blender-jobs"),
    scope: createHash("sha256").update(chatId).digest("hex").slice(0, 32),
  });
  return worker.run(args, options);
}

async function blenderResult(operation: () => Promise<BlenderSettingsView>): Promise<BlenderSettingsResult> {
  try {
    return { ok: true, settings: await operation() };
  } catch (error) {
    return storeFailure(error, "The Blender setting could not be changed.");
  }
}

function getBlenderSettings(event: IpcMainInvokeEvent): Promise<BlenderSettingsResult> {
  if (!isTrusted(event.sender)) return Promise.resolve({ ok: false, message: "This window may not read the Blender setting." });
  return blenderResult(() => blenderSettings().get());
}

function setBlenderEnabled(event: IpcMainInvokeEvent, enabled: unknown): Promise<BlenderSettingsResult> {
  if (!isTrusted(event.sender) || typeof enabled !== "boolean") {
    return Promise.resolve({ ok: false, message: "This window may not change the Blender setting." });
  }
  return blenderResult(() => blenderSettings().setEnabled(enabled));
}

/** The executable comes from the main process's own dialog, never from the renderer. */
async function chooseBlender(event: IpcMainInvokeEvent): Promise<BlenderSettingsResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not choose Blender." };
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Choose Blender",
    properties: ["openFile" as const],
    filters: process.platform === "win32" ? [{ name: "Blender", extensions: ["exe"] }] : [],
  };
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return blenderResult(() => blenderSettings().get());
  return blenderResult(() => blenderSettings().setExecutable(picked.filePaths[0]));
}

function redetectBlender(event: IpcMainInvokeEvent): Promise<BlenderSettingsResult> {
  if (!isTrusted(event.sender)) return Promise.resolve({ ok: false, message: "This window may not look for Blender." });
  return blenderResult(() => blenderSettings().redetect());
}

// -- Roblox Open Cloud -----------------------------------------------------

/** The saved Open Cloud settings, decrypted, as the next bridge Roqer starts receives them. */
let bridgeOpenCloud: OpenCloudResolved | undefined;
/** Settings changed while a run was using the bridge; restart it when the last run ends. */
let bridgeRestartPending = false;

async function loadBridgeOpenCloud(): Promise<void> {
  try {
    bridgeOpenCloud = await openCloud().resolve();
  } catch (error) {
    // Studio still works without Open Cloud; uploads report why they cannot.
    bridgeOpenCloud = undefined;
    console.error("Roqer could not read its Open Cloud settings for the Studio bridge:", error instanceof Error ? error.message : error);
  }
}

function openCloudBridgeUse(): OpenCloudBridgeUse {
  if (bridgeRestartPending) return "restart-pending";
  if (mcpServerState.kind === "adopted") return "adopted";
  if (mcpServerState.kind === "running") return "roqer";
  return "none";
}

/**
 * Put freshly saved settings into use. The bridge reads them only when it
 * starts, so a bridge Roqer runs is restarted -- never under a run, which would
 * lose its Studio calls, so then after the last run ends. A bridge somebody
 * else started keeps its own environment and is left alone.
 */
async function applyOpenCloudToBridge(): Promise<void> {
  await loadBridgeOpenCloud();
  if (mcpServer === undefined || (mcpServerState.kind !== "running" && mcpServerState.kind !== "starting")) return;
  if (runSessions.size > 0) {
    bridgeRestartPending = true;
    return;
  }
  await restartBridgeForOpenCloud();
}

async function restartBridgeForOpenCloud(): Promise<void> {
  bridgeRestartPending = false;
  const server = mcpServer;
  if (server === undefined || mcpServerState.kind === "adopted") return;
  await server.stop();
  await server.start();
}

async function openCloudSettingsResult(): Promise<OpenCloudSettingsResult> {
  const stored = await openCloud().get();
  const preserved = openCloud().takeDamagedNotice();
  return {
    ok: true,
    settings: {
      ...stored,
      bridge: openCloudBridgeUse(),
      ...(preserved === undefined
        ? {}
        : { damagedNotice: `Your saved Open Cloud settings could not be read and were set aside at ${preserved}. Enter them again.` }),
    },
  };
}

async function getOpenCloudSettings(event: IpcMainInvokeEvent): Promise<OpenCloudSettingsResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not read the Open Cloud settings." };
  try {
    return await openCloudSettingsResult();
  } catch (error) {
    return storeFailure(error, "Your Open Cloud settings could not be read.");
  }
}

async function saveOpenCloudSettings(event: IpcMainInvokeEvent, payload: unknown): Promise<OpenCloudSettingsResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not change the Open Cloud settings." };
  const parsed = parseOpenCloudSave(payload);
  if ("message" in parsed) return { ok: false, message: parsed.message };
  try {
    await openCloud().save(parsed.save);
  } catch (error) {
    return storeFailure(error, "Your Open Cloud settings could not be saved.");
  }
  try {
    await applyOpenCloudToBridge();
  } catch (error) {
    console.error("Roqer could not restart the Studio bridge with new Open Cloud settings:", error);
  }
  return openCloudSettingsResult().catch((error) => storeFailure(error, "Your Open Cloud settings could not be read."));
}

async function checkOpenCloudSettings(event: IpcMainInvokeEvent): Promise<OpenCloudCheckResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not check the Open Cloud key." };
  try {
    const { apiKey, creator } = await openCloud().resolve();
    if (apiKey === null) return { ok: false, message: "Save an Open Cloud key first." };
    return { ok: true, check: await checkOpenCloudKey({ apiKey, creator }) };
  } catch (error) {
    return storeFailure(error, "The Open Cloud key could not be checked.");
  }
}

// -- Application updates ---------------------------------------------------

/**
 * How often a long-running app looks for a new version. Roqer is the kind of
 * application someone leaves open for days, so a launch-only check would leave
 * them on an old build â€” and an old build means an old Studio plugin, since the
 * plugin ships inside the app.
 *
 * The first check runs once the window has drawn rather than on a timer. It
 * used to wait a fixed eight seconds, which with the check itself was ten
 * seconds of nothing after launch before a download began; nothing in startup
 * needed the wait, and the window's own first paint is the moment startup
 * contention is actually over.
 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let updateState: AppUpdateState = { kind: "idle" };
let updateTimer: NodeJS.Timeout | undefined;
/** Set by `startUpdates`; called by the first window once it has drawn. */
let checkForUpdatesNow: (() => void) | undefined;

/**
 * Whether this package was built against a release feed.
 *
 * electron-builder writes `app-update.yml` beside the app only when a publish
 * target is configured, and the updater reads its `url`. Checking first turns
 * "there is nowhere to check" into a plain statement rather than a recurring
 * error a user cannot act on â€” a build made without `ROQER_UPDATE_FEED_URL`
 * set should say so, not look broken.
 */
function hasUpdateFeed(): boolean {
  try {
    const configured = path.join(process.resourcesPath, "app-update.yml");
    const contents = fs.readFileSync(configured, "utf8");
    return /^\s*url:\s*\S+/m.test(contents);
  } catch {
    return false;
  }
}

function setUpdateState(state: AppUpdateState): void {
  updateState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send("update:state", state);
  }
}

/**
 * Wire the updater, unless this build has nothing to update from.
 *
 * A development run and a package built without a release feed are both
 * reported as unsupported rather than as errors: nothing is wrong, there is
 * simply nowhere to check.
 */
function startUpdates(): void {
  if (!app.isPackaged) {
    setUpdateState({ kind: "unsupported", message: "Development builds do not update themselves." });
    return;
  }
  if (!hasUpdateFeed()) {
    setUpdateState({
      kind: "unsupported",
      message: "This build has no update feed, so it will not update itself.",
    });
    return;
  }

  autoUpdater.autoDownload = true;
  // Staged rather than forced: an update installs when the user next quits, so
  // it never interrupts a run that is touching someone's place.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => setUpdateState({ kind: "checking" }));
  autoUpdater.on("update-not-available", () => setUpdateState({ kind: "idle" }));
  autoUpdater.on("update-available", (info) => {
    setUpdateState({ kind: "available", version: String(info.version) });
  });
  autoUpdater.on("download-progress", (progress) => {
    const version = updateState.kind === "available" || updateState.kind === "downloading"
      ? updateState.version
      : "";
    if (version === "") return;
    setUpdateState({ kind: "downloading", version, percent: Math.max(0, Math.min(100, progress.percent)) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({ kind: "ready", version: String(info.version) });
  });
  autoUpdater.on("error", (error) => {
    // The updater's own text can name a URL or a file path, so what reaches the
    // interface is Roqer's wording; the detail goes to the process log.
    console.error("Roqer could not check for updates", error);
    setUpdateState({ kind: "failed", message: "Roqer could not check for updates." });
  });

  const check = () => {
    void autoUpdater.checkForUpdates().catch(() => {
      // Already reported through the "error" event above.
    });
  };
  // Once, from the first window's paint; the timer only covers the hours
  // after. If the window somehow never reports, the interval still checks.
  checkForUpdatesNow = () => {
    checkForUpdatesNow = undefined;
    check();
  };
  updateTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  updateTimer.unref();
}

function chatGptProvider(): CodexAppServerClient {
  if (codexAppServer === null) {
    codexAppServer = new CodexAppServerClient({
      cwd: app.getPath("userData"),
      // Roqer's own Codex configuration and sign-in, never the user's ~/.codex.
      codexHome: path.join(app.getPath("userData"), "codex"),
    });
    // Ephemeral threads live in the app-server process; a new process has none of them.
    codexAppServer.onDisconnect(() => void codexThreads.closeAll());
  }
  return codexAppServer;
}

function claudeProvider(): ClaudeCodeClient {
  claudeCode ??= new ClaudeCodeClient({ cwd: app.getPath("userData") });
  return claudeCode;
}

/**
 * Sign-in hosts a provider CLI is allowed to send the user to. A vendor tool
 * that returns anything else is not opened: the address comes from a child
 * process, so it is checked before it reaches the user's browser.
 */
const SIGN_IN_HOSTS: Record<ProviderId, readonly string[]> = {
  chatgpt: ["chatgpt.com", "auth.openai.com"],
  claude: ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"],
  // Custom connections are configured in Settings; nothing is signed in to.
  custom: [],
};

/** A provider the renderer may ask about: only those this build offers. */
function providerArgument(value: unknown): ProviderId | null {
  return isEnabledProvider(value) ? value : null;
}

async function readProviderStatus(provider: ProviderId): Promise<ProviderStatus> {
  if (provider === "custom") {
    try {
      return customProviderStatus(await customProviders().list());
    } catch (error) {
      return { kind: "unavailable", message: error instanceof Error ? error.message : "Your model connections could not be read." };
    }
  }
  return provider === "claude"
    ? claudeProvider().getStatus()
    : chatGptProvider().getChatGptStatus();
}

async function readProviderCatalog(provider: ProviderId): Promise<ProviderModelCatalog> {
  if (provider === "custom") return customModelCatalog(await customProviders().list());
  return provider === "claude"
    ? claudeProvider().listModels()
    : chatGptProvider().listChatGptModels();
}

async function getProviderStatus(event: IpcMainInvokeEvent, value: unknown): Promise<ProviderStatus> {
  if (!isTrusted(event.sender)) return { kind: "unavailable", message: "This window may not access providers." };
  const provider = providerArgument(value);
  if (!provider) return { kind: "unavailable", message: "Unknown provider." };
  return readProviderStatus(provider);
}

async function getProviderModels(event: IpcMainInvokeEvent, value: unknown): Promise<ProviderModelCatalog> {
  if (!isTrusted(event.sender)) return { models: [], defaultModelId: null, message: "This window may not access models." };
  const provider = providerArgument(value);
  if (!provider) return { models: [], defaultModelId: null, message: "Unknown provider." };
  try {
    return await readProviderCatalog(provider);
  } catch (error) {
    return {
      models: [],
      defaultModelId: null,
      message: error instanceof Error
        ? error.message
        : `The ${providerLabel(provider)} model catalog is unavailable.`,
    };
  }
}

async function loginProvider(event: IpcMainInvokeEvent, value: unknown): Promise<ProviderLoginResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not start sign-in." };
  const provider = providerArgument(value);
  if (!provider) return { ok: false, message: "Unknown provider." };
  const label = providerLabel(provider);

  try {
    const current = await readProviderStatus(provider);
    if (current.kind === "signed-in") return { ok: true, message: current.message };
    if (provider === "custom") return { ok: false, message: current.message };

    // A new sign-in may be a different account; nothing it did not run may carry over.
    if (provider === "claude") await claudeSessions.closeAll();
    else await codexThreads.closeAll();
    const login = provider === "claude"
      ? await claudeProvider().beginLogin()
      : await chatGptProvider().beginChatGptLogin();
    const authUrl = new URL(login.authUrl);
    if (authUrl.protocol !== "https:" || !SIGN_IN_HOSTS[provider].includes(authUrl.hostname)) {
      return { ok: false, message: `${label} returned an unexpected sign-in address.` };
    }
    await shell.openExternal(authUrl.href);

    // Claude Code's flow hands the authorization code to a hosted page instead
    // of finishing in the browser, so the user has to bring the code back.
    return provider === "claude"
      ? { ok: true, message: "Sign in with Claude, then paste the code it gives you.", awaitingCode: true }
      : { ok: true, message: "Finish signing in with ChatGPT in your browser." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : `${label} sign-in could not start.` };
  }
}

async function submitProviderCode(event: IpcMainInvokeEvent, payload: unknown): Promise<ProviderLoginResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not finish sign-in." };
  if (!isRecord(payload) || providerArgument(payload.provider) !== "claude") {
    return { ok: false, message: "Unknown provider." };
  }
  if (typeof payload.code !== "string") return { ok: false, message: "Paste the code Claude gave you." };
  try {
    return await claudeProvider().submitLoginCode(payload.code);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Claude sign-in could not finish." };
  }
}

// -- Custom model connections ------------------------------------------------
//
// Configuration only: none of these runs anything in Studio. A run on a custom
// model goes through the same approvals as every other run.

function storeFailure(error: unknown, fallback: string): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : fallback };
}

/** The connections, plus a one-time note when a damaged file had to be set aside. */
async function customConnectionsResult(connections: Awaited<ReturnType<CustomProviderStore["list"]>>): Promise<CustomConnectionsResult> {
  const preserved = customProviders().takeDamagedNotice();
  return preserved === undefined
    ? { ok: true, connections }
    : { ok: false, message: `Your saved model connections could not be read and were set aside at ${preserved}. Add them again.` };
}

async function listCustomConnections(event: IpcMainInvokeEvent): Promise<CustomConnectionsResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not read model connections." };
  try {
    return await customConnectionsResult(await customProviders().list());
  } catch (error) {
    return storeFailure(error, "Your model connections could not be read.");
  }
}

async function saveCustomConnection(event: IpcMainInvokeEvent, payload: unknown): Promise<CustomConnectionsResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not change model connections." };
  const parsed = parseCustomConnectionSave(payload);
  if (!parsed.ok) return parsed;
  try {
    const connections = await customProviders().save(parsed.save);
    // A kept conversation holds its transport, key included. After an edit it
    // would not be continued anyway (see `customTransportKey`), so it goes now.
    void customConversations.closeAll();
    return { ok: true, connections };
  } catch (error) {
    return storeFailure(error, "The connection could not be saved.");
  }
}

async function removeCustomConnection(event: IpcMainInvokeEvent, id: unknown): Promise<CustomConnectionsResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not change model connections." };
  if (!isCustomConnectionId(id)) return { ok: false, message: "That connection was not valid." };
  try {
    const connections = await customProviders().remove(id);
    void customConversations.closeAll();
    return { ok: true, connections };
  } catch (error) {
    return storeFailure(error, "The connection could not be removed.");
  }
}

async function testCustomConnectionModel(event: IpcMainInvokeEvent, payload: unknown): Promise<CustomModelTestResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not test model connections." };
  if (!isRecord(payload) || !isCustomConnectionId(payload.connectionId) || !isCustomModelId(payload.modelId)) {
    return { ok: false, message: "That model was not valid." };
  }
  try {
    const resolved = await customProviders().resolve(payload.connectionId);
    if (resolved === undefined) return { ok: false, message: "That connection no longer exists." };
    const model = resolved.connection.models.find((entry) => entry.id === payload.modelId);
    if (model === undefined) return { ok: false, message: "Save the model before testing it." };
    return await testCustomModel({ connection: resolved.connection, model, apiKey: resolved.apiKey });
  } catch (error) {
    return storeFailure(error, "The model could not be tested.");
  }
}

async function importCustomModels(event: IpcMainInvokeEvent, connectionId: unknown): Promise<CustomModelImportResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not read model lists." };
  if (!isCustomConnectionId(connectionId)) return { ok: false, message: "That connection was not valid." };
  try {
    const resolved = await customProviders().resolve(connectionId);
    if (resolved === undefined) return { ok: false, message: "That connection no longer exists." };
    return await listEndpointModels(resolved.connection, resolved.apiKey);
  } catch (error) {
    return storeFailure(error, "The model list could not be read.");
  }
}

function clientAgentRuntime(): Promise<AgentRuntime> {
  agentRuntimePromise ??= loadAgentRuntime(path.join(__dirname, "agent"));
  return agentRuntimePromise;
}

type CustomRun = Readonly<{ connection: CustomConnection; model: CustomModel; apiKey: string | null }>;

/**
 * The connection, model, and decrypted key a custom run will use, read at the
 * moment the run starts so an edit in Settings a second ago is what runs.
 */
async function resolveCustomRun(modelKey: string | null): Promise<CustomRun | { message: string }> {
  const parsed = parseCustomModelKey(modelKey);
  if (parsed === null) return { message: "Choose one of your own models before starting." };
  let resolved: Awaited<ReturnType<CustomProviderStore["resolve"]>>;
  try {
    resolved = await customProviders().resolve(parsed.connectionId);
  } catch (error) {
    return { message: error instanceof Error ? error.message : "Your model connection could not be read." };
  }
  if (resolved === undefined) return { message: "That connection no longer exists. Choose another model." };
  const model = findCustomModel(resolved.connection, modelKey!);
  if (model === undefined) return { message: "That model is no longer in its connection. Choose another model." };
  return { connection: resolved.connection, model, apiKey: resolved.apiKey };
}

/** The agent that drives a run, chosen by the provider the user connected. */
function plannerFor(request: RunStartRequest, agentRuntime: AgentRuntime, runId: string, custom?: CustomRun, blender = false): Planner {
  const cwd = app.getPath("userData");
  // A conversation kept by one provider has not seen what another provider
  // does in the same chat, so a run on any other provider retires it.
  if (request.provider !== "claude") claudeSessions.drop(request.chatId);
  if (request.provider !== "chatgpt") codexThreads.drop(request.chatId);
  if (request.provider !== "custom") customConversations.drop(request.chatId);
  if (request.provider === "custom") {
    if (custom === undefined) throw new Error("Choose one of your own models before starting.");
    // Roqer's own loop, pointed at the user's endpoint: the same tools,
    // approvals, history bounds, and verification as every other run, with
    // requests going straight from this computer to that endpoint.
    return createAgentLoopPlanner({
      transport: createCustomTransport({ connection: custom.connection, model: custom.model, apiKey: custom.apiKey }),
      runId,
      modelId: custom.model.id,
      effort: request.effort,
      agent: agentRuntime.definition,
      skillLibrary: agentRuntime.skillLibrary,
      plannerId: "custom-endpoint",
      label: custom.connection.name,
      images: custom.model.images,
      toolOutputBudget: toolOutputBudgetFor(custom.model.contextWindow),
      ...(custom.model.contextWindow === undefined ? {} : { contextWindow: custom.model.contextWindow }),
      outputLimitAdvice: `Raise Max output for ${custom.model.displayName} in Settings → Your own models${
        custom.model.maxOutputTokens === undefined ? "" : ` (it is set to ${custom.model.maxOutputTokens.toLocaleString("en-US")})`
      }, then ask it to continue.`,
      blender,
      chatId: request.chatId,
      sessions: customConversations,
      transportKey: customTransportKey(custom),
    });
  }
  if (request.provider === "claude") {
    const client = claudeProvider();
    return createClaudePlanner({
      launcher: client,
      getStatus: () => client.getStatus(),
      cwd,
      model: request.model!,
      effort: request.effort,
      // The catalog was read to resolve this model moments ago, so the client
      // still holds the listing that says whether it takes an effort.
      supportsEffort: client.modelSupportsEffort(request.model!),
      agent: agentRuntime.definition,
      skillLibrary: agentRuntime.skillLibrary,
      chatId: request.chatId,
      sessions: claudeSessions,
      blender,
    });
  }
  return createChatGptPlanner({
    appServer: chatGptProvider(),
    cwd,
    model: request.model!,
    effort: request.effort,
    agent: agentRuntime.definition,
    skillLibrary: agentRuntime.skillLibrary,
    chatId: request.chatId,
    sessions: codexThreads,
    blender,
  });
}

async function getStudioStatus(_event: IpcMainInvokeEvent, endpointValue: unknown): Promise<StudioStatus> {
  const endpoint = typeof endpointValue === "string" && endpointValue !== ""
    ? endpointValue
    : DEFAULT_MCP_ENDPOINT;

  let client: McpClient;
  try {
    client = clientFor(endpoint);
  } catch (error) {
    const message = error instanceof McpEndpointError
      ? error.message
      : "The MCP endpoint could not be used.";
    return { kind: "offline", endpoint, message };
  }

  const health = await client.health();
  if (!health.reachable) {
    return { kind: "offline", endpoint: client.endpoint, message: health.message };
  }

  const first = health.instances[0];
  return {
    kind: health.pluginConnected ? "connected" : "bridge-only",
    endpoint: client.endpoint,
    placeName: first?.placeName || first?.dataModelName,
    instanceCount: health.instanceCount,
    serverVersion: health.serverVersion,
    mode: first?.isRunning ? "Playtest" : "Edit",
    message: health.pluginConnected ? "Studio connected" : "Waiting for Roblox Studio",
    instances: health.instances.map((instance) => ({
      instanceId: instance.instanceId,
      role: instance.role,
      placeName: instance.placeName ?? instance.dataModelName,
      isRunning: instance.isRunning,
    })),
  };
}

function parseOpenScriptRequest(value: unknown): OpenStudioScriptRequest | null {
  if (!isRecord(value)) return null;
  const { endpoint, target, instanceId } = value;
  if (typeof endpoint !== "string" || endpoint === "") return null;
  if (typeof target !== "string" || target === "" || target.length > 1_000) return null;
  if (instanceId !== null && (typeof instanceId !== "string" || instanceId === "")) return null;
  return { endpoint, target, instanceId };
}

async function openStudioScript(event: IpcMainInvokeEvent, value: unknown): Promise<StudioActionResult> {
  if (!isTrusted(event.sender)) return { ok: false, message: "This window may not control Studio." };
  const request = parseOpenScriptRequest(value);
  if (!request) return { ok: false, message: "The script target was not valid." };

  let client: McpClient;
  try {
    client = clientFor(request.endpoint);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof McpEndpointError ? error.message : "The MCP endpoint could not be used.",
    };
  }

  const outcome = await client.callTool("selection", {
    action: "open",
    path: request.target,
    ...(request.instanceId ? { instance_id: request.instanceId } : {}),
  });
  if (!outcome.ok) return { ok: false, message: outcome.message ?? "Studio could not open this script." };
  return { ok: true, message: "Opened in Studio." };
}

// -- Run channel -----------------------------------------------------------

const APPROVAL_MODES: readonly ApprovalMode[] = ["Ask first", "Auto approve", "Full auto", "Read only"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseStartRequest(value: unknown): RunStartRequest | null {
  if (!isRecord(value)) return null;
  const { projectId, chatId, prompt, conversation, approvalMode, autoPlaytest, endpoint, instanceId, provider, model, effort, startId, attachmentIds } = value;
  if (typeof projectId !== "string" || projectId === "" || projectId.length > 1_000) return null;
  if (typeof chatId !== "string" || chatId === "" || chatId.length > 1_000) return null;
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 64_000) return null;
  if (startId !== undefined && (typeof startId !== "string" || !/^[\w-]{1,100}$/.test(startId))) return null;
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 8 || !attachmentIds.every((id) => typeof id === "string" && id.length <= 100))) return null;
  if (!isConversationContext(conversation)) return null;
  if (!APPROVAL_MODES.includes(approvalMode as ApprovalMode)) return null;
  if (typeof autoPlaytest !== "boolean") return null;
  if (typeof endpoint !== "string" || endpoint === "") return null;
  if (instanceId !== null && typeof instanceId !== "string") return null;
  if (!isEnabledProvider(provider)) return null;
  if (model !== null && (typeof model !== "string" || model === "" || model.length > 100)) return null;
  if (!isReasoningEffort(effort)) return null;
  return {
    projectId,
    chatId,
    prompt,
    conversation,
    approvalMode: approvalMode as ApprovalMode,
    autoPlaytest,
    endpoint,
    instanceId,
    provider,
    model,
    effort,
    startId,
    attachmentIds,
  };
}

function isTrusted(sender: WebContents): boolean {
  return trustedSenders.has(sender.id);
}

type RunStartResult = { ok: true; runId: string } | { ok: false; message: string };

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise that cannot reject, for a read started before the code that awaits it. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}

async function startRun(event: IpcMainInvokeEvent, payload: unknown): Promise<RunStartResult> {
  if (!isTrusted(event.sender) || shuttingDown) return { ok: false, message: "This window may not start runs." };

  const request = parseStartRequest(payload);
  if (!request) return { ok: false, message: "The run request was not valid." };

  const sender = event.sender;
  const pending = pendingRuns.begin(sender.id, request.startId ?? randomUUID());
  const cancelled = () => pending.signal.aborted || shuttingDown || sender.isDestroyed() || !isTrusted(sender);
  const stopped: RunStartResult = { ok: false, message: "Run startup was cancelled." };
  let journalId: string | undefined;
  let executionStarted = false;
  try {
    await initializeStorage();
    if (cancelled()) return stopped;
    if (store().status().required) return { ok: false, message: "Recover your saved chats before starting a run." };
    // The vendor sign-in and the model catalog are independent reads that can
    // each wait on a provider process, so they run together. Their answers
    // are still taken in this order. The smoke run is driven by its own local
    // inspection planner and has no vendor sign-in by design, so it reads
    // neither.
    const catalogRead = smokeTest ? undefined : settle(readProviderCatalog(request.provider));
    if (!smokeTest) {
      const vendorStatus = await readProviderStatus(request.provider);
      if (cancelled()) return stopped;
      if (vendorStatus.kind !== "signed-in") {
        return { ok: false, message: vendorStatus.message };
      }
    }
    const attachmentContext = await attachments.context(request.attachmentIds ?? [], {
      images: !smokeTest,
    });
    if (cancelled()) return stopped;
    if (journalFailure) return { ok: false, message: journalFailure };

    let client: McpClient;
    try {
      client = clientFor(request.endpoint);
    } catch (error) {
      const message = error instanceof McpEndpointError
        ? error.message
        : "The MCP endpoint could not be used.";
      return { ok: false, message };
    }

    const label = providerLabel(request.provider);
    let resolvedRequest = request;
    if (catalogRead !== undefined) {
      const catalogResult = await catalogRead;
      if (!catalogResult.ok) {
        const { error } = catalogResult;
        return { ok: false, message: error instanceof Error ? error.message : `The ${label} model catalog is unavailable.` };
      }
      const catalog = catalogResult.value;
      if (cancelled()) return stopped;
      // A saved choice that is no longer in the catalog falls back to the
      // provider's default rather than refusing to start: a model can be
      // retired, and a stale preference is not a reason to block someone's work.
      const requested = request.model === null
        ? undefined
        : catalog.models.find((candidate) => candidate.id === request.model);
      const model = requested ??
        catalog.models.find((candidate) => candidate.id === catalog.defaultModelId) ??
        catalog.models[0];
      if (!model) {
        return {
          ok: false,
          message: catalog.message ?? `Choose an available ${label} model before starting.`,
        };
      }
      // The effort was chosen against a different model, so it is not the user's
      // choice to honour or refuse; take that model's own default instead.
      const effort = requested === undefined ? model.defaultReasoningEffort : request.effort;
      const supported = model.supportedReasoningEfforts.find((entry) => entry.reasoningEffort === effort);
      if (!supported) {
        return { ok: false, message: `${model.displayName} does not support the selected reasoning effort.` };
      }
      resolvedRequest = { ...request, model: model.id, effort };
    }

    const runId = `run-${randomUUID()}`;
    let agentRuntime: AgentRuntime;
    try {
      agentRuntime = await clientAgentRuntime();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Client instructions could not be loaded." };
    }
    if (cancelled()) return stopped;
    let customRun: CustomRun | undefined;
    if (!smokeTest && resolvedRequest.provider === "custom") {
      const resolved = await resolveCustomRun(resolvedRequest.model);
      if ("message" in resolved) return { ok: false, message: resolved.message };
      customRun = resolved;
      if (cancelled()) return stopped;
    }
    // The Blender tool is offered only when the user has it on and it answers;
    // the job itself checks again, so switching it off mid-run stops new jobs.
    const blender = !smokeTest && (await blenderSettings().ready().catch(() => undefined)) !== undefined;
    if (cancelled()) return stopped;
    const planner = smokeTest ? createInspectionPlanner() : plannerFor(resolvedRequest, agentRuntime, runId, customRun, blender);
    journalId = runId;
    await runJournal().start(runId, request, request.prompt, request.approvalMode);
    if (cancelled()) return stopped;
    journalRuns.add(runId);
    if (attachmentContext.text) {
      resolvedRequest = { ...resolvedRequest, prompt: `${request.prompt}\n\n${attachmentContext.text}` };
    }
    const session = new RunSession({
      caller: blender
        ? withLocalOperations(client, new Map([[BLENDER_OPERATION, (args, options) => runBlenderJob(args, options, request.chatId)]]))
        : client,
      bridge: bridgeRecoveryFor(client.endpoint),
      planner,
      request: { ...resolvedRequest, runId },
      images: attachmentContext.images,
      emit: (runEvent: RunEvent) => {
        runJournal().record(runEvent);
        if (runEvent.type === "run-completed") completedRuns.add(runId);
        if (!sender.isDestroyed()) sender.send("run:event", runEvent);
      },
    });

    runSessions.set(runId, session);
    // Driven from the session map rather than from one run, so a second run
    // finishing does not report the app idle while the first is still going.
    presence.setRunning(true);
    executionStarted = true;
    const execution = session.execute().finally(async () => {
      runSessions.delete(runId);
      presence.setRunning(runSessions.size > 0);
      if (runSessions.size === 0 && bridgeRestartPending) {
        void restartBridgeForOpenCloud().catch((error) => console.error("Roqer could not restart the Studio bridge with new Open Cloud settings:", error));
      }
      attachments.release(request.attachmentIds ?? []);
      if (discardedRuns.delete(runId)) {
        await runJournal().acknowledge([runId]);
        journalRuns.delete(runId);
        completedRuns.delete(runId);
      }
    });
    runExecutions.add(execution);
    void execution.finally(() => runExecutions.delete(execution)).catch((error) => console.error("Roqer run cleanup failed", error));

    return { ok: true, runId };
  } catch (error) {
    return { ok: false, message: cancelled() ? "Run startup was cancelled." : error instanceof Error ? error.message : "The run could not start." };
  } finally {
    pending.finish();
    if (!executionStarted) {
      attachments.release(request.attachmentIds ?? []);
      if (journalId) {
        await runJournal().acknowledge([journalId]).catch((error) => console.error("Roqer could not discard a run that never started", error));
        journalRuns.delete(journalId);
      }
    }
  }
}

function respondToRun(event: IpcMainInvokeEvent, payload: unknown): boolean {
  if (!isTrusted(event.sender) || !isRecord(payload)) return false;
  const { runId, callId, decision } = payload;
  if (typeof runId !== "string" || typeof callId !== "string") return false;
  if (decision !== "approved" && decision !== "rejected") return false;
  return runSessions.get(runId)?.resolveApproval(callId, decision) ?? false;
}

function answerRun(event: IpcMainInvokeEvent, payload: unknown): boolean {
  if (!isTrusted(event.sender) || !isRecord(payload)) return false;
  const { runId, callId, answerIndex } = payload;
  if (typeof runId !== "string" || typeof callId !== "string") return false;
  // The session validates the index against the options it actually offered.
  return runSessions.get(runId)?.resolveQuestion(callId, answerIndex) ?? false;
}

function steerRun(event: IpcMainInvokeEvent, payload: unknown): boolean {
  if (!isTrusted(event.sender) || !isRecord(payload)) return false;
  const { runId, text } = payload;
  if (typeof runId !== "string") return false;
  // The session bounds and normalizes the text, and refuses it once the run
  // has ended.
  return runSessions.get(runId)?.steer(text) ?? false;
}

function cancelRun(event: IpcMainInvokeEvent, payload: unknown): void {
  if (!isTrusted(event.sender) || !isRecord(payload)) return;
  const { runId } = payload;
  if (typeof runId !== "string") return;
  if (payload.discard === true) {
    if (runSessions.has(runId)) discardedRuns.add(runId);
    else void runJournal().acknowledge([runId]).catch((error) => console.error("Roqer could not discard a cancelled run", error));
  }
  runSessions.get(runId)?.cancel();
}

function cancelAllRuns(): void {
  pendingRuns.cancelAll();
  for (const session of runSessions.values()) session.cancel();
}

/** Wait for cancelled planners and host-owned Studio cleanup to settle. */
async function drainRunExecutions(): Promise<void> {
  await Promise.allSettled([...runExecutions]);
}

// -- Window ----------------------------------------------------------------

/**
 * Painted before the renderer has drawn anything. Read from the saved theme so
 * a light-theme user never sees a dark frame on startup, or the reverse, and
 * the same colour as the renderer's canvas so the first paint is not a seam.
 * Dark until a saved workspace says otherwise, which is the default the app
 * starts on.
 */
let windowBackground = "#15171b";

function savedTheme(state: unknown): "light" | "dark" | undefined {
  const preferences = isRecord(state) ? state.preferences : undefined;
  const theme = isRecord(preferences) ? preferences.theme : undefined;
  return theme === "light" || theme === "dark" ? theme : undefined;
}

/**
 * Native surfaces -- file dialogs, the Windows title bar -- take their colours
 * from the system unless told otherwise, which leaves them light beside a dark
 * Roqer. They follow the theme the user chose instead, whenever it is saved.
 */
function followTheme(theme: "light" | "dark" | undefined): void {
  if (theme !== undefined && nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
}

async function resolveWindowBackground(): Promise<string> {
  const state = await loadState().catch(() => null);
  const theme = savedTheme(state) ?? "dark";
  followTheme(theme);
  return theme === "light" ? "#f2f3f5" : "#15171b";
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: windowBackground,
    title: "Roqer",
    // Windows takes the multi-size application artwork from here for the
    // window and taskbar; macOS uses the bundle's own icon.
    icon: path.join(__dirname, "roqer-app-icon.ico"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Captured up front: by the time "closed" fires the BrowserWindow and its
  // webContents are destroyed, and touching either one throws.
  const senderId = window.webContents.id;
  trustedSenders.add(senderId);

  /**
   * A file dropped on the window is Electron's business, not the page's:
   * without this, missing the composer replaces the whole application with a
   * `file://` view of whatever was dropped, losing the unsaved message. The
   * composer's own drop handler is unaffected â€” it stops the event before it
   * ever reaches navigation.
   */
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => {
    if (!smokeTest) window.show();
    // The window is on screen: startup is over, and an update found now is
    // seen downloading in the sidebar rather than discovered later.
    checkForUpdatesNow?.();
  });
  window.on("closed", () => {
    trustedSenders.delete(senderId);
    // A window that is gone can no longer approve anything, so nothing it
    // started may keep touching Studio.
    cancelAllRuns();
    attachments.clear();
  });

  if (smokeTest) {
    runSmokeTest(window);
    // Exercise the real preload and main process without a second writer:
    // the application renderer hydrates and autosaves while the fixture is
    // deliberately writing its own workspace through the same bridge.
    void window.loadURL("data:text/html,<title>Roqer bridge smoke test</title>");
    return;
  }

  const devServer = process.env.WORKBENCH_DEV_SERVER_URL;
  if (devServer) {
    // Removing the application menu also removed its devtools accelerator, so
    // put F12 back for development runs only.
    window.webContents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && input.key === "F12") window.webContents.toggleDevTools();
    });
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

/**
 * Exercises the preload bridge for real: disk persistence, the Studio status
 * check, and a complete run over the IPC run channel. The run is pointed at a
 * dead loopback port on purpose â€” it proves the channel streams a well-ordered
 * event sequence and terminates without needing Roblox Studio installed.
 *
 * It then closes the window and quits normally rather than calling app.exit(),
 * so teardown is covered too. An earlier version exited straight from here and
 * reported success while the real app was throwing on close.
 */
function runSmokeTest(window: BrowserWindow): void {
  // Electron would otherwise swallow a shutdown exception into a dialog and
  // still exit cleanly, which is exactly how the teardown bug stayed hidden.
  process.on("uncaughtException", (error) => {
    console.error("WORKBENCH_SMOKE_FAILED uncaught-exception", error);
    process.exit(1);
  });

  const watchdog = setTimeout(() => {
    console.error("WORKBENCH_SMOKE_FAILED timeout");
    process.exit(1);
  }, 60_000);
  watchdog.unref();

  window.webContents.once("did-finish-load", async () => {
    try {
      const report = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.workbenchDesktop;
        if (!bridge?.storage?.load || !bridge?.storage?.flush || !bridge?.studio?.getStatus || !bridge?.studio?.openScript || !bridge?.providers?.chatGpt?.models || !bridge?.providers?.chatGpt?.status || !bridge?.runs?.start || !bridge?.assets?.attachImage) {
          return { ok: false, reason: "bridge-missing" };
        }

        const seed = ${JSON.stringify(createInitialWorkspace())};
        seed.projects[0].name = "Native persistence";
        await bridge.storage.save(seed);
        const loaded = await bridge.storage.load();
        if (loaded?.projects?.[0]?.name !== "Native persistence") return { ok: false, reason: "persistence" };
        bridge.storage.flush(loaded);
        const storageStatus = await bridge.storage.status();
        if (storageStatus.required) return { ok: false, reason: "storage-recovery" };

        // A real screenshot-sized picture across the real bridge: the renderer
        // holds only bytes, and the main process must come back with something
        // a model turn can carry plus the preview the chat will keep.
        const canvas = document.createElement("canvas");
        canvas.width = 2000;
        canvas.height = 1200;
        const paint = canvas.getContext("2d");
        paint.fillStyle = "#123456";
        paint.fillRect(0, 0, canvas.width, canvas.height);
        paint.fillStyle = "#ffffff";
        paint.fillRect(120, 120, 640, 420);
        const encoded = canvas.toDataURL("image/png").split(",")[1];
        const binary = atob(encoded);
        const pixels = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) pixels[index] = binary.charCodeAt(index);

        const attached = await bridge.assets.attachImage("smoke.png", "image/png", pixels.buffer);
        if (typeof attached?.id !== "string" || attached.path !== undefined) {
          return { ok: false, reason: "attach-image-handle" };
        }
        if (attached.mediaType !== "image/png" && attached.mediaType !== "image/jpeg") {
          return { ok: false, reason: "attach-image-media-type" };
        }
        if (!String(attached.thumbnailDataUrl ?? "").startsWith("data:image/jpeg;base64,")) {
          return { ok: false, reason: "attach-image-thumbnail" };
        }
        // Refusing a non-image is covered by the registry's own tests; asking
        // for it here would only print a rejected invoke into the smoke log.
        await bridge.assets.release([attached.id]);

        const studio = await bridge.studio.getStatus("http://127.0.0.1:58741");
        if (typeof studio?.kind !== "string") return { ok: false, reason: "studio-status" };

        const openResult = await bridge.studio.openScript({
          endpoint: "http://127.0.0.1:59999",
          target: "game.ServerScriptService.Main",
          instanceId: null,
        });
        if (typeof openResult?.ok !== "boolean" || typeof openResult?.message !== "string") {
          return { ok: false, reason: "studio-open-script" };
        }

        const events = [];
        const finished = new Promise((resolve) => {
          const stop = bridge.runs.subscribe((event) => {
            events.push(event);
            if (event.type === "run-completed") { stop(); resolve(); }
          });
          setTimeout(() => { stop(); resolve(); }, 15000);
        });

        // The smoke run never reaches a vendor: the main process gives it the
        // local inspection planner and skips the vendor sign-in, so this runs
        // on a machine with neither Codex nor Claude Code installed.
        const started = await bridge.runs.start({
          projectId: "smoke", chatId: "smoke",
          prompt: "Inspect this project and explain how it works",
          conversation: { messages: [], truncated: false },
          approvalMode: "Read only", autoPlaytest: false,
          endpoint: "http://127.0.0.1:59999", instanceId: null,
          provider: "chatgpt", model: null, effort: "medium",
        });
        if (!started?.ok) return { ok: false, reason: "run-start", message: started?.message };
        await finished;

        if (events.length < 2) return { ok: false, reason: "no-events" };
        if (events[0].type !== "run-started") return { ok: false, reason: "first-event" };
        if (events.at(-1).type !== "run-completed") return { ok: false, reason: "last-event" };
        for (let index = 0; index < events.length; index += 1) {
          if (events[index].seq !== index + 1) return { ok: false, reason: "seq" };
          if (events[index].runId !== started.runId) return { ok: false, reason: "run-id" };
        }
        // Leave a second run in flight on purpose and do not await it. The
        // window is closed moments later, so teardown has to cancel a live
        // session and emit its final events at a webContents that is already
        // gone, without throwing.
        bridge.runs.start({
          projectId: "smoke", chatId: "smoke",
          prompt: "Inspect this project and explain how it works",
          conversation: { messages: [], truncated: false },
          approvalMode: "Read only", autoPlaytest: false,
          endpoint: "http://127.0.0.1:59999", instanceId: null,
          provider: "chatgpt", model: null, effort: "medium",
        });

        return { ok: true, events: events.length, outcome: events.at(-1).outcome };
      })()`);

      if (!report?.ok) {
        console.error("WORKBENCH_SMOKE_FAILED", JSON.stringify(report));
        app.exit(1);
        return;
      }

      // The File/Edit/View/Window bar must stay gone off macOS.
      if (process.platform !== "darwin" && Menu.getApplicationMenu() !== null) {
        console.error("WORKBENCH_SMOKE_FAILED application-menu-present");
        app.exit(1);
        return;
      }
      console.log(`WORKBENCH_SMOKE_OK events=${report.events} outcome=${report.outcome}`);
      // The real teardown path: "closed" handlers, then the quit sequence.
      window.close();
      app.quit();
    } catch (error) {
      console.error("WORKBENCH_SMOKE_FAILED", error);
      app.exit(1);
    }
  });
}

app.whenReady().then(async () => {
  ipcMain.handle("workspace:load", (event) => {
    if (!isTrusted(event.sender)) throw new Error("This window may not load the workspace.");
    return loadState();
  });
  ipcMain.handle("workspace:status", async (event) => {
    if (!isTrusted(event.sender)) throw new Error("This window may not read storage status.");
    await initializeStorage();
    return store().status();
  });
  ipcMain.handle("assets:attach-image", attachImage);
  ipcMain.handle("update:state", (event) => {
    if (!isTrusted(event.sender)) throw new Error("This window may not read the update state.");
    return updateState;
  });
  ipcMain.handle("update:install", (event) => {
    if (!isTrusted(event.sender)) throw new Error("This window may not install updates.");
    if (updateState.kind !== "ready") return false;
    // Runs and their journals are drained by the ordinary quit sequence, which
    // this goes through: `quitAndInstall` closes windows and quits the app.
    shuttingDown = true;
    setImmediate(() => autoUpdater.quitAndInstall());
    return true;
  });
  ipcMain.handle("mcp:state", (event) => {
    if (!isTrusted(event.sender)) throw new Error("This window may not read the bridge state.");
    return mcpServerState;
  });
  ipcMain.handle("mcp:restart", async (event) => {
    if (!isTrusted(event.sender)) throw new Error("This window may not restart the bridge.");
    const server = mcpServerProcess();
    if (!server) return mcpServerState;
    await server.stop();
    return server.start();
  });
  ipcMain.handle("workspace:recover", recoverState);
  ipcMain.handle("workspace:export", exportState);
  ipcMain.handle("workspace:save", saveState);
  ipcMain.on("workspace:flush", flushState);
  ipcMain.handle("assets:pick", pickAsset);
  ipcMain.handle("assets:release", (event, ids: unknown) => {
    if (isTrusted(event.sender) && Array.isArray(ids) && ids.length <= 64 && ids.every((id) => typeof id === "string")) attachments.release(ids);
  });
  ipcMain.handle("studio:status", getStudioStatus);
  ipcMain.handle("studio:open-script", openStudioScript);
  ipcMain.handle("provider:status", getProviderStatus);
  ipcMain.handle("provider:models", getProviderModels);
  ipcMain.handle("provider:login", loginProvider);
  ipcMain.handle("provider:login-code", submitProviderCode);
  ipcMain.handle("custom-providers:list", listCustomConnections);
  ipcMain.handle("custom-providers:save", saveCustomConnection);
  ipcMain.handle("custom-providers:remove", removeCustomConnection);
  ipcMain.handle("custom-providers:test", testCustomConnectionModel);
  ipcMain.handle("custom-providers:import", importCustomModels);
  ipcMain.handle("open-cloud:get", getOpenCloudSettings);
  ipcMain.handle("open-cloud:save", saveOpenCloudSettings);
  ipcMain.handle("open-cloud:check", checkOpenCloudSettings);
  ipcMain.handle("blender:get", getBlenderSettings);
  ipcMain.handle("blender:set-enabled", setBlenderEnabled);
  ipcMain.handle("blender:choose", chooseBlender);
  ipcMain.handle("blender:redetect", redetectBlender);
  ipcMain.handle("run:start", startRun);
  ipcMain.handle("run:respond", respondToRun);
  ipcMain.handle("run:answer", answerRun);
  ipcMain.handle("run:steer", steerRun);
  ipcMain.handle("run:cancel", cancelRun);
  ipcMain.handle("run:cancel-start", (event, id: unknown) => {
    if (isTrusted(event.sender) && typeof id === "string") pendingRuns.cancel(event.sender.id, id);
  });
  ipcMain.handle("app:data-path", () => app.getPath("userData"));

  // Windows and Linux draw Electron's default File/Edit/View/Window menu inside
  // the window frame. Roqer has no use for it, so it is removed outright
  // rather than auto-hidden, which would still let Alt reveal it. macOS keeps
  // its menu: it lives in the system menu bar rather than the window, and is
  // where the standard Cmd+Q and clipboard accelerators come from.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);

  // The smoke test drives the bridge channel with its own fixtures and must not
  // spawn a real server, which would outlive the test's window.
  if (!smokeTest) {
    startMcpServer();
    startUpdates();
  }

  windowBackground = await resolveWindowBackground();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  shuttingDown = true;
  if (updateTimer) clearInterval(updateTimer);
  // Cleared before the window goes, so a closed Roqer does not leave "Building
  // in Roblox Studio" standing in a profile until Discord notices the socket.
  presence.dispose();
  cancelAllRuns();
  void claudeSessions.closeAll();
  void codexThreads.closeAll();
  void customConversations.closeAll();
  codexAppServer?.close();
  claudeCode?.close();
});

app.on("will-quit", (event) => {
  if (shutdownFinishedForQuit) return;
  event.preventDefault();
  if (waitingForShutdownBeforeQuit) return;
  waitingForShutdownBeforeQuit = true;
  void (async () => {
    await Promise.allSettled([drainStateWrites(), drainRunExecutions()]);
    await runJournal().drain();
    // Last, so a run still writing its journal keeps the bridge it is using.
    await mcpServer?.stop();
  })().catch((error) => console.error("Roqer could not finish saving run progress", error)).finally(() => {
    shutdownFinishedForQuit = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
