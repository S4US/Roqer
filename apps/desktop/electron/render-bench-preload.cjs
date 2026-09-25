/* eslint-env browser */
// The stub desktop bridge for `render-bench.mjs`: enough of `window.workbenchDesktop`
// for the real renderer to boot signed in with one model and a connected place,
// with run events supplied by the benchmark instead of a main process. Loaded
// without context isolation, which is fine for a benchmark against a dev
// server and would not be for the app.
const listeners = new Set();
const ok = (value) => Promise.resolve(value);
const model = {
  id: "opus",
  displayName: "Opus",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
};
const connector = {
  status: () => ok({ kind: "signed-in", message: "Bench", email: "bench@example.com", planType: "Pro" }),
  login: () => ok({ ok: false, message: "bench" }),
  submitCode: () => ok({ ok: false, message: "bench" }),
  models: () => ok({ models: [model], defaultModelId: model.id }),
};
/**
 * A saved workspace to boot with, described by the page URL:
 * `?seed=chats:6,runs:4,diff:400,tools:40`. Every chat holds `runs` finished
 * runs, each with one script diff of `diff` lines and `tools` tool rows, which
 * is what an old chat that did real work looks like on disk.
 */
function seededWorkspace() {
  const seed = new URLSearchParams(window.location.search).get("seed");
  if (!seed) return null;
  const spec = Object.fromEntries(seed.split(",").map((part) => part.split(":")).map(([key, value]) => [key, Number(value)]));
  const chats = spec.chats ?? 4, runs = spec.runs ?? 3, diffLines = spec.diff ?? 400, tools = spec.tools ?? 40;
  const at = "2026-09-12T10:00:00.000Z";
  const diff = Array.from({ length: diffLines }, (_, i) => (i % 8 === 0 ? "+" : i % 8 === 1 ? "-" : " ") + `local value${i} = compute(${i}, "text") -- comment ${i}`).join("\n");
  const record = (chat, run) => ({
    schemaVersion: 1, runId: `run-${chat}-${run}`, planner: "claude-code", approvalMode: "Full auto", outcome: "completed",
    startedAt: at, finishedAt: at,
    toolCalls: Array.from({ length: tools }, (_, i) => ({ tool: i % 5 === 1 ? "set_properties" : "get_script_source", ok: true, durationMs: 120, summary: "ok · 42 lines", target: `game.ServerScriptService.Script${i}` })),
    changes: [{ id: `ch-${chat}-${run}`, kind: "script-source", target: `game.ServerScriptService.Script${run}`, summary: "Retimed", addedLines: Math.floor(diffLines / 8), removedLines: Math.floor(diffLines / 8), diff, language: "lua", revisionBefore: "sr1:1:a", revisionAfter: "sr1:2:b" }],
    evidence: [{ id: `ev-${chat}-${run}`, kind: "verification", title: `game.ServerScriptService.Script${run}`, passed: true, metadata: [{ label: "Revision after write", value: "sr1:2:b" }] }],
    failures: [],
    tasks: [{ id: "t1", title: "Retime the launch", status: "done", requiresRuntimeEvidence: false, requiredEvidence: [] }],
    verification: { verified: true, issues: [] },
  });
  const chatList = Array.from({ length: chats }, (_, c) => ({
    id: `chat-${c}`, title: `Old chat ${c}`, createdAt: at, updatedAt: at,
    messages: Array.from({ length: runs }, (_, r) => [
      { id: `m-${c}-${r}-u`, role: "user", text: `Retime the projectile launch, attempt ${r}`, createdAt: at },
      { id: `m-${c}-${r}-a`, role: "assistant", text: "Retimed the launch and the cast direction. The script now waits for the cooldown before firing again.\n\n- `launch` no longer normalises twice\n- the cooldown is read from the config", createdAt: at, run: record(c, r) },
    ]).flat(),
  }));
  return {
    schemaVersion: 3, selectedProjectId: "p1", selectedChatId: "chat-0",
    projects: [{ id: "p1", name: "Default", createdAt: at, updatedAt: at, chats: chatList }],
    preferences: { theme: "dark", approvalMode: "Full auto", autoPlaytest: true, mcpEndpoint: "http://127.0.0.1:58741", studioInstanceId: null, discordPresence: false, provider: "claude", chatGptModelId: null, claudeModelId: model.id, customModelId: null, reasoningEffort: "medium" },
  };
}
const seeded = seededWorkspace();
const saveMs = [];

