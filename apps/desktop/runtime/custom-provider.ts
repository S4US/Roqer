import type { TurnRequest } from "./model-api/turn-contract";

import {
  customModelKey,
  defaultCustomReasoningEffort,
  isCustomModelId,
  parseCustomModelKey,
  type CustomConnection,
  type CustomConnectionView,
  type CustomModel,
  type CustomModelImportResult,
  type CustomModelTestResult,
} from "../shared/custom-providers";
import type { ProviderModel, ProviderModelCatalog, ProviderStatus } from "../shared/provider";
import type { TurnTransport } from "./agent-loop";
import { AnthropicMessagesTurns, ANTHROPIC_VERSION } from "./model-api/anthropic-messages";
import { endpointUrl, fetchWithin, isRecord, refusalMessage } from "./model-api/http";
import { OpenAiChatTurns } from "./model-api/openai-chat";

/**
 * The "Custom" provider: models on endpoints the user configured, driven by
 * Roqer's own agent loop with requests going straight from this computer to
 * the endpoint.
 */

function catalogModel(connection: CustomConnectionView, model: CustomModel): ProviderModel {
  const defaultEffort = defaultCustomReasoningEffort(model.efforts);
  return {
    id: customModelKey(connection.id, model.id),
    displayName: model.displayName,
    description: model.id,
    runsOn: connection.name,
    // A model without a reasoning setting still needs one entry for the
    // picker; "none" says plainly that nothing will be sent.
    defaultReasoningEffort: defaultEffort ?? "none",
    supportedReasoningEfforts: defaultEffort === undefined
      ? [{ reasoningEffort: "none", description: "This model has no reasoning setting." }]
      : model.efforts.map((reasoningEffort) => ({ reasoningEffort })),
  };
}

export function customModelCatalog(connections: readonly CustomConnectionView[]): ProviderModelCatalog {
  const models = connections.flatMap((connection) => connection.models.map((model) => catalogModel(connection, model)));
  return models.length === 0
    ? { models, defaultModelId: null, message: "Add a connection and a model in Settings to use your own endpoint." }
    : { models, defaultModelId: models[0].id };
}

export function customProviderStatus(connections: readonly CustomConnectionView[]): ProviderStatus {
  const models = connections.reduce((total, connection) => total + connection.models.length, 0);
  if (models === 0) {
    return {
      kind: "signed-out",
      message: connections.length === 0
        ? "Add a connection to your own model endpoint in Settings."
        : "Add a model to one of your connections in Settings.",
    };
  }
  return {
    kind: "signed-in",
    message: `${connections.length} ${connections.length === 1 ? "connection" : "connections"}, ${models} ${models === 1 ? "model" : "models"}`,
    planType: "Your endpoint",
  };
}

/** The connection and model a picker key names, if both still exist. */
export function findCustomModel(
  connection: CustomConnection,
  key: string,
): CustomModel | undefined {
  const parsed = parseCustomModelKey(key);
  if (parsed === null || parsed.connectionId !== connection.id) return undefined;
  return connection.models.find((model) => model.id === parsed.modelId);
}

export type CustomTransportOptions = Readonly<{
  connection: CustomConnection;
  model: CustomModel;
  apiKey: string | null;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}>;

/** One run's transport. A new one per run: the Anthropic one remembers the latest turn's thinking. */
export function createCustomTransport(options: CustomTransportOptions): TurnTransport {
  const shared = {
    baseUrl: options.connection.baseUrl,
    apiKey: options.apiKey,
    label: options.connection.name,
    reasoning: options.model.efforts.length > 0,
    ...(options.model.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.model.maxOutputTokens }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  return options.connection.format === "anthropic" ? new AnthropicMessagesTurns(shared) : new OpenAiChatTurns(shared);
}

const TEST_TOOL = "report_ready";
const TEST_TIMEOUT_MS = 60_000;

/**
 * One small request that needs a tool call to pass.
 *
 * A model that answers but cannot call a tool cannot drive Roqer at all, and
 * finding that out here costs one short request instead of a failed run.
 */
export async function testCustomModel(options: CustomTransportOptions): Promise<CustomModelTestResult> {
  const transport = createCustomTransport({ ...options, requestTimeoutMs: options.requestTimeoutMs ?? TEST_TIMEOUT_MS });
  const request: TurnRequest = {
    runId: "connection-test",
    turnId: "connection-test:turn:1",
    modelId: options.model.id,
    // The cheapest level the model takes: this checks the connection, not the thinking.
    reasoningEffort: options.model.efforts[0] ?? "none",
    instructions: { system: `You are checking a connection. Call the ${TEST_TOOL} tool with ok set to true. Do not answer in text.` },
    tools: [{
      name: TEST_TOOL,
      description: "Report that the connection works.",
      parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    }],
    messages: [{ role: "user", content: [{ kind: "text", text: `Call ${TEST_TOOL} now.` }] }],
    maxOutputTokens: options.model.efforts.length > 0 ? Math.min(options.model.maxOutputTokens ?? 4_096, 4_096) : 512,
  };
  const controller = new AbortController();
  try {
    let text = "";
    for await (const event of transport.streamTurn(request, controller.signal)) {
      if (event.kind === "tool-call" && event.call.name === TEST_TOOL) {
        return { ok: true, message: `${options.model.displayName} answered and called a tool. It is ready to use.` };
      }
      if (event.kind === "delta") text += event.text;
      if (event.kind === "failed") return { ok: false, message: event.message };
    }
    return {
      ok: false,
      message: text.trim().length > 0
        ? `${options.model.displayName} answered in text but did not call the tool. Roqer works through tool calls, so this model will not be able to make changes.`
        : `${options.model.displayName} did not answer.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The connection test failed." };
  } finally {
    controller.abort();
  }
}

const MAX_IMPORTED_MODELS = 500;

/** The model ids the endpoint lists, for the user to choose from. */
export async function listEndpointModels(
  connection: CustomConnection,
  apiKey: string | null,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CustomModelImportResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (connection.format === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey !== null) headers["x-api-key"] = apiKey;
  } else if (apiKey !== null) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const url = endpointUrl(connection.baseUrl, connection.format === "anthropic" ? "models?limit=1000" : "models");
  const controller = new AbortController();
  try {
    const opened = await fetchWithin(fetchImpl, url, { method: "GET", headers }, controller.signal, TEST_TIMEOUT_MS, connection.name);
    if (opened === undefined) return { ok: false, message: "The model list request was cancelled." };
    const { response, dispose } = opened;
    try {
      if (!response.ok) {
        return {
          ok: false,
          message: response.status === 404
            ? `${connection.name} does not list its models. Add model ids by hand.`
            : await refusalMessage(response, connection.name, apiKey),
        };
      }
      const body = await response.json() as unknown;
      const entries = isRecord(body) && Array.isArray(body.data) ? body.data
        : isRecord(body) && Array.isArray(body.models) ? body.models
          : Array.isArray(body) ? body : undefined;
      if (entries === undefined) return { ok: false, message: `${connection.name} sent a model list Roqer could not read.` };
      const ids = [...new Set(entries.flatMap((entry) => {
        const id = isRecord(entry) ? entry.id ?? entry.name ?? entry.model : entry;
        return isCustomModelId(id) ? [id] : [];
      }))].sort((a, b) => a.localeCompare(b)).slice(0, MAX_IMPORTED_MODELS);
      return ids.length === 0
        ? { ok: false, message: `${connection.name} listed no models Roqer can use. Add model ids by hand.` }
        : { ok: true, modelIds: ids };
    } finally {
      dispose();
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The model list could not be read." };
  }
}
