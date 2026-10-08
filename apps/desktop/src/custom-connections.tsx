import { Check, ChevronDown, ChevronLeft, Download, Eye, Plus, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CUSTOM_API_FORMATS,
  CUSTOM_REASONING_EFFORTS,
  DEFAULT_ANTHROPIC_MAX_OUTPUT,
  MAX_CUSTOM_MODELS,
  sortCustomReasoningEfforts,
  type CustomApiFormat,
  type CustomConnectionSave,
  type CustomConnectionView,
  type CustomModel,
  type CustomReasoningEffort,
} from "../shared/custom-providers";
import {
  importCustomModels, listCustomConnections, removeCustomConnection, saveCustomConnection, testCustomModel,
} from "./platform";
import { SettingsGroup } from "./settings-parts";

/**
 * Settings for the user's own model endpoints.
 *
 * Each connection is an API format, a base URL, an optional key, and the
 * models the user picked. The key is typed here and sent to the main process
 * once; it never comes back, so an edit shows only whether one is saved.
 *
 * Settings lists the endpoints; adding or editing one opens its own page in
 * Settings, because an endpoint with a handful of models needs more room than
 * a row in a list can give it, and a second dialog stacked on the first made
 * neither feel like a place.
 */

const FORMAT_LABELS: Record<CustomApiFormat, string> = {
  openai: "OpenAI-compatible",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic",
};

type Preset = Readonly<{ name: string; format: CustomApiFormat; baseUrl: string; local?: boolean }>;

