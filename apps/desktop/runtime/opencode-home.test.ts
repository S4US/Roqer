import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createOpenCodeHome, opencodeChildEnvironment } from "./opencode-home";

test("OpenCode keeps native tools at ask and grants only Roqer's MCP tools", async () => {
  const home = await createOpenCodeHome({ mcpServerUrl: "http://127.0.0.1:1/mcp", mcpServerToken: "dummy", toolNames: ["studio", "ask_user"], model: "opencode/test-free" });
  const directory = home.directory;
  try {
    const config = JSON.parse(await fs.readFile(home.configPath, "utf8"));
    assert.equal(config.mcp.roqer.type, "remote");
    assert.equal(config.mcp.roqer.oauth, false);
    assert.equal(config.mcp.roqer.headers.Authorization, "Bearer dummy");
    assert.deepEqual(config.permission, { "*": "ask", roqer_studio: "allow", roqer_ask_user: "allow" });
    assert.deepEqual(config.agent.roqer.permission, config.permission);
    assert.equal(config.default_agent, "roqer");
    assert.equal(config.share, "disabled");
    assert.equal(config.model, "opencode/test-free");
    assert.equal(config.small_model, "opencode/test-free");
    const env = opencodeChildEnvironment(home, { PATH: "test-path", OPENCODE_CONFIG_CONTENT: "unsafe", OPENCODE_PERMISSION: '{"*":"allow"}', ROBLOX_STUDIO_AUTH_TOKEN: "secret", OPENAI_API_KEY: "secret", NODE_OPTIONS: "unsafe" });
    assert.equal(env.PATH, "test-path");
    assert.equal(env.HOME, directory);
    assert.equal(env.USERPROFILE, directory);
    assert.equal(env.OPENCODE_CONFIG, home.configPath);
    assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(env.OPENCODE_PERMISSION, undefined);
    assert.equal(env.ROBLOX_STUDIO_AUTH_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.PWD, directory);
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
    assert.ok(env.OPENCODE_TEST_MANAGED_CONFIG_DIR?.startsWith(directory));
  } finally { await home.close(); }
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("OpenCode discovery homes grant no tools", async () => {
  const home = await createOpenCodeHome({});
  try {
    const config = JSON.parse(await fs.readFile(home.configPath, "utf8"));
    assert.deepEqual(config.permission, { "*": "deny" });
    assert.deepEqual(config.agent.roqer.permission, config.permission);
  } finally { await home.close(); }
});
