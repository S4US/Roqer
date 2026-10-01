import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AudioLines, Box, Camera, Check, ChevronRight, CloudUpload, Copy, ExternalLink, FileBox, FileCode2, Film, ImageIcon, PersonStanding,
} from "lucide-react";
import type { RunChange, RunEvidence } from "../shared/run-events";
import type { ChangeGroup } from "./diff-view";
import { PreviewsPanel } from "./evidence-previews";
import {
  arrivedTab, initialResultsView, rememberResults, resultsSummary, runResults, settleFileDefaults, shownTab, TAB_NAME, uploadEntry,
  type ResultsTab, type ResultsTabInfo, type ResultsViewState, type UploadEntry,
} from "./results-model";

const TAB_ICON: Record<ResultsTab, ReactNode> = {
  changes: <FileCode2 size={14} aria-hidden="true" />,
  uploads: <CloudUpload size={14} aria-hidden="true" />,
  screenshots: <Camera size={14} aria-hidden="true" />,
  previews: <Box size={14} aria-hidden="true" />,
};

/** Every run's card as the reader left it, by run id. See `ResultsViewState`. */
const remembered = new Map<string, ResultsViewState>();

/** How the Changes tab renders a file's diff open or folded, and reports a toggle. */
export type FileExpansion = {
  isOpen: (target: string) => boolean;
  onToggle: (target: string, open: boolean) => void;
};

/**
 * Everything a run left behind — changed files, uploaded assets, pictures — in
 * one card, one kind at a time.
 *
 * Every count sits on its tab, so a kind in another tab is never out of sight.
 * A live run shows whatever arrived last until the reader picks a tab; after
 * that the card stays where they put it. An earlier run's card starts folded to
 * its header, which still reads as a one-line account of what it produced, and
 * clicking any tab opens it there. What the reader chose is kept by run id,
 * so it survives the run ending and the chat being left and reopened.
 *
 * The file diffs are rendered by the caller, which owns the editor panel.
 */
