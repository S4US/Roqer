import { Connection } from "../types";

const CURRENT_VERSION = "__VERSION__";
const PLUGIN_VARIANT = "__PLUGIN_VARIANT__";
const BASE_PORT = 58741;
// The literal address the bridge binds, not `localhost`. The bridge listens on
// IPv4 loopback only, and `localhost` resolves to `::1` first on Windows; the
// fallback is instant on most machines and a hang on the ones whose firewall
// drops rather than refuses, which reads as a plugin that times out at random.
const DEFAULT_HOST = "127.0.0.1";

function defaultServerUrl(port: number): string {
	return `http://${DEFAULT_HOST}:${port}`;
}

function createConnection(port: number): Connection {
	return {
		port,
		serverUrl: defaultServerUrl(port),
		isActive: false,
		consecutiveFailures: 0,
		maxFailuresBeforeError: 50,
		currentRetryDelay: 0.5,
		lastHttpOk: false,
		lastMcpOk: false,
		mcpWaitStartTime: undefined,
		heartbeatConnection: undefined,
	};
}

const connection = createConnection(BASE_PORT);

function getActiveConnection(): Connection {
	return connection;
}

export = {
	CURRENT_VERSION,
	PLUGIN_VARIANT,
	BASE_PORT,
	DEFAULT_HOST,
	defaultServerUrl,
	getActiveConnection,
};
