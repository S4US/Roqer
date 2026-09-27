/**
 * A subscription's client (Codex or Claude Code) was not found on this
 * computer, as distinct from one that is installed but failing. Only the
 * executable lookups throw it, so a status reader can tell the two apart and
 * offer an install instead of a sign-in that cannot work.
 */
export class ClientNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientNotInstalledError";
  }
}
