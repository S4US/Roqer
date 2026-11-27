import { isRunRecord, withoutMalformedUsage, type RunRecord } from "../shared/run-events";
import { isPersistedAttachment } from "../shared/workspace-validation";
import type { AttachmentClip } from "../shared/reference-clip";
import { isStudioSelection, type StudioSelection } from "../shared/studio-selection";
import {
  DEFAULT_PROVIDER_ID,
  enabledProviderOr,
  isEnabledProvider,
  isReasoningEffort,
  type ProviderId,
  type ReasoningEffort,
} from "../shared/provider";

export type Theme = "light" | "dark";

// Re-exported so renderer modules keep importing it from here, while the one
// definition lives next to the policy rules that consume it.
export type { ApprovalMode } from "../shared/policy";
import type { ApprovalMode } from "../shared/policy";
import { isChatCompaction, type ChatCompaction } from "../shared/chat-compaction";
import { isProjectInstructions, normalizeProjectInstructions } from "../shared/project-instructions";

export type AssetAttachment = {
  id: string;
  name: string;
  path?: string;
  size: number;
  addedAt: string;
  /** Set when the attachment is a picture the model can actually look at. */
  mediaType?: string;
  /**
   * A small preview kept with the chat, as a data URL.
   *
   * The full-resolution image is sent to the model for the run it was attached
   * to and then released; this is what remains, so that a message asking about
   * a screenshot still shows the screenshot when the chat is reopened.
   */
  thumbnailDataUrl?: string;
  /**
   * Set for a video or an animated picture, which reaches the model as
   * frames: the part the user chose, and once Roqer has read them, the id
   * its frames are kept under for the chat.
   */
  clip?: AttachmentClip;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: AssetAttachment[];
  /** Compacted record of the agent run that produced this message. */
  run?: RunRecord;
  /** A note the user sent while a run was working, rather than a prompt that started one. */
  note?: true;
  /**
   * The Studio selection Roqer read when this message was sent and told the
   * model about. What was actually sent, which the composer's chip may not
   * have shown; absent when nothing was selected or the chip was dismissed.
   */
  studioSelection?: StudioSelection;
};

export type Chat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * True once the user has named the chat themselves.
   *
   * A chat is otherwise titled from its first message, which would silently
   * throw away a name typed before that message was sent.
   */
  titleSetByUser?: boolean;
  /**
   * The Studio place this chat works in, chosen by the user.
   *
   * Absent means nothing was chosen for this chat, which falls back to the
   * workspace preference — the last place picked anywhere — so a new chat about
   * the same game does not have to be pointed at it again.
   */
  studioInstanceId?: string;
  /**
   * The reasoning effort this chat's runs ask for, chosen in this chat.
   *
   * Absent means the chat has never had one of its own, which falls back to
   * the workspace preference. A chat without one is given the preference's
   * value before the preference changes (`setDefaultReasoningEffort`), so a
   * choice made in one chat never changes the effort of another.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * The provider and model this chat's runs use, chosen in this chat. Absent
   * means the chat follows the workspace preference; like the effort, a chat
   * without one is given the preference's value before the preference changes
   * (`setDefaultModel`), so choosing a model in one chat never changes another.
   */
  model?: ChatModel;
  /**
   * True while the chat holds a reply nobody has seen: its run ended while
   * another chat was open, or while Roqer was not the window in use. Opening
   * the chat clears it.
   */
  unread?: boolean;
  messages: ChatMessage[];
  /**
   * The chat's earlier messages, folded into a record by a manual compact. Only
   * the model's view changes: every message stays on screen.
   */
  compaction?: ChatCompaction;
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Standing instructions the user wrote for every chat in this project, sent
   * to the model with each run (see `shared/project-instructions.ts`). Absent
   * when there are none; never an empty string.
   */
  instructions?: string;
  chats: Chat[];
};

