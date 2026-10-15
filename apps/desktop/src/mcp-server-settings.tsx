import { Check, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  MAX_MCP_SECRETS,
  MAX_MCP_SERVERS,
  isMcpToolRisk,
  mcpServerTarget,
  parseMcpServerSave,
  type McpListedTool,
  type McpNewToolPolicy,
  type McpSecretSave,
  type McpServerSave,
  type McpServerTransport,
  type McpServerView,
} from "../shared/mcp-servers";
import type { ToolRisk } from "../shared/policy";
import {
  cancelMcpSignIn, listMcpServers, removeMcpServer, saveMcpServer, signInMcpServer, signOutMcpServer, testMcpServer,
} from "./platform";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-parts";

/**
 * Settings for the MCP servers the user adds.
 *
 * Roqer is the client: it starts a program on this computer or calls a URL,
 * and the model reaches the server's tools through one Roqer tool, under the
 * same approvals as a Studio call. A server describes its own tools and Roqer
 * cannot check what it says, so what each tool may do is the user's to set
 * here. The server's own hints are shown beside it and never applied.
 *
 * Secret values go to the main process once and never come back: a saved
 * environment variable or header shows only its name, and an edit that does
 * not touch it sends the name alone so the saved value is kept.
 *
 * The list and each server's page mirror the endpoints in Models: one row per
 * server, opening a page of Settings with a save bar that appears once
 * something has changed.
 */

const TRANSPORT_LABELS: Record<McpServerTransport, string> = { stdio: "Program", http: "URL" };

const TRANSPORT_TITLES: Record<McpServerTransport, string> = {
  stdio: "A program Roqer starts on this computer and talks to over stdio",
  http: "A server Roqer calls at a URL, over streamable HTTP",
};

/**
 * The default first. Adding a server is already the user trusting it, so its
 * tools count as Irreversible until set: Full auto, which the user picks to
 * run unattended, runs them, and every other mode asks.
 */
const NEW_TOOL_POLICIES: ReadonlyArray<{ policy: McpNewToolPolicy; label: string; hint: string }> = [
  { policy: "trust", label: "Treat as irreversible", hint: "A tool you have not set counts as Irreversible: Full auto runs it, every other mode asks first." },
  { policy: "review", label: "Ask every time", hint: "A tool you have not set asks before it runs in every mode, Full auto included." },
];

const RISK_OPTIONS: ReadonlyArray<{ risk: ToolRisk; label: string }> = [
  { risk: "read", label: "Read" },
  { risk: "mutation", label: "Edit" },
  { risk: "irreversible", label: "Irreversible" },
];

/** Third-party text is bounded before it reaches the page; the row clamps it further. */
const MAX_DESCRIPTION_CHARACTERS = 1_000;

type DraftSecret = {
  /** Identifies the row while it is edited; never saved. */
  key: string;
  name: string;
  /** A new value to save; empty on a saved row keeps the saved one. */
  value: string;
  /** Already saved under this name, so the name is fixed and the value optional. */
  saved: boolean;
};

export type McpDraft = {
  id?: string;
  name: string;
  enabled: boolean;
  transport: McpServerTransport;
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  /** Sign in with OAuth: URL servers only. */
  oauth: boolean;
  /** A client ID registered with the provider, for the rare server that needs one; empty for none. */
  oauthClientId: string;
  newTools: McpNewToolPolicy;
  toolRisk: Readonly<Record<string, ToolRisk>>;
  /**
   * Kept per transport: an environment variable is not a header, so switching
   * never carries a saved value from one to the other, and switching back
   * finds the rows as they were.
   */
  secrets: Readonly<Record<McpServerTransport, readonly DraftSecret[]>>;
};

let nextRowKey = 0;
const rowKey = () => `secret-${nextRowKey++}`;

export function emptyMcpDraft(): McpDraft {
  return {
    name: "", enabled: true, transport: "stdio", command: "", args: "", url: "", oauth: false, oauthClientId: "",
    newTools: "trust", toolRisk: {}, secrets: { stdio: [], http: [] },
  };
}

