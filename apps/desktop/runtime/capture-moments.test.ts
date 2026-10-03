import assert from "node:assert/strict";
import test from "node:test";

import { captureMoments, momentLuau, parseCaptureMoments, preloadLuau, stopLuau, type ContactSheet } from "./capture-moments";
import type { ClipManifest } from "./clip-store";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";
import type { ChatClips } from "./reference-clip";

type Call = { tool: string; args: Record<string, unknown>; options?: McpCallOptions };

const ok = (data: unknown, extra: Partial<McpToolOutcome> = {}): McpToolOutcome => ({ ok: true, data, text: "", httpStatus: 200, durationMs: 1, ...extra });
const image = (n: number) => ({ data: `image-${n}`, mediaType: "image/jpeg" as const });

/** A Studio that plays the effect to whatever time a moment asks for. */
function fakeStudio(overrides: { start?: McpToolOutcome; reached?: (time: number) => string; capture?: (n: number) => McpToolOutcome; preload?: string; view?: McpToolOutcome } = {}) {
  const calls: Call[] = [];
  let shots = 0;
  const studio: StudioCaller = async (tool, args, options) => {
    calls.push({ tool, args, options });
    if (tool === "capture_screenshot") {
      shots += 1;
      return overrides.capture?.(shots) ?? ok({}, { images: [image(shots)] });
    }
    if (tool === "selection") return overrides.view ?? ok({ success: true });
    const code = String(args.code);
    if (code.includes("pcall(h.stop")) return ok({ returnValue: "stopped" });
    if (code.includes("PreloadAsync")) return ok({ returnValue: overrides.preload ?? "loaded" });
    const wanted = /local target = ([\d.]+)/.exec(code);
    if (wanted) return ok({ returnValue: overrides.reached?.(Number(wanted[1])) ?? `${Number(wanted[1]).toFixed(3)}|done` });
    return overrides.start ?? ok({ returnValue: "" });
  };
  return { studio, calls };
}

test("arguments are checked before anything runs", () => {
  assert.match(String(parseCaptureMoments({ times: [0.1] })), /code must be/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [] })), /1-8 effect seconds/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.3, 0.1] })), /ascending/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], handle: "_G.vfx" })), /plain global name/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], slow: 3 })), /0\.01 to 1/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: Array.from({ length: 9 }, (_, i) => i) })), /1-8/);
  assert.deepEqual(parseCaptureMoments({ code: "x()", times: [0.1, 0.4] }), { code: "x()", times: [0.1, 0.4], runtime: "edit", handle: "vfx", hold: true, slow: 0.1, sheet: true });
  // A trail keeps playing, slowly enough that a capture lands near its time.
  assert.equal((parseCaptureMoments({ code: "x()", times: [0.1], hold: false }) as { slow: number }).slow, 0.04);
  assert.equal((parseCaptureMoments({ code: "x()", times: [0.1], runtime: "client" }) as { target?: string }).target, "client-1");
});

test("a moment travels at normal speed, slows for the last stretch, holds when asked, and the end stops the effect", () => {
  const held = momentLuau("vfx", 0.25, 0.1, true);
  assert.match(held, /_G\["vfx"\]/);
  assert.match(held, /local target = 0\.25/);
  // 1.5 s of real time at 0.1x is the last 0.15 s of effect time.
  assert.match(held, /if clock\(\) < target - 0\.15 then playTo\(target - 0\.15, 1\) end/);
  assert.match(held, /playTo\(target, 0\.1\)/);
  assert.match(held, /h\.finished ~= true and os\.clock\(\) - started < 20 and os\.clock\(\) - moved < 1\.5 do/, "an ended effect's stopped clock ends the wait");
  assert.match(held, /scale\(0\)/);
  assert.match(held, /"done" or \(\(h\.finished == true or os\.clock\(\) - moved >= 1\.5\) and "stalled" or "capped"\)/);
  // A finished handle has restored what it changed; it is never scaled again.
  assert.match(held, /local function scale\(speed\) if h\.finished ~= true then h:setTimeScale\(speed\) end end/);
  assert.doesNotMatch(held.replace(/local function scale[^\n]*\n/, ""), /h:setTimeScale/);
  const trail = momentLuau("vfx", 1.2, 0.04, false);
  // A trail is drawn slowly for as much of its life as one wait covers: 20 s at 0.04x is 0.8 s.
  assert.match(trail, /playTo\(target - 0\.8, 1\)/);
  assert.doesNotMatch(trail, /scale\(0\)/);
  // At the slowest speed the slow stretch still fits one wait.
  assert.match(momentLuau("vfx", 2, 0.01, false), /playTo\(target - 0\.2, 1\)/);
  assert.match(stopLuau("vfx"), /pcall\(h\.stop, h\)/);
});

