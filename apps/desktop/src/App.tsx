import {
  AlertCircle, AlertTriangle, Archive, Boxes, Check, ChevronDown, ChevronRight, Circle, Download,
  CircleDot, ExternalLink, FileBox, FileCode2, FileText, Folder, FolderPlus, Gamepad2,
  HelpCircle, Info, Loader2, MessageSquare, MinusCircle, MoreHorizontal,
  ArrowUp, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Play, Plus, RotateCw, Search, Settings, Square,
  ShieldCheck, Sparkles, MousePointerClick,
  Trash2, Upload, X,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AttachmentChip, MessageFiles, MessagePictures } from "./attachment-views";
import { isImageAttachment } from "./attachment-detail";
import { ClipTrimDialog } from "./clip-trim-dialog";
import { VIDEO_EXTENSIONS, type ClipSelection } from "../shared/reference-clip";
import { describeSelection, selectionChipParts, selectionKey, selectionToOffer, type StudioSelection } from "../shared/studio-selection";
import {
  appendMessage, createChat, createId, createInitialWorkspace, createProject, undeliverNotes, withMessageSelection,
  deleteChat, deleteProject, modelPreference, normalizeWorkspace, renameChat,
  renameProject, selectedModelId, setChatCompaction, setChatStudioInstance, chatStudioTarget, chatsByActivity, withdrawMessage,
  type AssetAttachment, type ChatMessage, type WorkspaceState,
} from "./model";
import {
  cancelRun, cancelRunStart, compactChatSessions, forgetChatSessions, getStudioStatus,
  hasDesktopRuntime, loadWorkspace, pickAsset, getStorageStatus, recoverWorkspace, exportWorkspace, releaseAttachments,
  answerRunQuestion, attachImage, attachVideo, ATTACHABLE_IMAGE_TYPES, ATTACHABLE_VIDEO_TYPES, selectClip, steerRun, compactChat,
  getBridgeState, restartBridge, subscribeToBridge, type McpServerState,
  getUpdateState, installUpdate, subscribeToUpdates, type AppUpdateState,
  flushWorkspace, getProviderModels, getProviderStatus, getStudioSelection, openScriptInStudio, respondToRun, saveWorkspace, startRun,
  subscribeToRuns,
  type ProviderModelCatalog, type ProviderStatus,
  type StudioStatus,
} from "./platform";
import {
  activitySteps, applyRunEvent, createRunView, describeOutcome, recordAppliedAndVerified,
  latestProse, recordGateIssues, recordHasWarnings, recordOnlyAnswered, recordReply, recordSteps, runAppliedAndVerified,
  runGateIssues, runHasWarnings, runOnlyAnswered, toRunRecord, hasPicture,
  type ActivityStep, type PendingApproval, type RunView,
} from "./run-view";
import { EvidencePicture, rememberEvidencePicture } from "./evidence-picture";
import { EvidenceSound } from "./evidence-sound";
import { QUESTION_ESCAPE_OPTION, type RunQuestion } from "../shared/question";
import { taskProgress, type RunTask, type RunTaskStatus } from "../shared/tasks";
import { runResults } from "./results-model";
import { Markdown, StreamingMarkdown } from "./markdown-view";
import { usePresence } from "./presence";
import { useSettledFlag } from "./settled-flag";
import { SettingsPage } from "./settings-page";
import { DiagnosticsActions } from "./diagnostics-actions";
import { sendBlockedNotice } from "./send-blocked";
import type { FileExpansion } from "./results-card";
import { targetLabel } from "./run-deck-model";
import { RunDeckProvider, RunDeckToggle, RunResults, useRunDeck } from "./run-deck";
import { ModelMenu, RunMenu } from "./composer-menus";
import { ContextMeter } from "./context-meter";
import { compactUsageNote, contextMeterView, nextContextReading, type ContextReading } from "./context-usage";
import { blockPreview, characterCount, composedMessage, finishBlockEdit, isLongPaste, lineCount, textSize, withBlockText, type PastedBlock } from "./composer-text";
import { RojoPill } from "./rojo-pill";

/** The key that sends with Enter and makes a new chat with N, named the way this computer's keyboard names it. */
const SEND_MODIFIER = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl";

import { providerCard } from "./provider-card";
import { COMMUNITY_INVITE_URL, communityInvite } from "./community-invite";
import { CommunityCard, CommunityIcon } from "./community-links";
import { approvalCode } from "./approval-code";
import {
  canOpenInStudio, highlightRows, parseDiffRows, sourceRows, splitChangeGroup,
  type ChangeGroup, type DiffRow, type SyntaxToken,
} from "./diff-view";
import {
  aggregateDuration, buildActivityModel, completedRunMetadataLabel, countedActions, currentNodeTitle, finishedRunSummary,
  elapsedLabel, MAX_VISIBLE_ALERTS, outputTokensLabel, type ActivityNode, type StepStatus,
} from "./activity-model";
import { CompletionLine } from "./completion-line";
import { ReviewCard, PromptDraftContext } from "./review-card";
import {
  CONVERSATION_WINDOW_SIZE, earlierConversationWindowStart, initialConversationWindowStart,
} from "./conversation-window";
import { DEMO_PLANNER, startDemoRun, type DemoRunHandle } from "./demo-run";
import { evidenceDetailLabel, type ActivityKind } from "../shared/activity";
import { boundConversation, MAX_MESSAGE_ATTACHMENTS, type ConversationMessage } from "../shared/conversation";
import { compactChatSummary } from "../shared/chat-compaction";
import { digestIsEmpty, digestRun } from "../shared/run-digest";
import { MAX_STEER_CHARS } from "../shared/steer";
import { describePolicyReason } from "../shared/policy";
import { mcpServerMessage } from "../shared/mcp-server";
import { appUpdateMessage, canInstallUpdate, updateInProgress } from "../shared/app-update";
import type {
  RunChange, RunEvent, RunEvidence, RunMetadata, RunOutcome, RunRecord, RunStartRequest,
} from "../shared/run-events";
import { connectedStudios, resolveInstanceId } from "../shared/studio-status";
import type { StorageStatus } from "../shared/workspace-storage";
import { providerLabel, type ProviderId } from "../shared/provider";

/**
 * The one dialog that can be open, and what it is about.
 *
 * Modelled as a single value rather than a flag per dialog: two of these on
 * screen at once would be a bug, and naming the subject here is what lets a
 * rename or a delete survive the row it was opened from scrolling away.
 */
type Dialog =
  | { kind: "create-project" }
  | { kind: "rename-project"; projectId: string }
  | { kind: "delete-project"; projectId: string }
  | { kind: "rename-chat"; projectId: string; chatId: string }
  | { kind: "delete-chat"; projectId: string; chatId: string };

const RENAME_ACTION = "rename";
const DELETE_ACTION = "delete";

/** Where the stylesheet stops docking the sidebar beside the workspace and
 *  starts laying it over the top. Kept in step with the matching breakpoint in
 *  `styles.css`, because the two answers have to agree. */
const SIDEBAR_OVERLAY = `(max-width: 840px)`;

const prefersOverlaySidebar = (): boolean =>
  typeof window !== "undefined" && window.matchMedia(SIDEBAR_OVERLAY).matches;

/** Whether the sidebar is currently covering the workspace rather than sitting
 *  beside it. The difference matters to more than the stylesheet: a sidebar
 *  lying over the conversation is in the way once a chat has been picked, and a
 *  docked one is not. */
