import { HttpService } from "@rbxts/services";
import HttpDiagnostics from "./HttpDiagnostics";
import PluginSession from "./PluginSession";
import {
	ReadyResponse,
	StudioRequestEvent,
	StudioStatusEvent,
	TransportUpdate,
} from "../types";

const INITIAL_RECONNECT_DELAY_SECONDS = 0.5;
const MAX_RECONNECT_DELAY_SECONDS = 5;
const INITIAL_RESPONSE_RETRY_DELAY_SECONDS = 0.5;
const MAX_RESPONSE_RETRY_DELAY_SECONDS = 5;
const MAX_TERMINAL_RESPONSES = 256;
// The bridge heartbeats every 10 seconds. A bound of 20 was one late frame
// away from a reconnect: a stalled Studio main thread, a large read, or a
// playtest starting could hold the plugin past two beats and read as a lost
// connection. A stream that actually dies is closed by the socket, which the
// Closed event reports at once; this bound only catches a half-open one, and
// for that a longer wait costs nothing.
const STREAM_SILENCE_TIMEOUT_SECONDS = 45;


interface StudioEventStreamOptions {
	serverUrl: string;
	dispatchRequest: (request: StudioRequestEvent) => unknown;
	onStatus: (status: StudioStatusEvent) => void;
	onHeartbeat: (timestamp: number) => void;
	onReady: (response: ReadyResponse) => void;
	onTransportUpdate: (update: TransportUpdate) => void;
}

type DecodedEvent =
	| StudioRequestEvent
	| StudioStatusEvent
	| { kind: "heartbeat"; timestamp: number };

type ResponseDisposition = "accepted" | "already_settled" | "unknown";

interface PendingResponse {
	body: string;
	retryAttempt: number;
	posting: boolean;
	retryToken: number;
}

let options: StudioEventStreamOptions | undefined;
let active = false;
let generation = 0;
let reconnectAttempt = 0;
let streamClient: WebStreamClient | undefined;
let streamConnections: RBXScriptConnection[] = [];
let lastValidEventAt = 0;
const inFlightRequestIds = new Set<string>();
const pendingResponses = new Map<string, PendingResponse>();
const terminalResponseIds = new Set<string>();
const terminalResponseOrder: string[] = [];
const readyFailureLogKeys = new Set<string>();

/**
 * Pieces of an event the bridge sent in chunks, by chunk id, until the last
 * piece arrives. Studio's SSE client delivers about 16 KB per read, so the
 * bridge never sends a frame near that: a big request comes as `chunk`
 * frames, each well inside one read, and is joined back here once
 * `takeStreamFrames` has separated them.
 */
interface PendingChunks {
	pieces: Map<number, string>;
	count: number;
	startedAt: number;
}

const pendingChunks = new Map<string, PendingChunks>();
const MAX_PENDING_CHUNK_SETS = 8;
const PENDING_CHUNK_TTL_SECONDS = 60;

/** Join a chunk into its set; the whole event's JSON once the set is complete. */
function joinChunk(envelope: Record<string, unknown>): string | undefined {
	const { id, index, count, data } = envelope;
	if (!typeIs(id, "string") || !typeIs(index, "number") || !typeIs(count, "number") || !typeIs(data, "string")) {
		return undefined;
	}
	if (count < 1 || index < 0 || index >= count) return undefined;

	const now = tick();
	for (const [staleId, stale] of pendingChunks) {
		if (now - stale.startedAt > PENDING_CHUNK_TTL_SECONDS) pendingChunks.delete(staleId);
	}
	let pending = pendingChunks.get(id);
	if (pending === undefined) {
		if (pendingChunks.size() >= MAX_PENDING_CHUNK_SETS) return undefined;
		pending = { pieces: new Map(), count, startedAt: now };
		pendingChunks.set(id, pending);
	}
	pending.pieces.set(index, data);
	if (pending.pieces.size() < pending.count) return undefined;

	pendingChunks.delete(id);
	const parts: string[] = [];
	for (let i = 0; i < pending.count; i++) {
		const piece = pending.pieces.get(i);
		if (piece === undefined) return undefined;
		parts.push(piece);
	}
	return parts.join("");
}