type McpServerPreset = Readonly<{
  id: string;
  title: string;
  description: string;
  setup: string;
  config: Partial<Pick<McpDraft, "name" | "transport" | "command" | "args" | "url" | "oauth">>;
  secretName?: string;
}>;

export const MCP_SERVER_PRESETS: readonly McpServerPreset[] = [
  {
    id: "meshy", title: "Meshy AI", description: "Create 3D models, textures and animations · API key",
    setup: "Paste your Meshy API key, then choose Save & test. Node.js must be installed; the official Meshy server downloads on first use. Generation uses your Meshy credits.",
    config: { name: "meshy", transport: "stdio", command: "npx", args: "-y\n@meshy-ai/meshy-mcp-server" },
    secretName: "MESHY_API_KEY",
  },
  {
    id: "elevenlabs", title: "ElevenLabs", description: "Generate speech and manage voice agents · Sign in",
    setup: "Choose Save & sign in to connect your ElevenLabs account in your browser. Nothing to install and no API key needed. Audio generation uses your ElevenLabs credits.",
    config: { name: "elevenlabs", transport: "http", url: "https://api.us.elevenlabs.io/v1/mcp", oauth: true },
  },
];

export function mcpDraftFromPreset(preset: McpServerPreset): McpDraft {
  const draft = { ...emptyMcpDraft(), ...preset.config };
  if (preset.secretName) draft.secrets = { stdio: [{ key: rowKey(), name: preset.secretName, value: "", saved: false }], http: [] };
  return draft;
}

export function mcpDraftFrom(server: McpServerView): McpDraft {
  const saved = server.secretNames.map((name): DraftSecret => ({ key: rowKey(), name, value: "", saved: true }));
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    url: server.url ?? "",
    oauth: server.auth === "oauth",
    oauthClientId: server.oauthClientId ?? "",
    newTools: server.newTools,
    toolRisk: { ...server.toolRisk },
    secrets: { stdio: server.transport === "stdio" ? saved : [], http: server.transport === "http" ? saved : [] },
  };
}