export type Preferences = {
  theme: Theme;
  approvalMode: ApprovalMode;
  autoPlaytest: boolean;
  /**
   * Whether runs may search the web through the provider's own search. Off by
   * default: a page is text the user never wrote, and a search sends the
   * model's words out of the machine.
   */
  webSearch: boolean;
  mcpEndpoint: string;
  /**
   * The Studio place runs go to, or `null` to use whichever connected first.
   *
   * Remembered because the alternative — the bridge's connection order — is
   * arbitrary from the customer's side, and with two places open it decides
   * which one gets edited.
   */
  studioInstanceId: string | null;
  /**
   * Whether Roqer appears in the user's Discord profile while it is open.
   *
   * On by default, because a presence entry is how most people will first hear
   * of this and because "Playing X" is a broadcast Discord users already
   * understand. What it publishes is deliberately only that Roqer is open and
   * whether it is busy — never a place, a script, or a task — so the default
   * announces the tool and never the work.
   */
  discordPresence: boolean;
  /**
   * Whether the composer shows what is selected in Studio and a sent message
   * carries it. Off, the window stops reading the selection and asks the main
   * process for none. Off by default: what the user has selected in Studio
   * reaches the model only once they choose to send it.
   */
  useStudioSelection: boolean;
  /**
   * Whether a run shows the model's reasoning while it thinks: the latest line
   * on the Thinking card, and the run's whole chain when the card is opened.
   * On by default. Display only: runs receive the reasoning either way, so
   * turning it on mid-run shows everything the run has thought so far.
   */
  showReasoning: boolean;
  /**
   * Whether a message is sent with Ctrl+Enter (Cmd+Enter on a Mac), leaving
   * Enter for a new line. On by default. Off, Enter sends and Shift+Enter
   * starts a new line; Ctrl+Enter still sends either way.
   */
  ctrlEnterToSend: boolean;
  /** Whether the community invite card was dismissed, leaving only its icon. */
  communityInviteDismissed: boolean;
  /** Which managed sign-in drives runs. */
  provider: ProviderId;
  /** Remembered per provider so switching back keeps the previous choice. */
  chatGptModelId: string | null;
  claudeModelId: string | null;
  antigravityModelId: string | null;
  /** A custom model, as `<connection id>:<model id>`. The connection itself lives in the main process. */
  customModelId: string | null;
  reasoningEffort: ReasoningEffort;
};

/** The model the user last chose for a provider, if any. */
export function selectedModelId(preferences: Preferences, provider: ProviderId): string | null {
  switch (provider) {
    case "chatgpt":
      return preferences.chatGptModelId;
    case "claude":
      return preferences.claudeModelId;
    case "antigravity":
      return preferences.antigravityModelId;
    case "custom":
      return preferences.customModelId;
  }
}

/** A preference patch that records a model choice against its own provider. */
export function modelPreference(provider: ProviderId, modelId: string): Partial<Preferences> {
  switch (provider) {
    case "chatgpt":
      return { chatGptModelId: modelId };
    case "claude":
      return { claudeModelId: modelId };
    case "antigravity":
      return { antigravityModelId: modelId };
    case "custom":
      return { customModelId: modelId };
  }
}

export type WorkspaceState = {
  schemaVersion: 3;
  selectedProjectId: string;
  selectedChatId: string | null;
  projects: Project[];
  preferences: Preferences;
};

export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:58741";

/**
 * Unattended is what the app is for.
 *
 * Confirming every action is the safer default in the abstract, but it is not
 * the product: someone who wanted to approve each edit would keep making the
 * edits themselves. Starting in `Ask first` shows a new user a slow, interrupted
 * version of Roqer and asks them to find the setting that makes it the thing
 * they came for. The modes that ask are one click away in the composer, and
 * `Full auto` still refuses any tool Roqer has not classified.
 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "Full auto";

export function createId(prefix: string): string {
  const value = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export const DEFAULT_PROJECT_ID = "default";

/**
 * A first-run workspace: one empty project and nothing else.
 *
 * This deliberately seeds no chats or messages. Invented conversations showing
 * work the app has not done are indistinguishable from real history once they
 * are saved to disk, so the workspace starts empty and everything in it is
 * something the user or a real run produced.
 */