/**
 * Stream bytes that did not end on an event boundary, kept for the read that
 * completes them. Per connection; cleared when one is opened.
 */
let streamRemainder = "";
/** More than this waiting for a boundary is not a slow read; it is not a stream we understand. */
const MAX_STREAM_REMAINDER_BYTES = 256 * 1024;

/**
 * The payload of one SSE frame: the text after `data:`, trimmed. A frame that
 * was delivered already stripped -- some Studio versions surface the payload
 * rather than the line -- is returned as it is.
 */
function framePayload(frame: string): string {
	const trimmed = frame.gsub("^%s+", "")[0].gsub("%s+$", "")[0];
	if (trimmed.sub(1, 5) === "data:") {
		return trimmed.sub(6).gsub("^%s+", "")[0];
	}
	return trimmed;
}

function decodeJsonTable(text: string): Record<string, unknown> | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(text));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	return decoded as Record<string, unknown>;
}

/**
 * Split what the stream delivered into complete frames.
 *
 * Studio's stream client hands over what each socket read returned, not one
 * event per message: an event past about 16 KB arrives in two pieces, and two
 * events the bridge wrote together arrive as one. The bridge sends a large
 * request as chunk frames written in one go, which is exactly the second
 * case -- a 15 KB write came as one 15,515-byte message holding both of its
 * frames, and decoding it as one frame discarded the request. So the
 * messages are a byte stream: they are split here on the blank line that
 * ends an SSE event, whatever the read boundaries were, and a piece left over
 * waits for the read that completes it. A message that is a whole payload
 * with no terminator, which some Studio versions deliver, is taken as it is
 * once it decodes.
 */
function takeStreamFrames(message: string): string[] {
	const combined = (streamRemainder + message).gsub("\r\n", "\n")[0].gsub("\r", "\n")[0];
	const frames: string[] = [];
	let start = 1;
	while (true) {
		const [boundary] = string.find(combined, "\n\n", start, true);
		if (boundary === undefined) break;
		const segment = string.sub(combined, start, boundary - 1);
		start = boundary + 2;
		if (segment.gsub("%s", "")[0] !== "") frames.push(segment);
	}
	const tail = string.sub(combined, start);
	if (tail.gsub("%s", "")[0] === "") {
		streamRemainder = "";
	} else if (decodeJsonTable(framePayload(tail)) !== undefined) {
		// Complete without its terminator: either the client stripped the
		// framing, or the blank line is in the next read, where it will be
		// skipped as an empty segment.
		frames.push(tail);
		streamRemainder = "";
	} else if (tail.size() > MAX_STREAM_REMAINDER_BYTES) {
		warn(`[robloxstudio-mcp] Discarded ${tostring(tail.size())} bytes of stream data that never completed a frame.`);
		streamRemainder = "";
	} else {
		streamRemainder = tail;
	}
	return frames;
}

