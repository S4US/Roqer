// What the play server's plugin last managed with the bridge, left where the
// edit plugin can read it.
//
// The play server's plugin registers a playtest's runtime peers: itself as
// `server`, and a `client-N` for each player that joins. When it cannot reach
// the bridge, the bridge never hears from it and the play DataModel has no
// panel to show why, so a start that timed out could say only that nothing
// came. Plugin settings are shared by every DataModel the plugin runs in
// (StopPlayMonitor crosses the same way), so the play server records each step
// of its connection under its place's keys, and the edit plugin hands back the
// newest record written since its own start.
//
// Written when the step changes, not per attempt or heartbeat: a plugin that
// keeps failing the same way writes once.

import { HttpService, RunService } from "@rbxts/services";
import ServerUrlSettings from "./ServerUrlSettings";

const SETTING_KEY_PREFIX = "MCP_RUNTIME_PEER_";
const MAX_DETAIL_LENGTH = 400;

type RuntimePeerStage = "loaded" | "connecting" | "retrying" | "failed" | "registered";

const STAGES = new Set<string>(["loaded", "connecting", "retrying", "failed", "registered"]);

interface RuntimePeerRecord {
	stage: RuntimePeerStage;
	/** tick() when written; every DataModel in the Studio process reads the same clock. */
	at: number;
	url?: string;
	detail?: string;
	role?: string;
}

let pluginRef: Plugin | undefined;
let lastStage: RuntimePeerStage | undefined;
let lastSignature: string | undefined;

function init(p: Plugin): void {
	pluginRef = p;
}

function clip(text: string | undefined): string | undefined {
	if (text === undefined || text.size() <= MAX_DETAIL_LENGTH) return text;
	return `${text.sub(1, MAX_DETAIL_LENGTH)}...`;
}

/** Record a step of the play server's connection. Does nothing outside a play server. */
function record(stage: RuntimePeerStage, fields: { url?: string; detail?: string; role?: string } = {}): void {
	const store = pluginRef;
	if (store === undefined || !RunService.IsRunning() || !RunService.IsServer()) return;
	// Why the last attempt failed says more than that the next one began.
	if (stage === "connecting" && lastStage === "retrying") return;

	const detail = clip(fields.detail);
	const signature = `${stage}|${fields.url ?? ""}|${fields.role ?? ""}|${detail ?? ""}`;
	if (signature === lastSignature) return;

	const entry: RuntimePeerRecord = { stage, at: tick(), url: fields.url, detail, role: fields.role };
	const [encodedOk, encoded] = pcall(() => HttpService.JSONEncode(entry));
	if (!encodedOk) return;
	lastStage = stage;
	lastSignature = signature;
	for (const instanceId of ServerUrlSettings.computeInstanceIds()) {
		pcall(() => store.SetSetting(SETTING_KEY_PREFIX + instanceId, encoded));
	}
}

function decode(value: unknown): RuntimePeerRecord | undefined {
	if (!typeIs(value, "string")) return undefined;
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(value as string));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const entry = decoded as Record<string, unknown>;
	if (!typeIs(entry.stage, "string") || !STAGES.has(entry.stage) || !typeIs(entry.at, "number")) {
		return undefined;
	}
	return {
		stage: entry.stage as RuntimePeerStage,
		at: entry.at,
		url: typeIs(entry.url, "string") ? entry.url : undefined,
		detail: typeIs(entry.detail, "string") ? entry.detail : undefined,
		role: typeIs(entry.role, "string") ? entry.role : undefined,
	};
}

/** The newest record written at or after `since`, under any key this place answers to. */
function readSince(since: number): RuntimePeerRecord | undefined {
	const store = pluginRef;
	if (store === undefined) return undefined;
	let newest: RuntimePeerRecord | undefined;
	for (const instanceId of ServerUrlSettings.computeInstanceIds()) {
		const [readOk, value] = pcall(() => store.GetSetting(SETTING_KEY_PREFIX + instanceId));
		const entry = readOk ? decode(value) : undefined;
		if (entry !== undefined && entry.at >= since && (newest === undefined || entry.at > newest.at)) {
			newest = entry;
		}
	}
	return newest;
}

export = {
	init,
	record,
	readSince,
};