function useOverlaySidebar(): boolean {
  const [overlay, setOverlay] = useState(prefersOverlaySidebar);
  useEffect(() => {
    const media = window.matchMedia(SIDEBAR_OVERLAY);
    const update = () => setOverlay(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return overlay;
}

const CHAT_MENU_ITEMS: readonly RowMenuItem[] = [
  { id: RENAME_ACTION, label: "Rename chat", icon: <Pencil size={14} /> },
  { id: "export", label: "Export chat…", icon: <Download size={14} /> },
  { id: "archive", label: "Archive to file…", icon: <Archive size={14} /> },
  { id: DELETE_ACTION, label: "Delete chat", icon: <Trash2 size={14} />, danger: true },
];

const countLabel = (count: number, noun: string): string =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;

const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** Matches the bound the run contract enforces on one turn. */
const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * One chat's run as the window tracks it. A chat has at most one run at a time,
 * and several chats may run at once: the main process refuses a second run in
 * the same chat or on the same Studio place, and everything else is per chat.
 */
type ChatRun = {
  projectId: string;
  chatId: string;
  /** The main process's id for the run; null until the start answers. */
  runId: string | null;
  /** The start's id while the main process is still starting the run. */
  startId: string | null;
  /** Which start this is, so an answer for a run the person has since abandoned is ignored. */
  attempt: number;
  view: RunView | null;
  /** The browser-only demo run that stands in for the main process when there is no desktop runtime. */
  demo: DemoRunHandle | null;
  /** The chat, provider and model the run's context readings describe. */
  contextTarget: { chatId: string; provider: ProviderId; model: string | null };
};

/** Whether a run is stopped on the person: a question or an approval waits for them. */
const runNeedsInputOf = (run: ChatRun): boolean =>
  run.view !== null && run.view.outcome === null && (run.view.pendingQuestion !== null || run.view.pendingApproval !== null);

/** A manual compact keeps the last exchange word for word, so the next run starts from what was just said. */
const COMPACT_KEEPS_MESSAGES = 2;

/**
 * A chat's messages as the model is given them: the words, the run digests, and
 * how many files a message carried. The send path and a compact both use it, so
 * a record is written from the same view the model would have been sent.
 */
function toConversationMessages(messages: readonly ChatMessage[]): ConversationMessage[] {
  return messages.map(({ role, text, run, attachments: attached, note, studioSelection }) => {
    const digest = run === undefined ? undefined : digestRun(run);
    // A replay carries the words, not the files; the count says they existed.
    // Clamped to what the main process accepts, so an odd saved message can
    // never make the chat impossible to continue.
    const images = (attached ?? []).filter(isImageAttachment).length;
    const pictures = Math.min(images, MAX_MESSAGE_ATTACHMENTS);
    const files = Math.min((attached ?? []).length - images, MAX_MESSAGE_ATTACHMENTS);
    return {
      role, text,
      ...(digest === undefined || digestIsEmpty(digest) ? {} : { run: digest }),
      ...(role === "user" && pictures + files > 0 ? { attachments: { pictures, files } } : {}),
      ...(note === true && role === "user" ? { note: true as const } : {}),
      ...(role === "user" && studioSelection !== undefined && studioSelection.count > 0 ? { selection: studioSelection } : {}),
      ...(role === "assistant" && run !== undefined ? { claude: run.planner === "claude-code" } : {}),
    };
  });
}

/**
 * The pictures an attachment adds to its message: a clip goes as up to two
 * sheets of its frames, a still as itself, anything else as none.
 */
const imageSlots = (attachment: AssetAttachment): number =>
  attachment.clip !== undefined ? 2 : isImageAttachment(attachment) ? 1 : 0;

const totalImageSlots = (attached: readonly AssetAttachment[]): number =>
  attached.reduce((total, attachment) => total + imageSlots(attachment), 0);

/**
 * A video by its type, or by its name when the system gave it none, as
 * Windows does for MKV and WebM. The main process reads the bytes to be sure.
 */
const isVideoFile = (file: File): boolean =>
  ATTACHABLE_VIDEO_TYPES.has(file.type) ||
  (file.type === "" && VIDEO_EXTENSIONS.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()));

function App() {
  // Dark unless this machine has chosen otherwise. Roqer sits beside Studio,
  // which is dark by default, and a white window next to it is the jarring one.
  const initialTheme = useMemo(
    () => window.localStorage.getItem("workbench-theme") === "light" ? "light" : "dark",
    [],
  );
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createInitialWorkspace(initialTheme));
  const [hydrated, setHydrated] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [storageRecovery, setStorageRecovery] = useState<StorageStatus>({ required: false, message: null });
  const [storageError, setStorageError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  const [bridgeState, setBridgeState] = useState<McpServerState>({ kind: "starting" });
  const [bridgeBusy, setBridgeBusy] = useState(false);
  /**
   * Dismissal is session-scoped on purpose: the plugin is only replaced once
   * per app update, so the notice cannot come back later in the same session,
   * and remembering the dismissal across launches would hide it after the next
   * update too.
   */
  const [studioRestartDismissed, setStudioRestartDismissed] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateState>({ kind: "idle" });
  const [storageBusy, setStorageBusy] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState(() => new Set<string>());
  const [composer, setComposer] = useState("");
  /** Long pastes, folded out of the text so what was typed stays readable. Sent first, in order. */
  const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([]);
  const [composerExpanded, setComposerExpanded] = useState(false);
  /** The pasted block open in the larger editor, if one is. Its text is edited there, apart from what was typed. */
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AssetAttachment[]>([]);
  /** Clips whose frames Roqer is reading, and the one whose part is being chosen. */
  const [readingClips, setReadingClips] = useState<ReadonlySet<string>>(() => new Set());
  const [trimmingClip, setTrimmingClip] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  /** Every chat's run, keyed by chat. See `runsRef` for why the latest copy is also kept in a ref. */
  const [runs, setRunsState] = useState<ReadonlyMap<string, ChatRun>>(() => new Map());
  /** The latest context reading per chat, for the composer's meter. Never saved; see context-usage.ts. */
  const [contextReadings, setContextReadings] = useState<ReadonlyMap<string, ContextReading>>(() => new Map());
  /** The chat whose compact is waiting on the main process. */
  const [compactingChatId, setCompactingChatId] = useState<string | null>(null);
  // What the last compact said, kept with its chat so it never shows on another one.
  const [compactNotice, setCompactNotice] = useState<{ chatId: string; text: string } | null>(null);
  /** The callId of a pending question being answered in the composer, if any. */
  const [explainingQuestion, setExplainingQuestion] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const clearComposer = useCallback(() => {
    setComposer("");
    setPastedBlocks([]);
    setComposerExpanded(false);
    setEditingBlockId(null);
  }, []);
  // The box grows with what is typed, up to a limit the stylesheet sets, and
  // scrolls after that; the expanded editor fills its space instead.
  useLayoutEffect(() => {
    const box = composerRef.current;
    if (box === null) return;
    box.style.height = "";
    if (!composerExpanded) box.style.height = `${box.scrollHeight}px`;
  }, [composer, composerExpanded, pastedBlocks.length, editingBlockId]);
  // The transcript keeps room for the composer below its last message, so a
  // composer grown by a long draft never hides what it is replying to.
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const workspaceElement = dock?.parentElement;
    if (!dock || !workspaceElement || composerExpanded) return;
    // On the shell, because the Run Deck beside the workspace stops above the dock too.
    const measure = () => (workspaceElement.closest<HTMLElement>(".app-shell") ?? workspaceElement).style.setProperty("--dock-height", `${Math.ceil(dock.getBoundingClientRect().height)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [composerExpanded]);
  // A review's findings go into the box for the person to read, change and
  // send themselves; after words already there, never in place of them.
  const draftPrompt = useCallback((text: string) => {
    setComposer((current) => current.trim() === "" ? text : `${current.trimEnd()}\n\n${text}`);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);
  // Choosing to explain moves the person's attention from the card to the
  // box, so the box takes focus rather than waiting to be clicked.
  useEffect(() => {
    if (explainingQuestion !== null) composerRef.current?.focus();
  }, [explainingQuestion]);
  const [showConnection, setShowConnection] = useState(false);
  const connectionPopover = usePresence(showConnection, MENU_LEAVE_MS);
  const connectionRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const settingsPage = usePresence(showSettings, SETTINGS_LEAVE_MS);
  /** The community icon has just taken the dismissed card's place and pulses once. */
  const [communityIconArrived, setCommunityIconArrived] = useState(false);
  /** The chat whose message waits for its compaction to finish before it sends. */
  const [sendAfterCompact, setSendAfterCompact] = useState<string | null>(null);
  /** Why Send opened Settings, shown at the top of it; null when it was opened by hand. */
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // One flag for both layouts, since "is the sidebar there" is one question
  // however it is answered visually. Only the starting answer differs, and the
  // window supplies that: one too narrow to dock the sidebar has no room to
  // spend showing it unasked.
  const [sidebarShown, setSidebarShown] = useState(() => !prefersOverlaySidebar());
  const overlaySidebar = useOverlaySidebar();
  const [studioStatus, setStudioStatus] = useState<StudioStatus>({ kind: "checking", endpoint: workspace.preferences.mcpEndpoint, message: "Checking local MCP" });
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ kind: "checking", message: "Checking provider" });
  const [modelCatalog, setModelCatalog] = useState<ProviderModelCatalog>({ models: [], defaultModelId: null });
  const saveRevision = useRef(0);
  // The async paths -- a start answering, an event arriving -- read the runs
  // through this ref, never through a render's copy, which may be stale. It is
  // always the map last committed, and every write goes through `setRuns`.
  const runsRef = useRef<ReadonlyMap<string, ChatRun>>(new Map());
  const setRuns = useCallback((next: ReadonlyMap<string, ChatRun>) => {
    runsRef.current = next;
    setRunsState(next);
  }, []);
  // A run's id is only known once the main process answers, but its events can
  // arrive before that. While any start is pending they are held here, and each
  // is drained onto its run when the id is adopted.
  const eventBuffer = useRef<RunEvent[]>([]);
  const startsPending = useRef(0);
  const runAttempt = useRef(0);
  // The finished runs already written into their chats, so a replayed effect
  // (StrictMode runs effects twice in development) cannot record one twice.
  const recordedRuns = useRef(new Set<string>());
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  /** Whether the box holds nothing typed or pasted, as of the latest render. */
  const composerEmpty = useRef(true);
  composerEmpty.current = composer === "" && pastedBlocks.length === 0;

  const selectedProject = useMemo(
    () => workspace.projects.find((project) => project.id === workspace.selectedProjectId) ?? workspace.projects[0],
    [workspace],
  );
  const selectedChat = useMemo(
    () => selectedProject?.chats.find((chat) => chat.id === workspace.selectedChatId),
    [selectedProject, workspace.selectedChatId],
  );

  /**
   * Abandon a chat's run, used when the chat or its project is deleted. With no
   * chat given, every run is abandoned, which is what unmounting does.
   */
  const resetRun = useCallback((chatId?: string, discard = false) => {
    const doomed = chatId === undefined
      ? [...runsRef.current.values()]
      : [runsRef.current.get(chatId)].filter((run): run is ChatRun => run !== undefined);
    if (doomed.length === 0) return;
    for (const run of doomed) {
      if (run.startId !== null) void cancelRunStart(run.startId);
      if (run.demo !== null) run.demo.cancel();
      else if (run.runId !== null) void cancelRun(run.runId, discard);
    }
    const next = new Map(runsRef.current);
    for (const run of doomed) next.delete(run.chatId);
    setRuns(next);
  }, [setRuns]);

  /** Whether a run id belongs to a run the window is tracking. */
  const runIsKnown = useCallback((runId: string) => [...runsRef.current.values()].some((run) => run.runId === runId), []);

  /**
   * Apply events to the runs they belong to, in order. An event for a run the
   * window is not tracking takes nowhere. A context reading the run reports
   * becomes its chat's latest, for the meter, as it arrives.
   */
  const applyRunEvents = useCallback((events: readonly RunEvent[]) => {
    let next = runsRef.current;
    const readings: Array<{ chatId: string; reading: ContextReading }> = [];
    for (const event of events) {
      const run = [...next.values()].find((candidate) => candidate.runId === event.runId);
      if (run === undefined || run.view === null) continue;
      const view = applyRunEvent(run.view, event);
      if (view === run.view) continue;
      if (view.contextUsage !== null && view.contextUsage !== run.view.contextUsage) {
        readings.push({
          chatId: run.chatId,
          reading: { ...run.contextTarget, ...view.contextUsage, observedAt: Date.now() },
        });
      }
      next = new Map(next).set(run.chatId, { ...run, view });
    }
    if (next !== runsRef.current) setRuns(next);
    for (const { chatId, reading } of readings) {
      setContextReadings((current) => new Map(current).set(chatId, nextContextReading(current.get(chatId), reading)));
    }
  }, [setRuns]);

  // Subscribing once at mount means no event can be missed between starting a
  // run and learning its id.
  //
  // Events are applied a frame at a time rather than as they arrive. Each one
  // crosses IPC as its own task, so a reply streaming at token rate was one
  // React commit per token; folding whatever arrived in the last 16 ms into one
  // commit caps the rate at the frame rate without delaying anything a person
  // could see. Order is preserved -- the batch is applied in arrival order --
  // and an event for a run that is no longer active is still dropped.
  useEffect(() => {
    const pending: RunEvent[] = [];
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      scheduled = null;
      applyRunEvents(pending.splice(0));
    };
    const unsubscribe = subscribeToRuns((event) => {
      // A picture arrives with its ref; kept under it, the saved run shows it
      // at once when it replaces the live one, instead of asking for it again.
      if (event.type === "evidence") rememberEvidencePicture(event.evidence);
      if (!runIsKnown(event.runId)) {
        if (startsPending.current > 0) eventBuffer.current.push(event);
        return;
      }
      pending.push(event);
      scheduled ??= setTimeout(flush, 16);
    });
    return () => {
      unsubscribe();
      if (scheduled !== null) clearTimeout(scheduled);
    };
  }, [applyRunEvents, runIsKnown]);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspace()
      .then(async (saved) => {
        const status = await getStorageStatus();
        if (cancelled) return;
        setStorageRecovery(status);
        if (status.required) setSaveStatus("error");
        const restored = normalizeWorkspace(saved, initialTheme);
        setWorkspace(restored);
        // Open the project the user was last in, so their chats are visible
        // without a click. Nothing is expanded before this point.
        setExpandedProjects(new Set([restored.selectedProjectId]));
        setHydrated(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStorageAvailable(false);
        setSaveStatus("error");
        setStorageError(error instanceof Error ? error.message : "Saved chats could not be loaded. Retry before making changes.");
        setHydrated(true);
      });
    return () => { cancelled = true; resetRun(); };
  }, [initialTheme, resetRun]);

  useEffect(() => {
    if (!hydrated || !storageAvailable || storageRecovery.required) return;
    const revision = ++saveRevision.current;
    setSaveStatus("saving");
    void saveWorkspace(workspace)
      .then(() => { if (saveRevision.current === revision) { setSaveStatus("saved"); setStorageError(null); } })
      .catch((error: unknown) => { if (saveRevision.current === revision) {
        setSaveStatus("error");
        setStorageError(error instanceof Error ? error.message : "Changes could not be saved. Export a copy, then retry.");
      } });
  }, [hydrated, storageAvailable, storageRecovery.required, workspace]);

  useEffect(() => {
    if (!hydrated || !storageAvailable || storageRecovery.required) return;
    const flush = () => flushWorkspace(workspace);
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [hydrated, storageAvailable, storageRecovery.required, workspace]);

  useEffect(() => {
    window.localStorage.setItem("workbench-theme", workspace.preferences.theme);
  }, [workspace.preferences.theme]);
  // Dialogs and menus portalled into the body sit outside the shell, and
  // native controls read `color-scheme` from the root, so the theme is kept on
  // the document root too.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = workspace.preferences.theme;
  }, [workspace.preferences.theme]);

  const refreshStudioStatus = useCallback(async () => {
    setStudioStatus(await getStudioStatus(workspace.preferences.mcpEndpoint));
  }, [workspace.preferences.mcpEndpoint]);

  /**
   * Follow the bridge Roqer runs for itself. Its state changes on its own — it
   * can come up slowly, or die and be restarted — so this listens rather than
   * polls, and re-checks Studio the moment a bridge is available, so the
   * connection pill stops saying "not running" as soon as that stops being true.
   */
  useEffect(() => {
    let cancelled = false;
    void getBridgeState().then((state) => { if (!cancelled) setBridgeState(state); });
    const unsubscribe = subscribeToBridge((state) => {
      setBridgeState(state);
      if (state.kind === "running" || state.kind === "adopted") void refreshStudioStatus();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [refreshStudioStatus]);

  /**
   * Follow the app's own updates. An update carries the Studio plugin with it,
   * so a customer who never restarts drifts on both at once — but installing
   * interrupts, so the interface only ever offers it and never forces it.
   */
  useEffect(() => {
    let cancelled = false;
    void getUpdateState().then((state) => { if (!cancelled) setUpdateState(state); });
    const unsubscribe = subscribeToUpdates(setUpdateState);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // Dismissed the way the app's other menus are: a press anywhere outside, or
  // Escape. The pill itself is inside the wrapper, so its own click still
  // toggles rather than closing and reopening.
  useEffect(() => {
    if (!showConnection) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (connectionRef.current && !connectionRef.current.contains(event.target as Node)) {
        setShowConnection(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowConnection(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showConnection]);

  const restartStudioBridge = useCallback(async () => {
    setBridgeBusy(true);
    try {
      setBridgeState(await restartBridge());
      await refreshStudioStatus();
    } finally {
      setBridgeBusy(false);
    }
  }, [refreshStudioStatus]);

  useEffect(() => {
    if (!hydrated) return;
    void refreshStudioStatus();
    const interval = window.setInterval(() => void refreshStudioStatus(), 5_000);
    return () => window.clearInterval(interval);
  }, [hydrated, refreshStudioStatus]);

  const provider = workspace.preferences.provider;
  const providerRef = useRef<ProviderId>(provider);

  const refreshProviderStatus = useCallback(async () => {
    const requested = provider;
    const status = await getProviderStatus(requested);
    if (providerRef.current === requested) setProviderStatus(status);
  }, [provider]);

  // Kept ahead of the effects below so a response that arrives after a switch
  // can tell that it is answering a question nobody is asking any more.
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  // Switching providers must not leave the previous one's account on screen.
  useEffect(() => {
    setProviderStatus({ kind: "checking", message: `Checking ${providerLabel(provider)}` });
    setModelCatalog({ models: [], defaultModelId: null });
  }, [provider]);

  useEffect(() => {
    if (!hydrated || !hasDesktopRuntime()) return;
    void refreshProviderStatus();
    const interval = window.setInterval(() => void refreshProviderStatus(), 15_000);
    return () => window.clearInterval(interval);
  }, [hydrated, refreshProviderStatus]);

  /**
   * A catalog belongs to the provider it was asked for. Without this guard a
   * slow answer for the previous provider lands after a switch, and the
   * selection effect below records that provider's model id against the new
   * one — which then fails at run start, because no catalog contains it.
   */
  const refreshProviderModels = useCallback(async () => {
    const requested = provider;
    const catalog = await getProviderModels(requested);
    if (providerRef.current === requested) setModelCatalog(catalog);
  }, [provider]);

  useEffect(() => {
    if (!hydrated || providerStatus.kind !== "signed-in") {
      setModelCatalog({ models: [], defaultModelId: null });
      return;
    }
    void refreshProviderModels();
    // A catalog can change while the provider stays signed in: Claude Code
    // and Codex update their model lists, and a custom connection can be
    // edited in Settings. Refresh it independently of provider status so the
    // picker converges without a provider switch or an application restart.
    const interval = window.setInterval(() => void refreshProviderModels(), 30_000);
    return () => window.clearInterval(interval);
  }, [hydrated, providerStatus.kind, refreshProviderModels]);

  useEffect(() => {
    if (!hydrated || modelCatalog.models.length === 0) return;
    setWorkspace((current) => {
      const chosen = selectedModelId(current.preferences, current.preferences.provider);
      // A remembered choice the provider no longer lists falls back to its
      // default rather than blocking the run.
      const models = modelCatalog.models;
      const model = models.find((candidate) => candidate.id === chosen) ??
        models.find((candidate) => candidate.id === modelCatalog.defaultModelId) ??
        models[0];
      const effort = model.supportedReasoningEfforts.some((entry) =>
        entry.reasoningEffort === current.preferences.reasoningEffort)
        ? current.preferences.reasoningEffort
        : model.defaultReasoningEffort;
      if (model.id === chosen && effort === current.preferences.reasoningEffort) return current;
      return {
        ...current,
        preferences: {
          ...current.preferences,
          ...modelPreference(current.preferences.provider, model.id),
          reasoningEffort: effort,
        },
      };
    });
  }, [hydrated, modelCatalog]);

  // A finished run becomes one assistant message carrying a compacted record,
  // so the result survives a restart without keeping the whole event stream.
  // The run leaves the map in the same commit that records it. Retiring the
  // live view on a timer instead left both on screen together, and the reply
  // appeared to arrive twice.
  useEffect(() => {
    // Only a run still in the map can be recorded again, so the rest are let go.
    const tracked = new Set([...runs.values()].map((run) => run.view?.runId));
    for (const runId of recordedRuns.current) if (!tracked.has(runId)) recordedRuns.current.delete(runId);
    const finished = [...runs.values()].filter((run) => run.view !== null && run.view.outcome !== null && !recordedRuns.current.has(run.view.runId));
    if (finished.length === 0) return;
    for (const run of finished) {
      const view = run.view!;
      recordedRuns.current.add(view.runId);
      setWorkspace((current) => appendMessage(undeliverNotes(current, run.projectId, run.chatId, view.notes.length - view.notesDelivered), run.projectId, run.chatId, {
        id: createId("message"),
        role: "assistant",
        text: view.text.trim() || view.summary,
        createdAt: new Date().toISOString(),
        run: toRunRecord(view) ?? undefined,
      }));
    }
    const next = new Map(runsRef.current);
    for (const run of finished) {
      // A run replaced in its chat since this render keeps its place.
      if (next.get(run.chatId)?.view?.runId === run.view?.runId) next.delete(run.chatId);
    }
    setRuns(next);
  }, [runs, setRuns]);

  // The chat on screen is the one whose run the composer, the live view, and
  // the stop control follow. Other chats keep their runs going in the background.
  const selectedRun = selectedChat === undefined ? null : runs.get(selectedChat.id) ?? null;
  const runView = selectedRun?.view ?? null;
  const runStarting = selectedRun !== null && selectedRun.runId === null;
  const isRunning = runStarting || (runView !== null && runView.outcome === null);
  // A run that starts ends a pasted block's edit: the box then belongs to the run's note.
  useEffect(() => { if (isRunning) setEditingBlockId(null); }, [isRunning]);

  /**
   * The Studio selection of the chat's place, for the composer's chip. Read
   * while the window is in front, because that is when the person is writing;
   * while they are in Studio choosing, nothing is read, and the first read on
   * coming back shows what they chose. The chip is a yes or no: the paths the
   * model gets are read again by the main process when the message is sent.
   */
  const [studioSelection, setStudioSelection] = useState<StudioSelection | null>(null);
  const [dismissedSelectionKey, setDismissedSelectionKey] = useState<string | null>(null);
  const [deckHost, setDeckHost] = useState<HTMLElement | null>(null);
  const deck = useRunDeck(workspace.selectedChatId, deckHost);
  const [windowFocused, setWindowFocused] = useState(() => typeof document !== "undefined" && document.hasFocus());
  useEffect(() => {
    const focused = () => setWindowFocused(true);
    const blurred = () => setWindowFocused(false);
    window.addEventListener("focus", focused);
    window.addEventListener("blur", blurred);
    return () => {
      window.removeEventListener("focus", focused);
      window.removeEventListener("blur", blurred);
    };
  }, []);
  const selectionPlace = useMemo(() => {
    if (studioStatus.kind !== "connected") return null;
    const target = chatStudioTarget(workspace, workspace.selectedProjectId, workspace.selectedChatId);
    return resolveInstanceId(studioStatus, target.instanceId, target.pinned);
  }, [studioStatus, workspace]);
  const useSelection = workspace.preferences.useStudioSelection;
  useEffect(() => {
    if (selectionPlace === null || !useSelection) setStudioSelection(null);
    if (!useSelection || !hydrated || !windowFocused || isRunning || selectionPlace === null || !hasDesktopRuntime()) return;
    let cancelled = false;
    const read = async () => {
      const selection = await getStudioSelection(workspace.preferences.mcpEndpoint, selectionPlace);
      if (!cancelled) setStudioSelection(selection);
    };
    void read();
    const interval = window.setInterval(() => void read(), 4_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [useSelection, hydrated, windowFocused, isRunning, selectionPlace, workspace.preferences.mcpEndpoint]);
  const selectionChip = selectionToOffer(studioSelection, { enabled: useSelection, running: isRunning, dismissedKey: dismissedSelectionKey });

  const compactedFrom = selectedChat?.compaction?.folded ?? 0;
  const compactedUsage = compactUsageNote(selectedChat?.compaction?.usedTokens, selectedChat?.compaction?.windowTokens);
  const compactTo = selectedChat === undefined ? 0 : selectedChat.messages.length - COMPACT_KEEPS_MESSAGES;
  // Send waits while the chat on screen is being compacted: a run started
  // between the main process dropping the provider's conversation and the
  // record being saved would rebuild that conversation from the whole chat.
  const compacting = compactingChatId !== null && compactingChatId === selectedChat?.id;
  // Claude chats compact their saved conversation with Claude's own summary;
  // the main process says when there is none, and the record is used instead.
  const modelCompact = provider === "claude" && hasDesktopRuntime();
  // Nothing new to fold yet, or a run may be working on this chat.
  const canCompact = !isRunning && compactingChatId === null &&
    (modelCompact ? (selectedChat?.messages.length ?? 0) > 0 : compactTo > compactedFrom);

  /** Forget a chat's context reading, once a compact has made the figure untrue. */
  const forgetContextReading = (chatId: string) => setContextReadings((current) => {
    if (!current.has(chatId)) return current;
    const next = new Map(current);
    next.delete(chatId);
    return next;
  });

  /**
   * Fold the chat's older messages into a record the model reads in their place.
   * Only the model's view changes: every message stays on screen. The main process
   * is asked first, since it drops the provider's own copy of the conversation and
   * refuses while a run owns the chat, in which case nothing changes here.
   */
  const compactSelectedChat = async () => {
    if (!selectedChat || !selectedProject || !canCompact) return;
    const projectId = selectedProject.id;
    const chatId = selectedChat.id;
    // Held until the whole compact is done, the record fallback included, so a
    // message queued meanwhile is sent with the compacted conversation.
    setCompactingChatId(chatId);
    try {
      if (modelCompact) {
        setCompactNotice({ chatId, text: "Claude is summarizing this chat's conversation; this can take a minute. A message you send now waits until it finishes." });
        const result = await compactChat(projectId, chatId);
        if (result.noSession !== true) {
          setCompactNotice({ chatId, text: result.message });
          // The reading described the context Claude compacted away, so the
          // meter shows nothing rather than a figure beside a notice that
          // contradicts it, until the next run reports.
          if (result.ok) forgetContextReading(chatId);
          return;
        }
        setCompactNotice(null);
        // No saved Claude conversation: the window's own record stands in.
        if (compactTo <= compactedFrom) {
          // Nothing saved and nothing left to fold: say so rather than leave
          // the button looking like it did something.
          setCompactNotice({ chatId, text: "This chat has nothing to compact yet." });
          return;
        }
      }
      if (hasDesktopRuntime() && !(await compactChatSessions(chatId))) return;
      const summary = compactChatSummary(
        selectedChat.compaction?.summary ?? "",
        toConversationMessages(selectedChat.messages.slice(compactedFrom, compactTo)),
      );
      // The figures are the provider's last report for this chat, taken as the
      // compact happens. A chat with no report yet records none.
      const reading = contextReadings.get(chatId);
      const usage: { usedTokens?: number; windowTokens?: number | null } = reading === undefined
        ? {}
        : { usedTokens: reading.usedTokens, windowTokens: reading.windowTokens };
      setWorkspace((current) => setChatCompaction(current, projectId, chatId, { folded: compactTo, summary, ...usage }));
      // The reading described the context before the compact. The meter shows
      // nothing rather than a figure the compact made untrue, until the next run reports.
      forgetContextReading(chatId);
      const note = compactUsageNote(usage.usedTokens, usage.windowTokens);
      setCompactNotice(note === null ? null : { chatId, text: `Compacted. ${note}` });
    } finally {
      setCompactingChatId(null);
    }
  };
  const showRunControls = runStarting || runView !== null;
  /** The composer addresses the running agent rather than starting a run. */
  const steering = isRunning && !runStarting;
  /**
   * The pending question the person chose to answer in their own words. The
   * question stays pending -- the run stays paused -- until the note is sent,
   * because resuming the model before its answer exists would have it proceed
   * on nothing. Cleared by the send, by choosing an option after all, and by
   * the question going away.
   */
  const explaining = explainingQuestion !== null && runView?.pendingQuestion?.callId === explainingQuestion;

  /**
   * Hand the composer's text to the running agent as a note for its next
   * turn. Recorded in the chat the moment it is accepted, so the transcript
   * shows what was said mid-run in the order it was said. Refused only when
   * the run ended first -- then the words stay in the composer and the next
   * Send starts a fresh run with them.
   *
   * While a question waits, the note is the answer to it, whether or not the
   * person chose "none of these" first: the run cannot read a note until the
   * question is answered, so a note sent without answering would leave the run
   * paused on a reply it already has. The answer follows the note: the note
   * has to be queued before the model resumes, so that the turn it resumes
   * into carries both.
   */
  const sendSteer = async () => {
    const text = composer.trim();
    if (!text || !steering) return;
    if (text.length > MAX_STEER_CHARS) { setAttachmentError(`Shorten the note to ${MAX_STEER_CHARS.toLocaleString()} characters.`); return; }
    if (!selectedRun) return;
    const target = { projectId: selectedRun.projectId, chatId: selectedRun.chatId };
    const accepted = selectedRun.demo
      ? selectedRun.demo.steer(text)
      : selectedRun.runId !== null && await steerRun(selectedRun.runId, text);
    if (!accepted) {
      setAttachmentError("Roqer had already finished. Send it as a new message.");
      return;
    }
    setWorkspace((current) => appendMessage(current, target.projectId, target.chatId, {
      id: createId("message"), role: "user", text, createdAt: new Date().toISOString(), note: true,
    }));
    setComposer("");
    const pending = runView?.pendingQuestion;
    if (pending) {
      setExplainingQuestion(null);
      if (selectedRun.demo) selectedRun.demo.answer(pending.callId, pending.options.length);
      else if (selectedRun.runId !== null) void answerRunQuestion(selectedRun.runId, pending.callId, pending.options.length);
    }
  };

  const sendPrompt = async () => {
    if (steering) { await sendSteer(); return; }
    const prompt = composedMessage(pastedBlocks, composer);
    if (!prompt || isRunning || !hydrated || !storageAvailable || storageRecovery.required) return;
    // Starting a run would reopen the conversation being compacted; it waits instead.
    if (compacting && workspace.selectedChatId !== null) { setSendAfterCompact(workspace.selectedChatId); return; }
    if (prompt.length > 64_000) { setAttachmentError("Shorten the message to 64,000 characters before sending."); return; }
    const unread = attachments.find((attachment) => attachment.clip !== undefined && (attachment.clip.id === undefined || readingClips.has(attachment.id)));
    if (unread !== undefined) {
      setAttachmentError(readingClips.has(unread.id)
        ? `Roqer is still reading “${unread.name}”. Send once it has finished.`
        : `Choose the part of “${unread.name}” to send first.`);
      return;
    }
    const chosenModelId = selectedModelId(workspace.preferences, provider);
    const availableModel = modelCatalog.models.find((model) => model.id === chosenModelId);
    if (hasDesktopRuntime() && (providerStatus.kind !== "signed-in" || !availableModel)) {
      setSettingsNotice(sendBlockedNotice(provider, providerStatus, modelCatalog.message));
      setShowSettings(true);
      return;
    }

    let next = workspace;
    if (!next.selectedChatId) next = createChat(next);
    const projectId = next.selectedProjectId;
    const chatId = next.selectedChatId!;
    const targetChat = next.projects.find((project) => project.id === projectId)?.chats.find((chat) => chat.id === chatId);
    // A reply that came from a run carries the host's digest of that run --
    // what it changed, left open, and was told -- so a follow-up starts from
    // the record rather than rediscovering it from Studio.
    // Messages a compact folded away are not replayed; its record stands for them.
    const folded = targetChat?.compaction?.folded ?? 0;
    const conversation = boundConversation(
      toConversationMessages((targetChat?.messages ?? []).slice(folded)),
      targetChat?.compaction?.summary,
    );
    const messageId = createId("message");
    next = appendMessage(next, projectId, chatId, {
      id: messageId, role: "user", text: prompt, createdAt: new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setWorkspace(next);
    setExpandedProjects((current) => new Set(current).add(projectId));
    clearComposer();
    setAttachments([]);
    // Whatever the box was warning about has been answered by sending.
    setAttachmentError(null);

    const request: RunStartRequest = {
      projectId, chatId, prompt, conversation,
      startId: createId("start"),
      attachmentIds: attachments.map((attachment) => attachment.id),
      includeSelection: selectionChip !== null,
      approvalMode: next.preferences.approvalMode,
      autoPlaytest: next.preferences.autoPlaytest,
      webSearch: next.preferences.webSearch,
      review: next.preferences.review,
      endpoint: next.preferences.mcpEndpoint,
      instanceId: (() => {
        const target = chatStudioTarget(next, projectId, chatId);
        return resolveInstanceId(studioStatus, target.instanceId, target.pinned);
      })(),
      provider: next.preferences.provider,
      model: availableModel?.id ?? null,
      effort: availableModel?.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === next.preferences.reasoningEffort)
        ? next.preferences.reasoningEffort
        : availableModel?.defaultReasoningEffort ?? "medium",
    };
    const attempt = ++runAttempt.current;
    const contextTarget = { chatId, provider: request.provider, model: request.model };
    const startId = request.startId!;
    // The chat's run is recorded before anything else happens, so the composer
    // and the sidebar show it at once, and so a later answer can tell it apart.
    const commit = (run: ChatRun) => setRuns(new Map(runsRef.current).set(chatId, run));
    const liveRun = (): ChatRun | undefined => runsRef.current.get(chatId);
    const forget = () => {
      const next = new Map(runsRef.current);
      next.delete(chatId);
      setRuns(next);
    };
    commit({ projectId, chatId, runId: null, startId, attempt, view: null, demo: null, contextTarget });
    setCompactNotice(null);

    if (!hasDesktopRuntime()) {
      const runId = createId("demo-run");
      commit({ projectId, chatId, runId, startId: null, attempt, view: createRunView(runId, prompt, request.approvalMode), demo: null, contextTarget });
      const demo = startDemoRun(runId, request, (event) => applyRunEvents([event]));
      const live = liveRun();
      if (live?.runId === runId) commit({ ...live, demo });
      return;
    }

    /**
     * A run that never started gives its prompt back: the message comes out of
     * the chat and its words go back in the box, with the reason above them,
     * so trying again is one Send. That is only done while the chat is still
     * open and the box still empty. Otherwise the transcript keeps the words
     * and says why they went nowhere, as it always did, rather than dropping
     * them or overwriting what was typed since. Files were released with the
     * failed start, so they have to be attached again.
     */
    const startFailed = (reason: string) => {
      const current = latestWorkspace.current;
      if (!composerEmpty.current || current.selectedProjectId !== projectId || current.selectedChatId !== chatId) {
        setWorkspace((state) => appendMessage(state, projectId, chatId, {
          id: createId("message"), role: "assistant",
          text: `I couldn't start this run: ${reason}`,
          createdAt: new Date().toISOString(),
        }));
        return;
      }
      setWorkspace((state) => withdrawMessage(state, projectId, chatId, messageId));
      setComposer(prompt);
      setAttachmentError(`The run didn't start: ${reason}${attachments.length > 0 ? " Attach your files again before sending." : ""}`);
      composerRef.current?.focus();
    };

    // While this start is pending, events that name no known run are held for it.
    // The count goes down when the start settles, and the held events go with
    // the last of them.
    const finishStart = () => {
      startsPending.current -= 1;
      if (startsPending.current === 0) eventBuffer.current = [];
    };
    startsPending.current += 1;
    let started: Awaited<ReturnType<typeof startRun>>;
    try {
      started = await startRun(request);
    } catch (error) {
      finishStart();
      if (liveRun()?.attempt !== attempt) return;
      forget();
      startFailed(error instanceof Error ? error.message : String(error));
      return;
    }
    const live = liveRun();
    // The chat's run was abandoned while the start was in flight: the run it
    // started is cancelled rather than left working for nobody.
    if (live?.attempt !== attempt) {
      finishStart();
      if (started.ok) void cancelRun(started.runId);
      return;
    }
    if (!started.ok) {
      finishStart();
      forget();
      startFailed(started.message);
      return;
    }

    const buffered = eventBuffer.current
      .filter((event) => event.runId === started.runId)
      .sort((left, right) => left.seq - right.seq);
    eventBuffer.current = eventBuffer.current.filter((event) => event.runId !== started.runId);
    finishStart();
    commit({
      ...live,
      runId: started.runId,
      startId: null,
      view: buffered.reduce(applyRunEvent, createRunView(started.runId, prompt, request.approvalMode)),
    });
    // What Roqer read when the message went, which the chip may not have shown:
    // recorded on the message, so the chat says what the model was told.
    if (started.selection !== undefined) {
      const selection = started.selection;
      setWorkspace((state) => withMessageSelection(state, projectId, chatId, messageId, selection));
    }
    setDismissedSelectionKey(null);
  };

  const answerApproval = (decision: "approved" | "rejected") => {
    const pending = runView?.pendingApproval;
    if (!selectedRun || !pending) return;
    if (selectedRun.demo) selectedRun.demo.respond(pending.callId, decision);
    else if (selectedRun.runId !== null) void respondToRun(selectedRun.runId, pending.callId, decision);
  };

  /** Answer the agent's question by index. */
  const answerQuestion = (answerIndex: number) => {
    const pending = runView?.pendingQuestion;
    if (!selectedRun || !pending) return;
    // Choosing one of the model's options after all withdraws the explanation.
    setExplainingQuestion(null);
    if (selectedRun.demo) selectedRun.demo.answer(pending.callId, answerIndex);
    else if (selectedRun.runId !== null) void answerRunQuestion(selectedRun.runId, pending.callId, answerIndex);
  };

  /** Hand the pending question to the composer; the answer goes out with the note. */
  const explainAnswer = () => {
    const pending = runView?.pendingQuestion;
    if (!runView || !pending) return;
    setExplainingQuestion((current) => current === pending.callId ? null : pending.callId);
  };

  /** Stop the chat on screen. Its start is abandoned if the run has not begun. */
  const stopRun = () => {
    if (!selectedRun) return;
    if (selectedRun.demo) selectedRun.demo.cancel();
    else if (selectedRun.runId !== null) void cancelRun(selectedRun.runId);
    else resetRun(selectedRun.chatId);
  };

  /** Picking a chat gets the sidebar out of the way only when it is in the way.
   *  A docked sidebar is part of the layout and stays put. */
  const dismissOverlaySidebar = useCallback(() => {
    if (overlaySidebar) setSidebarShown(false);
  }, [overlaySidebar]);

  // A message sent during compaction goes once it finishes, into the chat it
  // was written for. Moving to another chat in the meantime drops the wait;
  // the words stay in the composer.
  const sendPromptRef = useRef<() => Promise<void>>(async () => undefined);
  sendPromptRef.current = sendPrompt;
  useEffect(() => {
    if (compactingChatId !== null || sendAfterCompact === null) return;
    const chatId = sendAfterCompact;
    setSendAfterCompact(null);
    if (workspace.selectedChatId === chatId) void sendPromptRef.current();
  }, [compactingChatId, sendAfterCompact, workspace.selectedChatId]);

  const newChat = useCallback(() => {
    if (!hydrated || !storageAvailable || storageRecovery.required) return;
    const next = createChat(workspace);
    setWorkspace(next);
    setExpandedProjects((current) => new Set(current).add(next.selectedProjectId));
    clearComposer(); void releaseAttachments(attachments.map((asset) => asset.id)); setAttachments([]); dismissOverlaySidebar();
  }, [workspace, attachments, hydrated, storageAvailable, storageRecovery.required, dismissOverlaySidebar, clearComposer]);

  const closeDialog = useCallback(() => setDialog(null), []);

  const addProject = (name: string) => {
    if (!storageAvailable || storageRecovery.required) return;
    const next = createProject(workspace, name);
    setWorkspace(next);
    setExpandedProjects((current) => new Set(current).add(next.selectedProjectId));
    closeDialog();
    clearComposer();
  };

  /**
   * Deleting what a run is writing into would leave the run with nowhere to
   * report back to, so the run is abandoned first. The same applies to the open
   * chat, whose live view would otherwise stay on screen above a different
   * conversation.
   *
   * What the chat kept outside the window goes with it: a saved Claude session
   * and Claude Code's transcript of the chat would otherwise outlive the chat
   * the user deleted.
   */
  const removeChat = (projectId: string, chatId: string) => {
    if (!storageAvailable || storageRecovery.required) return;
    resetRun(chatId, true);
    void forgetChatSessions(chatId);
    setWorkspace((current) => deleteChat(current, projectId, chatId));
    clearComposer();
    setAttachments([]);
    closeDialog();
  };

  const removeProject = (projectId: string) => {
    if (!storageAvailable || storageRecovery.required) return;
    for (const chat of workspace.projects.find((project) => project.id === projectId)?.chats ?? []) {
      resetRun(chat.id, true);
      void forgetChatSessions(chat.id);
    }
    setWorkspace((current) => deleteProject(current, projectId));
    setExpandedProjects((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    clearComposer();
    setAttachments([]);
    closeDialog();
  };

  const selectChat = (projectId: string, chatId: string) => {
    setWorkspace((current) => ({ ...current, selectedProjectId: projectId, selectedChatId: chatId }));
    clearComposer();
    void releaseAttachments(attachments.map((asset) => asset.id)); setAttachments([]); dismissOverlaySidebar();
  };

  const selectProject = (projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });
    // Folding the open project away is tidying the sidebar: the chat stays
    // open, with what was being written in it.
    if (projectId === workspace.selectedProjectId) return;
    // Another project opens on another chat, so the draft goes the way it does
    // when a chat is picked, rather than following into a chat it was not for.
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    setWorkspace((current) => ({ ...current, selectedProjectId: projectId, selectedChatId: project === undefined ? null : chatsByActivity(project.chats)[0]?.id ?? null }));
    clearComposer();
    void releaseAttachments(attachments.map((asset) => asset.id)); setAttachments([]);
  };

  const updatePreferences = (changes: Partial<WorkspaceState["preferences"]>) => {
    setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, ...changes } }));
  };

  const dismissCommunityInvite = () => {
    updatePreferences({ communityInviteDismissed: true });
    setCommunityIconArrived(true);
  };

  // Old message cards are intentionally memoized. Keep their action stable too,
  // while still reading the latest endpoint and Studio selection when clicked.
  const chatTarget = chatStudioTarget(workspace, workspace.selectedProjectId, workspace.selectedChatId);
  const chatInstanceId = chatTarget.instanceId;
  const chatPinned = chatTarget.pinned;
  const openArtifactContext = useRef({
    endpoint: workspace.preferences.mcpEndpoint,
    studioInstanceId: chatInstanceId,
    studioStatus,
  });
  useEffect(() => {
    openArtifactContext.current = {
      endpoint: workspace.preferences.mcpEndpoint,
      studioInstanceId: chatInstanceId,
      studioStatus,
    };
  }, [chatInstanceId, studioStatus, workspace.preferences.mcpEndpoint]);
  const openArtifactInStudio = useCallback((target: string, instanceId?: string) => {
    const context = openArtifactContext.current;
    return openScriptInStudio({
      endpoint: context.endpoint,
      target,
      // A change record names the place it was made in, and opening it
      // somewhere else would show the wrong script.
      instanceId: instanceId ?? resolveInstanceId(context.studioStatus, context.studioInstanceId),
    });
  }, []);

  /** Every connected place, so a second one is visible rather than implied. */
  const studios = useMemo(
    () => connectedStudios(studioStatus, chatInstanceId, chatPinned),
    [studioStatus, chatInstanceId, chatPinned],
  );
  /** Record the place for the chat in view, and for the next chat after it. */
  const chooseStudio = (instanceId: string | null) => {
    setWorkspace((current) => setChatStudioInstance(
      current,
      current.selectedProjectId,
      current.selectedChatId,
      instanceId,
    ));
  };
  /**
   * The place the pill names. It has to be the one a run would go to, not
   * whichever plugin connected first: naming a place Roqer is not working in
   * is worse than naming none.
   */
  const targetStudio = studios.find((studio) => studio.isTarget);

  /**
   * Have Roqer read the frames of the part of a clip the user chose. The chip
   * says it is reading until the frames are kept, and the message cannot be
   * sent before then.
   */
  const readClip = async (id: string, selection: ClipSelection) => {
    setReadingClips((current) => new Set(current).add(id));
    try {
      const read = await selectClip(id, selection);
      setAttachments((current) => current.map((attachment) => (attachment.id === id ? read : attachment)));
    } catch (error) {
      // A clip removed while it was read, with its message or by hand, needs no word.
      if (attachmentsRef.current.some((attachment) => attachment.id === id)) {
        setAttachmentError(error instanceof Error ? error.message : "The clip's frames could not be read.");
      }
    } finally {
      setReadingClips((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  /**
   * Keep a newly attached file if the message still has room for its
   * pictures, a clip counting as two; a clip short enough to send whole is
   * read at once, and a longer one opens the dialog for choosing its part.
   */
  const keepAttached = (attached: readonly AssetAttachment[], asset: AssetAttachment): AssetAttachment[] | null => {
    if (totalImageSlots([...attached, asset]) > MAX_IMAGES_PER_MESSAGE) {
      void releaseAttachments([asset.id]);
      setAttachmentError(`One message carries up to ${MAX_IMAGES_PER_MESSAGE} pictures, and a clip is sent as two. Send this one in another message.`);
      return null;
    }
    const next = [...attached, asset];
    setAttachments(next);
    if (asset.clip !== undefined) {
      if (asset.clip.start === 0 && asset.clip.end >= asset.clip.duration) void readClip(asset.id, asset.clip);
      else setTrimmingClip(asset.id);
    }
    return next;
  };

  const attachAsset = async () => {
    setAttachmentError(null);
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) { setAttachmentError("Attach up to eight files per message."); return; }
    try {
      const asset = await pickAsset();
      if (asset) keepAttached(attachments, asset);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "The file could not be attached.");
    }
  };

  /**
   * Attach pasted or dropped pictures and videos, one at a time so that the
   * first failure stops the batch with a reason rather than leaving a
   * half-attached message.
   */
  const attachImages = async (files: readonly File[]) => {
    setAttachmentError(null);
    let attached: AssetAttachment[] = attachments;
    for (const file of files) {
      if (attached.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        setAttachmentError("Attach up to eight files per message.");
        break;
      }
      const video = isVideoFile(file);
      if (totalImageSlots(attached) + (video ? 2 : 1) > MAX_IMAGES_PER_MESSAGE) {
        setAttachmentError(`Send up to ${MAX_IMAGES_PER_MESSAGE} pictures in one message; a clip counts as two.`);
        break;
      }
      try {
        const asset = video
          ? await attachVideo(file, file.name || "clip.mp4")
          : await attachImage(file, file.name || "screenshot.png");
        const kept = keepAttached(attached, asset);
        if (kept === null) break;
        attached = kept;
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : "The file could not be attached.");
        break;
      }
    }
  };

  /** Pictures and videos from a paste or a drop; anything else is left to the browser. */
  const droppedImages = (list: FileList | null | undefined): File[] =>
    Array.from(list ?? []).filter((file) => ATTACHABLE_IMAGE_TYPES.has(file.type) || (hasDesktopRuntime() && isVideoFile(file)));

  const repairStorage = async () => {
    setStorageBusy(true);
    try {
      if (storageRecovery.required || !storageAvailable) {
        const saved = storageRecovery.required ? await recoverWorkspace() : await loadWorkspace();
        const status = await getStorageStatus();
        setWorkspace(normalizeWorkspace(saved, initialTheme));
        setStorageRecovery(status);
        setStorageAvailable(true);
        setSaveStatus(status.required ? "error" : "saved");
      } else {
        await saveWorkspace(latestWorkspace.current);
        setSaveStatus("saved");
      }
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Saved chats could not be recovered.");
    } finally { setStorageBusy(false); }
  };

  const exportChats = async (state?: WorkspaceState) => {
    try { return await exportWorkspace(state); }
    catch (error) { setStorageError(error instanceof Error ? error.message : "The export could not be saved."); return false; }
  };

  const chatAction = async (projectId: string, chatId: string, action: string) => {
    if (action !== "export" && action !== "archive") {
      if (storageAvailable && !storageRecovery.required) setDialog(chatDialog(projectId, chatId, action));
      return;
    }
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    const chat = project?.chats.find((candidate) => candidate.id === chatId);
    if (!project || !chat) return;
    if (action === "archive" && (runsRef.current.has(chatId) || !hasDesktopRuntime() || !storageAvailable || storageRecovery.required)) {
      setStorageError("Archive is available in the desktop app after the chat's run finishes and saved chats are healthy. You can still export a copy.");
      return;
    }
    const exported = await exportChats({ ...workspace, selectedProjectId: projectId, selectedChatId: chatId, projects: [{ ...project, chats: [chat] }] });
    if (exported && action === "archive") {
      const current = latestWorkspace.current.projects.find((candidate) => candidate.id === projectId)?.chats.find((candidate) => candidate.id === chatId);
      if (current !== chat || runsRef.current.has(chatId)) {
        setStorageError("A copy was exported. The chat changed during export, so it remains here.");
      } else removeChat(projectId, chatId);
    }
  };

  /**
   * Follow the conversation as it grows, unless the reader has scrolled away.
   *
   * The transcript only moves on its own while the reader is already at the
   * end of it. Someone who scrolled up to re-read a diff is reading, and
   * yanking them back down because a tool call finished would be the app
   * talking over them.
   *
   * Only the reader turns following off, by moving the view up. Measuring the
   * distance from the end on every scroll event also turned it off by itself:
   * content arriving during the glide after a send left the view briefly far
   * from the end, and the chat stopped following a run nobody had scrolled
   * away from. Reaching the end, or sending a message, turns it back on.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  /**
   * Until when content that grows without a run event is followed: a reply
   * revealing between deltas, a picture loading, the composer changing
   * height. While the chat's run is live, and for a moment after it ends,
   * while its reply finishes. Outside that, opening a card at the end of an
   * old reply leaves the view where the reader put it.
   */
  const followGrowthUntil = useRef(0);
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const node = scrollRef.current;
    // "instant" is explicit because the stylesheet makes this pane scroll smoothly by default.
    if (node) node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);
  const onConversationScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX) following.current = true;
    else if (node.scrollTop < lastScrollTop.current - 1) following.current = false;
    lastScrollTop.current = node.scrollTop;
  }, []);
  useEffect(() => {
    if (isRunning) followGrowthUntil.current = Number.POSITIVE_INFINITY;
    else if (followGrowthUntil.current === Number.POSITIVE_INFINITY) followGrowthUntil.current = Date.now() + FOLLOW_AFTER_RUN_MS;
  }, [isRunning]);
  useEffect(() => {
    const node = scrollRef.current;
    const content = conversationRef.current;
    if (!node || !content) return;
    const observer = new ResizeObserver(() => {
      if (following.current && Date.now() < followGrowthUntil.current) scrollToEnd("instant");
    });
    observer.observe(content);
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  // A sent or completed message is a beat the reader is meant to notice, so it
  // is followed smoothly. Sending is asking to watch the answer, so it follows
  // even from higher up.
  const messageCount = selectedChat?.messages.length ?? 0;
  const lastMessageRole = selectedChat?.messages.at(-1)?.role;
  const countedChat = useRef(workspace.selectedChatId);
  useEffect(() => {
    // Opening another chat changes the count too; that is not a new message.
    if (countedChat.current !== workspace.selectedChatId) {
      countedChat.current = workspace.selectedChatId;
      return;
    }
    if (lastMessageRole === "user") following.current = true;
    if (following.current) scrollToEnd("smooth");
    // Only a new message is a beat; the role and chat are read for it, not watched.
  }, [messageCount, scrollToEnd]);

  // A run's own events arrive many times a second while a reply streams, and
  // every approval, activity row and status change is one of them. Animating
  // each would leave the view permanently mid-glide, so these keep the end in
  // view without a transition of their own.
  useEffect(() => {
    if (following.current) scrollToEnd("instant");
  }, [runView?.lastSeq, runStarting, scrollToEnd]);

  // Another chat opens at its end, before its first frame is painted, and
  // settles in with a short fade and lift rather than replacing the last one
  // in a single frame.
  const openedChat = useRef(workspace.selectedChatId);
  useLayoutEffect(() => {
    following.current = true;
    scrollToEnd("instant");
    if (openedChat.current === workspace.selectedChatId) return;
    openedChat.current = workspace.selectedChatId;
    if (prefersReducedMotion()) return;
    // A new chat only fades. Its heading and backdrop are placed against the
    // workspace, and a transform here would place them against this element
    // for the length of the animation, so they would drift and then jump back.
    const empty = (selectedChat?.messages.length ?? 0) === 0;
    conversationRef.current?.animate(
      empty
        ? [{ opacity: 0.3 }, { opacity: 1 }]
        : [{ opacity: 0.3, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
      { duration: CHAT_ENTER_MS, easing: MOTION_EASE_OUT },
    );
    // Only opening a chat animates; what it holds is read for that, not watched.
  }, [workspace.selectedChatId, scrollToEnd]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        // Not underneath Settings or a dialog: the new chat would open out of
        // sight and take the draft with it.
        if (showSettings || dialog !== null || trimmingClip !== null) return;
        newChat();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [newChat, showSettings, dialog, trimmingClip]);

  const theme = workspace.preferences.theme;
  const approvalMode = workspace.preferences.approvalMode;
  /**
   * The decision the run is blocked on, docked above the composer rather than
   * left in the transcript. A run keeps appending activity while it waits, so a
   * card inside the stream scrolls away from the user it is waiting for.
   */
  const pendingApproval = runView?.pendingApproval ?? null;
  /**
   * The question the run is stopped on, docked for the same reason. In the
   * stream it was drawn at the top of the run, above the plan and the reply
   * already on screen, so it arrived where nobody was looking.
   */
  const pendingQuestion = runView?.pendingQuestion ?? null;
  /** Words in the composer while a question waits: Send will answer with them. */
  const answeringInWords = pendingQuestion !== null && (explaining || composer.trim() !== "");
  // Keyed on the three arrays the steps are built from rather than on the view,
  // so a streamed delta -- which replaces the view but none of these -- leaves
  // the steps, the model, and everything memoised on them untouched. Measured:
  // with the whole view as the key, a run holding three diffs and forty tool
  // rows cost ~146 ms per delta, all of it reconciling rows that had not changed.
  const runTimeline = runView?.timeline;
  const runActivities = runView?.activities;
  const runEvidence = runView?.evidence;
  // The words said before the latest stretch are settled by the time the timeline
  // changes, so the rows need not rebuild for every streamed token.
  const runText = useRef("");
  runText.current = runView?.text ?? "";
  const runSteps = useMemo(
    () => (runTimeline && runActivities && runEvidence
      ? activitySteps({ timeline: runTimeline, activities: runActivities, evidence: runEvidence, text: runText.current })
      : []),
    [runTimeline, runActivities, runEvidence],
  );
  const runActivityNodes = useMemo(() => buildActivityModel(runSteps), [runSteps]);
  /**
   * Whether the provider itself is working right now, which is what the
   * composer's spinner claims. A run waiting on Studio or on the user is not
   * thinking, and the Activity heading and approval card already say what those
   * waits are, so the spinner stands down for both.
   */
  const toolWorking = useSettledFlag(runActivityNodes.some((node) => node.status === "active"), TOOL_SETTLE_MS);
  const thinking = runView !== null && runView.outcome === null
    ? providerIsThinking(runView, toolWorking)
    : runView === null && runStarting;
  const autoPlaytest = workspace.preferences.autoPlaytest;
  const card = providerCard(provider, providerStatus, hasDesktopRuntime());
  const invite = hydrated ? communityInvite(COMMUNITY_INVITE_URL, workspace.preferences.communityInviteDismissed, workspace.projects) : "none";
  const imagesReachModel = hasDesktopRuntime();
  const selectedModel = modelCatalog.models
    .find((model) => model.id === selectedModelId(workspace.preferences, provider)) ?? null;
  const contextView = contextMeterView(
    workspace.selectedChatId === null ? undefined : contextReadings.get(workspace.selectedChatId),
    { provider, model: selectedModel?.id ?? null },
  );
  /** Exactly what Send would send. */
  const message = composedMessage(pastedBlocks, composer);
  // Offered once there is enough to want more room, and never in the way before.
  // A chat with nothing in it yet: the question, the composer and the starters sit together mid-pane.
  const onHome = !composerExpanded && !showRunControls && (selectedChat?.messages.length ?? 0) === 0;
  const canExpand = !isRunning && (pastedBlocks.length > 0 || lineCount(composer) >= 4 || composer.length >= 400);
  const composerHint: ReactNode = message.length >= 1_000
    ? characterCount(message.length)
    : composer.trim() !== "" && !isRunning
      ? <><kbd>{SEND_MODIFIER}</kbd> <kbd>Enter</kbd> to send</>
      : null;
  /**
   * A pasted block opens alone in the larger editor. Closing the editor folds
   * it back into its block, so the other blocks and what was typed are never
   * touched, and a block emptied there is removed.
   */
  const editingBlock = isRunning || !composerExpanded ? undefined : pastedBlocks.find((block) => block.id === editingBlockId);
  const editPastedText = (id: string) => {
    setEditingBlockId(id);
    setComposerExpanded(true);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };
  const closeEditor = () => {
    setComposerExpanded(false);
    if (editingBlockId !== null) {
      setPastedBlocks((current) => finishBlockEdit(current, editingBlockId));
      setEditingBlockId(null);
    }
    composerRef.current?.focus();
  };

  const onlyProject = workspace.projects.length < 2;
  const projectMenuItems: readonly RowMenuItem[] = [
    { id: RENAME_ACTION, label: "Rename project", icon: <Pencil size={14} /> },
    {
      id: DELETE_ACTION,
      label: "Delete project",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: onlyProject,
      title: onlyProject ? "A workspace keeps at least one project" : undefined,
    },
  ];

  const chatDialog = (projectId: string, chatId: string, action: string): Dialog =>
    action === RENAME_ACTION
      ? { kind: "rename-chat", projectId, chatId }
      : { kind: "delete-chat", projectId, chatId };

  const renderDialog = () => {
    if (!dialog) return null;
    if (dialog.kind === "create-project") {
      return <NameModal
        heading="Create a project" description="Keep related chats together in one project."
        label="Project name" placeholder="Obby prototype"
        confirmLabel="Create project" confirmIcon={<FolderPlus size={15} />}
        onSubmit={addProject} onClose={closeDialog}
      />;
    }

    const project = workspace.projects.find((candidate) => candidate.id === dialog.projectId);
    if (!project) return null;

    if (dialog.kind === "rename-project") {
      return <NameModal
        heading="Rename project" description="Only the name changes — every chat inside it is left alone."
        label="Project name" placeholder="Obby prototype" initialValue={project.name}
        confirmLabel="Save name" confirmIcon={<Check size={15} />}
        onSubmit={(value) => { setWorkspace((current) => renameProject(current, project.id, value)); closeDialog(); }}
        onClose={closeDialog}
      />;
    }
    if (dialog.kind === "delete-project") {
      return <ConfirmModal
        heading={`Delete ${project.name}?`}
        description={project.chats.length === 0
          ? "This project is empty, so nothing said in it will be lost."
          : `This also deletes ${countLabel(project.chats.length, "chat")} and everything said in them. It cannot be undone.`}
        confirmLabel="Delete project"
        onConfirm={() => removeProject(project.id)} onClose={closeDialog}
      />;
    }

    const chat = project.chats.find((candidate) => candidate.id === dialog.chatId);
    if (!chat) return null;

    if (dialog.kind === "rename-chat") {
      return <NameModal
        heading="Rename chat" description="A chat you name keeps that name when you send your next message."
        label="Chat name" placeholder="Checkpoint system" initialValue={chat.title}
        confirmLabel="Save name" confirmIcon={<Check size={15} />}
        onSubmit={(value) => { setWorkspace((current) => renameChat(current, project.id, chat.id, value)); closeDialog(); }}
        onClose={closeDialog}
      />;
    }
    return <ConfirmModal
      heading={`Delete ${chat.title}?`}
      description={chat.messages.length === 0
        ? "This chat is empty, so nothing will be lost."
        : `This removes ${countLabel(chat.messages.length, "message")} from this device. It cannot be undone.`}
      confirmLabel="Delete chat"
      onConfirm={() => removeChat(project.id, chat.id)} onClose={closeDialog}
    />;
  };

  return (
    <RunDeckProvider deck={deck}>
    <div className="app-shell" data-theme={theme} data-sidebar={sidebarShown ? "shown" : "hidden"} data-deck={deck.target === null ? "closed" : "open"} aria-busy={!hydrated}>
      {/* Settings covers the chat rather than replacing it, so a run keeps
          streaming underneath; while it is open the chat is unreachable. */}
      <aside className="sidebar" id="sidebar" inert={showSettings}>
        <div className="brand-row">
          {/* The transparent mark follows the surface theme so its primary ink
              keeps the intended contrast in either appearance. */}
          <img className="brand-mark" src={theme === "light" ? "./roqer-mark-light.svg" : "./roqer-mark-dark.svg"} width={38} height={38} alt="" />
          <div className="brand-copy"><strong>Roqer</strong></div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarShown(false)} aria-label="Hide sidebar" title="Hide sidebar" aria-controls="sidebar" aria-expanded={sidebarShown}><PanelLeftClose size={18} /></button>
        </div>
        <button className="new-chat-button" onClick={newChat}><Plus size={18} /> New chat <span className="shortcut">{SEND_MODIFIER} N</span></button>
        <div className="sidebar-section-heading">
          <span>Projects</span>
          <button className="icon-button dark" title="Create project" onClick={() => setDialog({ kind: "create-project" })}><FolderPlus size={17} /></button>
        </div>
        <nav className="folder-list" aria-label="Project folders">
          {workspace.projects.map((project) => {
            const expanded = expandedProjects.has(project.id);
            return (
              <div className="folder-group" key={project.id}>
                <div className={`folder-row ${workspace.selectedProjectId === project.id ? "folder-selected" : ""}`}>
                  <button className="folder-main" onClick={() => selectProject(project.id)}>
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<Folder size={17} /><span>{project.name}</span>
                  </button>
                  <RowMenu className="dark" label={`${project.name} options`} items={projectMenuItems} onSelect={(action) => setDialog(action === RENAME_ACTION
                    ? { kind: "rename-project", projectId: project.id }
                    : { kind: "delete-project", projectId: project.id })} />
                </div>
                {expanded && <div className="chat-list">
                  {project.chats.length === 0 && <p className="empty-folder">No chats yet</p>}
                  {chatsByActivity(project.chats).map((chat) => {
                    const chatRun = runs.get(chat.id) ?? null;
                    const runHere = chatRun !== null;
                    const needsInput = chatRun !== null && runNeedsInputOf(chatRun);
                    const runState = runHere ? (needsInput ? "chat-needs-input" : "chat-running") : "";
                    return <div className={`chat-row ${workspace.selectedChatId === chat.id ? "chat-selected" : ""} ${runState}`} key={chat.id}>
                      <button className="chat-main" onClick={() => selectChat(project.id, chat.id)}><MessageSquare size={15} /><span className="chat-row-title">{chat.title}</span>
                        {/* While a run is in this chat, its state replaces the
                            row's timestamp: which chat Roqer is in, and whether
                            it is waiting, is the fact worth having from any
                            other chat. */}
                        {runHere
                          ? <span className="chat-run-mark" role="status" aria-label={needsInput ? "Roqer needs your answer" : "Roqer is working"} title={needsInput ? "Roqer needs your answer" : "Roqer is working"}>{needsInput ? <CircleDot size={13} /> : <Loader2 size={13} />}</span>
                          : null}
                      </button>
                      <RowMenu className="dark chat-menu" label={`${chat.title} options`} items={CHAT_MENU_ITEMS} onSelect={(action) => void chatAction(project.id, chat.id, action)} />
                    </div>;
                  })}
                </div>}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          {invite === "card" && <CommunityCard url={COMMUNITY_INVITE_URL} onDismiss={dismissCommunityInvite} />}
          <div className="subscription-card"><Sparkles size={16} /><div><strong>{card.title}</strong><span>{card.detail}</span></div>{card.badge !== undefined && <span className="runtime-badge">{card.badge}</span>}</div>
          {/* The download is the part that takes a while, and it used to be
              the part nothing showed: the install button appeared only once it
              was over, so a person who had heard there was an update saw
              nothing for the minutes it took to arrive. */}
          {updateInProgress(updateState) && <div className="settings-button update-progress" role="status" aria-live="polite">
            <Loader2 size={18} />
            <div>
              <span>{appUpdateMessage(updateState)}</span>
              <span className="update-track"><span style={{ width: `${updateState.kind === "downloading" ? Math.round(updateState.percent) : 0}%` }} /></span>
            </div>
          </div>}
          {canInstallUpdate(updateState) && <button className="settings-button update-ready" onClick={() => void installUpdate()}>
            <Download size={18} /> {appUpdateMessage(updateState)}
          </button>}
          <div className="sidebar-settings-row">
            <button className="settings-button" onClick={() => setShowSettings(true)}><Settings size={18} /> Settings</button>
            {invite === "icon" && <CommunityIcon url={COMMUNITY_INVITE_URL} arrived={communityIconArrived} onArrived={() => setCommunityIconArrived(false)} />}
          </div>
        </div>
      </aside>

      {/* Mounted either way so it can fade out as well as in; it is inert and
          unreachable while the sidebar is away. */}
      <button className="sidebar-scrim" tabIndex={sidebarShown ? 0 : -1} onClick={() => setSidebarShown(false)} aria-label="Hide sidebar" />

      <main className="workspace" inert={showSettings}>
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setSidebarShown(true)} aria-label="Show sidebar" title="Show sidebar" aria-controls="sidebar" aria-expanded={sidebarShown}><PanelLeftOpen size={20} /></button>
          <div className="chat-heading"><strong>{selectedChat?.title ?? selectedProject?.name ?? "New project"}</strong>{saveStatus === "error" && <span className="save-problem" role="alert">Save failed</span>}</div>
          <div className="topbar-actions">
            <div className="connection-wrap" ref={connectionRef}>
              <button className={`connection-pill status-${studioStatus.kind}`} onClick={() => setShowConnection((value) => !value)}><span className="live-dot" /><span className="connection-label">{targetStudio?.name ?? (chatPinned && chatInstanceId !== null ? "This chat's place is not open" : studioStatus.placeName ?? "Roblox Studio")}</span><span className="connection-detail">{studioStatus.message}</span><ChevronDown size={15} /></button>
              {connectionPopover.present && <div className="connection-popover" data-leaving={connectionPopover.leaving || undefined}><div className="popover-title"><div className="studio-icon"><Gamepad2 size={18} /></div><div><strong>Roblox Studio</strong><span>{studioStatus.message}</span></div></div><dl><div><dt>Bridge</dt><dd>{statusLabel(studioStatus.kind)}</dd></div></dl>
                {/* Every connected place, not just the one a run happens to
                    go to. Two places open used to look identical to one. */}
                {studios.length === 0
                  ? <p className="popover-note">{studioStatus.kind === "connected" ? "No place is connected." : "Not connected."}</p>
                  : <ul className="studio-list" role="radiogroup" aria-label="Place to work in">
                    {studios.map((studio) => <li key={studio.instanceId}>
                      {/* Picking is the whole point of the list, so the row is
                          the control rather than carrying one. */}
                      <button
                        className={`studio-row ${studio.isTarget ? "studio-row-target" : ""}`}
                        role="radio"
                        aria-checked={studio.isTarget}
                        onClick={() => chooseStudio(studio.instanceId)}
                      >
                        <span className="studio-check">{studio.isTarget && <Check size={14} />}</span>
                        <span className="studio-name" title={studio.name}>{studio.name}</span>
                        <span className="studio-meta">
                          {studio.isRunning ? "Playtest" : "Edit"}
                          {studio.roles.length > 1 && ` · ${studio.roles.length} sessions`}
                        </span>
                      </button>
                    </li>)}
                  </ul>}
                {/* Only offered once a place has been pinned: with nothing
                    chosen, automatic is already what is happening. */}
                {chatInstanceId !== null && <button className="popover-action" onClick={() => chooseStudio(null)}>
                  Choose the place automatically
                </button>}
                {chatInstanceId !== null && studios.length > 0 && studios.every((studio) => studio.instanceId !== chatInstanceId) && (chatPinned
                  ? <p className="popover-note">This chat already changed a place that is not open, so Roqer will not work in another one. Open that place in Studio, or pick one above to move the chat there.</p>
                  : <p className="popover-note">The place you chose is not open. Roqer is using the one above until it is.</p>)}
                {bridgeState.kind === "failed" && <p className="popover-problem" role="alert">{bridgeState.message}</p>}
                {/* The message says what failed; these lines are usually why,
                    such as a port in use. They were kept and never shown. */}
                {bridgeState.kind === "failed" && bridgeState.detail !== undefined && bridgeState.detail.trim() !== "" &&
                  <details className="popover-detail"><summary>What the bridge said</summary><pre>{bridgeState.detail.trimEnd()}</pre></details>}
                {/* Without this, a plugin that was never installed looks
                    exactly like Studio simply not being open. */}
                {(bridgeState.kind === "running" || bridgeState.kind === "adopted") && bridgeState.pluginProblem !== undefined &&
                  <p className="popover-problem" role="alert">The Studio plugin could not be installed: {bridgeState.pluginProblem}</p>}
                {bridgeState.kind === "starting" && <p className="popover-note">{mcpServerMessage(bridgeState)}</p>}
                {/* Roqer is running against somebody else's process, which may
                    be any version and any age. Every symptom of that — a tool
                    that behaves like an older build, a timeout Roqer no longer
                    has — is inexplicable without knowing this one fact. */}
                {bridgeState.kind === "adopted" && <p className="popover-note">
                  Using a Studio bridge that was already running, not the one Roqer ships. Close it and restart Roqer to use its own.
                </p>}
                <button className="popover-action" onClick={() => void refreshStudioStatus()}><RotateCw size={15} /> Check again</button>
                {bridgeState.kind === "failed" && hasDesktopRuntime() && <button className="popover-action" disabled={bridgeBusy} onClick={() => void restartStudioBridge()}><RotateCw size={15} /> {bridgeBusy ? "Starting…" : "Restart the bridge"}</button>}
                {hasDesktopRuntime() && <div className="popover-tools">
                  <DiagnosticsActions endpoint={workspace.preferences.mcpEndpoint} buttonClassName="popover-tool" />
                </div>}
              </div>}
            </div>
            <RojoPill instanceId={targetStudio?.instanceId ?? null} placeName={targetStudio?.name} refreshSignal={studioStatus} />
            <RunDeckToggle deck={deck} />
            <RowMenu label="Chat options" iconSize={20} disabled={!selectedChat} items={CHAT_MENU_ITEMS} onSelect={(action) => { if (selectedChat) void chatAction(workspace.selectedProjectId, selectedChat.id, action); }} />
          </div>
        </header>

        {/* Studio loads plugins when it starts, so a session that was already
            open is still running the previous one. Nothing else in the product
            would tell them why their newly updated Roqer behaves like the old
            one. */}
        {(bridgeState.kind === "running" || bridgeState.kind === "adopted") && bridgeState.pluginUpdated === true && !studioRestartDismissed &&
          <div className="restart-notice" role="status">
            <RotateCw size={18} />
            <div><strong>Restart Roblox Studio</strong>
              <p>Roqer updated the Studio plugin. If Studio is open, restart it so the new version loads.</p>
            </div>
            <button onClick={() => setStudioRestartDismissed(true)}>Got it</button>
          </div>}

        {(storageRecovery.required || storageError) && <div className="storage-notice" role="alert">
          <AlertTriangle size={18} />
          <div><strong>{storageRecovery.required ? "Saved chats need recovery" : "Your changes may not be saved"}</strong><p>{storageError ?? storageRecovery.message}</p>
            {storageRecovery.required && <p>Recovery keeps a backup of the original files before saving the readable chats. Review them below first.</p>}
          </div>
          <button disabled={storageBusy} onClick={() => void repairStorage()}>{storageBusy ? "Working…" : storageRecovery.required ? "Back up and recover" : "Retry"}</button>
          <button onClick={() => void exportChats(storageRecovery.required ? undefined : workspace)}>Export a copy</button>
        </div>}

        <div className="conversation-scroll" ref={scrollRef} onScroll={onConversationScroll}><div className="conversation" ref={conversationRef}><PromptDraftContext.Provider value={draftPrompt}>
          {selectedChat && selectedChat.messages.length > 0
            ? <ConversationMessages
              key={selectedChat.id}
              messages={selectedChat.messages}
              onOpenInStudio={openArtifactInStudio}
              // The live run shows its own notes, with whether Claude has them yet.
              hideTrailingNotes={runView !== null && runView.outcome === null}
            />
            : <EmptyConversation place={targetStudio?.name} />}
          {runView
            ? <LiveRun view={runView} steps={runSteps} nodes={runActivityNodes} thinking={thinking} onOpenInStudio={openArtifactInStudio} />
            // The run is still being started, so the dots stand in for the
            // assistant block that is about to exist.
            : runStarting && <div className="mock-run"><section className="message assistant-message"><div className="message-content">
              <TypingIndicator done={false} />
            </div></section></div>}
        </PromptDraftContext.Provider></div></div>

        <div className={`composer-dock${composerExpanded ? " expanded" : ""}${onHome ? " home" : ""}`} ref={dockRef}>
          {pendingApproval && <div className="approval-dock"><ApprovalCard pending={pendingApproval} onApprove={() => answerApproval("approved")} onReject={() => answerApproval("rejected")} /></div>}
          {/* Keyed by the question, so each new one arrives with its own rings. */}
          {pendingQuestion && <div className="approval-dock question-dock" key={pendingQuestion.callId}><QuestionCard question={pendingQuestion} explaining={answeringInWords} onAnswer={answerQuestion} onExplain={explainAnswer} /></div>}
          <div
            className={`composer-card${draggingImage ? " dropping" : ""}`}
            onDragOver={(event) => {
              if (isRunning || !Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) return;
              event.preventDefault();
              setDraggingImage(true);
            }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImage(false); }}
            onDrop={(event) => {
              setDraggingImage(false);
              if (isRunning) return;
              const images = droppedImages(event.dataTransfer.files);
              if (images.length === 0) return;
              event.preventDefault();
              void attachImages(images);
            }}
          >
            {composerExpanded
              ? <div className="composer-expanded-head">
                <strong>{editingBlock ? "Pasted text" : "Message"}</strong>
                <span>{textSize(editingBlock ? editingBlock.text : message)}</span>
                <button type="button" className="text-button" onClick={closeEditor}><Minimize2 size={14} aria-hidden="true" /> {editingBlock ? "Done" : "Collapse"}</button>
              </div>
              : canExpand && <button type="button" className="icon-button composer-expand" onClick={() => { setComposerExpanded(true); composerRef.current?.focus(); }} aria-label="Open the larger editor" title="Open the larger editor"><Maximize2 size={15} /></button>}
            {thinking && <div className="composer-status" role="status"><Loader2 size={13} /><span>Thinking…</span></div>}
            {/* The spinner stands down while the run waits on the person, and
                without this the box would say nothing at all about the wait. */}
            {pendingQuestion && <div className="composer-status waiting-choice" role="status">
              <CircleDot size={13} />
              <span>{answeringInWords ? "Send answers the question in your words" : "Roqer is waiting for your choice"}</span>
            </div>}
            {/* A disabled composer with no reason reads as a broken one. This
                says where the run is and offers the two things that can be done
                about it from here: go to it, or stop it. */}
            {compactNotice?.chatId === workspace.selectedChatId && <div className="composer-status" role="status"><span>{compactNotice.text}</span></div>}
            {draggingImage && <div className="composer-drop-hint"><Upload size={18} aria-hidden="true" />Drop an image or a video to attach it</div>}
            {sendAfterCompact !== null && sendAfterCompact === workspace.selectedChatId && <div className="attachment-notice compact-queued" role="status">
              <span><Loader2 size={13} className="spin" aria-hidden="true" /> Queued: your message sends as soon as compacting finishes. You can keep editing it.</span>
              <button onClick={() => setSendAfterCompact(null)}>Cancel</button>
            </div>}
            {attachmentError && <div className="attachment-notice" role="alert"><AlertTriangle size={14} aria-hidden="true" /><span>{attachmentError}</span><button onClick={() => setAttachmentError(null)} aria-label="Dismiss"><X size={14} /></button></div>}
            {selectionChip !== null && (() => {
              const { name, className, more } = selectionChipParts(selectionChip);
              return <div className="selection-chip" role="status" aria-label={`Using your Studio selection: ${describeSelection(selectionChip)}`}>
                <div className="selection-chip-text" title={["Using your Studio selection:", ...selectionChip.items.map((item) => item.path), ...(selectionChip.count > selectionChip.items.length ? [`and ${selectionChip.count - selectionChip.items.length} more`] : [])].join("\n")}>
                  <MousePointerClick size={13} aria-hidden="true" />
                  <strong>{name}</strong>
                  {className !== undefined && <span>{className}</span>}
                  {more > 0 && <span className="selection-chip-more">+{more} more</span>}
                </div>
                <button type="button" onClick={() => setDismissedSelectionKey(selectionKey(selectionChip))} aria-label="Send without your selection" title="Send without your selection"><X size={13} /></button>
              </div>;
            })()}
            {attachments.length > 0 && <div className="attachment-row">{attachments.map((attachment) => <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              imagesReachModel={imagesReachModel}
              reading={readingClips.has(attachment.id)}
              readsText={hasDesktopRuntime()}
              onTrim={() => setTrimmingClip(attachment.id)}
              onRemove={() => { void releaseAttachments([attachment.id]); setAttachments((current) => current.filter((item) => item.id !== attachment.id)); }}
            />)}</div>}
            {(() => {
              const trimming = attachments.find((attachment) => attachment.id === trimmingClip);
              return trimming?.clip === undefined ? null : <ClipTrimDialog
                attachment={trimming}
                clip={trimming.clip}
                onClose={() => setTrimmingClip(null)}
                onConfirm={(selection) => { setTrimmingClip(null); void readClip(trimming.id, selection); }}
              />;
            })()}
            {!editingBlock && pastedBlocks.map((block) => <div className="pasted-block" key={block.id}>
              <FileText size={17} aria-hidden="true" />
              <div><strong>Pasted text</strong><span>{textSize(block.text)} · <code>{blockPreview(block.text)}</code></span></div>
              <button type="button" className="small-button" onClick={() => editPastedText(block.id)}>Edit</button>
              <button type="button" className="icon-button" onClick={() => setPastedBlocks((current) => current.filter((entry) => entry.id !== block.id))} aria-label="Remove pasted text"><X size={14} /></button>
            </div>)}
            <textarea ref={composerRef} value={editingBlock ? editingBlock.text : composer} onChange={(event) => {
              const text = event.target.value;
              if (editingBlock) setPastedBlocks((current) => withBlockText(current, editingBlock.id, text));
              else setComposer(text);
            }} onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void sendPrompt(); }
              if (event.key === "Escape" && composerExpanded) { event.preventDefault(); closeEditor(); }
            }} onPaste={(event) => {
              const images = droppedImages(event.clipboardData?.files);
              if (images.length > 0) {
                event.preventDefault();
                void attachImages(images);
                return;
              }
              // A note or an answer stays plain text: it is short by nature,
              // and it is sent the moment it is written. A paste into a block
              // being edited is part of that block.
              if (steering || explaining || editingBlock) return;
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (!isLongPaste(text)) return;
              event.preventDefault();
              setPastedBlocks((current) => [...current, { id: createId("paste"), text }]);
            }} placeholder={explaining ? "Your answer, in your own words" : pendingQuestion ? "Or write your own answer…" : steering ? "Add a note. Roqer reads it at its next step." : editingBlock ? "Pasted text" : "Describe what you want to build or change…"} aria-label={editingBlock ? "Pasted text" : "Message"} disabled={isRunning && !steering} />
            <div className="composer-toolbar">
              {/* A note carries words only; a picture cannot be attached to a
                  turn that is already in progress. */}
              <button className="attach-button" onClick={() => void attachAsset()} title="Attach an asset pack" aria-label="Attach an asset pack" disabled={isRunning}><Paperclip size={17} /></button>
              <ModelMenu
                provider={provider}
                status={providerStatus}
                catalog={modelCatalog}
                selectedModel={selectedModel}
                effort={workspace.preferences.reasoningEffort}
                disabled={isRunning}
                onManage={() => setShowSettings(true)}
                onEffort={(reasoningEffort) => updatePreferences({ reasoningEffort })}
                onPick={(nextProvider, model) => {
                  const effort = model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === workspace.preferences.reasoningEffort)
                    ? workspace.preferences.reasoningEffort
                    : model.defaultReasoningEffort;
                  updatePreferences({ provider: nextProvider, ...modelPreference(nextProvider, model.id), reasoningEffort: effort });
                }}
              />
              <RunMenu
                approvalMode={approvalMode}
                autoPlaytest={autoPlaytest}
                disabled={isRunning}
                onApprovalMode={(mode) => updatePreferences({ approvalMode: mode })}
                onAutoPlaytest={(on) => updatePreferences({ autoPlaytest: on })}
                webSearch={workspace.preferences.webSearch}
                onWebSearch={(on) => updatePreferences({ webSearch: on })}
                review={workspace.preferences.review}
                onReview={(on) => updatePreferences({ review: on })}
              />
              <div className="toolbar-spacer" />
              {composerHint !== null && <span className="composer-hint">{composerHint}</span>}
              <ContextMeter
                view={contextView}
                modelName={selectedModel?.displayName ?? null}
                onNewChat={newChat}
                compacted={compactedFrom}
                compactedUsage={compactedUsage}
                canCompact={canCompact}
                onCompact={() => void compactSelectedChat()}
                compacting={compacting}
                modelWritten={modelCompact}
              />
              {showRunControls && <button className="stop-button" onClick={stopRun}><Square size={11} fill="currentColor" aria-hidden="true" /> Stop</button>}
              {steering
                ? pendingQuestion && composer.trim()
                  ? <button className="send-button answer-send" onClick={() => void sendSteer()}>Send as answer <ArrowUp size={16} aria-hidden="true" /></button>
                  : <button className="send-button" onClick={() => void sendSteer()} disabled={!composer.trim()} aria-label="Send note to the running task"><ArrowUp size={18} /></button>
                : !showRunControls && <button className="send-button" onClick={() => void sendPrompt()} disabled={!hydrated || !storageAvailable || storageRecovery.required || isRunning || message === "" || sendAfterCompact !== null || (hasDesktopRuntime() && providerStatus.kind === "signed-in" && !selectedModel)} aria-label={compacting ? "Send once compacting finishes" : "Send message"} title={compacting ? "Sends once compacting finishes" : undefined}><ArrowUp size={18} /></button>}
            </div>
          </div>
          {onHome && <Starters onSuggestion={setComposer} />}
        </div>
      </main>

      <aside className="run-deck" aria-label="Run Deck" ref={setDeckHost} inert={showSettings} />

      {settingsPage.present && <SettingsPage leaving={settingsPage.leaving} preferences={workspace.preferences} studioStatus={studioStatus} updateState={updateState} onPreferences={updatePreferences} onStudioRefresh={() => void refreshStudioStatus()} onProviderChanged={() => { void refreshProviderStatus(); void refreshProviderModels(); }} onExport={() => void exportChats(storageRecovery.required ? undefined : workspace)} notice={settingsNotice ?? undefined} onClose={() => { setShowSettings(false); setSettingsNotice(null); }} />}
      {renderDialog()}
      {!hydrated && <div className="loading-overlay"><div><span /><strong>Opening your workspace…</strong></div></div>}
    </div>
    </RunDeckProvider>
  );
}