function decodeMessage(message: string): DecodedEvent | undefined {
	const payload = framePayload(message);
	let [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(payload));
	if (!decodeOk || !typeIs(decoded, "table")) {
		// Said out loud, because a message dropped here leaves no other trace:
		// the request is never dispatched, no response is ever posted, and the
		// caller waits out its timeout against a plugin that never heard it.
		// An oversized event failed exactly this way and looked like a hang.
		warn(`[robloxstudio-mcp] Discarded an unreadable stream message (${tostring(payload.size())} bytes).`);
		return undefined;
	}
	let envelope = decoded as Record<string, unknown>;

	if (envelope.kind === "chunk") {
		const whole = joinChunk(envelope);
		if (whole === undefined) return undefined;
		[decodeOk, decoded] = pcall(() => HttpService.JSONDecode(whole));
		if (!decodeOk || !typeIs(decoded, "table")) {
			warn(`[robloxstudio-mcp] Discarded an unreadable chunked stream message (${tostring(whole.size())} bytes).`);
			return undefined;
		}
		envelope = decoded as Record<string, unknown>;
	}

	if (envelope.kind === "heartbeat") {
		if (!typeIs(envelope.timestamp, "number")) return undefined;
		return { kind: "heartbeat", timestamp: envelope.timestamp };
	}

	if (envelope.kind === "status") {
		if (!typeIs(envelope.knownInstance, "boolean") || !typeIs(envelope.mcpConnected, "boolean")) {
			return undefined;
		}
		return {
			kind: "status",
			knownInstance: envelope.knownInstance,
			mcpConnected: envelope.mcpConnected,
			serverVersion: typeIs(envelope.serverVersion, "string") ? envelope.serverVersion : undefined,
			pluginVersion: typeIs(envelope.pluginVersion, "string") ? envelope.pluginVersion : undefined,
			pluginVariant: typeIs(envelope.pluginVariant, "string") ? envelope.pluginVariant : undefined,
		};
	}

	if (envelope.kind === "request") {
		if (
			!typeIs(envelope.requestId, "string") ||
			!typeIs(envelope.logicalSessionId, "string") ||
			!typeIs(envelope.target, "string") ||
			!typeIs(envelope.endpoint, "string")
		) {
			return undefined;
		}
		let data: Record<string, unknown> | undefined;
		if (typeIs(envelope.data, "table")) {
			data = envelope.data as Record<string, unknown>;
		}
		return {
			kind: "request",
			requestId: envelope.requestId,
			logicalSessionId: envelope.logicalSessionId,
			target: envelope.target,
			endpoint: envelope.endpoint,
			data,
		};
	}

	return undefined;
}

function closeCurrentStream(): void {
	const current = streamClient;
	streamClient = undefined;
	for (const connection of streamConnections) {
		connection.Disconnect();
	}
	streamConnections = [];
	if (current !== undefined) {
		pcall(() => current.Close());
	}
}

function responseRetryDelay(attempt: number): number {
	return math.min(
		INITIAL_RESPONSE_RETRY_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)),
		MAX_RESPONSE_RETRY_DELAY_SECONDS,
	);
}

function parseResponseDisposition(success: boolean, body: string): ResponseDisposition | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const acknowledgement = decoded as Record<string, unknown>;
	const disposition = acknowledgement.disposition;
	if (
		disposition === "accepted" ||
		disposition === "already_settled" ||
		disposition === "unknown"
	) {
		return disposition;
	}
	if (success && acknowledgement.success === true && disposition === undefined) {
		return "accepted";
	}
	return undefined;
}

function rememberTerminalResponse(requestId: string): void {
	if (terminalResponseIds.has(requestId)) return;
	terminalResponseIds.add(requestId);
	terminalResponseOrder.push(requestId);
	while (terminalResponseOrder.size() > MAX_TERMINAL_RESPONSES) {
		const oldest = terminalResponseOrder.shift();
		if (oldest !== undefined) terminalResponseIds.delete(oldest);
	}
}

function settleResponse(
	requestId: string,
	entry: PendingResponse,
	disposition: ResponseDisposition,
): void {
	if (pendingResponses.get(requestId) !== entry) return;
	pendingResponses.delete(requestId);
	rememberTerminalResponse(requestId);
	if (disposition === "unknown") {
		warn(
			`[robloxstudio-mcp] Server no longer recognizes response ${requestId}; dropping stored result`,
		);
	}
}