test("one call starts the effect, captures every moment in order and stops it", async () => {
  const { studio, calls } = fakeStudio();
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.05, 0.3] }, {}, studio);
  assert.equal(outcome.ok, true, outcome.text);
  assert.deepEqual(outcome.images?.map((picture) => picture.data), ["image-1", "image-2"]);
  assert.deepEqual(calls.map((call) => call.tool), ["execute_luau", "execute_luau", "execute_luau", "capture_screenshot", "execute_luau", "capture_screenshot", "execute_luau"]);
  assert.match(String(calls[1].args.code), /PreloadAsync/, "the effect waits for its textures before the first moment");
  assert.equal(calls[0].args.code, "_G.vfx = start()");
  assert.match(String(calls.at(-1)?.args.code), /pcall\(h\.stop, h\)/);
  assert.match(outcome.text, /Captured 2 of 2 moments, held still/);
  assert.match(outcome.text, /- 0\.05 s, at 0\.050 s: image 1\n- 0\.3 s, at 0\.300 s: image 2/);
});

test("in a playtest the code runs on the client peer", async () => {
  const { studio, calls } = fakeStudio();
  await captureMoments({ code: "_G.vfx = start()", times: [0.1], runtime: "client", target: "client-2" }, {}, studio);
  const runs = calls.filter((call) => call.tool !== "capture_screenshot");
  assert.ok(runs.every((call) => call.tool === "eval_client_runtime" && call.args.target === "client-2"));
});

test("a clock that stops short is captured anyway, and said so", async () => {
  const { studio } = fakeStudio({ reached: () => "1.200|stalled" });
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [3] }, {}, studio);
  assert.equal(outcome.images?.length, 1);
  assert.match(outcome.text, /at 1\.200 s \(the clock stopped short of 3 s: the effect had ended\)/);
});

test("a call that runs short of time captures no further moments, and says which", async () => {
  const { studio, calls } = fakeStudio();
  // 30 s leaves no room for a 20 s wait after the reserve for stopping the effect.
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.1, 0.2] }, { timeoutMs: 30_000 }, studio);
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /Not captured, because this call's time ran out first: 0\.1 s, 0\.2 s\. Capture them in another call\./);
  assert.equal(calls.filter((call) => call.tool === "capture_screenshot").length, 0);
  assert.match(String(calls.at(-1)?.args.code), /pcall\(h\.stop, h\)/, "the effect is still stopped");
});

test("a wait that runs out of its call's budget carries on in another call, up to a limit", async () => {
  let waits = 0;
  const { studio } = fakeStudio({ reached: () => (++waits < 3 ? `${waits * 0.5}|capped` : "1.500|done") });
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [1.5] }, {}, studio);
  assert.equal(waits, 3);
  assert.match(outcome.text, /- 1\.5 s, at 1\.500 s: image 1/);
  let endless = 0;
  const capped = await captureMoments({ code: "_G.vfx = start()", times: [50] }, {}, fakeStudio({ reached: () => `${++endless}|capped` }).studio);
  assert.equal(endless, 4);
  assert.match(capped.text, /at 4\.000 s \(still short of 50 s when the waiting ran out\)/);
});

