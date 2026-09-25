import { RunService } from "@rbxts/services";
import State from "./State";
import UI from "./UI";
import { cleanupEditBridgeArtifacts } from "./EvalBridges";
import QueryHandlers from "./handlers/QueryHandlers";
import PropertyHandlers from "./handlers/PropertyHandlers";
import BuildHandlers from "./handlers/BuildHandlers";
import ScriptHandlers from "./handlers/ScriptHandlers";
import MetadataHandlers from "./handlers/MetadataHandlers";
import TestHandlers from "./handlers/TestHandlers";
import AssetHandlers from "./handlers/AssetHandlers";
import CaptureHandlers from "./handlers/CaptureHandlers";
import InputHandlers from "./handlers/InputHandlers";
import LogHandlers from "./handlers/LogHandlers";
import SerializationHandlers from "./handlers/SerializationHandlers";
import MemoryHandlers from "./handlers/MemoryHandlers";
import SceneAnalysisHandlers from "./handlers/SceneAnalysisHandlers";
import BreakpointHandlers from "./handlers/BreakpointHandlers";
import ScriptProfilerHandlers from "./handlers/ScriptProfilerHandlers";
import MicroProfilerHandlers from "./handlers/MicroProfilerHandlers";
import GenerateModelHandlers from "./handlers/GenerateModelHandlers";
import EvalRuntimeHandlers from "./handlers/EvalRuntimeHandlers";
import UIInspectionHandlers from "./handlers/UIInspectionHandlers";
import UIInteractionHandlers from "./handlers/UIInteractionHandlers";
import ClientBroker from "./ClientBroker";
import ServerUrlSettings from "./ServerUrlSettings";
import PluginSession from "./PluginSession";
import StudioEventStream from "./StudioEventStream";
import {
	RequestPayload,
	ReadyResponse,
	StudioRequestEvent,
	StudioStatusEvent,
	TransportUpdate,
} from "../types";

let assignedRole: string | undefined;
let lastReadyInstanceId: string | undefined;

const initialRole = PluginSession.getRole();

type Handler = (data: Record<string, unknown>) => unknown;

const routeMap: Record<string, Handler> = {

    "/api/file-tree": QueryHandlers.getFileTree,
    "/api/search-files": QueryHandlers.searchFiles,
    "/api/place-info": QueryHandlers.getPlaceInfo,
    "/api/search-objects": QueryHandlers.searchObjects,
    "/api/instance-properties": QueryHandlers.getInstanceProperties,
    "/api/search-by-property": QueryHandlers.searchByProperty,
    "/api/class-info": QueryHandlers.getClassInfo,
    "/api/project-structure": QueryHandlers.getProjectStructure,
    "/api/grep-scripts": QueryHandlers.grepScripts,

    "/api/set-properties": PropertyHandlers.setProperties,
    "/api/build-instances": BuildHandlers.buildInstances,

	"/api/get-script-source": ScriptHandlers.getScriptSource,
	"/api/set-script-source": ScriptHandlers.setScriptSource,
	"/api/edit-script-lines": ScriptHandlers.editScriptLines,
	"/api/edit-script-batch": ScriptHandlers.editScriptBatch,
	"/api/insert-script-lines": ScriptHandlers.insertScriptLines,
	"/api/delete-script-lines": ScriptHandlers.deleteScriptLines,

	"/api/get-attributes": MetadataHandlers.getAttributes,
	"/api/get-selection": MetadataHandlers.getSelection,
	"/api/set-selection": MetadataHandlers.setSelection,
	"/api/open-script": MetadataHandlers.openScript,
	"/api/focus-viewport": MetadataHandlers.focusViewport,
	"/api/execute-luau": MetadataHandlers.executeLuau,
	"/api/eval-runtime": EvalRuntimeHandlers.evalRuntime,

	"/api/start-playtest": TestHandlers.startPlaytest,
	"/api/stop-playtest": TestHandlers.stopPlaytest,
	"/api/multiplayer-test-start": TestHandlers.multiplayerTestStart,
	"/api/multiplayer-test-state": TestHandlers.multiplayerTestState,
	"/api/multiplayer-test-add-players": TestHandlers.multiplayerTestAddPlayers,
	"/api/multiplayer-test-leave-client": TestHandlers.multiplayerTestLeaveClient,
	"/api/multiplayer-test-end": TestHandlers.multiplayerTestEnd,

    "/api/insert-asset": AssetHandlers.insertAsset,
	"/api/preview-asset": AssetHandlers.previewAsset,

	"/api/capture-screenshot": CaptureHandlers.captureScreenshot,
	"/api/capture-begin": CaptureHandlers.captureBegin,
	"/api/capture-read": CaptureHandlers.captureRead,
	"/api/simulate-mouse-input": InputHandlers.simulateMouseInput,
	"/api/simulate-keyboard-input": InputHandlers.simulateKeyboardInput,
	"/api/inspect-ui": UIInspectionHandlers.inspectUi,
	"/api/interact-ui": UIInteractionHandlers.interactUi,

	"/api/find-and-replace-in-scripts": ScriptHandlers.findAndReplaceInScripts,

	"/api/get-runtime-logs": LogHandlers.getRuntimeLogs,
	"/api/breakpoints": BreakpointHandlers.breakpoints,
	"/api/capture-script-profiler": ScriptProfilerHandlers.captureScriptProfiler,
	"/api/capture-micro-profiler": MicroProfilerHandlers.captureMicroProfiler,
	"/api/generate-model": GenerateModelHandlers.generateModel,

	"/api/export-rbxm": SerializationHandlers.exportRbxm,
	"/api/import-rbxm": SerializationHandlers.importRbxm,

	"/api/get-memory-breakdown": MemoryHandlers.getMemoryBreakdown,
	"/api/get-scene-analysis": SceneAnalysisHandlers.getSceneAnalysis,
};

