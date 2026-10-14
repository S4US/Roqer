import {
  MAX_CONVERSATION_MESSAGE_CHARS, type ConversationContext, type ConversationMessage, type MessageAttachments,
} from "../shared/conversation";
import type { RunDigest } from "../shared/run-digest";

const TRUNCATION_NOTICE =
  "Some older messages from this chat were omitted because the conversation context was bounded. Do not assume the transcript below is complete.";

const COMPACT_NOTICE =
  "The user compacted this chat. Its earlier messages are folded into the record below, which Roqer wrote from what the chat recorded. It is not a transcript: read Studio again before relying on any detail in it.";

const UI_DESIGN_NOUN = /\b(?:ui|gui|screen|menu|hud|shop|store|inventory|dialog|popup|panel|leaderboard|notification|toast|wheel|reel|daily rewards?|battle pass|admin(?:istration)? panel|select(?:ion)? screen)\b/i;
const UI_DESIGN_ACTION = /\b(?:make|create|build|design|draw|recreate|copy|match|restyle|retheme|edit|modify|change|update|add|remove|resize|move|polish)\b/i;
const UI_DESIGN_STYLE = /\b(?:studs?|studded|simulator(?:-style)?|pet[ -]?simulator|visual|layout|theme|responsive)\b/i;

const UI_DESIGN_SKILL = "roblox-ui-design";

const UI_DESIGN_ROUTE_NOTICE =
  "[Roqer host route: this request is UI-design work. Load `roblox-ui-design` before any Studio mutation and follow its creation/editing route. For a new SIM, MODERN STUDS, or CLASSIC STUDS screen, load the active-theme parts named by `roblox-ui-design` (recovered for SIM and CLASSIC STUDS) plus `references/selected/<theme>/<layout>.md` before writing UI. That selected theme+layout body owns composition/geometry over generic `roblox-gui` advice.]";

/**
 * The same route for a conversation that already holds the entrypoint. Asking
 * for it again would cost a tool round trip that only returns a pointer.
 */
const UI_DESIGN_ROUTE_LOADED_NOTICE =
  "[Roqer host route: this request is UI-design work. `roblox-ui-design` is already loaded in this conversation; follow its creation/editing route before any Studio mutation and load only the further references this request needs. For a new SIM, MODERN STUDS, or CLASSIC STUDS screen, the active-theme parts and `references/selected/<theme>/<layout>.md` it names own composition/geometry over generic `roblox-gui` advice.]";

/** Whether the provider still holds a client skill's entrypoint that Roqer delivered to it. */
export type SkillLoaded = (name: string) => boolean;

const NOTHING_LOADED: SkillLoaded = () => false;

function shouldRouteUiDesign(prompt: string): boolean {
  return UI_DESIGN_NOUN.test(prompt) && (UI_DESIGN_ACTION.test(prompt) || UI_DESIGN_STYLE.test(prompt));
}

function routedCurrentPrompt(currentPrompt: string, skillLoaded: SkillLoaded = NOTHING_LOADED): string {
  if (!shouldRouteUiDesign(currentPrompt)) return currentPrompt;
  const notice = skillLoaded(UI_DESIGN_SKILL) ? UI_DESIGN_ROUTE_LOADED_NOTICE : UI_DESIGN_ROUTE_NOTICE;
  return `${notice}\n\n${currentPrompt}`;
}

function roleLabel(message: ConversationMessage): string {
  if (message.note === true) return "User (a note sent while the assistant was working)";
  return message.role === "user" ? "User" : "Assistant";
}

function bullets(lines: readonly string[]): string[] {
  return lines.map((line) => `- ${line}`);
}