type RowMenuItem = {
  id: string;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
};

/** Where an open menu sits, in viewport coordinates. */
type MenuAnchor = { top?: number; bottom?: number; right: number };

/** Roughly one item, used only to decide whether the menu has room below. */
const MENU_ITEM_HEIGHT = 33;

/**
 * The "…" menu on a project or chat row.
 *
 * Rendered into the document body rather than into the row, because the folder
 * list scrolls and a menu positioned inside it would be clipped at the edge of
 * the pane. The cost of that is a menu which cannot follow its trigger, so any
 * scroll or resize closes it rather than leaving it stranded beside the wrong
 * row.
 */
function RowMenu({ label, items, onSelect, className = "", iconSize = 16, disabled = false }: {
  label: string;
  items: readonly RowMenuItem[];
  onSelect: (id: string) => void;
  className?: string;
  iconSize?: number;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  // Where the menu last opened, so it can fade out where it was.
  const [lastAnchor, setLastAnchor] = useState<MenuAnchor | null>(null);
  if (anchor !== null && anchor !== lastAnchor) setLastAnchor(anchor);
  const shownAnchor = anchor ?? lastAnchor;
  const menu = usePresence(anchor !== null, MENU_LEAVE_MS);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = useCallback((restoreFocus = false) => {
    setAnchor(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const focusItem = useCallback((index: number) => {
    const next = (index + items.length) % items.length;
    window.requestAnimationFrame(() => itemRefs.current[next]?.focus());
  }, [items.length]);

  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = items.length * MENU_ITEM_HEIGHT + 8;
    const right = Math.max(8, window.innerWidth - rect.right);
    setAnchor(rect.bottom + height + 12 > window.innerHeight
      ? { bottom: window.innerHeight - rect.top + 6, right }
      : { top: rect.bottom + 6, right });
    focusItem(0);
  };

  useEffect(() => {
    if (!anchor) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", handlePointerDown);
    // Captured, so scrolling the folder list counts and not just the window.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [anchor, close]);

  useEffect(() => {
    if (disabled) setAnchor(null);
  }, [disabled]);

  const handleItemKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") { event.preventDefault(); focusItem(index + 1); }
    if (event.key === "ArrowUp") { event.preventDefault(); focusItem(index - 1); }
    if (event.key === "Escape") { event.preventDefault(); close(true); }
  };

  return <>
    <button
      className={`icon-button row-menu-trigger ${className} ${anchor ? "open" : ""}`}
      type="button" ref={triggerRef} disabled={disabled} title={label} aria-label={label}
      aria-haspopup="menu" aria-expanded={anchor !== null}
      onClick={() => anchor ? close() : open()}
    ><MoreHorizontal size={iconSize} /></button>
    {menu.present && shownAnchor !== null && createPortal(
      <div className="row-menu" role="menu" aria-label={label} ref={menuRef} data-leaving={menu.leaving || undefined} data-placement={shownAnchor.bottom === undefined ? "below" : "above"} style={{ top: shownAnchor.top, bottom: shownAnchor.bottom, right: shownAnchor.right }}>
        {items.map((item, index) => <button
          className={`row-menu-item ${item.danger ? "danger" : ""}`}
          type="button" role="menuitem" key={item.id} disabled={item.disabled} title={item.title}
          ref={(element) => { itemRefs.current[index] = element; }}
          onKeyDown={(event) => handleItemKeyDown(event, index)}
          // Focus is left for whatever opens next: restoring it to the trigger
          // would pull it back out of the dialog these actions raise.
          onClick={() => { close(); onSelect(item.id); }}
        >{item.icon}<span>{item.label}</span></button>)}
      </div>,
      document.body,
    )}
  </>;
}

type OpenInStudio = (target: string, instanceId?: string) => Promise<{ ok: boolean; message: string }>;

const ConversationMessageView = memo(function ConversationMessageView({ message, latestRun, arrived = false, onOpenInStudio }: {
  message: ChatMessage;
  /** Sent while this chat was open, rather than loaded with it: only such a message animates in. */
  arrived?: boolean;
  /** Whether this is the newest reply that came from a run; only its diffs open by default. */
  latestRun: boolean;
  onOpenInStudio: OpenInStudio;
}) {
  return message.role === "user" ? (
    <section className={`message user-message${message.note === true ? " note-message" : ""}${arrived ? " message-arrived" : ""}`} key={message.id}>
      {message.note === true && <span className="note-label">Note sent while Roqer was working</span>}
      {message.attachments !== undefined && <MessagePictures attachments={message.attachments} />}
      <p className="user-prompt">{message.text}</p>
      {message.studioSelection !== undefined && message.studioSelection.count > 0 && <div className="message-selection" title={message.studioSelection.items.map((item) => item.path).join("\n")}>
        <MousePointerClick size={12} aria-hidden="true" /> Selected in Studio: <code>{describeSelection(message.studioSelection)}</code>
      </div>}
      {message.attachments !== undefined && <MessageFiles attachments={message.attachments} />}
    </section>
  ) : (
    <section className="message assistant-message" key={message.id}><div className="message-content">
      {message.run
        ? <RunRecordView record={message.run} text={message.text} latest={latestRun} onOpenInStudio={onOpenInStudio} />
        : <Markdown text={message.text} className="result-copy" />}
    </div></section>
  );
});

const ConversationMessages = memo(function ConversationMessages({ messages: allMessages, onOpenInStudio, hideTrailingNotes = false }: {
  messages: ChatMessage[];
  onOpenInStudio: OpenInStudio;
  /** Leave out the notes after the last prompt: the live run below shows them. */
  hideTrailingNotes?: boolean;
}) {
  const messages = useMemo(() => {
    if (!hideTrailingNotes) return allMessages;
    let end = allMessages.length;
    while (end > 0 && allMessages[end - 1].note === true) end -= 1;
    return end === allMessages.length ? allMessages : allMessages.slice(0, end);
  }, [allMessages, hideTrailingNotes]);
  // The component is keyed by chat, so this index belongs to one transcript.
  // Appended messages leave it untouched and remain visible at the bottom.
  const [visibleFrom, setVisibleFrom] = useState(() => initialConversationWindowStart(messages.length));
  // What the chat held when it opened. Those messages, and earlier ones shown
  // later, appear with the chat; only a message sent since animates in.
  const [loadedIds] = useState(() => new Set(messages.map((message) => message.id)));
  const revealCount = Math.min(visibleFrom, CONVERSATION_WINDOW_SIZE);
  // The newest reply that came from a run, not the newest message: a prompt
  // just sent must not fold the diffs of the reply it is a follow-up to.
  const latestRunId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].run !== undefined) return messages[index].id;
    }
    return undefined;
  }, [messages]);

  return <>
    {visibleFrom > 0 && <div className="conversation-history">
      <button type="button" onClick={() => setVisibleFrom(earlierConversationWindowStart)}>
        Show {countLabel(revealCount, "earlier message")}
      </button>
    </div>}
    {messages.slice(visibleFrom).map((message) => (
      <ConversationMessageView key={message.id} message={message} latestRun={message.id === latestRunId} arrived={!loadedIds.has(message.id)} onOpenInStudio={onOpenInStudio} />
    ))}
  </>;
});