test("code that fails to start captures nothing and still ends the effect", async () => {
  const { studio, calls } = fakeStudio({ start: { ok: false, data: undefined, text: "", message: "attempt to index nil", httpStatus: 200, durationMs: 1 } });
  const outcome = await captureMoments({ code: "_G.vfx = nope()", times: [0.1] }, {}, studio);
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /failed, so nothing was captured: attempt to index nil/);
  assert.equal(calls.some((call) => call.tool === "capture_screenshot"), false);
  assert.match(String(calls.at(-1)?.args.code), /pcall\(h\.stop, h\)/);
});

test("a missing handle is named, and nothing is captured", async () => {
  const { studio } = fakeStudio({ reached: () => "no-handle" });
  const outcome = await captureMoments({ code: "start()", times: [0.1, 0.2] }, {}, studio);
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /_G\.vfx is not a handle with setTimeScale/);
});

test("a cancelled run stops capturing but still ends the effect", async () => {
  const controller = new AbortController();
  const { studio, calls } = fakeStudio({ capture: (n) => { controller.abort(); return ok({}, { images: [image(n)] }); } });
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.1, 0.2, 0.3] }, { signal: controller.signal }, studio).catch((error: Error) => error);
  assert.ok(outcome instanceof Error && /cancelled/.test(outcome.message));
  const stop = calls.at(-1);
  assert.match(String(stop?.args.code), /pcall\(h\.stop, h\)/);
  assert.equal(stop?.options?.signal, undefined, "the clean-up call does not carry the cancelled signal");
  assert.equal(calls.filter((call) => call.tool === "capture_screenshot").length, 1);
});

test("the frames come back tiled into one image when the host can tile them", async () => {
  const { studio } = fakeStudio();
  const tiled: Array<{ count: number; columns: number }> = [];
  const sheet = async (images: readonly { data: string }[], columns: number) => {
    tiled.push({ count: images.length, columns });
    return { data: "sheet", mediaType: "image/jpeg" as const };
  };
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.1, 0.2, 0.3] }, {}, studio, sheet);
  assert.deepEqual(tiled, [{ count: 3, columns: 2 }]);
  assert.deepEqual(outcome.images?.map((picture) => picture.data), ["sheet"]);
  assert.match(outcome.text, /tiled into one image, 2 to a row, left to right then top to bottom/);
  assert.match(outcome.text, /- 0\.3 s, at 0\.300 s: frame 3/);
});

test("frames come back one image each when asked, when there is one, or when tiling fails", async () => {
  const sheet = async () => ({ data: "sheet", mediaType: "image/jpeg" as const });
  const separate = await captureMoments({ code: "_G.vfx = start()", times: [0.1, 0.2], sheet: false }, {}, fakeStudio().studio, sheet);
  assert.deepEqual(separate.images?.map((picture) => picture.data), ["image-1", "image-2"]);
  assert.match(separate.text, /The images follow in this order/);
  const single = await captureMoments({ code: "_G.vfx = start()", times: [0.1] }, {}, fakeStudio().studio, sheet);
  assert.deepEqual(single.images?.map((picture) => picture.data), ["image-1"]);
  const failing = await captureMoments({ code: "_G.vfx = start()", times: [0.1, 0.2] }, {}, fakeStudio().studio, async () => { throw new Error("no decoder"); });
  assert.equal(failing.images?.length, 2);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], sheet: "yes" })), /sheet must be true or false/);
});

test("the effect is held where it is while everything under its root loads, for a bounded time", () => {
  const preload = preloadLuau("vfx");
  assert.match(preload, /_G\["vfx"\]/);
  assert.match(preload, /local root = h\.root/);
  assert.match(preload, /if typeof\(root\) ~= "Instance" then return "no-root" end/);
  assert.match(preload, /if h\.finished ~= true then h:setTimeScale\(0\) end/);
  assert.match(preload, /ContentProvider:PreloadAsync\(\{ root \}\)/);
  assert.match(preload, /os\.clock\(\) - started < 10/);
  assert.match(preload, /return done and "loaded" or "loading"/);
});