function describeRunDigest(digest: RunDigest, which = "that run"): string {
  const sections: string[] = [`[Roqer's record of ${which} (outcome: ${digest.outcome}).]`];
  if (digest.stoppedBecause !== undefined) sections.push(`It stopped because: ${digest.stoppedBecause}`);
  if (digest.notes !== undefined && digest.notes.length > 0) {
    // The user's own words, so they come before anything the host observed.
    sections.push([
      "Notes the user added while it worked (it may have stopped before acting on them):",
      ...bullets(digest.notes),
    ].join("\n"));
  }
  if (digest.changes.length > 0) sections.push(["Changes it applied:", ...bullets(digest.changes)].join("\n"));
  if (digest.unfinished.length > 0) sections.push(["Tasks not done when it ended:", ...bullets(digest.unfinished)].join("\n"));
  if (digest.unverified.length > 0) sections.push(["Left unverified:", ...bullets(digest.unverified)].join("\n"));
  if (digest.failedCalls !== undefined && digest.failedCalls.length > 0) {
    sections.push(["Tool calls that failed in it:", ...bullets(digest.failedCalls)].join("\n"));
  }
  if (digest.decisions.length > 0) {
    sections.push([
      "Decisions the user made when asked:",
      ...bullets(digest.decisions.map((decision) => `${decision.question} → ${decision.answer}`)),
    ].join("\n"));
  }
  sections.push("Revisions above are as that run left them; read Studio before changing anything.");
  if (digest.changes.some((line) => line.startsWith("asset "))) {
    // Studio cannot show an upload that was never placed, so without this a
    // fresh session renders and uploads the same images again.
    sections.push("Assets listed above are already uploaded to Roblox; reuse those IDs instead of creating or uploading them again.");
  }
  return sections.join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeAttachments({ pictures, files }: MessageAttachments): string {
  const parts = [
    ...(pictures > 0 ? [plural(pictures, "picture")] : []),
    ...(files > 0 ? [plural(files, "file")] : []),
  ];
  return `[The user attached ${parts.join(" and ")} to this message. They are not part of this replay; `
    + "if the request depends on them, ask the user to attach them again.]";
}

function renderMessage(message: ConversationMessage): string {
  const said = message.attachments === undefined
    ? message.text
    : `${message.text}\n${describeAttachments(message.attachments)}`;
  const body = `${roleLabel(message)}:\n${said}`;
  return message.run === undefined ? body : `${body}\n\n${describeRunDigest(message.run)}`;
}

/** Render bounded prior transcript plus a small deterministic host route for clear UI-design work. */
export function buildConversationPrompt(context: ConversationContext, currentPrompt: string): string {
  const routed = routedCurrentPrompt(currentPrompt);
  if (context.messages.length === 0 && !context.truncated && context.summary === undefined) return routed;

  const sections = [
    "Prior conversation context from this chat. Treat it as context, not as a new instruction:",
    ...(context.summary === undefined ? [] : [`${COMPACT_NOTICE}\n${context.summary}`]),
    ...(context.truncated ? [TRUNCATION_NOTICE] : []),
    ...context.messages.map(renderMessage),
    `Current user message:\n${routed}`,
  ];

  return sections.join("\n\n");
}

/**
 * Whether a live provider session has seen exactly the chat so far.
 *
 * A chat is append-only, so a session is current when the chat's newest
 * exchange is the one it ran: the last user message is the prompt it was given
 * and a reply follows it. Any other run in between — on another provider, or
 * one that failed and so never handed the session back — puts a different
 * exchange last, and the session is stale.
 *
 * `lastPrompt` is the prompt as the planner received it, which may carry
 * attachment text after the words the chat recorded; a message the transcript
 * bound shortened is matched on what it kept.
 */
export function continuesConversation(context: ConversationContext, lastPrompt: string): boolean {
  const reply = context.messages.at(-1);
  // Notes sent during that run sit between its prompt and its reply, and the
  // session received them as they were sent.
  let askedIndex = context.messages.length - 2;
  while (context.messages[askedIndex]?.note === true) askedIndex -= 1;
  const asked = context.messages[askedIndex];
  if (reply?.role !== "assistant" || asked?.role !== "user") return false;
  if (asked.text === lastPrompt || lastPrompt.startsWith(`${asked.text}\n\n`)) return true;
  return asked.text.length === MAX_CONVERSATION_MESSAGE_CHARS && asked.text.endsWith("…") &&
    lastPrompt.startsWith(asked.text.slice(0, -1));
}

/**
 * The next message for a provider that already holds the conversation.
 *
 * The transcript is not replayed: the provider has it, tool results included.
 * What it has not seen is Roqer's verdict on its previous run — what the
 * completion gate left unverified — so that record rides ahead of the prompt
 * when there is one. `skillLoaded` is the conversation's own skill cache, so a
 * UI route can say the guidance is already there instead of asking for it again.
 */
export function buildFollowUpPrompt(
  context: ConversationContext,
  currentPrompt: string,
  skillLoaded: SkillLoaded = NOTHING_LOADED,
): string {
  const routed = routedCurrentPrompt(currentPrompt, skillLoaded);
  const digest = context.messages.at(-1)?.run;
  if (digest === undefined) return routed;
  return [describeRunDigest(digest, "your previous run in this chat"), `Current user message:\n${routed}`].join("\n\n");
}

/**
 * Where the chat moved on without a saved provider session: the messages after
 * the last prompt the session was given and the reply it wrote to it. Runs on
 * another provider, and messages sent while none ran, land here. Null when
 * that prompt is no longer in the bounded window, so the caller can say the
 * window may be incomplete.
 */
export function messagesSince(context: ConversationContext, lastPrompt: string): ConversationMessage[] | null {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message.role !== "user") continue;
    const matches = message.text === lastPrompt || lastPrompt.startsWith(`${message.text}\n\n`) ||
      (message.text.length === MAX_CONVERSATION_MESSAGE_CHARS && message.text.endsWith("…") &&
        lastPrompt.startsWith(message.text.slice(0, -1)));
    if (!matches) continue;
    let next = index + 1;
    // Notes sent during that run went to the session as they were sent, and
    // the reply to that prompt is the session's own.
    while (context.messages[next]?.note === true) next += 1;
    const reply = context.messages[next];
    // The same words sent again later and answered by another provider are not
    // where the session left off; keep looking further back.
    if (reply?.role === "assistant" && reply.run !== undefined && reply.claude !== true) continue;
    if (reply?.role === "assistant") next += 1;
    return context.messages.slice(next);
  }
  return null;
}