export function createInitialWorkspace(theme: Theme = "dark"): WorkspaceState {
  const now = new Date().toISOString();

  return {
    schemaVersion: 3,
    selectedProjectId: DEFAULT_PROJECT_ID,
    selectedChatId: null,
    projects: [
      {
        id: DEFAULT_PROJECT_ID,
        name: "Default",
        createdAt: now,
        updatedAt: now,
        chats: [],
      },
    ],
    preferences: {
      theme,
      approvalMode: DEFAULT_APPROVAL_MODE,
      autoPlaytest: true,
      webSearch: false,
      mcpEndpoint: DEFAULT_MCP_ENDPOINT,
      studioInstanceId: null,
      discordPresence: true,
      useStudioSelection: false,
      showReasoning: true,
      ctrlEnterToSend: true,
      communityInviteDismissed: false,
      provider: DEFAULT_PROVIDER_ID,
      chatGptModelId: null,
      claudeModelId: null,
      antigravityModelId: null,
      customModelId: null,
      reasoningEffort: "medium",
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "Ask first" || value === "Auto approve" || value === "Full auto" || value === "Read only";
}

function isAttachment(value: unknown): value is AssetAttachment {
  return isPersistedAttachment(value);
}

function isMessage(value: unknown): value is ChatMessage {
  return isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string" &&
    (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(isAttachment))) &&
    (value.run === undefined || isRunRecord(value.run)) &&
    (value.note === undefined || (value.note === true && value.role === "user")) &&
    (value.studioSelection === undefined || (value.role === "user" && isStudioSelection(value.studioSelection)));
}

/**
 * A damaged run record should cost the user the record, not the message it was
 * attached to, so it is stripped before the message itself is validated. A
 * damaged usage figure costs only itself, so it goes first.
 */
function normalizeMessage(value: unknown): ChatMessage[] {
  if (!isRecord(value)) return [];
  const run = withoutMalformedUsage(value.run);
  const withRun = run === undefined || isRunRecord(run)
    ? (run === value.run ? value : { ...value, run })
    : { ...value, run: undefined };
  // A damaged selection likewise costs only itself, never the words.
  const candidate = withRun.studioSelection === undefined || isStudioSelection(withRun.studioSelection)
    ? withRun
    : { ...withRun, studioSelection: undefined };
  return isMessage(candidate) ? [candidate] : [];
}

// Earlier builds shipped invented projects, chats, and one fabricated
// "change applied" conversation. Those were written to disk on first run, so
// removing them from the code is not enough — anyone who already opened the app
// still has them, and there is no way to delete a project from the interface.
const SEEDED_PROJECT_IDS = new Set(["coffee-run", "tycoon-v2"]);
const SEEDED_CHAT_IDS = new Set(["fireball", "shop-ui", "daily-login", "dropper", "rebirth"]);
const SEEDED_MESSAGE_IDS = new Set(["message-fireball-request", "message-fireball-result"]);

/**
 * Drop seeded content that the user never touched.
 *
 * Deliberately conservative: a seeded chat is removed only if every message in
 * it is also seeded, and a seeded project only if it has no chats left. A real
 * conversation started inside one of those projects keeps both the chat and its
 * project, because losing the user's own work would be far worse than leaving a
 * stale folder behind.
 */
function dropUntouchedSeedContent(projects: Project[]): Project[] {
  return projects.flatMap((project): Project[] => {
    const chats = project.chats.filter((chat) => {
      const seeded = SEEDED_CHAT_IDS.has(chat.id) &&
        chat.messages.every((message) => SEEDED_MESSAGE_IDS.has(message.id));
      return !seeded;
    });

    if (chats.length === 0 && SEEDED_PROJECT_IDS.has(project.id)) return [];
    return chats.length === project.chats.length ? [project] : [{ ...project, chats }];
  });
}

export function normalizeWorkspace(value: unknown, themeFallback: Theme = "dark"): WorkspaceState {
  const fallback = createInitialWorkspace(themeFallback);
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) || !Array.isArray(value.projects)) return fallback;

  const parsed = value.projects.flatMap((project): Project[] => {
    if (!isRecord(project) ||
      typeof project.id !== "string" ||
      typeof project.name !== "string" ||
      typeof project.createdAt !== "string" ||
      typeof project.updatedAt !== "string" ||
      !Array.isArray(project.chats)) return [];

    const chats = project.chats.flatMap((chat): Chat[] => {
      if (!isRecord(chat) ||
        typeof chat.id !== "string" ||
        typeof chat.title !== "string" ||
        typeof chat.createdAt !== "string" ||
        typeof chat.updatedAt !== "string" ||
        !Array.isArray(chat.messages)) return [];
      const messages = chat.messages.flatMap(normalizeMessage);
      // A compact that folds more messages than the chat holds is not a record
      // of this chat, so it is dropped and the chat is sent in full again.
      const compaction = isChatCompaction(chat.compaction) && chat.compaction.folded <= messages.length
        ? {
          folded: chat.compaction.folded,
          summary: chat.compaction.summary,
          ...(chat.compaction.usedTokens === undefined ? {} : {
            usedTokens: chat.compaction.usedTokens,
            windowTokens: chat.compaction.windowTokens ?? null,
          }),
        }
        : undefined;
      return [{
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        titleSetByUser: chat.titleSetByUser === true ? true : undefined,
        studioInstanceId: typeof chat.studioInstanceId === "string" && chat.studioInstanceId !== ""
          ? chat.studioInstanceId
          : undefined,
        // Additive: a chat saved before efforts were kept per chat has none,
        // and follows the workspace preference as it did then.
        ...(isReasoningEffort(chat.reasoningEffort) ? { reasoningEffort: chat.reasoningEffort } : {}),
        // A provider that can no longer run drops the choice, and the chat
        // follows the workspace preference again.
        ...(isChatModel(chat.model) ? { model: { provider: chat.model.provider, modelId: chat.model.modelId } } : {}),
        ...(chat.unread === true ? { unread: true } : {}),
        messages,
        ...(compaction === undefined ? {} : { compaction }),
      }];
    });

    return [{
      id: project.id,
      name: project.id === DEFAULT_PROJECT_ID && project.name === "DEFAULT" ? "Default" : project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      // Additive: a workspace saved before these existed has none. A damaged
      // value is caught by `malformedWorkspace` before it gets here.
      ...(isProjectInstructions(project.instructions) ? { instructions: project.instructions } : {}),
      chats,
    }];
  });

  const projects = dropUntouchedSeedContent(parsed);
  if (projects.length === 0) return fallback;

  const rawPreferences = isRecord(value.preferences) ? value.preferences : {};
  const preferences: Preferences = {
    theme: isTheme(rawPreferences.theme) ? rawPreferences.theme : themeFallback,
    approvalMode: isApprovalMode(rawPreferences.approvalMode) ? rawPreferences.approvalMode : DEFAULT_APPROVAL_MODE,
    autoPlaytest: typeof rawPreferences.autoPlaytest === "boolean" ? rawPreferences.autoPlaytest : true,
    // Off unless the user turned it on: a workspace saved before the switch
    // existed never agreed to send anything to a search engine.
    webSearch: rawPreferences.webSearch === true,
    mcpEndpoint: typeof rawPreferences.mcpEndpoint === "string" && rawPreferences.mcpEndpoint !== ""
      ? rawPreferences.mcpEndpoint
      : DEFAULT_MCP_ENDPOINT,
    // A remembered place that is not open right now is kept rather than
    // dropped: closing Studio for the evening is not a change of mind.
    studioInstanceId: typeof rawPreferences.studioInstanceId === "string" && rawPreferences.studioInstanceId !== ""
      ? rawPreferences.studioInstanceId
      : null,
    // A workspace saved before this existed comes back with it on, which is the
    // same answer a new install gets. Anyone who turned it off has the boolean
    // saved, so the default never overrides a decision that was actually made.
    discordPresence: typeof rawPreferences.discordPresence === "boolean" ? rawPreferences.discordPresence : true,
    // Off unless the user turned it on: a workspace saved before this existed
    // gets the same answer a new install does.
    useStudioSelection: rawPreferences.useStudioSelection === true,
    // On unless the user turned it off: a workspace saved before the switch
    // existed shows the reasoning, as a new install does.
    showReasoning: rawPreferences.showReasoning !== false,
    // On unless the user turned it off: a workspace saved before the switch
    // existed keeps sending the way it always did.
    ctrlEnterToSend: rawPreferences.ctrlEnterToSend !== false,
    // Additive: a workspace saved before the invite existed has not seen it,
    // so it is offered once to people who were already using Roqer too.
    communityInviteDismissed: rawPreferences.communityInviteDismissed === true,
    // A workspace saved while a vendor adapter was selectable still loads; it
    // simply comes back on the default rather than refusing to open or
    // resurrecting a provider that can no longer run.
    provider: enabledProviderOr(rawPreferences.provider),
    chatGptModelId: typeof rawPreferences.chatGptModelId === "string" && rawPreferences.chatGptModelId !== ""
      ? rawPreferences.chatGptModelId
      : null,
    claudeModelId: typeof rawPreferences.claudeModelId === "string" && rawPreferences.claudeModelId !== ""
      ? rawPreferences.claudeModelId
      : null,
    // Additive: a workspace saved before Antigravity was offered has none chosen.
    antigravityModelId: typeof rawPreferences.antigravityModelId === "string" && rawPreferences.antigravityModelId !== ""
      ? rawPreferences.antigravityModelId
      : null,
    // Additive: a workspace saved before custom models existed has none chosen.
    customModelId: typeof rawPreferences.customModelId === "string" && rawPreferences.customModelId !== ""
      ? rawPreferences.customModelId
      : null,
    reasoningEffort: isReasoningEffort(rawPreferences.reasoningEffort)
      ? rawPreferences.reasoningEffort
      : "medium",
  };

  const requestedProjectId = typeof value.selectedProjectId === "string" ? value.selectedProjectId : "";
  const selectedProject = projects.find((project) => project.id === requestedProjectId) ?? projects[0];
  const requestedChatId = typeof value.selectedChatId === "string" ? value.selectedChatId : null;
  const selectedChatId = selectedProject.chats.some((chat) => chat.id === requestedChatId)
    ? requestedChatId
    : selectedProject.chats[0]?.id ?? null;

  return {
    schemaVersion: 3,
    selectedProjectId: selectedProject.id,
    selectedChatId,
    projects,
    preferences,
  };
}

