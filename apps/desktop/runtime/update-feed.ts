/**
 * Whether a packaged build's `app-update.yml` names somewhere to update from.
 *
 * electron-builder writes that file beside the app only when a publish target
 * is configured, and what it holds depends on the provider. A generic feed is
 * a `url`; a GitHub Releases feed, which is what Roqer publishes to, is an
 * `owner` and a `repo` with no `url` at all. Reading only for `url` made every
 * released build report that it had no feed, so none of them ever checked.
 *
 * Only the top-level scalar fields are read: that is all electron-builder
 * writes, and it keeps a YAML parser out of the startup path.
 */
export function describesUpdateFeed(contents: string): boolean {
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:[ \\t]*['"]?([^'"\\s#]+)`, "m").exec(contents)?.[1];

  const provider = field("provider");
  switch (provider) {
    case undefined:
      return false;
    case "github":
      return field("owner") !== undefined && field("repo") !== undefined;
    case "generic":
      return field("url") !== undefined;
    // Any other provider electron-updater supports carries its own required
    // fields, and it reports a bad one when it checks.
    default:
      return true;
  }
}