/** The arguments in a textarea, one per line; blank lines are not arguments. */
export function argumentsFromText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** Sorted, so a risk changed and changed back compares equal to the saved map. */
function sortedRisks(toolRisk: Readonly<Record<string, ToolRisk>>): Record<string, ToolRisk> {
  return Object.fromEntries(Object.entries(toolRisk).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The save request for a draft, or what is wrong with it. Only the chosen
 * transport's secrets are sent, always as a full list: a saved row without a
 * new value keeps its value, and a row the user removed is left out, which
 * removes it. The shared parser checks the rest, so the renderer says what the
 * main process would.
 */
export function mcpSaveRequest(draft: McpDraft): { ok: true; save: McpServerSave } | { ok: false; message: string } {
  const noun = draft.transport === "stdio" ? "environment variable" : "header";
  const secrets: McpSecretSave[] = [];
  for (const secret of draft.secrets[draft.transport]) {
    const name = secret.name.trim();
    const value = secret.value.trim();
    if (secret.saved) {
      secrets.push(value === "" ? { name } : { name, value });
      continue;
    }
    if (name === "" && value === "") continue;
    if (name === "") return { ok: false, message: `Give each ${noun} a name.` };
    if (value === "") return { ok: false, message: `Enter a value for ${name}.` };
    secrets.push({ name, value });
  }
  const common = {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    newTools: draft.newTools,
    toolRisk: sortedRisks(draft.toolRisk),
    secrets,
  };
  const clientId = draft.oauthClientId.trim();
  return parseMcpServerSave(draft.transport === "stdio"
    ? { ...common, command: draft.command.trim(), args: argumentsFromText(draft.args) }
    : {
      ...common,
      url: draft.url.trim(),
      ...(draft.oauth ? { auth: "oauth" } : {}),
      ...(draft.oauth && clientId !== "" ? { oauthClientId: clientId } : {}),
    });
}

/**
 * Whether the page holds something worth asking about before it is left. A
 * new server counts once anything is typed; a saved one when saving the draft
 * would change what is saved.
 */
export function isMcpDraftDirty(draft: McpDraft, saved: McpServerView | undefined): boolean {
  if (saved === undefined) {
    return [draft.name, draft.command, draft.args, draft.url, draft.oauthClientId].some((field) => field.trim() !== "") ||
      Object.keys(draft.toolRisk).length > 0 ||
      [...draft.secrets.stdio, ...draft.secrets.http].some((secret) => secret.name.trim() !== "" || secret.value.trim() !== "");
  }
  const request = mcpSaveRequest(draft);
  if (!request.ok) return true;
  const current = mcpSaveRequest(mcpDraftFrom(saved));
  return !current.ok || JSON.stringify(request.save) !== JSON.stringify(current.save);
}

export type McpToolRow = Readonly<{ name: string; risk?: ToolRisk; listed?: McpListedTool }>;

/**
 * The tools to show: the ones the last test listed, in the server's order,
 * then any the user classified that the test did not list, so a saved choice
 * is never hidden. Before a test, that is the saved choices alone.
 */
export function mcpToolRows(listed: readonly McpListedTool[] | null, toolRisk: Readonly<Record<string, ToolRisk>>): McpToolRow[] {
  const rows: McpToolRow[] = [];
  const seen = new Set<string>();
  for (const tool of listed ?? []) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    rows.push(hasOwn(toolRisk, tool.name) ? { name: tool.name, risk: toolRisk[tool.name], listed: tool } : { name: tool.name, listed: tool });
  }
  for (const [name, risk] of Object.entries(sortedRisks(toolRisk))) {
    if (!seen.has(name)) rows.push({ name, risk });
  }
  return rows;
}

/**
 * The risks with every tool the server calls read-only, and the user has not
 * set, set to Read. Only ever run from the user's own click, and saved only
 * when they save: the hint is the server's claim, so taking it is the user's
 * decision, never Roqer's.
 */
export function withReadOnlyHints(
  listed: readonly McpListedTool[] | null,
  toolRisk: Readonly<Record<string, ToolRisk>>,
): { toolRisk: Record<string, ToolRisk>; applied: number } {
  const next: Record<string, ToolRisk> = { ...toolRisk };
  let applied = 0;
  for (const tool of listed ?? []) {
    if (tool.readOnlyHint !== true || hasOwn(next, tool.name)) continue;
    next[tool.name] = "read";
    applied += 1;
  }
  return { toolRisk: next, applied };
}

/** One line per server: what it runs or calls, and only the exceptions after that. */
export function mcpServerDetail(server: McpServerView): string {
  const target = mcpServerTarget(server);
  const parts = [target.length > 80 ? `${target.slice(0, 79)}…` : target];
  const set = Object.keys(server.toolRisk).length;
  if (set > 0) parts.push(`${set} ${set === 1 ? "tool" : "tools"} set`);
  if (!server.enabled) parts.push("off");
  return parts.join(" · ");
}

/**
 * The server page on screen. `key` names the visit, not the server: a new
 * server keeps its page when its first save gives it an id, so a test that
 * save was made for lands on the page that asked for it.
 */
export type McpServerVisit = { key: string; id?: string; preset?: string };

let nextVisit = 0;

/**
 * The MCP servers section: the list, or one server's page. Which page is open
 * belongs to Settings, so changing section or leaving Settings closes it and
 * asks first when it holds unsaved changes.
 */
export function McpServerSettings({ visit, onVisit, guarded, onDirtyChange }: {
  visit: McpServerVisit | null;
  onVisit: (visit: McpServerVisit | null) => void;
  /** Runs `leave` now, or once the user agrees to discard the page's changes. */
  guarded: (leave: () => void) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [servers, setServers] = useState<readonly McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listMcpServers().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setServers(result.servers);
        setError(null);
      } else {
        setError(result.message);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const editing = visit?.id === undefined ? undefined : servers?.find((server) => server.id === visit.id);
  if (visit !== null && (visit.id === undefined || editing !== undefined)) {
    return <McpServerPage
      key={visit.key}
      server={editing}
      preset={MCP_SERVER_PRESETS.find((preset) => preset.id === visit.preset)}
      onBack={() => guarded(() => onVisit(null))}
      onDirtyChange={onDirtyChange}
      onSaved={(next, saved) => {
        setServers(next);
        onVisit({ ...visit, id: saved.id });
      }}
      onRemoved={(next) => {
        setServers(next);
        onDirtyChange(false);
        onVisit(null);
      }}
    />;
  }

  const full = servers !== null && servers.length >= MAX_MCP_SERVERS;
  return <>
    <div className="settings-page-head">
      <h1>MCP servers</h1>
      <p>Give the agent tools from other programs and services. You decide what each tool may do.</p>
    </div>
    <SettingsGroup title="Quick setup" footnote="Choose a service, then enter its API key or sign in. Each service uses your own account.">
      {MCP_SERVER_PRESETS.map((preset) => {
        const exists = servers?.some((server) => server.name === preset.config.name) === true;
        return <button key={preset.id} type="button" className="settings-row settings-link" disabled={full || exists}
          onClick={() => onVisit({ key: `add-${nextVisit++}`, preset: preset.id })}>
          <span className="settings-row-text"><strong>{preset.title}</strong><span>{exists ? "Already added · manage it below" : preset.description}</span></span>
          <ChevronRight size={16} className="settings-chevron" aria-hidden="true" />
        </button>;
      })}
    </SettingsGroup>
    <SettingsGroup
      title="Your servers"
      action={<button type="button" className="text-button" disabled={full} title={full ? `Up to ${MAX_MCP_SERVERS} servers` : undefined} onClick={() => onVisit({ key: `add-${nextVisit++}` })}><Plus size={14} /> Add server</button>}
      footnote="A program server runs on this computer with your permissions, and a URL server receives what the agent sends it. Only add servers you trust. Roqer treats everything a server says as untrusted text."
    >
      {servers?.map((server) => <button
        key={server.id}
        type="button"
        className="settings-row settings-link"
        onClick={() => onVisit({ key: server.id, id: server.id })}
      >
        <span className="settings-row-text"><strong>{server.name}</strong><span>{mcpServerDetail(server)}</span></span>
        <ChevronRight size={16} className="settings-chevron" aria-hidden="true" />
      </button>)}
      {servers?.length === 0 && <SettingsRow
        title="None yet"
        detail="A program on this computer, such as one started with npx, or a server at a URL."
      />}
      {error !== null && <p className="custom-message error">{error}</p>}
    </SettingsGroup>
  </>;
}

/**
 * One server, as a page of Settings. Nothing saves until the save bar is
 * used. Test connects to the saved server, so on a new or changed one it
 * saves first, and a new program or a changed command is confirmed by the
 * main process in a dialog of its own before it is saved.
 */
function McpServerPage({ server, preset, onBack, onSaved, onRemoved, onDirtyChange }: {
  /** The saved server being edited, or undefined to add one. */
  server: McpServerView | undefined;
  preset?: McpServerPreset;
  onBack: () => void;
  /** Saved: every server now, and the one this page shows. */
  onSaved: (servers: readonly McpServerView[], saved: McpServerView) => void;
  onRemoved: (servers: readonly McpServerView[]) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<McpDraft>(() => server !== undefined ? mcpDraftFrom(server) : preset ? mcpDraftFromPreset(preset) : emptyMcpDraft());
  const [showConnection, setShowConnection] = useState(preset === undefined);
  const [saved, setSaved] = useState<McpServerView | undefined>(server);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** What the last successful test listed; null before one. */
  const [listed, setListed] = useState<readonly McpListedTool[] | null>(null);
  const [test, setTest] = useState<{ pending: boolean; ok?: boolean; text?: string }>({ pending: false });
  const adding = saved === undefined;
  const dirty = isMcpDraftDirty(draft, saved);
  const stdio = draft.transport === "stdio";

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const update = (changes: Partial<McpDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setMessage(null);
  };

  const secretRows = draft.secrets[draft.transport];
  const setSecretRows = (rows: readonly DraftSecret[]) => update({ secrets: { ...draft.secrets, [draft.transport]: rows } });
  const updateSecret = (key: string, changes: Partial<DraftSecret>) =>
    setSecretRows(secretRows.map((row) => row.key === key ? { ...row, ...changes } : row));

  const setRisk = (name: string, risk: ToolRisk | undefined) => {
    const rest = Object.fromEntries(Object.entries(draft.toolRisk).filter(([entry]) => entry !== name));
    update({ toolRisk: risk === undefined ? rest : { ...rest, [name]: risk } });
  };

  /** Save the draft and keep editing it; the saved server, or undefined when it did not save. */
  const save = async (): Promise<McpServerView | undefined> => {
    const request = mcpSaveRequest(draft);
    if (!request.ok) {
      setMessage({ ok: false, text: request.message });
      return undefined;
    }
    setBusy(true);
    const result = await saveMcpServer(request.save);
    setBusy(false);
    if (!result.ok) {
      // Also how a declined confirmation of the command comes back.
      setMessage({ ok: false, text: result.message });
      return undefined;
    }
    // The model calls a server by its name, so a new one is found by it.
    const next = request.save.id === undefined
      ? result.servers.find((entry) => entry.name === request.save.name)
      : result.servers.find((entry) => entry.id === request.save.id);
    if (next === undefined) return undefined;
    setSaved(next);
    setDraft(mcpDraftFrom(next));
    setMessage({ ok: true, text: "Saved." });
    onSaved(result.servers, next);
    return next;
  };

  const discard = () => {
    if (saved === undefined) {
      onBack();
      return;
    }
    setDraft(mcpDraftFrom(saved));
    setMessage(null);
  };

  const remove = async () => {
    if (saved === undefined) return;
    setBusy(true);
    const result = await removeMcpServer(saved.id);
    setBusy(false);
    if (!result.ok) {
      setConfirmRemove(false);
      setMessage({ ok: false, text: result.message });
      return;
    }
    onRemoved(result.servers);
  };

  const needsSaveFirst = dirty || saved === undefined;

  const runTest = async () => {
    setTest({ pending: true });
    const target = needsSaveFirst ? await save() : saved;
    if (target === undefined) {
      setTest({ pending: false });
      return;
    }
    const result = await testMcpServer(target.id);
    if (result.ok) setListed(result.tools);
    setTest({ pending: false, ok: result.ok, text: result.message });
  };

  const [signIn, setSignIn] = useState<{ pending: boolean; ok?: boolean; text?: string }>({ pending: false });
  /** Signed in as the server is saved: an unsaved change to its address or client ends that sign-in when saved. */
  const signedIn = !needsSaveFirst && saved?.signedIn === true;

  /** Show the servers an OAuth change returned, keeping the page on this one. */
  const adopt = (servers: readonly McpServerView[], id: string) => {
    const next = servers.find((entry) => entry.id === id);
    if (next === undefined) return;
    setSaved(next);
    setDraft(mcpDraftFrom(next));
    onSaved(servers, next);
  };

  const runSignIn = async () => {
    setSignIn({ pending: true });
    const target = needsSaveFirst ? await save() : saved;
    if (target === undefined) {
      setSignIn({ pending: false });
      return;
    }
    const result = await signInMcpServer(target.id);
    if (!result.ok) {
      setSignIn({ pending: false, ok: false, text: result.message });
      return;
    }
    adopt(result.servers, target.id);
    setSignIn({ pending: false, ok: true, text: "Signed in." });
  };

  const runSignOut = async () => {
    if (saved === undefined) return;
    setBusy(true);
    const result = await signOutMcpServer(saved.id);
    setBusy(false);
    if (!result.ok) {
      setSignIn({ pending: false, ok: false, text: result.message });
      return;
    }
    adopt(result.servers, saved.id);
    setSignIn({ pending: false, ok: true, text: "Signed out." });
  };

  const canSave = !busy && mcpSaveRequest(draft).ok;
  const showSaveBar = adding || dirty;
  const rows = mcpToolRows(listed, draft.toolRisk);
  /** Tools the server calls read-only that the user has not set yet. */
  const hinted = withReadOnlyHints(listed, draft.toolRisk).applied;
  const policy = NEW_TOOL_POLICIES.find((entry) => entry.policy === draft.newTools) ?? NEW_TOOL_POLICIES[0];
  const savedSecrets = saved === undefined || saved.secretNames.length === 0
    ? ""
    : saved.transport === "stdio" ? " and its saved environment variables" : " and its saved headers";

  return <div className="settings-subpage">
    <div className="settings-page-head">
      <button type="button" className="settings-back" onClick={onBack}><ChevronLeft size={14} /> MCP servers</button>
      <h1>{preset?.title ?? (adding ? "Add a server" : saved.name)}</h1>
      {preset ? <p>{preset.setup}</p> : adding && <p>Roqer starts the program or calls the URL, and offers the server&apos;s tools to the model.</p>}
    </div>

    <SettingsGroup
      title="Server"
      action={preset && <button type="button" className="text-button" aria-expanded={showConnection} onClick={() => setShowConnection(!showConnection)}>{showConnection ? "Hide connection settings" : "Connection settings"}</button>}
      footnote={!showConnection ? undefined : stdio
        ? "Roqer shows you the exact command and asks before it saves a new program or a changed one."
        : "Use HTTPS. Plain HTTP is only for a server on this computer or your local network. Put a key in a header, not in the URL."}
    >
      {showConnection && <><label className="settings-field">
        <span>Name</span>
        <input className="mono" value={draft.name} maxLength={32} spellCheck={false} autoComplete="off" autoFocus={adding} placeholder="e.g. github" onChange={(event) => update({ name: event.target.value })} />
        <span className="custom-hint">What the model calls it. Lowercase letters, digits, - and _.</span>
      </label>
      <div className="settings-field">
        <span id="mcp-transport">Runs as</span>
        <div className="settings-segmented" role="group" aria-labelledby="mcp-transport">
          {(["stdio", "http"] as const).map((transport) => <button key={transport} type="button" aria-pressed={draft.transport === transport} title={TRANSPORT_TITLES[transport]} onClick={() => update({ transport })}>{TRANSPORT_LABELS[transport]}</button>)}
        </div>
      </div></>}
      {stdio
        ? showConnection && <>
          <label className="settings-field">
            <span>Program</span>
            <input className="mono" value={draft.command} spellCheck={false} autoComplete="off" placeholder="npx" onChange={(event) => update({ command: event.target.value })} />
            <span className="custom-hint">A full path, or a name on PATH such as npx.</span>
          </label>
          <label className="settings-field">
            <span>Arguments</span>
            <textarea className="mono" rows={3} value={draft.args} spellCheck={false} placeholder={"-y\n@modelcontextprotocol/server-everything"} onChange={(event) => update({ args: event.target.value })} />
            <span className="custom-hint">One per line.</span>
          </label>
        </>
        : <>
          {showConnection && <><label className="settings-field">
            <span>URL</span>
            <input className="mono" value={draft.url} spellCheck={false} autoComplete="off" placeholder="https://example.com/mcp" onChange={(event) => update({ url: event.target.value })} />
          </label>
          <SettingsRow title="Sign in with OAuth" detail="For a server you sign in to on its website, such as ElevenLabs. Roqer opens the page in your browser and keeps the sign-in encrypted on this computer.">
            <SettingsSwitch label="Sign in with OAuth" checked={draft.oauth} onChange={(oauth) => update({ oauth })} />
          </SettingsRow></>}
          {draft.oauth && <>
            <SettingsRow
              title={signedIn ? "Signed in" : "Not signed in"}
              detail={signIn.pending
                ? "Finish signing in in your browser."
                : signedIn ? "Roqer renews the sign-in by itself while the server allows it." : "Sign in before the agent can use this server."}
            >
              {signIn.pending
                ? <>
                  <button type="button" className="small-button" disabled>Waiting…</button>
                  <button type="button" className="small-button" onClick={() => void cancelMcpSignIn()}>Cancel</button>
                </>
                : signedIn
                  ? <button type="button" className="small-button" disabled={busy} onClick={() => void runSignOut()}>Sign out</button>
                  : <button type="button" className="small-button" disabled={!canSave} onClick={() => void runSignIn()}>{needsSaveFirst ? "Save & sign in" : "Sign in"}</button>}
            </SettingsRow>
            {signIn.text !== undefined && <p className={`custom-message ${signIn.ok ? "ok" : "error"}`}>{signIn.ok ? <Check size={13} /> : null} {signIn.text}</p>}
            {showConnection && <label className="settings-field">
              <span>Client ID</span>
              <input className="mono" value={draft.oauthClientId} spellCheck={false} autoComplete="off" placeholder="Optional" onChange={(event) => update({ oauthClientId: event.target.value })} />
              <span className="custom-hint">Leave this empty unless the server&apos;s provider gave you a client ID. Most servers need none.</span>
            </label>}
          </>}
        </>}
      <SettingsRow title="Offer to the model" detail="When off, the agent cannot use this server.">
        <SettingsSwitch label="Offer to the model" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
      </SettingsRow>
    </SettingsGroup>

    {(showConnection || secretRows.length > 0) && <SettingsGroup
      title={!showConnection && preset?.secretName ? "API key" : stdio ? "Environment variables" : "Headers"}
      action={showConnection && <button type="button" className="text-button" disabled={secretRows.length >= MAX_MCP_SECRETS} onClick={() => setSecretRows([...secretRows, { key: rowKey(), name: "", value: "", saved: false }])}><Plus size={14} /> {stdio ? "Add variable" : "Add header"}</button>}
      footnote={`${stdio ? "Set for the program when Roqer starts it." : "Sent with every request to the server."} Values are stored encrypted on this computer and are not shown again.`}
    >
      {secretRows.length === 0 && <p className="custom-empty">{stdio
        ? "None. Add one for a key the program reads, such as GITHUB_TOKEN."
        : "None. Add one for a key the server asks for, such as Authorization."}</p>}
      {secretRows.map((row) => <div key={row.key} className="settings-field">
        {row.saved || !showConnection
          ? <span className="mcp-secret-name" title={row.name}>{!showConnection && row.name === preset?.secretName ? `${preset.title} API key` : row.name}</span>
          : <input className="mono" value={row.name} spellCheck={false} autoComplete="off" autoFocus={row.name === "" && row.value === ""} aria-label={stdio ? "Variable name" : "Header name"} placeholder={stdio ? "NAME" : "Authorization"} onChange={(event) => updateSecret(row.key, { name: event.target.value })} />}
        <div className="custom-key-row">
          <input type="password" value={row.value} spellCheck={false} autoComplete="off" aria-label={`Value for ${row.name.trim() || (stdio ? "the variable" : "the header")}`} placeholder={row.saved ? "Saved · type a new value to replace it" : "Value"} onChange={(event) => updateSecret(row.key, { value: event.target.value })} />
          {showConnection && <button type="button" className="small-button" aria-label={`Remove ${row.name.trim() || (stdio ? "variable" : "header")}`} onClick={() => setSecretRows(secretRows.filter((entry) => entry.key !== row.key))}><X size={14} /></button>}
        </div>
      </div>)}
    </SettingsGroup>}

    <SettingsGroup
      title={`Tools${rows.length > 0 ? ` · ${rows.length}` : ""}`}
      action={<button type="button" className="text-button" disabled={!canSave || test.pending} title={needsSaveFirst ? "Saves the server, then connects and lists its tools" : "Connect and list the server's tools"} onClick={() => void runTest()}>{test.pending ? "Testing…" : needsSaveFirst ? "Save & test" : "Test"}</button>}
      footnote="Read runs in every mode. Edit runs without asking in Auto approve and Full auto, and asks in Ask first. Irreversible asks in every mode but Full auto. Read only allows Read alone."
    >
      <div className="settings-field">
        <span id="mcp-new-tools">Tools you have not set</span>
        <div className="settings-segmented" role="group" aria-labelledby="mcp-new-tools">
          {NEW_TOOL_POLICIES.map((entry) => <button key={entry.policy} type="button" aria-pressed={draft.newTools === entry.policy} onClick={() => update({ newTools: entry.policy })}>{entry.label}</button>)}
        </div>
        <span className="custom-hint">{policy.hint}</span>
      </div>
      {test.text !== undefined && <p className={`custom-message ${test.ok ? "ok" : "error"}`}>{test.ok ? <Check size={13} /> : null} {test.text}</p>}
      {hinted > 0 && <SettingsRow
        title={`${hinted} ${hinted === 1 ? "tool says" : "tools say"} read-only`}
        detail="Set them to Read, so they run without asking. This takes the server's word for it; check the list before you save."
      >
        <button type="button" className="small-button" onClick={() => update({ toolRisk: withReadOnlyHints(listed, draft.toolRisk).toolRisk })}>Set to Read</button>
      </SettingsRow>}
      {rows.length === 0 && <p className="custom-empty">{listed === null
        ? "Test the server to list its tools, then set what each one may do."
        : "The server listed no tools."}</p>}
      {rows.map((row) => <ToolRow
        key={row.name}
        row={row}
        tested={listed !== null}
        newTools={draft.newTools}
        onChange={(risk) => setRisk(row.name, risk)}
      />)}
    </SettingsGroup>

    {!adding && <div className="settings-danger">
      {confirmRemove
        ? <>
          <span>Remove {saved.name}{savedSecrets} from this computer?</span>
          <button type="button" className="small-button" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep</button>
          <button type="button" className="small-button danger" disabled={busy} onClick={() => void remove()}>Remove</button>
        </>
        : <>
          <span>Chats that used this server keep their history.</span>
          <button type="button" className="small-button danger-outline" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove server…</button>
        </>}
    </div>}

    {(showSaveBar || message !== null) && <div className="settings-savebar" role="region" aria-label="Save changes">
      {message !== null
        ? <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.ok ? <Check size={13} /> : null} {message.text}</p>
        : <p className="settings-savebar-note">{adding ? "Not added yet." : "You have unsaved changes."}</p>}
      {showSaveBar && <>
        <button type="button" className="secondary-action" disabled={busy} onClick={discard}>{adding ? "Cancel" : "Discard"}</button>
        <button type="button" className="primary-action" disabled={!canSave || !dirty} onClick={() => void save()}>{busy ? "Saving…" : adding ? "Add server" : "Save"}</button>
      </>}
    </div>}
  </div>;
}

/**
 * One tool: its name, what the server says it does, and what the user lets
 * it do. The description and hints come from the server, so they are plain
 * text, clamped, and only ever advice: Unset falls back to the server's
 * policy for tools the user has not set, never to the server's hint.
 */
function ToolRow({ row, tested, newTools, onChange }: {
  row: McpToolRow;
  /** Whether a test has listed the server's tools, so a missing one can be told apart. */
  tested: boolean;
  newTools: McpNewToolPolicy;
  onChange: (risk: ToolRisk | undefined) => void;
}) {
  const description = (row.listed?.description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARACTERS);
  const hint = row.listed?.readOnlyHint === true
    ? "server says read-only"
    : row.listed?.destructiveHint === true ? "server says destructive" : undefined;
  return <div className="settings-row">
    <div className="settings-row-text">
      <strong className="mcp-tool-name" title={row.name}>{row.name}</strong>
      {description !== "" && <span className="mcp-tool-description" title={description}>{description}</span>}
    </div>
    <div className="settings-actions">
      {hint !== undefined && <span className="custom-badge quiet" title="The server's own claim. Roqer shows it and does not act on it.">{hint}</span>}
      {tested && row.listed === undefined && <span className="custom-badge quiet" title="The last test did not list this tool. Your choice is kept in case it comes back.">not listed</span>}
      <select
        className="mcp-risk"
        value={row.risk ?? ""}
        aria-label={`What ${row.name} may do`}
        onChange={(event) => onChange(isMcpToolRisk(event.target.value) ? event.target.value : undefined)}
      >
        <option value="">{newTools === "trust" ? "Unset · as Irreversible" : "Unset · always asks"}</option>
        {RISK_OPTIONS.map((option) => <option key={option.risk} value={option.risk}>{option.label}</option>)}
      </select>
    </div>
  </div>;
}
