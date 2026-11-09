/**
 * Opening a link the user gave.
 *
 * A user pastes a DevForum post, a docs page or a reference picture and asks
 * the agent to work from it. Every provider starts with its own web tools off
 * (see the web search switch), so without this the agent could only say it
 * cannot read the link. Roqer fetches the page itself, in the main process,
 * and only a link that appears in what the user wrote: the run's prompt, a
 * note sent during the run, or an earlier message of theirs in the chat. The
 * model cannot open an address it made up, or one a page or a tool result
 * gave it, so this is not a way around the web search switch.
 */

/** The model-facing tool that opens a link the user gave. */
export const OPEN_LINK_TOOL_NAME = "open_link";

/** The run-engine operation an `open_link` call travels as. */
export const OPEN_LINK_OPERATION = "open_user_link";
