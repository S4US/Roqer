# Roqer agent evaluation harness

A production-path evaluation harness with deterministic place reset, twelve seeded
tasks, numeric per-turn telemetry for Roqer's own agent loop, and a JSONL
trajectory per run.

It exists to be *run*, not to be complete. Arms, a factorial design, and token
accounting for the MCP tool catalog were all specified once and deliberately
left out; none of that is worth building before there is one reproducible
trajectory to read. What is here measures Roqer end to end — the real run
engine, real policy, real approvals, the real completion gate — because a
harness that reimplemented the run loop would be measuring itself.

## Running it

Requires a live MCP bridge with Roblox Studio connected. Two providers can
drive it:

- `claude` (the default) runs Claude Code on your own Claude subscription. It
  needs a signed-in Claude Code CLI.
- `endpoint` runs a model on an OpenAI-compatible or Anthropic endpoint through
  Roqer's own agent loop, exactly as the app's Custom provider does. It needs
  `--base-url` and `--model`, and reads the endpoint's key, if it needs one,
  from `ROQER_EVAL_API_KEY` so the key stays out of shell history and is never
  written to the trajectory. Pass `--images` and `--reasoning` when the model
  takes them.

From the repository root, where the rest of the toolchain is driven from:

```bash
npm run eval                                         # Claude Code, every task
npm run eval -- --task T1-property-write             # one task
npm run eval -- --provider claude --model opus --effort high
ROQER_EVAL_API_KEY=... npm run eval -- --provider endpoint --format openai \
  --base-url https://openrouter.ai/api/v1 --model deepseek/deepseek-chat
```

Or directly, from the workspace:

```bash
cd apps/desktop
tsx eval/run.ts --task T1-property-write
tsx eval/run.ts --provider endpoint --format anthropic --base-url https://api.anthropic.com/v1 --model claude-opus-5-5 --images --reasoning
```

A run that ends before the agent finishes prints `STOPPED` with the reason, and
its verdict line carries `stoppedBy`; the oracle's detail on such a run
describes an interrupted place, not the agent's result.

**This changes the connected place.** Every task destroys and rebuilds
`ServerStorage.WorkbenchEval`, and the agent then edits inside it. The world
tasks also destroy and rebuild `Workspace.WorkbenchEvalIsland` or
`Workspace.WorkbenchEvalMeadow`, `Workspace.WorkbenchEvalRepair`, or
`Workspace.WorkbenchEvalVillage`, `Workspace.WorkbenchEvalAdventure`, or `Workspace.WorkbenchEvalCart`; T8 adds
Terrain that no reset removes.
Point it at a scratch place, never at real work.

Results land in `eval/results/<taskId>.jsonl` (gitignored). Each file is one
`run` header line, one `event` line per run event in engine order, one `turn`
line per model turn, and one `verdict` line.

The `turn` lines are what make the latency figures readable as a trend rather
than a total. Each carries the four phases, `requestCharacters`, whatever usage
the provider reported, and that turn's own tool time. A wait that is flat across
a run is a fixed cost upstream; one that climbs with `requestCharacters` is
prompt processing, and only the second is something this end can fix.

## The tasks

