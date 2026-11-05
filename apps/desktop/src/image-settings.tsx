import { useEffect, useState } from "react";

import {
  defaultImageBaseUrl, defaultImageModel, IMAGE_QUALITIES, imageSourceLabel, isImageSourceKind, type ImageQuality, type ImageSettingsResult,
  type ImageSettingsView, type ImageSourceKind,
} from "../shared/image-generation";
import { getImageSettings, saveImageSettings, testImageSettings } from "./platform";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-parts";

type Draft = { source: ImageSourceKind; baseUrl: string; model: string; apiKey: string; removeKey: boolean; quality: ImageQuality };

const draftFrom = (settings: ImageSettingsView): Draft => ({
  source: settings.source,
  baseUrl: settings.baseUrl,
  model: settings.model,
  apiKey: "",
  removeKey: false,
  quality: settings.quality,
});

const QUALITY_LABELS: Record<ImageQuality, string> = { low: "Low (drafts)", medium: "Medium", high: "High (settled textures)" };

function sourceSummary(settings: ImageSettingsView): string {
  const where = settings.source === "openai-compatible" ? settings.baseUrl : imageSourceLabel(settings.source);
  return `${settings.model} at ${where} · ${settings.hasKey ? "key saved" : "no key"} · quality ${settings.quality}`;
}

const KEY_HINTS: Record<ImageSourceKind, string> = {
  openai: "(from platform.openai.com → API keys)",
  openrouter: "(from openrouter.ai → Keys)",
  "openai-compatible": "(if the server needs one)",
};

/** Moving between sources: each takes its own address and model unless the user typed one for it. */
function switchSource(draft: Draft, source: ImageSourceKind): Draft {
  const previousDefault = defaultImageModel(draft.source);
  const model = draft.model.trim() === "" || draft.model === previousDefault ? defaultImageModel(source) ?? draft.model : draft.model;
  return { ...draft, source, baseUrl: defaultImageBaseUrl(source) ?? draft.baseUrl, model };
}

/**
 * The image model in Settings. Off until the user turns it on, and plain about
 * what turning it on allows: the agent's prompts go to that server, and each
 * call spends the user's key or plan, after an approval outside Full auto.
 */
export function ImageSettings() {
  const [settings, setSettings] = useState<ImageSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (request: () => Promise<ImageSettingsResult>, done?: string) => {
    setBusy(true);
    const result = await request();
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return false;
    }
    setSettings(result.settings);
    setMessage(result.settings.damagedNotice ? { ok: false, text: result.settings.damagedNotice } : done === undefined ? null : { ok: true, text: done });
    return true;
  };

  useEffect(() => {
    void apply(getImageSettings);
  }, []);

  const save = async () => {
    if (draft === null) return;
    const apiKey = draft.removeKey ? null : draft.apiKey.trim() === "" ? undefined : draft.apiKey.trim();
    const saved = await apply(() => saveImageSettings({
      source: draft.source,
      baseUrl: draft.baseUrl,
      model: draft.model,
      quality: draft.quality,
      ...(apiKey === undefined ? {} : { apiKey }),
    }), "Saved.");
    if (saved) setDraft(null);
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    const result = await testImageSettings();
    setBusy(false);
    setMessage({ ok: result.ok, text: result.message });
  };

  if (settings === null) return message ? <p className="custom-message error">{message.text}</p> : null;
  const compatible = (draft?.source ?? settings.source) === "openai-compatible";
  return <>
    <SettingsGroup footnote="Each image call sends the prompt to this server and spends your key or plan. Roqer asks before each one unless the chat is in Full auto, measures every picture, and keeps the prompt beside the file so an upload can say where it came from.">
      <SettingsRow title="Generate images" detail={settings.message}>
        <SettingsSwitch label="Generate images" checked={settings.enabled} disabled={busy} onChange={(enabled) => void apply(() => saveImageSettings({ enabled }))} />
      </SettingsRow>
      <SettingsRow title="Image model" detail={sourceSummary(settings)}>
        {draft === null && <>
          {(settings.hasKey || settings.source === "openai-compatible") && <button className="small-button" disabled={busy} onClick={() => void test()}>{busy ? "Testing…" : "Test"}</button>}
          <button className="small-button" disabled={busy} onClick={() => { setDraft(draftFrom(settings)); setMessage(null); }}>Change</button>
        </>}
      </SettingsRow>
    </SettingsGroup>
    {draft !== null && <div className="custom-editor">
      <div className="custom-field-pair">
        <label className="custom-field"><span>Server</span>
          <select value={draft.source} onChange={(event) => {
            if (isImageSourceKind(event.target.value)) setDraft(switchSource(draft, event.target.value));
          }}>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="openai-compatible">OpenAI-compatible server</option>
          </select>
        </label>
        <label className="custom-field grow"><span>Model</span>
          <input value={draft.model} spellCheck={false} placeholder={defaultImageModel(draft.source) ?? "flux"} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
        </label>
      </div>
      {compatible && <label className="custom-field"><span>Address (the /v1 base, with /images/generations under it)</span>
        <input value={draft.baseUrl} spellCheck={false} placeholder="http://localhost:8000/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
      </label>}
      {draft.source === "openrouter" && <p className="custom-hint">Any model in OpenRouter's image list works. OpenAI's image models through OpenRouter take a transparent background, which particle and icon textures need; other models return opaque pictures. Test says what the chosen model takes.</p>}
      <label className="custom-field"><span>API key {settings.hasKey && !draft.removeKey ? "(saved; paste a new one to replace it)" : KEY_HINTS[draft.source]}</span>
        <div className="custom-key-row">
          <input type="password" value={draft.apiKey} spellCheck={false} autoComplete="off" disabled={draft.removeKey} placeholder={settings.hasKey && !draft.removeKey ? "••••••••" : "Paste the key"} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
          {settings.hasKey && <button className="small-button" onClick={() => setDraft({ ...draft, removeKey: !draft.removeKey, apiKey: "" })}>{draft.removeKey ? "Keep key" : "Remove key"}</button>}
        </div>
      </label>
      <label className="custom-field"><span>Default quality</span>
        <select value={draft.quality} onChange={(event) => setDraft({ ...draft, quality: IMAGE_QUALITIES.includes(event.target.value as ImageQuality) ? event.target.value as ImageQuality : draft.quality })}>
          {IMAGE_QUALITIES.map((quality) => <option key={quality} value={quality}>{QUALITY_LABELS[quality]}</option>)}
        </select>
      </label>
      <p className="custom-hint">The agent can ask for a lower or higher quality on one call. The key is encrypted with your operating system's credential store and never reaches the window or the model.</p>
      <div className="settings-actions">
        <button className="small-button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        <button className="small-button" disabled={busy} onClick={() => { setDraft(null); setMessage(null); }}>Cancel</button>
      </div>
    </div>}
    {message && draft === null && <p className={`custom-message ${message.ok ? "ok" : "error"}`}>{message.text}</p>}
  </>;
}
