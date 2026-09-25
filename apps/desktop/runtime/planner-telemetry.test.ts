import assert from "node:assert/strict";
import test from "node:test";

import type { AgentLoopTelemetryEvent } from "./agent-loop";
import { createPlannerTelemetryCollector } from "./planner-telemetry";

const turnEvent = (
  turn: number,
  fields: Partial<Extract<AgentLoopTelemetryEvent, { kind: "turn" }>> = {},
): AgentLoopTelemetryEvent => ({
  kind: "turn",
  turn,
  durationMs: 1_000,
  firstEventMs: 900,
  requestCharacters: 1_000,
  estimatedInputTokens: 250,
  completed: true,
  ...fields,
});

test("a turn's tool time is attributed to it, though its calls run afterwards", () => {
  const collector = createPlannerTelemetryCollector();
  // The planner reports a turn when its stream closes, then runs the calls that
  // turn asked for, so the calls always arrive after the record they belong to.
  collector.observe(turnEvent(1, { lastToolCallMs: 950 }));
  collector.observe({ kind: "tool", turn: 1, index: 1, tool: "get_script_source", ok: true, durationMs: 40, resultCharacters: 100 });
  collector.observe({ kind: "tool", turn: 1, index: 2, tool: "search_objects", ok: true, durationMs: 60, resultCharacters: 100 });
  collector.observe(turnEvent(2, { lastToolCallMs: 800 }));
  collector.observe({ kind: "tool", turn: 2, index: 1, tool: "set_properties", ok: false, durationMs: 5, resultCharacters: 10 });
  collector.observe(turnEvent(3));

  const { turns, toolDurationMs } = collector.snapshot();
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2, 3]);
  assert.deepEqual(turns.map((turn) => turn.toolsMs), [100, 5, 0]);
  assert.deepEqual(turns.map((turn) => turn.toolCalls), [2, 1, 0]);
  // The per-turn figures are a decomposition of the total, not a second count.
  assert.equal(turns.reduce((total, turn) => total + turn.toolsMs, 0), toolDurationMs);
});

test("only a turn that asked for a tool has a tail", () => {
  const collector = createPlannerTelemetryCollector();
  collector.observe(turnEvent(1, { durationMs: 4_000, lastToolCallMs: 3_950 }));
  // A turn that ended in prose is finished when its last word arrives, so
  // counting the whole turn as tail would report thinking as overhead.
  collector.observe(turnEvent(2, { durationMs: 4_000 }));

  const { turns, streamTailMs } = collector.snapshot();
  assert.equal(turns[0].tailMs, 50);
  assert.equal(turns[1].tailMs, undefined);
  assert.equal(streamTailMs, 50);
});

test("the per-turn record carries what a trend needs and nothing a person wrote", () => {
  const collector = createPlannerTelemetryCollector();
  collector.observe(turnEvent(1, {
    requestCharacters: 40_000,
    usage: { inputTokens: 10_000, outputTokens: 120, cachedInputTokens: 7_300 },
  }));
  collector.observe(turnEvent(2, {
    requestCharacters: 900_000,
    usage: { inputTokens: 12_000, outputTokens: 90 },
    stalled: true,
  }));

  const { turns } = collector.snapshot();
  // Request size against wait is the whole question: a cost that grows with
  // what is sent is the client's to fix, a flat one is not.
  assert.deepEqual(turns.map((turn) => turn.requestCharacters), [40_000, 900_000]);
  assert.equal(turns[0].cachedInputTokens, 7_300);
  // A provider that reported no cache figure says so rather than reporting zero.
  assert.equal(turns[1].cachedInputTokens, undefined);
  assert.equal(turns[0].stalled, undefined);
  assert.equal(turns[1].stalled, true);

  for (const turn of turns) {
    for (const [key, value] of Object.entries(turn)) {
      assert.equal(typeof value, key === "completed" || key === "stalled" ? "boolean" : "number", key);
    }
  }
});
