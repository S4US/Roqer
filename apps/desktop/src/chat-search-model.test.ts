import assert from "node:assert/strict";
import test from "node:test";
import { foldText, searchChats, searchTerms } from "./chat-search-model";
import { appendMessage, createChat, createInitialWorkspace, createProject, renameChat, type WorkspaceState } from "./model";

function workspace(): { state: WorkspaceState; shop: string; lobby: string } {
  let state = createChat(createInitialWorkspace());
  const first = state.selectedProjectId;
  const shop = state.selectedChatId!;
  const say = (chatId: string, projectId: string, id: string, role: "user" | "assistant", text: string, at: string) => {
    state = appendMessage(state, projectId, chatId, { id, role, text, createdAt: at });
  };
  say(shop, first, "s1", "user", "Build a coin shop near the spawn", "2026-01-01T10:00:00.000Z");
  say(shop, first, "s2", "assistant", "The shop is built.\nIt sells three items for Coins, and the jackpot alert plays a sound.", "2026-01-01T10:05:00.000Z");
  say(shop, first, "s3", "user", "Change the jackpot sound", "2026-01-02T09:00:00.000Z");
  state = renameChat(state, first, shop, "Coin shop");
  state = createChat(createProject(state, "BID OR BOOM!"));
  const second = state.selectedProjectId;
  const lobby = state.selectedChatId!;
  say(lobby, second, "l1", "user", "Ajoute de l'électricité dans le lobby", "2026-01-03T08:00:00.000Z");
  say(lobby, second, "l2", "assistant", "C'est fait : le lobby a maintenant des éclairs.", "2026-01-03T08:02:00.000Z");
  return { state, shop, lobby };
}

test("text is compared without case or accents, position for position", () => {
  assert.equal(foldText("Électricité"), "electricite");
  assert.equal(foldText("Straße ﬁn").length, "Straße ﬁn".length, "a character that folds to several keeps its place");
  assert.deepEqual(searchTerms("  Shop  SHOP coin "), ["shop", "coin"]);
  assert.deepEqual(searchTerms("   "), []);
});

test("a search finds messages in every project, newest first, with the words marked", () => {
  const { state, shop } = workspace();
  const results = searchChats(state, "jackpot");
  assert.deepEqual(results.map((result) => result.messageId), ["s3", "s2"]);
  assert.equal(results[0].chatId, shop);
  assert.equal(results[0].chatTitle, "Coin shop");
  assert.equal(results[0].role, "user");
  for (const result of results) {
    for (const [start, end] of result.marks) assert.equal(result.snippet.slice(start, end).toLowerCase(), "jackpot");
    assert.ok(result.marks.length > 0);
    assert.doesNotMatch(result.snippet, /\n/, "a snippet is one line");
  }
});

test("every word must be in the same message, in any order, whatever the accents", () => {
  const { state, lobby } = workspace();
  assert.deepEqual(searchChats(state, "sound jackpot").map((result) => result.messageId), ["s3", "s2"]);
  assert.deepEqual(searchChats(state, "jackpot lobby"), [], "the words are in different chats");
  // The chat is named after its first message, so its name is found too; the messages are what is checked here.
  const french = searchChats(state, "ELECTRICITE").filter((result) => result.messageId !== undefined);
  assert.deepEqual(french.map((result) => [result.chatId, result.messageId, result.projectName]), [[lobby, "l1", "BID OR BOOM!"]]);
  const [start, end] = french[0].marks[0];
  assert.equal(french[0].snippet.slice(start, end), "électricité", "the mark sits on the word as it was written");
});

test("a chat found by its name comes before messages, and carries no message", () => {
  const { state, shop } = workspace();
  const results = searchChats(state, "coin");
  assert.equal(results[0].chatId, shop);
  assert.equal(results[0].messageId, undefined);
  assert.equal(results[0].snippet, "Coin shop");
  assert.deepEqual(results[0].marks, [[0, 4]]);
  assert.deepEqual(results.slice(1).map((result) => result.messageId), ["s2", "s1"]);
});

test("one chat gives a few messages at most, and the list has a limit", () => {
  let { state } = workspace();
  const projectId = state.selectedProjectId;
  const chatId = state.selectedChatId!;
  for (let index = 0; index < 10; index += 1) {
    state = appendMessage(state, projectId, chatId, { id: `x${index}`, role: "user", text: `zebra ${index}`, createdAt: `2026-02-01T00:00:0${index}.000Z` });
  }
  assert.deepEqual(searchChats(state, "zebra").map((result) => result.messageId), ["x9", "x8", "x7"]);
  assert.equal(searchChats(state, "zebra", 2).length, 2);
  assert.equal(searchChats(state, "zebra", 40, 10).length, 10);
});

test("a long message shows the text around the first word found", () => {
  let { state } = workspace();
  const long = `${"word ".repeat(100)}needle ${"tail ".repeat(100)}`;
  state = appendMessage(state, state.selectedProjectId, state.selectedChatId!, { id: "long", role: "assistant", text: long, createdAt: "2026-03-01T00:00:00.000Z" });
  const [result] = searchChats(state, "needle");
  assert.ok(result.snippet.startsWith("…") && result.snippet.endsWith("…"));
  assert.ok(result.snippet.length < 170);
  const [start, end] = result.marks[0];
  assert.equal(result.snippet.slice(start, end), "needle");
  assert.equal(searchChats(state, "").length, 0);
});
