# Feature ideas

A brainstorm, written on 2026-11-05. It is context, not a plan: nothing here
is accepted work, and nothing here changes what the code does. Each idea says
what it is, why it is worth doing, where it fits in the architecture, and a
rough cost (S: days, M: a week or two, L: more). The shortlist at the end is
the only part in priority order.

The ideas come from reading the code, the docs and the plans, the eval
harness, the open issues and pull requests, the release notes, and what
Roblox's own Studio agent can do now.

## Where Roqer stands

What exists today:

- A Studio MCP with 52 tools, an inspector edition with 25 read-only ones, and
  a Studio plugin with edit, server and client peers.
- A desktop agent on the user's own model: ChatGPT through Codex, Claude
  through Claude Code, Gemini through the Antigravity CLI, or any
  OpenAI-compatible, Responses or Anthropic endpoint.
- Four approval modes, risk per tool, and a completion gate that refuses to
  call a run verified without evidence.
- Revision-checked script writes, atomic builds, Rojo file-backed edits,
  Blender modeling, a rig and animation pipeline, VFX craft, UI themes, and
  the user's own MCP servers.
- Parallel chats with one writing run per place, kept Claude conversations,
  manual compaction, Linux through Vinegar, and twenty seeded eval tasks.

What the plans defer: faces, fingers, IK feet and crowds in animation; fluid
flipbooks and AI textures in VFX; rig declarations written by hand for custom
creatures; property edits and binary models in Rojo projects; macOS.

