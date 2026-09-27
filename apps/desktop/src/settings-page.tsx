import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CustomConnectionView } from "../shared/custom-providers";
import { ENABLED_PROVIDER_IDS, providerLabel, type ProviderId, type ProviderStatus } from "../shared/provider";
import type { StudioStatus } from "../shared/studio-status";
import type { WorkspaceState } from "./model";
import { BlenderSettings } from "./blender-settings";
import { EndpointPage, endpointDetail, useCustomConnections } from "./custom-connections";
import { OpenCloudSettings } from "./open-cloud-settings";
import { getProviderStatus, loginProvider, submitProviderCode } from "./platform";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-parts";

/**
 * Settings, as a page of the app rather than a dialog over it.
 *
 * The earlier dialog grew a second dialog for each endpoint and a dropdown on
 * top of that, three layers of floating panels with nothing that felt like a
 * place. Here each subject has its own page, reached from a sidebar, and an
 * endpoint opens as a page within Models.
 *
 * Which provider runs a chat is not a setting: it is chosen in the composer,
 * beside the model. This page only says what is available to choose from.
 */

export type SettingsSectionId = "models" | "roblox" | "blender" | "app";

const SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "models", label: "Models" },
  { id: "roblox", label: "Roblox" },
  { id: "blender", label: "Blender" },
  { id: "app", label: "App" },
];

/** A subscription account; the Custom provider is the endpoints list instead. */
const ACCOUNT_PROVIDERS = ENABLED_PROVIDER_IDS.filter((provider) => provider !== "custom");

const ACCOUNT_CLIENTS: Partial<Record<ProviderId, string>> = { chatgpt: "Codex", claude: "Claude Code" };

/**
 * The endpoint page on screen. `key` names the visit, not the endpoint: a new
 * endpoint keeps its page when its first save gives it an id, so a model list
 * that save was made to fetch still lands on the page that asked for it.
 */
type EndpointView = { key: string; id?: string };

let nextEndpointVisit = 0;

