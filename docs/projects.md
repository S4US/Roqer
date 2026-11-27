# Long Claude chats

A Claude chat keeps its Claude Code conversation between runs, and after Roqer
restarts. The next message resumes it, so Claude remembers the whole chat
rather than a replayed summary of it.

## What is kept, and where

Each Claude chat has one Claude Code conversation (a "session"). Roqer
records which session belongs to which chat in `claude-sessions.json` in its
data folder (on Windows, `%APPDATA%\Roqer`). The file holds only the session
id, the chat's last prompt, its Studio place, its model, and what the
conversation has spent so far, which is how a resumed run reports its own
tokens and cost rather than the whole chat's.

The conversation itself is kept by **Claude Code**, not Roqer: **every Claude
chat's full transcript is saved under `~/.claude/projects/`** (or
`$CLAUDE_CONFIG_DIR/projects/` when that is set), in a folder named after
Roqer's data folder, for example `C--Users-you-AppData-Roaming-Roqer`. That is
everything sent and received in the chat: your messages, Claude's replies and
reasoning, and the results of its tool calls, such as script source it read.
Before this, Roqer started Claude Code with `--no-session-persistence` and
nothing was kept there.

- Deleting a chat in Roqer deletes its transcript and its row in
  `claude-sessions.json` with it. Deleting a project does the same for every
  chat in it.
- Claude Code deletes transcripts older than its `cleanupPeriodDays` setting
  (30 days unless you change it). When a chat's transcript is gone, Roqer
  notices, forgets the session, and starts a new one from the chat's history.
- To remove one yourself, delete its `.jsonl` file from that folder, or the
  whole folder. Roqer starts that chat's next conversation fresh in the same
  way.

## What a resumed chat is told

When another provider ran in the chat since Claude's last turn, or you wrote
while nothing ran, Claude is told what it missed when it resumes, and nothing
more. A chat moved to a different Studio place is told so, since what Claude
read earlier describes the other place.

A Claude Code process is reused while the chat's model, effort, place and
tools stay the same. Otherwise the process is closed, and the next run resumes
the saved session under the new settings.

Each chat keeps its own thinking effort. Choosing one in a chat changes only
that chat, and a new chat starts with the last effort chosen.

While Claude thinks before its first word, the waiting card shows how long it
has been thinking and, with Claude Code 2.1.325 or later, a summary of its
reasoning as it goes: the latest line on the card, and under "Show reasoning"
every thought of the run so far, in order. The reasoning is live only and is
not kept in the chat. Hide it in Settings, under App; the switch takes effect
at once, so turning it back on during a run shows what the run has thought.
With an older Claude Code the card counts the tokens thought so far instead.
One response can think for many minutes.

## Notes while Claude works

A note you send while a Claude run works reaches Claude at its next step,
beside the result of the tool call in progress, the way a message typed into
Claude Code mid-turn does. It does not wait for the turn to end.

A note can carry pictures: paste, drop or attach them while the run works, and
they reach Claude in the same message as the note's words. Pictures sent with
nothing written are a note of their own. Only Claude runs take pictures in a
note; with another provider, send them with your next message.

Under the run, each note shows where it is:

- **Queued** until Claude Code puts it in front of the model. Roqer starts
  Claude Code with `--replay-user-messages`, so Claude Code echoes each
  message at the moment the model is given it, and that echo is what marks a
  note **Delivered**.
- When a turn ends before the model reached a note, Claude Code starts a new
  turn for it by itself, and the run continues through that turn: its reply
  is part of the run.
- If that turn never starts, the run ends after a minute, the note is marked
  **Not delivered** so you can send it again, and the Claude Code process is
  closed rather than kept for the next message, so it cannot answer the note
  with no run to show it.

Other providers take notes when their turn ends, as before.

## Compacting

Claude Code compacts the conversation by itself when its context fills. To do
it sooner, open the context meter in the composer's corner and choose
**Compact chat**:

- In a Claude chat with a saved conversation, Claude summarizes it with Claude
  Code's own `/compact`. That is one model call and can take a minute. A
  message you send meanwhile waits and goes once compacting finishes, and a
  run never starts on a conversation being compacted.
- Otherwise the chat's older messages are folded into a record Roqer writes
  from what the chat recorded, and the provider's copy of the conversation,
  including a saved Claude one, is forgotten, so the next run starts from that
  record.

Either way every message stays on screen; only what the model reads changes.
