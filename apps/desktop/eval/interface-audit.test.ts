import assert from "node:assert/strict";
import test from "node:test";

import type { McpToolCaller, McpToolOutcome } from "../runtime/mcp-types";
import { auditInterface } from "./interface-audit";

const outcome = (data: unknown, ok = true): McpToolOutcome => ({ ok, data, text: "", httpStatus: 200, durationMs: 1 });

/** A Studio whose client joins after `clientAfter` polls and whose shop reaches PlayerGui after `guiAfter` audits. */
function fakeStudio({ clientAfter = 1, guiAfter = 1, issues = [] as unknown[], startOk = true } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let polls = 0;
  let audits = 0;
  const caller: McpToolCaller = {
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "solo_playtest") return outcome({}, args.action === "stop" || startOk);
      if (tool === "get_connected_instances") {
        polls += 1;
        return outcome({ instances: [{ id: "place-1", roles: polls > clientAfter ? ["edit", "server", "client-1"] : ["edit"] }] });
      }
      if (tool === "inspect_ui") {
        audits += 1;
        const shop = audits > guiAfter;
        return outcome({
          elements: shop
            ? [{ path: "Players.Ada.PlayerGui.Shop" }, { path: "Players.Ada.PlayerGui.Shop.Card.Title" }, { path: "Players.Ada.PlayerGui.Chat" }]
            : [{ path: "Players.Ada.PlayerGui.Chat" }],
          audit: { success: true, issues },
        });
      }
      return outcome({});
    },
  };
  return { caller, calls };
}

const fast = { pollMs: 1, clientTimeoutMs: 200, guiTimeoutMs: 200 };

test("the harness audits the named interface in its own playtest and always stops it", async () => {
  const { caller, calls } = fakeStudio({
    issues: [
      { code: "text_obscured", path: "Players.Ada.PlayerGui.Shop.Card.Title" },
      { code: "text_overflow", path: "Players.Ada.PlayerGui.Chat.Line" },
    ],
  });
  const result = await auditInterface(caller, "place-1", "Shop", fast);

  assert.deepEqual(result, {
    ran: true, elements: 2, issues: [{ code: "text_obscured", path: "Players.Ada.PlayerGui.Shop.Card.Title" }],
  }, "issues outside the task's interface are not the task's");
  const playtests = calls.filter((call) => call.tool === "solo_playtest").map((call) => call.args.action);
  assert.deepEqual(playtests, ["stop", "start", "stop"], "a playtest left running is stopped first, and the harness's own is stopped after");
  const audit = calls.find((call) => call.tool === "inspect_ui")!;
  assert.deepEqual([audit.args.mode, audit.args.target, audit.args.instance_id], ["audit", "client-1", "place-1"]);
});

test("a reading the harness could not take is reported as not run, with the reason, and still stops the playtest", async () => {
  const noClient = fakeStudio({ clientAfter: 1_000 });
  const missing = await auditInterface(noClient.caller, null, "Shop", fast);
  assert.equal(missing.ran, false);
  assert.match(missing.error ?? "", /No playtest client/);
  assert.equal(noClient.calls.at(-1)?.args.action, "stop");

  const noGui = await auditInterface(fakeStudio({ guiAfter: 1_000 }).caller, null, "Shop", fast);
  assert.match(noGui.error ?? "", /Shop never appeared/);

  const noStart = await auditInterface(fakeStudio({ startOk: false }).caller, null, "Shop", fast);
  assert.match(noStart.error ?? "", /could not start a playtest/);
});