export function createProject(state: WorkspaceState, name: string): WorkspaceState {
  const now = new Date().toISOString();
  const project: Project = {
    id: createId("project"),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    chats: [],
  };
  return { ...state, projects: [...state.projects, project], selectedProjectId: project.id, selectedChatId: null };
}

const UNTITLED_CHAT = "Untitled chat";

export function createChat(state: WorkspaceState, projectId = state.selectedProjectId): WorkspaceState {
  const now = new Date().toISOString();
  const chat: Chat = {
    id: createId("chat"),
    title: UNTITLED_CHAT,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return {
    ...state,
    selectedProjectId: projectId,
    selectedChatId: chat.id,
    projects: state.projects.map((project) => project.id === projectId
      ? { ...project, updatedAt: now, chats: [chat, ...project.chats] }
      : project),
  };
}

/**
 * A project's chats as the sidebar lists them: the one worked in most recently
 * first, as each row's time already implied. They are kept on disk in the
 * order they were made, newest first, and sorted only when shown, so nothing
 * saved changes shape. Renaming leaves `updatedAt` alone, so it does not move
 * a chat.
 */
export function chatsByActivity<T extends Pick<Chat, "updatedAt">>(chats: readonly T[]): T[] {
  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return chats
    .map((chat, index) => ({ chat, index, at: time(chat.updatedAt) }))
    .sort((left, right) => right.at - left.at || left.index - right.index)
    .map(({ chat }) => chat);
}

/**
 * A selection that still points at something that exists.
 *
 * Deleting what is open has to leave the user somewhere, so the selection falls
 * back to the chat at the top of the selected project's list, and to the first
 * project when the selected one is gone. Keeping the repair in one place means
 * no delete can leave the workspace pointing at a chat that is no longer there.
 */
function repairSelection(state: WorkspaceState): WorkspaceState {
  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId)
    ?? state.projects[0];
  if (!project) return state;
  const selectedChatId = project.chats.some((chat) => chat.id === state.selectedChatId)
    ? state.selectedChatId
    : chatsByActivity(project.chats)[0]?.id ?? null;
  return { ...state, selectedProjectId: project.id, selectedChatId };
}

