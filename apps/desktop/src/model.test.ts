import assert from "node:assert/strict";
import test from "node:test";
import { enabledProviderOr, isEnabledProvider, isProviderId } from "../shared/provider";
import {
  appendMessage,
  chatStudioInstanceId,
  createChat,
  createInitialWorkspace,
  createProject,
  deleteChat,
  deleteProject,
  normalizeWorkspace,
  renameChat,
  renameProject,
  setChatStudioInstance,
} from "./model";

test("a new workspace contains no invented projects, chats, or messages", () => {
  const state = createInitialWorkspace();
  assert.equal(state.projects.length, 1);
  assert.deepEqual(state.projects[0].chats, []);
  assert.equal(state.selectedChatId, null);
  assert.equal(state.selectedProjectId, state.projects[0].id);
  assert.equal(state.projects[0].name, "Default");
});

test("a first launch starts unattended, which is what the app is for", () => {
  assert.equal(createInitialWorkspace().preferences.approvalMode, "Full auto");

  // A stored workspace whose mode is unreadable lands on the same default
  // rather than on a second, quieter one nobody chose.
  const repaired = normalizeWorkspace({
    ...createInitialWorkspace(),
    preferences: { approvalMode: "Supervise" },
  });
  assert.equal(repaired.preferences.approvalMode, "Full auto");
});

/** A workspace as older builds wrote it to disk, with the seeded content. */
function legacySeededWorkspace() {
  const now = new Date().toISOString();
  const chat = (id: string, messages: Array<{ id: string; role: "user" | "assistant"; text: string }> = []) => ({
    id, title: id, createdAt: now, updatedAt: now,
    messages: messages.map((message) => ({ ...message, createdAt: now })),
  });
  return {
    schemaVersion: 1,
    selectedProjectId: "coffee-run",
    selectedChatId: "fireball",
    projects: [
      {
        id: "coffee-run", name: "COFFEE-RUN", createdAt: now, updatedAt: now,
        chats: [
          chat("fireball", [
            { id: "message-fireball-request", role: "user" as const, text: "Make the Fireball tool shoot a projectile." },
            { id: "message-fireball-result", role: "assistant" as const, text: "I updated the fireball." },
          ]),
          chat("shop-ui"),
          chat("daily-login"),
        ],
      },
      { id: "tycoon-v2", name: "TYCOON-V2", createdAt: now, updatedAt: now, chats: [chat("dropper"), chat("rebirth")] },
      { id: "default", name: "DEFAULT", createdAt: now, updatedAt: now, chats: [] },
    ],
    preferences: { theme: "light", approvalMode: "Ask first", autoPlaytest: true, mcpEndpoint: "http://127.0.0.1:58741" },
  };
}

test("a chat remembers its own place, and the next chat inherits it", () => {
  const base = createChat(createChat(createInitialWorkspace()));
  const projectId = base.selectedProjectId;
  const [second, first] = base.projects[0].chats;

  const chosen = setChatStudioInstance(base, projectId, first.id, "place:1");
  assert.equal(chatStudioInstanceId(chosen, projectId, first.id), "place:1");
  // A chat that was never pointed anywhere follows the last choice made, so
  // starting a new chat about the same game does not mean re-picking.
  assert.equal(chatStudioInstanceId(chosen, projectId, second.id), "place:1");

  // Pointing another chat elsewhere leaves the first one alone.
  const split = setChatStudioInstance(chosen, projectId, second.id, "place:2");
  assert.equal(chatStudioInstanceId(split, projectId, first.id), "place:1");
  assert.equal(chatStudioInstanceId(split, projectId, second.id), "place:2");

  // Clearing asks for the automatic behaviour again, for this chat and for the
  // ones started after it, without disturbing chats that chose for themselves.
  const cleared = setChatStudioInstance(split, projectId, second.id, null);
  assert.equal(chatStudioInstanceId(cleared, projectId, second.id), null);
  assert.equal(cleared.preferences.studioInstanceId, null);
  assert.equal(chatStudioInstanceId(cleared, projectId, first.id), "place:1");
});

test("a place chosen with no chat open is still remembered for the next one", () => {
  const base = createInitialWorkspace();
  const chosen = setChatStudioInstance(base, base.selectedProjectId, null, "place:1");
  assert.equal(chosen.preferences.studioInstanceId, "place:1");
  assert.equal(chatStudioInstanceId(chosen, base.selectedProjectId, null), "place:1");
});

test("a chat's place survives being written to disk and read back", () => {
  const base = createChat(createInitialWorkspace());
  const chatId = base.projects[0].chats[0].id;
  const saved = JSON.parse(JSON.stringify(
    setChatStudioInstance(base, base.selectedProjectId, chatId, "place:1"),
  ));
  assert.equal(chatStudioInstanceId(normalizeWorkspace(saved), base.selectedProjectId, chatId), "place:1");
});

test("previously persisted seeded chats are removed on load", () => {
  const normalized = normalizeWorkspace(legacySeededWorkspace());
  assert.deepEqual(normalized.projects.map((project) => project.id), ["default"]);
  assert.equal(normalized.selectedProjectId, "default");
  assert.equal(normalized.selectedChatId, null);
});

