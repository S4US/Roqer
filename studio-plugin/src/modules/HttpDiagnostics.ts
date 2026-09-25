import { HttpService } from "@rbxts/services";

interface FailureBody {
	error?: string;
	message?: string;
	missingFields?: unknown;
	request?: unknown;
	existing?: unknown;
	details?: unknown;
}

function encodeForLog(value: unknown): string {
	const [ok, encoded] = pcall(() => HttpService.JSONEncode(value));
	return ok ? encoded : tostring(value);
}

function formatBody(body: string): string {
	if (body === "") return "";
	const [ok, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (ok && typeIs(decoded, "table")) {
		const data = decoded as FailureBody;
		const parts: string[] = [];
		if (typeIs(data.error, "string") && data.error !== "") parts.push(`error=${data.error}`);
		if (typeIs(data.message, "string") && data.message !== "") parts.push(`message=${data.message}`);
		if (data.missingFields !== undefined) parts.push(`missingFields=${encodeForLog(data.missingFields)}`);
		if (data.request !== undefined) parts.push(`request=${encodeForLog(data.request)}`);
		if (data.existing !== undefined) parts.push(`existing=${encodeForLog(data.existing)}`);
		if (data.details !== undefined) parts.push(`details=${encodeForLog(data.details)}`);
		if (parts.size() > 0) return parts.join(" ");
	}
	return `body=${body}`;
}

function formatRequestFailure(url: string, ok: boolean, res: unknown): string {
	if (!ok) {
		return `RequestAsync threw for ${url}: ${tostring(res)}`;
	}
	if (res === undefined) {
		return `RequestAsync returned no response for ${url}`;
	}
	const response = res as RequestAsyncResponse;
	const statusMessage = response.StatusMessage !== "" ? ` ${response.StatusMessage}` : "";
	const body = formatBody(response.Body);
	const suffix = body !== "" ? `: ${body}` : "";
	return `HTTP ${response.StatusCode}${statusMessage} from ${url}${suffix}`;
}

export = {
	formatRequestFailure,
};
