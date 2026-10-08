# roblox tooling: full reference

> Code examples are illustrative. Adapt them to your project and verify in Studio before production use.

Tooling should make the source tree reproducible without forcing every project into the same framework. Keep the repository's chosen tools visible in its manifest and CI.

## 1. Decide what the project needs

| Need | Useful tool | Keep in mind |
| --- | --- | --- |
| file-to-Studio sync or build | Rojo | define the data-model mapping in a project file |
| third-party packages | Wally or pesde | commit the manifest and lockfile; choose realms intentionally |
| Luau linting | Selene | configure the Roblox standard and project exceptions |
| formatting | StyLua | pin the formatter and run a check in CI |
| standalone scripts | Lune | use only where its runtime libraries are appropriate |
| tool versions | Rokit, or the project's existing manager | one source of truth for versions |
| editor navigation | luau-lsp plus a sourcemap | regenerate the map when the tree changes |

If the project already has a working toolchain, extend it before introducing another manager.

## 1b. Source-of-truth paradigm

Before any file tooling matters, know which side owns the place: Studio or files. This determines what an agent may safely touch and what the failure modes look like.

| Paradigm | Source of truth | Typical setup | Failure mode to guard |
| --- | --- | --- | --- |
| Studio-first | The open `.rbxl` in Studio | Edit directly in Studio; scripts live in the place | No file layer for git, diffing, or CI; agent edits are invisible outside Studio and can be lost |
| Files-first | A repo on disk | Rojo project; `rojo serve` syncs files to Studio | Rojo can overwrite unbuilt Studio edits after a reload; `.rbxl` binary diffs are useless |
| Bidirectional sync | Both, with conflict rules | WEPPY-style or similar plugin that mirrors Studio tree to files both ways | Two sources of truth need explicit conflict resolution (Studio priority, local priority, per-file) or changes silently overwrite each other |

When working with an agentic tool:

- **Detect the paradigm first.** Ask or check: is this a Rojo project (files-first)? Is the place only open in Studio (Studio-first)? Is there a sync plugin with a local mirror (bidirectional)?
- **Never assume both sides are in sync.** Before mutating, read from the source of truth, then write to the same side. After an agent changes files, verify Studio reflects it (and vice versa), especially after a reload.
- **Rojo gotchas:** `rojo serve` watches the filesystem; a script written into Studio by another tool can be overwritten on the next sync, and an agent editing files must run `rojo build` or rely on serve to push. Do not mix MCP-driven Studio edits with a running Rojo serve on the same place without acknowledging which side wins. In Roqer, link the project with `manage_instance` `link_project` first: script edits then save to the file and Rojo syncs them into Studio, as the developer instructions describe.
- **Bidirectional sync gotchas:** conflict resolution is a real decision, not a default. If both sides changed, pick Studio priority or local priority per file and say which; do not apply both silently.
- **Pulling edits out of Studio (Rojo syncback):** since Rojo 7.7.0, `rojo syncback` is the first-party way to convert instances from a saved place file (`.rbxl`/`.rbxlx`/`.rbxm`/`.rbxmx`, via a required `--input`) into files under the project's mapping. It is an offline file pull from a saved file, not live two-way sync; behavior is controlled by `syncbackRules` in the project file. Preview before writing: `rojo syncback --dry-run --list --input <file>` (the project positional is optional and defaults to the current directory). Normal output goes to stderr; always dry-run first, because syncback can delete or rewrite mapped files.

## 1c. Optional ecosystem: name it, do not push

Some tooling improves agent and developer productivity but is not essential to a working Roblox project. An agent should **mention these exist** when a user asks about them or is clearly doing work they would automate (linting, formatting, test orchestration), but **should not impose them** on a project that does not use them:

