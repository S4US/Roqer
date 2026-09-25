import { Cloud, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { OpenCloudCheck, OpenCloudSettingsView } from "../shared/open-cloud";
import { checkOpenCloudKey, getOpenCloudSettings, saveOpenCloudSettings } from "./platform";

type Draft = { apiKey: string; removeKey: boolean; kind: "user" | "group"; id: string };

const draftFrom = (settings: OpenCloudSettingsView): Draft => ({
  apiKey: "",
  removeKey: false,
  kind: settings.creator?.kind ?? "user",
  id: settings.creator?.id ?? "",
});

function summary(settings: OpenCloudSettingsView): string {
  if (!settings.hasKey) {
    return "Lets Roqer publish images, audio and models you ask for to your Roblox account. The key stays on this computer.";
  }
  const creator = settings.creator === null
    ? "no creator chosen yet"
    : `publishes as ${settings.creator.kind} ${settings.creator.id}`;
  return `Key saved · ${creator}`;
}

/** What the bridge is using, when that is not simply the saved settings. */
function bridgeNote(settings: OpenCloudSettingsView): string | undefined {
  switch (settings.bridge) {
    case "restart-pending":
      return "The Studio bridge picks this up when the current run finishes.";
    case "adopted":
      return "Another program started the Studio bridge, so it uses its own Open Cloud settings. Close it and restart Roqer to use these.";
    default:
      return undefined;
  }
}

function checkDetails(check: OpenCloudCheck): string {
  return [
    check.keyName === undefined ? undefined : `Key "${check.keyName}"`,
    check.canRead === undefined ? undefined : `assets ${[check.canRead ? "read" : "", check.canWrite ? "write" : ""].filter(Boolean).join(" and ") || "not allowed"}`,
    check.expiresAt === undefined ? undefined : `expires ${new Date(check.expiresAt).toLocaleDateString()}`,
  ].filter((part): part is string => part !== undefined).join(" · ");
}

/** A key that works but has no creator yet is a next step, not a failure. */
function checkTone(check: OpenCloudCheck, settings: OpenCloudSettingsView): "ok" | "note" | "error" {
  if (check.canUpload) return "ok";
  return check.canWrite === true && settings.creator === null ? "note" : "error";
}

export function OpenCloudSettings() {
  const [settings, setSettings] = useState<OpenCloudSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<OpenCloudCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await getOpenCloudSettings();
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setSettings(result.settings);
    if (result.settings.damagedNotice) setMessage({ ok: false, text: result.settings.damagedNotice });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (draft === null) return;
    const id = draft.id.trim();
    const apiKey = draft.removeKey ? null : draft.apiKey.trim() === "" ? undefined : draft.apiKey;
    setBusy(true);
    const result = await saveOpenCloudSettings({
      ...(apiKey === undefined ? {} : { apiKey }),
      creator: id === "" ? null : { kind: draft.kind, id },
    });
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    setSettings(result.settings);
    setDraft(null);
    setCheck(null);
    setMessage({ ok: true, text: bridgeNote(result.settings) ?? "Saved." });
  };

  const runCheck = async () => {
    setBusy(true);
    setMessage(null);
    const result = await checkOpenCloudKey();
    setBusy(false);
    if (!result.ok) {
      setCheck(null);
      setMessage({ ok: false, text: result.message });
      return;
    }
    setCheck(result.check);
  };

  if (settings === null) {
    return message ? <p className="custom-message error">{message.text}</p> : null;
  }
  const note = bridgeNote(settings);
  return <>
    <div className="settings-row">
      <div className={`settings-icon ${settings.hasKey && settings.creator !== null ? "green" : ""}`}><Cloud size={17} /></div>
      <div>
        <strong>Roblox Open Cloud</strong>
        <span>{summary(settings)}</span>
      </div>
      {draft === null && <div className="settings-actions">
        {settings.hasKey && <button className="small-button" disabled={busy} onClick={() => void runCheck()}>{busy ? "Checking…" : "Check key"}</button>}
        <button className="small-button" disabled={busy} onClick={() => { setDraft(draftFrom(settings)); setMessage(null); }} aria-label="Edit Open Cloud settings">
          {settings.hasKey ? <Pencil size={14} /> : "Set up"}
        </button>
      </div>}
    </div>
    {note !== undefined && draft === null && message === null && <p className="custom-hint">{note}</p>}
    {draft !== null && <div className="custom-editor">
      <label className="custom-field"><span>API key {settings.hasKey && !draft.removeKey ? "(saved; paste a new one to replace it)" : "(from Creator Dashboard → Open Cloud → API Keys)"}</span>
        <div className="custom-key-row">
          <input type="password" value={draft.apiKey} spellCheck={false} autoComplete="off" disabled={draft.removeKey} placeholder={settings.hasKey && !draft.removeKey ? "••••••••" : "Paste the key"} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
          {settings.hasKey && <button className="small-button" onClick={() => setDraft({ ...draft, removeKey: !draft.removeKey, apiKey: "" })}>{draft.removeKey ? "Keep key" : "Remove key"}</button>}
        </div>
      </label>
      <div className="custom-field-pair">
        <label className="custom-field"><span>Publish as</span>
          <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value === "group" ? "group" : "user" })}>
            <option value="user">User</option>
            <option value="group">Group</option>
          </select>
        </label>
        <label className="custom-field grow"><span>{draft.kind === "group" ? "Group ID" : "User ID"}</span>
          <input value={draft.id} inputMode="numeric" spellCheck={false} placeholder="e.g. 123456789" onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
        </label>
      </div>
      <p className="custom-hint">The key needs the Assets API with Write access for this user or group. Uploads are irreversible, so Roqer asks before each one unless you run in Full auto.</p>
      <div className="settings-actions">
        <button className="small-button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        <button className="small-button" disabled={busy} onClick={() => { setDraft(null); setMessage(null); }}>Cancel</button>
      </div>
    </div>}
    {check !== null && draft === null && <div className={`custom-message open-cloud-check ${checkTone(check, settings)}`}>
      <p>{check.message}</p>
      {checkDetails(check) && <p className="custom-hint">{checkDetails(check)}</p>}
      {settings.creator === null && check.authorizedUserId !== undefined && <button className="small-button" disabled={busy} onClick={() => {
        setDraft({ ...draftFrom(settings), kind: "user", id: check.authorizedUserId! });
        setCheck(null);
      }}>Publish as user {check.authorizedUserId}</button>}
    </div>}
    {message && <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.text}</p>}
  </>;
}
