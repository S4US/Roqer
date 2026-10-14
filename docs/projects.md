# Projects: roles, notes, files and long chats

A project in Roqer groups the chats about one game. Beyond the chats
themselves, a project keeps three things every chat in it can use: a **master
plan**, a **project memory** and a pool of **project files**. Each chat can also
take a **role**, so one chat is your scripter, another your modeller, and a
third the planner you talk big decisions through with, each on the model and
effort that suit it.

What reaches the model differs by provider. Roles' instructions, the notes and
the project files are offered to **Claude** chats (through Claude Code), which
also keep their conversation between runs (see [Long Claude chats](#long-claude-chats)).
A role's model and effort choice works for every provider.

## Roles

Pick a chat's role with the **Role** menu at the top of the chat: General (no
role), Scripter, Modeller or Planner. The sidebar shows the role as a coloured
tag next to the chat's name.

- **Each role remembers its own model and effort.** While a chat has a role,
  the model and effort menus in the composer set that role's choice, and every
  chat with the role uses it. A Planner on your strongest model at high effort
  and a Scripter on a faster one stay that way without switching back and
  forth. A role you never set up starts from the workspace's own choice, and
  General chats keep using the workspace's choice.
- **Each role tells Claude its job.** These are Roqer's own instructions, the
  same for everyone, not text you edit.
  - The **Scripter** writes, wires up, debugs and tests the game's code, and
    builds what the master plan describes.
  - The **Modeller** builds 3D assets with the Blender tool in stages, looks at
    every result from the angles that matter, saves finished models to the
    project files, and does not upload them unless you ask.
  - The **Planner** is a design partner: mechanics, progression, scope and
    priorities. It keeps the master plan current with what you decide and does
    not edit the place unless you ask.

## Master plan and project memory

Open them with the **Project notes** button (the notebook icon) in the top bar.

- The **master plan** is one document for the whole game (up to 60,000
  characters). You can write it yourself, and a Claude chat can read it, rewrite
  it, or change one passage of it with the `master_plan` tool.
- The **project memory** is a list of short lasting facts ("R6 avatars only",
  "the shop sells in Scrap, never Robux"), up to 200 of them and 1,000
  characters each, kept with the `project_memory` tool or by you.

**How Claude is given them.** The notes are text you and the agent write, so
they reach Claude as **project data, not instructions**:

- Claude's system prompt holds only Roqer's own guidance on keeping the notes,
  and says their contents are project data that never override your messages.
- The contents go in front of the chat's message, inside `<project-notes>`: the
  first time a conversation is given them, again when they changed since (you
  edited them, or another chat did), and again after the conversation was
  compacted, since a summary may not keep them word for word.

**The agent's changes are steps in the run.** Each `master_plan`,
`project_memory` and `project_files` call shows in the run like any other tool
call, and follows the run's approval mode. Reading needs no approval. A change
is refused in **Read only**, asks first in **Ask first**, and goes ahead in
**Auto approve** and **Full auto**.

The notes are stored in Roqer's data folder under `project-notes`, one file per
project. A file that cannot be parsed is set aside as `<project>.json.damaged-<time>`
rather than written over, one that cannot be read just now (locked by another
program) is left alone and the change is refused, and one saved by a newer
Roqer is read but never changed.

## Project files

The **Files** button in the top bar opens the project's files: models, images,
documents and anything else the chats should share, such as the game's design
document or a model you made elsewhere.

- **Add files** by dragging them onto the Files panel or onto the composer, or
  with **Add files…**. Pictures and video dropped on the composer still attach
  to that message as before; other files go into the project files and are
  shared with the chat.
- **Share a file with a chat** with its **Shared here** box, or drag the file
  onto a chat in the sidebar. A file dropped from your computer onto a chat in
  the sidebar is added and shared in one step. A chat's shared files show as
  chips above the composer, and Claude is told about them with every message.
- **Any Claude chat can use any file** in the project, shared or not, with the
  `project_files` tool: list them, read a text file, get a model's path to
  inspect it in Blender, attach a note, or save a model it made. An agent can
  only save files from its own Blender jobs into the project, not copy
  arbitrary files from your computer.
- **Look before you use.** Click a file to view it: models (FBX, GLB, glTF,
  OBJ) open in the same 3D viewer as Blender previews, images and text show as
  they are.
- **Send to Studio** uploads a model to Roblox and inserts it into the chat's
  place (see below). Roblox takes models as FBX or GLB, so the button shows on
  those; export an OBJ or a multi-file glTF as GLB to send it.

Each project holds up to 500 files of up to 512 MB each; the viewer opens files
up to 96 MB. Files are copied into Roqer's data folder under `project-files`,
so they stay even if you move or delete the original. **Show in folder** opens
a file's copy.

Each project's list of files (`index.json`, versioned) is kept as carefully as
the notes:

- If it cannot be read just now, nothing is changed, and adding a file says so.
- If it is damaged, it is kept as `index.json.damaged-<time>` and the list is
  rebuilt from the files themselves, so no file drops out of the project. Only
  what the list said about a file (its note, its asset id) can be lost.

## Checking a model, then sending it to Studio

A model the Modeller builds shows its preview in the chat, and the preview opens
in 3D. Under it are two buttons:

- **Save to project** keeps the model's exported file (the FBX or GLB the job
  wrote) in the project files. A Blender job's folder is deleted after seven
  days; a saved model stays.
