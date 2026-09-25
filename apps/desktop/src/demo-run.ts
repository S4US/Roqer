import { evaluateCompletion } from "../shared/completion";
import { riskForTool, summarizeToolCall } from "../shared/mcp-tools";
import { decideToolPolicy } from "../shared/policy";
import type {
  RunChange, RunEvent, RunEventBody, RunEvidence, RunOutcome, RunStartRequest, ToolProposal,
} from "../shared/run-events";
import { isAnswerIndex, isEscapeAnswer, QUESTION_ESCAPE_OPTION } from "../shared/question";
import { normalizeSteer } from "../shared/steer";

/**
 * The demo run.
 *
 * Renderer development happens in a plain browser, where there is no main
 * process, no MCP client, and therefore no real agent. Rather than keep a
 * second rendering path alive for that case, the demo emits the same event
 * schema a real run does, so the conversation, the approval card, and the
 * evidence views are exercised by exactly the code that serves real runs.
 *
 * Everything it reports is invented. It identifies itself as `planner: "demo"`
 * and the interface labels it, so a demo run is never mistaken for real work.
 */

export const DEMO_PLANNER = "demo";

type ApprovalAnswer = "approved" | "rejected" | "cancelled";

export type DemoRunHandle = {
  cancel(): void;
  respond(callId: string, decision: "approved" | "rejected"): boolean;
  answer(callId: string, answerIndex: number): boolean;
  steer(text: string): boolean;
};

const SCRIPT_PATH = "game.ServerScriptService.FireballService";

/**
 * Invented, in the exact format `shared/text-diff.ts` produces: two hunks far
 * apart in one file, folded unchanged regions between them, and context either
 * side of each change — so the demo exercises the code surface, not a single
 * changed line.
 */
const DEMO_DIFF = [
  "@@ 12 unchanged lines @@",
  " local function launch(origin, direction)",
  " \tlocal fireball = template:Clone()",
  " \tfireball.CFrame = CFrame.new(origin)",
  "-\tfireball.Velocity = direction * 80",
  "+\tfireball.AssemblyLinearVelocity = direction * PROJECTILE_SPEED",
  "+\tfireball:AddTag(\"Projectile\")",
  " \tfireball.Parent = workspace.Effects",
  " end",
  "@@ 24 unchanged lines @@",
  " local function onCast(player, origin, direction)",
  " \tif not canCast(player) then",
  " \t\treturn",
  " \tend",
  "-\tlaunch(origin, direction)",
  "+\tlaunch(origin, direction.Unit)",
  " \tlastCast[player] = os.clock()",
  " end",
].join("\n");

