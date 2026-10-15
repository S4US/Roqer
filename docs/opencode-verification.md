# OpenCode integration verification — 2026-10-14

Reviewed against the original local `origin/main`, commit `bdc176e50f39127079b280e075a57b830b766939`. Existing integration edits were preserved and corrected in place.

## Passing checks

- Desktop TypeScript checks, desktop lint and desktop build.
- Electron startup smoke: `WORKBENCH_SMOKE_OK events=8 outcome=completed`.
- 77 targeted tests across OpenCode configuration, executable lookup, model discovery, planner, model preferences, provider cards, account details and client installation.
- Native OpenCode 1.18.32 accepts the generated configuration. Its effective agent disables every native tool and grants only the named Roqer MCP tools.
- Core MCP build, required to prepare the managed Studio check.

The planner tests include real local HTTP MCP calls. They exercise host transport failures, questions, the host's “none of these” choice, note delivery, cancellation, silent/truncated replies, usage, attachments, history and cleanup. They do not mutate a live Studio place.

## Full desktop suite

`npm run test:desktop` completed with 1,676 passing tests out of 1,682. The six failures were outside the OpenCode integration:

- `runtime/mcp-server-process.test.ts`: “adopting somebody else's bridge still installs the Studio plugin” and “an install that fails is reported rather than leaving Studio silently unreachable”. Synthetic installer timing expired before the fake process finished.
- `shared/provider-limits.test.ts`: “a reset time says which day once it is not today”. The Windows locale renders `15:40`, while the test expects `3:40`.
- `src/context-usage.test.ts`: “a reported reading shows the share used, quietly until it is worth noticing” and “without a reported window the meter shows tokens in use and claims no share”. The locale renders `14:05`, while the tests expect `2:05 PM`.
- `src/plan-usage.test.ts`: “windows read shortest first, with a reset only while it is ahead”. The same 12-hour versus 24-hour mismatch.

These test files and their original implementation files were copied directly from HEAD into a disposable directory and tested without the integration edits. All four clock-format failures reproduced. Timer-sensitive installation/restart failures also reproduced in the original `mcp-server-process.test.ts`; their exact membership varies with scheduling. No assertions or timeouts were weakened.

## Managed Studio check

`npm run test:e2e` built the plugin and launched an isolated Studio session. The initial attempt required building the missing MCP distribution; after `npm run build`, the live run completed with:

- PASS: `studio-tooling-smoke.mjs`.
- PASS: `semantic-ui-smoke.mjs`.
- PASS: `eval-context-routing.mjs`.
- FAIL: `micro-profiler-responsiveness.mjs`, “high-volume MicroProfiler capture remains cooperative”. Studio received `capture_micro_profiler` but did not answer before its timeout.

The MicroProfiler implementation, plugin handlers and live test files are unchanged from HEAD. This suite drives the standalone MCP directly and does not load the OpenCode adapter. Its managed Studio instance was closed after the failure. The temporary Studio plugin-directory setting was restored using the repository's guarded repair helper.

## Real provider request

The installed OpenCode CLI discovered `opencode/big-pickle`. A real planner run requested only `ROQER_OK`, with no Studio calls allowed. OpenCode's service refused it with “OpenCode's free tier can only be used from within OpenCode.” The planner propagated the refusal; it did not report success. No Studio operation ran, and the private session files were removed.

