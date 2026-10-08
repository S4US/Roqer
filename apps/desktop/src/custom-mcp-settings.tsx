import { ChevronLeft, Plus } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_CUSTOM_MCP_CONNECTIONS, MAX_CUSTOM_MCP_NAME_CHARACTERS,
  type CustomMcpConnectionView, type CustomMcpSave,
} from "../shared/custom-mcp";
import {
  checkCustomMcpConnection, listCustomMcpConnections, removeCustomMcpConnection, saveCustomMcpConnection,
} from "./platform";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-parts";

type Message = { ok: boolean; text: string };
type Draft = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  environment: string;
  headers: string;
  clearEnvironment: boolean;
  clearHeaders: boolean;
};
type Field = "args" | "environment" | "headers";

function draftFrom(connection?: CustomMcpConnectionView): Draft {
  return {
    name: connection?.name ?? "",
    enabled: connection?.enabled ?? true,
    transport: connection?.transport ?? "stdio",
    command: connection?.command ?? "",
    args: JSON.stringify(connection?.args ?? []),
    url: connection?.url ?? "",
    environment: "",
    headers: "",
    clearEnvironment: false,
    clearHeaders: false,
  };
}

function parseSecretMap(value: string): Record<string, string> | undefined | null {
  if (value.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (Object.values(parsed).some((entry) => typeof entry !== "string")) return null;
    return parsed as Record<string, string>;
  } catch {
    // A parser's error can include secret text. Show only our own explanation.
    return null;
  }
}

function destinationChanged(draft: Draft, saved: CustomMcpConnectionView | undefined): boolean {
  if (saved === undefined) return false;
  if (draft.transport !== saved.transport) return true;
  if (draft.transport === "http") {
    try { return new URL(draft.url.trim()).href !== saved.url; }
    catch { return true; }
  }
  if (draft.command.trim() !== saved.command) return true;
  try { return JSON.stringify(JSON.parse(draft.args)) !== JSON.stringify(saved.args ?? []); }
  catch { return true; }
}

function requestFrom(draft: Draft, id?: string):
  { ok: true; save: CustomMcpSave } | { ok: false; field: Field; message: string } {
  const common = { ...(id === undefined ? {} : { id }), name: draft.name.trim(), enabled: draft.enabled };
  if (draft.transport === "stdio") {
    let args: unknown;
    try { args = JSON.parse(draft.args); } catch { args = null; }
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
      return { ok: false, field: "args", message: "Arguments must be a JSON array of strings, such as [\"--port\", \"3000\"]." };
    }
    const environment = draft.clearEnvironment ? undefined : parseSecretMap(draft.environment);
    if (environment === null) {
      return { ok: false, field: "environment", message: "Environment variables must be a JSON object with string values." };
    }
    return { ok: true, save: {
      ...common, transport: "stdio", command: draft.command.trim(), args: args as string[], headers: null,
      ...(draft.clearEnvironment ? { environment: null } : environment === undefined ? {} : { environment }),
    } };
  }
  const headers = draft.clearHeaders ? undefined : parseSecretMap(draft.headers);
  if (headers === null) {
    return { ok: false, field: "headers", message: "Headers must be a JSON object with string values." };
  }
  return { ok: true, save: {
    ...common, transport: "http", url: draft.url.trim(), environment: null,
    ...(draft.clearHeaders ? { headers: null } : headers === undefined ? {} : { headers }),
  } };
}