What users asked for: a compact for every provider (#63), web search (#68),
a place to share prompts (#65), and setup that fails less (#91, #59). A
project workspace with notes, roles, files and Send to Studio is in review
(#97). The Discord invite in the README has expired (#103).

## What Roblox's own agent does now

In April 2026 Roblox made Studio's Assistant agentic: a planning mode, mesh
generation, a playtesting agent in beta that drives the player character as a
tester, and an MCP server built into Studio with a Quick Connect for outside
clients such as Claude and Cursor. Its roadmap names parallel agents and
long cloud workflows. Sources:
[Roblox newsroom](https://about.roblox.com/newsroom/2026/04/roblox-studio-going-agentic),
[TechCrunch](https://techcrunch.com/2026/04/16/robloxs-ai-assistant-gets-new-agentic-tools-to-plan-build-and-test-games/),
[DevForum: Studio MCP Server updates](https://devforum.roblox.com/t/studio-mcp-server-updates-and-external-llm-support-for-assistant/4415631),
[the standalone server, now deprecated](https://github.com/Roblox/studio-rust-mcp-server).

Roqer should not race that agent on zero-setup integration. Its edge is what
a built-in agent will not do:

- the user's own model and subscription, including local models;
- evidence the host checks, not claims the model makes;
- approvals, risk, and a policy that lives in the runtime;
- files and git through Rojo;
- Blender, rigs, animation and VFX as one pipeline;
- any other tool through MCP;
- open source.

Most ideas below deepen one of those.

## 1. Safety and trust

### 1.1 Undo a run

**What.** A button on a finished run: put back everything this run changed.

**Why.** Studio's own undo covers one Studio session and mixes with the user's
own edits. A run that went wrong is found later, often after Studio
restarted. Today the user repairs by hand or asks for another run. Undo makes
Auto approve safe to use, which is the mode most people want.

**How.** The host already records every change with the revision it
produced. Add a reverse ledger per run, kept beside the run's pictures: the
full source before each script write, the previous values of each property
write (the plugin snapshots them already for its own rollback, but the result
does not return them: a schema change through every layer), the roots a build
created, and the files a Rojo save touched (it keeps backups of removed files
today). Undo applies the ledger in reverse order, as a run, through the same
policy. Each step is compare-and-set: a script goes back only if its current
revision is the one the run left; otherwise that step is skipped and named.
Uploads and published animations cannot be undone, and the card says so.

**Cost.** L. **Value.** High. It is the most direct answer to the project's
first priority, user safety.

### 1.2 Protected paths

**What.** Per place, a list of instances the agent may never change:
`ServerScriptService.DataService`, `ReplicatedStorage.Packages`, a whole
folder of a live game's economy.

**Why.** People with a live game want help on one feature without risk to the
rest. Today the only tool for that is Ask first, which asks about everything.

**How.** Stored per place with the desktop's other place settings, as a
versioned contract. Enforced in the runtime before dispatch for every
structured mutation by target path; a ref-only target is resolved to a path
with one read first. Luau execution and `find_and_replace_in_scripts` cannot
be checked before they run, so under a protected list they always ask, the
approval card shows the list, and a tripwire reads the protected scripts'
revisions after the call. A change there fails the gate and names the script.

**Cost.** M. **Value.** High.

### 1.3 A risk scan on approval cards

**What.** Short chips above a proposed Luau or Blender script: which services
it touches, what it destroys, what it sends.

**Why.** An approval card shows the whole script, and most people do not read
it. Chips such as `touches DataStoreService`, `destroys 3 instances`,
`HttpService: posts to discord.com`, `requires a remote module 1234567` turn
the card into something a person can judge in two seconds.

**How.** A host-side scan with patterns, no parser needed for the first
version, in `apps/desktop/runtime`. A few findings are hard stops with a
reason the model can read, as writing `Source` from Luau is today: a
`require(<asset id>)` loads code nobody reviewed.

**Cost.** S. **Value.** Medium to high.

### 1.4 A secret scan on script writes

**What.** Warn when a script about to land holds a Discord webhook URL, an
API key, or an Open Cloud key.

**Why.** Roblox developers paste webhooks and keys into scripts, and a model
copies what it reads. A warning on the diff card, and a note to the model to
move the secret into server-side configuration, prevents a leak into a place
that other people can download.

**How.** Patterns on the write path in `studio-tools.ts`, before the write,
with the match in the result the model reads. **Cost.** S.

### 1.5 Static analysis before a write lands

**What.** Run Luau's own analyzer on every script Roqer writes, and on every
script it reads back, and give the findings to the model and the user.

**Why.** Today each write is compiled without being run, so syntax errors are
caught. Type errors and lints are not: an undefined variable, a value written
to a local nobody reads (the T2 eval), a shadowed name. The Script Analysis
pane in Studio sees these, and a plugin cannot read it.

**How.** An optional local binary like Blender: Roqer finds `luau-analyze` or
`luau-lsp` or the user chooses one, with Roblox's global type definitions.
Findings travel in the write result as lints, never as a refusal. For Rojo
projects, StyLua formatting on write when the repository has a config.

**Cost.** M. **Value.** High for code quality on every run.

## 2. Evidence

### 2.1 Watch the playtest

**What.** Record the Studio window during a run's playtest, show the clip in
the results card, and let the model look at its frames.

**Why.** The VFX study measured a Studio capture at 661 to 894 ms, too slow
for motion, so Roqer freezes an effect's clock to photograph it. Gameplay
cannot be frozen. Motion, timing, camera feel and animation blending are the
things a screenshot cannot show, and the things people judge a game by.

**How.** The desktop, not Studio: Electron's window capture finds the Studio
window, records it to a WebM in the run's folder for the length of the
playtest, and samples frames. The reference-clip pipeline already turns a
video into labelled frame sheets with timing and colour for the model; reuse
it, so the model studies its own playtest the way it studies a clip the user
attached. Off by default, a switch beside Playtest to check changes, only the
Studio window, only during a run's playtest, nothing leaves the machine
except the frames the model is shown. Windows first; Linux window capture
goes through the desktop portal and needs its own look.

**Cost.** L. **Value.** High. It also produces the showcase clips the README
is made of, from real runs.

### 2.2 Viewpoints and before-and-after pairs

**What.** Named camera positions per place, and screenshots taken from the
same viewpoint before and after a change, shown side by side with a slider.

**Why.** Comparing two screenshots from different angles proves little. The
building guidance already tells the agent to frame the same container with
the same arguments. Making that a named thing lets the user save views they
care about, and lets the host pair pictures without asking the model.

**How.** `selection view` already frames from an azimuth, elevation and
distance. Store viewpoints per place, record the viewpoint on each screenshot
evidence, and pair them in the results card. **Cost.** S to M.

### 2.3 Performance deltas

**What.** Each run that changes scripts or scenes shows what it did to the
place's cost: instances, triangles, memory by category, and frame time when
a playtest ran.

**Why.** Most Roblox players are on phones. A feature that works but doubles
client memory is a regression nobody notices until the ratings drop. The
profilers and the scene analysis exist; nobody collects a baseline.

**How.** The host, before the run's first mutation and after its last, under
the same conditions, with the delta on the results card. An optional budget
per place turns a large regression into an unverified result with a reason.
**Cost.** M.

### 2.4 A QA bot for gameplay tests

**What.** One operation that drives the player character: move to a point or
along waypoints, jump, equip a tool, use it, press a key, wait for a
condition, and report position, health, leaderstats and what is near, with a
screenshot at each stop.

**Why.** The agent can do this today through `eval_client_runtime`, which is
arbitrary code: an approval each time outside Full auto, and many tokens for
the same snippets again and again. Roblox's own playtesting agent is built on
exactly this. The public surface is budgeted, so this should be one operation
with a bounded step list, rated a mutation, since it changes only a playtest.

**How.** Plugin handler in the client peer, schema, routing, risk, inspector
list, tests: the usual eight layers. **Cost.** M to L. **Value.** High.

## 3. Real projects: Rojo, git, CI

### 3.1 Commit this run

**What.** On a Rojo-linked place in a git repository, a button on the results
card: commit exactly the files this run saved, with a message drafted from
the run's summary.

**Why.** File-backed edits exist so that changes show up in `git diff`. The
next thing every Rojo user does is commit them. Doing it from the card ties
the commit to the run that made it and its evidence.

**How.** The core already asks git how it classifies a project's files. The
main process stages the listed files only, commits after a confirmation
where the message can be edited, never pushes, and shows the hash. A setting
can commit after each verified run. **Cost.** S to M.

### 3.2 Rojo depth

**What.** Save property edits on project-owned instances to Rojo meta files,
and save small new models as `.model.json` instead of binary `.rbxm`.

**Why.** Both are listed limitations: a property change on something the
project owns is Studio-only today and Rojo can put the file's version back,
and a binary model has no line diff. Meta files and JSON models make both
changes reviewable. **Cost.** M to L.

### 3.3 A conventions file in the repository

**What.** A `ROQER.md` at a Rojo project's root, read as project data at the
start of a conversation and again when it changes.

**Why.** Teams keep conventions in git, not in an app: the framework, naming,
where services go, what never to touch. #97 adds notes stored by the app;
this is the same idea for people whose source of truth is the repository.
The framing is the one #97 settled on: data, not instructions.
**Cost.** S, after #97.

### 3.4 Headless runs for CI

**What.** A command line: open this place file in Studio, run this prompt in
this mode on this provider, write a report, close Studio.

**Why.** A nightly "audit this game for exploits", "run the test suite and
explain the failures", or "check the shop on five devices" is what serious
studios want, and every piece exists: managed Studio launches from a local
file, the headless engine the eval harness drives, the completion gate and
the run digest. **Cost.** M, mostly packaging.

## 4. Studio-side ergonomics

### 4.1 The selection as context

**What.** A chip in the composer: "Using your Studio selection:
`Workspace.Tower` (Model, 42 parts)", on by default, one click to drop it.

**Why.** People point at things by selecting them. Today they type the path,
often wrongly, or the agent spends calls finding what they meant.

**How.** The desktop reads the selection through the existing `selection`
operation when the composer is focused, and sends a host-authored line with
the prompt. No new channel: it is host-derived data, like the run digest.
**Cost.** S. **Value.** High for its size.

### 4.2 Ask Roqer from Studio, and see it working there

**What.** A toolbar button in the plugin that sends the selection to Roqer's
composer and brings the window forward; the plugin widget shows what the run
is doing ("writing `Shop.client.lua`") and has a Stop button.

**Why.** Studio is where the user is. Seeing a script change under the cursor
with no sign of why is unsettling. Approvals must stay in the desktop, because
the plugin's endpoints are tokenless, but a prefilled prompt the user still
has to send, a status line, and a stop are all safe in the deny direction.
**Cost.** M.

### 4.3 Error watch during the user's own playtests

**What.** When Studio is in play mode and no run is active, a small banner:
"4 errors in your last playtest. Fix with Roqer?", prefilled with the traces.

**Why.** The copilot that notices is the one people keep open. It never starts
a run by itself. **How.** The desktop polls `get_runtime_logs` for errors at
a low rate while health shows a playtest, and otherwise does nothing.
**Cost.** S to M.

### 4.4 Comment on a diff line

**What.** A button in the diff gutter that drafts a note to the running task,
or the next prompt, naming the script and line.

**Why.** "Wrong script, the server one" is the mid-run note that exists; most
corrections are about one line. **Cost.** S.

## 5. Long work, cost and context

### 5.1 A prompt queue, for overnight work

**What.** Several prompts queued on one place, run one after another, each
with its own mode and its own gate, stopping on the first unverified result
if the user wants, with one summary in the morning.

**Why.** One writing run per place already exists, and Full auto exists for
unattended runs. With undo (1.1) and protected paths (1.2) this becomes a
credible way to hand Roqer an evening of work. **Cost.** M.

### 5.2 Budgets and a usage ledger

**What.** Per-run caps the user sets: minutes, tool calls, and tokens or an
estimated price for a configured endpoint. A per-project ledger of what each
model spent.

**Why.** Usage is already measured per run and per request. People on a key
want a ceiling; people on a subscription want to see where their allowance
goes. **Cost.** S to M.

### 5.3 A model-written compact for every provider

**What.** The roadmap item and #63. Claude chats have it. The custom provider
runs Roqer's own loop, so one extra model turn can write the summary beside
the host's record; Codex can use its own compaction when the app server
exposes it. **Cost.** M.

### 5.4 A web search switch

**What.** The roadmap item and #68. A per-chat switch; provider-native search
where it exists, each search shown in the activity, results framed as
third-party data the way MCP results are, and a warning in Full auto, since
a page can try to steer the agent. **Cost.** S to M.

### 5.5 Webhook notifications

**What.** A user-provided webhook URL, usually Discord's, that gets "the run
needs you" and "the run finished", with no place name unless the user allows
one.

**Why.** Roblox developers live in Discord, and a long Full auto run is what
someone starts and walks away from. The system notification exists; this is
the version that reaches a phone. **Cost.** S.

## 6. Creative capability

### 6.1 A terrain tool

**What.** One operation with actions: fill a region with a shape and
material, paint, smooth, clear a region, raise from a heightmap image a
Blender job rendered, assign materials by height and slope, and read an
occupancy summary.

**Why.** The world plan's rule is that natural ground is Terrain, and the
only way to make Terrain today is arbitrary Luau: an approval per call, and a
model that writes voxel loops from memory. A structured tool is cheaper in
tokens, undoable in one step if Studio records terrain writes in a recording
(to verify live), and a mutation rather than an irreversible action. The
inspector edition gets the read only. **Cost.** M to L. **Value.** High for
every map.

### 6.2 An asset ledger

**What.** Everything Roqer uploaded for this account: models, decals,
animations and sounds, with thumbnail, asset id, moderation state, the job
and chat that made it, and a content hash. Searchable by the user and
readable by the agent, with "insert again" and no second upload.

**Why.** Uploads are irreversible and moderated, and the same barrel gets made
twice. #97's send ledger already keys files by hash; this makes the record
first-class. **Cost.** M.

### 6.3 Animation, from the plans' deferred list

IK feet for slopes and stairs, face expressions through FaceControls, curve
animation export, and crowds with level of detail. IK feet first: it is the
one the eye catches on every NPC. **Cost.** L each.

### 6.4 Sound in the chat

**What.** A Sounds tab in the results card that plays previewed Creator Store
audio and sounds uploaded through an external MCP server such as ElevenLabs.
**Cost.** S.

## 7. Adoption and community

### 7.1 A setup doctor

**What.** A page of live checks with a fix next to each: Studio found, plugin
installed and matching, plugin connected, HTTP requests enabled, third-party
assets allowed, the provider's client installed, signed in and a supported
version, and Roqer's tools visible to that client.

**Why.** #91 is "Claude Code did not load the Roqer tools", with no
diagnostics attached; #59 was a playtest nobody could see. Copy diagnostics
exists; a checklist turns a report into a fix. **Cost.** S to M.
**Value.** High for everyone who installs and gives up on day one.

### 7.2 Prompt recipes

**What.** `/audit`, `/explain-place`, `/mobile-check`, `/polish-ui` and the
user's own, as templates with a few fields, stored in the workspace and
exportable as a file to share on Discord (#65), with a folder in the
repository for community recipes.

**Why.** The skill pack knows how to do these; people do not know to ask.
**Cost.** S to M.

### 7.3 Run report export

**What.** One Markdown or HTML file per run: prompt, plan, diffs, pictures and
the gate's verdict, with place names and paths removed by default, for a
DevForum or Discord post. **Cost.** S to M.

### 7.4 A model report card

**What.** Run the twenty eval tasks per model each month and publish pass
rates and cost in the docs.

**Why.** "Which model should I use" is the first question in every community,
and Roqer is the one tool that can answer it on the same tasks. It also
catches regressions in Roqer's own guidance. **Cost.** Compute, not code.

### 7.5 Platforms

macOS, which the roadmap names: the plugin folder, Studio discovery, and no
texture preview inside the signed app. A signed Windows installer, so
SmartScreen stops warning. A Linux package, so Vinegar users do not build
from source. Also, a permanent Discord invite (#103).

### 7.6 The desktop in more languages

Roblox's developers are global and young. The agent already answers in the
user's language; the window does not. Start with the languages the Discord
shows. **Cost.** M.

## Shortlist

In the order I would do them. Value is to the user; cost is as above.

| Order | Idea | Value | Cost | Why in this place |
| --- | --- | --- | --- | --- |
| 1 | 4.1 The selection as context | High | S | Smallest change with the largest daily effect |
| 2 | 7.1 A setup doctor | High | S to M | Turns #91-style reports into fixes; every new user passes through it |
| 3 | 1.3 and 1.4 Risk and secret scans | Medium to high | S | Makes every approval card informative |
| 4 | 1.2 Protected paths | High | M | The feature that lets owners of live games use Auto approve |
| 5 | 3.1 Commit this run | High for Rojo users | S to M | Finishes what file-backed edits started |
| 6 | 6.1 A terrain tool | High | M to L | Removes the biggest source of arbitrary Luau in world runs |
| 7 | 1.1 Undo a run | High | L | The flagship safety feature; needs the property schema change |
| 8 | 2.1 Watch the playtest | High | L | The flagship evidence feature; nothing else shows motion |
| 9 | 5.1 A prompt queue | High for power users | M | Credible only after 4 and 7 |
| 10 | 2.4 A QA bot | High | M to L | Gameplay evidence at a fraction of today's tokens and approvals |
| 11 | 1.5 Static analysis | High | M | Catches the bugs that compile |
| 12 | 4.3 Error watch | Medium to high | S to M | The copilot that notices |

Quick wins under a day each: 4.4 comment on a diff line, 5.5 webhook
notifications, 6.4 sounds in the chat, the permanent Discord invite, and a
first version of 7.2 recipes.

Already promised on the roadmap and not repeated here as new: 5.3 compaction
for every provider and 5.4 web search.

## Things not to do

- **Approvals or free text from the Studio plugin.** Its endpoints are
  tokenless, so anything from it is untrusted. A prefilled prompt and a stop
  button are the safe directions; an approval or a message is not.
- **A second text channel from the renderer to the model.** The prompt and
  the mid-run note are the channel. Editing a proposed script inside the
  approval card, for example, would be a third.
- **A hosted service.** Every idea above runs on the user's machine with the
  user's keys. A relay for notifications or sharing would be the first thing
  Roqer depended on.
- **A tool for every convenience.** The public catalog is budgeted. The QA
  bot and the terrain tool earn a place because arbitrary Luau is the
  alternative; most other needs are a skill, a recipe, or host orchestration.
- **AI-generated textures and marketplace code vendoring.** Both are in the
  VFX plan's deferred list for reasons that still hold: moderation with no
  originality assurance, and unchecked licences.