/**
 * What the inspector build answers. Its promise is that the DataModel stays
 * read-only, and the plugin is where that is privileged, so the build refuses
 * every other endpoint itself rather than trusting whichever server it is
 * talking to. An endpoint added later is refused here until it is listed.
 *
 * `/api/execute-luau` is the exception that keeps this from being the whole
 * promise: the inspector's `get_simulation_state` and
 * `get_device_simulator_state` read through fixed Luau snippets, so it has to
 * be answered. Giving those two reads endpoints of their own would let it go.
 *
 * `core/src/__tests__/inspector-endpoints.test.ts` checks this list against
 * what the inspector's tools actually send.
 */
const INSPECTOR_ENDPOINTS = new Set<string>([
	"/api/file-tree",
	"/api/search-files",
	"/api/place-info",
	"/api/search-objects",
	"/api/instance-properties",
	"/api/search-by-property",
	"/api/class-info",
	"/api/project-structure",
	"/api/grep-scripts",
	"/api/get-script-source",
	"/api/get-attributes",
	"/api/get-selection",
	"/api/set-selection",
	"/api/open-script",
	"/api/focus-viewport",
	"/api/execute-luau",
	"/api/multiplayer-test-state",
	"/api/preview-asset",
	"/api/capture-screenshot",
	"/api/capture-begin",
	"/api/capture-read",
	"/api/inspect-ui",
	"/api/get-runtime-logs",
	"/api/capture-script-profiler",
	"/api/capture-micro-profiler",
	"/api/export-rbxm",
	"/api/get-memory-breakdown",
	"/api/get-scene-analysis",
]);

function processRequest(request: RequestPayload): unknown {
	const endpoint = request.endpoint;
	const data = request.data ?? {};

	if (State.PLUGIN_VARIANT === "inspector" && !INSPECTOR_ENDPOINTS.has(endpoint)) {
		return { error: `The read-only Roqer Inspector plugin does not run ${endpoint}.` };
	}

	const handler = routeMap[endpoint];
	if (handler) {
		return handler(data as Record<string, unknown>);
	} else {
		return { error: `Unknown endpoint: ${endpoint}` };
	}
}

function getConnectionStatus(): string {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return "disconnected";
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) return "error";
	if (conn.lastHttpOk) return "connected";
	return "connecting";
}

function dispatchStreamRequest(request: StudioRequestEvent): unknown {
	if (request.logicalSessionId !== PluginSession.id) {
		return ClientBroker.dispatchClientRequest(
			request.logicalSessionId,
			request.target,
			request.endpoint,
			request.data,
		);
	}
	const localRole = assignedRole ?? PluginSession.getRole();
	if (request.target !== localRole) {
		return {
			error: `Physical plugin session is registered as ${localRole}, not ${request.target}.`,
		};
	}
	return processRequest({ endpoint: request.endpoint, data: request.data });
}

function handleReady(response: ReadyResponse): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	assignedRole = response.assignedRole;
	lastReadyInstanceId = response.instanceId;
	ServerUrlSettings.rememberServerUrl(conn.serverUrl);
	ClientBroker.refreshAllLogicalRegistrations();
}

function handleStatus(status: StudioStatusEvent): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	conn.lastHttpOk = true;
	conn.lastMcpOk = status.mcpConnected;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	if (status.mcpConnected) {
		conn.mcpWaitStartTime = undefined;
	} else if (conn.mcpWaitStartTime === undefined) {
		conn.mcpWaitStartTime = tick();
	}


	UI.updateUIState();
	UI.updateToolbarIcon();
}

function handleHeartbeat(_timestamp: number): void {
	if (!State.getActiveConnection().isActive) return;
	UI.updateUIState();
}

