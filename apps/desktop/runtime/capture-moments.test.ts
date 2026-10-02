import assert from "node:assert/strict";
import test from "node:test";

import { captureMoments, momentLuau, parseCaptureMoments, stopLuau } from "./capture-moments";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";

type Call = { tool: string; args: Record<string, unknown>; options?: McpCallOptions };

const ok = (data: unknown, extra: Partial<McpToolOutcome> = {}): McpToolOutcome => ({ ok: true, data, text: "", httpStatus: 200, durationMs: 1, ...extra });
const image = (n: number) => ({ data: `image-${n}`, mediaType: "image/jpeg" as const });

/** A Studio that plays the effect to whatever time a moment asks for. */
function fakeStudio(overrides: { start?: McpToolOutcome; reached?: (time: number) => string; capture?: (n: number) => McpToolOutcome } = {}) {
  const calls: Call[] = [];
  let shots = 0;
  const studio: StudioCaller = async (tool, args, options) => {
    calls.push({ tool, args, options });
    if (tool === "capture_screenshot") {
      shots += 1;
      return overrides.capture?.(shots) ?? ok({}, { images: [image(shots)] });
    }
    const code = String(args.code);
    if (code.includes("pcall(h.stop")) return ok({ returnValue: "stopped" });
    const wanted = /< ([\d.]+) and os\.clock/.exec(code);
    if (wanted) return ok({ returnValue: overrides.reached?.(Number(wanted[1])) ?? Number(wanted[1]).toFixed(3) });
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
  assert.deepEqual(parseCaptureMoments({ code: "x()", times: [0.1, 0.4] }), { code: "x()", times: [0.1, 0.4], runtime: "edit", handle: "vfx", hold: true, slow: 0.1 });
  // A trail keeps playing, slowly enough that a capture lands near its time.
  assert.equal((parseCaptureMoments({ code: "x()", times: [0.1], hold: false }) as { slow: number }).slow, 0.04);
  assert.equal((parseCaptureMoments({ code: "x()", times: [0.1], runtime: "client" }) as { target?: string }).target, "client-1");
});

test("a moment plays on to its time, holds when asked, and the end stops the effect", () => {
  const held = momentLuau("vfx", 0.25, 0.1, true);
  assert.match(held, /_G\["vfx"\]/);
  assert.match(held, /h:setTimeScale\(0\.1\)/);
  assert.match(held, /< 0\.25 and os\.clock\(\) - started < 20 and os\.clock\(\) - moved < 1\.5 do/, "an ended effect's stopped clock ends the wait");
  assert.match(held, /h:setTimeScale\(0\)/);
  assert.doesNotMatch(momentLuau("vfx", 0.25, 0.04, false), /setTimeScale\(0\)/);
  assert.match(stopLuau("vfx"), /pcall\(h\.stop, h\)/);
});

test("one call starts the effect, captures every moment in order and stops it", async () => {
  const { studio, calls } = fakeStudio();
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [0.05, 0.3] }, {}, studio);
  assert.equal(outcome.ok, true, outcome.text);
  assert.deepEqual(outcome.images?.map((picture) => picture.data), ["image-1", "image-2"]);
  assert.deepEqual(calls.map((call) => call.tool), ["execute_luau", "execute_luau", "capture_screenshot", "execute_luau", "capture_screenshot", "execute_luau"]);
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
  const { studio } = fakeStudio({ reached: () => "1.200" });
  const outcome = await captureMoments({ code: "_G.vfx = start()", times: [3] }, {}, studio);
  assert.equal(outcome.images?.length, 1);
  assert.match(outcome.text, /at 1\.200 s \(the clock stopped short of 3 s/);
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
