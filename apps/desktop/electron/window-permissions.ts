import type { Session, WebContents } from "electron";

/**
 * What Roqer's own window may ask the browser for, and nothing else.
 *
 * Electron grants every permission request by default. Roqer's window needs
 * two: the microphone, for dictation, and writing to the clipboard, for the
 * copy buttons. Any other request, and any request from a page that is not
 * Roqer's window, is refused.
 */
export function allowedPermission(
  permission: string,
  trusted: boolean,
  details: Readonly<{ mediaTypes?: readonly string[]; mediaType?: string }>,
): boolean {
  if (!trusted) return false;
  if (permission === "clipboard-sanitized-write") return true;
  if (permission !== "media") return false;
  // Sound only: a request that also asks for the camera or the screen is refused whole.
  const asked = details.mediaTypes ?? (details.mediaType === undefined ? [] : [details.mediaType]);
  return asked.length > 0 && asked.every((type) => type === "audio");
}

/** Put the rule above on the session Roqer's window uses. */
export function restrictWindowPermissions(session: Session, isTrusted: (contents: WebContents) => boolean): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowedPermission(permission, isTrusted(contents), details as { mediaTypes?: string[] }));
  });
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    return contents !== null && allowedPermission(permission, isTrusted(contents), details as { mediaType?: string });
  });
}
