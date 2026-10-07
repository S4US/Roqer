import assert from "node:assert/strict";
import test from "node:test";

import { GATEWAY_SCHEMAS, GATEWAY_TOOL_RISK, isGatewayOperation, LINK_ROJO_PROJECT_OPERATION } from "./gateway-operations";
import { riskForTool } from "./mcp-tools";

test("link_rojo_project asks like other writes, and is a known gateway operation", () => {
  assert.equal(GATEWAY_TOOL_RISK[LINK_ROJO_PROJECT_OPERATION], "mutation");
  assert.equal(riskForTool(LINK_ROJO_PROJECT_OPERATION), "mutation");
  assert.equal(isGatewayOperation(LINK_ROJO_PROJECT_OPERATION), true);
});

test("link_rojo_project's schema has no path or project parameter of any kind", () => {
  const { parameters } = GATEWAY_SCHEMAS[LINK_ROJO_PROJECT_OPERATION];
  const names = parameters.map((parameter) => parameter.name);
  assert.deepEqual(names, ["instance_id"]);
  assert.equal(parameters.every((parameter) => !parameter.required), true, "instance_id is the only parameter, and it is optional");
  for (const name of names) {
    assert.doesNotMatch(name.toLowerCase(), /path|project|file/);
  }
});