export const ResultsCard = memo(function ResultsCard({ runId, changes, evidence, collapsed = false, renderFiles }: {
  /** The run this card belongs to; the live card and the recorded one share it. */
  runId: string;
  changes: readonly RunChange[];
  evidence: readonly RunEvidence[];
  /** Start folded to the header: an earlier run in the chat. */
  collapsed?: boolean;
  renderFiles: (files: ChangeGroup[], expansion: FileExpansion) => ReactNode;
}) {
  const results = useMemo(() => runResults(changes, evidence), [changes, evidence]);
  const { tabs } = results;
  const [view, setView] = useState<ResultsViewState>(() => remembered.get(runId) ?? initialResultsView(tabs, collapsed));
  const update = useCallback((change: (current: ResultsViewState) => ResultsViewState) => {
    setView((current) => {
      const next = change(current);
      if (next !== current) rememberResults(remembered, runId, next);
      return next;
    });
  }, [runId]);
  const seen = useRef<readonly ResultsTabInfo[]>(tabs);
  useEffect(() => {
    const arrived = arrivedTab(seen.current, tabs);
    seen.current = tabs;
    if (arrived !== null) update((current) => (current.following === arrived ? current : { ...current, following: arrived }));
  }, [tabs, update]);
  const baseId = useId();
  const tabRefs = useRef(new Map<ResultsTab, HTMLButtonElement>());
  const { open } = view;
  const active = shownTab(tabs, view.picked, view.following);
  // Tabs the reader has had open keep their panels mounted, hidden, so what
  // they chose there is still there when they come back; a tab never opened
  // builds nothing. File defaults are fixed as files are first seen. Both are
  // settled during render, so neither shows a frame of the wrong state.
  const files = settleFileDefaults(view.files, results.files.map((group) => group.target));
  const visit = open && active !== null && !view.visited.includes(active);
  if (visit || files !== view.files) {
    update((current) => ({
      ...current,
      files: settleFileDefaults(current.files, results.files.map((group) => group.target)),
      visited: visit && active !== null && !current.visited.includes(active) ? [...current.visited, active] : current.visited,
    }));
  }
  const expansion = useMemo<FileExpansion>(() => ({
    isOpen: (target) => files[target] ?? false,
    onToggle: (target, isOpen) => update((current) => ({ ...current, files: { ...current.files, [target]: isOpen } })),
  }), [files, update]);
  const onChooseVersion = useCallback((id: string, at: number) => {
    update((current) => ({ ...current, versions: { ...current.versions, [id]: at } }));
  }, [update]);
  if (active === null) return null;

  const choose = (id: ResultsTab) => update((current) => ({ ...current, picked: id, open: true }));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((tab) => tab.id === active);
    const next = event.key === "ArrowRight" ? (at + 1) % tabs.length
      : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
        : event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
            : null;
    if (next === null) return;
    event.preventDefault();
    choose(tabs[next].id);
    tabRefs.current.get(tabs[next].id)?.focus();
  };

  const panelId = (id: ResultsTab) => `${baseId}-${id}-panel`;
  const tabId = (id: ResultsTab) => `${baseId}-${id}`;
  return <section className="results-card" data-open={open} aria-label={`Results: ${resultsSummary(tabs)}`}>
    <div className="results-header">
      <button
        type="button"
        className="results-collapse"
        aria-expanded={open}
        aria-controls={open ? panelId(active) : undefined}
        title={open ? "Fold the results" : "Show the results"}
        onClick={() => update((current) => ({ ...current, open: !current.open }))}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <div className="results-tabs" role="tablist" aria-label="Results" onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const noun = tab.count === 1 ? TAB_NAME[tab.id].one : TAB_NAME[tab.id].many;
          return <button
            key={tab.id}
            ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            className="results-tab"
            aria-selected={selected}
            aria-controls={view.visited.includes(tab.id) ? panelId(tab.id) : undefined}
            aria-label={`${TAB_NAME[tab.id].title}, ${tab.count} ${noun}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => choose(tab.id)}
          >
            {TAB_ICON[tab.id]}
            <span className="results-tab-name">{TAB_NAME[tab.id].title}</span>
            <span className="results-tab-count">{tab.count}</span>
            {tab.id === "changes" && ((tab.added ?? 0) > 0 || (tab.removed ?? 0) > 0) && <span className="diff-summary" aria-hidden="true">
              {(tab.added ?? 0) > 0 && <span className="added">+{tab.added}</span>}
              {(tab.removed ?? 0) > 0 && <span className="removed">−{tab.removed}</span>}
            </span>}
          </button>;
        })}
      </div>
    </div>
    {/* Mounted on first visit: a folded card in a long chat builds none of
        its diffs, tiles or pictures. A hidden pictures panel is display:none,
        so its inline animation leaves view and gives up its WebGL context. */}
    {tabs.filter((tab) => view.visited.includes(tab.id)).map((tab) => <div
      key={tab.id}
      className="results-panel"
      role="tabpanel"
      id={panelId(tab.id)}
      aria-labelledby={tabId(tab.id)}
      data-tab={tab.id}
      hidden={!open || tab.id !== active}
    >
      {tab.id === "changes" && renderFiles(results.files, expansion)}
      {tab.id === "uploads" && <UploadsPanel uploads={results.uploads} />}
      {(tab.id === "screenshots" || tab.id === "previews") && <PreviewsPanel
        category={tab.id}
        evidence={evidence}
        changes={changes}
        chosen={view.versions}
        onChoose={onChooseVersion}
      />}
    </div>)}
  </section>;
});

/**
 * The run's uploads as a grid of small tiles: what each asset is called, what
 * kind it is, its id, and what moderation said — with the two things someone
 * does next with an asset, copying its id and opening it on Roblox, one click
 * away. Six uploads fill two short rows rather than six cards.
 */
const UploadsPanel = memo(function UploadsPanel({ uploads }: { uploads: readonly ChangeGroup[] }) {
  const entries = useMemo(() => uploads.map(uploadEntry), [uploads]);
  return <ul className="upload-grid">
    {entries.map((entry) => <UploadTile key={entry.key} entry={entry} />)}
  </ul>;
});

function uploadIcon(type: string): ReactNode {
  const kind = type.toLowerCase();
  if (/animation/.test(kind)) return <PersonStanding size={16} aria-hidden="true" />;
  if (/model|mesh|package/.test(kind)) return <Box size={16} aria-hidden="true" />;
  if (/image|decal|texture/.test(kind)) return <ImageIcon size={16} aria-hidden="true" />;
  if (/audio|sound/.test(kind)) return <AudioLines size={16} aria-hidden="true" />;
  if (/video/.test(kind)) return <Film size={16} aria-hidden="true" />;
  return <FileBox size={16} aria-hidden="true" />;
}

const COPIED_FOR_MS = 1_600;

function UploadTile({ entry }: { entry: UploadEntry }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), COPIED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const reference = entry.assetId === undefined ? undefined : `rbxassetid://${entry.assetId}`;
  const copy = () => {
    if (reference === undefined) return;
    if (navigator.clipboard === undefined) {
      setCopied("failed");
      return;
    }
    navigator.clipboard.writeText(reference).then(() => setCopied("copied"), () => setCopied("failed"));
  };
  return <li className="upload-tile">
    <span className="upload-icon">{uploadIcon(entry.type)}</span>
    <div className="upload-text">
      <strong title={entry.name}>{entry.name}</strong>
      <span>
        {entry.type}
        {entry.assetId !== undefined && <> · <code>{entry.assetId}</code></>}
        {entry.writes > 1 && <> · {entry.writes} uploads</>}
        {entry.moderation && <> · <span className="upload-moderation" data-tone={entry.moderation.tone} title="Moderation, as Roblox reported it">
          {entry.moderation.label}
        </span></>}
      </span>
    </div>
    <div className="upload-actions">
      {reference !== undefined && <button
        type="button"
        onClick={copy}
        title={copied === "copied" ? "Copied" : copied === "failed" ? "Could not copy" : `Copy ${reference}`}
        aria-label={copied === "copied" ? `Copied ${reference}` : `Copy ${reference}`}
        data-state={copied}
      >
        {copied === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>}
      {entry.assetUrl !== undefined && <a href={entry.assetUrl} target="_blank" rel="noreferrer" title="Open on Roblox" aria-label={`Open ${entry.name} on Roblox`}>
        <ExternalLink size={14} aria-hidden="true" />
      </a>}
    </div>
  </li>;
}