test("a real chat inside a seeded project keeps both the chat and the project", () => {
  const legacy = legacySeededWorkspace();
  legacy.projects[0].chats.push({
    id: "chat-mine", title: "My own work", createdAt: legacy.projects[0].createdAt, updatedAt: legacy.projects[0].updatedAt,
    messages: [{ id: "message-mine", role: "user" as const, text: "Inspect this place", createdAt: legacy.projects[0].createdAt }],
  });

  const normalized = normalizeWorkspace(legacy);
  const coffeeRun = normalized.projects.find((project) => project.id === "coffee-run");
  assert.ok(coffeeRun, "a project holding real work must survive");
  assert.deepEqual(coffeeRun.chats.map((chat) => chat.id), ["chat-mine"]);
});

test("a seeded chat the user replied in is kept", () => {
  const legacy = legacySeededWorkspace();
  legacy.projects[0].chats[0].messages.push({
    id: "message-mine", role: "user" as const, text: "Actually, do it differently", createdAt: legacy.projects[0].createdAt,
  });

  const normalized = normalizeWorkspace(legacy);
  const fireball = normalized.projects.find((project) => project.id === "coffee-run")?.chats[0];
  assert.equal(fireball?.id, "fireball");
  assert.equal(fireball?.messages.length, 3);
});

test("normalization repairs an invalid selection", () => {
  const state = createInitialWorkspace("dark");
  const normalized = normalizeWorkspace({ ...state, selectedProjectId: "missing", selectedChatId: "missing" });
  assert.equal(normalized.selectedProjectId, state.projects[0].id);
  assert.equal(normalized.selectedChatId, null, "an empty project has no chat to select");
  assert.equal(normalized.preferences.theme, "dark");
});

test("version 1 preferences migrate without losing workspace data", () => {
  const current = createChat(createInitialWorkspace("dark"));
  const legacy = {
    ...current,
    schemaVersion: 1,
    preferences: {
      theme: current.preferences.theme,
      approvalMode: current.preferences.approvalMode,
      autoPlaytest: current.preferences.autoPlaytest,
      mcpEndpoint: current.preferences.mcpEndpoint,
    },
  };

  const migrated = normalizeWorkspace(legacy);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.projects[0].chats.length, 1);
  assert.equal(migrated.preferences.chatGptModelId, null);
  assert.equal(migrated.preferences.reasoningEffort, "medium");
});

test("version 2 preferences keep the vendor models", () => {
  const current = createChat(createInitialWorkspace("dark"));
  const version2 = {
    ...current,
    schemaVersion: 2,
    preferences: {
      theme: current.preferences.theme,
      approvalMode: current.preferences.approvalMode,
      autoPlaytest: current.preferences.autoPlaytest,
      mcpEndpoint: current.preferences.mcpEndpoint,
      provider: "claude",
      chatGptModelId: "gpt-5.6-luna",
      claudeModelId: "claude-opus-5",
      reasoningEffort: "high",
    },
  };

  const migrated = normalizeWorkspace(version2);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.preferences.provider, "claude");
  assert.equal(migrated.preferences.chatGptModelId, "gpt-5.6-luna");
  assert.equal(migrated.preferences.claudeModelId, "claude-opus-5");
  assert.equal(migrated.preferences.reasoningEffort, "high");
});

test("every provider is offered and the retired hosted gateway moves to the default", () => {
  assert.equal(isProviderId("claude"), true);
  assert.equal(isEnabledProvider("claude"), true);
  assert.equal(isEnabledProvider("chatgpt"), true);
  // The retired hosted gateway is no longer a provider at all.
  assert.equal(isProviderId("workbench"), false);
  assert.equal(isEnabledProvider("workbench"), false);
  assert.equal(enabledProviderOr("chatgpt"), "chatgpt");
  assert.equal(enabledProviderOr("nonsense"), "chatgpt");
  assert.equal(enabledProviderOr("workbench"), "chatgpt");
});

test("normalization drops malformed persisted messages and keeps the rest", () => {
  const withChat = createChat(createInitialWorkspace());
  const chatId = withChat.selectedChatId!;
  const populated = appendMessage(withChat, withChat.selectedProjectId, chatId, {
    id: "message-good",
    role: "user",
    text: "Inspect this project",
    createdAt: new Date().toISOString(),
  });

  const damaged = structuredClone(populated) as unknown as Record<string, unknown>;
  const projects = damaged.projects as Array<{ chats: Array<{ messages: unknown[] }> }>;
  projects[0].chats[0].messages.push({ role: "assistant" });

  const normalized = normalizeWorkspace(damaged, "dark");
  const messages = normalized.projects[0].chats[0].messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "message-good");
});

