import type { AgentLoopTelemetryEvent } from "./agent-loop";

export type PlannerToolCallMetric = Readonly<{
  /** Which model turn asked for it, so tool time can be attributed per turn. */
  turn: number;
  tool: string;
  ok: boolean;
  durationMs: number;
  resultCharacters: number;
}>;

/**
 * One turn, kept rather than only summed.
 *
 * The totals below answer "where did the run's time go"; they cannot answer
 * "and does it get worse". A per-turn wait that is flat across a run and one
 * that climbs with the conversation have the same sum and completely different
 * causes -- a fixed cost at the aggregator against prompt processing that grows
 * with what is being sent -- and only the second is something the client can
 * fix. Retained in full because the planner's own loop already bounds how many
 * there can be.
 */
export type PlannerTurnMetric = Readonly<{
  turn: number;
  durationMs: number;
  firstEventMs?: number;
  firstTextMs?: number;
  firstToolCallMs?: number;
  lastToolCallMs?: number;
  /** What the turn spent after its last tool call. Absent when it asked for none. */
  tailMs?: number;
  requestCharacters: number;
  estimatedInputTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  completed: boolean;
  stalled?: boolean;
  /** This turn's own tool calls, which run after the turn stream closes. */
  toolsMs: number;
  toolCalls: number;
}>;

export type PlannerTelemetryMetrics = Readonly<{
  modelTurns: number;
  /**
   * Turns ended because the model made no semantic progress. Counted on its own
   * rather than folded into failures: a stall is a reliability property of a
   * model and effort, and averaging it into "the run failed" hides the arm that
   * is doing it.
   */
  stalledTurns: number;
  /**
   * Tries at a turn that the endpoint failed transiently, after which the loop
   * sent the same turn again. They are not turns: their time counts toward the
   * stream total, and any tokens the endpoint reported for them toward the token
   * totals, but the per-turn record holds only the try that went through.
   */
  retriedAttempts: number;
  measuredUsageTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  accumulatedContextTokens: number;
  peakTurnContextCharacters: number;
  toolResultCharacters: number;
  /**
   * Where the run's wall time went, summed over its turns. Divide by
   * `modelTurns` for a per-turn figure.
   *
   * These four are separated because they have different causes and different
   * fixes, and a single "the agent is slow" reading cannot tell them apart.
   * `timeToFirstEventMs` is everything before the endpoint says anything --
   * authorization, the connection, any retry the transport waited out, and the
   * model's own thinking. `streamDurationMs` is the whole turn stream.
   * `streamTailMs` is what a turn spends after the model has finished asking
   * for its last tool, which is orchestration cost rather than inference and
   * should be near zero. `toolDurationMs` is the work itself.
   */
  streamDurationMs: number;
  timeToFirstEventMs: number;
  streamTailMs: number;
  toolDurationMs: number;
  modelToolCalls: readonly PlannerToolCallMetric[];
  /** The same run, turn by turn, so the totals above can be read as a trend. */
  turns: readonly PlannerTurnMetric[];
}>;

/**
 * Collects numeric agent-loop telemetry without retaining model or tool content.
 *
 * Shared by the evaluation harness and by the app's own turn timing log, so the
 * `wait / tools / tail` split means the same thing in a measured run and in an
 * ordinary one. Two copies of this arithmetic would be free to disagree, and a
 * measurement that only reproduces under the rig is not a measurement.
 */
