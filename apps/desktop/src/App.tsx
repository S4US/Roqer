import {
  AlertCircle, AlertTriangle, Archive, Bot, Boxes, Check, ChevronDown, ChevronRight, CircleStop, Circle, Download,
  CircleDot, ExternalLink, FileBox, FileCode2, FileText, Folder, FolderPlus, Gamepad2, HardDrive,
  HelpCircle, Info, ListChecks, Loader2, MessageSquare, MinusCircle, Moon, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Play, Plus, RotateCw, Search, Send, Settings,
  ShieldCheck, Sparkles, Sun,
  Trash2, X, Zap,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  appendMessage, chatStudioInstanceId, createChat, createId, createInitialWorkspace, createProject,
  deleteChat, deleteProject, modelPreference, normalizeWorkspace, renameChat,
  renameProject, selectedModelId, setChatStudioInstance, type ApprovalMode,
  type AssetAttachment, type ChatMessage, type WorkspaceState,
} from "./model";
import {
  cancelRun, cancelRunStart, getStudioStatus,
  hasDesktopRuntime, loadWorkspace, pickAsset, getStorageStatus, recoverWorkspace, exportWorkspace, releaseAttachments,
  answerRunQuestion, attachImage, ATTACHABLE_IMAGE_TYPES, steerRun,
  getBridgeState, restartBridge, subscribeToBridge, type McpServerState,
  getUpdateState, installUpdate, subscribeToUpdates, type AppUpdateState,
  flushWorkspace, getProviderModels, getProviderStatus, loginProvider, openScriptInStudio, respondToRun, saveWorkspace, startRun,
  submitProviderCode, subscribeToRuns,
  type ProviderModelCatalog, type ProviderStatus,
  type StudioStatus,
} from "./platform";
import {
  activitySteps, applyRunEvent, createRunView, describeOutcome, recordAppliedAndVerified,
  recordGateIssues, recordHasWarnings, recordOnlyAnswered, recordSteps, runAppliedAndVerified,
  runGateIssues, runHasWarnings, runOnlyAnswered, toRunRecord,
  type ActivityStep, type PendingApproval, type RunView,
} from "./run-view";
import { QUESTION_ESCAPE_OPTION, type RunQuestion } from "../shared/question";
import { summarizeTasks, type RunTask, type RunTaskStatus } from "../shared/tasks";
import { Markdown } from "./markdown-view";
import { CustomConnectionsSettings } from "./custom-connections";
import { OpenCloudSettings } from "./open-cloud-settings";
import { BlenderSettingsRow } from "./blender-settings";
import { SettingsSection, SettingsSwitch } from "./settings-parts";
import { providerCard } from "./provider-card";
import { approvalCode } from "./approval-code";
import {
  groupChangesByTarget, highlightRows, parseDiffRows, sourceRows, splitChangeGroup,
  type ChangeGroup, type DiffRow, type SyntaxToken,
} from "./diff-view";
import {
  aggregateDuration, buildActivityModel, currentNodeTitle, elapsedLabel, MAX_VISIBLE_ALERTS,
  type ActivityNode, type StepStatus,
} from "./activity-model";
import {
  CONVERSATION_WINDOW_SIZE, earlierConversationWindowStart, initialConversationWindowStart,
} from "./conversation-window";
import { DEMO_PLANNER, startDemoRun, type DemoRunHandle } from "./demo-run";
import { evidenceDetailLabel, type ActivityKind } from "../shared/activity";
import { boundConversation } from "../shared/conversation";
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
import {
  ENABLED_PROVIDER_IDS,
  providerLabel,
  type ProviderId,
  type ReasoningEffort,
} from "../shared/provider";

type SelectOption = {
  value: string;
  label: string;
  title?: string;
};

const APPROVAL_OPTIONS: SelectOption[] = [
  { value: "Ask first", label: "Ask first", title: "Confirm every change before it reaches your project." },
  { value: "Auto approve", label: "Auto approve", title: "Ordinary, recoverable edits run unattended. Anything that cannot be undone still asks." },
  { value: "Full auto", label: "Full auto", title: "Nothing asks: publishing, asset spend, and arbitrary Luau all run unattended." },
  { value: "Read only", label: "Read only", title: "Inspect the place and block every change to it." },
];

const PROVIDER_TITLES: Record<ProviderId, string> = {
  chatgpt: "Use your ChatGPT subscription through the Codex app. Codex must be installed on this computer.",
  claude: "Use your Claude subscription through Claude Code. Claude Code must be installed on this computer.",
  custom: "Use a model on your own endpoint: an API key from OpenAI, Anthropic, OpenRouter and others, or a model server on this computer. Set it up in Settings.",
};

function providerOptions(): SelectOption[] {
  return ENABLED_PROVIDER_IDS.map((provider) => ({
    value: provider,
    label: providerLabel(provider),
    title: PROVIDER_TITLES[provider],
  }));
}

function effortLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort[0].toUpperCase()}${effort.slice(1)}`;
}

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

const isImageAttachment = (attachment: AssetAttachment): boolean =>
  attachment.mediaType !== undefined && ATTACHABLE_IMAGE_TYPES.has(attachment.mediaType);

/** What the chat can promise about an attachment, given where the run will go. */
function attachmentDetail(attachment: AssetAttachment, imagesReachModel: boolean): string {
  if (isImageAttachment(attachment)) {
    return imagesReachModel ? "image shared with agent" : "image saved; this sign-in cannot read images";
  }
  return hasDesktopRuntime() && /\.(rbxmx|txt|md|lua|luau)$/i.test(attachment.name)
    ? "text shared with agent"
    : "file details only; contents not read";
}

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
  const [attachments, setAttachments] = useState<AssetAttachment[]>([]);
  const [runView, setRunView] = useState<RunView | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  /** The callId of a pending question being answered in the composer, if any. */
  const [explainingQuestion, setExplainingQuestion] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Choosing to explain moves the person's attention from the card to the
  // box, so the box takes focus rather than waiting to be clicked.
  useEffect(() => {
    if (explainingQuestion !== null) composerRef.current?.focus();
  }, [explainingQuestion]);
  const [showConnection, setShowConnection] = useState(false);
  const connectionRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);
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
  // The run id is only known once the main process answers, but events can
  // arrive before that, so anything early is buffered and drained on adoption.
  const activeRunId = useRef<string | null>(null);
  const eventBuffer = useRef<RunEvent[]>([]);
  const demoHandle = useRef<DemoRunHandle | null>(null);
  const runTarget = useRef<{ projectId: string; chatId: string } | null>(null);
  const recordedRunId = useRef<string | null>(null);
  const runAttempt = useRef(0);
  const pendingStartAttempt = useRef<number | null>(null);
  const pendingStartId = useRef<string | null>(null);
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;

  const selectedProject = useMemo(
    () => workspace.projects.find((project) => project.id === workspace.selectedProjectId) ?? workspace.projects[0],
    [workspace],
  );
  const selectedChat = useMemo(
    () => selectedProject?.chats.find((chat) => chat.id === workspace.selectedChatId),
    [selectedProject, workspace.selectedChatId],
  );

  /** Abandon a run, used when its target is deleted or the renderer unmounts. */
  const resetRun = useCallback((discard = false) => {
    runAttempt.current += 1;
    pendingStartAttempt.current = null;
    if (pendingStartId.current) void cancelRunStart(pendingStartId.current);
    pendingStartId.current = null;
    if (demoHandle.current) {
      demoHandle.current.cancel();
      demoHandle.current = null;
    } else if (activeRunId.current) {
      void cancelRun(activeRunId.current, discard);
    }
    activeRunId.current = null;
    eventBuffer.current = [];
    runTarget.current = null;
    recordedRunId.current = null;
    setRunView(null);
    setRunStarting(false);
  }, []);

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
      const batch = pending.splice(0);
      setRunView((current) => {
        if (!current) return current;
        let view = current;
        for (const event of batch) {
          if (event.runId === view.runId) view = applyRunEvent(view, event);
        }
        return view;
      });
    };
    const unsubscribe = subscribeToRuns((event) => {
      if (activeRunId.current === null) {
        if (pendingStartAttempt.current !== null) eventBuffer.current.push(event);
        return;
      }
      if (event.runId !== activeRunId.current) return;
      pending.push(event);
      scheduled ??= setTimeout(flush, 16);
    });
    return () => {
      unsubscribe();
      if (scheduled !== null) clearTimeout(scheduled);
    };
  }, []);

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

  const connectProvider = async () => {
    const result = await loginProvider(provider);
    if (result.ok) {
      setProviderStatus({ kind: "signed-out", message: result.message });
      // A flow that still needs a pasted code is finished by the settings
      // modal, so polling would only overwrite its instructions.
      if (!result.awaitingCode) window.setTimeout(() => void refreshProviderStatus(), 2_500);
    } else {
      setProviderStatus({ kind: "unavailable", message: result.message });
    }
    return result;
  };

  const finishProviderLogin = async (code: string) => {
    const result = await submitProviderCode(provider, code);
    await refreshProviderStatus();
    return result;
  };

  // A finished run becomes one assistant message carrying a compacted record,
  // so the result survives a restart without keeping the whole event stream.
  useEffect(() => {
    if (!runView || runView.outcome === null) return;
    if (recordedRunId.current === runView.runId) return;
    recordedRunId.current = runView.runId;

    const target = runTarget.current;
    if (target) {
      setWorkspace((current) => appendMessage(current, target.projectId, target.chatId, {
        id: createId("message"),
        role: "assistant",
        text: runView.text.trim() || runView.summary,
        createdAt: new Date().toISOString(),
        run: toRunRecord(runView) ?? undefined,
      }));
    }

    // The live view and the recorded message say the same thing, so the handoff
    // has to happen in one commit. Retiring the live view on a timer instead
    // left both on screen together, and the reply appeared to arrive twice.
    setRunView(null);
    activeRunId.current = null;
    demoHandle.current = null;
    pendingStartAttempt.current = null;
    runTarget.current = null;
  }, [runView]);

  const isRunning = runStarting || (runView !== null && runView.outcome === null);
  const runBelongsToSelectedChat = runTarget.current?.projectId === workspace.selectedProjectId &&
    runTarget.current?.chatId === workspace.selectedChatId;
  const showRunControls = runBelongsToSelectedChat && (runStarting || runView !== null);
  /**
   * The one run, as seen from anywhere else in the interface. There is a single
   * run at a time and the composer is disabled everywhere while it works, so a
   * chat that is not the one it is in has to be able to say where it is, whether
   * it is waiting on the person, and offer a way there.
   */
  const runNeedsInput = runView !== null && runView.outcome === null &&
    (runView.pendingQuestion !== null || runView.pendingApproval !== null);
  const runLocation = runTarget.current;
  const runChat = isRunning && runLocation !== null
    ? workspace.projects.find((project) => project.id === runLocation.projectId)?.chats
      .find((chat) => chat.id === runLocation.chatId) ?? null
    : null;
  const runElsewhere = isRunning && !runBelongsToSelectedChat;
  /** The composer addresses the running agent rather than starting a run. */
  const steering = isRunning && runBelongsToSelectedChat && !runStarting;
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
   * When the note is the answer to a question, the answer follows the note:
   * the note has to be queued before the model resumes, so that the turn it
   * resumes into carries both.
   */
  const sendSteer = async () => {
    const text = composer.trim();
    if (!text || !steering) return;
    if (text.length > MAX_STEER_CHARS) { setAttachmentError(`Shorten the note to ${MAX_STEER_CHARS.toLocaleString()} characters.`); return; }
    const target = runTarget.current;
    if (!target) return;
    const accepted = demoHandle.current
      ? demoHandle.current.steer(text)
      : activeRunId.current !== null && await steerRun(activeRunId.current, text);
    if (!accepted) {
      setAttachmentError("Roqer had already finished. Send it as a new message.");
      return;
    }
    setWorkspace((current) => appendMessage(current, target.projectId, target.chatId, {
      id: createId("message"), role: "user", text, createdAt: new Date().toISOString(),
    }));
    setComposer("");
    const pending = runView?.pendingQuestion;
    if (explaining && pending) {
      setExplainingQuestion(null);
      if (demoHandle.current) demoHandle.current.answer(pending.callId, pending.options.length);
      else if (activeRunId.current !== null) void answerRunQuestion(activeRunId.current, pending.callId, pending.options.length);
    }
  };

  const sendPrompt = async () => {
    if (steering) { await sendSteer(); return; }
    const prompt = composer.trim();
    if (!prompt || isRunning || !hydrated || !storageAvailable || storageRecovery.required) return;
    if (prompt.length > 64_000) { setAttachmentError("Shorten the message to 64,000 characters before sending."); return; }
    if (hasDesktopRuntime() && providerStatus.kind !== "signed-in") {
      setShowSettings(true);
      return;
    }
    const chosenModelId = selectedModelId(workspace.preferences, provider);
    const availableModel = modelCatalog.models.find((model) => model.id === chosenModelId);
    if (hasDesktopRuntime() && !availableModel) {
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
    const conversation = boundConversation((targetChat?.messages ?? []).map(({ role, text, run }) => {
      const digest = run === undefined ? undefined : digestRun(run);
      return digest === undefined || digestIsEmpty(digest) ? { role, text } : { role, text, run: digest };
    }));
    next = appendMessage(next, projectId, chatId, {
      id: createId("message"), role: "user", text: prompt, createdAt: new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setWorkspace(next);
    setExpandedProjects((current) => new Set(current).add(projectId));
    setComposer("");
    setAttachments([]);

    const request: RunStartRequest = {
      projectId, chatId, prompt, conversation,
      startId: createId("start"),
      attachmentIds: attachments.map((attachment) => attachment.id),
      approvalMode: next.preferences.approvalMode,
      autoPlaytest: next.preferences.autoPlaytest,
      endpoint: next.preferences.mcpEndpoint,
      instanceId: resolveInstanceId(studioStatus, chatStudioInstanceId(next, projectId, chatId)),
      provider: next.preferences.provider,
      model: availableModel?.id ?? null,
      effort: availableModel?.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === next.preferences.reasoningEffort)
        ? next.preferences.reasoningEffort
        : availableModel?.defaultReasoningEffort ?? "medium",
    };
    runTarget.current = { projectId, chatId };
    const attempt = ++runAttempt.current;
    pendingStartAttempt.current = attempt;
    pendingStartId.current = request.startId!;
    recordedRunId.current = null;
    eventBuffer.current = [];
    activeRunId.current = null;
    setRunStarting(true);

    if (!hasDesktopRuntime()) {
      const runId = createId("demo-run");
      activeRunId.current = runId;
      pendingStartAttempt.current = null;
      pendingStartId.current = null;
      setRunView(createRunView(runId, prompt, request.approvalMode));
      setRunStarting(false);
      demoHandle.current = startDemoRun(runId, request, (event) => {
        setRunView((current) => (current && current.runId === event.runId ? applyRunEvent(current, event) : current));
      });
      return;
    }

    let started: Awaited<ReturnType<typeof startRun>>;
    try {
      started = await startRun(request);
    } catch (error) {
      if (runAttempt.current !== attempt) return;
      pendingStartAttempt.current = null;
      setRunStarting(false);
      runTarget.current = null;
      const message = error instanceof Error ? error.message : String(error);
      setWorkspace((current) => appendMessage(current, projectId, chatId, {
        id: createId("message"), role: "assistant",
        text: `I couldn't start this run: ${message}`,
        createdAt: new Date().toISOString(),
      }));
      return;
    }
    if (runAttempt.current !== attempt) {
      if (started.ok) void cancelRun(started.runId);
      return;
    }
    pendingStartId.current = null;
    pendingStartAttempt.current = null;
    setRunStarting(false);
    if (!started.ok) {
      runTarget.current = null;
      setWorkspace((current) => appendMessage(current, projectId, chatId, {
        id: createId("message"), role: "assistant",
        text: `I couldn't start this run: ${started.message}`,
        createdAt: new Date().toISOString(),
      }));
      return;
    }

    activeRunId.current = started.runId;
    const buffered = eventBuffer.current
      .filter((event) => event.runId === started.runId)
      .sort((left, right) => left.seq - right.seq);
    eventBuffer.current = [];
    setRunView(buffered.reduce(applyRunEvent, createRunView(started.runId, prompt, request.approvalMode)));
  };

  const answerApproval = (decision: "approved" | "rejected") => {
    const pending = runView?.pendingApproval;
    if (!runView || !pending) return;
    if (demoHandle.current) demoHandle.current.respond(pending.callId, decision);
    else void respondToRun(runView.runId, pending.callId, decision);
  };

  /** Answer the agent's question by index. */
  const answerQuestion = (answerIndex: number) => {
    const pending = runView?.pendingQuestion;
    if (!runView || !pending) return;
    // Choosing one of the model's options after all withdraws the explanation.
    setExplainingQuestion(null);
    if (demoHandle.current) demoHandle.current.answer(pending.callId, answerIndex);
    else void answerRunQuestion(runView.runId, pending.callId, answerIndex);
  };

  /** Hand the pending question to the composer; the answer goes out with the note. */
  const explainAnswer = () => {
    const pending = runView?.pendingQuestion;
    if (!runView || !pending) return;
    setExplainingQuestion((current) => current === pending.callId ? null : pending.callId);
  };

  const stopRun = () => {
    if (demoHandle.current) demoHandle.current.cancel();
    else if (activeRunId.current) void cancelRun(activeRunId.current);
    else if (pendingStartAttempt.current !== null) resetRun();
  };

  /** Picking a chat gets the sidebar out of the way only when it is in the way.
   *  A docked sidebar is part of the layout and stays put. */
  const dismissOverlaySidebar = useCallback(() => {
    if (overlaySidebar) setSidebarShown(false);
  }, [overlaySidebar]);

  const newChat = useCallback(() => {
    if (!hydrated || !storageAvailable || storageRecovery.required) return;
    const next = createChat(workspace);
    setWorkspace(next);
    setExpandedProjects((current) => new Set(current).add(next.selectedProjectId));
    setComposer(""); void releaseAttachments(attachments.map((asset) => asset.id)); setAttachments([]); dismissOverlaySidebar();
  }, [workspace, attachments, hydrated, storageAvailable, storageRecovery.required, dismissOverlaySidebar]);

  const closeDialog = useCallback(() => setDialog(null), []);

  const addProject = (name: string) => {
    if (!storageAvailable || storageRecovery.required) return;
    const next = createProject(workspace, name);
    setWorkspace(next);
    setExpandedProjects((current) => new Set(current).add(next.selectedProjectId));
    closeDialog();
    setComposer("");
  };

  /**
   * Deleting what a run is writing into would leave the run with nowhere to
   * report back to, so the run is abandoned first. The same applies to the open
   * chat, whose live view would otherwise stay on screen above a different
   * conversation.
   */
  const removeChat = (projectId: string, chatId: string) => {
    if (!storageAvailable || storageRecovery.required) return;
    if (runTarget.current?.projectId === projectId && runTarget.current.chatId === chatId) resetRun(true);
    setWorkspace((current) => deleteChat(current, projectId, chatId));
    setComposer("");
    setAttachments([]);
    closeDialog();
  };

  const removeProject = (projectId: string) => {
    if (!storageAvailable || storageRecovery.required) return;
    if (runTarget.current?.projectId === projectId) resetRun(true);
    setWorkspace((current) => deleteProject(current, projectId));
    setExpandedProjects((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setComposer("");
    setAttachments([]);
    closeDialog();
  };

  const selectChat = (projectId: string, chatId: string) => {
    setWorkspace((current) => ({ ...current, selectedProjectId: projectId, selectedChatId: chatId }));
    setComposer("");
    void releaseAttachments(attachments.map((asset) => asset.id)); setAttachments([]); dismissOverlaySidebar();
  };

  const selectProject = (projectId: string) => {
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    setWorkspace((current) => ({ ...current, selectedProjectId: projectId, selectedChatId: project?.chats[0]?.id ?? null }));
    void releaseAttachments(attachments.map((asset) => asset.id)); setAttachments([]);
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });
  };

  const updatePreferences = (changes: Partial<WorkspaceState["preferences"]>) => {
    setWorkspace((current) => ({ ...current, preferences: { ...current.preferences, ...changes } }));
  };

  // Old message cards are intentionally memoized. Keep their action stable too,
  // while still reading the latest endpoint and Studio selection when clicked.
  const chatInstanceId = chatStudioInstanceId(workspace, workspace.selectedProjectId, workspace.selectedChatId);
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
    () => connectedStudios(studioStatus, chatInstanceId),
    [studioStatus, chatInstanceId],
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

  const attachAsset = async () => {
    setAttachmentError(null);
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) { setAttachmentError("Attach up to eight files per message."); return; }
    try {
      const asset = await pickAsset();
      if (asset) setAttachments((current) => [...current, asset]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "The file could not be attached.");
    }
  };

  /**
   * Attach pasted or dropped pictures, one at a time so that the first failure
   * stops the batch with a reason rather than leaving a half-attached message.
   */
  const attachImages = async (files: readonly File[]) => {
    setAttachmentError(null);
    let attached = attachments;
    for (const file of files) {
      if (attached.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        setAttachmentError("Attach up to eight files per message.");
        break;
      }
      if (attached.filter(isImageAttachment).length >= MAX_IMAGES_PER_MESSAGE) {
        setAttachmentError(`Send up to ${MAX_IMAGES_PER_MESSAGE} images in one message.`);
        break;
      }
      try {
        const image = await attachImage(file, file.name || "screenshot.png");
        attached = [...attached, image];
        setAttachments(attached);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : "The image could not be attached.");
        break;
      }
    }
  };

  /** Pictures from a paste or a drop; anything else is left to the browser. */
  const droppedImages = (list: FileList | null | undefined): File[] =>
    Array.from(list ?? []).filter((file) => ATTACHABLE_IMAGE_TYPES.has(file.type));

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
    if (action === "archive" && (runTarget.current?.chatId === chatId || !hasDesktopRuntime() || !storageAvailable || storageRecovery.required)) {
      setStorageError("Archive is available in the desktop app after the chat's run finishes and saved chats are healthy. You can still export a copy.");
      return;
    }
    const exported = await exportChats({ ...workspace, selectedProjectId: projectId, selectedChatId: chatId, projects: [{ ...project, chats: [chat] }] });
    if (exported && action === "archive") {
      const current = latestWorkspace.current.projects.find((candidate) => candidate.id === projectId)?.chats.find((candidate) => candidate.id === chatId);
      if (current !== chat || runTarget.current?.chatId === chatId) {
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
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);
  const onConversationScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }, []);

  // A sent or completed message is a beat the reader is meant to notice, so it
  // is followed smoothly.
  const messageCount = selectedChat?.messages.length ?? 0;
  useEffect(() => {
    if (following.current) scrollToEnd("smooth");
  }, [messageCount, scrollToEnd]);

  // A run's own events arrive many times a second while a reply streams, and
  // every approval, activity row and status change is one of them. Animating
  // each would leave the view permanently mid-glide, so these keep the end in
  // view without a transition of their own.
  useEffect(() => {
    if (following.current) scrollToEnd("instant");
  }, [runView?.lastSeq, runStarting, scrollToEnd]);

  // Another chat opens at its end, and opens there immediately.
  useEffect(() => {
    following.current = true;
    scrollToEnd("instant");
  }, [workspace.selectedChatId, scrollToEnd]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [newChat]);

  const theme = workspace.preferences.theme;
  const approvalMode = workspace.preferences.approvalMode;
  /**
   * The decision the run is blocked on, docked above the composer rather than
   * left in the transcript. A run keeps appending activity while it waits, so a
   * card inside the stream scrolls away from the user it is waiting for.
   */
  const pendingApproval = runBelongsToSelectedChat ? runView?.pendingApproval ?? null : null;
  // Keyed on the three arrays the steps are built from rather than on the view,
  // so a streamed delta -- which replaces the view but none of these -- leaves
  // the steps, the model, and everything memoised on them untouched. Measured:
  // with the whole view as the key, a run holding three diffs and forty tool
  // rows cost ~146 ms per delta, all of it reconciling rows that had not changed.
  const runTimeline = runView?.timeline;
  const runActivities = runView?.activities;
  const runEvidence = runView?.evidence;
  const runSteps = useMemo(
    () => (runTimeline && runActivities && runEvidence
      ? activitySteps({ timeline: runTimeline, activities: runActivities, evidence: runEvidence })
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
  const thinking = runBelongsToSelectedChat && (runView !== null && runView.outcome === null
    ? providerIsThinking(runView, runActivityNodes)
    : runView === null && runStarting);
  const autoPlaytest = workspace.preferences.autoPlaytest;
  const card = providerCard(provider, providerStatus, hasDesktopRuntime());
  const availableProviderOptions = providerOptions();
  const showProviderChoice = availableProviderOptions.length > 1;
  const imagesReachModel = hasDesktopRuntime();
  const selectedModel = modelCatalog.models
    .find((model) => model.id === selectedModelId(workspace.preferences, provider)) ?? null;
  const modelOptions: SelectOption[] = modelCatalog.models.length > 0
    ? modelCatalog.models.map((model) => ({
      value: model.id,
      label: model.displayName,
      title: model.description,
    }))
    : [{
      value: "",
      label: providerStatus.kind === "signed-in"
        ? modelCatalog.message ? "Models unavailable" : "Loading models…"
        : "Connect",
    }];
  const effortOptions: SelectOption[] = selectedModel
    ? selectedModel.supportedReasoningEfforts.map((entry) => ({
      value: entry.reasoningEffort,
      label: effortLabel(entry.reasoningEffort),
      title: entry.description,
    }))
    : [{ value: "medium", label: "Medium" }];

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
    <div className="app-shell" data-theme={theme} data-sidebar={sidebarShown ? "shown" : "hidden"} aria-busy={!hydrated}>
      <aside className="sidebar" id="sidebar">
        <div className="brand-row">
          {/* The transparent mark follows the surface theme so its primary ink
              keeps the intended contrast in either appearance. */}
          <img className="brand-mark" src={theme === "light" ? "./roqer-mark-light.svg" : "./roqer-mark-dark.svg"} width={38} height={38} alt="" />
          <div className="brand-copy"><strong>Roqer</strong></div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarShown(false)} aria-label="Hide sidebar" title="Hide sidebar" aria-controls="sidebar" aria-expanded={sidebarShown}><PanelLeftClose size={18} /></button>
        </div>
        <div className="sidebar-section-heading">
          <span>Projects</span>
          <button className="icon-button dark" title="Create project" onClick={() => setDialog({ kind: "create-project" })}><FolderPlus size={17} /></button>
        </div>
        <button className="new-chat-button" onClick={newChat}><Plus size={18} /> New chat <span className="shortcut">Ctrl N</span></button>
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
                  {project.chats.map((chat) => {
                    const runHere = isRunning && runLocation?.chatId === chat.id;
                    const runState = runHere ? (runNeedsInput ? "chat-needs-input" : "chat-running") : "";
                    return <div className={`chat-row ${workspace.selectedChatId === chat.id ? "chat-selected" : ""} ${runState}`} key={chat.id}>
                      <button className="chat-main" onClick={() => selectChat(project.id, chat.id)}><MessageSquare size={15} /><span className="chat-row-title">{chat.title}</span>
                        {/* While a run is in this chat, its state replaces the
                            row's timestamp: which chat Roqer is in, and whether
                            it is waiting, is the fact worth having from any
                            other chat. */}
                        {runHere
                          ? <span className="chat-run-mark" role="status" aria-label={runNeedsInput ? "Roqer needs your answer" : "Roqer is working"} title={runNeedsInput ? "Roqer needs your answer" : "Roqer is working"}>{runNeedsInput ? <CircleDot size={13} /> : <Loader2 size={13} />}</span>
                          : <time>{relativeTime(chat.updatedAt)}</time>}
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
          <button className="settings-button" onClick={() => setShowSettings(true)}><Settings size={18} /> Settings</button>
        </div>
      </aside>

      {/* Mounted either way so it can fade out as well as in; it is inert and
          unreachable while the sidebar is away. */}
      <button className="sidebar-scrim" tabIndex={sidebarShown ? 0 : -1} onClick={() => setSidebarShown(false)} aria-label="Hide sidebar" />

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setSidebarShown(true)} aria-label="Show sidebar" title="Show sidebar" aria-controls="sidebar" aria-expanded={sidebarShown}><PanelLeftOpen size={20} /></button>
          <div className="chat-heading"><strong>{selectedChat?.title ?? selectedProject?.name ?? "New project"}</strong><span>{selectedProject?.name} · {saveStatus === "saving" ? "saving…" : saveStatus === "error" ? "save failed" : "saved locally"}</span></div>
          <div className="topbar-actions">
            <button className="icon-button theme-button" onClick={() => updatePreferences({ theme: theme === "light" ? "dark" : "light" })} aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} title={theme === "light" ? "Dark theme" : "Light theme"}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
            <div className="connection-wrap" ref={connectionRef}>
              <button className={`connection-pill status-${studioStatus.kind}`} onClick={() => setShowConnection((value) => !value)}><span className="live-dot" /><span className="connection-label">{targetStudio?.name ?? studioStatus.placeName ?? "Roblox Studio"}</span><span className="connection-detail">{studioStatus.message}</span><ChevronDown size={15} /></button>
              {showConnection && <div className="connection-popover"><div className="popover-title"><div className="studio-icon"><Gamepad2 size={18} /></div><div><strong>Roblox Studio</strong><span>{studioStatus.message}</span></div></div><dl><div><dt>Bridge</dt><dd>{statusLabel(studioStatus.kind)}</dd></div></dl>
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
                {chatInstanceId !== null && studios.length > 0 && studios.every((studio) => studio.instanceId !== chatInstanceId) &&
                  <p className="popover-note">The place you chose is not open. Roqer is using the one above until it is.</p>}
                {bridgeState.kind === "failed" && <p className="popover-problem" role="alert">{bridgeState.message}</p>}
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
              </div>}
            </div>
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

        <div className="conversation-scroll" ref={scrollRef} onScroll={onConversationScroll}><div className="conversation">
          {selectedChat && selectedChat.messages.length > 0
            ? <ConversationMessages key={selectedChat.id} messages={selectedChat.messages} onOpenInStudio={openArtifactInStudio} />
            : <EmptyConversation onSuggestion={setComposer} />}
          {runView && runBelongsToSelectedChat
            ? <LiveRun view={runView} steps={runSteps} nodes={runActivityNodes} explaining={explaining} onAnswer={answerQuestion} onExplain={explainAnswer} onOpenInStudio={openArtifactInStudio} />
            // The run is still being started, so the dots stand in for the
            // assistant block that is about to exist.
            : runStarting && runBelongsToSelectedChat && <div className="mock-run"><section className="message assistant-message"><div className="message-content">
              <TypingIndicator done={false} />
            </div></section></div>}
        </div></div>

        <div className="composer-dock">
          {pendingApproval && <div className="approval-dock"><ApprovalCard pending={pendingApproval} onApprove={() => answerApproval("approved")} onReject={() => answerApproval("rejected")} /></div>}
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
            {thinking && <div className="composer-status" role="status"><Loader2 size={13} /><span>Thinking…</span></div>}
            {/* A disabled composer with no reason reads as a broken one. This
                says where the run is and offers the two things that can be done
                about it from here: go to it, or stop it. */}
            {runElsewhere && <div className={`composer-status run-elsewhere${runNeedsInput ? " needs-input" : ""}`} role="status">
              {runNeedsInput ? <CircleDot size={13} /> : <Loader2 size={13} />}
              <span>{runNeedsInput ? "Roqer needs your answer in" : "Roqer is working in"} <strong>{runChat?.title ?? "another chat"}</strong></span>
              {runLocation && <button onClick={() => selectChat(runLocation.projectId, runLocation.chatId)}>Open</button>}
              <button onClick={stopRun}>Stop</button>
            </div>}
            {draggingImage && <div className="composer-drop-hint">Drop an image to attach it</div>}
            {attachmentError && <div className="attachment-notice" role="alert">{attachmentError}<button onClick={() => setAttachmentError(null)} aria-label="Dismiss attachment error"><X size={14} /></button></div>}
            {attachments.length > 0 && <div className="attachment-row">{attachments.map((attachment) => <div className="attachment-chip" key={attachment.id}>{attachment.thumbnailDataUrl ? <img className="attachment-thumbnail" src={attachment.thumbnailDataUrl} alt="" /> : <FileBox size={16} />}<div><strong>{attachment.name}</strong><span>{formatBytes(attachment.size)} · {attachmentDetail(attachment, imagesReachModel)}</span></div><button onClick={() => { void releaseAttachments([attachment.id]); setAttachments((current) => current.filter((item) => item.id !== attachment.id)); }} aria-label={`Remove ${attachment.name}`}><X size={14} /></button></div>)}</div>}
            <textarea ref={composerRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendPrompt(); }} onPaste={(event) => {
              const images = droppedImages(event.clipboardData?.files);
              if (images.length === 0) return;
              event.preventDefault();
              void attachImages(images);
            }} placeholder={runElsewhere ? "Roqer is busy in another chat" : explaining ? "Your answer, in your own words" : steering ? "Add a note — Roqer reads it at its next step" : "Describe what you want to build or change…"} aria-label="Message" disabled={isRunning && !steering} />
            <div className="composer-toolbar">
              {/* A note carries words only; a picture cannot be attached to a
                  turn that is already in progress. */}
              <button className="attach-button" onClick={() => void attachAsset()} title="Attach an asset pack" disabled={isRunning}><Paperclip size={18} /></button><div className="toolbar-divider" />
              {showProviderChoice && <ComposerSelect className="compact provider-control" label="Provider" value={provider} options={availableProviderOptions} icon={<Bot size={15} />} title={PROVIDER_TITLES[provider]} disabled={isRunning} showChevron onChange={(value) => updatePreferences({ provider: value as ProviderId })} />}
              <ComposerSelect className="model-control" label="Model selector" value={selectedModel?.id ?? ""} options={modelOptions} icon={<Sparkles size={15} />} title={modelCatalog.message ?? providerStatus.message} disabled={isRunning || providerStatus.kind !== "signed-in" || !selectedModel} showChevron onChange={(value) => {
                const model = modelCatalog.models.find((candidate) => candidate.id === value);
                if (!model) return;
                const effort = model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === workspace.preferences.reasoningEffort)
                  ? workspace.preferences.reasoningEffort
                  : model.defaultReasoningEffort;
                updatePreferences({ ...modelPreference(provider, model.id), reasoningEffort: effort });
              }} />
              <ComposerSelect className="compact effort-control" label="Effort" value={workspace.preferences.reasoningEffort} options={effortOptions} title={selectedModel ? `${selectedModel.displayName} reasoning effort` : "Reasoning effort"} disabled={isRunning || !selectedModel} showChevron onChange={(value) => updatePreferences({ reasoningEffort: value as ReasoningEffort })} />
              <ComposerSelect className={`approval ${approvalMode === "Auto approve" ? "auto" : approvalMode === "Full auto" ? "full-auto" : ""}`} label="Approval mode" value={approvalMode} options={APPROVAL_OPTIONS} icon={<ShieldCheck size={15} />} disabled={isRunning} onChange={(value) => updatePreferences({ approvalMode: value as ApprovalMode })} />
              <button className={`playtest-toggle ${autoPlaytest ? "enabled" : ""}`} disabled={isRunning} onClick={() => updatePreferences({ autoPlaytest: !autoPlaytest })} aria-pressed={autoPlaytest}><Gamepad2 size={16} /><span className="playtest-label">Auto-playtest</span><span className="toggle-track"><span /></span></button>
              <div className="toolbar-spacer" />
              {showRunControls && <button className="send-button stop" onClick={stopRun} aria-label="Stop run"><CircleStop size={20} /></button>}
              {steering
                ? <button className="send-button" onClick={() => void sendSteer()} disabled={!composer.trim()} aria-label="Send note to the running task"><Send size={19} /></button>
                : !showRunControls && <button className="send-button" onClick={() => void sendPrompt()} disabled={!hydrated || !storageAvailable || storageRecovery.required || isRunning || !composer.trim() || (hasDesktopRuntime() && providerStatus.kind === "signed-in" && !selectedModel)} aria-label="Send message"><Send size={19} /></button>}
            </div>
          </div>
        </div>
      </main>

      {showSettings && <SettingsModal preferences={workspace.preferences} studioStatus={studioStatus} providerStatus={providerStatus} onPreferences={updatePreferences} onRefresh={() => void refreshStudioStatus()} onProviderRefresh={() => void refreshProviderStatus()} onCustomChanged={() => { void refreshProviderStatus(); void refreshProviderModels(); }} onProviderLogin={connectProvider} onProviderCode={finishProviderLogin} onExport={() => void exportChats(storageRecovery.required ? undefined : workspace)} onClose={() => setShowSettings(false)} />}
      {renderDialog()}
      {!hydrated && <div className="loading-overlay"><div><span /><strong>Opening your workspace…</strong></div></div>}
    </div>
  );
}

