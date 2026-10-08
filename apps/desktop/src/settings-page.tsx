import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { appVersionDetail, type AppUpdateState } from "../shared/app-update";
import type { CustomConnectionView } from "../shared/custom-providers";
import { ENABLED_PROVIDER_IDS, providerLabel, type ProviderId, type ProviderStatus } from "../shared/provider";
import { NO_LIMITS, type ProviderLimits } from "../shared/provider-limits";
import type { StudioStatus } from "../shared/studio-status";
import type { WorkspaceState } from "./model";
import { accountDetail } from "./account-detail";
import { BlenderSettings } from "./blender-settings";
import { DiagnosticsActions } from "./diagnostics-actions";
import { EndpointPage, endpointDetail, useCustomConnections } from "./custom-connections";
import { OpenCloudSettings } from "./open-cloud-settings";
import {
  cancelProviderLogin, getAppVersion, getProviderLimits, getProviderStatus, installProviderClient, loginProvider, openProviderLogin, submitProviderCode,
  waitForProviderLogin,
} from "./platform";
import { planUsageView } from "./plan-usage";
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

const ACCOUNT_CLIENTS: Partial<Record<ProviderId, string>> = {
  chatgpt: "Codex", claude: "Claude Code", antigravity: "Antigravity CLI",
};

/**
 * What a plan's limits cover: ChatGPT meters Codex apart from chat, while
 * Claude's limits are shared by every Claude app. Antigravity meters groups of
 * models apart, and the meter shows its Gemini group.
 */
const USAGE_SCOPES: Partial<Record<ProviderId, string>> = { chatgpt: "Codex", claude: "Claude", antigravity: "Gemini models" };

/**
 * Where Roqer's source and licence are published. The About group shows them
 * with the copyright and the no-warranty statement: the notices the GNU AGPL
 * asks an interactive program to display, and asks modified copies to keep.
 */
const SOURCE_URL = "https://github.com/S4US/Roqer";
const LICENSE_URL = "https://github.com/S4US/Roqer/blob/main/LICENSE";

/**
 * The endpoint page on screen. `key` names the visit, not the endpoint: a new
 * endpoint keeps its page when its first save gives it an id, so a model list
 * that save was made to fetch still lands on the page that asked for it.
 */
type EndpointView = { key: string; id?: string };

let nextEndpointVisit = 0;

export function SettingsPage({ preferences, studioStatus, updateState, notice, onPreferences, onStudioRefresh, onProviderChanged, onExport, onClose }: {
  preferences: WorkspaceState["preferences"];
  studioStatus: StudioStatus;
  updateState: AppUpdateState;
  /** Why Settings opened, when something other than the person opened it. Shown on Models. */
  notice?: string;
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
  /** Asked of the running app rather than built in, so it is the version actually running. */
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppVersion().then((version) => { if (!cancelled) setAppVersion(version); }, () => undefined);
    return () => { cancelled = true; };
  }, []);

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
            {notice !== undefined && <p className="settings-notice" role="status">{notice}</p>}
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
          <SettingsGroup title="Troubleshooting" footnote="The report has Roqer's version, the bridge's state, what it sees of Studio and the end of its log. Your user folder and place names are left out.">
            <SettingsRow title="Studio connection" detail="For a bug report about Studio or playtests">
              <DiagnosticsActions endpoint={preferences.mcpEndpoint} buttonClassName="small-button" />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="About">
            <SettingsRow title="Version" detail={appVersionDetail(appVersion, updateState)} />
            <SettingsRow title="License" detail="Roqer is free software: you may share and change it under the GNU Affero General Public License, version 3 or later. It comes with no warranty.">
              <a className="small-button" href={LICENSE_URL} target="_blank" rel="noreferrer">View license</a>
            </SettingsRow>
            <SettingsRow title="Source code" detail="Copyright © 2026 S4US and the Roqer contributors">
              <a className="small-button" href={SOURCE_URL} target="_blank" rel="noreferrer">Open on GitHub</a>
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
 * is not, or installing the client it runs through when that is missing. Each
 * row asks about its own provider, so both accounts show their real state
 * whichever one the composer is using.
 */
