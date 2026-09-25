import { isRunRecord, type RunRecord } from "../shared/run-events";
import { isPersistedAttachment } from "../shared/workspace-validation";
import {
  DEFAULT_PROVIDER_ID,
  enabledProviderOr,
  isReasoningEffort,
  type ProviderId,
  type ReasoningEffort,
} from "../shared/provider";

export type Theme = "light" | "dark";

// Re-exported so renderer modules keep importing it from here, while the one
// definition lives next to the policy rules that consume it.
export type { ApprovalMode } from "../shared/policy";
import type { ApprovalMode } from "../shared/policy";

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
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: AssetAttachment[];
  /** Compacted record of the agent run that produced this message. */
  run?: RunRecord;
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
  messages: ChatMessage[];
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  chats: Chat[];
};

export type Preferences = {
  theme: Theme;
  approvalMode: ApprovalMode;
  autoPlaytest: boolean;
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
  /** Which managed sign-in drives runs. */
  provider: ProviderId;
  /** Remembered per provider so switching back keeps the previous choice. */
  chatGptModelId: string | null;
  claudeModelId: string | null;
  /** A custom model, as `<connection id>:<model id>`. The connection itself lives in the main process. */
  customModelId: string | null;
  reasoningEffort: ReasoningEffort;
};

/** The model the user last chose for a provider, if any. */
export function selectedModelId(preferences: Preferences, provider: ProviderId): string | null {
  if (provider === "custom") return preferences.customModelId;
  return provider === "claude" ? preferences.claudeModelId : preferences.chatGptModelId;
}

/** A preference patch that records a model choice against its own provider. */
export function modelPreference(provider: ProviderId, modelId: string): Partial<Preferences> {
  if (provider === "custom") return { customModelId: modelId };
  return provider === "claude" ? { claudeModelId: modelId } : { chatGptModelId: modelId };
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
      mcpEndpoint: DEFAULT_MCP_ENDPOINT,
      studioInstanceId: null,
      discordPresence: true,
      provider: DEFAULT_PROVIDER_ID,
      chatGptModelId: null,
      claudeModelId: null,
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
    (value.run === undefined || isRunRecord(value.run));
}

/**
 * A damaged run record should cost the user the record, not the message it was
 * attached to, so it is stripped before the message itself is validated.
 */
function normalizeMessage(value: unknown): ChatMessage[] {
  if (!isRecord(value)) return [];
  const candidate = value.run === undefined || isRunRecord(value.run)
    ? value
    : { ...value, run: undefined };
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
      return [{
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        titleSetByUser: chat.titleSetByUser === true ? true : undefined,
        studioInstanceId: typeof chat.studioInstanceId === "string" && chat.studioInstanceId !== ""
          ? chat.studioInstanceId
          : undefined,
        messages: chat.messages.flatMap(normalizeMessage),
      }];
    });

    return [{
      id: project.id,
      name: project.id === DEFAULT_PROJECT_ID && project.name === "DEFAULT" ? "Default" : project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
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

export function createChat(state: WorkspaceState, projectId = state.selectedProjectId): WorkspaceState {
  const now = new Date().toISOString();
  const chat: Chat = {
    id: createId("chat"),
    title: "Untitled chat",
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
 * A selection that still points at something that exists.
 *
 * Deleting what is open has to leave the user somewhere, so the selection falls
 * back to the first chat of the selected project, and to the first project when
 * the selected one is gone. Keeping the repair in one place means no delete can
 * leave the workspace pointing at a chat that is no longer there.
 */
function repairSelection(state: WorkspaceState): WorkspaceState {
  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId)
    ?? state.projects[0];
  if (!project) return state;
  const selectedChatId = project.chats.some((chat) => chat.id === state.selectedChatId)
    ? state.selectedChatId
    : project.chats[0]?.id ?? null;
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