- **Selene** (lint), **StyLua** (format), **luau-lsp** (editor intelligence), **Lune** (standalone Luau scripts/tests), **Wally/pesde** (packages), **Rokit** (tool manager; Aftman is archived), **Rojo** (files-first sync), **[lest](https://github.com/lest-luau/lest)** (Luau test runner with cloud and Studio backends). [TestEZ](https://github.com/Roblox/testez) is archived; keep it where already used, but do not introduce it as a default for new projects. Where a project has no test runner, lest is one option to mention, not a mandate. Its Studio backend launches edit-mode `RunScript`, not a stepping client playtest; it does not verify hover, live input, or mobile sensors.

### Test-runner doctrine: what each backend can actually prove

Before wiring any test runner (lest, Lune scripts, or a bespoke harness), split suites by what the runtime provides — not by convenience. lest's docs state the transferable rule directly: "**No backend fakes an environment.** Nothing mocks Instances, and nothing reimplements a runtime's standard library. If a test needs an environment, Lest runs it in that environment — partial mocks produce confident wrong tests." (lest `docs/backends.md`, verified 2026-10.)

| Suite type | Where it runs | Can prove | Cannot prove |
| --- | --- | --- | --- |
| Pure logic | embedded/plain Luau VM (lest `native`, instant, per-file isolation, line coverage) | algorithms, state machines, pure functions | anything touching engine APIs — a spec requiring one fails loudly, not silently |
| Script/tooling | real Lune or Lute process (lest `lune`/`lute` backends spawn `lune run`/`lute run`; Lune's `@lune/roblox` library reads/writes place files as data — "more limited API", no running engine) | file transforms, HTTP, place-file manipulation | a live Instance tree with running simulation |
| Engine | real place: lest `cloud` (Open Cloud Luau task on a fresh game server per spec: `IsServer()` true) or `studio` (launched Studio, **edit-mode** `RunScript` — command-bar permission level, place scripts don't run, physics doesn't step; `IsStudio()` true but `IsClient()` **and** `IsServer()` both true — an edit-mode quirk; branch on `IsStudio()`) | engine APIs, services, DataModel, DataStores-on-cloud, place fixtures | input, hover, rendering, mobile sensors, an actual stepping playtest — no backend covers these; verify those in a real client session |

Key lest facts (verified against its docs, v0.6.0 line, MIT, created 2026-07; distinct from the unrelated 2023 Jest-style `TAServers/lest`):

- Suites declare their backend in `lest.toml`; reporters/snapshots/CI output are backend-independent.
- Exit codes are a three-way contract: `0` all passed, `1` **test failures**, `2` **tool error** ("the run didn't happen (or measured nothing), and calling that a test failure would be a lie your dashboard then repeats"). CI scripts should branch on 1 vs 2.
- JUnit (`--reporter junit`) and JSON reporters, Lcov coverage with `--min` gate, snapshot testing, and `--changed origin/main` selective runs are built in.
- The studio backend "refuses to run under `$CI` on purpose"; engine suites gate on the cloud backend with an Open Cloud key from the CI secret store.

**The CI contract generalizes:** gate on parsed results (JUnit/JSON), not exit code alone — a tool that exits 0 on a failure class, or exits 0 while producing zero outcomes, reports green while testing nothing. If a runner lacks a structured reporter, assert on expected output artifacts (a results file with N passing entries), never on exit code alone.

**Mocking by injection, not interception:** pass fakes through parameters (systems take `world`/`services`; components take props) instead of monkey-patching globals. That is what makes a headless run possible at all, and it matches the architecture skill's "pure core, testable without Roblox wiring" rule. A mock that fakes engine instances produces tests that verify the fake, not the game — prefer splitting the suite so engine-dependent tests run where the engine exists.

**Flaky-test triage order:** isolate timing dependence (fixed clock/seeded RNG), then environment dependence (paths, locale, network), then quarantine-or-delete. Never mask with an unconditional retry — a retry hides real races.

**Pin the runner like every other tool** (Rokit manifest), because a runner/framework version mismatch is a silent behavior-change class. lest documents LPM/rokit pinning for exactly this.
- **Roblox-TS** (TypeScript-to-Luau compiler): a real production stack used by some studios, with its own tradeoffs; see the language-choice section before recommending it for an agent workflow.

The line: if the user asks "should I add linting/formatting/tests?" or is hand-doing something these automate, offer the option and the tradeoff, then let them choose. If the project already has a toolchain, extend it; do not introduce a new ecosystem unprompted. The exceptions that justify recommendation: files-first source control (Rojo) and CI reproducibility, when the user is clearly trying to version or automate their project.

## 1d. Language choice: Luau vs Roblox-TS (for agents and greenfield projects)

Verified state, August 2026 (npm + GitHub APIs): roblox-ts ~11.4k npm downloads/month, 1.3k stars, but the canonical npm release is still 3.0.0 (Sep 2023, TS 5.2-era); a community fork (`@isentinel/roblox-ts`, 4.0.x, provenance unverified) carries newer releases. That is a niche within Roblox dev; most shipped experiences and nearly all community libraries (TopbarPlus, ProfileStore, FastCast, jecs) are Luau.

- The TS advantage is real for *teams of engineers* (typed contracts, npm package ecosystem, familiar syntax; see the Last Level Studios writeup). The training-data argument ("billions of lines of TS") is practitioner anecdote only: no controlled benchmark compares LLM output in rbxts-TS vs Luau, and rbxts is a TS dialect whose Roblox-isms erode the vanilla-TS advantage (models confidently misuse APIs that `@rbxts/types` doesn't cover, and those stubs lag the engine).
- For **AI agents specifically**, the compiler pipeline adds failure modes that raw Luau does not have: a watch process that must be running, generated files agents can wrongly edit, Studio line numbers that don't map to source without sourcemap work, compiler-inserted runtime asserts, and lint that must run post-compile. Luau runs directly in Studio and every engine-facing tool (luau-lsp, luaudit, Lune, Rojo sourcemap) speaks it natively; `--!strict` plus a live type solver gives agents the same machine-checkable feedback loop that is the actual accuracy lever.
- Verdict an agent should give: adopt TS where the team already knows TS and wants npm; default to Luau for agent-heavy workflows and where community libraries are the point. This is a tradeoff, not a mistake either way. Platform momentum backs the default: Roblox shipped Studio Script Sync and lists Studio Luau file sync on the 2026 roadmap, i.e. first-party tooling grows around native Luau file workflows. <!-- temporal: 2026-08 -->

## 2. Rojo project mapping

A Rojo project file maps filesystem paths to Roblox services. Keep the mapping small and obvious.

```json
{
  "name": "ExampleGame",
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": {
      "$path": "src/ReplicatedStorage"
    },
    "ServerScriptService": {
      "$path": "src/ServerScriptService"
    },
    "StarterPlayer": {
      "StarterPlayerScripts": {
        "$path": "src/StarterPlayer/StarterPlayerScripts"
      }
    }
  }
}
```

File suffixes communicate the Roblox instance type in the usual Rojo workflow:

- `.server.luau` maps to a server `Script`;
- `.client.luau` maps to a client `LocalScript`;
- `.luau` maps to a `ModuleScript`;
- `init.luau` can represent a module at a folder boundary.

Use the exact conventions documented by the project's Rojo version. Test both `rojo serve` for development and `rojo build` for a reproducible artifact.

## 3. Packages: Wally, pesde, rokit, or vendoring

<!-- temporal: 2026-10 -->
The package-manager question has no single winner as of 2026-10; an agent should know the landscape and follow the project, not evangelize:

- **Wally** (UpliftGames): the long-standing default. The CLI's last tagged release is 2023-06, which says nothing about the registry itself: package publishing to `wally-index` continues (commits observed 2026-10). Roblox's April 2026 "Evolving Luau OSS" announcement said new official libraries publish under `roblox/` on Wally. Treat the CLI's release cadence and the registry's activity as separate facts; do not claim adoption trends either way.
- **pesde** (pesde-pkg): an active community alternative; manifest-based like Cargo, supports Roblox and Lune targets. Smaller package count than Wally. Its `[wally_indices]` manifest table lets a pesde project install Wally packages directly, so choosing pesde does not orphan existing Wally dependencies; a `sourcemap_generator` script is required for Wally-dependency type support.
- **Rokit**: package *tool* manager (pins CLI tools like Rojo), not a dependency manager. **Aftman is archived** (LPGhatguy/aftman, 2025); for new projects Rokit is the common choice, and it reads existing `aftman.toml`/`foreman.toml` projects.
- **Vendoring**: copying a module into `ReplicatedStorage` is still a common and respectable pattern; the Fusion maintainer publicly prefers package-manager-agnostic file bundles pending an official solution. For single-file community modules (TopbarPlus, FastCast) it is the norm. Legitimate; require a provenance comment with the thread URL and version.
- **Direct GitHub installs**: common in agent workflows where the dependency is one clone + a Rojo path mapping.

A package manifest should state whether a dependency is shared, server-only, client-only, or development-only. Keep the lockfile under version control so CI resolves the same graph.

```toml
[package]
name = "team/example-game"
version = "0.1.0"
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"

[dependencies]
Promise = "evaera/promise@4.0.0"
```

The names and versions above are examples, not recommendations. Verify package ownership, license, compatibility, and the project's existing conventions before adding a dependency. Do not copy a package into the repository just to avoid documenting it.

### Version specification: how resolution actually fails

These behaviors are verified against Wally 0.3.2 source ([resolution.rs](https://raw.githubusercontent.com/UpliftGames/wally/v0.3.2/src/resolution.rs), [manifest.rs](https://raw.githubusercontent.com/UpliftGames/wally/v0.3.2/src/manifest.rs)) and pesde docs (2026-10); both resolvers evolve, so re-check the pinned CLI version before treating a detail as current:

- **A bare version spec is a range, not a pin.** Wally parses the requirement with `VersionReq`, and in the semver grammar a bare `1.2.0` means a caret-compatible range, not exactly `1.2.0`. "Works on my machine" version drift comes from the spec, not the resolver. Pin with explicit operators when reproducibility matters, commit the lockfile (already required above), and diff the lockfile in review — a review that skips it can approve an unrequested upgrade.
- **Wally's resolver does not backtrack.** It walks dependencies depth-first picking the newest candidate; when every candidate for a request conflicts with already-activated packages it bails with "All possible candidates for package {req} ... conflicted with other packages that were already installed", and when no candidate matches the realm it bails with "No packages were found that matched". A wedged resolution usually names an incompatible constraint pair — read the error before touching the lockfile. (Do not delete a lockfile as a default fix: it discards the reviewed dependency graph. If a resolver genuinely wedges, fix the constraint in the manifest first; deleting the lockfile is a deliberate, explained action, and the user decides.)
- **Realm mismatches fail at resolution, not runtime.** In Wally source, `Realm::is_dependency_valid` permits `(Server, _) | (Shared, Shared) | (Dev, _)`: a dependency declared in the shared `[dependencies]` section can only be satisfied by a package whose own realm is `shared`, while `[server_dependencies]` and `[dev_dependencies]` may consume packages of any realm. So a shared dependency on a server-only package fails install with the realm-named error above, before any code runs. Declare realms deliberately; a realm error at install is a manifest error, not a code bug. pesde's targets (`luau`, `lune`, `roblox`, `roblox_server` in `[target].environment`) play the same role; its resolver errors on incompatible target combinations rather than installing something unusable.
- **pesde's `pesde.lock` records resolved versions** ("contains the exact versions of the dependencies that were installed so that they can be installed again", per its quickstart) — commit it for the same reason as `wally.lock`. The documented recovery for resolver wedges is fixing the dependency graph, not editing the lock by hand.
- **Verify what ships before the first publish.** Wally's `wally package --list` previews the package contents; its `include` globs are additive over the default set and `exclude` prunes (with `.gitignore` used as the default exclude when `include` is empty). There is no `wally publish --dry-run` flag — `wally package --list` is the dry-run. pesde ships `pesde publish` with a `--dry-run` option per its CLI reference. Publish tools can succeed while uploading less than assumed, so check the listing, not the exit code.
- **Wally-dependency interop in pesde costs a step.** Configure the index under `[wally_indices]`, then declare a Wally dependency under `[dependencies]`, for example `foo = { wally = "acme/foo", version = "1.2.3", index = "acme" }`, and the docs require a `sourcemap_generator` script "to get proper types support when using Wally dependencies". That script runs during install/linking, so keep the interop as an explicit migration step (script + index config) rather than a background assumption.

## 4. Pin the toolchain

Aftman is archived and should be treated as legacy compatibility. If an existing repository already uses `aftman.toml`, keep its versions pinned and avoid an unrelated migration during feature work. For a new project, lead with Rokit (or the project's existing manager); Rokit is compatible with existing `aftman.toml` and `foreman.toml` projects.

An existing Aftman manifest can look like this (example pins, verified current as of 2026-10):
```toml
[tools]
rojo = "rojo-rbx/rojo@7.7.1"
wally = "UpliftGames/wally@0.3.2"
selene = "kampfkarren/selene@0.32.0"
stylua = "JohnnyMorganz/StyLua@2.5.2"
lune = "lune-org/lune@0.10.5"
```

Use versions tested by the repository. Update them deliberately, review generated lockfile changes, and record compatibility failures rather than silently floating to the newest release.

## 5. Selene

Configure the Roblox standard and keep suppressions narrow.

```toml
std = "roblox"

[rules]
unused_variable = "warn"
shadowing = "warn"

[config]
allow_defined_top = true
```

Run `selene src` locally and in CI. Prefer a named configuration or a small inline suppression with a reason over disabling a rule for the whole project.

## 6. StyLua

Formatting is a repository convention. Keep the configuration short and run the formatter in check mode in automation.

```toml
column_width = 100
indent_type = "Spaces"
indent_width = 4
quote_style = "AutoPreferDouble"
call_parentheses = "Always"
```

Use `stylua --check .` in CI and `stylua .` only as an explicit developer action. Do not mix formatter changes with a gameplay change unless the repository expects format-on-save commits.

## 7. Lune and standalone scripts

Lune is useful for file transforms, test orchestration, and small repository utilities. Keep Roblox-only code out of scripts that must run without Studio.

```luau
local fs = require("@lune/fs")
local serde = require("@lune/serde")

local manifest = serde.decode("json", fs.readFile("manifest.json"))
print(manifest.name)
```

A Lune script is not automatically a Roblox runtime script. Document which APIs it expects and make its inputs and outputs testable from CI.

## 8. Sourcemaps and editor support

If the editor needs Roblox-aware type information, generate a sourcemap from the same Rojo project file used for development. Treat the generated map as disposable build output unless the repository explicitly versions it.

Regenerate it after adding services, moving modules, or changing suffixes. A stale map can make correct code look broken and can hide incorrect paths.

## 9. CI sequence

A small pipeline can use this order:

1. install the pinned tools;
2. restore or install Wally dependencies;
3. run Selene;
4. run StyLua in check mode;
5. generate a sourcemap if luau-lsp analysis is enabled;
6. run standalone Lune tests or project tests;
7. run `rojo build` and inspect the artifact boundary.

Keep credentials out of project files and CI logs. If a build needs a Roblox API credential, inject it through the CI secret store and use the narrowest scope available.

## 10. Ignore generated output

The exact list depends on the project, but commonly generated paths include:

```gitignore
/Packages/
/.aftman/
/build/
sourcemap.json
*.rbxl
```

Do not ignore source, lockfiles, configuration, or test fixtures by accident. Check `git status` after installing tools and packages.

## 11. Documentation indexes for agents

Roblox publishes LLM-oriented documentation indexes that route an agent to the correct API surface before it starts reading:

- `https://create.roblox.com/docs/llms.txt`: top-level index; use it first.
- `https://create.roblox.com/docs/reference/engine/llms.txt`: Engine API index (Luau inside an experience).
- `https://create.roblox.com/docs/cloud/llms.txt`: Open Cloud API index (REST from external servers).
- `https://create.roblox.com/docs/llms-full.txt`: all docs in one file (large).
- `https://create.roblox.com/docs/reference/engine/deprecated.md`: deprecated API inventory.

The Engine API and Open Cloud API are separate systems. Engine APIs are Luau objects via `game:GetService()` inside a running experience; Open Cloud APIs are HTTP endpoints called with an `x-api-key` from outside Roblox. Fetching the wrong index produces non-functional code, so route first.

### Verifying one API claim

An index tells you where to look; it does not settle whether a member exists today. To check a specific claim without opening Studio (all verified reachable 2026-09):

- Append `.md` to any docs URL to get the page source instead of the rendered site, for example `https://create.roblox.com/docs/en-us/reference/engine/classes/Players.md`. Class pages carry signatures, parameter tables, security and capability notes, and deprecation tags.
- For machine-readable answers use the engine reference YAML that backs those pages: `https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/<Class>.yaml`. It lists every property, method, and event with types, thread-safety, security, capabilities, and `Deprecated` tags, which is enough to distinguish "this API exists" from "this API existed".
- Cross-check community mirrors such as `https://robloxapi.github.io/ref/` when you want a diff view between engine versions. Label it as community-maintained and expect lag; it is not the authority.
- Practitioners also dump the installed engine's API surface, but a dump only reflects the client you have, so treat it as a local artifact rather than the platform contract.

A verified claim is worth pinning: if you maintain an agent-facing skill library, record the claim with the doc path and the date you checked it, so a later reviewer can re-run the check instead of re-litigating the API.

## Tooling checklist

- [ ] The project has one documented source-to-Studio workflow.
- [ ] Tool versions are pinned and tested.
- [ ] Dependencies have explicit realms and licenses.
- [ ] Lint and format checks run without rewriting files in CI.
- [ ] Sourcemaps and build artifacts have a clear ownership policy.
- [ ] Standalone scripts declare their runtime assumptions.
- [ ] CI produces a reproducible build or reports why it cannot.

## Community tool stack (Tizzy discord, Jul–Sep 2026)

Field-reported from a live dev Discord (Jul–Sep 2026). Community practices and third-party services, not verified or endorsed tooling; treat URLs, pricing, and availability as temporal. <!-- temporal: 2026-09 -->

### AI thumbnail / icon pipelines

There is a genuine CONFLICT in the community data on whether AI thumbnails help or hurt CTR; the resolution is genre-dependent:

- **AI beats paid artists (repeated first-hand):** a $50 commissioned thumb got 1% CTR vs 3% for an AI one; AI thumbs routinely hit 8–10%+ qPTR (best observed ~14%); paid artists charged $35–150 per thumbnail pre-AI vs ~$16/mo AI subscriptions. Spend on iteration volume, not single commissions. (TwoGodTwoForce 2026-08-03; Gosu 2026-07-27/08-23; Blueshell_Dev 2026-07-21)
- **CONFLICT: AI thumbs measurably hurt CTR for non-slop games:** players recognize and skip obvious AI images; visible artifacts (uncanny faces) reduce perceived game quality. Reported to work only for brainrot/slop-adjacent genres. Mitigation: feed the AI references of successful same-genre thumbnails and A/B test whether the result reads "too AI." (Every 2026-08-25; Gatto 2026-08-30; lanmi 2026-09-17; charlie 2026-07-30; DampTruff 2026-07-15; cyntile 2026-07-18)
- **Workflow both camps agree on:** a detailed template prompt (one big bacon-hair avatar doing the action, black outlines, studio lighting, reward popups, mobile-legible, 16:9), then test many variants through Ads Manager and let CTR pick winners. From-scratch prompts produce generic output; always feed a reference image and describe targeted changes ("replace the gun with my game's mechanic"). GPT-class models are good at icons and high-saturation imagery, bad at faces and text; the standard pipeline is AI-generate the scene, then add text/faces by hand (Figma/Photopea). "Nano banana" rated better than GPT image 1. (Flow 2026-08-23; XOO 2026-08-23; Zriptic 2026-08-02; Seth/transcendence/Jerome 2026-08-27; Aura 2026-08-09)

**Thumbnail pre-testing tools** (test CTR before committing ad spend; reported by Blueshell_Dev 2026-07-21; RealYoKaglier 2026-08-07; FuturisticGames 2026-07-15/08-04; Zacky0s 2026-08-05; idk 2026-08-11; dot 2026-07-10; BlueMaster 2026-07-31; Zayuh 2026-07-10; MrX 2026-07-27):

- qptr.io: community tool by "Michael", recommended by Tizzy; devs pair it with ChatGPT ("show it the home-recs row, ask which thumbnail stands out to kids")
- vizzbees.com: AI thumbnail generator even AI-skeptics vouch for
- rothumbs / RoThumbs: AI generation (paid); RoClicks: free thumbnail/icon generator built from what's charting (bring-your-own Google/OpenAI key); several devs just use nano banana pro (free) directly
- DIY style-copy pipeline: collect reference thumbnails → train a LoRA with Kohya_ss → run in ComfyUI/Stable Diffusion with a trigger word
- PixelForge ($5): cheap image-studio alternative to a free-but-slow Blender render setup

**Production pipelines in use:** Gemini/ChatGPT layouts (with references from successful games) → clean up with RoThumbs; "ChatGPT Images + Photopea is a GOATED combo"; Fiverr human artists at ~3–4 thumbnails for £20; big-bang.studio (the studio behind Rivals and 99 Nights artwork) as study material; free render stack = Blender + free rigs + Photopea (pre-rendered baseplates, HP bars, etc. freely available). (beahrz/Zriptic 2026-07-12; Doug 2026-09-14; Joel 2026-09-17; Ariex 2026-08-07; N3Developer 2026-07-20)

**AI icon pipeline that works:** have Claude render each 3D model as a screenshot from an angle with no background + black stroke: 20 car icons in 2 minutes; one dev built a custom icon maker (model screenshot → stroke → auto-upload via API). (blodi 2026-08-07; rip_HaoshokuRed 2026-08-12)

Ads note: Ads Manager natively rotates multiple thumbnails as creatives in one campaign (auto-rotates, reports per-creative CTR, pushes winners) and is sufficient for 99% of games; if ads "don't work," the failure is almost always retention, not the channel. (Duphalak 2026-07-11; john 2026-07-06)

### Asset / resource stack (community union)

- Packages/data: wally.run community frameworks (Signal by sleitnick, Janitor, Promise v4); ProfileStore/ProfileService for data; roproxy.com as proxy for Roblox web-API calls from games. (Blueshell_Dev 2026-07-12; Qizzy 2026-07-29)
- Figma→Roblox UI: roimport.com (free importer); design at 16:9 for PC, export, scale with UIScale; preview/test UI code without launching the game via hoarcekat or the Vide framework; UI packs preferred over AI-generated UI frames. (Dapathy 2026-08-09; val 2026-07-30; Haze 2026-08-09; Bapo 2026-07-18)
- AI 3D: Meshy/Tripo3D for image-to-3D (~$1 first month; meshy.ai for bulk small models), but building/modeling is the skill AI handles worst, along with non-basic UI; AI meshes are typically badly over-poly, check vertex counts before import; Blender + Claude/Astra for models, tripo3d for reference-image→3D instead of burning chat usage. (Zriptic 2026-07-10; FuturisticGames 2026-07-15; thug 2026-08-22; WASIMALT/Luna 2026-07-14; CraseDev 2026-09-14; Nyx 2026-09-01)
- Audio/UI assets: nocapmocap.com (mocap); Moon Animator ($30) + EasyWeld plugin; builtbybit.com templates/asset packs (e.g. SFX megapacks); gvesster.itch.io free icon pack; uiresouces.com UI grid patterns; epicstockmedia.com UI SFX packs; devforum "massive sound kit" (142 categorized sounds); itch.io UI kits (rblx-essentials) for weak GUI skills; Pixabay/Creator Store sounds; RoVisuals free hourglass/icon generator for ad creatives; Vanilla 3 icon set (DevForum) for Studio editor icons. (multiple contributors, Jul–Sep 2026)
- RoPrice (DevForum tool): bulk-creating/editing dev products and gamepasses. (SteamedBunX 2026-07-25)

### AI coding stack consensus

- Practical Roblox-specific workflow: keep the game in the project folder so a new AI session inherits context; connect Studio via MCP so the AI reads real code; rojo with git + selene linting for version-controlled scripting. Studio's MCP is token-hungry; sequential MCP + rojo + Codex is the leaner setup. (Nullborne 2026-07-17; chris 2026-08-23; BPAndrew 2026-07-10; Gordito 2026-07-15)
- **Studio MCP bug warning: collaborative editing can kill the Studio session and unsaved data when using Studio MCP; turn collaborative edits off and keep file backups.** (dalph06, 2026-07-10)
- Open Cloud API largely removes AI-agent friction: an AI with API access can publish images, create gamepasses/dev products, and set prices itself; "AI as studio assistant" is viable end-to-end. (Nyx, 2026-08-10)
- Performance debugging with AI: don't prompt "optimize my code"; ask for real diagnostics via MicroProfiler and script profiling to find CPU spikes; Humanoid instances are expensive at scale (hundreds of NPCs need rigs without Humanoids). (terms 2026-08-22; kah 2026-08-21)
- Local models: Qwen3.8-27B on a 24GB+ Apple Silicon Mac inside an agentic harness was specifically recommended; pairing Studio MCP with local Ollama models was asked about but unconfirmed. (jan 2026-08-20; majorFraud 2026-08-17)
- Community Claude skills circulating: roblox-brain (the upstream of Roqer's bundled skills) and dstack (github.com/HungryKelvin123/dstack); community opinion: most community skills are "documentation wrappers"/bloat. (keltec 2026-07-14; CraseDev 2026-09-14; Nyx 2026-09-01)

### Playtester channels

QA Central Discord organizes scheduled test sessions (recommended repeatedly, incl. by coaches); Hidden Devs has a tester-matching board; pay bug-finders by severity to increase coverage; Creator Hub "audience" section feedback (likes/dislikes) also counts as feedback entries. (NotAntPanda 2026-09-13; GameComposer 2026-08-21; tora/Kam 2026-08-23; ClosedTofu 2026-09-16)

### Learning resources

TizzyRBLX12 for monetization ("the GOAT"), RoBuilder for building, gfxcomet for UI, BrawlDev's tutorials as the standard on-ramp (replacing AlvinBlox/PeasFactory), Roblox's official learn channel (microprofiler videos for frame optimization) and its basic+advanced creator tutorials, refactoring.guru design-patterns catalog for game code architecture; consensus warning: avoid "tutorial hell"; math prerequisites for gameplay physics: trig, basic calculus, basic linear algebra. (bac 2026-07-26; Gosu 2026-08-20; Zayuh 2026-07-14; Davide 2026-07-13; Otorina3d 2026-08-12; freakyfinch457 2026-07-13)

### Analytics and ops tools

- Funnels are the underused analytics feature: devs who set them up immediately find exact drop-off steps; pair with watching a real fresh player session. (john 2026-07-06; Zak 2026-08-04; Carter 2026-08-06)
- Pull your own metrics into Grafana; the Roblox creator dashboard lags badly (24–48h on stats); self-hosted dashboards surface CCU/monetization trends faster. (Surfrdan, 2026-07-08)
- Trend-target tooling: a top dev runs a scraper detecting newly released games and pulls owner contact info within minutes of release; others scrape front-page thumbnails into a folder and have Claude pick references + write generation prompts; top-1000-game cutoff observed at 1,399 concurrent players. (740k 2026-07-28; Zriptic 2026-07-22; amend 2026-08-21)

### Identified tool gaps

Two tool concepts the community wants but says do not exist yet:

- **Session-replay plugin**: records player positions/actions for onboarding analytics and bug repro. (umbri, 2026-08-11)
- **Balance simulator**: run 100,000 simulated sessions to tune progression/balance values in seconds instead of weeks of hand-tuning. (740k, 2026-07-24)