/**
 * A card's secondary detail: the fingerprints and payloads that make a result
 * auditable but say nothing a reader needs at a glance. Native disclosure, so
 * it opens with the keyboard and needs no state.
 */
function CardDetails({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="card-details">
    <summary><ChevronRight size={13} />{label}</summary>
    <div className="card-details-body">{children}</div>
  </details>;
}

function MetadataList({ entries }: { entries: RunMetadata[] }) {
  return <dl className="metadata-list">
    {entries.map((entry) => <div key={`${entry.label}-${entry.value}`}>
      <dt>{entry.label}</dt><dd>{entry.value}</dd>
    </div>)}
  </dl>;
}

// Every suggestion is something the current read-only planner actually does,
// so a fresh chat never proposes work the app cannot carry out yet.
const SUGGESTIONS = [
  "Inspect this project",
  "List all scripts",
  "Read the main server script",
];

function EmptyConversation({ place }: { place: string | undefined }) {
  return <><div className="home-studs" aria-hidden="true" /><div className="empty-conversation"><h1>What should change in {place ?? "your place"}?</h1></div></>;
}

/** Things to start from, directly under the composer on a new chat. */
function Starters({ onSuggestion }: { onSuggestion: (value: string) => void }) {
  return <div className="home-starters">{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} onClick={() => onSuggestion(suggestion)}>{suggestion}</button>)}</div>;
}