The [upstream report](https://github.com/anomalyco/opencode/issues/50627) reproduces this restriction on OpenCode 1.18.32 and Windows when native tools are removed. This was the initial integration's configuration. The additional experiments below identified the `ask` alternative now applied to Roqer's integration.

## Additional permission experiments

Nine real requests were made using the installed OpenCode 1.18.32 CLI, with private homes, no user credentials, actual native tools and an isolated MCP diagnostic server. The MCP server could only return a constant test marker; it had no Studio access. Every temporary home and test fixture was removed. No project file was read or changed. These experiments preceded the production fix.

| Model | Configuration | Request | Observed result |
| --- | --- | --- | --- |
| Big Pickle | Native tools denied | Text only | Free-tier refusal reproduced |
| Big Pickle | Native tools `ask`, no `--auto` | Text only | `ROQER_OK`, no tool calls |
| Big Pickle | Native tools allowed, `--auto` | Text only | Reply includes `ROQER_OK`, no tool calls |
| Big Pickle | Native tools `ask`, no `--auto` | MCP diagnostic | One real `roqer_probe` call and `ROQER_MCP_OK` |
| Big Pickle | Native tools `ask`, no `--auto` | Native read of a test fixture | Permission automatically rejected; tool status `error`, no fixture content returned and no assistant reply |
| Big Pickle | Native tools allowed, `--auto` | Native read of a test fixture | Tool status `completed`, fixture marker returned |
| Muse Spark 1.3 Contributor | Native tools denied | Text only | Free-tier refusal reproduced |
| Muse Spark 1.3 Contributor | Native tools `ask`, no `--auto` | Text only | `ROQER_OK`, no tool calls |
| Muse Spark 1.3 Contributor | Native tools `ask`, no `--auto` | MCP diagnostic | One real `roqer_probe` call and `ROQER_MCP_OK` |

The native `ask` setting keeps the native tool schemas available while the noninteractive CLI rejects requests to execute them. It lets the tested free models answer and call explicitly granted MCP tools. Roqer now applies this configuration to run homes, while discovery homes still grant no tools. The launcher never supplies `--auto`, including follow-up turns and Roqer's Full auto mode. It does not provide interactive native-tool approval in Roqer's UI: native permission requests are rejected, not forwarded to the user.

Full auto also works in the tested native configuration, and its successful file read demonstrates why it has different safety implications. These observations cover the tested CLI and models only; they do not establish availability for every free model or an official guarantee for third-party integrations.

The [structured results](opencode-permission-experiments.json) retain exit codes, elapsed times, provider errors, replies and observed tool states. No fake native tool schemas, request-header spoofing or custom provider endpoints were used.

## Applied fix verification — 2026-10-15

The production home generator now uses `ask` for native tools only in run homes connected to Roqer's MCP server. The launcher continues to omit `--auto` in every mode and follow-up turn. Discovery homes retain `deny`, ambient permission overrides are stripped, and unexpected native tool events still fail closed. The model guidance and availability messages describe this behavior.

Both models were then tested through the real `createOpenCodePlanner`, its default native launcher, the full Roqer instruction bundle and its normal MCP tool catalog. The host answered one `ask_user` question using a predetermined test choice; all Studio operations were forbidden by the test context.

| Model | Real MCP questions | Studio operations | Reply | Result |
| --- | --- | --- | --- | --- |
| `opencode/big-pickle` | 1 | 0 | `ROQER_MCP_OK` | Passed |
| `opencode/muse-spark-1.3-contributor-free` | 1 | 0 | Includes `ROQER_MCP_OK` | Passed |

The 33 targeted OpenCode tests pass, including the `ask` configuration, absence of `--auto`, refusal of unknown native tools, follow-up turns, cancellation and local MCP calls. Desktop lint, the desktop build (including TypeScript) and Electron startup smoke pass.

The latest complete desktop suite reported 1,681/1,688 passing. The six original locale/timing failures above remain, plus `runtime/attachment-clips.test.ts`, “releasing a clip removes its unsent frames and a dropped video's copy”, which reported a missing expected rejection. All 11 tests in that unchanged file passed when run in isolation. No tests were relaxed.

The latest `npm run test:e2e` attempt built and installed its isolated plugin, but stopped before the live assertions: `manage_instance` returned HTTP 500, “Timed out while capturing the exact Studio process identity.” The managed runner's failure recovery and worker cleanup completed without an additional cleanup error. The guarded plugin-directory repair found no remaining temporary setting. Studio verification remains incomplete; this launch path is unchanged by the OpenCode fix.

## Reasoning levels and context readings — 2026-10-15

The installed OpenCode 1.18.32 catalog reports model-specific `variants` and `limit.context`. Roqer now offers supported standard reasoning levels in its existing model menu and sends the selected level on every turn using the documented [`--variant` flag](https://opencode.ai/docs/cli/#run). Unknown variant names are omitted. Models with no supported variants retain the existing no-selector behavior. The context meter receives the latest completed step's input, output, reasoning and cache counts, rather than cumulative run totals, and the published capacity when available.

A real production-planner diagnostic selected `opencode/muse-spark-1.3-contributor-free` with effort `low`, using the default native launcher. It returned `ROQER_EFFORT_OK`, reported 16,373 input tokens and 82 output/reasoning tokens, and produced a context reading of 16,455 / 1,048,576 tokens. Cost and cache counts were zero. The host prohibited Studio operations and questions; no tools were needed. An earlier attempt timed out during model discovery while the complete suite was running; the retry after the suite completed passed.

All 40 targeted OpenCode/provider-contract tests pass. Desktop build (including TypeScript), lint and Electron startup smoke pass. The complete desktop suite reports 1,687/1,692 passing; the remaining failures are the previously observed bridge installation timeout in `runtime/mcp-server-process.test.ts`, one locale assertion in `shared/provider-limits.test.ts`, two in `src/context-usage.test.ts` and one in `src/plan-usage.test.ts`. This change does not alter Studio tools, and the live Studio suite was not rerun. No interactive visual check of the existing model menu was performed. Native session import/persistence between runs is unchanged.