/** Main owns values and encryption. This hook receives only redacted views. */
export function useCustomMcpConnections() {
  const [connections, setConnections] = useState<readonly CustomMcpConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listCustomMcpConnections();
      if (result.ok) {
        setConnections(result.connections);
        setError(null);
      } else setError(result.message);
    } catch {
      setError("MCP connections could not be loaded. Try again.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { connections, error, loading, reload, setConnections };
}

function connectionSave(connection: CustomMcpConnectionView, enabled: boolean): CustomMcpSave {
  return connection.transport === "stdio"
    ? { id: connection.id, name: connection.name, enabled, transport: "stdio", command: connection.command, args: connection.args }
    : { id: connection.id, name: connection.name, enabled, transport: "http", url: connection.url };
}

/** A successful check says what was discovered, never that a server stays connected. */
function checkMessage(result: Awaited<ReturnType<typeof checkCustomMcpConnection>>): Message {
  return {
    ok: result.ok,
    text: result.ok
      ? `Check complete: ${result.tools} ${result.tools === 1 ? "tool" : "tools"} found. ${result.message}`
      : result.message,
  };
}

export function CustomMcpConnectionsList({ connections, error, loading, onReload, onAdd, onEdit, onConnections }: {
  connections: readonly CustomMcpConnectionView[] | null;
  error: string | null;
  loading: boolean;
  onReload: () => Promise<void>;
  onAdd: () => void;
  onEdit: (connection: CustomMcpConnectionView) => void;
  onConnections: (connections: readonly CustomMcpConnectionView[]) => void;
}) {
  const [pending, setPending] = useState<{ id: string; action: "enable" | "check" } | null>(null);
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const changeEnabled = async (connection: CustomMcpConnectionView, enabled: boolean) => {
    setPending({ id: connection.id, action: "enable" });
    try {
      const result = await saveCustomMcpConnection(connectionSave(connection, enabled));
      if (!active.current) return;
      if (result.ok) onConnections(result.connections);
      setMessages((current) => ({ ...current, [connection.id]: {
        ok: result.ok, text: result.ok ? (enabled ? "Enabled for agent runs." : "Disabled for agent runs.") : result.message,
      } }));
    } catch {
      if (active.current) setMessages((current) => ({ ...current, [connection.id]: { ok: false, text: "The connection could not be updated. Try again." } }));
    } finally { if (active.current) setPending(null); }
  };

  const check = async (connection: CustomMcpConnectionView) => {
    setPending({ id: connection.id, action: "check" });
    setMessages((current) => ({ ...current, [connection.id]: { ok: true, text: "Checking the server and reading its tool list…" } }));
    try {
      const result = await checkCustomMcpConnection(connection.id);
      if (active.current) setMessages((current) => ({ ...current, [connection.id]: checkMessage(result) }));
    } catch {
      if (active.current) setMessages((current) => ({ ...current, [connection.id]: { ok: false, text: "The connection check failed. Try again." } }));
    } finally { if (active.current) setPending(null); }
  };

  const unavailable = pending !== null || loading;
  return <div className="settings-subpage custom-mcp-settings">
    <div className="settings-page-head">
      <h1>MCP</h1>
      <p>Connect tool servers the agent can use alongside Studio.</p>
    </div>
    <SettingsGroup
      title="Your connections"
      action={<button type="button" className="text-button" disabled={unavailable || connections === null || connections.length >= MAX_CUSTOM_MCP_CONNECTIONS} onClick={onAdd}><Plus size={14} aria-hidden="true" /> Add connection</button>}
      footnote="Starting a local server runs its configured executable on this computer. External tools require your approval, including in Full auto. Read only blocks their calls."
    >
      {loading && <p className="custom-hint" role="status">Loading MCP connections…</p>}
      {error !== null && <div className="custom-editor">
        <p className="custom-message error" role="alert">{error}</p>
        <button type="button" className="small-button" disabled={unavailable} onClick={() => void onReload()}>Try again</button>
      </div>}
      {connections?.map((connection) => <Fragment key={connection.id}>
        <SettingsRow title={connection.name} detail={`${connection.enabled ? "Enabled" : "Disabled"} · ${connection.transport === "stdio" ? `Local stdio · ${connection.command ?? ""}` : `Streamable HTTP · ${connection.url ?? ""}`}`}>
          <button type="button" className="small-button" disabled={unavailable} onClick={() => onEdit(connection)}>Edit</button>
          <button type="button" className="small-button" disabled={unavailable} onClick={() => void check(connection)}>{pending?.id === connection.id && pending.action === "check" ? "Checking…" : "Check"}</button>
          <SettingsSwitch label={`Enable ${connection.name}`} checked={connection.enabled} disabled={unavailable} onChange={(enabled) => void changeEnabled(connection, enabled)} />
        </SettingsRow>
        {pending?.id === connection.id && pending.action === "enable" && <p className="custom-message" role="status">Saving {connection.name}…</p>}
        {messages[connection.id] !== undefined && <p className={`custom-message ${messages[connection.id].ok ? "ok" : "error"}`} role={messages[connection.id].ok ? "status" : "alert"}>{messages[connection.id].text}</p>}
      </Fragment>)}
      {!loading && connections?.length === 0 && <SettingsRow title="None yet" detail="Add a local stdio server or a Streamable HTTP endpoint." />}
      {connections !== null && connections.length >= MAX_CUSTOM_MCP_CONNECTIONS && <p className="custom-hint">All {MAX_CUSTOM_MCP_CONNECTIONS} connection slots are used. Remove a connection to add another.</p>}
    </SettingsGroup>
  </div>;
}

/** The editor holds only new secrets; saving clears them from the form. */
export function CustomMcpConnectionPage({ connection, connections, onBack, onSaved, onRemoved, onDirtyChange, onBusyChange }: {
  connection: CustomMcpConnectionView | undefined;
  connections: readonly CustomMcpConnectionView[];
  onBack: () => void;
  onSaved: (connections: readonly CustomMcpConnectionView[], saved: CustomMcpConnectionView) => void;
  onRemoved: (connections: readonly CustomMcpConnectionView[]) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [saved, setSaved] = useState(connection);
  const [draft, setDraft] = useState(() => draftFrom(connection));
  const [message, setMessage] = useState<Message | null>(null);
  const [fieldError, setFieldError] = useState<{ field: Field; message: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const active = useRef(true);
  const formRef = useRef<HTMLDivElement>(null);
  const adding = saved === undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(saved));
  const needsSave = adding || dirty;
  const canSave = busy === null && draft.name.trim() !== "" && (draft.transport === "stdio" ? draft.command.trim() !== "" : draft.url.trim() !== "");
  const changedServer = destinationChanged(draft, saved);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy !== null); }, [busy, onBusyChange]);
  useEffect(() => {
    if (fieldError !== null && busy === null) formRef.current?.querySelector<HTMLInputElement>(`[name="${fieldError.field}"]`)?.focus();
  }, [fieldError, busy]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; onDirtyChange(false); onBusyChange(false); };
  }, [onDirtyChange, onBusyChange]);

  const update = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(null);
    setFieldError(null);
  };

  const save = async (): Promise<CustomMcpConnectionView | undefined> => {
    const nextRequest = requestFrom(draft, saved?.id);
    if (!nextRequest.ok) {
      setFieldError(nextRequest);
      setMessage({ ok: false, text: "Check the highlighted field before saving." });
      return undefined;
    }
    const result = await saveCustomMcpConnection(nextRequest.save);
    if (!active.current) return undefined;
    if (!result.ok) { setMessage({ ok: false, text: result.message }); return undefined; }
    const next = saved === undefined
      ? result.connections.find((entry) => !connections.some((current) => current.id === entry.id))
      : result.connections.find((entry) => entry.id === saved.id);
    if (next === undefined) {
      setMessage({ ok: false, text: "The saved connection could not be read. Go back and reload MCP settings." });
      return undefined;
    }
    setSaved(next);
    setDraft(draftFrom(next));
    setFieldError(null);
    setMessage({ ok: true, text: "Saved." });
    onSaved(result.connections, next);
    return next;
  };

  const saveChanges = async () => {
    setBusy("save");
    try { await save(); }
    catch { if (active.current) setMessage({ ok: false, text: "The connection could not be saved. Try again." }); }
    finally { if (active.current) setBusy(null); }
  };

  const check = async () => {
    setBusy("check");
    setMessage({ ok: true, text: needsSave ? "Saving, then checking the server…" : "Checking the server and reading its tool list…" });
    try {
      const target = needsSave ? await save() : saved;
      if (target === undefined || !active.current) return;
      setMessage({ ok: true, text: "Checking the server and reading its tool list…" });
      const result = await checkCustomMcpConnection(target.id);
      if (active.current) setMessage(checkMessage(result));
    } catch {
      if (active.current) setMessage({ ok: false, text: "The connection check failed. Try again." });
    } finally { if (active.current) setBusy(null); }
  };

  const remove = async () => {
    if (saved === undefined) return;
    setBusy("remove");
    try {
      const result = await removeCustomMcpConnection(saved.id);
      if (!active.current) return;
      if (result.ok) onRemoved(result.connections);
      else { setConfirmRemove(false); setMessage({ ok: false, text: result.message }); }
    } catch {
      if (active.current) { setConfirmRemove(false); setMessage({ ok: false, text: "The connection could not be removed. Try again." }); }
    } finally { if (active.current) setBusy(null); }
  };

  const discard = () => {
    if (adding) { onBack(); return; }
    setDraft(draftFrom(saved));
    setFieldError(null);
    setMessage(null);
  };

  return <div className="settings-subpage custom-mcp-settings" ref={formRef}>
    <div className="settings-page-head">
      <button type="button" className="settings-back" disabled={busy !== null} onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /> MCP</button>
      <h1>{adding ? "Add an MCP connection" : saved.name}</h1>
    </div>
    <SettingsGroup title="Connection">
      <label className="settings-field">
        <span>Name</span>
        <input value={draft.name} maxLength={MAX_CUSTOM_MCP_NAME_CHARACTERS} autoFocus={adding} disabled={busy !== null} placeholder="e.g. My tools" onChange={(event) => update({ name: event.target.value })} />
      </label>
      <SettingsRow title="Enable for agent runs" detail="Checks work even when the connection is disabled.">
        <SettingsSwitch label="Enable for agent runs" checked={draft.enabled} disabled={busy !== null} onChange={(enabled) => update({ enabled })} />
      </SettingsRow>
      <div className="settings-field">
        <span id="custom-mcp-transport">Transport</span>
        <div className="settings-segmented" role="group" aria-labelledby="custom-mcp-transport">
          <button type="button" disabled={busy !== null} aria-pressed={draft.transport === "stdio"} onClick={() => update({ transport: "stdio" })}>Local stdio</button>
          <button type="button" disabled={busy !== null} aria-pressed={draft.transport === "http"} onClick={() => update({ transport: "http" })}>Streamable HTTP</button>
        </div>
      </div>
      {draft.transport === "stdio" ? <>
        <label className="settings-field">
          <span>Executable</span>
          <input className="mono" value={draft.command} disabled={busy !== null} spellCheck={false} placeholder="Command or full path" onChange={(event) => update({ command: event.target.value })} />
        </label>
        <label className="settings-field">
          <span>Arguments (JSON)</span>
          <input className="mono" name="args" value={draft.args} disabled={busy !== null} spellCheck={false} aria-invalid={fieldError?.field === "args" || undefined} aria-describedby={fieldError?.field === "args" ? "custom-mcp-args-error" : undefined} onChange={(event) => update({ args: event.target.value })} />
          {fieldError?.field === "args" && <span id="custom-mcp-args-error" className="custom-message error">{fieldError.message}</span>}
        </label>
      </> : <label className="settings-field">
        <span>Server URL</span>
        <input className="mono" value={draft.url} disabled={busy !== null} spellCheck={false} placeholder="https://example.com/mcp" onChange={(event) => update({ url: event.target.value })} />
      </label>}
    </SettingsGroup>
    <SettingsGroup title="Secrets" footnote="Values are encrypted on this computer and never shown again. A JSON object replaces all saved values of that kind.">
      {changedServer && saved !== undefined && saved.environmentKeys.length + saved.headerKeys.length > 0 && <p className="custom-hint" role="status">Changing the server clears its saved secrets. Enter them again to use them with this server.</p>}
      <SecretField
        kind={draft.transport === "stdio" ? "environment" : "headers"}
        value={draft.transport === "stdio" ? draft.environment : draft.headers}
        clear={draft.transport === "stdio" ? draft.clearEnvironment : draft.clearHeaders}
        keys={draft.transport === "stdio" ? saved?.environmentKeys ?? [] : saved?.headerKeys ?? []}
        destinationChanged={changedServer}
        disabled={busy !== null}
        error={fieldError}
        onChange={(value) => update(draft.transport === "stdio" ? { environment: value } : { headers: value })}
        onClear={(clear) => update(draft.transport === "stdio" ? { clearEnvironment: clear, environment: "" } : { clearHeaders: clear, headers: "" })}
      />
    </SettingsGroup>
    <SettingsGroup title="Check" footnote={draft.transport === "stdio"
      ? "Checking starts this executable on this computer and reads its tool list. It does not call a tool."
      : "Use HTTPS, or HTTP on loopback only. Checking reads the server's tool list without calling a tool."}>
      <SettingsRow title="Discover tools" detail="External tools require approval, including in Full auto. Read only blocks calls.">
        <button type="button" className="small-button" disabled={!canSave} onClick={() => void check()}>{busy === "check" ? "Checking…" : needsSave ? "Save & check" : "Check"}</button>
      </SettingsRow>
    </SettingsGroup>
    {!adding && <div className="settings-danger">
      {confirmRemove ? <>
        <span>Remove {saved.name} and its saved secrets from this computer?</span>
        <button type="button" className="small-button" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep</button>
        <button type="button" className="small-button danger" disabled={busy !== null} onClick={() => void remove()}>{busy === "remove" ? "Removing…" : "Remove"}</button>
      </> : <>
        <span>The agent will no longer have tools from this connection.</span>
        <button type="button" className="small-button danger-outline" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove connection…</button>
      </>}
    </div>}
    {(needsSave || message !== null) && <div className="settings-savebar" role="region" aria-label="Save changes">
      {message === null
        ? <p className="settings-savebar-note">{adding ? "Not added yet." : "You have unsaved changes."}</p>
        : <p className={`custom-message ${message.ok ? "ok" : "error"}`} role={message.ok ? "status" : "alert"}>{message.text}</p>}
      {needsSave && <>
        <button type="button" className="secondary-action" disabled={busy !== null} onClick={discard}>{adding ? "Cancel" : "Discard"}</button>
        <button type="button" className="primary-action" disabled={!canSave} onClick={() => void saveChanges()}>{busy === "save" ? "Saving…" : adding ? "Add connection" : "Save"}</button>
      </>}
    </div>}
  </div>;
}