/**
 * Rename a project. A blank name is not a name, so it is ignored rather than
 * saved: an empty folder row would be unclickable and impossible to fix.
 *
 * Renaming deliberately leaves `updatedAt` alone. That timestamp is shown as
 * when the work in a chat last happened, and typing a better title is not work
 * on the place.
 */
export function renameProject(state: WorkspaceState, projectId: string, name: string): WorkspaceState {
  const trimmed = name.trim();
  if (trimmed === "") return state;
  return {
    ...state,
    projects: state.projects.map((project) => project.id === projectId
      ? { ...project, name: trimmed }
      : project),
  };
}

/**
 * Replace a project's instructions. Empty text removes them. Text a run could
 * not send (over the bound, or with control characters) leaves the project
 * unchanged; the editor refuses it before it gets here.
 *
 * Like renaming, this leaves `updatedAt` alone: it is not work on the place.
 */
export function setProjectInstructions(state: WorkspaceState, projectId: string, text: string): WorkspaceState {
  const instructions = normalizeProjectInstructions(text);
  if (instructions === null && text.trim() !== "") return state;
  return {
    ...state,
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project;
      const rest = { ...project };
      delete rest.instructions;
      return instructions === null ? rest : { ...rest, instructions };
    }),
  };
}

/** The instructions a run in this project sends, or undefined for none. */
export function projectInstructions(state: WorkspaceState, projectId: string): string | undefined {
  return state.projects.find((project) => project.id === projectId)?.instructions;
}

/** The place a chat works in: its own choice, or the last one picked anywhere. */
export function chatStudioInstanceId(
  state: WorkspaceState,
  projectId: string,
  chatId: string | null,
): string | null {
  if (chatId === null) return state.preferences.studioInstanceId;
  const chat = state.projects.find((project) => project.id === projectId)?.chats
    .find((candidate) => candidate.id === chatId);
  return chat?.studioInstanceId ?? state.preferences.studioInstanceId;
}