test("textures still loading after the wait are said so; loaded ones and handles without a root say nothing", async () => {
  const loading = await captureMoments({ code: "_G.vfx = start()", times: [0.1] }, {}, fakeStudio({ preload: "loading" }).studio);
  assert.match(loading.text, /textures were still loading after 10 s, so early frames may be missing layers/);
  for (const preload of ["loaded", "no-root"]) {
    const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.1] }, {}, fakeStudio({ preload }).studio);
    assert.equal(outcome.ok, true);
    assert.doesNotMatch(outcome.text, /still loading/);
  }
});

test("a view aims the edit camera before the effect starts, in the same call", async () => {
  const { studio, calls } = fakeStudio();
  const outcome = await captureMoments({
    code: "_G.vfx = start()", times: [0.1], view: { path: "game.Workspace.SlamPreview", from: 30, angleY: 20 },
  }, {}, studio);
  assert.equal(outcome.ok, true, outcome.text);
  assert.deepEqual(calls[0].args, { action: "view", path: "game.Workspace.SlamPreview", from: 30, angleY: 20 });
  assert.equal(calls[0].tool, "selection");
  assert.equal(calls[1].args.code, "_G.vfx = start()");

  const refused = fakeStudio({ view: { ok: false, data: undefined, text: "", message: "Instance not found", httpStatus: 200, durationMs: 1 } });
  const missed = await captureMoments({ code: "_G.vfx = start()", times: [0.1], view: { path: "game.Workspace.Nope" } }, {}, refused.studio);
  assert.equal(missed.ok, false);
  assert.match(missed.text, /Aiming the camera at game\.Workspace\.Nope failed, so nothing was started or captured: Instance not found/);
  assert.deepEqual(refused.calls.map((call) => call.tool), ["selection"]);
});

test("a view is checked with the other arguments", () => {
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], view: "game.Workspace.A" })), /view must be an object/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], view: { from: 30 } })), /view\.path must name the instance/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], view: { path: "game.Workspace.A", angleY: "20" } })), /view\.angleY must be a number/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], runtime: "client", view: { path: "game.Workspace.A" } })), /player's own view, so leave view out/);
  assert.deepEqual((parseCaptureMoments({ code: "x()", times: [0.1], view: { path: "game.Workspace.A", padding: 2 } }) as { view?: unknown }).view, { path: "game.Workspace.A", padding: 2 });
});

const CLIP = "0123456789ab";

/** A chat's reference clip: frames 1/30 s apart from the start of its selection, cropped to its right half. */
function chatClips(): ChatClips & { frames: number[] } {
  const manifest: ClipManifest = {
    version: 1, id: CLIP, name: "nova.mp4", duration: 3, width: 1280, height: 720,
    selection: { start: 1, end: 2, slow: 1 },
    frames: Array.from({ length: 31 }, (_, index) => 1 + index / 30),
    analysis: { active: true, cameraMoves: false, phases: [], crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    createdAt: "2026-10-03T12:00:00.000Z",
  };
  const frames: number[] = [];
  return {
    frames,
    list: async () => [manifest],
    read: async (id) => (id === CLIP ? manifest : undefined),
    frame: async (_manifest, index) => {
      frames.push(index);
      return Buffer.from([0xff, 0xd8, 0xff, index]);
    },
  };
}

test("a reference is checked with the other arguments", () => {
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], reference: "nova" })), /reference must be an object/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1], reference: { clip: "nova" } })), /reference\.clip must be a clip's id/);
  assert.match(String(parseCaptureMoments({ code: "x()", times: [0.1, 0.2], reference: { clip: CLIP, times: [0.1] } })), /one effect second of the clip for each of the 2 moments/);
  assert.deepEqual((parseCaptureMoments({ code: "x()", times: [0.1, 0.2], reference: { clip: CLIP, times: [0.3, 0.5] } }) as { reference?: unknown }).reference, { clip: CLIP, times: [0.3, 0.5] });
});

