/** External MCP identities stay outside Studio's catalog and risk classifications. */
const PREFIX = "custom_mcp/";

export function customMcpToolIdentity(server: string, tool: string): string {
  return `${PREFIX}${encodeURIComponent(server)}/${encodeURIComponent(tool)}`;
}

export function parseCustomMcpToolIdentity(value: string): { server: string; tool: string } | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  const parts = value.slice(PREFIX.length).split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return undefined;
  try {
    return { server: decodeURIComponent(parts[0]!), tool: decodeURIComponent(parts[1]!) };
  } catch {
    return undefined;
  }
}