/**
 * The place a chat's earlier runs changed, from the newest change that names
 * one. Null for a chat that has not changed Studio.
 */
export function chatWorkPlace(chat: Pick<Chat, "messages">): string | null {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const changes = chat.messages[index].run?.changes ?? [];
    for (let at = changes.length - 1; at >= 0; at -= 1) {
      const instanceId = changes[at].instanceId;
      if (instanceId !== undefined && instanceId !== "") return instanceId;
    }
  }
  return null;
}

export type ChatStudioTarget = {
  /** The place the chat's next run should go to, when one is known. */
  instanceId: string | null;
  /**
   * Whether that place is the only one the run may go to. A chat that has
   * already changed a place is about that place: its transcript and records
   * name that place's scripts and parts, and continuing it in whichever Studio
   * happens to be open would apply that work to a different game. So such a
   * chat is pinned, and when its place is not open the run goes to it anyway
   * and every Studio call fails as not connected, rather than guessing.
   */
  pinned: boolean;
};

/**
 * Where a chat's next run goes: its own choice, else the place its earlier
 * runs changed, else the last place picked anywhere.
 */
export function chatStudioTarget(
  state: WorkspaceState,
  projectId: string,
  chatId: string | null,
): ChatStudioTarget {
  const chat = chatId === null
    ? undefined
    : state.projects.find((project) => project.id === projectId)?.chats.find((candidate) => candidate.id === chatId);
  const worked = chat === undefined ? null : chatWorkPlace(chat);
  return {
    instanceId: chat?.studioInstanceId ?? worked ?? state.preferences.studioInstanceId,
    pinned: worked !== null,
  };
}

/**
 * Record the place a chat works in.
 *
 * The choice is written twice on purpose: on the chat, because that is what the
 * user was looking at when they made it, and on the preferences, so the next
 * new chat starts in the same place instead of falling back to whichever plugin
 * connected first. `null` clears both, which is how the automatic behaviour is
 * asked for again.
 */
export function setChatStudioInstance(
  state: WorkspaceState,
  projectId: string,
  chatId: string | null,
  instanceId: string | null,
): WorkspaceState {
  const preferences = { ...state.preferences, studioInstanceId: instanceId };
  if (chatId === null) return { ...state, preferences };
  return {
    ...state,
    preferences,
    projects: state.projects.map((project) => project.id === projectId
      ? {
        ...project,
        chats: project.chats.map((chat) => chat.id === chatId
          ? { ...chat, studioInstanceId: instanceId ?? undefined }
          : chat),
      }
      : project),
  };
}

/** The reasoning effort a chat's next run asks for: its own choice, else the workspace default. */
export function chatReasoningEffort(
  state: WorkspaceState,
  projectId: string,
  chatId: string | null,
): ReasoningEffort {
  if (chatId === null) return state.preferences.reasoningEffort;
  const chat = state.projects.find((project) => project.id === projectId)?.chats
    .find((candidate) => candidate.id === chatId);
  return chat?.reasoningEffort ?? state.preferences.reasoningEffort;
}

/**
 * Change the effort new chats start with.
 *
 * Every chat that has none of its own follows this default, so before it
 * changes each such chat is given the value it has been using. Changing the
 * default therefore never changes what any existing chat asks for.
 */
/** A chat's provider and model; `modelId` null means the provider's default. */
export type ChatModel = Readonly<{ provider: ProviderId; modelId: string | null }>;

function isChatModel(value: unknown): value is ChatModel {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return isEnabledProvider(record.provider) &&
    (record.modelId === null || (typeof record.modelId === "string" && record.modelId !== "" && record.modelId.length <= 200));
}

/** The provider and model the workspace preference names: what a chat without its own uses. */
export function defaultChatModel(state: WorkspaceState): ChatModel {
  return { provider: state.preferences.provider, modelId: selectedModelId(state.preferences, state.preferences.provider) };
}

/** The provider and model a chat's next run uses: its own choice, else the workspace default. */
export function chatModel(state: WorkspaceState, projectId: string, chatId: string | null): ChatModel {
  if (chatId === null) return defaultChatModel(state);
  const chat = state.projects.find((project) => project.id === projectId)?.chats
    .find((candidate) => candidate.id === chatId);
  return chat?.model ?? defaultChatModel(state);
}

/**
 * Change the provider and model new chats start with. Every chat that has
 * none of its own is first given the one it has been using, so changing the
 * default never changes what an existing chat runs on.
 */
