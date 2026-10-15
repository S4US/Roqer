import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const OPENCODE_MCP_SERVER_NAME = "roqer";

export type OpenCodeHome = Readonly<{
  directory: string;
  configPath: string;
  close(): Promise<void>;
}>;

export async function createOpenCodeHome(options: {
  mcpServerUrl?: string;
  mcpServerToken?: string;
  parentDir?: string;
  toolNames?: readonly string[];
  model?: string;
}): Promise<OpenCodeHome> {
  const parent = options.parentDir ?? os.tmpdir();
  const directory = await fs.mkdtemp(path.join(parent, "roqer-opencode-"));

  // Free models require native tool schemas. Headless runs reject asks; never launch with --auto.
  const permission: Record<string, string> = { "*": options.mcpServerUrl ? "ask" : "deny" };
  for (const name of options.toolNames ?? []) permission[`${OPENCODE_MCP_SERVER_NAME}_${name}`] = "allow";
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    permission,
    default_agent: "roqer",
    agent: { roqer: { mode: "primary", permission } },
    plugin: [],
    instructions: [],
    lsp: false,
    formatter: false,
  };
  if (options.model) {
    config.model = options.model;
    config.small_model = options.model;
  }

  if (options.mcpServerUrl) {
    config.mcp = {
      [OPENCODE_MCP_SERVER_NAME]: {
        type: "remote",
        url: options.mcpServerUrl,
        enabled: true,
        oauth: false,
        timeout: 24 * 60 * 60 * 1000,
        headers: options.mcpServerToken
          ? { Authorization: `Bearer ${options.mcpServerToken}` }
          : {},
      },
    };
  }

  const configPath = path.join(directory, "opencode.json");
  try {
    // A repository boundary stops OpenCode discovering parent project settings.
    await fs.mkdir(path.join(directory, ".git"));
    await fs.mkdir(path.join(directory, "tmp"));
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    configPath,
    close: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  };
}

/** Keep ambient credentials, plugins, Node injection and MCP settings out of a run. */
export function opencodeChildEnvironment(home: OpenCodeHome, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home.directory,
    USERPROFILE: home.directory,
    APPDATA: path.join(home.directory, "appdata"),
    LOCALAPPDATA: path.join(home.directory, "localappdata"),
    XDG_CONFIG_HOME: path.join(home.directory, "config"),
    XDG_DATA_HOME: path.join(home.directory, "data"),
    XDG_CACHE_HOME: path.join(home.directory, "cache"),
    XDG_STATE_HOME: path.join(home.directory, "state"),
    TMP: path.join(home.directory, "tmp"),
    TEMP: path.join(home.directory, "tmp"),
    PWD: home.directory,
    OPENCODE_CONFIG: home.configPath,
    OPENCODE_CONFIG_DIR: home.directory,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    // OpenCode's managed settings must not widen Roqer's private tool grant.
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home.directory, "managed"),
  };
}