/**
 * A run in flight, and the moment it finishes.
 *
 * Three layers, in the order a reader needs them. Activity is what the agent
 * is doing, closed unless they open it and never mixed into the reply. The code
 * a run changed comes next, as its own artifact. The reply comes last, because
 * it is the sentence a reader leaves with: sitting above a long diff it scrolls
 * out of view and reads as a caption on the code, while underneath it is where
 * the eye lands. Everything technical — operation names, paths, revisions, raw
 * output — stays inside Activity.
 */
/**
 * Whether the provider is the thing currently working.
 *
 * A run spends its time in three places, and only one of them is thinking: the
 * model reasoning between calls, a tool waiting on Studio, and the run stopped
 * on the user. Naming the first is the composer spinner's whole job, so it says
 * nothing during the other two rather than claiming the model is busy while a
 * playtest boots or while an approval sits unanswered.
 */
/** The app's standard ease: quick to start, long to settle, as iOS moves sheets and panels. Matches `--ease-out`. */
const MOTION_EASE_OUT = "cubic-bezier(.32, .72, 0, 1)";
/** How long another chat takes to settle in. */
const CHAT_ENTER_MS = 260;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long a menu or popover takes to fade out, and Settings to close. Match the leave rules in styles.css. */
const MENU_LEAVE_MS = 120;
const SETTINGS_LEAVE_MS = 180;