function postPendingResponse(requestId: string, entry: PendingResponse): void {
	const currentOptions = options;
	if (
		!active ||
		currentOptions === undefined ||
		pendingResponses.get(requestId) !== entry ||
		entry.posting
	) {
		return;
	}
	entry.posting = true;
	entry.retryToken++;

	task.spawn(() => {
		if (
			!active ||
			options !== currentOptions ||
			pendingResponses.get(requestId) !== entry
		) {
			entry.posting = false;
			return;
		}
		const responseUrl = `${currentOptions.serverUrl}/response`;
		const [requestOk, requestResult] = pcall(() =>
			HttpService.RequestAsync({
				Url: responseUrl,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: entry.body,
			}),
		);
		if (pendingResponses.get(requestId) !== entry) return;
		entry.posting = false;

		let failure: string;
		if (!requestOk) {
			failure = HttpDiagnostics.formatRequestFailure(responseUrl, false, requestResult);
		} else {
			const disposition = parseResponseDisposition(requestResult.Success, requestResult.Body);
			if (disposition !== undefined) {
				settleResponse(requestId, entry, disposition);
				return;
			}
			failure = requestResult.Success
				? "Invalid /response acknowledgement"
				: HttpDiagnostics.formatRequestFailure(responseUrl, true, requestResult);
		}

		warn(`[robloxstudio-mcp] Failed to deliver response ${requestId}: ${failure}`);
		entry.retryAttempt++;
		if (!active || pendingResponses.get(requestId) !== entry) return;
		const retryToken = ++entry.retryToken;
		const delay = responseRetryDelay(entry.retryAttempt);
		task.delay(delay, () => {
			if (
				!active ||
				pendingResponses.get(requestId) !== entry ||
				entry.retryToken !== retryToken
			) {
				return;
			}
			postPendingResponse(requestId, entry);
		});
	});
}

function resumePendingResponses(): void {
	for (const [requestId, entry] of pendingResponses) {
		postPendingResponse(requestId, entry);
	}
}

function encodeResponse(requestId: string, response: unknown): string {
	const [encodeOk, encoded] = pcall(() => HttpService.JSONEncode({ requestId, response }));
	if (encodeOk) return encoded;
	warn(`[robloxstudio-mcp] Failed to serialize response ${requestId}: ${tostring(encoded)}`);
	return HttpService.JSONEncode({
		requestId,
		error: `Plugin response serialization failed: ${tostring(encoded)}`,
	});
}

function dispatchRequest(request: StudioRequestEvent): void {
	if (
		terminalResponseIds.has(request.requestId) ||
		pendingResponses.has(request.requestId) ||
		inFlightRequestIds.has(request.requestId)
	) {
		return;
	}
	const dispatchOptions = options;
	if (!active || dispatchOptions === undefined) return;
	inFlightRequestIds.add(request.requestId);

	task.spawn(() => {
		const [dispatchOk, response] = pcall(() => dispatchOptions.dispatchRequest(request));
		const responseData = dispatchOk ? response : { error: tostring(response) };
		const entry: PendingResponse = {
			body: encodeResponse(request.requestId, responseData),
			retryAttempt: 0,
			posting: false,
			retryToken: 0,
		};
		pendingResponses.set(request.requestId, entry);
		inFlightRequestIds.delete(request.requestId);
		postPendingResponse(request.requestId, entry);
	});
}

function invokeCallback(name: string, callback: () => void): void {
	const [callbackOk, callbackError] = pcall(callback);
	if (!callbackOk) {
		warn(`[robloxstudio-mcp] ${name} callback failed: ${tostring(callbackError)}`);
	}
}

function reportTransport(update: TransportUpdate): void {
	const currentOptions = options;
	if (active && currentOptions !== undefined) {
		invokeCallback("event stream transport", () => currentOptions.onTransportUpdate(update));
	}
}

function reconnectDelay(attempt: number): number {
	return math.min(INITIAL_RECONNECT_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)), MAX_RECONNECT_DELAY_SECONDS);
}

function connectAfter(delaySeconds: number, expectedGeneration: number): void {
	task.delay(delaySeconds, () => {
		if (!active || generation !== expectedGeneration) return;
		connect(expectedGeneration);
	});
}