export function setDefaultModel(state: WorkspaceState, provider: ProviderId, modelId: string): WorkspaceState {
  const previous = defaultChatModel(state);
  if (previous.provider === provider && previous.modelId === modelId) return state;
  return {
    ...state,
    preferences: { ...state.preferences, provider, ...modelPreference(provider, modelId) },
    projects: state.projects.map((project) => project.chats.some((chat) => chat.model === undefined)
      ? { ...project, chats: project.chats.map((chat) => chat.model === undefined ? { ...chat, model: previous } : chat) }
      : project),
  };
}

/**
 * Record the provider and model chosen in a chat: kept on the chat, so only its
 * runs change, and made the default the next new chat starts with. With no chat
 * open only the default changes.
 */
export function setChatModel(
  state: WorkspaceState, projectId: string, chatId: string | null, provider: ProviderId, modelId: string,
): WorkspaceState {
  const next = setDefaultModel(state, provider, modelId);
  if (chatId === null) return next;
  return {
    ...next,
    projects: next.projects.map((project) => project.id === projectId
      ? { ...project, chats: project.chats.map((chat) => chat.id === chatId ? { ...chat, model: { provider, modelId } } : chat) }
      : project),
  };
}

export function setDefaultReasoningEffort(state: WorkspaceState, effort: ReasoningEffort): WorkspaceState {
  const previous = state.preferences.reasoningEffort;
  if (previous === effort) return state;
  return {
    ...state,
    preferences: { ...state.preferences, reasoningEffort: effort },
    projects: state.projects.map((project) => project.chats.some((chat) => chat.reasoningEffort === undefined)
      ? {
        ...project,
        chats: project.chats.map((chat) => chat.reasoningEffort === undefined ? { ...chat, reasoningEffort: previous } : chat),
      }
      : project),
  };
}

/**
 * Record the reasoning effort chosen in a chat.
 *
 * It is kept on the chat, so only that chat's runs change, and becomes the
 * default the next new chat starts with, the way the Studio place does. With
 * no chat open only the default changes.
 */
export function setChatReasoningEffort(
  state: WorkspaceState,
  projectId: string,
  chatId: string | null,
  effort: ReasoningEffort,
): WorkspaceState {
  const next = setDefaultReasoningEffort(state, effort);
  if (chatId === null) return next;
  return {
    ...next,
    projects: next.projects.map((project) => project.id === projectId
      ? {
        ...project,
        chats: project.chats.map((chat) => chat.id === chatId ? { ...chat, reasoningEffort: effort } : chat),
      }
      : project),
  };
}

/** Rename a chat, and stop its first message from overwriting the new title. */
export function renameChat(state: WorkspaceState, projectId: string, chatId: string, title: string): WorkspaceState {
  const trimmed = title.trim();
  if (trimmed === "") return state;
  return {
    ...state,
    projects: state.projects.map((project) => project.id === projectId
      ? {
        ...project,
        chats: project.chats.map((chat) => chat.id === chatId
          ? { ...chat, title: trimmed, titleSetByUser: true }
          : chat),
      }
      : project),
  };
}

/** Delete a chat and everything said in it, then repair the selection. */
export function deleteChat(state: WorkspaceState, projectId: string, chatId: string): WorkspaceState {
  const now = new Date().toISOString();
  return repairSelection({
    ...state,
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project;
      const chats = project.chats.filter((chat) => chat.id !== chatId);
      return chats.length === project.chats.length ? project : { ...project, updatedAt: now, chats };
    }),
  });
}

/**
 * Delete a project and every chat inside it.
 *
 * The last remaining project cannot be deleted: a chat has to live somewhere,
 * and a workspace with no projects would be repaired into a fresh one on the
 * next load, which reads as the app having thrown the user's work away. The
 * menu disables the action too; this guard is what makes it true.
 */
export function deleteProject(state: WorkspaceState, projectId: string): WorkspaceState {
  if (state.projects.length < 2) return state;
  const projects = state.projects.filter((project) => project.id !== projectId);
  if (projects.length === state.projects.length) return state;
  return repairSelection({ ...state, projects });
}

/** Record a manual compact on one chat. The messages themselves are untouched. */
export function setChatCompaction(state: WorkspaceState, projectId: string, chatId: string, compaction: ChatCompaction): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project;
      return {
        ...project,
        chats: project.chats.map((chat) => (chat.id === chatId ? { ...chat, compaction } : chat)),
      };
    }),
  };
}

/**
 * The chat's last `count` notes, which the run ended before the model read,
 * become ordinary messages again: the next run is told them as messages it
 * missed instead of taking them as already received.
 */