function ComposerSelect({ className = "", label, value, options, icon, title, disabled = false, showChevron = false, onChange }: { className?: string; label: string; value: string; options: readonly SelectOption[]; icon?: React.ReactNode; title?: string; disabled?: boolean; showChevron?: boolean; onChange?: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusOption = useCallback((index: number) => {
    const nextIndex = (index + options.length) % options.length;
    setActiveIndex(nextIndex);
    window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  }, [options.length]);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || options.length < 2) return;
    const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
    setOpen(true);
    focusOption(selectedIndex);
  }, [disabled, focusOption, options, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [closeMenu, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (option: SelectOption) => {
    onChange?.(option.value);
    closeMenu(true);
  };

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); focusOption(activeIndex + 1); }
    if (event.key === "ArrowUp") { event.preventDefault(); focusOption(activeIndex - 1); }
    if (event.key === "Home") { event.preventDefault(); focusOption(0); }
    if (event.key === "End") { event.preventDefault(); focusOption(options.length - 1); }
    if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
  };

  const selected = options.find((option) => option.value === value) ?? options[0];
  return <div className={`select-control ${className} ${open ? "open" : ""} ${disabled ? "disabled" : ""}`} ref={rootRef}>
    <button className="select-trigger" type="button" ref={triggerRef} disabled={disabled} title={title ?? selected?.title} aria-label={`${label}: ${selected?.label ?? value}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => open ? closeMenu() : openMenu()} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(); } }}>
      {icon && <span className="select-leading">{icon}</span>}<span className="select-value">{selected?.label ?? value}</span>{(showChevron || options.length > 1) && <ChevronDown className="select-chevron" size={14} />}
    </button>
    {open && <div className="select-menu" role="listbox" aria-label={label}>
      {options.map((option, index) => <button className={`select-option ${option.value === value ? "selected" : ""}`} type="button" role="option" aria-selected={option.value === value} title={option.title} key={option.value} ref={(element) => { optionRefs.current[index] = element; }} onClick={() => choose(option)} onKeyDown={handleOptionKeyDown}><Check className="select-option-check" size={14} /><span className="select-option-label">{option.label}</span></button>)}
    </div>}
  </div>;
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
    {anchor && createPortal(
      <div className="row-menu" role="menu" aria-label={label} ref={menuRef} style={{ top: anchor.top, bottom: anchor.bottom, right: anchor.right }}>
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

const ConversationMessageView = memo(function ConversationMessageView({ message, latestRun, onOpenInStudio }: {
  message: ChatMessage;
  /** Whether this is the newest reply that came from a run; only its diffs open by default. */
  latestRun: boolean;
  onOpenInStudio: OpenInStudio;
}) {
  return message.role === "user" ? (
    <section className="message user-message" key={message.id}>
      <p className="user-prompt">{message.text}</p>
      {message.attachments && message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((asset) => asset.thumbnailDataUrl
        ? <img key={asset.id} className="message-attachment-image" src={asset.thumbnailDataUrl} alt={`Attached image: ${asset.name}`} title={asset.name} />
        : <span key={asset.id}><FileBox size={13} />{asset.name}</span>)}</div>}
    </section>
  ) : (
    <section className="message assistant-message" key={message.id}><div className="message-content">
      {message.run
        ? <RunRecordView record={message.run} text={message.text} latest={latestRun} onOpenInStudio={onOpenInStudio} />
        : <Markdown text={message.text} className="result-copy" />}
    </div></section>
  );
});

const ConversationMessages = memo(function ConversationMessages({ messages, onOpenInStudio }: {
  messages: ChatMessage[];
  onOpenInStudio: OpenInStudio;
}) {
  // The component is keyed by chat, so this index belongs to one transcript.
  // Appended messages leave it untouched and remain visible at the bottom.
  const [visibleFrom, setVisibleFrom] = useState(() => initialConversationWindowStart(messages.length));
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
      <ConversationMessageView key={message.id} message={message} latestRun={message.id === latestRunId} onOpenInStudio={onOpenInStudio} />
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

function EmptyConversation({ onSuggestion }: { onSuggestion: (value: string) => void }) {
  return <div className="empty-conversation"><div className="empty-illustration"><Sparkles size={27} /></div><h1>Explore your place</h1><p>Ask about the connected place, its scripts, or project structure.</p><div className="suggestion-grid">{SUGGESTIONS.map((suggestion) => <button key={suggestion} onClick={() => onSuggestion(suggestion)}><Zap size={15} />{suggestion}</button>)}</div></div>;
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
function providerIsThinking(view: RunView, nodes: readonly ActivityNode[]): boolean {
  if (view.outcome !== null) return false;
  if (view.pendingApproval !== null || view.pendingQuestion !== null) return false;
  return !nodes.some((node) => node.status === "active");
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
 * the provider stops being the thing that is working, so a tool call or an
 * approval resets it and the number always means "how long has it been quiet".
 *
 * Deliberately not a live region. The composer already announces "Thinking…",
 * and one announcement is enough.
 */
function WaitingNotice({ label, detail }: { label: string; detail?: string }) {
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
    </p>
    {detail !== undefined && detail !== "" && <p className="waiting-detail">{detail}</p>}
    {elapsedMs >= WAITING_REASSURANCE_AFTER_MS && <p className="waiting-detail">
      Some models work for a minute or more before their first word.
    </p>}
  </div>;
}

function LiveRun({ view, steps, nodes, explaining, onAnswer, onExplain, onOpenInStudio }: { view: RunView; steps: ActivityStep[]; nodes: ActivityNode[]; explaining: boolean; onAnswer: (index: number) => void; onExplain: () => void; onOpenInStudio: OpenInStudio }) {
  const answered = view.text.trim() !== "";
  const running = view.outcome === null;
  const appliedAndVerified = runAppliedAndVerified(view);
  // Anything the run has put on screen retires the dots: a plan, an activity
  // row, a question to answer, or the first words of the reply.
  const produced = view.tasks.length > 0 || steps.length > 0 || answered || view.pendingQuestion !== null;
  // The same rule the composer's spinner uses, so the two can never disagree
  // about who is working. A run waiting on Studio or on the user is not
  // thinking, and both of those already say so elsewhere.
  const thinking = running && providerIsThinking(view, nodes);
  return <div className="mock-run"><section className="message assistant-message"><div className="message-content">
    {view.planner === DEMO_PLANNER && <p className="run-tag"><span className="run-badge">Demo</span></p>}
    {running && <TypingIndicator done={produced} />}
    {thinking && <WaitingNotice
      // Every turn opens with a progress label, so this is normally the
      // planner's own words; the fallback is for a planner that sends none.
      label={view.status?.label ?? "Working"}
      {...(view.status?.detail === undefined ? {} : { detail: view.status.detail })}
    />}
    {view.pendingQuestion && <QuestionCard question={view.pendingQuestion} explaining={explaining} onAnswer={onAnswer} onExplain={onExplain} />}
    <TaskList tasks={view.tasks} />
    <ActivitySection steps={steps} nodes={nodes} running={running} />
    <ChangeSet changes={view.changes} onOpenInStudio={onOpenInStudio} />
    {answered && (running
      // Parsing the whole growing document for every provider delta makes a
      // long reply quadratic. Preserve the text while streaming, then render
      // its Markdown once the completed message moves into history.
      ? <div className="markdown result-copy streaming-copy"><p>{view.text}</p></div>
      : <Markdown text={view.text} className="result-copy" />)}
    {appliedAndVerified && <AppliedStatus />}
    {view.outcome !== null && !appliedAndVerified && !runOnlyAnswered(view) && <OutcomeCard
      outcome={view.outcome}
      warnings={runHasWarnings(view)}
      // Once the answer is on screen, repeating it on the card says nothing.
      summary={view.outcome === "completed" && answered ? runFacts(view) : view.summary}
      note={failureNote(view.failures.length)}
      issues={runGateIssues(view)}
    />}
    {view.desynchronized && <p className="run-warning"><AlertCircle size={14} /> Some updates were missed, so this timeline may be incomplete.</p>}
  </div></section></div>;
}

/** One line of counts describing what a run actually did. */
function countLine(calls: number, changes: number, failed: number): string {
  const parts = [`${calls} ${calls === 1 ? "tool call" : "tool calls"}`];
  if (changes > 0) parts.push(`${changes} ${changes === 1 ? "change" : "changes"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

function runFacts(view: RunView): string {
  const finished = view.activities.filter((activity) => activity.state === "done" || activity.state === "failed");
  return countLine(finished.length, view.changes.length, finished.filter((activity) => activity.state === "failed").length);
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
    <span className="node-finding">{node.finding ?? ""}</span>
  </>;
}

/**
 * Everything about a step that only matters when something looks wrong: the
 * operation the agent actually called, the full instance path, what it cost,
 * and the payload that came back.
 */
function StepDetails({ step }: { step: ActivityStep }) {
  if (step.tool === undefined) return null;
  const entries: RunMetadata[] = [{ label: "Operation", value: step.tool }];
  if (step.target) entries.push({ label: "Target", value: step.target });
  if (step.durationMs !== undefined) entries.push({ label: "Duration", value: formatDuration(step.durationMs) });
  if (step.resultSummary) entries.push({ label: "Result", value: step.resultSummary });
  return <CardDetails label="Details">
    <MetadataList entries={entries} />
    {step.detail && <pre className="tool-output"><code>{step.detail}</code></pre>}
  </CardDetails>;
}

/** One operation, with its raw account of itself behind a disclosure. */
function ActivityLeaf({ node }: { node: ActivityNode }) {
  return <li className="activity-node">
    <div className="node-row" data-status={node.status} data-kind={node.kind}><span className="node-caret" /><NodeLine node={node} /></div>
    {node.step && <StepDetails step={node.step} />}
    {node.step?.evidence && <EvidenceDetail evidence={node.step.evidence} />}
  </li>;
}

/**
 * A phase of the run, folded to one line.
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
function EvidenceDetail({ evidence }: { evidence: RunEvidence }) {
  const lines = evidence.lines ?? [];
  const metadata = evidence.metadata ?? [];
  if (!evidence.detail && lines.length === 0 && metadata.length === 0 && !evidence.imageDataUrl) return null;
  return <CardDetails label={evidenceDetailLabel(evidence.kind)}>
    {evidence.detail && <p className="evidence-note">{evidence.detail}</p>}
    {evidence.imageDataUrl && <img className="evidence-image" src={evidence.imageDataUrl} alt={evidence.title} />}
    {lines.length > 0 && (evidence.format === "code"
      // A source read-back is verbatim: indentation and blank lines are part of
      // what is being shown, so it is a code block, not a list of strings.
      ? <pre className="evidence-code"><code>{lines.join("\n")}</code></pre>
      : <ul className="evidence-lines">{lines.map((line, index) => <li key={`${evidence.id}-${index}`}>{line}</li>)}</ul>)}
    {metadata.length > 0 && <MetadataList entries={metadata} />}
  </CardDetails>;
}

/**
 * The activity layer: everything the agent did, in one place, out of the way.
 *
 * Closed until the reader opens it, and it never opens or closes itself. A
 * project inspection is forty rows; unrolling that over the answer while the
 * run works, then rolling it back up the moment the run ends, moves the page
 * under the reader twice for something they did not ask to see. So the section
 * holds one line instead — the operation in flight, or the last one finished —
 * with the step and failure counts beside it, and the whole list one click
 * away. Nothing is removed and nothing is decided for the reader.
 *
 * A failure is the exception to putting things away: it stays listed under the
 * closed section, the way a folded phase keeps its own alerts on screen, since
 * nothing else on the page would report it.
 */
/**
 * Memoised, with the change set and the task list below, because these are
 * what a live run re-renders for every streamed token otherwise. Their inputs
 * only change when an event of their own kind arrives, so between those a
 * delta reconciles the streaming paragraph and nothing else.
 */
const ActivitySection = memo(function ActivitySection({ steps, nodes, running }: { steps: ActivityStep[]; nodes?: ActivityNode[]; running: boolean }) {
  // Which groups the reader has opened or closed by hand. Without it, the next
  // event would re-assert the default and shut a group under their cursor.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const resolvedNodes = useMemo(() => nodes ?? buildActivityModel(steps), [nodes, steps]);
  const onToggle = useCallback((key: string, open: boolean) => {
    setExpanded((current) => (current[key] === open ? current : { ...current, [key]: open }));
  }, []);
  if (steps.length === 0) return null;

  const failed = steps.filter((step) => step.state === "failed").length;
  // Notes are commentary on the run, not things it did, so they are not counted.
  const actions = steps.filter((step) => step.kind !== "note").length;
  const counted = `${actions} ${actions === 1 ? "step" : "steps"}${failed > 0 ? ` · ${failed} failed` : ""}`;
  const current = currentNodeTitle(resolvedNodes);
  // Failures only. A step waiting on a decision has the approval card above the
  // composer, and repeating it here says the same thing twice.
  const alerts = resolvedNodes
    .flatMap((node) => (node.children.length === 0 ? [node] : node.alerts))
    .filter((node) => node.status === "failed")
    .slice(0, MAX_VISIBLE_ALERTS);
  return <>
    <details className="activity-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={14} />
        <strong>Activity</strong>
        <span className="activity-summary">{current ?? counted}</span>
        {current !== null && <span className="activity-count">{counted}</span>}
        {running && <span className="working-label"><i /></span>}
      </summary>
      {/* The rows exist only while the section is open. A closed details
          element hides its children but still has them built, and a chat of
          old runs holds thousands. */}
      {open && <ol className="activity-timeline">
        {resolvedNodes.map((node) => (node.children.length === 0
          ? <ActivityLeaf key={node.key} node={node} />
          : <ActivityGroup
            key={node.key}
            node={node}
            open={expanded[node.key] ?? node.status === "active"}
            onToggle={onToggle}
          />))}
      </ol>}
    </details>
    {!open && alerts.length > 0 && <ul className="group-alerts section-alerts">
      {alerts.map((alert) => <li key={alert.key} className="node-row" data-status={alert.status} data-kind={alert.kind}>
        <span className="node-caret" /><NodeLine node={alert} />
      </li>)}
    </ul>}
  </>;
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
 */
function CodeSurface({ rows, language, label }: { rows: DiffRow[]; language?: string; label: string }) {
  const tokens = useMemo(() => highlightRows(rows, language), [rows, language]);
  const style = { "--gutter": gutterWidth(rows) } as CSSProperties;

  return <div className="code-surface" role="region" aria-label={label}>
    <div className="code-lines" style={style}>
      {rows.map((row, index) => {
        if (row.kind === "collapse" || row.kind === "truncated") {
          return <div className={`code-fold${row.kind === "truncated" ? " code-fold-cut" : ""}`} key={index}>
            <span className="code-fold-body">
              <span className="code-fold-mark" aria-hidden="true">⋯</span>
              <span>{row.text}</span>
              {row.hidden && <span className="code-fold-range">{row.hidden.newFrom}–{row.hidden.newTo}</span>}
            </span>
          </div>;
        }
        const number = lineNumber(row);
        return <div className={`code-line code-${row.kind}`} key={index}>
          <span className="code-gutter" aria-hidden="true" title={number.title}>{number.text}</span>
          <span className="code-sign" aria-hidden="true">{row.marker === " " ? "" : row.marker}</span>
          <code className="code-text"><CodeTokens tokens={tokens[index]} /></code>
        </div>;
      })}
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

function ArtifactCard({ group, defaultExpanded = true, onOpenInStudio }: { group: ChangeGroup; defaultExpanded?: boolean; onOpenInStudio: OpenInStudio }) {
  const { changes } = group;
  const bodyId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
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
  const [openState, setOpenState] = useState<{ kind: "idle" | "opening" | "opened" | "error"; message?: string }>({ kind: "idle" });
  const revisions: RunMetadata[] = [
    ...(revisionBefore ? [{ label: "Revision before", value: revisionBefore }] : []),
    ...(revisionAfter ? [{ label: "Revision after", value: revisionAfter }] : []),
  ];
  const openScript = async () => {
    if (!scriptChange || openState.kind === "opening") return;
    setOpenState({ kind: "opening" });
    const result = await onOpenInStudio(group.target, scriptChange.instanceId);
    setOpenState({ kind: result.ok ? "opened" : "error", message: result.message });
  };
  return <article className="diff-artifact">
    <div className="diff-header">
      <div className="diff-file">{assetChange ? <FileBox size={14} /> : <FileCode2 size={14} />}<code title={group.target}>{group.target}</code></div>
      <div className="diff-actions">
        {scriptChange && <button className={`open-studio-action state-${openState.kind}`} type="button" onClick={() => void openScript()} disabled={openState.kind === "opening"} title={openState.message ?? "Open this script in Roblox Studio"}>
          {openState.kind === "opened" ? <Check size={13} /> : openState.kind === "error" ? <AlertCircle size={13} /> : <ExternalLink size={13} />}
          <span>{openState.kind === "opening" ? "Opening…" : openState.kind === "opened" ? "Opened" : openState.kind === "error" ? "Try again" : "Open in Studio"}</span>
        </button>}
        {earlier.length > 0
          ? <div className="diff-writes" title={`This run wrote this file ${changes.length} times`}>{changes.length} writes</div>
          : (added > 0 || removed > 0) && <div className="diff-summary" aria-label={`${added} lines added, ${removed} lines removed`}>
            {added > 0 && <span className="added">+{added}</span>}
            {removed > 0 && <span className="removed">−{removed}</span>}
          </div>}
        <button className="diff-collapse" type="button" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} title={expanded ? "Collapse this file" : "Expand this file"} onClick={() => setExpanded((open) => !open)}>
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
    {revisions.length > 0 && <CardDetails label="Revision details"><MetadataList entries={revisions} /></CardDetails>}
  </article>;
}

/** Memoised: see `ActivitySection`. The diffs are the bulk of a live run's DOM. */
const ChangeSet = memo(function ChangeSet({ changes, collapsed = false, onOpenInStudio }: { changes: RunChange[]; collapsed?: boolean; onOpenInStudio: OpenInStudio }) {
  const groups = useMemo(() => groupChangesByTarget(changes), [changes]);
  if (groups.length === 0) return null;
  return <section className="change-set" aria-label="Changed files">
    {groups.map((group) => <ArtifactCard key={group.target} group={group} defaultExpanded={!collapsed} onOpenInStudio={onOpenInStudio} />)}
  </section>;
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
function OutcomeCard({ outcome, summary, note, warnings = false, issues = [] }: { outcome: RunOutcome; summary: string; note: string; warnings?: boolean; issues?: string[] }) {
  const label = describeOutcome(outcome, warnings);
  return <div className={`completed-run-card outcome-${outcome} ${warnings ? "outcome-warnings" : ""}`}>
    <div className="completion-mark">{outcome === "completed" && !warnings ? <Check size={22} /> : <AlertCircle size={22} />}</div>
    <div>
      <strong>{label}</strong>
      <p>{summary}</p>
      {issues.length > 0 && <ul className="gate-issues">
        {issues.map((issue, index) => <li key={index}>{issue}</li>)}
      </ul>}
    </div>
    <span>{note || label}</span>
  </div>;
}

const TASK_ICON: Record<RunTaskStatus, React.ReactNode> = {
  pending: <Circle size={13} />,
  active: <CircleDot size={13} />,
  done: <Check size={13} />,
  blocked: <AlertCircle size={13} />,
};

/**
 * What the agent said it would do, above what it actually did.
 *
 * A task that declared it needs runtime evidence is marked, because that is the
 * promise the completion gate will hold the run to, and seeing it beforehand is
 * what makes the caveat at the end legible instead of surprising.
 */
const TaskList = memo(function TaskList({ tasks }: { tasks: readonly RunTask[] }) {
  if (tasks.length === 0) return null;
  return <div className="task-list">
    <div className="task-list-heading">
      <ListChecks size={14} /><strong>Plan</strong><span>{summarizeTasks(tasks)}</span>
    </div>
    <ul>{tasks.map((task) => <li key={task.id} className={`task-row task-${task.status}`}>
      {TASK_ICON[task.status]}
      <span className="task-title">{task.title}</span>
      {task.requiresRuntimeEvidence && (
        <em
          className="task-flag"
          title={`Needs ${(task.requiredEvidence ?? ["runtime"]).join(", ")} evidence to be called done`}
        >
          {(task.requiredEvidence ?? ["runtime"]).join("/")}
        </em>
      )}
    </li>)}</ul>
  </div>;
});

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
 * Only the latest run's diffs open by default. Earlier ones keep their header
 * -- the file, the line counts, Open in Studio -- and mount their lines when
 * asked, because opening a chat used to build every line of every past diff
 * before it could draw a frame: half a second for a modest chat, over a second
 * for a long one, on every switch.
 */
function RunRecordView({ record, text, latest, onOpenInStudio }: { record: RunRecord; text: string; latest: boolean; onOpenInStudio: OpenInStudio }) {
  const warnings = recordHasWarnings(record);
  const failed = record.toolCalls.filter((call) => !call.ok).length;
  const appliedAndVerified = recordAppliedAndVerified(record);
  const steps = useMemo(() => recordSteps(record), [record]);
  return <>
    <TaskList tasks={record.tasks ?? []} />
    <ActivitySection steps={steps} running={false} />
    <ChangeSet changes={record.changes} collapsed={!latest} onOpenInStudio={onOpenInStudio} />
    <Markdown text={text} className="result-copy" />
    {appliedAndVerified && <AppliedStatus />}
    {!appliedAndVerified && !recordOnlyAnswered(record, text) && <OutcomeCard
      outcome={record.outcome}
      warnings={warnings}
      summary={countLine(record.toolCalls.length, record.changes.length, failed)}
      note={record.planner === DEMO_PLANNER ? "Demo" : record.approvalMode}
      issues={recordGateIssues(record)}
    />}
  </>;
}

function SettingsModal({ preferences, studioStatus, providerStatus, onPreferences, onRefresh, onProviderRefresh, onCustomChanged, onProviderLogin, onProviderCode, onExport, onClose }: {
  preferences: WorkspaceState["preferences"];
  studioStatus: StudioStatus;
  providerStatus: ProviderStatus;
  onPreferences: (changes: Partial<WorkspaceState["preferences"]>) => void;
  onRefresh: () => void;
  onProviderRefresh: () => void;
  /** A custom connection was added, edited, or removed. */
  onCustomChanged: () => void;
  onProviderLogin: () => Promise<{ ok: boolean; message: string; awaitingCode?: boolean }>;
  onProviderCode: (code: string) => Promise<{ ok: boolean; message: string }>;
  onExport: () => void;
  onClose: () => void;
}) {
  const [loginPending, setLoginPending] = useState(false);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const providerName = providerLabel(preferences.provider);
  const availableProviderOptions = providerOptions();
  const closeSettings = onClose;

  // A half-finished sign-in belongs to the provider it was started for.
  useEffect(() => {
    setAwaitingCode(false);
    setCode("");
    setCodeError(null);
  }, [preferences.provider]);

  const startLogin = async () => {
    setLoginPending(true);
    setCodeError(null);
    const result = await onProviderLogin();
    setAwaitingCode(result.ok && result.awaitingCode === true);
    setLoginPending(false);
    return result;
  };

  const finishLogin = async () => {
    setLoginPending(true);
    const result = await onProviderCode(code);
    setLoginPending(false);
    if (result.ok) {
      setAwaitingCode(false);
      setCode("");
      setCodeError(null);
    } else {
      setCodeError(result.message);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={closeSettings}><div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header settings-header"><div><h2>Settings</h2></div><button className="icon-button" onClick={closeSettings} aria-label="Close settings"><X size={19} /></button></div>
    <SettingsSection title="Models">
      {availableProviderOptions.length > 1 && <div className="settings-row"><div className="settings-icon"><Bot size={17} /></div><div><strong>Provider</strong><span>{PROVIDER_TITLES[preferences.provider]}</span></div><select className="small-button" aria-label="Provider" value={preferences.provider} onChange={(event) => onPreferences({ provider: event.target.value as ProviderId })}>{availableProviderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>}
      {/* A vendor sign-in only: a custom model is set up in the rows below. */}
      {preferences.provider !== "custom" && <>
        <div className="settings-row"><div className={`settings-icon ${providerStatus.kind === "signed-in" ? "green" : ""}`}><Sparkles size={17} /></div><div><strong>{providerName}</strong><span>{providerStatus.kind === "signed-in" ? providerStatus.email ?? providerStatus.message : providerStatus.message}</span></div>{providerStatus.kind === "signed-in"
          ? <button className="small-button" onClick={onProviderRefresh}>{providerStatus.planType ?? "Connected"}</button>
          : <button className="small-button" disabled={loginPending || providerStatus.kind === "checking"} onClick={() => void startLogin()}>{loginPending ? "Opening…" : "Connect"}</button>}</div>
        {awaitingCode && providerStatus.kind !== "signed-in" && <label className="endpoint-setting">
          <span>{`Paste the code ${providerName} showed you`}</span>
          <input value={code} autoFocus spellCheck={false} placeholder="Authorization code" onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && code.trim()) void finishLogin(); }} />
          <button className="small-button" disabled={loginPending || !code.trim()} onClick={() => void finishLogin()}>{loginPending ? "Finishing…" : "Finish sign-in"}</button>
          {codeError && <span className="status-text">{codeError}</span>}
        </label>}
      </>}
      <CustomConnectionsSettings onChanged={onCustomChanged} />
    </SettingsSection>
    <SettingsSection title="Roblox">
      <div className="settings-row"><div className={`settings-icon ${studioStatus.kind === "connected" ? "green" : ""}`}><Gamepad2 size={17} /></div><div><strong>Roblox Studio</strong><span>{studioStatus.message}</span></div><button className="small-button" onClick={onRefresh}>Check</button></div>
      <OpenCloudSettings />
    </SettingsSection>
    <SettingsSection title="Modeling">
      <BlenderSettingsRow />
    </SettingsSection>
    <SettingsSection title="App">
      <div className="settings-row"><div className={`settings-icon ${preferences.discordPresence ? "green" : ""}`}><MessageSquare size={17} /></div><div><strong>Show Roqer on Discord</strong><span>Your profile shows that Roqer is open and whether it is busy. Never your place, scripts, or tasks.</span></div><SettingsSwitch label="Show Roqer on Discord" checked={preferences.discordPresence} onChange={(discordPresence) => onPreferences({ discordPresence })} /></div>
      <div className="settings-row"><div className="settings-icon"><HardDrive size={17} /></div><div><strong>Local project data</strong><span>Chats and settings stay on this device</span></div><button className="small-button" onClick={onExport}><Download size={15} /> Export chats</button></div>
      {/* Only someone running their own bridge needs this, so it stays folded
          away rather than sitting among the settings everybody reads. */}
      <details className="settings-advanced">
        <summary>Advanced</summary>
        <label className="endpoint-setting"><span>MCP endpoint</span><input value={preferences.mcpEndpoint} onChange={(event) => onPreferences({ mcpEndpoint: event.target.value })} spellCheck={false} /></label>
      </details>
    </SettingsSection>
  </div></div>;
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

function relativeTime(value: string): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function failureNote(count: number): string {
  if (count === 0) return "";
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

function statusLabel(kind: StudioStatus["kind"]): string {
  if (kind === "connected") return "Healthy";
  if (kind === "bridge-only") return "MCP available";
  if (kind === "checking") return "Checking";
  return "Offline";
}

export default App;