function scheduleReconnect(expectedGeneration: number, detail: string, duplicate = false): void {
	if (!active || generation !== expectedGeneration) return;
	generation++;
	closeCurrentStream();
	reconnectAttempt++;
	const delay = duplicate ? 1 : reconnectDelay(reconnectAttempt);
	reportTransport({
		state: duplicate ? "waiting-duplicate" : "retrying",
		attempt: reconnectAttempt,
		retryDelay: delay,
		detail,
	});
	connectAfter(delay, generation);
}

function watchForSilence(expectedGeneration: number, expectedClient: WebStreamClient): void {
	const elapsed = tick() - lastValidEventAt;
	const delay = math.max(STREAM_SILENCE_TIMEOUT_SECONDS - elapsed, 0.1);
	task.delay(delay, () => {
		if (
			!active ||
			generation !== expectedGeneration ||
			streamClient !== expectedClient
		) {
			return;
		}
		const silentFor = tick() - lastValidEventAt;
		if (silentFor >= STREAM_SILENCE_TIMEOUT_SECONDS) {
			scheduleReconnect(
				expectedGeneration,
				`Event stream silent for ${math.floor(silentFor)} seconds`,
			);
			return;
		}
		watchForSilence(expectedGeneration, expectedClient);
	});
}

function parseReadyResponse(body: string): ReadyResponse | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const value = decoded as Record<string, unknown>;
	if (
		value.success !== true ||
		!typeIs(value.assignedRole, "string") ||
		value.assignedRole === "" ||
		!typeIs(value.instanceId, "string") ||
		value.instanceId === "" ||
		!typeIs(value.serverVersion, "string") ||
		value.serverVersion === ""
	) {
		return undefined;
	}
	return {
		success: true,
		assignedRole: value.assignedRole,
		instanceId: value.instanceId,
		serverVersion: value.serverVersion,
	};
}