/** How long a section of a run's strip takes to slide shut. Matches `--motion-base` in styles.css. */
const PANEL_LEAVE_MS = 220;

/** How close to the end of the chat counts as being at it. */
const FOLLOW_SLACK_PX = 48;
/** How long after a run ends the chat still follows its reply, which may still be revealing. */
const FOLLOW_AFTER_RUN_MS = 2_500;

/**
 * How long a tool step must run before "Thinking" gives way to it. A run of
 * quick tool calls otherwise hid and showed the notice several times a second,
 * which read as flicker; a step this short is shown in Activity alone.
 */
const TOOL_SETTLE_MS = 900;

/** `toolWorking`: a tool step has been running for at least `TOOL_SETTLE_MS`. */
function providerIsThinking(view: RunView, toolWorking: boolean): boolean {
  if (view.outcome !== null) return false;
  if (view.pendingApproval !== null || view.pendingQuestion !== null) return false;
  return !toolWorking;
}

/**
 * Three dots where the answer is going to be, from the moment a prompt is sent
 * until the run puts something real in their place.
 *
 * It stays mounted and collapses when `done`, so the handover to real content
 * is a fade rather than a swap. Decorative on purpose: the composer's
 * "Thinking…" is what a screen reader is told, and one announcement is enough.
 */
function TypingIndicator({ done }: { done: boolean }) {
  return <div className={`typing-indicator${done ? " done" : ""}`} aria-hidden="true"><span /><span /><span /></div>;
}

/** Below this a counter is noise; above it, its absence is the thing in question. */
const WAITING_ELAPSED_AFTER_MS = 5_000;
/** Long enough that silence has stopped reading as latency and started reading as a hang. */
const WAITING_REASSURANCE_AFTER_MS = 30_000;

/**
 * What the model is doing, and for how long.
 *
 * Nearly every model sends nothing at all until its final message, so between
 * the prompt and the first tool call there is genuinely nothing to render: no
 * prose, and no Activity section, which does not exist until a step does. What
 * was left was three animated dots, for a wait that can run past a minute on a
 * model that emits its whole answer in one burst at the end. Dots that have
 * been identical for ninety seconds are indistinguishable from a hang.
 *
 * The elapsed count is the part that answers the question. A label alone is
 * still a static string; a number that visibly moves is what says the app is
 * working rather than stuck. It appears a few seconds in, so an ordinary quick
 * turn stays quiet, and after half a minute the notice says plainly that a long
 * silence is normal for some models -- which is true here, and better said than
 * left for the user to guess.
 *
 * The clock is per waiting spell rather than per run: this unmounts whenever
 * the provider stops being the thing that is working, so a tool call longer
 * than a moment, or an approval, resets it and the number always means "how long has it been quiet".
 * Beside it, once the model has streamed anything, is how much it has written
 * in this response: the clock says time is passing, the count says the model
 * is still producing.
 *
 * Deliberately not a live region. The composer already announces "Thinking…",
 * and one announcement is enough.
 */
function WaitingNotice({ label, detail, output }: { label: string; detail?: string; output: RunView["outputTokens"] }) {
  const startedAt = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt.current), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <div className="waiting-notice">
    <p className="waiting-line">
      <span>{label}</span>
      {elapsedMs >= WAITING_ELAPSED_AFTER_MS && <span className="waiting-elapsed">{elapsedLabel(elapsedMs)}</span>}
      {/* Only once something has streamed: a count sitting at zero reads as
          more stuck than no count at all, and a model that hides its
          reasoning sends nothing to count until it answers. */}
      {output !== null && output.tokens > 0 && <span
        className="waiting-elapsed"
        title={output.exact
          ? "Tokens the model reported for this response."
          : "Estimated from what the model has streamed so far. Reasoning a model does not show is not counted until it reports its own total."}
      >{outputTokensLabel(output.tokens, output.exact)}</span>}
    </p>
    {detail !== undefined && detail !== "" && <p className="waiting-detail">{detail}</p>}
    {elapsedMs >= WAITING_REASSURANCE_AFTER_MS && <p className="waiting-detail">
      Some models work for a minute or more before their first word.
    </p>}
  </div>;
}