export function startDemoRun(
  runId: string,
  request: RunStartRequest,
  emit: (event: RunEvent) => void,
): DemoRunHandle {
  let seq = 0;
  let finished = false;
  let pendingCallId: string | null = null;
  let resumeFromApproval: ((answer: ApprovalAnswer) => void) | null = null;
  let pendingQuestion: { callId: string; options: string[] } | null = null;
  let resumeFromQuestion: ((answerIndex: number | null) => void) | null = null;
  const timers: number[] = [];

  // The demo runs the same gate over its own invented evidence, so demo mode
  // exercises the real completion contract instead of asserting a clean result.
  const changes: RunChange[] = [];
  const evidence: RunEvidence[] = [];
  let failureCount = 0;

  const send = (event: RunEventBody) => {
    if (finished) return;
    if (event.type === "change") changes.push(event.change);
    if (event.type === "evidence") evidence.push(event.evidence);
    if (event.type === "failure") failureCount += 1;
    seq += 1;
    emit({ ...event, runId, seq, at: new Date().toISOString() } as RunEvent);
  };

  const finish = (outcome: RunOutcome, summary: string) => {
    if (finished) return;
    send({
      type: "run-completed",
      outcome,
      summary,
      verification: evaluateCompletion({ outcome, tasks: [], changes, evidence, failureCount }),
    });
    finished = true;
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
  };

  const wait = (delay: number) => new Promise<void>((resolve) => {
    timers.push(window.setTimeout(resolve, delay));
  });

  const proposalFor = (tool: string, args: Record<string, unknown>, index: number): ToolProposal => ({
    callId: `${runId}-call-${index}`,
    tool,
    arguments: args,
    summary: summarizeToolCall(tool, args),
    risk: riskForTool(tool, args),
  });

  /**
   * Mirrors the engine's gate exactly: propose, apply policy, ask only when
   * policy says to ask. Returns false when the call did not go ahead.
   */
  const gate = async (proposal: ToolProposal): Promise<boolean> => {
    send({ type: "tool-proposed", proposal });
    const decision = decideToolPolicy(request.approvalMode, proposal.risk);

    if (decision.outcome === "deny") {
      send({
        type: "approval-resolved",
        callId: proposal.callId,
        decision: "rejected",
        automatic: true,
        reason: decision.reason,
      });
      return false;
    }

    if (decision.outcome === "ask") {
      send({
        type: "approval-requested",
        callId: proposal.callId,
        proposal,
        reason: decision.reason,
      });
      pendingCallId = proposal.callId;
      const answer = await new Promise<ApprovalAnswer>((resolve) => {
        resumeFromApproval = resolve;
      });
      pendingCallId = null;
      resumeFromApproval = null;
      if (answer === "cancelled") return false;
      send({
        type: "approval-resolved",
        callId: proposal.callId,
        decision: answer,
        automatic: false,
        reason: decision.reason,
      });
      if (answer === "rejected") return false;
    } else {
      send({
        type: "approval-resolved",
        callId: proposal.callId,
        decision: "approved",
        automatic: true,
        reason: decision.reason,
      });
    }

    send({ type: "tool-started", callId: proposal.callId, tool: proposal.tool });
    await wait(650);
    if (finished) return false;
    send({
      type: "tool-result",
      callId: proposal.callId,
      tool: proposal.tool,
      ok: true,
      durationMs: 650,
      summary: `${proposal.tool} returned a sample result`,
    });
    return true;
  };

  const play = async () => {
    send({
      type: "run-started",
      prompt: request.prompt,
      approvalMode: request.approvalMode,
      autoPlaytest: request.autoPlaytest,
      endpoint: request.endpoint,
      instanceId: request.instanceId,
      model: request.model,
      effort: request.effort,
      planner: DEMO_PLANNER,
    });

    send({ type: "status", label: "Inspecting the connected project", detail: "Demo data — nothing is read from Studio." });
    await wait(600);
    if (finished) return;

    const inspected = await gate(proposalFor("get_project_structure", { scriptsOnly: true, maxDepth: 4 }, 1));
    if (finished) return;
    if (!inspected) {
      finish("refused", "The demo stopped because inspection was not permitted.");
      return;
    }

    send({ type: "message-delta", text: "This is a demo run. In the desktop app the same steps read your real place through the MCP bridge." });

    // One question, the same way a real run asks: the run suspends until the
    // renderer answers by index, and the host's "none of these" is one past the
    // options the demo wrote. Cancelling records it as unanswered.
    const questionCallId = `${runId}-question-1`;
    const questionOptions = ["Only the launch timing", "Timing and the cast direction"];
    pendingQuestion = { callId: questionCallId, options: questionOptions };
    send({
      type: "question-asked",
      question: { callId: questionCallId, question: "How much of the fireball script should the demo retime?", options: questionOptions },
    });
    const answerIndex = await new Promise<number | null>((resolve) => { resumeFromQuestion = resolve; });
    pendingQuestion = null;
    resumeFromQuestion = null;
    if (answerIndex === null || finished) return;
    send({
      type: "question-answered",
      callId: questionCallId,
      answerIndex,
      answer: isEscapeAnswer(answerIndex, questionOptions) ? QUESTION_ESCAPE_OPTION : questionOptions[answerIndex],
      cancelled: false,
    });

    const applied = await gate(proposalFor("set_script_source", {
      instancePath: SCRIPT_PATH,
      expectedRevision: "sr1:412:demo0000demo0000",
    }, 2));
    if (finished) return;

    if (!applied) {
      finish("refused", request.approvalMode === "Read only"
        ? "Read only mode blocked the sample change."
        : "The sample change was not approved.");
      return;
    }

    send({
      type: "change",
      change: {
        id: `${runId}-change-1`,
        kind: "script-source",
        target: SCRIPT_PATH,
        summary: "Retimed the projectile launch and normalised the cast direction",
        addedLines: 3,
        removedLines: 2,
        diff: DEMO_DIFF,
        language: "lua",
        revisionBefore: "sr1:412:demo0000demo0000",
        revisionAfter: "sr1:461:demo1111demo1111",
      },
    });

    send({
      type: "evidence",
      evidence: {
        id: `${runId}-evidence-verify`,
        kind: "verification",
        title: SCRIPT_PATH,
        passed: true,
        detail: "Invented read-back — a desktop run verifies the real script in Studio.",
      },
    });

    if (request.autoPlaytest) {
      send({ type: "status", label: "Running a sample playtest" });
      await wait(900);
      if (finished) return;
      send({
        type: "evidence",
        evidence: {
          id: `${runId}-evidence-1`,
          kind: "playtest",
          title: "Sample playtest",
          passed: true,
          detail: "Invented result — the desktop app runs a real playtest through MCP.",
          lines: ["Requested behavior detected", "Runtime remained stable", "No new server errors"],
        },
      });
    }

    finish("completed", "Demo run finished. Connect the desktop app to run this for real.");
  };

  void play();

  return {
    cancel() {
      if (finished) return;
      resumeFromApproval?.("cancelled");
      if (pendingQuestion) {
        send({ type: "question-answered", callId: pendingQuestion.callId, answerIndex: -1, answer: "", cancelled: true });
        resumeFromQuestion?.(null);
      }
      finish("cancelled", "The demo run was stopped.");
    },
    respond(callId, decision) {
      if (finished || pendingCallId !== callId || !resumeFromApproval) return false;
      resumeFromApproval(decision);
      return true;
    },
    answer(callId, answerIndex) {
      if (finished || !pendingQuestion || pendingQuestion.callId !== callId || !resumeFromQuestion) return false;
      if (!isAnswerIndex(answerIndex, pendingQuestion.options)) return false;
      resumeFromQuestion(answerIndex);
      return true;
    },
    // There is no model to read it, but the note still lands in the timeline
    // the way it would in a real run, so the interface can be exercised.
    steer(text) {
      const normalized = normalizeSteer(text);
      if (finished || normalized === null) return false;
      send({ type: "steer", text: normalized });
      return true;
    },
  };
}