function connect(expectedGeneration: number): void {
	const currentOptions = options;
	if (!active || generation !== expectedGeneration || currentOptions === undefined) return;
	reportTransport({ state: "connecting", attempt: reconnectAttempt, retryDelay: 0 });

	task.spawn(() => {
		const instanceId = PluginSession.getInstanceId();
		const readyUrl = `${currentOptions.serverUrl}/ready`;
		const physicalRole = PluginSession.getRole();
		const readyPayload = PluginSession.createReadyPayload(PluginSession.id, physicalRole);
		readyPayload.pluginReady = true;
		if (!active || generation !== expectedGeneration || options !== currentOptions) return;
		const [readyOk, readyResult] = pcall(() =>
			HttpService.RequestAsync({
				Url: readyUrl,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: HttpService.JSONEncode(readyPayload),
			}),
		);
		if (!active || generation !== expectedGeneration || options !== currentOptions) return;

		const readyLogKey = `${currentOptions.serverUrl}|${instanceId}|${physicalRole}`;
		// Nothing answering is the ordinary state whenever Roqer or its bridge is
		// closed or restarting, so it is not written to Studio's Output: the panel
		// already shows it as Reconnecting, and after repeated failures names the
		// reason and the raw error. Output is kept for a bridge that answered and
		// refused this Studio, which the user has to act on.
		if (!readyOk) {
			const detail = HttpDiagnostics.formatRequestFailure(readyUrl, false, readyResult);
			scheduleReconnect(expectedGeneration, detail);
			return;
		}
		if (!readyResult.Success) {
			const detail = HttpDiagnostics.formatRequestFailure(readyUrl, true, readyResult);
			if (!readyFailureLogKeys.has(readyLogKey)) {
				readyFailureLogKeys.add(readyLogKey);
				warn(`[robloxstudio-mcp] /ready rejected for ${instanceId}/${physicalRole}: ${detail}`);
			}
			scheduleReconnect(expectedGeneration, detail, readyResult.StatusCode === 409);
			return;
		}

		const readyData = parseReadyResponse(readyResult.Body);
		if (readyData === undefined) {
			scheduleReconnect(
				expectedGeneration,
				"Invalid /ready response: expected the bundled server protocol",
			);
			return;
		}
		// Connected again: a later refusal is worth reporting once more. The
		// reconnection itself is shown in the panel, not in Output.
		readyFailureLogKeys.delete(readyLogKey);
		invokeCallback(
			"event stream ready",
			() => currentOptions.onReady(readyData),
		);

		const [createOk, createdClient] = pcall(() =>
			HttpService.CreateWebStreamClient(Enum.WebStreamClientType.SSE, {
				Url: `${currentOptions.serverUrl}/events?pluginSessionId=${PluginSession.id}`,
				Method: "GET",
				Headers: { Accept: "text/event-stream" },
			}),
		);
		if (!createOk) {
			scheduleReconnect(expectedGeneration, `Failed to create event stream: ${tostring(createdClient)}`);
			return;
		}
		if (!active || generation !== expectedGeneration || options !== currentOptions) {
			pcall(() => createdClient.Close());
			return;
		}

		streamClient = createdClient;
		streamRemainder = "";
		const handleEvent = (event: DecodedEvent): void => {
			if (event.kind === "heartbeat") {
				invokeCallback(
					"event stream heartbeat",
					() => currentOptions.onHeartbeat(event.timestamp),
				);
				return;
			}
			if (event.kind === "request") {
				dispatchRequest(event);
				return;
			}
			invokeCallback("event stream status", () => currentOptions.onStatus(event));
			if (!event.knownInstance) refresh();
		};
		streamConnections = [
			createdClient.Opened.Connect((statusCode, _headers) => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				lastValidEventAt = tick();
				if (statusCode < 200 || statusCode >= 300) {
					scheduleReconnect(expectedGeneration, `Event stream opened with HTTP ${statusCode}`);
					return;
				}
				reconnectAttempt = 0;
				reportTransport({ state: "open", attempt: 0, retryDelay: 0 });
				resumePendingResponses();
			}),
			createdClient.MessageReceived.Connect((message) => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				for (const frame of takeStreamFrames(message)) {
					// Checked per frame: a status frame can refresh the stream,
					// after which the rest of this read belongs to a closed one.
					if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
					const event = decodeMessage(frame);
					if (event === undefined) continue;
					lastValidEventAt = tick();
					handleEvent(event);
				}
			}),
			createdClient.Error.Connect((statusCode, message) => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				const detail = statusCode === 404
					? `Event stream session is not registered: ${message}`
					: `Event stream error ${statusCode}: ${message}`;
				scheduleReconnect(expectedGeneration, detail);
			}),
			createdClient.Closed.Connect(() => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				scheduleReconnect(expectedGeneration, "Event stream closed");
			}),
		];
		lastValidEventAt = tick();
		watchForSilence(expectedGeneration, createdClient);
	});
}

function start(newOptions: StudioEventStreamOptions): void {
	if (active) stop();
	options = newOptions;
	active = true;
	reconnectAttempt = 0;
	generation++;
	connect(generation);
}

function refresh(): void {
	if (!active || options === undefined) return;
	generation++;
	closeCurrentStream();
	reconnectAttempt = 0;
	connect(generation);
}

function stop(): void {
	if (!active) return;
	const currentOptions = options;
	active = false;
	generation++;
	closeCurrentStream();
	readyFailureLogKeys.clear();
	options = undefined;
	reconnectAttempt = 0;
	if (currentOptions !== undefined) {
		pcall(() =>
			HttpService.RequestAsync({
				Url: `${currentOptions.serverUrl}/disconnect`,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: HttpService.JSONEncode({ pluginSessionId: PluginSession.id, timestamp: tick() }),
			}),
		);
	}
}

export = {
	start,
	refresh,
	stop,
};