function LiveRun({ view, steps, nodes, thinking, onOpenInStudio }: { view: RunView; steps: ActivityStep[]; nodes: ActivityNode[]; thinking: boolean; onOpenInStudio: OpenInStudio }) {
  const answered = view.text.trim() !== "";
  const running = view.outcome === null;
  const appliedAndVerified = runAppliedAndVerified(view);
  const onlyAnswered = runOnlyAnswered(view);
  const showOutcome = !appliedAndVerified && !onlyAnswered;
  const completionNote = completedRunMetadataLabel(
    view.planner === DEMO_PLANNER ? "Demo" : null,
    view.startedAt,
    view.finishedAt,
  );
  // Anything the run has put on screen retires the dots: a plan, an activity
  // row, a question to answer (docked above the composer), or the first words
  // of the reply.
  const produced = view.tasks.length > 0 || steps.length > 0 || answered || view.pendingQuestion !== null;
  // `thinking` is the composer's own value, so the two can never disagree
  // about who is working. A run waiting on Studio or on the user is not
  // thinking, and both of those already say so elsewhere.
  const renderFiles = useCallback((files: ChangeGroup[], expansion: FileExpansion) => <ChangeSet groups={files} expansion={expansion} onOpenInStudio={onOpenInStudio} />, [onOpenInStudio]);
  return <div className="mock-run"><section className="message assistant-message"><div className="message-content">
    {view.planner === DEMO_PLANNER && <p className="run-tag"><span className="run-badge">Demo</span></p>}
    {running && <TypingIndicator done={produced} />}
    {thinking && <WaitingNotice
      // Every turn opens with a progress label, so this is normally the
      // planner's own words; the fallback is for a planner that sends none.
      label={view.status?.label ?? "Working"}
      {...(view.status?.detail === undefined ? {} : { detail: view.status.detail })}
      output={view.outputTokens}
    />}
    <RunStrip tasks={view.tasks} steps={steps} nodes={nodes} running={running} runId={view.runId} changes={view.changes} evidence={view.evidence} latest renderFiles={renderFiles} />
    {/* Formatted and revealed smoothly as it streams. When the run ends, the
        saved reply takes over from the same point, keyed by the run. */}
    {answered && <StreamingMarkdown text={latestProse(view)} live done={!running} handoffKey={view.runId} className={running ? "result-copy streaming-copy" : "result-copy"} />}
    {appliedAndVerified && <AppliedStatus />}
    {view.outcome !== null && showOutcome && <OutcomeCard
      outcome={view.outcome}
      warnings={runHasWarnings(view)}
      // Once the answer is on screen, repeating it says nothing; Activity above has the counts.
      summary={view.outcome === "completed" && answered ? "" : view.summary}
      issues={runGateIssues(view)}
    />}
    {view.review !== null && <ReviewCard review={view.review} latest />}
    {!running && <CompletionLine metadata={completionNote} usage={view.usage ?? undefined} />}
    <RunNotes notes={view.notes} delivered={view.notesDelivered} running={running} />
    {view.desynchronized && <p className="run-warning"><AlertCircle size={14} /> Some updates were missed, so this timeline may be incomplete.</p>}
  </div></section></div>;
}

/**
 * The notes sent while this run works, each with where it is: still queued
 * in Roqer, or with the model. Claude reads a note at its next step; a
 * provider that cannot take one mid-turn gets it when its turn ends.
 */
function RunNotes({ notes, delivered, running }: { notes: string[]; delivered: number; running: boolean }) {
  if (notes.length === 0) return null;
  return <ul className="run-notes" aria-label="Your notes">
    {notes.map((note, index) => {
      const sent = index < delivered;
      return <li key={index} className={`run-note${sent ? " sent" : ""}`}>
        <p className="run-note-text">{note}</p>
        <span className="run-note-status">
          {sent
            ? <><Check size={12} aria-hidden="true" /> {running ? "Delivered, the model has it" : "Delivered"}</>
            : running
              ? <><Loader2 size={12} aria-hidden="true" className="spin" /> Queued, delivered at the next step</>
              : "Not delivered: the run ended first. Send it again as a new message."}
        </span>
      </li>;
    })}
  </ul>;
}

