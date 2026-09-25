/**
 * How choppy the renderer gets while a reply streams, measured.
 *
 * Boots the real renderer against a stub desktop bridge (the preload beside
 * this file), starts a run, feeds it a realistic history -- tool rows, a plan,
 * diffs of a chosen size -- and then streams message deltas at token rate
 * while sampling requestAnimationFrame. What comes out is the per-frame cost
 * of one streamed token against a run of that shape.
 *
 * It exists because that cost was once proportional to everything the run had
 * already done: three 400-line diffs and forty tool rows cost 146 ms per
 * token, six 800-line diffs and 120 rows cost 575 ms, and a person watching
 * saw two frames a second. After memoising the live run's static subtrees and
 * folding events into one commit per frame, both cost 4 ms. Run this before
 * touching `LiveRun` or the run-event subscription, and after.
 *
 * Needs the renderer dev server: `npm run dev:renderer` in apps/desktop, then
 *
 *   npx electron electron/render-bench.mjs typical 3 400 40 600 8
 *
 * with the arguments <label> [changes] [diffLines] [tools] [deltas] [msBetween].
 * The window is shown for the seconds it takes; a hidden window's animation
 * frames are throttled to nothing and would measure the throttle.
 */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [label = "run", changesArg = "3", diffLinesArg = "400", toolsArg = "40", deltasArg = "600", everyArg = "8"] = process.argv.slice(2);
const CHANGES = Number(changesArg), DIFF_LINES = Number(diffLinesArg), TOOLS = Number(toolsArg), DELTAS = Number(deltasArg), EVERY_MS = Number(everyArg);
const URL = process.env.ROQER_BENCH_URL ?? "http://127.0.0.1:5173/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Frame-time percentiles from a list of frame durations, in ms. */
const FRAME_STATS = `(frames) => {
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  return { frames: frames.length, p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: Math.round(sorted[sorted.length - 1] ?? 0), over33: frames.filter((f) => f > 33).length, over100: frames.filter((f) => f > 100).length };
}`;

/**
 * The idle case: no run, an old chat open, and the person typing, scrolling,
 * and switching chats. Arguments after the label are the seed:
 *
 *   npx electron electron/render-bench.mjs idle <chats> <runsPerChat> <diffLines> <tools>
 */
async function idleBench(win, js, waitFor) {
  const [chats = "6", runs = "4", diffLines = "400", tools = "40"] = process.argv.slice(3);
  await win.loadURL(`${URL}?seed=chats:${chats},runs:${runs},diff:${diffLines},tools:${tools}`);
  await waitFor('textarea[aria-label="Message"]');
  await sleep(1500);

  const result = await js(`(async () => {
    const stats = ${FRAME_STATS};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sample = async (work) => {
      const frames = []; let last = performance.now(); let on = true;
      const tick = (now) => { frames.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      await work();
      on = false; await wait(50);
      return stats(frames);
    };
    const textarea = () => document.querySelector('textarea[aria-label="Message"]');
    const setText = (text) => {
      const el = textarea();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const nodes = document.querySelectorAll("*").length;

    const idle = await sample(() => wait(2000));
    const typing = await sample(async () => {
      const text = "please also make the fireball blue and slower";
      for (let i = 1; i <= text.length; i++) { setText(text.slice(0, i)); await wait(30); }
      setText("");
    });
    const scroller = document.querySelector(".conversation-scroll");
    const scrolling = await sample(async () => {
      for (let step = 0; step < 60; step++) { scroller.scrollTop = (step % 20) * (scroller.scrollHeight / 20); await wait(32); }
    });
    const rows = [...document.querySelectorAll(".chat-main")];
    const switches = [];
    for (const row of rows.slice(1, 4).concat(rows.slice(0, 1))) {
      const t0 = performance.now();
      row.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      switches.push(Math.round(performance.now() - t0));
    }
    await wait(300);
    return { nodes, workspaceKB: Math.round(window.__bench.workspaceBytes() / 1024), idle, typing, scrolling, switchMs: switches, saveMs: window.__bench.saves() };
  })()`);
  console.log(JSON.stringify({ label: "idle", chats: Number(chats), runsPerChat: Number(runs), diffLines: Number(diffLines), tools: Number(tools), ...result }));
}

