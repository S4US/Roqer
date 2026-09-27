import path from "node:path";

/**
 * Where a Windows `npm install -g` may have put a package.
 *
 * npm's global prefix holds the `.cmd` shims, with the packages themselves in
 * its `node_modules`. The shims cannot be launched without a command shell, but
 * the native executable the package ships sits inside it and can be. The prefix
 * is found from PATH, where the shims put it, without asking npm; `%APPDATA%\npm`
 * is npm's default prefix, searched even when it is missing from PATH.
 */
export function windowsNpmPackageRoots(env: NodeJS.ProcessEnv, packageName: string): string[] {
  const prefixes = (env.PATH ?? "").split(path.delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (env.APPDATA) prefixes.push(path.join(env.APPDATA, "npm"));
  return [...new Set(prefixes)].map((prefix) => path.join(prefix, "node_modules", ...packageName.split("/")));
}