window.workbenchDesktop = {
  storage: {
    load: () => ok(seeded),
    // The real bridge sends the whole workspace across IPC on every save, which
    // serialises it on the renderer's thread. structuredClone is the same
    // serialiser, so its cost here is that cost, measured.
    save: (state) => {
      const started = performance.now();
      structuredClone(state);
      saveMs.push(performance.now() - started);
      return ok({ savedAt: new Date().toISOString() });
    },
    flush: () => undefined,
    status: () => ok({ required: false, message: null }),
    recover: () => ok(null),
    export: () => ok(false),
  },
  assets: { pick: () => ok(null), attachImage: () => Promise.reject(new Error("bench")), release: () => ok(undefined) },
  updates: { state: () => ok({ kind: "idle" }), install: () => ok(false), subscribe: () => () => undefined },
  bridge: { state: () => ok({ kind: "running", endpoint: "http://127.0.0.1:58741" }), restart: () => ok({ kind: "running", endpoint: "http://127.0.0.1:58741" }), subscribe: () => () => undefined },
  studio: {
    getStatus: () => ok({ kind: "connected", endpoint: "http://127.0.0.1:58741", placeName: "Bench Place", instanceCount: 1, message: "Connected", instances: [{ instanceId: "place:1", role: "edit", placeName: "Bench Place", isRunning: false }] }),
    openScript: () => ok({ ok: true, message: "opened" }),
  },
  providers: { chatGpt: connector, claude: connector, custom: connector },
  customProviders: {
    list: () => ok({ ok: true, connections: [] }),
    save: () => ok({ ok: false, message: "The render bench does not save connections." }),
    remove: () => ok({ ok: true, connections: [] }),
    test: () => ok({ ok: false, message: "The render bench does not test models." }),
    importModels: () => ok({ ok: false, message: "The render bench does not read model lists." }),
  },
  openCloud: {
    get: () => ok({ ok: true, settings: { hasKey: false, creator: null, bridge: "none" } }),
    save: () => ok({ ok: false, message: "The render bench does not save Open Cloud settings." }),
    check: () => ok({ ok: false, message: "The render bench does not check keys." }),
  },
  blender: {
    get: () => ok({ ok: true, settings: { enabled: false, executable: "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", version: "Blender 5.2.1 LTS", state: "off", message: "Blender 5.2.1 LTS found. Turn it on to let the agent model assets with it." } }),
    setEnabled: (enabled) => ok({ ok: true, settings: { enabled, executable: "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", version: "Blender 5.2.1 LTS", state: enabled ? "ready" : "off", message: enabled ? "Blender 5.2.1 LTS runs modeling jobs the agent writes, after you approve each one." : "Blender 5.2.1 LTS found. Turn it on to let the agent model assets with it." } }),
    choose: () => ok({ ok: false, message: "The render bench does not open dialogs." }),
    redetect: () => ok({ ok: false, message: "The render bench does not look for Blender." }),
  },
  runs: {
    start: () => ok({ ok: true, runId: "run_bench" }),
    respond: () => ok(true),
    answer: () => ok(true),
    steer: () => ok(true),
    cancel: () => ok(undefined),
    cancelStart: () => ok(undefined),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  },
  app: { getDataPath: () => ok("C:\\bench") },
};
window.__bench = {
  emit(event) { for (const listener of listeners) listener(event); },
  listeners: () => listeners.size,
  saves: () => saveMs.splice(0).map((ms) => Math.round(ms)),
  workspaceBytes: () => (seeded ? JSON.stringify(seeded).length : 0),
};
