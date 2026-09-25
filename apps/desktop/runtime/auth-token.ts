import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolves the MCP auth token the same way the server does
 * (packages/core/src/auth.ts), so Roqer never needs its own configuration
 * step: whatever token the server minted for itself is the token we send.
 */
export type ResolvedToken = { token?: string; source: "env" | "file" | "disabled" | "missing" };

const TOKEN_FILE_RELATIVE_PATH = [".robloxstudio-mcp", "auth-token"];

/**
 * Reads the token; never creates it. The server mints the file on first run
 * and every MCP process resolves the same value, which is what lets Roqer
 * authenticate with no configuration step. A token written from here would not
 * be the one the running server is checking against, so it would produce 401s
 * while looking like success — and it could clobber the real token for every
 * other client. A missing file therefore resolves to "missing", and the caller
 * sends no auth header at all.
 */
export function resolveMcpAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): ResolvedToken {
  const noAuth = env.ROBLOX_STUDIO_NO_AUTH;
  if (noAuth !== undefined && /^(1|true)$/i.test(noAuth)) {
    return { source: "disabled" };
  }

  const envToken = env.ROBLOX_STUDIO_AUTH_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  try {
    const filePath = path.join(homeDirectory, ...TOKEN_FILE_RELATIVE_PATH);
    const fileToken = fs.readFileSync(filePath, "utf8").trim();
    if (fileToken) {
      return { token: fileToken, source: "file" };
    }
  } catch {
    // No file, unreadable, or a permissions error: fall through to "missing".
  }

  return { source: "missing" };
}
