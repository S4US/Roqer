# Projects: roles, notes, files and long chats

A project in Roqer groups the chats about one game. Beyond the chats
themselves, a project keeps three things every chat in it can use: a **master
plan**, a **project memory** and a pool of **project files**. Each chat can also
take a **role**, so one chat is your scripter, another your modeller, and a
third the planner you talk big decisions through with, each on the model and
effort that suit it.

What reaches the model differs by provider. Roles' instructions, the notes and
the project files are offered to **Claude** chats (through Claude Code), which
also keep their conversation between runs. A role's model and effort choice
works for every provider.

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
- **Each role tells Claude its job.**
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

Every Claude chat in the project is given both when it starts, and is told when
another chat changed them since its last turn.

They are stored in Roqer's data folder under `project-notes`, one file per
project.

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
  place in one click (see below). Roblox takes models as FBX or GLB, so the
  button shows on those; export an OBJ or a multi-file glTF as GLB to send it.

Each project holds up to 500 files of up to 512 MB each; the viewer opens files
up to 96 MB. Files are copied into Roqer's data folder under `project-files`,
so they stay even if you move or delete the original. **Show in folder** opens
a file's copy.

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

Sending needs an Open Cloud API key with Assets write access, set under
**Settings → Roblox → Open Cloud** (see
[Roblox Open Cloud in Roqer](configuration.md#roblox-open-cloud-in-roqer)). If
the key is missing or refused, the button says so and nothing is inserted. The
upload goes through Roblox's moderation like any other.

The agent itself can look at a model from any angle before you do; see
[Looking closer](blender.md#looking-closer).

## Long Claude chats

A Claude chat keeps its Claude Code conversation between runs and after Roqer
restarts: the next message resumes it, so Claude remembers the whole chat, not
a replayed summary of it. Roqer records which conversation belongs to which chat
in `claude-sessions.json` in its data folder. When a different provider ran in
the chat meanwhile, or you wrote while nothing ran, Claude is told what it
missed when it resumes.

Claude Code compacts the conversation by itself when its context fills. To do
it sooner, open the context meter in the composer's corner and choose
**Compact chat**:

- In a Claude chat with a saved conversation, Claude summarizes it with Claude
  Code's own `/compact`. That is one model call and can take a minute. A
  message you send meanwhile waits and goes once compacting finishes, and a run
  never starts on a conversation being compacted.
- Otherwise the chat's older messages are folded into a record Roqer writes
  from what the chat recorded, and the provider's copy of the conversation,
  including a saved Claude one, is forgotten so the next run starts from that
  record.

Either way every message stays on screen; only what the model reads changes.