function AccountRow({ provider, onChanged }: { provider: ProviderId; onChanged: () => void }) {
  const [status, setStatus] = useState<ProviderStatus>({ kind: "checking", message: "Checking…" });
  const [pending, setPending] = useState(false);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installNote, setInstallNote] = useState<{ message: string; command?: string } | null>(null);
  const [limits, setLimits] = useState<ProviderLimits>(NO_LIMITS);
  /** What the row says while a sign-in is open in the browser; null when none is. */
  const [waitingMessage, setWaitingMessage] = useState<string | null>(null);
  /** Bumped when a sign-in is cancelled, replaced, or settled by a pasted code, so an older wait cannot touch the row. */
  const loginAttempt = useRef(0);
  const name = providerLabel(provider);

  const refresh = useCallback(async () => {
    const next = await getProviderStatus(provider);
    setStatus(next);
    // Usage belongs to a signed-in account; without one there is nothing to show.
    setLimits(next.kind === "signed-in" ? await getProviderLimits(provider) : NO_LIMITS);
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
    setAwaitingCode(result.awaitingCode === true);
    // Connect the moment the sign-in finishes in the browser, not on the
    // row's next status check; Claude's code field stays as the fallback.
    const attempt = ++loginAttempt.current;
    setWaitingMessage(result.message);
    const done = await waitForProviderLogin(provider);
    if (loginAttempt.current !== attempt) return;
    setWaitingMessage(null);
    setAwaitingCode(false);
    setCode("");
    setCodeError(null);
    if (!done.ok) {
      setStatus({ kind: "signed-out", message: done.message });
      return;
    }
    await refresh();
    onChanged();
  };

  const openLoginPage = async () => {
    const result = await openProviderLogin(provider);
    setCodeError(result.ok ? null : result.message);
  };

  const cancel = async () => {
    loginAttempt.current += 1;
    setWaitingMessage(null);
    setAwaitingCode(false);
    setCode("");
    setCodeError(null);
    await cancelProviderLogin(provider);
    await refresh();
  };

  const install = async () => {
    setInstalling(true);
    setInstallNote(null);
    const result = await installProviderClient(provider);
    setInstalling(false);
    if (!result.ok) {
      setInstallNote({ message: result.message, ...(result.command === undefined ? {} : { command: result.command }) });
      return;
    }
    await refresh();
    onChanged();
  };

  const finish = async () => {
    setPending(true);
    const result = await submitProviderCode(provider, code);
    setPending(false);
    if (!result.ok) {
      setCodeError(result.message);
      return;
    }
    // The code settled it; the browser wait ending too changes nothing.
    loginAttempt.current += 1;
    setWaitingMessage(null);
    setAwaitingCode(false);
    setCode("");
    setCodeError(null);
    await refresh();
    onChanged();
  };

  const signedIn = status.kind === "signed-in";
  // Signing in needs the client, so without it the row can only look again.
  const canCheckOnly = signedIn || status.kind === "not-installed";
  const client = ACCOUNT_CLIENTS[provider];
  const installable = status.kind === "not-installed" && status.installable === true;
  const detail = !signedIn && installing
    ? `Installing ${client ?? name}… This can take a few minutes.`
    : !signedIn && waitingMessage !== null ? waitingMessage : accountDetail(status, client);
  const usage = signedIn ? planUsageView(limits, USAGE_SCOPES[provider] ?? name, Date.now()) : null;

  return <>
    <SettingsRow title={name} detail={detail}>
      {installable && <button type="button" className="small-button" disabled={installing} onClick={() => void install()}>{installing ? "Installing…" : "Install"}</button>}
      {waitingMessage !== null && !signedIn
        ? <>
          <button type="button" className="small-button" disabled>Waiting…</button>
          <button type="button" className="small-button" onClick={() => void cancel()}>Cancel</button>
        </>
        : canCheckOnly
          ? <button type="button" className="small-button" disabled={installing} onClick={() => void refresh()}>Check</button>
          : <button type="button" className="small-button" disabled={pending || status.kind === "checking"} onClick={() => void connect()}>{pending ? "Opening…" : "Connect"}</button>}
    </SettingsRow>
    {usage !== null && <div className="plan-usage">
      {usage.reached && <p className="plan-usage-reached">{name} reports this plan's usage limit is reached.</p>}
      {usage.rows.map((row) => <div key={row.label} className={`plan-usage-row ${row.tone}`}>
        <span className="plan-usage-label">{row.label}</span>
        <span className="plan-usage-track" role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.percent}>
          <span style={{ width: `${row.percent}%` }} />
        </span>
        <span className="plan-usage-detail">{row.detail}</span>
      </div>)}
      <p className="plan-usage-note">{usage.footnote}</p>
    </div>}
    {/* A failed install says why and gives the vendor's command to run by hand;
        a declined one just says so. */}
    {installNote !== null && status.kind === "not-installed" && <p className={`custom-message${installNote.command === undefined ? "" : " error"}`}>
      {installNote.message}
      {installNote.command !== undefined && <><br />To install it yourself, run this in PowerShell: <code className="settings-command">{installNote.command}</code></>}
    </p>}
    {/* Claude's fallback: a page that shows a code, opened only on request, so
        the tab Claude Code opened is the only one unless it failed to appear.
        Antigravity's sign-in always ends in a code, so there it is the way in. */}
    {awaitingCode && !signedIn && <label className="settings-field">
      <span>{provider === "antigravity" ? "Paste the code Google shows you" : `Or paste the code ${name} shows you`}</span>
      <div className="custom-key-row">
        <input value={code} spellCheck={false} placeholder="Authorization code" onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && code.trim()) void finish(); }} />
        <button type="button" className="small-button" disabled={pending || !code.trim()} onClick={() => void finish()}>{pending ? "Finishing…" : "Finish sign-in"}</button>
      </div>
      <span className="custom-message">
        Browser didn&apos;t open?{" "}
        <button type="button" className="link-button" onClick={() => void openLoginPage()}>Open the sign-in page</button>
      </span>
      {codeError !== null && <span className="custom-message error">{codeError}</span>}
    </label>}
  </>;
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