function handleTransportUpdate(update: TransportUpdate): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;

	if (update.state === "open") {
		conn.lastHttpOk = true;
		conn.lastMcpOk = false;
		conn.consecutiveFailures = 0;
		conn.currentRetryDelay = 0.5;
		conn.mcpWaitStartTime = tick();
		conn.lastTransportDetail = undefined;
	} else {
		conn.lastHttpOk = false;
		conn.lastMcpOk = false;
		conn.consecutiveFailures = update.attempt;
		if (update.retryDelay > 0) conn.currentRetryDelay = update.retryDelay;
		conn.mcpWaitStartTime = undefined;
		// "connecting" carries no detail; the last failure's reason is kept
		// through it so the panel does not blank between attempts.
		if (update.detail !== undefined) conn.lastTransportDetail = update.detail;
	}

	UI.updateUIState();
	UI.updateToolbarIcon();
	if (update.state === "waiting-duplicate") {
		const ui = UI.getElements();
		ui.statusLabel.Text = "Already active";
		ui.statusLabel.TextColor3 = Color3.fromRGB(210, 164, 81);
		ui.detailStatusLabel.Text = "Another Studio window is linked";
		ui.detailStatusLabel.TextColor3 = Color3.fromRGB(210, 164, 81);
	}
}

let nameChangeConn: RBXScriptConnection | undefined;
let placeIdChangeConn: RBXScriptConnection | undefined;

function ensureIdentityWatchers(): void {
	if (!nameChangeConn) {
		const [signalOk, signal] = pcall(() => game.GetPropertyChangedSignal("Name"));
		if (signalOk && signal) {
			nameChangeConn = signal.Connect(() => StudioEventStream.refresh());
		}
	}
	if (!placeIdChangeConn) {
		const [signalOk, signal] = pcall(() => game.GetPropertyChangedSignal("PlaceId"));
		if (signalOk && signal) {
			placeIdChangeConn = signal.Connect(() => {
				PluginSession.invalidatePlaceName();
				lastReadyInstanceId = PluginSession.getInstanceId();
				StudioEventStream.refresh();
			});
		}
	}
}

function disconnectIdentityWatchers(): void {
	if (nameChangeConn) {
		nameChangeConn.Disconnect();
		nameChangeConn = undefined;
	}
	if (placeIdChangeConn) {
		placeIdChangeConn.Disconnect();
		placeIdChangeConn = undefined;
	}
}


function activatePlugin() {
	const conn = State.getActiveConnection();
	if (conn.isActive) return;
	const ui = UI.getElements();

	conn.isActive = true;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	conn.lastHttpOk = false;
	conn.lastMcpOk = false;
	conn.mcpWaitStartTime = undefined;

	const normalizedUrl = ServerUrlSettings.normalizeServerUrl(ui.urlInput.Text);
	conn.serverUrl = normalizedUrl !== "" ? normalizedUrl : conn.serverUrl;
	if (conn.serverUrl === "") conn.serverUrl = ClientBroker.DEFAULT_MCP_URL;
	ui.urlInput.Text = conn.serverUrl;
	const port = ServerUrlSettings.extractPort(conn.serverUrl);
	if (port !== undefined) conn.port = port;
	ClientBroker.setServerUrl(conn.serverUrl);
	lastReadyInstanceId = PluginSession.getInstanceId();
	UI.updateUIState();

	StudioEventStream.start({
		serverUrl: conn.serverUrl,
		dispatchRequest: dispatchStreamRequest,
		onStatus: handleStatus,
		onHeartbeat: handleHeartbeat,
		onReady: handleReady,
		onTransportUpdate: handleTransportUpdate,
	});

	if (!conn.heartbeatConnection) {
		conn.heartbeatConnection = RunService.Heartbeat.Connect(() => {
			if (initialRole === "server" && !RunService.IsRunning()) {
				ClientBroker.disconnectAllProxies();
				deactivatePlugin();
				return;
			}
			const currentInstanceId = PluginSession.getInstanceId();
			if (lastReadyInstanceId !== undefined && currentInstanceId !== lastReadyInstanceId) {
				lastReadyInstanceId = currentInstanceId;
				PluginSession.invalidatePlaceName();
				StudioEventStream.refresh();
			}
		});
	}

	if (!RunService.IsRunning()) {
		task.spawn(cleanupEditBridgeArtifacts);
	}
	ensureIdentityWatchers();
}

function deactivatePlugin() {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	conn.isActive = false;
	conn.lastHttpOk = false;
	conn.lastMcpOk = false;
	conn.mcpWaitStartTime = undefined;

	StudioEventStream.stop();
	disconnectIdentityWatchers();
	if (initialRole === "server") ClientBroker.disconnectAllProxies();
	if (conn.heartbeatConnection) {
		conn.heartbeatConnection.Disconnect();
		conn.heartbeatConnection = undefined;
	}

	lastReadyInstanceId = undefined;
	assignedRole = undefined;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	UI.updateUIState();
}

function deactivateAll() {
	const conn = State.getActiveConnection();
	if (conn.isActive) {
		deactivatePlugin();
	}
}

export = {
	getConnectionStatus,
	activatePlugin,
	deactivatePlugin,
	deactivateAll,
};