| Id | Shape | What it is for |
| --- | --- | --- |
| `T1-property-write` | clean mutation, no fault | the ordinary path works at all |
| `T2-seeded-fault` | reward written to a dead local | diagnosis that needs the script read and understood, not compiled |
| `T3-runtime-evidence` | fault only visible when the place runs | the completion gate: a run that claims success without runtime evidence must fail |
| `T4-ui-create` | six-card simulator shop | reference-shaped UI creation with semantic and visual validation |
| `T5-ui-three-change-edit` | three independent builder edits | edit batching, builder authority, and visual freshness |
| `T6-purchase-price-debug` | two displayed prices, one hardcoded deduction | diagnosis, minimal repair, two real interactions, and runtime logs |
| `T7-world-blocky-island` | stylized island with two elevations, a path, trees, and a spawn | construction follows the style: Parts, not Terrain, at scale and within a part budget |
| `T8-world-realistic-meadow` | realistic rolling hills | the counterpart to T7: natural continuous ground should be Terrain |
| `T9-world-visual-repair` | one conspicuous bad tree in Cove beside an intact Ridge | screenshot → local diagnosis → bounded repair → structural readback → second screenshot, without collateral rebuilds |
| `T10-world-lowpoly-village` | kit-built houses, a landmark, paths, and a spawn | a composed village: kit reuse with variants, saved intent, a landmark above the houses, a path network that reaches every house and the spawn, a final-state screenshot, and a playtest |
| `T11-world-adventure-edit` | a seeded three-zone map with a broken bridge and a user-moved Well | extending and repairing an existing world: the bridge to walking height, a new registered zone joined to the route, and every other zone, the kits and the user's edit left exactly as they were |
| `T12-model-prop` | a handcart modeled in Blender | the modeling path end to end: a Blender job, an upload, the requested stud size, coloured (in Blender by texture or vertex colours, or on the imported mesh parts in Studio), resting on the ground, anchored, and screenshotted |
| `T13-reference-style` | a small map in the style of an attached reference image | the Blender-first map: reused Blender kits, flat materials where the reference is flat, visual meshes without full-detail collision, plateaus a player can stand on, its own spawn with the place's left alone, the palette in WorldSpec, a final screenshot and a playtest |
| `T14-ui-polished-shop` | "Make a simulator themed shop UI… Make it polished." | the harness's own layout audit of the shop, in its own playtest, comes back clean; at least four buttons; a screenshot after the last interface write; the completion gate |

T7 and T8 are a pair. Either alone rewards a fixed preference; together they
measure whether the agent chooses its construction from the requested style.
Both build in `Workspace` rather than under `ServerStorage.WorkbenchEval`, and
both record the place's Terrain cell count at reset so a reused scratch place
does not credit or blame one run for another's Terrain.

Their prompts place world intent and reusable templates under
`ServerStorage.WorkbenchEval.RoqerWorld`, so the existing reset owns and clears
that metadata between runs. Writes to the global `ServerStorage.RoqerWorld`
remain off-target. Use the named metadata root for each batch because the
harness reports exact changed targets, not arbitrary descendants.

T9 is the first world-quality repair task. Its seeded Cove contains one visually
obvious outlier while Ridge is held by an ObjectValue sentinel. A passing run has
to screenshot before mutation, repair the local asset rather than rebuild the
scene, structurally read the result back, and screenshot again. The oracle is
intentionally loose about the exact green and canopy size; it measures whether
the defect was corrected without rewarding one hidden constant.

T10 is the village baseline. Every hard check names something its prompt asks
for, so a plain village that meets them passes and a pretty one with a house no
path reaches fails. Paths are judged top-down from each part's exact footprint
(`footprints.ts`) rather than its axis-aligned bounds, which would join a
diagonal strip to anything near its corners; a bridge or stair still counts as
touching what it crosses, and the playtest covers what the ground plane cannot.
What is a matter of judgement is recorded, not scored: the probe's `observed`
field holds the material mix, the number of distinct colors, and how many path
pieces are narrower than 6 studs, which a stair tread legitimately is. Read
those beside the screenshots. Its writes may land anywhere under the village or
its `RoqerWorld` (`allowedRoots`), since a build chooses its own sub-roots; the
earlier tasks list exact targets because a write beside them is the failure.