export function createPlannerTelemetryCollector(): Readonly<{
  observe: (event: AgentLoopTelemetryEvent) => void;
  snapshot: () => PlannerTelemetryMetrics;
}> {
  const calls: PlannerToolCallMetric[] = [];
  /** Everything but the tool sums, which are only knowable once the turn's calls have run. */
  const turns: Omit<PlannerTurnMetric, "toolsMs" | "toolCalls">[] = [];
  let modelTurns = 0;
  let stalledTurns = 0;
  let retriedAttempts = 0;
  let measuredUsageTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let accumulatedContextTokens = 0;
  let peakTurnContextCharacters = 0;
  let toolResultCharacters = 0;
  let streamDurationMs = 0;
  let timeToFirstEventMs = 0;
  let streamTailMs = 0;
  let toolDurationMs = 0;

  return {
    observe(event: AgentLoopTelemetryEvent): void {
      if (event.kind === "turn" && event.retried === true) {
        retriedAttempts += 1;
        streamDurationMs += event.durationMs;
        timeToFirstEventMs += event.firstEventMs ?? 0;
        inputTokens += event.usage?.inputTokens ?? 0;
        outputTokens += event.usage?.outputTokens ?? 0;
        cachedInputTokens += event.usage?.cachedInputTokens ?? 0;
        return;
      }
      if (event.kind === "turn") {
        modelTurns += 1;
        if (event.stalled === true) stalledTurns += 1;
        streamDurationMs += event.durationMs;
        timeToFirstEventMs += event.firstEventMs ?? 0;
        // Only a turn that asked for a tool has a tail to measure: one that
        // ended in prose is finished the moment its last word arrives, so
        // counting the whole turn there would report thinking as overhead.
        if (event.lastToolCallMs !== undefined) {
          streamTailMs += Math.max(0, event.durationMs - event.lastToolCallMs);
        }
        peakTurnContextCharacters = Math.max(peakTurnContextCharacters, event.requestCharacters);
        accumulatedContextTokens += event.usage?.inputTokens ?? event.estimatedInputTokens;
        if (event.usage !== undefined) {
          measuredUsageTurns += 1;
          inputTokens += event.usage.inputTokens;
          outputTokens += event.usage.outputTokens;
          cachedInputTokens += event.usage.cachedInputTokens ?? 0;
        }
        turns.push({
          turn: event.turn,
          durationMs: event.durationMs,
          ...(event.firstEventMs === undefined ? {} : { firstEventMs: event.firstEventMs }),
          ...(event.firstTextMs === undefined ? {} : { firstTextMs: event.firstTextMs }),
          ...(event.firstToolCallMs === undefined ? {} : { firstToolCallMs: event.firstToolCallMs }),
          ...(event.lastToolCallMs === undefined
            ? {}
            : {
              lastToolCallMs: event.lastToolCallMs,
              tailMs: Math.max(0, event.durationMs - event.lastToolCallMs),
            }),
          requestCharacters: event.requestCharacters,
          estimatedInputTokens: event.estimatedInputTokens,
          ...(event.usage === undefined ? {} : {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            ...(event.usage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: event.usage.cachedInputTokens }),
          }),
          completed: event.completed,
          ...(event.stalled === true ? { stalled: true } : {}),
        });
        return;
      }

      calls.push({
        turn: event.turn,
        tool: event.tool,
        ok: event.ok,
        durationMs: event.durationMs,
        resultCharacters: event.resultCharacters,
      });
      toolResultCharacters += event.resultCharacters;
      toolDurationMs += event.durationMs;
    },

    snapshot(): PlannerTelemetryMetrics {
      return {
        modelTurns,
        stalledTurns,
        retriedAttempts,
        measuredUsageTurns,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        accumulatedContextTokens,
        peakTurnContextCharacters,
        toolResultCharacters,
        streamDurationMs,
        timeToFirstEventMs,
        streamTailMs,
        toolDurationMs,
        modelToolCalls: [...calls],
        // Attributed here rather than as the calls arrive, because a turn's own
        // calls run after its stream has closed and its record already exists.
        turns: turns.map((turn) => {
          const own = calls.filter((call) => call.turn === turn.turn);
          return {
            ...turn,
            toolsMs: own.reduce((total, call) => total + call.durationMs, 0),
            toolCalls: own.length,
          };
        }),
      };
    },
  };
}