/** Where most people's models already live. Choosing one only fills the fields. */
const PRESETS: readonly Preset[] = [
  // Responses, where OpenAI's reasoning models keep their thinking between tool calls.
  { name: "OpenAI", format: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  { name: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { name: "OpenRouter", format: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "OpenCode Zen", format: "openai", baseUrl: "https://opencode.ai/zen/v1" },
  { name: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Ollama", format: "openai", baseUrl: "http://localhost:11434/v1", local: true },
  { name: "LM Studio", format: "openai", baseUrl: "http://localhost:1234/v1", local: true },
];

export type FreeModelOption = Readonly<{
  id: string;
  displayName: string;
  contextWindow: number;
  category: "opencode" | "openrouter";
  description: string;
}>;

export const FREE_MODEL_OPTIONS: readonly FreeModelOption[] = [
  // OpenCode Zen free models
  {
    id: "space-bunny-free",
    displayName: "Space Bunny Free (Verified)",
    contextWindow: 128_000,
    category: "opencode",
    description: "Active free model on OpenCode Zen (tool-calling verified, no key required)",
  },
  {
    id: "big-pickle",
    displayName: "Big Pickle (Needs Zen Key)",
    contextWindow: 128_000,
    category: "opencode",
    description: "Requires an API key from opencode.ai/zen (OpenCode gates anonymous access)",
  },

  // OpenRouter free models
  {
    id: "deepseek/deepseek-r1:free",
    displayName: "DeepSeek R1 (Free)",
    contextWindow: 64_000,
    category: "openrouter",
    description: "Open reasoning model with chain-of-thought",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    displayName: "Llama 3.3 70B (Free)",
    contextWindow: 128_000,
    category: "openrouter",
    description: "Meta's flagship 70B open-weights instruction model",
  },
  {
    id: "qwen/qwen-2.5-coder-32b-instruct:free",
    displayName: "Qwen 2.5 Coder 32B (Free)",
    contextWindow: 32_000,
    category: "openrouter",
    description: "Alibaba's specialized code generation model",
  },
  {
    id: "google/gemini-2.0-flash-exp:free",
    displayName: "Gemini 2.0 Flash (Free)",
    contextWindow: 1_000_000,
    category: "openrouter",
    description: "Google's 1M-token multimodal experimental model",
  },
  {
    id: "deepseek/deepseek-chat:free",
    displayName: "DeepSeek V3 (Free)",
    contextWindow: 64_000,
    category: "openrouter",
    description: "Strong general coding and conversation model",
  },
];

const EFFORT_LABELS: Record<CustomReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

/** One-click effort sets for the common families; the toggles stay the truth. */
const EFFORT_SHORTCUTS: ReadonlyArray<{ label: string; title: string; efforts: readonly CustomReasoningEffort[] }> = [
  { label: "Standard", title: "Low, medium and high", efforts: ["low", "medium", "high"] },
  { label: "OpenAI", title: "Minimal to x-high, as OpenAI's reasoning models take", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  { label: "Claude", title: "Low to max, as Claude's models take", efforts: ["low", "medium", "high", "xhigh", "max"] },
];

type DraftModel = {
  /** Identifies the row while it is edited; never saved. */
  key: string;
  id: string;
  displayName: string;
  images: boolean;
  efforts: readonly CustomReasoningEffort[];
  contextWindow: string;
  maxOutputTokens: string;
};

type Draft = {
  id?: string;
  name: string;
  format: CustomApiFormat;
  baseUrl: string;
  /** A new key to save; empty keeps what is saved. */
  apiKey: string;
  removeKey: boolean;
  hasKey: boolean;
  models: DraftModel[];
};

let nextRowKey = 0;
const rowKey = () => `row-${nextRowKey++}`;

function emptyDraft(): Draft {
  return { name: "", format: "openai", baseUrl: "", apiKey: "", removeKey: false, hasKey: false, models: [] };
}

function draftModel(model?: CustomModel, key = rowKey()): DraftModel {
  return {
    key,
    id: model?.id ?? "",
    displayName: model?.displayName ?? "",
    images: model?.images ?? true,
    efforts: model?.efforts ?? [],
    contextWindow: model?.contextWindow === undefined ? "" : String(model.contextWindow),
    maxOutputTokens: model?.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens),
  };
}

/** A draft of a saved connection. Rows keep their keys from `previous`, so a save does not fold open rows. */
function draftFrom(connection: CustomConnectionView, previous?: Draft): Draft {
  const keys = new Map(previous?.models.map((model) => [model.id.trim(), model.key]));
  return {
    id: connection.id,
    name: connection.name,
    format: connection.format,
    baseUrl: connection.baseUrl,
    apiKey: "",
    removeKey: false,
    hasKey: connection.hasKey,
    models: connection.models.map((model) => draftModel(model, keys.get(model.id))),
  };
}

function optionalNumber(value: string): number | undefined | null {
  const trimmed = value.replace(/[\s,_]/g, "");
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The save request for a draft, or what is wrong with it. */
function saveRequest(draft: Draft): { ok: true; save: CustomConnectionSave } | { ok: false; message: string } {
  const models: CustomModel[] = [];
  for (const model of draft.models) {
    const id = model.id.trim();
    if (id === "") continue;
    const contextWindow = optionalNumber(model.contextWindow);
    const maxOutputTokens = optionalNumber(model.maxOutputTokens);
    if (contextWindow === null || maxOutputTokens === null) {
      return { ok: false, message: `The token counts for ${id} must be whole numbers.` };
    }
    models.push({
      id,
      displayName: model.displayName.trim() || id,
      images: model.images,
      efforts: sortCustomReasoningEfforts(model.efforts),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  }
  return {
    ok: true,
    save: {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name: draft.name.trim(),
      format: draft.format,
      baseUrl: draft.baseUrl.trim(),
      models,
      ...(draft.removeKey ? { apiKey: null } : draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    },
  };
}

/** Whether saving the draft would change what is saved. */
function isDirty(draft: Draft, saved: CustomConnectionView | undefined): boolean {
  if (saved === undefined) return true;
  const request = saveRequest(draft);
  if (!request.ok) return true;
  const current = saveRequest(draftFrom(saved));
  return !current.ok || JSON.stringify(request.save) !== JSON.stringify(current.save);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** "Low – Max" for a run of levels, the one label for a single level. */
function effortSummary(efforts: readonly CustomReasoningEffort[]): string | undefined {
  if (efforts.length === 0) return undefined;
  const sorted = sortCustomReasoningEfforts(efforts);
  const first = EFFORT_LABELS[sorted[0]];
  return sorted.length === 1 ? first : `${first} – ${EFFORT_LABELS[sorted[sorted.length - 1]]}`;
}

/** 128000 → "128K", 1000000 → "1M": the way model pages write it. */
function compactTokens(value: string): string | undefined {
  const tokens = optionalNumber(value);
  if (tokens === undefined || tokens === null) return undefined;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** The endpoints a person has saved, and a way to reload them after a change elsewhere. */
export function useCustomConnections() {
  const [connections, setConnections] = useState<readonly CustomConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const result = await listCustomConnections();
    if (result.ok) {
      setConnections(result.connections);
      setError(null);
    } else {
      setError(result.message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { connections, error, setConnections, reload };
}

/** One line per endpoint; what it says is what the person would otherwise open it to check. */
export function endpointDetail(connection: CustomConnectionView): string {
  const models = connection.models.length;
  const parts = [hostOf(connection.baseUrl), models === 0 ? "no models yet" : `${models} ${models === 1 ? "model" : "models"}`];
  // Only the exception is worth a word: a saved key is the normal state.
  const local = PRESETS.some((preset) => preset.local === true && preset.baseUrl === connection.baseUrl);
  if (!connection.hasKey && !local) parts.push("no key");
  return parts.join(" · ");
}

/**
 * One endpoint, as a page of Settings rather than a dialog above it.
 *
 * Adding one starts from where the key is from; editing one starts from what
 * is saved, since which provider it is was decided when it was added. Nothing
 * saves until the save bar is used, and the bar only appears once something
 * has changed, so an untouched page never asks a question.
 */
export function EndpointPage({ connection, onBack, onSaved, onRemoved, onDirtyChange }: {
  /** The saved endpoint being edited, or undefined to add one. */
  connection: CustomConnectionView | undefined;
  onBack: () => void;
  /** Saved: every endpoint now, and the one this page shows. */
  onSaved: (connections: readonly CustomConnectionView[], saved: CustomConnectionView) => void;
  onRemoved: (connections: readonly CustomConnectionView[]) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => connection === undefined ? emptyDraft() : draftFrom(connection));
  const [saved, setSaved] = useState<CustomConnectionView | undefined>(connection);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, { pending: boolean; ok?: boolean; text?: string }>>({});
  const [imported, setImported] = useState<readonly string[] | null>(null);
  const [importFilter, setImportFilter] = useState("");
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showFreePicker, setShowFreePicker] = useState(false);
  const [chosenFree, setChosenFree] = useState<ReadonlySet<string>>(new Set());
  const adding = saved === undefined;
  const activePreset = PRESETS.find((preset) => preset.baseUrl === draft.baseUrl.trim() && preset.format === draft.format);
  // A preset fills the address, so its fields stay folded away until asked for.
  const [showEndpoint, setShowEndpoint] = useState(draft.baseUrl.trim() !== "" && activePreset === undefined);
  const endpointChosen = draft.baseUrl.trim() !== "" || showEndpoint;
  const dirty = isDirty(draft, saved);

  useEffect(() => {
    onDirtyChange(dirty && (!adding || endpointChosen));
  }, [dirty, adding, endpointChosen, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const update = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(null);
  };
  const updateModel = (key: string, changes: Partial<DraftModel>) =>
    update({ models: draft.models.map((model) => model.key === key ? { ...model, ...changes } : model) });
  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const applyPreset = (preset: Preset) => {
    const isNew = draft.models.length === 0;
    const defaultModels = preset.name === "OpenCode Zen" && isNew
      ? FREE_MODEL_OPTIONS.filter((m) => m.id === "space-bunny-free").map((m) => draftModel({
          id: m.id,
          displayName: m.displayName,
          images: true,
          efforts: [],
          contextWindow: m.contextWindow,
        }))
      : draft.models;
    update({
      name: draft.name.trim() === "" || PRESETS.some((entry) => entry.name === draft.name.trim()) ? preset.name : draft.name,
      format: preset.format,
      baseUrl: preset.baseUrl,
      models: defaultModels,
    });
    setShowEndpoint(false);
  };

  const chooseOther = () => {
    if (activePreset !== undefined) update({ baseUrl: "" });
    setShowEndpoint(true);
  };

  /** Save the draft and keep editing it; the saved endpoint, or undefined when it did not save. */
  const save = async (): Promise<CustomConnectionView | undefined> => {
    const request = saveRequest(draft);
    if (!request.ok) {
      setMessage({ ok: false, text: request.message });
      return undefined;
    }
    setBusy(true);
    const result = await saveCustomConnection(request.save);
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return undefined;
    }
    // Stay on the saved endpoint, so Test and Find models work next.
    const next = request.save.id === undefined
      ? result.connections.at(-1)
      : result.connections.find((entry) => entry.id === request.save.id);
    if (next === undefined) return undefined;
    setSaved(next);
    setDraft((current) => draftFrom(next, current));
    setMessage({ ok: true, text: "Saved." });
    onSaved(result.connections, next);
    return next;
  };

  const discard = () => {
    if (saved === undefined) {
      onBack();
      return;
    }
    setDraft(draftFrom(saved, draft));
    setMessage(null);
  };

  const remove = async () => {
    if (saved === undefined) return;
    setBusy(true);
    const result = await removeCustomConnection(saved.id);
    setBusy(false);
    if (!result.ok) {
      setConfirmRemove(false);
      setMessage({ ok: false, text: result.message });
      return;
    }
    onRemoved(result.connections);
  };

  /** The saved endpoint, saving the draft first when it has changes. */
  const savedForUse = async (): Promise<CustomConnectionView | undefined> => dirty || saved === undefined ? save() : saved;

  const test = async (model: DraftModel) => {
    const id = model.id.trim();
    if (id === "") return;
    setTests((current) => ({ ...current, [id]: { pending: true } }));
    const endpoint = await savedForUse();
    if (endpoint === undefined) {
      setTests((current) => ({ ...current, [id]: { pending: false } }));
      return;
    }
    const result = await testCustomModel(endpoint.id, id);
    setTests((current) => ({ ...current, [id]: { pending: false, ok: result.ok, text: result.message } }));
  };

  const loadImport = async () => {
    setImportMessage("Reading the endpoint's model list…");
    const endpoint = await savedForUse();
    if (endpoint === undefined) {
      setImportMessage(null);
      return;
    }
    const result = await importCustomModels(endpoint.id);
    if (!result.ok) {
      setImportMessage(result.message);
      return;
    }
    setImportMessage(null);
    setImported(result.modelIds);
    setChosen(new Set());
  };

  const existingIds = useMemo(() => new Set(draft.models.map((model) => model.id.trim())), [draft.models]);
  const visibleImports = useMemo(() => {
    const filter = importFilter.trim().toLowerCase();
    return (imported ?? []).filter((id) => !existingIds.has(id) && (filter === "" || id.toLowerCase().includes(filter))).slice(0, 200);
  }, [imported, importFilter, existingIds]);

  const room = MAX_CUSTOM_MODELS - draft.models.length;

  const addChosen = () => {
    const added = [...chosen].slice(0, room).map((id) => draftModel({ id, displayName: id, images: true, efforts: [] }));
    update({ models: [...draft.models, ...added] });
    setImported(null);
    setChosen(new Set());
    setImportFilter("");
  };

  const addManual = () => {
    const model = draftModel();
    update({ models: [...draft.models, model] });
    setExpanded((current) => new Set(current).add(model.key));
  };

  const canSave = !busy && draft.name.trim() !== "" && draft.baseUrl.trim() !== "";
  const needsSaveFirst = dirty || saved === undefined;
  const showSaveBar = endpointChosen && (adding || dirty);

  return <div className="settings-subpage">
    <div className="settings-page-head">
      <button type="button" className="settings-back" onClick={onBack}><ChevronLeft size={14} /> Models</button>
      <h1>{adding ? "Add an endpoint" : saved.name}</h1>
      {adding && <p>Pick where your key is from. Roqer fills in the rest.</p>}
    </div>

    {adding && <div className="custom-provider-grid" role="group" aria-label="Where the key is from">
      {PRESETS.map((preset) => <button
        key={preset.name}
        type="button"
        className="custom-provider"
        aria-pressed={activePreset === preset}
        onClick={() => applyPreset(preset)}
      >
        <strong>{preset.name}</strong>
        <span>{preset.local ? "On this computer" : hostOf(preset.baseUrl)}</span>
      </button>)}
      <button type="button" className="custom-provider" aria-pressed={activePreset === undefined && showEndpoint} onClick={chooseOther}>
        <strong>Other</strong>
        <span>Any endpoint URL</span>
      </button>
    </div>}

    {endpointChosen && <>
      <SettingsGroup title="Endpoint">
        <label className="settings-field">
          <span>Name</span>
          <input value={draft.name} maxLength={60} placeholder="e.g. OpenRouter" onChange={(event) => update({ name: event.target.value })} />
        </label>
        <label className="settings-field">
          <span>API key</span>
          <div className="custom-key-row">
            <input type="password" value={draft.apiKey} spellCheck={false} autoComplete="off" disabled={draft.removeKey} placeholder={draft.removeKey ? "Removed when you save" : draft.hasKey ? "Saved · paste a new one to replace it" : activePreset?.local ? "Not needed for a server on this computer" : "sk-…"} onChange={(event) => update({ apiKey: event.target.value })} />
            {draft.hasKey && <button type="button" className="small-button" onClick={() => update({ removeKey: !draft.removeKey, apiKey: "" })}>{draft.removeKey ? "Keep key" : "Remove"}</button>}
          </div>
        </label>
        {showEndpoint || activePreset === undefined || !adding
          ? <>
            <div className="settings-field">
              <span id="endpoint-format">Format</span>
              <div className="settings-segmented" role="group" aria-labelledby="endpoint-format">
                {CUSTOM_API_FORMATS.map((format) => <button key={format} type="button" aria-pressed={draft.format === format} onClick={() => update({ format })}>{FORMAT_LABELS[format]}</button>)}
              </div>
            </div>
            <label className="settings-field">
              <span>Base URL</span>
              <input className="mono" value={draft.baseUrl} spellCheck={false} autoFocus={draft.baseUrl === ""} placeholder={draft.format === "anthropic" ? "https://api.anthropic.com/v1" : "https://…/v1"} onChange={(event) => update({ baseUrl: event.target.value })} />
            </label>
          </>
          : <div className="settings-field">
            <span>Address</span>
            <p className="custom-endpoint-line">
              <span>{FORMAT_LABELS[draft.format]} · <code>{draft.baseUrl}</code></span>
              <button type="button" className="link-button" onClick={() => setShowEndpoint(true)}>Change</button>
            </p>
          </div>}
      </SettingsGroup>

      <SettingsGroup
        title={`Models${draft.models.length > 0 ? ` · ${draft.models.length}` : ""}`}
        action={<div className="settings-actions">
          <button type="button" className="text-button" disabled={busy || room <= 0} onClick={() => { setShowFreePicker(!showFreePicker); setImported(null); }}><Sparkles size={14} /> Free models</button>
          <button type="button" className="text-button" disabled={busy || room <= 0 || !canSave} onClick={() => { void loadImport(); setShowFreePicker(false); }} title={needsSaveFirst ? "Saves the endpoint, then reads its model list" : "Read the endpoint's model list"}><Download size={14} /> Find models</button>
          <button type="button" className="text-button" disabled={room <= 0} onClick={addManual}><Plus size={14} /> Add by id</button>
        </div>}
        footnote="These appear in the composer's model picker. Roqer works through tool calls, so use models that support them; small local models may not follow its instructions well."
      >
        {showFreePicker && <div className="custom-import">
          <div className="custom-import-list">
            {FREE_MODEL_OPTIONS.filter((option) => !existingIds.has(option.id)).map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={chosenFree.has(option.id)}
                  disabled={!chosenFree.has(option.id) && chosenFree.size >= room}
                  onChange={(event) => setChosenFree((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(option.id); else next.delete(option.id);
                    return next;
                  })}
                />
                <span className="custom-model-name">
                  <strong>{option.displayName}</strong>
                  <code>{option.id}</code>
                </span>
                <span className="custom-hint">{option.description}</span>
              </label>
            ))}
            {FREE_MODEL_OPTIONS.every((option) => existingIds.has(option.id)) && <span className="custom-hint">All curated free models are already added.</span>}
          </div>
          <div className="settings-actions">
            <span className="custom-hint">Curated free models for OpenCode Zen and OpenRouter.</span>
            <button type="button" className="small-button" onClick={() => setShowFreePicker(false)}>Close</button>
            <button
              type="button"
              className="small-button primary"
              disabled={chosenFree.size === 0}
              onClick={() => {
                const added = FREE_MODEL_OPTIONS.filter((opt) => chosenFree.has(opt.id)).slice(0, room).map((opt) => draftModel({
                  id: opt.id,
                  displayName: opt.displayName,
                  images: true,
                  efforts: [],
                  contextWindow: opt.contextWindow,
                }));
                update({ models: [...draft.models, ...added] });
                setShowFreePicker(false);
                setChosenFree(new Set());
              }}
            >
              Add {chosenFree.size || ""} selected
            </button>
          </div>
        </div>}
        {importMessage && <p className="custom-hint">{importMessage}</p>}
        {imported !== null && <div className="custom-import">
          <input value={importFilter} autoFocus placeholder={`Filter ${imported.length} models`} spellCheck={false} onChange={(event) => setImportFilter(event.target.value)} />
          <div className="custom-import-list">
            {visibleImports.map((id) => <label key={id}><input type="checkbox" checked={chosen.has(id)} disabled={!chosen.has(id) && chosen.size >= room} onChange={(event) => setChosen((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(id); else next.delete(id);
              return next;
            })} /> {id}</label>)}
            {visibleImports.length === 0 && <span className="custom-hint">No models match.</span>}
          </div>
          <div className="settings-actions">
            <span className="custom-hint">Set images and reasoning for each model after adding it.</span>
            <button type="button" className="small-button" onClick={() => setImported(null)}>Close</button>
            <button type="button" className="small-button primary" disabled={chosen.size === 0} onClick={addChosen}>Add {chosen.size || ""} selected</button>
          </div>
        </div>}
        {draft.models.length === 0 && imported === null && <p className="custom-empty">No models yet. Find them on the endpoint, or add one by its id.</p>}
        {draft.models.map((model) => <ModelRow
          key={model.key}
          model={model}
          format={draft.format}
          open={expanded.has(model.key) || model.id.trim() === ""}
          test={tests[model.id.trim()]}
          testLabel={needsSaveFirst ? "Save & test" : "Test"}
          canTest={canSave && model.id.trim() !== ""}
          onToggle={() => toggleExpanded(model.key)}
          onChange={(changes) => updateModel(model.key, changes)}
          onTest={() => void test(model)}
          onRemove={() => update({ models: draft.models.filter((entry) => entry.key !== model.key) })}
        />)}
      </SettingsGroup>
    </>}

    {!adding && <div className="settings-danger">
      {confirmRemove
        ? <>
          <span>Remove {saved.name} and its saved key from this computer?</span>
          <button type="button" className="small-button" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep</button>
          <button type="button" className="small-button danger" disabled={busy} onClick={() => void remove()}>Remove</button>
        </>
        : <>
          <span>Chats that used this endpoint keep their history.</span>
          <button type="button" className="small-button danger-outline" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove endpoint…</button>
        </>}
    </div>}

    {(showSaveBar || message !== null) && <div className="settings-savebar" role="region" aria-label="Save changes">
      {message !== null
        ? <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.ok ? <Check size={13} /> : null} {message.text}</p>
        : <p className="settings-savebar-note">{adding ? "Not added yet." : "You have unsaved changes."}</p>}
      {showSaveBar && <>
        <button type="button" className="secondary-action" disabled={busy} onClick={discard}>{adding ? "Cancel" : "Discard"}</button>
        <button type="button" className="primary-action" disabled={!canSave || !dirty} onClick={() => void save()}>{busy ? "Saving…" : adding ? "Add endpoint" : "Save"}</button>
      </>}
    </div>}
  </div>;
}

/**
 * One model: a line that says what it is and what it takes, which opens to
 * the fields. Most models are set once, so the fields stay out of the way.
 */
function ModelRow({ model, format, open, test, testLabel, canTest, onToggle, onChange, onTest, onRemove }: {
  model: DraftModel;
  format: CustomApiFormat;
  open: boolean;
  test: { pending: boolean; ok?: boolean; text?: string } | undefined;
  testLabel: string;
  canTest: boolean;
  onToggle: () => void;
  onChange: (changes: Partial<DraftModel>) => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const id = model.id.trim();
  const name = model.displayName.trim() || id || "New model";
  const effort = effortSummary(model.efforts);
  const context = compactTokens(model.contextWindow);
  return <div className={`custom-model ${open ? "open" : ""}`}>
    <div className="custom-model-line">
      <button type="button" className="custom-model-summary" aria-expanded={open} onClick={onToggle}>
        <ChevronDown size={14} className="custom-model-chevron" />
        <span className="custom-model-name">
          <strong>{name}</strong>
          {id !== "" && id !== name && <code>{id}</code>}
        </span>
        <span className="custom-model-badges">
          {model.images && <span className="custom-badge" title="Sees images"><Eye size={12} /> Images</span>}
          <span className={`custom-badge ${effort === undefined ? "quiet" : ""}`} title="Reasoning effort">{effort ?? "No effort"}</span>
          {context !== undefined && <span className="custom-badge" title="Context window">{context}</span>}
        </span>
      </button>
      <div className="settings-actions">
        <button className="small-button" disabled={!canTest || test?.pending === true} onClick={onTest}>{test?.pending ? "Testing…" : testLabel}</button>
        <button className="small-button" onClick={onRemove} aria-label={`Remove ${id || "model"}`}><X size={14} /></button>
      </div>
    </div>
    {test?.text && <p className={`custom-message ${test.ok ? "ok" : "error"}`}>{test.ok ? <Check size={13} /> : null} {test.text}</p>}
    {open && <div className="custom-model-details">
      <div className="custom-grid">
        <label className="custom-field"><span>Model id</span><input value={model.id} spellCheck={false} autoFocus={id === ""} placeholder="e.g. deepseek/deepseek-chat" onChange={(event) => onChange({ id: event.target.value })} /></label>
        <label className="custom-field"><span>Display name</span><input value={model.displayName} maxLength={60} placeholder={id || "Shown in the model picker"} onChange={(event) => onChange({ displayName: event.target.value })} /></label>
      </div>
      <EffortPicker efforts={model.efforts} onChange={(efforts) => onChange({ efforts })} />
      <div className="custom-model-options">
        <label className="custom-check" title="Screenshots and attached images are sent only to models that accept them."><input type="checkbox" checked={model.images} onChange={(event) => onChange({ images: event.target.checked })} /> Sees images</label>
        <label className="custom-number" title="Tokens the model can hold. Roqer keeps less tool output for a small model."><span>Context window</span><input value={model.contextWindow} inputMode="numeric" placeholder="Unknown" onChange={(event) => onChange({ contextWindow: event.target.value })} /></label>
        <label className="custom-number" title="The longest answer to ask for in one turn, thinking included. Writing a whole UI builder takes around 10,000 tokens."><span>Max output</span><input value={model.maxOutputTokens} inputMode="numeric" placeholder={format === "anthropic" ? String(DEFAULT_ANTHROPIC_MAX_OUTPUT) : "Endpoint default"} onChange={(event) => onChange({ maxOutputTokens: event.target.value })} /></label>
      </div>
    </div>}
  </div>;
}

/**
 * The reasoning efforts a model takes, as toggles. None chosen means Roqer
 * sends no effort at all, which is what a model without the setting needs.
 */
function EffortPicker({ efforts, onChange }: {
  efforts: readonly CustomReasoningEffort[];
  onChange: (efforts: CustomReasoningEffort[]) => void;
}) {
  const chosen = new Set(efforts);
  const toggle = (effort: CustomReasoningEffort) => {
    const next = new Set(chosen);
    if (next.has(effort)) next.delete(effort); else next.add(effort);
    onChange(sortCustomReasoningEfforts(next));
  };
  const current = sortCustomReasoningEfforts(efforts).join();
  return <div className="custom-efforts">
    <div className="custom-efforts-header">
      <span>Reasoning effort</span>
      <div className="custom-effort-shortcuts">
        {EFFORT_SHORTCUTS.map((shortcut) => <button key={shortcut.label} type="button" className="link-button" title={shortcut.title} aria-pressed={current === shortcut.efforts.join()} onClick={() => onChange([...shortcut.efforts])}>{shortcut.label}</button>)}
        <button type="button" className="link-button" title="This model has no reasoning setting" aria-pressed={chosen.size === 0} onClick={() => onChange([])}>None</button>
      </div>
    </div>
    <div className="custom-effort-row" role="group" aria-label="Reasoning efforts this model takes">
      {CUSTOM_REASONING_EFFORTS.map((effort) => <button
        key={effort}
        type="button"
        className="custom-effort"
        aria-pressed={chosen.has(effort)}
        title={effort === "none" ? "Sends \"none\": some endpoints accept it to turn reasoning off." : `Sends "${effort}".`}
        onClick={() => toggle(effort)}
      >{EFFORT_LABELS[effort]}</button>)}
    </div>
    <span className="custom-hint">{chosen.size === 0
      ? "No effort is sent. Choose the levels this model takes to pick one in the composer."
      : "The composer offers exactly these levels for this model."}</span>
  </div>;
}