test("with a reference, each moment comes back beside the clip's frame at its time, in one image", async () => {
  const { studio } = fakeStudio();
  const clips = chatClips();
  const tiled: Array<{ data: string[]; columns: number; labels?: readonly string[]; crops?: readonly unknown[] }> = [];
  const sheet: ContactSheet = async (images, columns, options) => {
    tiled.push({ data: images.map((picture) => picture.data), columns, labels: options?.labels, crops: options?.crops });
    return { data: "comparison", mediaType: "image/jpeg" };
  };
  const outcome = await captureMoments({
    code: "_G.vfx = start()", times: [0.1, 0.2, 0.3], sheet: false, reference: { clip: CLIP, times: [0.1, 0.2, 0.5] },
  }, {}, studio, sheet, clips);
  assert.equal(outcome.ok, true, outcome.text);
  assert.deepEqual(outcome.images?.map((picture) => picture.data), ["comparison"], "one image whatever sheet says");
  // The clip's frames at 0.1, 0.2 and 0.5 s are its 4th, 7th and 16th (1/30 s apart).
  assert.deepEqual(clips.frames, [3, 6, 15]);
  assert.equal(tiled[0]!.columns, 4);
  assert.deepEqual(tiled[0]!.data.filter((_, index) => index % 2 === 1), ["image-1", "image-2", "image-3"]);
  assert.deepEqual(tiled[0]!.labels, ["R1 0.10s", "S1 0.10s", "R2 0.20s", "S2 0.20s", "R3 0.50s", "S3 0.30s"]);
  assert.deepEqual(tiled[0]!.crops?.[0], { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.equal(tiled[0]!.crops?.[1], undefined, "Studio's frames are not cropped");
  assert.match(outcome.text, /Each moment is paired with reference clip 0123456789ab in one image, two pairs to a row/);
  assert.match(outcome.text, /- 0\.3 s, at 0\.300 s: pair 3, beside the clip at 0\.50 s\n/);
  assert.deepEqual((outcome.data as { comparedWith?: string }).comparedWith, CLIP);

  // A time past the clip's end shows its last frame, and says so.
  const past = await captureMoments({ code: "_G.vfx = start()", times: [0.1], reference: { clip: CLIP, times: [2.5] } }, {}, fakeStudio().studio, sheet, chatClips());
  assert.match(past.text, /pair 1, beside the clip at 1\.00 s \(the clip ends at 1\.00 s; its last frame is shown\)/);
});

test("a reference the chat does not hold is refused before anything starts in Studio", async () => {
  const { studio, calls } = fakeStudio();
  const missing = await captureMoments({ code: "_G.vfx = start()", times: [0.1], reference: { clip: "aaaaaaaaaaaa" } }, {}, studio, undefined, chatClips());
  assert.equal(missing.ok, false);
  assert.match(missing.text, /This chat has no clip aaaaaaaaaaaa\. This chat's clips, most recently used first: 0123456789ab/);
  const none = await captureMoments({ code: "_G.vfx = start()", times: [0.1], reference: { clip: CLIP } }, {}, studio);
  assert.match(none.text, /holds no reference clips to compare with/);
  assert.deepEqual(calls, []);
});

test("when the pairs cannot be made, the moments come back on their own, and say why", async () => {
  const { studio } = fakeStudio();
  const clips = { ...chatClips(), frame: async () => { throw new Error("gone"); } };
  const sheet: ContactSheet = async () => ({ data: "plain", mediaType: "image/jpeg" });
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.1, 0.2], reference: { clip: CLIP } }, {}, studio, sheet, clips);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.images?.map((picture) => picture.data), ["plain"]);
  assert.match(outcome.text, /could not pair the frames with the clip's/);
  assert.equal((outcome.data as { comparedWith?: string }).comparedWith, undefined);
});