function SecretField({ kind, value, clear, keys, destinationChanged, disabled, error, onChange, onClear }: {
  kind: "environment" | "headers";
  value: string;
  clear: boolean;
  keys: readonly string[];
  destinationChanged: boolean;
  disabled: boolean;
  error: { field: Field; message: string } | null;
  onChange: (value: string) => void;
  onClear: (clear: boolean) => void;
}) {
  const invalid = error?.field === kind;
  const hint = clear ? "Saved values will be cleared when you save."
    : destinationChanged && keys.length > 0 ? "Changing the server clears saved values. Re-enter them to keep them."
      : keys.length > 0 ? "Leave blank to keep saved values." : "Optional JSON object with string values.";
  return <div className="settings-field">
    <span id={`custom-mcp-${kind}-label`}>{kind === "environment" ? "Environment (JSON)" : "Headers (JSON)"}</span>
    <div className="custom-mcp-secret">
      <div className="custom-key-row">
        <input type="password" name={kind} value={value} disabled={disabled || clear} spellCheck={false} autoComplete="off" aria-labelledby={`custom-mcp-${kind}-label`} aria-describedby={`custom-mcp-${kind}-hint${invalid ? ` custom-mcp-${kind}-error` : ""}`} aria-invalid={invalid || undefined} placeholder={clear ? "Cleared when saved" : keys.length > 0 ? "Enter new values to replace saved values" : "{}"} onChange={(event) => onChange(event.target.value)} />
        {keys.length > 0 && <button type="button" className="small-button" disabled={disabled} onClick={() => onClear(!clear)}>{clear ? "Undo clear" : "Clear values"}</button>}
      </div>
      <p id={`custom-mcp-${kind}-hint`} className="custom-hint">
        {keys.length > 0 && <>{destinationChanged ? "Previously saved keys" : "Saved keys"}: {keys.join(", ")}. </>}{hint}
      </p>
      {invalid && <p id={`custom-mcp-${kind}-error`} className="custom-message error">{error.message}</p>}
    </div>
  </div>;
}
