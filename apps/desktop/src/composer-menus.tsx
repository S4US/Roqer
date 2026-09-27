import { Check, ChevronDown, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { ApprovalMode } from "../shared/policy";
import {
  ENABLED_PROVIDER_IDS, providerLabel,
  type ProviderId, type ProviderModel, type ProviderModelCatalog, type ProviderStatus, type ReasoningEffort,
} from "../shared/provider";
import { getProviderModels, getProviderStatus } from "./platform";
import { SettingsSwitch } from "./settings-parts";

/**
 * The composer's two menus: which model answers, and how the run behaves.
 *
 * The toolbar used to hold a select for each of provider, model, effort and
 * approval, and a separate playtest toggle: seven controls in a row, the model
 * hidden entirely on a narrow window. Each decision now has one button that
 * says its current answer and one menu that changes it.
 */

/** Whether a model offers a choice of thinking effort worth showing. */
export function takesEffort(model: ProviderModel | null): boolean {
  const efforts = model?.supportedReasoningEfforts ?? [];
  return efforts.length > 1 || (efforts.length === 1 && efforts[0].reasoningEffort !== "none");
}

export function effortLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort[0].toUpperCase()}${effort.slice(1)}`;
}

/** A trigger and the panel it opens above the composer. Closes on Escape and on a click elsewhere. */
function ComposerMenu({ className, label, trigger, disabled, title, children }: {
  className: string;
  label: string;
  trigger: ReactNode;
  disabled: boolean;
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [close, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Up and down move between the menu's choices, the way a menu does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-menu-option]:not(:disabled)") ?? []);
    if (options.length === 0) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length - 1 : index - 1);
    options[next].focus();
  };

  return <div className={`composer-menu ${className}${open ? " open" : ""}`} ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
    <button
      type="button"
      ref={triggerRef}
      className="composer-menu-trigger"
      disabled={disabled}
      title={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >{trigger}<ChevronDown className="composer-menu-chevron" size={13} aria-hidden="true" /></button>
    {open && <div className="composer-menu-panel" role="dialog" aria-label={label}>{children(() => close())}</div>}
  </div>;
}

type Group = { key: string; provider: ProviderId; label: string; models: readonly ProviderModel[]; note?: string };

/** What another provider offers, read when the menu opens rather than kept polling in the background. */
type OtherProvider = { status: ProviderStatus; catalog: ProviderModelCatalog | null };

/**
 * Every model Roqer can use, grouped by where it runs, and the thinking effort
 * for the one chosen.
 *
 * Choosing a model from another group also switches the provider, so there is
 * no separate provider control. The current provider's models come from the
 * app, which already keeps them fresh; the others are read each time the menu
 * opens, so a user who only ever uses one provider never starts the others.
 */
export function ModelMenu({ provider, status, catalog, selectedModel, effort, disabled, onPick, onEffort, onManage }: {
  provider: ProviderId;
  status: ProviderStatus;
  catalog: ProviderModelCatalog;
  selectedModel: ProviderModel | null;
  effort: ReasoningEffort;
  disabled: boolean;
  onPick: (provider: ProviderId, model: ProviderModel) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onManage: () => void;
}) {
  const [others, setOthers] = useState<Partial<Record<ProviderId, OtherProvider>>>({});
  const [query, setQuery] = useState("");
  // The model just picked, held while the app catches up: picking one from
  // another provider switches provider, and that provider's catalog is read
  // again before the app's own selection shows it.
  const [picked, setPicked] = useState<{ provider: ProviderId; model: ProviderModel } | null>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const chosenModel = selectedModel ?? (picked?.provider === provider ? picked.model : null);

  const loadOthers = useCallback(() => {
    for (const other of ENABLED_PROVIDER_IDS) {
      if (other === provider) continue;
      void (async () => {
        const otherStatus = await getProviderStatus(other);
        const otherCatalog = otherStatus.kind === "signed-in" ? await getProviderModels(other) : null;
        setOthers((current) => ({ ...current, [other]: { status: otherStatus, catalog: otherCatalog } }));
      })();
    }
  }, [provider]);

  const groups = useMemo((): Group[] => {
    const result: Group[] = [];
    for (const id of ENABLED_PROVIDER_IDS) {
      // Just switched to, this provider is still being read again; what the
      // menu read when it opened stands in until then, so its list stays put.
      const settled = status.kind !== "checking" && (status.kind !== "signed-in" || catalog.models.length > 0 || catalog.message !== undefined);
      const entry = id === provider ? (settled ? { status, catalog } : others[id] ?? { status, catalog }) : others[id];
      const models = entry?.catalog?.models ?? [];
      const note = entry === undefined
        ? "Checking…"
        : entry.status.kind !== "signed-in"
          ? id === "custom" ? "No endpoints yet" : "Not connected"
          : models.length === 0 ? entry.catalog?.message ?? "Loading models…" : undefined;
      if (id === "custom" && models.length > 0) {
        // Your own models are grouped by the endpoint they run on.
        const byEndpoint = new Map<string, ProviderModel[]>();
        for (const model of models) {
          const endpoint = model.runsOn ?? "Your models";
          byEndpoint.set(endpoint, [...(byEndpoint.get(endpoint) ?? []), model]);
        }
        for (const [endpoint, endpointModels] of byEndpoint) {
          result.push({ key: `custom:${endpoint}`, provider: id, label: endpoint, models: endpointModels });
        }
      } else {
        result.push({ key: id, provider: id, label: id === "custom" ? "Your models" : providerLabel(id), models, ...(note === undefined ? {} : { note }) });
      }
    }
    return result;
  }, [catalog, others, provider, status]);

  const filter = query.trim().toLowerCase();
  const visible = filter === ""
    ? groups
    : groups
      .map((group) => ({
        ...group,
        note: undefined,
        models: group.label.toLowerCase().includes(filter)
          ? group.models
          : group.models.filter((model) => `${model.displayName} ${model.description ?? ""}`.toLowerCase().includes(filter)),
      }))
      .filter((group) => group.models.length > 0);

  const efforts = chosenModel?.supportedReasoningEfforts ?? [];
  const showEffort = chosenModel !== null && takesEffort(chosenModel);

  // After a pick the effort is the next thing chosen, so it gets the focus.
  useEffect(() => {
    if (picked === null) return;
    const frame = window.requestAnimationFrame(() => {
      effortRef.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [picked]);
  const triggerLabel = chosenModel?.displayName
    ?? (status.kind === "signed-in" ? catalog.message ? "No models" : "Loading models…" : "Choose a model");

  return <ComposerMenu
    className="model-menu"
    label="Model"
    disabled={disabled}
    title={selectedModel?.runsOn === undefined ? providerLabel(provider) : `${selectedModel.displayName} on ${selectedModel.runsOn}`}
    trigger={<span className="composer-menu-label">{triggerLabel}{showEffort && <em>{effortLabel(effort)}</em>}</span>}
  >
    {(close) => <MenuBody onOpen={loadOthers} onClose={() => setPicked(null)}>
      <label className="model-menu-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={query} placeholder="Find a model" aria-label="Find a model" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="model-menu-list">
        {visible.map((group) => <div key={group.key} className="model-menu-group" role="group" aria-label={group.label}>
          <span className="model-menu-group-label">{group.label}</span>
          {group.models.map((model) => {
            const chosen = group.provider === provider && model.id === chosenModel?.id;
            return <button
              key={model.id}
              type="button"
              aria-pressed={chosen}
              data-menu-option
              className="composer-menu-option"
              title={model.description}
              onClick={() => {
                onPick(group.provider, model);
                // A model with a thinking effort to choose keeps the menu open
                // on that choice; picking the effort then closes it.
                if (takesEffort(model)) setPicked({ provider: group.provider, model });
                else close();
              }}
            ><span className="composer-menu-option-label">{model.displayName}</span>{chosen && <Check size={14} aria-hidden="true" />}</button>;
          })}
          {group.note !== undefined && <button type="button" className="model-menu-note" data-menu-option onClick={() => { close(); onManage(); }}>{group.note}</button>}
        </div>)}
        {visible.length === 0 && <p className="model-menu-empty">No model matches “{query.trim()}”.</p>}
      </div>
      {showEffort && <div className="model-menu-effort">
        <span id="model-menu-effort-label">Thinking effort for {chosenModel.displayName}</span>
        <div className="composer-segmented" role="radiogroup" aria-labelledby="model-menu-effort-label" ref={effortRef}>
          {efforts.map((entry) => <button
            key={entry.reasoningEffort}
            type="button"
            role="radio"
            aria-checked={entry.reasoningEffort === effort}
            title={entry.description}
            onClick={() => { onEffort(entry.reasoningEffort); close(); }}
          >{effortLabel(entry.reasoningEffort)}</button>)}
        </div>
      </div>}
      <button type="button" className="composer-menu-footer" data-menu-option onClick={() => { close(); onManage(); }}>Manage models…</button>
    </MenuBody>}
  </ComposerMenu>;
}

/** Runs `onOpen` when the panel mounts, and `onClose` when it goes. */
function MenuBody({ onOpen, onClose, children }: { onOpen: () => void; onClose?: () => void; children: ReactNode }) {
  useEffect(() => {
    onOpen();
  }, [onOpen]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => () => closeRef.current?.(), []);
  return <>{children}</>;
}

const APPROVAL_CHOICES: ReadonlyArray<{ value: ApprovalMode; label: string; detail: string }> = [
  { value: "Ask first", label: "Ask first", detail: "Confirm every change before it reaches your place." },
  { value: "Auto approve", label: "Auto approve", detail: "Ordinary, recoverable edits run on their own. Anything that cannot be undone still asks." },
  { value: "Full auto", label: "Full auto", detail: "Nothing asks: publishing, asset spend, and arbitrary Luau all run unattended." },
  { value: "Read only", label: "Read only", detail: "Inspect the place and block every change to it." },
];

/** How a run behaves: what it may change without asking, and whether it playtests its own work. */
export function RunMenu({ approvalMode, autoPlaytest, disabled, onApprovalMode, onAutoPlaytest }: {
  approvalMode: ApprovalMode;
  autoPlaytest: boolean;
  disabled: boolean;
  onApprovalMode: (mode: ApprovalMode) => void;
  onAutoPlaytest: (on: boolean) => void;
}) {
  const tone = approvalMode === "Full auto" ? " full-auto" : approvalMode === "Auto approve" ? " auto" : "";
  return <ComposerMenu
    className={`run-menu${tone}`}
    label="How the run behaves"
    disabled={disabled}
    trigger={<span className="composer-menu-label"><ShieldCheck size={15} aria-hidden="true" />{approvalMode}<em>{autoPlaytest ? "Playtest on" : "Playtest off"}</em></span>}
  >
    {(close) => <>
      <span className="model-menu-group-label">Before changing your place</span>
      {APPROVAL_CHOICES.map((choice) => <button
        key={choice.value}
        type="button"
        aria-pressed={choice.value === approvalMode}
        data-menu-option
        autoFocus={choice.value === approvalMode}
        className={`composer-menu-option run-choice${choice.value === "Full auto" ? " full-auto" : ""}`}
        onClick={() => { onApprovalMode(choice.value); close(); }}
      >
        <span className="run-choice-text"><strong>{choice.label}</strong><span>{choice.detail}</span></span>
        {choice.value === approvalMode && <Check size={14} aria-hidden="true" />}
      </button>)}
      <div className="run-menu-playtest">
        <span className="run-choice-text"><strong>Playtest to check changes</strong><span>After a change a playtest can check, run a short one and stop it before replying.</span></span>
        <SettingsSwitch label="Playtest to check changes" checked={autoPlaytest} onChange={onAutoPlaytest} />
      </div>
    </>}
  </ComposerMenu>;
}