export function SettingsPage({ preferences, studioStatus, onPreferences, onStudioRefresh, onProviderChanged, onExport, onClose }: {
  preferences: WorkspaceState["preferences"];
  studioStatus: StudioStatus;
  onPreferences: (changes: Partial<WorkspaceState["preferences"]>) => void;
  onStudioRefresh: () => void;
  /** An account signed in, or an endpoint was added, edited or removed. */
  onProviderChanged: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSectionId>("models");
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);
  const [endpointDirty, setEndpointDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const endpoints = useCustomConnections();
  const mainRef = useRef<HTMLElement>(null);

  /** Leave the endpoint page, asking first when it holds unsaved changes. */
  const guarded = useCallback((leave: () => void) => {
    if (endpointDirty) setPendingLeave(() => leave);
    else leave();
  }, [endpointDirty]);

  const close = useCallback(() => guarded(onClose), [guarded, onClose]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || pendingLeave !== null) return;
      close();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [close, pendingLeave]);

  // A new page starts at its top, the way a page does.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [section, endpoint]);

  const openSection = (next: SettingsSectionId) => guarded(() => {
    setSection(next);
    setEndpoint(null);
  });

  const editing = endpoint?.id === undefined
    ? undefined
    : endpoints.connections?.find((connection) => connection.id === endpoint.id);

  return <div className="settings-page" role="region" aria-label="Settings">
    <nav className="settings-nav" aria-label="Settings sections">
      <button type="button" className="settings-nav-back" onClick={close}><ChevronLeft size={15} /> Back to chats</button>
      {SECTIONS.map((entry) => <button
        key={entry.id}
        type="button"
        className="settings-nav-item"
        aria-current={section === entry.id ? "page" : undefined}
        onClick={() => openSection(entry.id)}
      >{entry.label}</button>)}
    </nav>

    <main className="settings-main" ref={mainRef}>
      <div className="settings-content">
        {section === "models" && (endpoint !== null && (endpoint.id === undefined || editing !== undefined)
          ? <EndpointPage
            key={endpoint.key}
            connection={editing}
            onBack={() => guarded(() => setEndpoint(null))}
            onDirtyChange={setEndpointDirty}
            onSaved={(connections: readonly CustomConnectionView[], saved: CustomConnectionView) => {
              endpoints.setConnections(connections);
              setEndpoint((current) => current === null ? null : { key: current.key, id: saved.id });
              onProviderChanged();
            }}
            onRemoved={(connections) => {
              endpoints.setConnections(connections);
              setEndpointDirty(false);
              setEndpoint(null);
              onProviderChanged();
            }}
          />
          : <>
            <PageHead title="Models" lede="The accounts and endpoints Roqer can use. You choose the model for each chat in the composer." />
            {ACCOUNT_PROVIDERS.length > 0 && <SettingsGroup title="Accounts">
              {ACCOUNT_PROVIDERS.map((provider) => <AccountRow key={provider} provider={provider} onChanged={onProviderChanged} />)}
            </SettingsGroup>}
            <SettingsGroup
              title="Your endpoints"
              action={<button type="button" className="text-button" onClick={() => setEndpoint({ key: `add-${nextEndpointVisit++}` })}><Plus size={14} /> Add endpoint</button>}
              footnote="Requests go straight from this computer to each endpoint. Keys are stored encrypted on this computer."
            >
              {endpoints.connections?.map((connection) => <button
                key={connection.id}
                type="button"
                className="settings-row settings-link"
                onClick={() => setEndpoint({ key: connection.id, id: connection.id })}
              >
                <span className="settings-row-text"><strong>{connection.name}</strong><span>{endpointDetail(connection)}</span></span>
                <ChevronRight size={16} className="settings-chevron" aria-hidden="true" />
              </button>)}
              {endpoints.connections?.length === 0 && <SettingsRow
                title="None yet"
                detail="An API key from OpenAI, Anthropic, OpenRouter and others, or a model server on this computer."
              />}
              {endpoints.error !== null && <p className="custom-message error">{endpoints.error}</p>}
            </SettingsGroup>
          </>)}

        {section === "roblox" && <>
          <PageHead title="Roblox" lede="How Roqer reaches Studio, and publishes to your account when you ask it to." />
          <SettingsGroup title="Studio">
            <SettingsRow title="Roblox Studio" detail={studioStatus.message}>
              <button type="button" className="small-button" onClick={onStudioRefresh}>Check</button>
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Publishing">
            <OpenCloudSettings />
          </SettingsGroup>
        </>}

        {section === "blender" && <>
          <PageHead title="Blender" lede="Let the agent model props and buildings in Blender, then bring them into Studio." />
          <BlenderSettings />
        </>}

        {section === "app" && <>
          <PageHead title="App" />
          <SettingsGroup>
            <SettingsRow title="Show Roqer on Discord" detail="Your profile shows that Roqer is open and whether it is busy. Never your place, scripts, or tasks.">
              <SettingsSwitch label="Show Roqer on Discord" checked={preferences.discordPresence} onChange={(discordPresence) => onPreferences({ discordPresence })} />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Your data">
            <SettingsRow title="Chats and settings" detail="Kept on this computer only">
              <button type="button" className="small-button" onClick={onExport}>Export chats</button>
            </SettingsRow>
          </SettingsGroup>
          {/* Only someone running their own bridge needs this, so it stays
              last and says who it is for. */}
          <SettingsGroup title="Advanced" footnote="Only change this if you run your own Studio bridge.">
            <label className="settings-field">
              <span>MCP endpoint</span>
              <input className="mono" value={preferences.mcpEndpoint} onChange={(event) => onPreferences({ mcpEndpoint: event.target.value })} spellCheck={false} />
            </label>
          </SettingsGroup>
        </>}
      </div>
    </main>

    {pendingLeave !== null && <LeaveConfirm
      onStay={() => setPendingLeave(null)}
      onLeave={() => {
        const leave = pendingLeave;
        setPendingLeave(null);
        setEndpointDirty(false);
        leave();
      }}
    />}
  </div>;
}

