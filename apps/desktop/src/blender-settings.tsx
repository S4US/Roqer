import { Shapes } from "lucide-react";
import { useEffect, useState } from "react";

import type { BlenderSettingsResult, BlenderSettingsView } from "../shared/blender";
import { chooseBlender, getBlenderSettings, redetectBlender, setBlenderEnabled } from "./platform";
import { SettingsSwitch } from "./settings-parts";

/**
 * The local Blender worker in Settings. Off until the user turns it on, and it
 * says plainly what turning it on allows: the agent's Python runs with the
 * user's own permissions, after an approval for each job.
 */
export function BlenderSettingsRow() {
  const [settings, setSettings] = useState<BlenderSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (request: () => Promise<BlenderSettingsResult>) => {
    setBusy(true);
    const result = await request();
    setBusy(false);
    if (result.ok) {
      setSettings(result.settings);
      setError(null);
    } else {
      setError(result.message);
    }
  };

  useEffect(() => {
    void apply(getBlenderSettings);
  }, []);

  if (settings === null) return error ? <p className="custom-message error">{error}</p> : null;
  const canEnable = settings.state === "off" || settings.state === "ready";
  return <>
    <div className="settings-row">
      <div className={`settings-icon ${settings.state === "ready" ? "green" : ""}`}><Shapes size={17} /></div>
      <div>
        <strong>Blender modeling</strong>
        <span>{settings.message}</span>
        {settings.executable !== null && <code className="settings-path" title={settings.executable}>{settings.executable}</code>}
      </div>
      <div className="settings-actions">
        <button className="small-button" disabled={busy} onClick={() => void apply(chooseBlender)}>Choose…</button>
        {canEnable
          ? <SettingsSwitch label="Blender modeling" checked={settings.enabled} disabled={busy} onChange={(enabled) => void apply(() => setBlenderEnabled(enabled))} />
          : <button className="small-button" disabled={busy} onClick={() => void apply(redetectBlender)}>Find again</button>}
      </div>
    </div>
    {settings.enabled && <p className="settings-note">
      The agent writes Python that runs in this Blender with your permissions. Roqer asks before each job unless you run in Full auto, and checks every exported model before it can be uploaded.
    </p>}
    {error && <p className="custom-message error">{error}</p>}
  </>;
}