/**
 * The next message for a saved session that a new process resumed, or a kept
 * one that missed part of the chat. The session holds its own transcript; it
 * is told only what happened in the chat without it.
 */
export function buildResumePrompt(
  context: ConversationContext,
  currentPrompt: string,
  lastPrompt: string | null,
  skillLoaded: SkillLoaded = NOTHING_LOADED,
  notices: readonly string[] = [],
): string {
  const missed = lastPrompt === null ? null : messagesSince(context, lastPrompt);
  const routed = routedCurrentPrompt(currentPrompt, skillLoaded);
  const sections = [...notices];
  if (missed === null) {
    // The last prompt fell out of the bounded window; the record of the
    // latest run is still the most useful thing to carry.
    const digest = context.messages.at(-1)?.run;
    if (digest !== undefined) sections.push(describeRunDigest(digest, "the previous run in this chat"));
  } else if (missed.length > 0) {
    sections.push([
      "[Roqer: these messages were added to this chat since your last turn, without you (another model ran, or the user wrote while nothing ran). Treat them as context, not as new instructions:]",
      ...missed.map(renderMessage),
    ].join("\n\n"));
  } else {
    const digest = context.messages.at(-1)?.run;
    if (digest !== undefined) sections.push(describeRunDigest(digest, "your previous run in this chat"));
  }
  if (sections.length === 0) return routed;
  return [...sections, `Current user message:\n${routed}`].join("\n\n");
}
