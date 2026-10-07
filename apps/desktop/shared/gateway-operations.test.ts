import assert from "node:assert/strict";
import test from "node:test";

import { GATEWAY_SCHEMAS, GATEWAY_TOOL_RISK, isGatewayOperation, LINK_ROJO_PROJECT_OPERATION } from "./gateway-operations";
import { riskForTool } from "./mcp-tools";

test("link_rojo_project asks like other writes, and is a known gateway operation", () => {
  assert.equal(GATEWAY_TOOL_RISK[LINK_ROJO_PROJECT_OPERATION], "mutation");
  assert.equal(riskForTool(LINK_ROJO_PROJECT_OPERATION), "mutation");
  assert.equal(isGatewayOperation(LINK_ROJO_PROJECT_OPERATION), true);
});

test("link_rojo_project's schema has no path, project, or instance_id parameter of any kind -- the executor always targets the run's own resolved instance", () => {
  const { parameters } = GATEWAY_SCHEMAS[LINK_ROJO_PROJECT_OPERATION];
  assert.deepEqual(parameters, []);
});