app.whenReady().then(async () => {
  // Visible, because a hidden window's requestAnimationFrame is throttled to
  // nothing and the measurement would be of the throttle.
  const win = new BrowserWindow({
    width: 1280, height: 820, show: true, x: 40, y: 40,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, preload: join(here, "render-bench-preload.cjs") },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (selector, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${selector}`);
  };

  win.webContents.on("console-message", (event) => { if (event.level === "error") console.log("[renderer]", event.message.slice(0, 300)); });

  if (label === "idle") {
    await idleBench(win, js, waitFor);
    app.exit(0);
    return;
  }

  await win.loadURL(URL);
  await waitFor('textarea[aria-label="Message"]');
  await sleep(800);
  if ((await js(`window.__bench.listeners()`)) !== 1) throw new Error("the renderer did not subscribe to run events");

  // Type and send, which makes the renderer start the run through the stub.
  await js(`(() => {
    const el = document.querySelector('textarea[aria-label="Message"]');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(el, "Retime the projectile launch"); el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await js(`document.querySelector('button[aria-label="Send message"]').click()`);
  await sleep(400);

  // The event script, built in the page so nothing crosses IPC per event.
  const script = `(async () => {
    const RUN = "run_bench"; let seq = 0;
    const at = () => new Date().toISOString();
    const emit = (body) => window.__bench.emit({ ...body, runId: RUN, seq: ++seq, at: at() });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const diffLines = [];
    for (let i = 0; i < ${DIFF_LINES}; i++) {
      const p = i % 8 === 0 ? "+" : i % 8 === 1 ? "-" : " ";
      diffLines.push(p + "local value" + i + " = compute(" + i + ", \\"text\\") -- comment " + i);
    }
    const diff = diffLines.join("\\n");

    emit({ type: "run-started", prompt: "Retime the projectile launch", approvalMode: "Full auto", autoPlaytest: true, endpoint: "http://127.0.0.1:58741", instanceId: "place:1", model: "opus", effort: "medium", planner: "claude-code" });
    emit({ type: "tasks", tasks: [
      { id: "t1", title: "Inspect the weapon scripts", status: "done", requiresRuntimeEvidence: false, requiredEvidence: [] },
      { id: "t2", title: "Retime the launch and the cooldown", status: "active", requiresRuntimeEvidence: false, requiredEvidence: [] },
      { id: "t3", title: "Playtest and verify", status: "pending", requiresRuntimeEvidence: true, requiredEvidence: ["runtime", "visual"] },
    ] });
    for (let i = 0; i < ${TOOLS}; i++) {
      const callId = "c" + i; const tool = i % 5 === 0 ? "get_script_source" : i % 5 === 1 ? "set_properties" : "get_project_structure";
      const proposal = { callId, tool, arguments: { instancePath: "game.ServerScriptService.Script" + i }, summary: tool + " · game.ServerScriptService.Script" + i, risk: "read" };
      emit({ type: "tool-proposed", proposal });
      emit({ type: "approval-resolved", callId, decision: "approved", automatic: true, reason: "read-allowed" });
      emit({ type: "tool-started", callId, tool });
      emit({ type: "tool-result", callId, tool, ok: true, durationMs: 120, summary: "ok · 42 lines", detail: "{\\"result\\": \\"" + "x".repeat(600) + "\\"}" });
      if (i % 10 === 3) emit({ type: "evidence", evidence: { id: "e" + i, kind: "verification", title: "game.ServerScriptService.Script" + i, passed: true, metadata: [{ label: "Revision after write", value: "rev-" + i }] } });
    }
    for (let c = 0; c < ${CHANGES}; c++) {
      emit({ type: "change", change: { id: "ch" + c, kind: "script-source", target: "game.ServerScriptService.Script" + c, summary: "Retimed", addedLines: ${Math.floor(DIFF_LINES / 8)}, removedLines: ${Math.floor(DIFF_LINES / 8)}, diff, language: "lua", revisionBefore: "sr1:1:a", revisionAfter: "sr1:2:b" } });
    }
    emit({ type: "status", label: "Writing the reply", transient: true });

    // Measure frames while deltas stream at token rate.
    const frames = []; let last = performance.now(); let raf = true;
    const tick = (now) => { frames.push(now - last); last = now; if (raf) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    for (let d = 0; d < ${DELTAS}; d++) {
      emit({ type: "message-delta", text: "word" + (d % 7) + (d % 13 === 0 ? "\\n\\n" : " ") });
      await wait(${EVERY_MS});
    }
    const streamedMs = performance.now() - t0;
    raf = false;
    emit({ type: "run-completed", outcome: "completed", summary: "done", verification: { verified: true, issues: [] } });
    const sorted = [...frames].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      frames: frames.length, streamedMs: Math.round(streamedMs), fps: Math.round(frames.length / (streamedMs / 1000)),
      p50: Math.round(pct(0.5)), p90: Math.round(pct(0.9)), p99: Math.round(pct(0.99)), max: Math.round(sorted[sorted.length - 1]),
      over33: frames.filter((f) => f > 33).length, over100: frames.filter((f) => f > 100).length,
    };
  })()`;
  const result = await js(script);
  console.log(JSON.stringify({ label, changes: CHANGES, diffLines: DIFF_LINES, tools: TOOLS, deltas: DELTAS, everyMs: EVERY_MS, ...result }));
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