export function undeliverNotes(state: WorkspaceState, projectId: string, chatId: string, count: number): WorkspaceState {
  if (count <= 0) return state;
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== projectId ? project : {
      ...project,
      chats: project.chats.map((chat) => {
        if (chat.id !== chatId) return chat;
        let left = count;
        const messages = [...chat.messages];
        for (let index = messages.length - 1; index >= 0 && left > 0; index -= 1) {
          if (messages[index].note !== true) continue;
          const plain = { ...messages[index] };
          delete plain.note;
          messages[index] = plain;
          left -= 1;
        }
        return { ...chat, messages };
      }),
    }),
  };
}

export function appendMessage(state: WorkspaceState, projectId: string, chatId: string, message: ChatMessage): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) => {
      if (project.id !== projectId) return project;
      return {
        ...project,
        updatedAt: message.createdAt,
        chats: project.chats.map((chat) => {
          if (chat.id !== chatId) return chat;
          const firstUserMessage = chat.messages.length === 0 &&
            message.role === "user" &&
            chat.titleSetByUser !== true;
          const title = firstUserMessage
            ? message.text.trim().slice(0, 48) || chat.title
            : chat.title;
          return { ...chat, title, updatedAt: message.createdAt, messages: [...chat.messages, message] };
        }),
      };
    }),
  };
}

/**
 * Take back a message that never went anywhere: a prompt whose run could not
 * start. A chat left empty gets back the title it had before, since that title
 * came from the message; one the user named keeps its name.
 */
export function withdrawMessage(state: WorkspaceState, projectId: string, chatId: string, messageId: string): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== projectId ? project : {
      ...project,
      chats: project.chats.map((chat) => {
        if (chat.id !== chatId || !chat.messages.some((message) => message.id === messageId)) return chat;
        const messages = chat.messages.filter((message) => message.id !== messageId);
        const title = messages.length === 0 && chat.titleSetByUser !== true ? UNTITLED_CHAT : chat.title;
        return { ...chat, title, messages };
      }),
    }),
  };
}

/**
 * The prompt a chat can be taken back to, to be written again or sent again:
 * its last one, which only replies and notes come after. Undefined when the
 * chat has none, or when a compact has already folded that prompt into its
 * record, where it can no longer be taken out of what the model is told.
 */
export function rewindableMessage(chat: Chat): ChatMessage | undefined {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message.role !== "user" || message.note === true) continue;
    return index >= (chat.compaction?.folded ?? 0) ? message : undefined;
  }
  return undefined;
}

/**
 * Take a chat back to just before one of its prompts: that prompt and
 * everything after it leave the chat. Only `rewindableMessage` can be taken
 * out; any other id leaves the chat as it is.
 */
export function rewindChat(state: WorkspaceState, projectId: string, chatId: string, messageId: string): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== projectId ? project : {
      ...project,
      chats: project.chats.map((chat) => {
        if (chat.id !== chatId || rewindableMessage(chat)?.id !== messageId) return chat;
        const messages = chat.messages.slice(0, chat.messages.findIndex((message) => message.id === messageId));
        const title = messages.length === 0 && chat.titleSetByUser !== true ? UNTITLED_CHAT : chat.title;
        return { ...chat, title, messages };
      }),
    }),
  };
}

/**
 * Mark a chat as holding a reply nobody has seen, or (`unread` false) as seen.
 * The same state is returned when the chat already says so, so marking the
 * open chat read on every render saves nothing new.
 */
export function setChatUnread(state: WorkspaceState, projectId: string, chatId: string, unread: boolean): WorkspaceState {
  const chat = state.projects.find((project) => project.id === projectId)?.chats.find((entry) => entry.id === chatId);
  if (chat === undefined || (chat.unread === true) === unread) return state;
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== projectId ? project : {
      ...project,
      chats: project.chats.map((entry) => {
        if (entry.id !== chatId) return entry;
        const rest = { ...entry };
        delete rest.unread;
        return unread ? { ...rest, unread: true } : rest;
      }),
    }),
  };
}

/** Record on a sent message the Studio selection Roqer actually read when it went. */
export function withMessageSelection(
  state: WorkspaceState, projectId: string, chatId: string, messageId: string, selection: StudioSelection,
): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== projectId ? project : {
      ...project,
      chats: project.chats.map((chat) => chat.id !== chatId ? chat : {
        ...chat,
        messages: chat.messages.map((message) => message.id !== messageId ? message : { ...message, studioSelection: selection }),
      }),
    }),
  };
}
