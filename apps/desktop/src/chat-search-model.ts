import type { WorkspaceState } from "./model";

/** One place a search found: a chat by its name, or one message in a chat. */
export type ChatSearchResult = Readonly<{
  projectId: string;
  projectName: string;
  chatId: string;
  chatTitle: string;
  /** The message found; absent when the chat's own name is what matched. */
  messageId?: string;
  role?: "user" | "assistant";
  /** The text around the first word found, on one line. */
  snippet: string;
  /** Where the searched words sit in `snippet`, in order, as [start, end) pairs. */
  marks: ReadonlyArray<readonly [number, number]>;
  /** When the message was sent, or the chat last changed: newest results come first. */
  at: string;
}>;

/** How much text a result shows before and after the first word found. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 110;

/**
 * Text as it is compared: lower case, with accents taken off, so "electricite"
 * finds "Électricité". Every character maps to exactly one, so a position in
 * the folded text is the same position in the original.
 */
export function foldText(text: string): string {
  let folded = "";
  for (const char of text) {
    const base = char.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    // A character that folds to another length (ß, ligatures) keeps its own
    // place, so positions still line up.
    folded += base.length === char.length ? base : char.toLowerCase().length === char.length ? char.toLowerCase() : char;
  }
  return folded;
}

/**
 * Each message's folded text, kept while the message is: messages are not
 * changed in place, so a message object always folds to the same text, and a
 * search that runs on every keystroke folds each message once, not each time.
 */
const foldedMessages = new WeakMap<object, string>();

function foldedMessage(message: { text: string }): string {
  let folded = foldedMessages.get(message);
  if (folded === undefined) {
    folded = foldText(message.text);
    foldedMessages.set(message, folded);
  }
  return folded;
}

/** The words of a search, folded; a search of nothing but spaces has none. */
export function searchTerms(query: string): string[] {
  return [...new Set(foldText(query).split(/\s+/).filter((term) => term !== ""))];
}

function positions(folded: string, terms: readonly string[]): Array<[number, number]> | undefined {
  const found: Array<[number, number]> = [];
  for (const term of terms) {
    let from = folded.indexOf(term);
    if (from === -1) return undefined;
    while (from !== -1 && found.length < 64) {
      found.push([from, from + term.length]);
      from = folded.indexOf(term, from + term.length);
    }
  }
  found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  // Words that overlap ("shop" inside "shops") are shown as one stretch.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function snippetOf(text: string, found: ReadonlyArray<readonly [number, number]>): Pick<ChatSearchResult, "snippet" | "marks"> {
  const first = found[0]?.[0] ?? 0;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  // Start on a word where one is close, rather than in the middle of it.
  const space = text.lastIndexOf(" ", start + 12);
  if (start > 0 && space >= start) start = space + 1;
  const end = Math.min(text.length, first + SNIPPET_AFTER);
  const lead = start > 0 ? "…" : "";
  const body = text.slice(start, end).replace(/\s/g, " ");
  const marks = found
    .filter(([from, to]) => to > start && from < end)
    .map(([from, to]) => [Math.max(from, start) - start + lead.length, Math.min(to, end) - start + lead.length] as const);
  return { snippet: `${lead}${body}${end < text.length ? "…" : ""}`, marks };
}

/**
 * Search every chat's name and messages for all of the query's words, in any
 * order, ignoring case and accents. A chat whose name matches comes first,
 * then messages, each group newest first; a chat gives at most `perChat`
 * messages so one long chat cannot fill the list.
 */
export function searchChats(state: WorkspaceState, query: string, limit = 40, perChat = 3): ChatSearchResult[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const titles: ChatSearchResult[] = [];
  const messages: ChatSearchResult[] = [];
  for (const project of state.projects) {
    for (const chat of project.chats) {
      const place = { projectId: project.id, projectName: project.name, chatId: chat.id, chatTitle: chat.title };
      const inTitle = positions(foldText(chat.title), terms);
      if (inTitle !== undefined) titles.push({ ...place, snippet: chat.title, marks: inTitle, at: chat.updatedAt });
      let taken = 0;
      for (let index = chat.messages.length - 1; index >= 0 && taken < perChat; index -= 1) {
        const message = chat.messages[index];
        const found = positions(foldedMessage(message), terms);
        if (found === undefined) continue;
        taken += 1;
        messages.push({ ...place, messageId: message.id, role: message.role, ...snippetOf(message.text, found), at: message.createdAt });
      }
    }
  }
  const newestFirst = (left: ChatSearchResult, right: ChatSearchResult) => right.at.localeCompare(left.at);
  return [...titles.sort(newestFirst), ...messages.sort(newestFirst)].slice(0, limit);
}
