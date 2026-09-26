import { Check, ChevronDown, Download, Eye, KeyRound, Pencil, Plus, Server, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
 *
 * Settings lists the connections; adding or editing one opens its own dialog
 * above Settings, because a connection with a handful of models needs more
 * room than a row in a list can give it.
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

function connectionSummary(connection: CustomConnectionView): string {
  const models = connection.models.length;
  return [
    FORMAT_LABELS[connection.format],
    hostOf(connection.baseUrl),
    `${models} ${models === 1 ? "model" : "models"}`,
    connection.hasKey ? "key saved" : "no key",
  ].join(" · ");
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

export function CustomConnectionsSettings({ onChanged }: { onChanged: () => void }) {
  const [connections, setConnections] = useState<readonly CustomConnectionView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editorMessage, setEditorMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listCustomConnections();
    if (result.ok) setConnections(result.connections);
    else setMessage({ ok: false, text: result.message });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Save the draft and keep editing it; the saved connection, or undefined when it did not save. */
  const save = async (): Promise<CustomConnectionView | undefined> => {
    if (draft === null) return undefined;
    const request = saveRequest(draft);
    if (!request.ok) {
      setEditorMessage({ ok: false, text: request.message });
      return undefined;
    }
    setBusy(true);
    const result = await saveCustomConnection(request.save);
    setBusy(false);
    if (!result.ok) {
      setEditorMessage({ ok: false, text: result.message });
      return undefined;
    }
    setConnections(result.connections);
    // Stay in the editor on the saved connection, so Test and Import work next.
    const saved = request.save.id === undefined
      ? result.connections.at(-1)
      : result.connections.find((connection) => connection.id === request.save.id);
    setDraft(saved === undefined ? null : draftFrom(saved, draft));
    setEditorMessage({ ok: true, text: "Saved." });
    onChanged();
    return saved;
  };

  const remove = async (connection: CustomConnectionView) => {
    setConfirmRemove(null);
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

  const open = (next: Draft) => {
    setDraft(next);
    setEditorMessage(null);
    setMessage(null);
    setConfirmRemove(null);
  };

  const close = useCallback(() => {
    setDraft(null);
    setEditorMessage(null);
  }, []);

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
      <button className="small-button" disabled={busy} onClick={() => open(emptyDraft())}><Plus size={14} /> Add</button>
    </div>
    {connections.map((connection) => <div className="settings-row settings-subrow" key={connection.id}>
      <div className="settings-subicon"><KeyRound size={14} /></div>
      <div><strong>{connection.name}</strong><span>{connectionSummary(connection)}</span></div>
      <div className="settings-actions">
        {confirmRemove === connection.id
          ? <>
            <button className="small-button danger" disabled={busy} onClick={() => void remove(connection)}>Remove</button>
            <button className="small-button" onClick={() => setConfirmRemove(null)}>Keep</button>
          </>
          : <>
            <button className="small-button" disabled={busy} onClick={() => open(draftFrom(connection))} aria-label={`Edit ${connection.name}`}><Pencil size={14} /></button>
            <button className="small-button" disabled={busy} onClick={() => setConfirmRemove(connection.id)} aria-label={`Remove ${connection.name}`} title="Remove this connection and its saved key"><Trash2 size={14} /></button>
          </>}
      </div>
    </div>)}
    {message && <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.text}</p>}
    {draft !== null && createPortal(<ConnectionEditor
      draft={draft}
      busy={busy}
      saved={draft.id === undefined ? undefined : connections.find((connection) => connection.id === draft.id)}
      message={editorMessage}
      onChange={(next) => { setDraft(next); setEditorMessage(null); }}
      onSave={save}
      onClose={close}
    />, document.body)}
  </>;
}

function ConnectionEditor({ draft, busy, saved, message, onChange, onSave, onClose }: {
  draft: Draft;
  busy: boolean;
  /** The saved version, when this edits an existing connection; Test and Import work against it. */
  saved: CustomConnectionView | undefined;
  message: { ok: boolean; text: string } | null;
  onChange: (draft: Draft) => void;
  onSave: () => Promise<CustomConnectionView | undefined>;
  onClose: () => void;
}) {
  const [tests, setTests] = useState<Record<string, { pending: boolean; ok?: boolean; text?: string }>>({});
  const [imported, setImported] = useState<readonly string[] | null>(null);
  const [importFilter, setImportFilter] = useState("");
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const activePreset = PRESETS.find((preset) => preset.baseUrl === draft.baseUrl.trim() && preset.format === draft.format);
  // A preset fills the address, so its fields stay folded away until asked for.
  const [showEndpoint, setShowEndpoint] = useState(draft.baseUrl.trim() !== "" && activePreset === undefined);
  const endpointChosen = draft.baseUrl.trim() !== "" || showEndpoint;
  const dirty = isDirty(draft, saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Escape closes the editor, but never throws away edits.
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!dirtyRef.current) onClose();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [onClose]);

  const update = (changes: Partial<Draft>) => onChange({ ...draft, ...changes });
  const updateModel = (key: string, changes: Partial<DraftModel>) =>
    update({ models: draft.models.map((model) => model.key === key ? { ...model, ...changes } : model) });
  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const applyPreset = (preset: Preset) => {
    update({
      name: draft.name.trim() === "" || PRESETS.some((entry) => entry.name === draft.name.trim()) ? preset.name : draft.name,
      format: preset.format,
      baseUrl: preset.baseUrl,
    });
    setShowEndpoint(false);
  };

  const chooseOther = () => {
    if (activePreset !== undefined) update({ baseUrl: "" });
    setShowEndpoint(true);
  };

  /** The saved connection, saving the draft first when it has changes. */
  const savedForUse = async (): Promise<CustomConnectionView | undefined> => dirty || saved === undefined ? onSave() : saved;

  const test = async (model: DraftModel) => {
    const id = model.id.trim();
    if (id === "") return;
    setTests((current) => ({ ...current, [id]: { pending: true } }));
    const connection = await savedForUse();
    if (connection === undefined) {
      setTests((current) => ({ ...current, [id]: { pending: false } }));
      return;
    }
    const result = await testCustomModel(connection.id, id);
    setTests((current) => ({ ...current, [id]: { pending: false, ok: result.ok, text: result.message } }));
  };

  const loadImport = async () => {
    setImportMessage("Reading the endpoint's model list…");
    const connection = await savedForUse();
    if (connection === undefined) {
      setImportMessage(null);
      return;
    }
    const result = await importCustomModels(connection.id);
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

  const title = saved === undefined ? "Add a connection" : saved.name;
  const canSave = !busy && draft.name.trim() !== "" && draft.baseUrl.trim() !== "";
  const needsSaveFirst = dirty || saved === undefined;

  return <div className="modal-backdrop custom-dialog-backdrop" role="presentation" onMouseDown={() => { if (!dirty) onClose(); }}>
    <div className="custom-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <div className="custom-dialog-header">
        <div>
          <h2>{title}</h2>
          <span>Requests go straight from this computer to the endpoint.</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close" title={dirty ? "Close without saving" : "Close"}><X size={19} /></button>
      </div>

      <div className="custom-dialog-body">
        <section className="custom-section">
          <h3>Provider</h3>
          <div className="custom-provider-grid">
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
          </div>
        </section>

        {endpointChosen && <>
          <section className="custom-section">
            <h3>Connection</h3>
            <div className="custom-grid">
              <label className="custom-field"><span>Name</span><input value={draft.name} maxLength={60} placeholder="e.g. OpenRouter" onChange={(event) => update({ name: event.target.value })} /></label>
              <label className="custom-field"><span>API key {activePreset?.local ? "(not needed here)" : ""}</span>
                <div className="custom-key-row">
                  <input type="password" value={draft.apiKey} spellCheck={false} autoComplete="off" disabled={draft.removeKey} placeholder={draft.removeKey ? "Removed on save" : draft.hasKey ? "Saved · type to replace" : activePreset?.local ? "Leave empty" : "sk-…"} onChange={(event) => update({ apiKey: event.target.value })} />
                  {draft.hasKey && <button className="small-button" onClick={() => update({ removeKey: !draft.removeKey, apiKey: "" })}>{draft.removeKey ? "Keep key" : "Remove"}</button>}
                </div>
              </label>
            </div>
            {showEndpoint || activePreset === undefined
              ? <div className="custom-grid endpoint">
                <label className="custom-field"><span>API format</span>
                  <select value={draft.format} onChange={(event) => update({ format: event.target.value as CustomApiFormat })}>
                    {CUSTOM_API_FORMATS.map((format) => <option key={format} value={format}>{FORMAT_LABELS[format]}</option>)}
                  </select>
                </label>
                <label className="custom-field"><span>Base URL</span><input value={draft.baseUrl} spellCheck={false} autoFocus={draft.baseUrl === ""} placeholder={draft.format === "anthropic" ? "https://api.anthropic.com/v1" : "https://…/v1"} onChange={(event) => update({ baseUrl: event.target.value })} /></label>
              </div>
              : <p className="custom-endpoint-line">
                <span>{FORMAT_LABELS[draft.format]} · <code>{draft.baseUrl}</code></span>
                <button className="link-button" onClick={() => setShowEndpoint(true)}>Change</button>
              </p>}
          </section>

          <section className="custom-section">
            <div className="custom-section-header">
              <h3>Models <em>{draft.models.length} of {MAX_CUSTOM_MODELS}</em></h3>
              <div className="settings-actions">
                <button className="small-button" disabled={busy || room <= 0 || !canSave} onClick={() => void loadImport()} title={needsSaveFirst ? "Saves the connection, then reads its model list" : "Read the endpoint's model list"}><Download size={14} /> Import from endpoint</button>
                <button className="small-button" disabled={room <= 0} onClick={addManual}><Plus size={14} /> Add by id</button>
              </div>
            </div>
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
                <button className="small-button" onClick={() => setImported(null)}>Close</button>
                <button className="small-button primary" disabled={chosen.size === 0} onClick={addChosen}>Add {chosen.size || ""} selected</button>
              </div>
            </div>}
            {draft.models.length === 0 && imported === null && <p className="custom-empty">No models yet. Import them from the endpoint or add one by its id.</p>}
            <div className="custom-model-list">
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
            </div>
            <p className="custom-hint">Roqer works through tool calls, so use models that support them. Small local models may not follow its instructions well.</p>
          </section>
        </>}
      </div>

      <div className="custom-dialog-footer">
        {message && <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.ok ? <Check size={13} /> : null} {message.text}</p>}
        <button className="secondary-action" onClick={onClose}>{dirty ? "Cancel" : "Close"}</button>
        <button className="primary-action" disabled={!canSave || !dirty} onClick={() => void onSave()}>{busy ? "Saving…" : saved === undefined ? "Save connection" : "Save changes"}</button>
      </div>
    </div>
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