- **Send to Studio** uploads the exported file to Roblox as a Model, waits for
  Roblox to finish processing it (up to 90 seconds), and inserts it into the
  chat's place. When the job exported a format Roblox does not take (OBJ,
  glTF), the preview's own GLB is sent instead.

Sending to Studio:

- **Asks first.** An upload cannot be taken back, so Roqer names the file and
  the place it goes into, and says it goes to your Roblox account and through
  Roblox moderation, before uploading anything. (When the agent uploads with
  `upload_asset`, that call always asks too, outside Full auto.)
- **Checks the place before uploading.** The chat's place (the one its runs
  worked in, or the one you picked for it) must be open in Studio. A chat with
  no place of its own needs exactly one open place: with several open, Roqer
  asks you to choose instead of guessing. Either way, nothing is uploaded until
  the place is there.
- **Never uploads the same file twice.** Each send is recorded by the file's
  contents in `studio-sends.json` in Roqer's data folder: the operation id as
  soon as Roblox takes the upload, and the asset id once Roblox has processed
  it. Sending the same file again (after Roblox took too long, after the insert
  failed, after you stopped it, or from a second click) checks that upload or
  inserts that asset instead of uploading another. A changed file, such as a
  re-export, is uploaded as a new asset. If Roblox refuses the model while
  processing it, the record is dropped so the next send tries afresh.
- **Can be stopped** with **Stop** while it works. A stop never cuts an upload
  or an insert off halfway: an upload Roblox may already have is finished and
  recorded first, so sending again picks it up. Quitting Roqer stops sends the
  same way and waits for that record to be written.

If Roblox does not answer the upload at all, Roqer cannot know whether it went
through, and says so rather than sending again by itself.

Sending needs an Open Cloud API key with Assets write access, set under
**Settings → Roblox → Open Cloud** (see
[Roblox Open Cloud in Roqer](configuration.md#roblox-open-cloud-in-roqer)). If
the key is missing or refused, the send says so and nothing is inserted.

The agent itself can look at a model from any angle before you do; see
[Looking closer](blender.md#looking-closer).

## Deleting a chat or a project

Deleting a chat also removes what Roqer keeps for it outside the chat list: its
saved Claude session entry and the transcript Claude Code wrote for it (see
below), and any provider process still open for it. Deleting a project does the
same for each of its chats, and also deletes the project's files and notes.
Neither can be undone.

## Long Claude chats

A Claude chat keeps its Claude Code conversation between runs, and after Roqer
restarts. The next message resumes it, so Claude remembers the whole chat
rather than a replayed summary of it.

### What is kept, and where

Each Claude chat has one Claude Code conversation (a "session"). Roqer
records which session belongs to which chat in `claude-sessions.json` in its
data folder (on Windows, `%APPDATA%\Roqer`). The file holds only the session
id, the chat's last prompt, its Studio place and its model.

The conversation itself is kept by **Claude Code**, not Roqer: **every Claude
chat's full transcript is saved under `~/.claude/projects/`** (or
`$CLAUDE_CONFIG_DIR/projects/` when that is set), in a folder named after
Roqer's data folder, for example `C--Users-you-AppData-Roaming-Roqer`. That is
everything sent and received in the chat: your messages, Claude's replies and
reasoning, and the results of its tool calls, such as script source it read.
Before this, Roqer started Claude Code with `--no-session-persistence` and
nothing was kept there.

- Claude Code deletes transcripts older than its `cleanupPeriodDays` setting
  (30 days unless you change it). When a chat's transcript is gone, Roqer
  notices, forgets the session, and starts a new one from the chat's history.
- Deleting a chat in Roqer deletes its transcript too. To remove one
  yourself, delete its `.jsonl` file from that folder, or the whole folder.
  Roqer starts that chat's next conversation fresh in the same way.

### What a resumed chat is told

When another provider ran in the chat since Claude's last turn, or you wrote
while nothing ran, Claude is told what it missed when it resumes, and nothing
more. A chat moved to a different Studio place is told so, since what Claude
read earlier describes the other place.

A Claude Code process is reused while the chat's model, effort, place and
tools stay the same. Otherwise the process is closed, and the next run resumes
the saved session under the new settings.

### Notes while Claude works

A note you send while a Claude run works reaches Claude at its next step,
beside the result of the tool call in progress, the way a message typed into
Claude Code mid-turn does. It does not wait for the turn to end.

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

### Compacting

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