T11 is the large-map scenario, and it starts from an existing world rather
than an empty place, because that is where preservation can fail. The seed
builds Village, Canyon and Forest on raised ground with saved WorldSpec, kits
and zones, then records a fingerprint of every zone the prompt says to leave,
and of the kits and templates. Village's Well has been "moved by a user": its
saved intent says x = -150, the live map has it at -138, and moving it back
fails the run. The bridge is judged by downward rays along the route, two
lines a player's width apart: nothing may drop into the canyon, the gap must be
spanned by the Bridge rather than by filling the canyon, and no step between
samples four studs apart may exceed two studs. Summit is judged only on what
the prompt names: registered, north of Forest, a Landmark, at least one saved
kit, and a Path meeting the end of Forest's north path. A write under Village,
Forest, the kits or the templates fails even if it happens to leave the values
unchanged.

T12 is the modeling baseline, and the only task that needs the local Blender
worker. It runs only with `--blender auto` (or `--blender <path to
blender.exe>`), which offers the planner the same `blender` tool and worker the
app uses when Settings → Blender modeling is on; without the flag it is
skipped and counted as skipped. Its upload goes through the Open Cloud key of
the bridge being driven, so each run publishes a real Model to that account.
The oracle checks what the first real Blender run got wrong or skipped: that a
Blender job and an upload succeeded, that the cart contains the uploaded mesh,
that it is about the requested 8 studs, that it is coloured (a packed texture
or more than one vertex colour on the mesh, or mesh parts painted in more than
one colour in Studio; flat material colours arrive white), that it rests on the
ground under it,
anchored, and that a screenshot follows the last change. Wheel count and style
are left to the screenshot.

```bash
npm run eval -- --task T12-model-prop --provider claude --model opus --blender auto
```

T13 is the first task with an image in its prompt. `referenceImage` names a
file in `eval/fixtures`, and the harness attaches it to the prompt the way the
app attaches a pasted one; the trajectory header names it. The reference,
`fixtures/t13-reference.png`, is an original render of the blocky stylised
look (flat bright colours, red dirt cliffs with a jagged grass edge,
stacked-cube trees, lavender rocks, a pink path, a fence), made by
`fixtures/t13-reference.py` in Blender. Like T12 it needs `--blender`. Its
checks come from a live run of this kind of prompt that built everything from
Parts with textured `Grass`, a muted palette and a pasted-on fringe: at least
three Blender kits and one placed more than once; no visible Part in a
textured material; no visual mesh colliding at full detail (only `Box` or
`Hull`); standing surfaces at least 4 studs apart, found by collision-aware
rays landing face-up on something 6 studs across; a SpawnLocation inside the
map while the place's own spawns stay where they were; WorldSpec with a style
and three or more palette colours; and a screenshot after the last change and
a playtest. How close the map looks to the reference is the screenshot's to
judge.

```bash
npm run eval -- --task T13-reference-style --dry-run
npm run eval -- --task T13-reference-style --provider claude --model opus --blender auto
```

T14 is the user's own UI prompt, and the first task the harness checks itself.
`auditInterface` names a ScreenGui under StarterGui; after the agent stops,
the harness stops any playtest left running, starts its own, waits for the
client, runs `inspect_ui` in audit mode, keeps the findings inside that
ScreenGui, and always stops the playtest. The oracle gets the result as
`interfaceAudit`, and the verdict line records it. So T14 passes only when
Studio measures no covered or edge-crossing text, no content past a scroll
canvas, no text that does not fit and no unreachable control, whatever the
agent checked or said. The probe records signs of polish beside the
screenshot (text elements, how many use `TextScaled`, images and distinct
images) without scoring them.

The completion gate now also holds any run that changed interface until an
`inspect_ui` audit after the last interface change comes back clean, so T4
and T5, which require a verified run, need that audit too.

Run a new task's seed and probe before spending a model run on it:
`npm run eval -- --task <id> --dry-run` seeds, probes and scores the untouched
fixture without a model. The fixture should fail, for the reason its seeded
state implies; a Luau error surfaces here instead of after a paid run.

T3 is the one that earns the harness. It cannot be solved by reading, so an
agent that reports success without a playtest should fail both the oracle and
the gate — and if it passes anyway, the gate is wrong and that is worth knowing.

