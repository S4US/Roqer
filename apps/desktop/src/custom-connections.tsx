import { Check, KeyRound, Pencil, Plus, Server, Trash2, X } from "lucide-react";
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

/**
 * Settings for the user's own model endpoints.
 *
 * Each connection is an API format, a base URL, an optional key, and the
 * models the user picked. The key is typed here and sent to the main process
 * once; it never comes back, so an edit shows only whether one is saved.
 */

const FORMAT_LABELS: Record<CustomApiFormat, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
};

type Preset = Readonly<{ name: string; format: CustomApiFormat; baseUrl: string; local?: boolean }>;

/** Where most people's models already live. Choosing one only fills the fields. */
const PRESETS: readonly Preset[] = [
  { name: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1" },
  { name: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { name: "OpenRouter", format: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Ollama", format: "openai", baseUrl: "http://localhost:11434/v1", local: true },
  { name: "LM Studio", format: "openai", baseUrl: "http://localhost:1234/v1", local: true },
];

type DraftModel = {
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

function emptyDraft(): Draft {
  return { name: "", format: "openai", baseUrl: "", apiKey: "", removeKey: false, hasKey: false, models: [] };
}

function draftModel(model?: CustomModel): DraftModel {
  return {
    id: model?.id ?? "",
    displayName: model?.displayName ?? "",
    images: model?.images ?? true,
    efforts: model?.efforts ?? [],
    contextWindow: model?.contextWindow === undefined ? "" : String(model.contextWindow),
    maxOutputTokens: model?.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens),
  };
}

function draftFrom(connection: CustomConnectionView): Draft {
  return {
    id: connection.id,
    name: connection.name,
    format: connection.format,
    baseUrl: connection.baseUrl,
    apiKey: "",
    removeKey: false,
    hasKey: connection.hasKey,
    models: connection.models.map(draftModel),
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

function connectionSummary(connection: CustomConnectionView): string {
  const models = connection.models.length;
  return [
    FORMAT_LABELS[connection.format],
    new URL(connection.baseUrl).host,
    `${models} ${models === 1 ? "model" : "models"}`,
    connection.hasKey ? "key saved" : "no key",
  ].join(" · ");
}

export function CustomConnectionsSettings({ onChanged }: { onChanged: () => void }) {
  const [connections, setConnections] = useState<readonly CustomConnectionView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listCustomConnections();
    if (result.ok) setConnections(result.connections);
    else setMessage({ ok: false, text: result.message });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (draft === null) return;
    const request = saveRequest(draft);
    if (!request.ok) {
      setMessage({ ok: false, text: request.message });
      return;
    }
    setBusy(true);
    const result = await saveCustomConnection(request.save);
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setConnections(result.connections);
    // Stay in the editor on the saved connection, so Test and Import work next.
    const saved = request.save.id === undefined
      ? result.connections.at(-1)
      : result.connections.find((connection) => connection.id === request.save.id);
    setDraft(saved === undefined ? null : draftFrom(saved));
    setMessage({ ok: true, text: "Saved." });
    onChanged();
  };

  const remove = async (connection: CustomConnectionView) => {
    setBusy(true);
    const result = await removeCustomConnection(connection.id);
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setConnections(result.connections);
    if (draft?.id === connection.id) setDraft(null);
    setMessage(null);
    onChanged();
  };

  return <>
    <div className="settings-row">
      <div className={`settings-icon ${connections.some((connection) => connection.models.length > 0) ? "green" : ""}`}><Server size={17} /></div>
      <div>
        <strong>Your own models</strong>
        {/* The explanation is for someone who has none yet; once they do, the
            list below says it better. */}
        <span>{connections.length === 0
          ? "An API key for OpenAI, Anthropic, OpenRouter and others, or a model server on this computer. Requests go straight from here to that endpoint."
          : "Requests go straight from this computer to each endpoint."}</span>
      </div>
      {draft === null && <button className="small-button" disabled={busy} onClick={() => { setDraft(emptyDraft()); setMessage(null); }}><Plus size={14} /> Add</button>}
    </div>
    {connections.map((connection) => draft?.id === connection.id ? null : <div className="settings-row settings-subrow" key={connection.id}>
      <div className="settings-subicon"><KeyRound size={14} /></div>
      <div><strong>{connection.name}</strong><span>{connectionSummary(connection)}</span></div>
      <div className="settings-actions">
        <button className="small-button" disabled={busy || draft !== null} onClick={() => { setDraft(draftFrom(connection)); setMessage(null); }} aria-label={`Edit ${connection.name}`}><Pencil size={14} /></button>
        <button className="small-button" disabled={busy} onClick={() => void remove(connection)} aria-label={`Remove ${connection.name}`}><Trash2 size={14} /></button>
      </div>
    </div>)}
    {draft !== null && <ConnectionEditor
      draft={draft}
      busy={busy}
      saved={draft.id === undefined ? undefined : connections.find((connection) => connection.id === draft.id)}
      onChange={setDraft}
      onSave={() => void save()}
      onCancel={() => { setDraft(null); setMessage(null); }}
    />}
    {message && <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.text}</p>}
  </>;
}

function ConnectionEditor({ draft, busy, saved, onChange, onSave, onCancel }: {
  draft: Draft;
  busy: boolean;
  /** The saved version, when this edits an existing connection; Test and Import work against it. */
  saved: CustomConnectionView | undefined;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [tests, setTests] = useState<Record<string, { pending: boolean; ok?: boolean; text?: string }>>({});
  const [imported, setImported] = useState<readonly string[] | null>(null);
  const [importFilter, setImportFilter] = useState("");
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  const update = (changes: Partial<Draft>) => onChange({ ...draft, ...changes });
  const updateModel = (index: number, changes: Partial<DraftModel>) =>
    update({ models: draft.models.map((model, position) => position === index ? { ...model, ...changes } : model) });

  const applyPreset = (preset: Preset) => update({
    name: draft.name.trim() === "" ? preset.name : draft.name,
    format: preset.format,
    baseUrl: preset.baseUrl,
  });

  const isSavedModel = (model: DraftModel) => {
    const match = saved?.models.find((entry) => entry.id === model.id.trim());
    return match !== undefined && saved?.baseUrl === draft.baseUrl.trim() && saved.format === draft.format &&
      match.images === model.images && match.efforts.join() === sortCustomReasoningEfforts(model.efforts).join();
  };

  const test = async (model: DraftModel) => {
    if (saved === undefined) return;
    const id = model.id.trim();
    setTests((current) => ({ ...current, [id]: { pending: true } }));
    const result = await testCustomModel(saved.id, id);
    setTests((current) => ({ ...current, [id]: { pending: false, ok: result.ok, text: result.message } }));
  };

  const loadImport = async () => {
    if (saved === undefined) return;
    setImportMessage("Reading the endpoint's model list…");
    const result = await importCustomModels(saved.id);
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

  const addChosen = () => {
    const room = MAX_CUSTOM_MODELS - draft.models.length;
    const added = [...chosen].slice(0, room).map((id) => draftModel({ id, displayName: id, images: true, efforts: [] }));
    update({ models: [...draft.models, ...added] });
    setImported(null);
    setChosen(new Set());
    setImportFilter("");
  };

  return <div className="custom-editor">
    <div className="custom-presets">
      {PRESETS.map((preset) => <button key={preset.name} className="small-button" onClick={() => applyPreset(preset)} title={preset.baseUrl}>{preset.name}</button>)}
    </div>
    <label className="custom-field"><span>Name</span><input value={draft.name} maxLength={60} placeholder="e.g. OpenRouter" onChange={(event) => update({ name: event.target.value })} /></label>
    <div className="custom-field-pair">
      <label className="custom-field"><span>API format</span>
        <select value={draft.format} onChange={(event) => update({ format: event.target.value as CustomApiFormat })}>
          {CUSTOM_API_FORMATS.map((format) => <option key={format} value={format}>{FORMAT_LABELS[format]}</option>)}
        </select>
      </label>
      <label className="custom-field grow"><span>Base URL</span><input value={draft.baseUrl} spellCheck={false} placeholder={draft.format === "anthropic" ? "https://api.anthropic.com/v1" : "https://…/v1"} onChange={(event) => update({ baseUrl: event.target.value })} /></label>
    </div>
    <label className="custom-field"><span>API key {draft.hasKey && !draft.removeKey ? "(saved; type a new one to replace it)" : "(leave empty for a local server)"}</span>
      <div className="custom-key-row">
        <input type="password" value={draft.apiKey} spellCheck={false} autoComplete="off" disabled={draft.removeKey} placeholder={draft.hasKey && !draft.removeKey ? "••••••••" : "sk-…"} onChange={(event) => update({ apiKey: event.target.value })} />
        {draft.hasKey && <button className="small-button" onClick={() => update({ removeKey: !draft.removeKey, apiKey: "" })}>{draft.removeKey ? "Keep key" : "Remove key"}</button>}
      </div>
    </label>

    <div className="custom-models-header">
      <strong>Models</strong>
      <div className="settings-actions">
        {saved !== undefined && <button className="small-button" onClick={() => void loadImport()}>Import from endpoint</button>}
        <button className="small-button" disabled={draft.models.length >= MAX_CUSTOM_MODELS} onClick={() => update({ models: [...draft.models, draftModel()] })}><Plus size={14} /> Model</button>
      </div>
    </div>
    {saved === undefined && <p className="custom-hint">Save the connection to test models or import the endpoint's model list.</p>}
    {importMessage && <p className="custom-hint">{importMessage}</p>}
    {imported !== null && <div className="custom-import">
      <input value={importFilter} placeholder={`Filter ${imported.length} models`} spellCheck={false} onChange={(event) => setImportFilter(event.target.value)} />
      <div className="custom-import-list">
        {visibleImports.map((id) => <label key={id}><input type="checkbox" checked={chosen.has(id)} onChange={(event) => setChosen((current) => {
          const next = new Set(current);
          if (event.target.checked) next.add(id); else next.delete(id);
          return next;
        })} /> {id}</label>)}
        {visibleImports.length === 0 && <span className="custom-hint">No models match.</span>}
      </div>
      <div className="settings-actions">
        <button className="small-button" disabled={chosen.size === 0} onClick={addChosen}>Add {chosen.size || ""} selected</button>
        <button className="small-button" onClick={() => setImported(null)}>Close</button>
      </div>
    </div>}
    {draft.models.map((model, index) => {
      const result = tests[model.id.trim()];
      return <div className="custom-model" key={index}>
        <div className="custom-field-pair">
          <label className="custom-field grow"><span>Model id</span><input value={model.id} spellCheck={false} placeholder="e.g. deepseek/deepseek-chat" onChange={(event) => updateModel(index, { id: event.target.value })} /></label>
          <label className="custom-field grow"><span>Display name</span><input value={model.displayName} maxLength={60} placeholder={model.id || "Shown in the model picker"} onChange={(event) => updateModel(index, { displayName: event.target.value })} /></label>
        </div>
        <div className="custom-model-options">
          <label title="Screenshots and attached images are sent only to models that accept them."><input type="checkbox" checked={model.images} onChange={(event) => updateModel(index, { images: event.target.checked })} /> Sees images</label>
          <label className="custom-number" title="Tokens the model can hold. Roqer keeps less tool output for a small model."><span>Context</span><input value={model.contextWindow} inputMode="numeric" placeholder="optional" onChange={(event) => updateModel(index, { contextWindow: event.target.value })} /></label>
          <label className="custom-number" title="The longest answer to ask for in one turn, thinking included. Writing a whole UI builder takes around 10,000 tokens."><span>Max output</span><input value={model.maxOutputTokens} inputMode="numeric" placeholder={draft.format === "anthropic" ? String(DEFAULT_ANTHROPIC_MAX_OUTPUT) : "endpoint's"} onChange={(event) => updateModel(index, { maxOutputTokens: event.target.value })} /></label>
          <div className="settings-actions">
            {isSavedModel(model) && <button className="small-button" disabled={result?.pending === true} onClick={() => void test(model)}>{result?.pending ? "Testing…" : "Test"}</button>}
            <button className="small-button" onClick={() => update({ models: draft.models.filter((_, position) => position !== index) })} aria-label={`Remove ${model.id || "model"}`}><X size={14} /></button>
          </div>
        </div>
        <EffortPicker efforts={model.efforts} onChange={(efforts) => updateModel(index, { efforts })} />
        {result?.text && <p className={`custom-message ${result.ok ? "ok" : "error"}`}>{result.ok ? <Check size={13} /> : null} {result.text}</p>}
      </div>;
    })}
    <p className="custom-hint">Roqer works through tool calls, so use models that support them. Small local models may not follow its instructions well.</p>
    <div className="modal-actions">
      <button className="secondary-action" onClick={onCancel}>Cancel</button>
      <button className="primary-action" disabled={busy || draft.name.trim() === "" || draft.baseUrl.trim() === ""} onClick={onSave}>{busy ? "Saving…" : "Save connection"}</button>
    </div>
  </div>;
}

const EFFORT_LABELS: Record<CustomReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

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
  return <div className="custom-efforts" role="group" aria-label="Reasoning efforts this model takes">
    <span title="The levels you can pick in the composer for this model. Choose none if the model has no reasoning setting.">Reasoning effort</span>
    {CUSTOM_REASONING_EFFORTS.map((effort) => <button
      key={effort}
      type="button"
      className="custom-effort"
      aria-pressed={chosen.has(effort)}
      title={effort === "none" ? "Sends \"none\": the endpoint accepts it to turn reasoning off." : `Sends "${effort}".`}
      onClick={() => toggle(effort)}
    >{EFFORT_LABELS[effort]}</button>)}
    {chosen.size === 0 && <em>not sent</em>}
  </div>;
}