test("an image attachment keeps its preview, and an unbounded one is not saved", () => {
  const withChat = createChat(createInitialWorkspace());
  const chatId = withChat.selectedChatId!;
  const preview = `data:image/jpeg;base64,${"A".repeat(64)}`;
  const attachment = { id: "asset-1", name: "shot.png", size: 4_096, addedAt: new Date().toISOString() };
  const populated = appendMessage(withChat, withChat.selectedProjectId, chatId, {
    id: "message-image",
    role: "user",
    text: "Why does this look wrong?",
    createdAt: new Date().toISOString(),
    attachments: [{ ...attachment, mediaType: "image/png", thumbnailDataUrl: preview }],
  });

  const kept = normalizeWorkspace(structuredClone(populated) as unknown as Record<string, unknown>);
  assert.deepEqual(kept.projects[0].chats[0].messages[0].attachments?.[0].thumbnailDataUrl, preview);

  // The preview is the only part of an attachment that outlives the run, so a
  // record that exceeds the bound is treated as damaged rather than persisted.
  const oversized = structuredClone(populated) as unknown as Record<string, unknown>;
  const projects = oversized.projects as Array<{ chats: Array<{ messages: Array<{ attachments: Array<{ thumbnailDataUrl: string }> }> }> }>;
  projects[0].chats[0].messages[0].attachments[0].thumbnailDataUrl = `data:image/jpeg;base64,${"A".repeat(200_000)}`;
  assert.equal(normalizeWorkspace(oversized).projects[0].chats[0].messages.length, 0);

  // A preview that is not an image data URL cannot be rendered, and a saved
  // record is not the place to discover that.
  const forged = structuredClone(populated) as unknown as Record<string, unknown>;
  const forgedProjects = forged.projects as typeof projects;
  forgedProjects[0].chats[0].messages[0].attachments[0].thumbnailDataUrl = "javascript:alert(1)";
  assert.equal(normalizeWorkspace(forged).projects[0].chats[0].messages.length, 0);
});

test("creating a project and chat selects both", () => {
  const withProject = createProject(createInitialWorkspace(), "new game");
  assert.equal(withProject.projects.at(-1)?.name, "new game");
  assert.equal(withProject.selectedChatId, null);

  const withChat = createChat(withProject);
  assert.equal(withChat.projects.at(-1)?.chats.length, 1);
  assert.equal(withChat.selectedChatId, withChat.projects.at(-1)?.chats[0].id);
});

test("the first user message becomes the chat title", () => {
  const withChat = createChat(createInitialWorkspace(), "default");
  const updated = appendMessage(withChat, "default", withChat.selectedChatId!, {
    id: "message-test",
    role: "user",
    text: "Build a polished obby checkpoint system with effects",
    createdAt: new Date().toISOString(),
  });
  const chat = updated.projects.find((project) => project.id === "default")?.chats[0];
  assert.equal(chat?.title, "Build a polished obby checkpoint system with eff");
  assert.equal(chat?.messages.length, 1);
});

test("a title the user typed survives the first message", () => {
  const withChat = createChat(createInitialWorkspace(), "default");
  const chatId = withChat.selectedChatId!;
  const named = renameChat(withChat, "default", chatId, "  Checkpoint work  ");
  const updated = appendMessage(named, "default", chatId, {
    id: "message-test",
    role: "user",
    text: "Build a polished obby checkpoint system with effects",
    createdAt: new Date().toISOString(),
  });

  const chat = updated.projects.find((project) => project.id === "default")?.chats[0];
  assert.equal(chat?.title, "Checkpoint work");
});

test("renaming ignores a blank name rather than saving an unreadable row", () => {
  const state = createProject(createInitialWorkspace(), "Obby");
  const projectId = state.selectedProjectId;
  assert.equal(renameProject(state, projectId, "   "), state);

  const renamed = renameProject(state, projectId, " Obby prototype ");
  assert.equal(renamed.projects.at(-1)?.name, "Obby prototype");
});

test("deleting the open chat selects another one in the same project", () => {
  const first = createChat(createInitialWorkspace(), "default");
  const second = createChat(first, "default");
  const openChatId = second.selectedChatId!;
  const remainingId = first.selectedChatId!;

  const deleted = deleteChat(second, "default", openChatId);
  assert.deepEqual(deleted.projects[0].chats.map((chat) => chat.id), [remainingId]);
  assert.equal(deleted.selectedChatId, remainingId);
});

test("deleting the last chat in a project leaves nothing selected", () => {
  const state = createChat(createInitialWorkspace(), "default");
  const deleted = deleteChat(state, "default", state.selectedChatId!);
  assert.equal(deleted.selectedChatId, null);
  assert.equal(deleted.selectedProjectId, "default");
});

test("deleting the open project falls back to one that still exists", () => {
  const state = createChat(createProject(createInitialWorkspace(), "Obby"));
  const projectId = state.selectedProjectId;

  const deleted = deleteProject(state, projectId);
  assert.deepEqual(deleted.projects.map((project) => project.id), ["default"]);
  assert.equal(deleted.selectedProjectId, "default");
  assert.equal(deleted.selectedChatId, null);
});

test("the only project cannot be deleted", () => {
  const state = createInitialWorkspace();
  assert.equal(deleteProject(state, "default"), state);
});