Endpoint trajectories include model turns, stalled turns, distinct tools, calls
before the first mutation, reads, writes, skill loads, task updates, playtests,
screenshots, UI interactions, failed calls, repair loops, tool-result
characters, peak request characters, accumulated context tokens, and measured
input/output/cache usage when the upstream provider reports it. Stalls are
counted on their own rather than folded into failures: a model that answers the
socket while getting nowhere is a property of that model and effort, and
averaging it into "the run failed" hides which arm is doing it. Claude trajectories retain the
provider-neutral Studio metrics but do not invent unavailable token figures.

## Does Blender colour survive upload?

`npm run eval:colors` answers one question without driving a model: when a
Blender model reaches Roblox, which colours survive? Flat material colours do
not (the barrel and the cart both arrived white). The probe tests the two other
carriers: one 4-stud cube coloured only by an image texture packed into its
GLB, and one coloured only by per-vertex colours (`COLOR_0`). It runs one
Blender job, checks each file carries its colour, uploads both as Models,
inserts them under `Workspace.WorkbenchColorProbe`, and reads back
`MeshPart.TextureID`, any `SurfaceAppearance` colour map, and the mesh's vertex
colours through `EditableMesh`. It prints `kept`, `dropped` or `unknown` for
each, and writes `eval/results/color-probe.json` and a screenshot. `unknown`
means Studio would not let `EditableMesh` read the mesh; judge that cube from
the screenshot.

```bash
npm run eval:colors -- --blender auto
```

Like T12 it needs Roqer's own bridge with an Open Cloud key, and it publishes
two real Models. It leaves the cubes in the place to look at.

The first run, on 2026-09-24 with Blender 5.2.1, printed `kept` for both: the
textured cube arrived with a `TextureID`, the vertex cube's mesh held all four
colours, and both showed their colours in Studio. The building skill now tells
the agent to colour models in Blender that way.

## Can one upload carry a whole kit set?

`npm run eval:kits` answers the question the Blender-first plan depends on:
whether one Blender job and one upload can carry every visual piece of a map,
to be split into templates in Studio, instead of two approvals per piece. One
job makes a cliff section, a stacked-cube tree and a bevelled rock, all
vertex-coloured, and exports them twice: sharing one material, and with a
material each, since Roblox has split imports by material before. Each file is
checked (three meshes, vertex colours, the expected materials), uploaded once
and inserted under `Workspace.WorkbenchKitProbe`. The readback reports, per
upload, whether the pieces arrived as one MeshPart each (recognised by name,
or by size when Roblox renamed them), kept their colours and modelled size,
and kept their spacing. It prints one line of answer, and writes
`eval/results/kit-probe.json` and a screenshot.

```bash
npm run eval:kits -- --blender auto
```

It needs what `eval:colors` needs, and publishes two Models.

## What it does not do yet

World intent and kit reuse also have a [manual cross-session evaluation](world-continuity.md).
It preserves the place across fresh conversations to measure reuse, targeted
repair after a user's edit, and interrupted metadata updates. It is not run by
the reset-per-task harness above; no model-quality result is implied by its presence.

- No arms. One configuration per invocation; comparisons are done by running it
  twice and diffing the trajectories.
- No USD cost calculation. Token and cache usage are recorded, but prices
  belong to whoever serves the model and are not inferred here.
- No competitor baseline. "Roqer versus X" needs X driven through the same
  reset and oracles, which is a larger piece of work than this slice.
- Fourteen tasks. T9 exists because the first recorded world baselines exposed the need for a measured local visual-repair loop, T10 and T11 because the world-building plan's village and large-map baselines had no scored form, T12 because the first real Blender run brought in a model at the wrong scale and in one colour, T13 because a live map built from a reference image came out far from it, and T14 because a live shop passed its own screenshot review with overlapping text; add another only when a real failure or an outstanding baseline motivates it.
