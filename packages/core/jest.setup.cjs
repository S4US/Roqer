// Every test file gets a registry of managed Studio processes of its own.
//
// Left to the default, the suite used the real per-user registry
// (~/.local/state/robloxstudio-mcp on Linux, %LOCALAPPDATA% on Windows): it
// wrote into a contributor's own records of the Studio processes their MCP
// launched, and parallel workers waited on one lock until they timed out and
// logged after their tests had finished, which Jest counts as a failure when
// it runs every file in one process. Setup files run once per test file, and
// a registry keeps the directory it was created with, so work a file left
// running cannot hold the lock a later file needs.
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR =
  mkdtempSync(join(tmpdir(), 'roqer-test-registry-'));
