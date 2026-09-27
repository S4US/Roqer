import { useEffect, useState } from "react";

import type { BlenderSettingsResult, BlenderSettingsView } from "../shared/blender";
import { chooseBlender, getBlenderSettings, redetectBlender, setBlenderEnabled } from "./platform";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-parts";

/**
 * The local Blender worker in Settings. Off until the user turns it on, and it
 * says plainly what turning it on allows: the agent's Python runs with the
 * user's own permissions, after an approval for each job.
 */
export function BlenderSettings() {
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
    <SettingsGroup footnote="Jobs run in this Blender with your permissions. Roqer asks before each one unless the chat is in Full auto, and checks every exported model before it can be uploaded.">
      <SettingsRow title="Use Blender for modeling" detail={settings.message}>
        {canEnable
          ? <SettingsSwitch label="Use Blender for modeling" checked={settings.enabled} disabled={busy} onChange={(enabled) => void apply(() => setBlenderEnabled(enabled))} />
          : <button className="small-button" disabled={busy} onClick={() => void apply(redetectBlender)}>Find again</button>}
      </SettingsRow>
      <SettingsRow
        title={settings.version ?? "Blender app"}
        detail={settings.executable === null ? "Not found yet" : <code className="settings-path" title={settings.executable}>{settings.executable}</code>}
      >
        <button className="small-button" disabled={busy} onClick={() => void apply(chooseBlender)}>Choose…</button>
      </SettingsRow>
    </SettingsGroup>
    {error && <p className="custom-message error">{error}</p>}
  </>;
}