/** One line of counts describing what a run actually did. */
function countLine(calls: number, changes: number, failed: number): string {
  const parts = [`${calls} ${calls === 1 ? "tool call" : "tool calls"}`];
  if (changes > 0) parts.push(`${changes} ${changes === 1 ? "change" : "changes"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

const KIND_ICON: Record<ActivityKind, React.ReactNode> = {
  search: <Search size={13} />,
  read: <FileText size={13} />,
  edit: <Pencil size={13} />,
  run: <Play size={13} />,
  verify: <ShieldCheck size={13} />,
  inspect: <Boxes size={13} />,
  note: <Info size={13} />,
};

/**
 * One shape per status, and one word per status.
 *
 * The shapes differ before the colours do — a filled check, a spinner, a
 * triangle, a dash — so the state of a row survives a reader who cannot tell
 * the success green from the warning amber, and the word rides along as the
 * icon's accessible name rather than being implied by it.
 */
const STATUS_ICON: Record<StepStatus, React.ReactNode> = {
  pending: <Circle size={13} />,
  active: <Loader2 size={13} />,
  completed: <Check size={13} />,
  warning: <AlertTriangle size={13} />,
  failed: <AlertCircle size={13} />,
  skipped: <MinusCircle size={13} />,
};

const STATUS_WORD: Record<StepStatus, string> = {
  pending: "Queued",
  active: "In progress",
  completed: "Done",
  warning: "Needs attention",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * A queued step has nothing to report yet, so it shows what kind of work it is
 * about to be instead of a placeholder circle, and a note the planner left is
 * an annotation rather than a task anyone completed. Every other status speaks
 * for itself and outranks the kind.
 */
function NodeIcon({ node }: { node: ActivityNode }) {
  const annotation = node.kind === "note" && node.status === "completed";
  const word = annotation ? "Note" : STATUS_WORD[node.status];
  const showKind = annotation || node.status === "pending";
  return <span className="node-status" role="img" aria-label={word} title={word}>
    {showKind ? KIND_ICON[node.kind] : STATUS_ICON[node.status]}
  </span>;
}

/** The three columns every row shares: what it is, and what it found. */
function NodeLine({ node }: { node: ActivityNode }) {
  return <>
    <NodeIcon node={node} />
    <span className="node-title" title={node.title}>{node.title}</span>
    <span className="node-finding" title={node.finding}>{node.finding ?? ""}</span>
  </>;
}

/**
 * One thing the run did. The row itself opens what only matters when something
 * looks wrong: the operation the agent actually called, the full instance path,
 * what it cost, the payload that came back, and what it proved. Built when opened,
 * because a long run has hundreds of these.
 */
function ActivityLeaf({ node }: { node: ActivityNode }) {
  const [open, setOpen] = useState(false);
  const details = usePresence(open, PANEL_LEAVE_MS);
  const { step } = node;
  if (step === undefined || (step.tool === undefined && step.evidence === undefined)) {
    return <li className="activity-node">
      <div className="node-row" data-status={node.status} data-kind={node.kind}><span className="node-caret" /><NodeLine node={node} /></div>
    </li>;
  }
  const entries: RunMetadata[] = step.tool === undefined ? [] : [{ label: "Operation", value: step.tool }];
  if (step.target) entries.push({ label: "Target", value: step.target });
  if (step.durationMs !== undefined) entries.push({ label: "Duration", value: formatDuration(step.durationMs) });
  if (step.resultSummary) entries.push({ label: "Result", value: step.resultSummary });
  const proved = [...(step.evidence === undefined ? [] : [step.evidence]), ...(step.attached ?? [])];
  return <li className="activity-node">
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="node-row" data-status={node.status} data-kind={node.kind}>
        <ChevronRight size={12} className="node-caret" />
        <NodeLine node={node} />
      </summary>
      {/* Rendered only while open, and kept as it slides shut. */}
      {details.present && <div className="node-details">
        {entries.length > 0 && <MetadataList entries={entries} />}
        {step.detail && <pre className="tool-output"><code>{step.detail}</code></pre>}
        {proved.map((evidence) => <EvidenceBody key={evidence.id} evidence={evidence} />)}
      </div>}
    </details>
  </li>;
}

/**
 * A run of neighbouring steps, folded to one line.
 *
 * Anything that went wrong inside stays listed under the collapsed row: a group
 * is a way to put routine work away, never a way to put a failure away. The
 * disclosure opens itself while the phase is running and closes when it ends,
 * but a reader who opens or closes one keeps that choice for the rest of the run.
 */
function ActivityGroup({ node, open, onToggle }: {
  node: ActivityNode;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
}) {
  const duration = aggregateDuration(node.durationMs);
  return <li className="activity-node activity-group">
    <details open={open} onToggle={(event) => onToggle(node.key, event.currentTarget.open)}>
      <summary className="node-row" data-status={node.status} data-kind={node.kind}>
        <ChevronRight size={12} className="node-caret" />
        <NodeLine node={node} />
        {duration && <time>{duration}</time>}
      </summary>
      <ol className="node-children">
        {node.children.map((child) => <ActivityLeaf key={child.key} node={child} />)}
      </ol>
    </details>
    {node.alerts.length > 0 && <ul className="group-alerts">
      {node.alerts.map((alert) => <li key={alert.key} className="node-row" data-status={alert.status} data-kind={alert.kind}>
        <span className="node-caret" /><NodeLine node={alert} />
      </li>)}
    </ul>}
  </li>;
}

/** An evidence entry's payload: what was read back, and what proves it. */
function EvidenceBody({ evidence }: { evidence: RunEvidence }) {
  const lines = evidence.lines ?? [];
  const metadata = evidence.metadata ?? [];
  return <div className="node-evidence">
    <strong>{evidenceDetailLabel(evidence.kind)}</strong>
    {evidence.detail && <p className="evidence-note">{evidence.detail}</p>}
    {hasPicture(evidence) && <EvidencePicture className="evidence-image" evidence={evidence} alt={evidence.title} />}
    {evidence.soundRef !== undefined && <EvidenceSound evidence={evidence} />}
    {lines.length > 0 && (evidence.format === "code"
      // A source read-back is verbatim: indentation and blank lines are part of
      // what is being shown, so it is a code block, not a list of strings.
      ? <pre className="evidence-code"><code>{lines.join("\n")}</code></pre>
      : <ul className="evidence-lines">{lines.map((line, index) => <li key={`${evidence.id}-${index}`}>{line}</li>)}</ul>)}
    {metadata.length > 0 && <MetadataList entries={metadata} />}
  </div>;
}

/**
 * What a run did, as one row: its Plan, its Activity and its results.
 *
 * Each was a bar of its own, so every reply sat under a stack of three that look
 * alike. Plan and Activity open underneath the row, independently; results open
 * in the Run Deck. Activity stays closed until the reader opens it and never
 * opens or closes itself: a project inspection is forty rows, and unrolling that
 * over the answer while the run works moves the page under the reader for
 * something they did not ask to see. The Plan is open while there is work left,
 * because it says what the agent promised, until the reader says otherwise.
 *
 * A failure is the exception to putting things away: it stays listed under the
 * closed row, since nothing else on the page would report it. One line each, so
 * the answer stays near; the full reason is in the row's tooltip and in Activity.
 *
 * Memoised, because this is what a live run re-renders for every streamed token
 * otherwise. Its inputs only change when an event of their own kind arrives.
 */
const RunStrip = memo(function RunStrip({ tasks, settled = false, steps, nodes, running, runId, changes, evidence, latest, renderFiles }: {
  tasks: readonly RunTask[];
  /** A finished run's plan, folded when every task is done. */
  settled?: boolean;
  steps: ActivityStep[];
  nodes?: ActivityNode[];
  running: boolean;
  runId: string;
  changes: readonly RunChange[];
  evidence: readonly RunEvidence[];
  latest: boolean;
  renderFiles: (files: ChangeGroup[], expansion: FileExpansion) => ReactNode;
}) {
  // Which groups the reader has opened or closed by hand. Without it, the next
  // event would re-assert the default and shut a group under their cursor.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [activityOpen, setActivityOpen] = useState(false);
  const [planChoice, setPlanChoice] = useState<boolean | null>(null);
  const resolvedNodes = useMemo(() => nodes ?? buildActivityModel(steps), [nodes, steps]);
  const hasResults = useMemo(() => runResults(changes, evidence).tabs.length > 0, [changes, evidence]);
  const onToggle = useCallback((key: string, open: boolean) => {
    setExpanded((current) => (current[key] === open ? current : { ...current, [key]: open }));
  }, []);
  const planOpen = planChoice ?? (!settled || tasks.some((task) => task.status !== "done"));
  // Both sections slide shut rather than vanish, so their rows stay a moment
  // after closing. Above the early return: a strip drawn before its run has a
  // step must call the same hooks as one drawn after.
  const plan = usePresence(planOpen && tasks.length > 0, PANEL_LEAVE_MS);
  const activity = usePresence(activityOpen, PANEL_LEAVE_MS);
  if (tasks.length === 0 && steps.length === 0 && !hasResults) return null;

  const failed = steps.filter((step) => step.state === "failed").length;
  const actions = countedActions(resolvedNodes);
  const counted = `${actions} ${actions === 1 ? "step" : "steps"}${failed > 0 ? ` · ${failed} failed` : ""}`;
  // Live, what it is doing. Finished, the last step says nothing about the run.
  const current = running ? currentNodeTitle(resolvedNodes) : finishedRunSummary(resolvedNodes);
  // Failures only. A step waiting on a decision has the approval card above the
  // composer, and repeating it here says the same thing twice.
  const alerts = resolvedNodes
    .flatMap((node) => (node.children.length === 0 ? [node] : node.alerts))
    .filter((node) => node.status === "failed")
    .slice(0, MAX_VISIBLE_ALERTS);
  return <div className="run-strip">
    <div className="run-strip-row">
      {tasks.length > 0 && <button type="button" className="strip-seg strip-plan" aria-expanded={planOpen} onClick={() => setPlanChoice(!planOpen)}>
        <ChevronRight size={14} aria-hidden="true" />
        <span className="strip-text"><strong>Plan</strong><span>{taskProgress(tasks)}</span></span>
      </button>}
      {steps.length > 0 && <button type="button" className="strip-seg strip-activity" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>
        <ChevronRight size={14} aria-hidden="true" />
        <span className="strip-text">
          <strong>Activity</strong>
          {current !== null && <span className="strip-current">{current}</span>}
          <span className="strip-count">{counted}</span>
        </span>
        {running && <span className="working-label"><i /></span>}
      </button>}
      <RunResults runId={runId} changes={changes} evidence={evidence} latest={latest} renderFiles={renderFiles} />
    </div>
    {plan.present && tasks.length > 0 && <ul className="strip-plan-rows" data-leaving={plan.leaving || undefined}>{tasks.map((task) => <li key={task.id} className={`task-row task-${task.status}`}>
      {TASK_ICON[task.status]}
      <span className="task-title">{task.title}</span>
      {task.requiresRuntimeEvidence && <em
        className="task-flag"
        title={`Needs ${(task.requiredEvidence ?? ["runtime"]).join(", ")} evidence to be called done`}
      >
        {(task.requiredEvidence ?? ["runtime"]).join("/")}
      </em>}
    </li>)}</ul>}
    {/* The rows exist only while the section is open. A closed section has no
        use for them, and a chat of old runs holds thousands. */}
    {activity.present && <ol className="activity-timeline" data-leaving={activity.leaving || undefined}>
      {resolvedNodes.map((node) => (node.children.length === 0
        ? <ActivityLeaf key={node.key} node={node} />
        : <ActivityGroup
          key={node.key}
          node={node}
          open={expanded[node.key] ?? node.status === "active"}
          onToggle={onToggle}
        />))}
    </ol>}
    {!activityOpen && alerts.length > 0 && <ul className="group-alerts section-alerts">
      {alerts.map((alert) => <li key={alert.key} className="node-row" data-status={alert.status} data-kind={alert.kind}>
        <span className="node-caret" /><NodeLine node={alert} />
      </li>)}
      {failed > alerts.length && <li><button type="button" className="more-failed" onClick={() => setActivityOpen(true)}>{failed - alerts.length} more failed</button></li>}
    </ul>}
  </div>;
});

function ApprovalCard({ pending, onApprove, onReject }: { pending: PendingApproval; onApprove: () => void; onReject: () => void }) {
  const irreversible = pending.proposal.risk === "irreversible";
  const code = approvalCode(pending.proposal.tool, pending.proposal.arguments);
  const subtitle = code?.subtitle
    ?? (irreversible ? "This cannot be undone from Studio" : "One reversible Studio change");
  return <div className="approval-card">
    <div className="approval-heading"><div className="card-icon warning"><ShieldCheck size={18} /></div><div><strong>Approval needed</strong><span>{subtitle}</span></div></div>
    <p>{describePolicyReason(pending.reason)}</p>
    {code === undefined
      ? <div className="approval-scope"><FileCode2 size={15} /><span>{pending.proposal.summary}</span></div>
      : <pre className="approval-script" aria-label={code.label}>{code.lines.map((tokens, index) => <Fragment key={index}>
        {index > 0 && "\n"}<CodeTokens tokens={tokens} />
      </Fragment>)}</pre>}
    <div className="approval-actions"><button className="secondary-action" onClick={onReject}>Reject</button><button className="primary-action" onClick={onApprove}><Check size={15} /> Approve</button></div>
  </div>;
}

/** One line of already-lexed Luau. The text is never altered, only wrapped. */
function CodeTokens({ tokens }: { tokens: SyntaxToken[] }) {
  return <>{tokens.map((token, index) => (
    <span className={`syntax-${token.kind}`} key={index}>{token.text}</span>
  ))}</>;
}

/** Widest coordinate in the file, so the rail is sized rather than boxed. */
function gutterWidth(rows: readonly DiffRow[]): string {
  const widest = rows.reduce((total, row) => Math.max(total, row.oldLine ?? 0, row.newLine ?? 0, row.hidden?.newTo ?? 0), 0);
  return `${Math.max(2, String(widest).length)}ch`;
}

/**
 * The coordinate a row occupies in the file it belongs to.
 *
 * A unified row lives on one side or the other, so one number is the row's own:
 * the new coordinate for an addition or a context line, the old one for a
 * removal. Where the two sides have drifted apart, the pair is kept on the
 * title so the old coordinate stays reachable without a second column.
 */
function lineNumber(row: DiffRow): { text: string; title?: string } {
  const number = row.newLine ?? row.oldLine;
  if (number === null || number === undefined) return { text: "" };
  const drifted = row.oldLine !== null && row.newLine !== null && row.oldLine !== row.newLine;
  return { text: String(number), title: drifted ? `Was line ${row.oldLine}` : undefined };
}

/**
 * The code surface: a unified diff laid out the way an editor lays out a file.
 *
 * Three columns — line number, diff marker, code — where the first two form one
 * pinned gutter and the code scrolls under it. `shared/text-diff.ts` supplies
 * real context lines and folds only over long unchanged regions, so a hunk
 * reads as a region of a file rather than as a pair of coloured lines, and
 * `diff-view.ts` supplies the Luau tokens.
 *
 * The gutter is one pinned column beside the code rather than a pinned cell on
 * every row. Pinning each row's cells cost the browser two sticky elements per
 * line, and a long chat's diffs carried over a thousand, reworked on every
 * frame: typing, scrolling and opening a group all lagged with them.
 */
function CodeSurface({ rows, language, label }: { rows: DiffRow[]; language?: string; label: string }) {
  const tokens = useMemo(() => highlightRows(rows, language), [rows, language]);
  const style = { "--gutter": gutterWidth(rows) } as CSSProperties;
  const folded = (row: DiffRow) => row.kind === "collapse" || row.kind === "truncated";
  const foldClass = (row: DiffRow) => `code-fold${row.kind === "truncated" ? " code-fold-cut" : ""}`;

  return <div className="code-surface" role="region" aria-label={label}>
    <div className="code-lines" style={style}>
      <div className="code-rail" aria-hidden="true">
        {rows.map((row, index) => {
          if (folded(row)) return <div className={foldClass(row)} key={index}><span className="code-fold-spacer" /></div>;
          const number = lineNumber(row);
          return <div className={`code-rail-row code-${row.kind}`} key={index}>
            <span className="code-gutter" title={number.title}>{number.text}</span>
            <span className="code-sign">{row.marker === " " ? "" : row.marker}</span>
          </div>;
        })}
      </div>
      <div className="code-rows">
        {rows.map((row, index) => {
          if (folded(row)) {
            return <div className={foldClass(row)} key={index}>
              <span className="code-fold-body">
                <span className="code-fold-mark" aria-hidden="true">⋯</span>
                <span>{row.text}</span>
                {row.hidden && <span className="code-fold-range">{row.hidden.newFrom}–{row.hidden.newTo}</span>}
              </span>
            </div>;
          }
          return <div className={`code-line code-${row.kind}`} key={index}>
            <code className="code-text"><CodeTokens tokens={tokens[index]} /></code>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function DiffBody({ change }: { change: RunChange }) {
  const rows = useMemo(
    () => parseDiffRows(change.diff ?? "", change.oldStartLine, change.newStartLine),
    [change.diff, change.oldStartLine, change.newStartLine],
  );
  return <CodeSurface rows={rows} language={change.language} label={`Diff of ${change.target}`} />;
}

function SourceBody({ change }: { change: RunChange }) {
  // Only the producer knows whether these lines are new or merely unseen: it
  // counts them as additions when the file did not exist before, and not
  // otherwise.
  const rows = useMemo(
    () => sourceRows(change.code ?? "", change.newStartLine, change.addedLines !== undefined),
    [change.code, change.newStartLine, change.addedLines],
  );
  return <CodeSurface rows={rows} language={change.language} label={`Source of ${change.target}`} />;
}

/**
 * Code a run created or changed, as one editor panel.
 *
 * The point of the panel is the code: the diff when there is one to show, the
 * resulting source when the script is new. Everything else is chrome and is
 * sized as chrome — a compact file header above, and below it the fingerprints
 * that prove the write landed on the source that was read, which are
 * unreadable noise until someone is checking exactly that.
 */
/** One write to a file: its diff, its whole source, or what it says it did. */
function ChangeBody({ change }: { change: RunChange }) {
  return <div className="artifact-change">
    {change.kind === "asset" && change.assetUrl
      ? <div className="asset-result">
          <p className="card-body-text">{change.summary}</p>
          <a className="asset-result-link" href={change.assetUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
            <span>Open asset {change.assetId} on Roblox</span>
          </a>
        </div>
      : change.diff
      ? <DiffBody change={change} />
      : change.code
        ? <SourceBody change={change} />
        : <p className="card-body-text">{change.summary}</p>}
    {change.truncated && <p className="artifact-note">Shortened to keep this card small; Studio has the whole file.</p>}
  </div>;
}

function ArtifactCard({ group, expanded, onExpandedChange, onOpenInStudio }: {
  group: ChangeGroup;
  /** Held by the Results card, so an open diff outlives a tab switch and the end of the run. */
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onOpenInStudio: OpenInStudio;
}) {
  const { changes } = group;
  const bodyId = useId();
  const { latest, earlier } = splitChangeGroup(group);
  // Counts belong to one write. Adding up every write to a file reports more
  // changed lines than the file has, so a file written more than once says how
  // many times instead.
  const added = latest?.addedLines ?? 0;
  const removed = latest?.removedLines ?? 0;
  const revisionBefore = changes.find((change) => change.revisionBefore)?.revisionBefore;
  const revisionAfter = [...changes].reverse().find((change) => change.revisionAfter)?.revisionAfter;
  const scriptChange = changes.find((change) => change.kind === "script-source");
  const assetChange = changes.find((change) => change.kind === "asset");
  // A save still pending Rojo delivery, or one Studio diverged from before it
  // arrived, never touched Studio: offering to open it there would show the
  // old script and imply the edit landed.
  const openableInStudio = scriptChange !== undefined && canOpenInStudio(scriptChange);
  const [openState, setOpenState] = useState<{ kind: "idle" | "opening" | "opened" | "error"; message?: string }>({ kind: "idle" });
  const revisions: RunMetadata[] = [
    ...(revisionBefore ? [{ label: "Revision before", value: revisionBefore }] : []),
    ...(revisionAfter ? [{ label: "Revision after", value: revisionAfter }] : []),
  ];
  const openScript = async () => {
    if (!openableInStudio || openState.kind === "opening") return;
    setOpenState({ kind: "opening" });
    const result = await onOpenInStudio(group.target, scriptChange.instanceId);
    setOpenState({ kind: result.ok ? "opened" : "error", message: result.message });
  };
  // The whole header toggles for a pointer, as a file row in a list should;
  // the chevron stays the one control the keyboard and screen readers use.
  const toggleFromHeader = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, a") !== null) return;
    onExpandedChange(!expanded);
  };
  const fileLabel = targetLabel(group.target);
  return <article className="diff-artifact">
    <div className="diff-header" onClick={toggleFromHeader}>
      <div className="diff-file">{assetChange ? <FileBox size={14} /> : <FileCode2 size={14} />}<code title={group.target}>{fileLabel.name}{fileLabel.parent !== undefined && <span className="diff-file-parent">{fileLabel.parent}</span>}</code></div>
      <div className="diff-actions">
        {openableInStudio && <button className={`open-studio-action state-${openState.kind}`} type="button" onClick={() => void openScript()} disabled={openState.kind === "opening"} title={openState.message ?? "Open this script in Roblox Studio"}>
          {openState.kind === "opened" ? <Check size={13} /> : openState.kind === "error" ? <AlertCircle size={13} /> : <ExternalLink size={13} />}
          <span>{openState.kind === "opening" ? "Opening…" : openState.kind === "opened" ? "Opened" : openState.kind === "error" ? "Try again" : "Open in Studio"}</span>
        </button>}
        {earlier.length > 0
          ? <div className="diff-writes" title={`This run wrote this file ${changes.length} times`}>{changes.length} writes</div>
          : (added > 0 || removed > 0) && <div className="diff-summary" aria-label={`${added} lines added, ${removed} lines removed`}>
            {added > 0 && <span className="added">+{added}</span>}
            {removed > 0 && <span className="removed">−{removed}</span>}
          </div>}
        <button className="diff-collapse" type="button" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} title={expanded ? "Collapse this file" : "Expand this file"} onClick={() => onExpandedChange(!expanded)}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
    {openState.kind === "error" && <p className="artifact-feedback" role="status">{openState.message}</p>}
    {/* Mounted on demand rather than hidden: a hidden diff still costs every
        one of its lines to build, and history holds many. */}
    {expanded && <div className="diff-body" id={bodyId}>
      {latest && <ChangeBody change={latest} />}
      {earlier.length > 0 && <CardDetails label={`${earlier.length} earlier ${earlier.length === 1 ? "write" : "writes"} in this run`}>
        {earlier.map((change) => <ChangeBody change={change} key={change.id} />)}
      </CardDetails>}
    </div>}
    {expanded && revisions.length > 0 && <CardDetails label="Revision details"><MetadataList entries={revisions} /></CardDetails>}
  </article>;
}

/**
 * The Changes tab: one row per file, as a list to scan. A lone file opens on
 * its diff; several stay folded to their headers — path, line counts, Open in
 * Studio — so a run that touched five scripts reads as five lines, and any one
 * opens in place. Which are open is the Results card's to keep.
 *
 * Memoised: see `ActivitySection`. The diffs are the bulk of a live run's DOM.
 */
const ChangeSet = memo(function ChangeSet({ groups, expansion, onOpenInStudio }: { groups: ChangeGroup[]; expansion: FileExpansion; onOpenInStudio: OpenInStudio }) {
  if (groups.length === 0) return null;
  return <div className="change-set" aria-label="Changed files" role="list">
    {groups.map((group) => <div role="listitem" key={group.target}>
      <ArtifactCard
        group={group}
        expanded={expansion.isOpen(group.target)}
        onExpandedChange={(open) => expansion.onToggle(group.target, open)}
        onOpenInStudio={onOpenInStudio}
      />
    </div>)}
  </div>;
});

function AppliedStatus() {
  return <div className="applied-status"><Check size={14} /><span>Applied and verified in Studio</span></div>;
}

/**
 * The end of a run, and — when the completion gate was not satisfied — exactly
 * what it is missing.
 *
 * The issues are listed rather than summarised into a single adjective because
 * "unverified" on its own gives the reader nothing to check. A run that wrote a
 * script it never read back and a run that skipped a playtest it promised are
 * different problems with different fixes.
 */
function OutcomeCard({ outcome, summary, warnings = false, issues = [] }: { outcome: RunOutcome; summary: string; warnings?: boolean; issues?: string[] }) {
  // A gate issue is a reason not to call the run plainly complete.
  const warned = warnings || issues.length > 0;
  return <div className="run-outcome" data-outcome={outcome} data-warnings={warned || undefined}>
    <p>
      {outcome === "completed" && !warned ? <Check size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}
      <strong>{describeOutcome(outcome, warned)}</strong>
      {summary !== "" && <span>{summary}</span>}
    </p>
    {issues.length > 0 && <ul className="gate-issues">
      {issues.map((issue, index) => <li key={index}>{issue}</li>)}
    </ul>}
  </div>;
}

/** So a run with no plan does not hand the row a new array every render. */
const NO_TASKS: readonly RunTask[] = [];

const TASK_ICON: Record<RunTaskStatus, React.ReactNode> = {
  pending: <Circle size={13} />,
  active: <CircleDot size={13} />,
  done: <Check size={13} />,
  blocked: <AlertCircle size={13} />,
};

/**
 * The agent's one bounded question.
 *
 * Every choice is a button carrying the model's own wording, and answering
 * sends its index rather than its text, so the renderer never composes anything
 * the provider will read. The last button is the host's: it does not answer
 * yet, it hands the question to the composer, and the answer goes out with the
 * note the person writes there.
 */
function QuestionCard({ question, explaining, onAnswer, onExplain }: {
  question: RunQuestion;
  explaining: boolean;
  onAnswer: (index: number) => void;
  onExplain: () => void;
}) {
  return <div className="approval-card question-card">
    <div className="approval-heading">
      <div className="card-icon warning"><HelpCircle size={18} /></div>
      <div><strong>Roqer needs a decision</strong><span>{explaining ? "Write your answer below and send it" : "The run is paused until you choose"}</span></div>
    </div>
    <p>{question.question}</p>
    <div className="approval-actions question-options">
      {question.options.map((option, index) => <button
        key={option}
        className={index === 0 ? "primary-action" : "secondary-action"}
        onClick={() => onAnswer(index)}
      >{option}</button>)}
      <button className={`secondary-action question-escape${explaining ? " active" : ""}`} onClick={onExplain} aria-pressed={explaining}>{QUESTION_ESCAPE_OPTION}</button>
    </div>
  </div>;
}

/**
 * A finished run from history, in the same two layers a live one uses.
 *
 * Only the latest run's results open by default. An earlier run's card folds
 * to its header -- files, uploads and pictures, each counted -- and mounts its
 * contents when asked, because opening a chat used to build every line of
 * every past diff before it could draw a frame: half a second for a modest
 * chat, over a second for a long one, on every switch. A plan that finished
 * folds the same way; one with a blocked task stays open, since that is news.
 */
function RunRecordView({ record, text, latest, onOpenInStudio }: { record: RunRecord; text: string; latest: boolean; onOpenInStudio: OpenInStudio }) {
  const warnings = recordHasWarnings(record);
  const failed = record.toolCalls.filter((call) => !call.ok).length;
  const appliedAndVerified = recordAppliedAndVerified(record);
  const onlyAnswered = recordOnlyAnswered(record, text);
  const showOutcome = !appliedAndVerified && !onlyAnswered;
  const outcomeNote = completedRunMetadataLabel(
    record.planner === DEMO_PLANNER ? "Demo" : null,
    record.startedAt,
    record.finishedAt,
  );
  const steps = useMemo(() => recordSteps(record), [record]);
  const renderFiles = useCallback((files: ChangeGroup[], expansion: FileExpansion) => <ChangeSet groups={files} expansion={expansion} onOpenInStudio={onOpenInStudio} />, [onOpenInStudio]);
  return <>
    <RunStrip tasks={record.tasks ?? NO_TASKS} settled steps={steps} running={false} runId={record.runId} changes={record.changes} evidence={record.evidence} latest={latest} renderFiles={renderFiles} />
    {/* Carries on a reveal the live view had not finished; an older reply shows at once. */}
    <StreamingMarkdown text={recordReply(record, text)} done handoffKey={record.runId} className="result-copy" />
    {appliedAndVerified && <AppliedStatus />}
    {showOutcome && <OutcomeCard
      outcome={record.outcome}
      warnings={warnings}
      summary={record.outcome === "completed" ? "" : countLine(record.toolCalls.length, record.changes.length, failed)}
      issues={recordGateIssues(record)}
    />}
    {record.review !== undefined && <ReviewCard review={record.review} latest={latest} />}
    <CompletionLine metadata={outcomeNote} usage={record.usage} />
    {/* Notes the run ended before reading stay visible, so they can be sent again. */}
    {record.notes !== undefined && record.notesDelivered !== undefined && record.notesDelivered < record.notes.length &&
      <RunNotes notes={record.notes} delivered={record.notesDelivered} running={false} />}
  </>;
}

/** Escape closes a dialog, the way every other window on the desktop does. */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [onClose]);
}

/**
 * Naming something: a new project, or a project or chat being renamed.
 *
 * One dialog for all three, because they ask the same question. A rename opens
 * with the current name selected, so replacing it takes one keystroke and
 * editing it still works.
 */
function NameModal({ heading, description, label, placeholder, initialValue = "", confirmLabel, confirmIcon, onSubmit, onClose }: {
  heading: string;
  description: string;
  label: string;
  placeholder: string;
  initialValue?: string;
  confirmLabel: string;
  confirmIcon: React.ReactNode;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialValue);
  const submit = () => { if (name.trim()) onSubmit(name); };
  useEscapeToClose(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className="name-modal" role="dialog" aria-modal="true" aria-label={heading} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><h2>{heading}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
    <p>{description}</p>
    <label><span>{label}</span><input autoFocus value={name} onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder={placeholder} /></label>
    <div className="modal-actions"><button className="secondary-action" onClick={onClose}>Cancel</button><button className="primary-action" disabled={!name.trim()} onClick={submit}>{confirmIcon} {confirmLabel}</button></div>
  </div></div>;
}

/**
 * Confirmation for a delete.
 *
 * Chats and projects live only on this device and there is no undo, so the
 * dialog says what is about to be lost in the same terms the sidebar uses, and
 * Cancel keeps the focus so that leaning on Enter cannot delete anything.
 */
function ConfirmModal({ heading, description, confirmLabel, onConfirm, onClose }: {
  heading: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className="name-modal" role="dialog" aria-modal="true" aria-label={heading} onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><h2>{heading}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
    <p>{description}</p>
    <div className="modal-actions"><button className="secondary-action" autoFocus onClick={onClose}>Cancel</button><button className="danger-action" onClick={onConfirm}><Trash2 size={15} /> {confirmLabel}</button></div>
  </div></div>;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function statusLabel(kind: StudioStatus["kind"]): string {
  if (kind === "connected") return "Healthy";
  if (kind === "bridge-only") return "MCP available";
  if (kind === "checking") return "Checking";
  return "Offline";
}

export default App;
