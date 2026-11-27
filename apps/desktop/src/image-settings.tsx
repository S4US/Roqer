import { useEffect, useState } from "react";

import {
  defaultImageBaseUrl, defaultImageModel, IMAGE_QUALITIES, imageModelPresets, imageSourceLabel, isImageSourceKind, type ImageQuality, type ImageSettingsResult,
  type ImageSettingsView, type ImageSourceKind,
} from "../shared/image-generation";
import { getImageSettings, saveImageSettings, testImageSettings } from "./platform";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-parts";

type Draft = {
  source: ImageSourceKind; baseUrl: string; model: string; accountId: string; apiKey: string; removeKey: boolean; quality: ImageQuality; customModel: boolean;
};

/** The value of the "custom" option in a model picker; never a real model id. */
const CUSTOM_MODEL = "__custom__";

const isPresetModel = (source: ImageSourceKind, model: string): boolean => imageModelPresets(source).some((preset) => preset.id === model);

/** True when the source offers presets and the saved model is one the user typed. */
const isCustomModel = (source: ImageSourceKind, model: string): boolean => imageModelPresets(source).length > 0 && !isPresetModel(source, model);

const draftFrom = (settings: ImageSettingsView): Draft => ({
  source: settings.source,
  baseUrl: settings.baseUrl,
  model: settings.model,
  accountId: settings.accountId,
  apiKey: "",
  removeKey: false,
  quality: settings.quality,
  customModel: isCustomModel(settings.source, settings.model),
});

const QUALITY_LABELS: Record<ImageQuality, string> = { low: "Low (drafts)", medium: "Medium", high: "High (settled textures)" };

function sourceSummary(settings: ImageSettingsView): string {
  const where = settings.source === "openai-compatible" ? settings.baseUrl : imageSourceLabel(settings.source);
  return `${settings.model} at ${where} · ${settings.hasKey ? "key saved" : "no key"} · quality ${settings.quality}`;
}

const KEY_HINTS: Record<ImageSourceKind, string> = {
  openai: "(from platform.openai.com → API keys)",
  openrouter: "(from openrouter.ai → Keys)",
  google: "(from aistudio.google.com → API keys)",
  cloudflare: "(a Workers AI token from dash.cloudflare.com → My Profile → API Tokens)",
  "openai-compatible": "(if the server needs one)",
};

/**
 * Moving between sources: a model typed for a server of the user's own follows
 * them, but a provider's own model (or a Cloudflare id) is replaced by the new
 * source's default instead of being sent to a provider that cannot serve it.
 */
function switchSource(draft: Draft, source: ImageSourceKind): Draft {
  const previousPresets = imageModelPresets(draft.source);
  const targetPresets = imageModelPresets(source);
  const previousDefault = defaultImageModel(draft.source);
  const fromProviderModel = draft.customModel || (previousPresets.length > 0 && previousPresets.some((preset) => preset.id === draft.model));
  const carry = !fromProviderModel
    && draft.model.trim() !== ""
    && draft.model !== previousDefault
    && (targetPresets.length === 0 || targetPresets.some((preset) => preset.id === draft.model));
  const model = carry ? draft.model : defaultImageModel(source) ?? draft.model;
  return {
    ...draft, source, baseUrl: defaultImageBaseUrl(source) ?? draft.baseUrl, model,
    customModel: isCustomModel(source, model),
  };
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
      accountId: draft.accountId,
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
  const presets = imageModelPresets(draft?.source ?? settings.source);
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
            <option value="google">Google</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="openai-compatible">OpenAI-compatible server</option>
          </select>
        </label>
        <label className="custom-field grow"><span>Model</span>
          {presets.length > 0 ? (
            <select
              value={draft.customModel ? CUSTOM_MODEL : draft.model}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(value === CUSTOM_MODEL
                  ? { ...draft, customModel: true, model: draft.customModel ? draft.model : "" }
                  : { ...draft, customModel: false, model: value });
              }}
            >
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} — {preset.detail}</option>)}
              <option value={CUSTOM_MODEL}>Custom model…</option>
            </select>
          ) : (
            <input
              value={draft.model}
              spellCheck={false}
              placeholder={defaultImageModel(draft.source) ?? "flux"}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          )}
        </label>
      </div>
      {draft.customModel && <label className="custom-field"><span>Model ID (any Workers AI image model)</span>
        <input value={draft.model} spellCheck={false} autoFocus placeholder={defaultImageModel(draft.source) ?? "@cf/..."} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
      </label>}
      {draft.source === "cloudflare" && <label className="custom-field"><span>Account ID (Workers AI → Use REST API shows it)</span>
        <input value={draft.accountId} spellCheck={false} placeholder="Your Cloudflare account ID" onChange={(event) => setDraft({ ...draft, accountId: event.target.value })} />
      </label>}
      {compatible && <label className="custom-field"><span>Address (the /v1 base, with /images/generations under it)</span>
        <input value={draft.baseUrl} spellCheck={false} placeholder="http://localhost:8000/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
      </label>}
      {draft.source === "openrouter" && <p className="custom-hint">Any model in OpenRouter's image list works. OpenAI's image models through OpenRouter take a transparent background, which particle and icon textures need; other models return opaque pictures. Test says what the chosen model takes.</p>}
      {draft.source === "google" && <p className="custom-hint">A Gemini image model such as gemini-2.5-flash-image makes one picture a call and can vary an earlier output; an Imagen model such as imagen-4.0-generate-001 makes up to four in one call from the prompt alone. Google has no transparent-background field, so Roqer asks for it in words; the result's family line says whether the picture came back with transparency.</p>}
      {draft.source === "cloudflare" && <p className="custom-hint">Cloudflare serves these models through Workers AI, billed to your account. FLUX.2 Klein 4B is quickest, Klein 9B has more detail, and Dev has the most; Leonardo Lucid Origin suits icons, decals and readable text; Phoenix suits concept art; FLUX.1 Schnell is the cheapest draft. Choose <strong>Custom model…</strong> for any other Workers AI image model; it is sent the prompt with width and height (FLUX.2 ids go as multipart, flux-1-schnell takes the prompt alone) and must accept those fields. Cloudflare has no transparent-background or quality field, so Roqer asks for the background in words and sends no quality; a JPEG answer is turned into a PNG before it is saved. These models make a picture from the prompt alone, so a call cannot vary an earlier output.</p>}
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