function PageHead({ title, lede }: { title: string; lede?: string }) {
  return <div className="settings-page-head">
    <h1>{title}</h1>
    {lede !== undefined && <p>{lede}</p>}
  </div>;
}

/**
 * One subscription account: whether it is signed in, and signing in when it
 * is not. Each row asks about its own provider, so both accounts show their
 * real state whichever one the composer is using.
 */
function AccountRow({ provider, onChanged }: { provider: ProviderId; onChanged: () => void }) {
  const [status, setStatus] = useState<ProviderStatus>({ kind: "checking", message: "Checking…" });
  const [pending, setPending] = useState(false);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const name = providerLabel(provider);

  const refresh = useCallback(async () => {
    setStatus(await getProviderStatus(provider));
  }, [provider]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const connect = async () => {
    setPending(true);
    setCodeError(null);
    const result = await loginProvider(provider);
    setPending(false);
    if (!result.ok) {
      setStatus({ kind: "unavailable", message: result.message });
      return;
    }
    setStatus({ kind: "signed-out", message: result.message });
    setAwaitingCode(result.awaitingCode === true);
    // A browser sign-in finishes on its own; look again shortly after.
    if (result.awaitingCode !== true) {
      window.setTimeout(() => void refresh().then(onChanged), 2_500);
    }
  };

  const finish = async () => {
    setPending(true);
    const result = await submitProviderCode(provider, code);
    setPending(false);
    if (!result.ok) {
      setCodeError(result.message);
      return;
    }
    setAwaitingCode(false);
    setCode("");
    setCodeError(null);
    await refresh();
    onChanged();
  };

  const signedIn = status.kind === "signed-in";
  const client = ACCOUNT_CLIENTS[provider];
  const detail = signedIn
    ? [status.planType === undefined ? undefined : capitalized(status.planType), status.email, client === undefined ? undefined : `through ${client}`]
      .filter((part): part is string => part !== undefined && part !== "")
      .join(" · ") || status.message
    : status.message;

  return <>
    <SettingsRow title={name} detail={detail}>
      {signedIn
        ? <button type="button" className="small-button" onClick={() => void refresh()}>Check</button>
        : <button type="button" className="small-button" disabled={pending || status.kind === "checking"} onClick={() => void connect()}>{pending ? "Opening…" : "Connect"}</button>}
    </SettingsRow>
    {awaitingCode && !signedIn && <label className="settings-field">
      <span>{`Paste the code ${name} showed you`}</span>
      <div className="custom-key-row">
        <input value={code} autoFocus spellCheck={false} placeholder="Authorization code" onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && code.trim()) void finish(); }} />
        <button type="button" className="small-button" disabled={pending || !code.trim()} onClick={() => void finish()}>{pending ? "Finishing…" : "Finish sign-in"}</button>
      </div>
      {codeError !== null && <span className="custom-message error">{codeError}</span>}
    </label>}
  </>;
}

function capitalized(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function LeaveConfirm({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onStay();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [onStay]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={onStay}>
    <div className="name-modal" role="alertdialog" aria-modal="true" aria-label="Discard changes?" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><h2>Discard changes?</h2></div><button type="button" className="icon-button" onClick={onStay} aria-label="Keep editing"><X size={19} /></button></div>
      <p>This endpoint has changes that are not saved yet.</p>
      <div className="modal-actions">
        <button type="button" className="secondary-action" autoFocus onClick={onStay}>Keep editing</button>
        <button type="button" className="danger-action" onClick={onLeave}>Discard</button>
      </div>
    </div>
  </div>;
}
