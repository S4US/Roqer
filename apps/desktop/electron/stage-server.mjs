#!/usr/bin/env node

/**
 * Stages the MCP bridge for packaging.
 *
 * A packaged Roqer has to carry a working bridge and the Studio plugin, because
 * the app starts one itself and installs the other on launch. Rather than hand-
 * assembling that folder, this builds the very artifact the MCP package already
 * publishes — `npm pack` runs its `prepack`, which stages
 * `studio-plugin/MCPPlugin.rbxmx` beside `dist/` — and then installs the few
 * runtime dependencies the bundle leaves external. What ships is therefore the
 * same layout the npm release has, which is the layout the server's own plugin
 * lookup and version read already expect.
 */

import { build as esbuild } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundledDependencies, verifyLockedRuntimeDependencies } from "./stage-server-dependencies.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.join(desktopRoot, "..", "..");
// Deliberately not "build/", which electron-builder treats as its own resource
// directory; a staged server there would be ambiguous with packaging assets.
const stagingRoot = path.join(desktopRoot, "resources", "mcp-server");
const SERVER_PACKAGE = "@roqer/mcp";

/** Everything the packaged bridge must contain, checked before it ships. */
const REQUIRED = [
  path.join("dist", "index.js"),
  "package.json",
  path.join("studio-plugin", "MCPPlugin.rbxmx"),
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}`);
  }
  return result.stdout ?? "";
}

function requirePrerequisite(file, remedy) {
  if (existsSync(file)) return;
  throw new Error(`Missing ${path.relative(repoRoot, file)}. ${remedy}`);
}

// Both are produced by other build steps, and both fail confusingly later if
// they are absent: npm pack would refuse, or the app would ship a bridge with
// no plugin to install.
requirePrerequisite(
  path.join(repoRoot, "packages", "robloxstudio-mcp", "dist", "index.js"),
  "Run npm run build first.",
);
requirePrerequisite(
  path.join(repoRoot, "studio-plugin", "MCPPlugin.rbxmx"),
  "Run npm run build:plugin:artifact first.",
);

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

const tarballDir = mkdtempSync(path.join(tmpdir(), "roqer-mcp-pack-"));
try {
  console.log(`Packing ${SERVER_PACKAGE}…`);
  run("npm", ["pack", "--workspace", SERVER_PACKAGE, "--pack-destination", tarballDir, "--silent"], {
    cwd: repoRoot,
  });

  const tarball = readdirSync(tarballDir).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack produced no tarball.");

  // `--strip-components=1` drops the tarball's own "package/" wrapper so the
  // staged layout matches what the runtime resolves against.
  run("tar", ["-xzf", path.join(tarballDir, tarball), "-C", stagingRoot, "--strip-components=1"]);

  // The published package still declares the workspace-only core as a dev
  // dependency, which npm resolves before it prunes and cannot find in any
  // registry. It is already bundled into `dist/`, so the staged copy drops the
  // dev metadata outright — along with the build scripts, which point at
  // monorepo paths that will not exist inside an installed application.
  const manifestPath = path.join(stagingRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.devDependencies;
  delete manifest.scripts;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // Packaging requires a clean `npm ci` from the committed root lockfile.
  // Resolve externals from that repository install, whose exact versions come
  // from the committed root lockfile. Refuse a stale or ad-hoc install rather
  // than performing a second range-based install inside the staging folder.
  const rootLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  verifyLockedRuntimeDependencies({ manifest, lock: rootLock, repoRoot });

  console.log("Bundling the bridge into a self-contained entry point…");
  const entry = path.join(stagingRoot, "dist", "index.js");
  const bundled = path.join(stagingRoot, "dist", "index.bundle.mjs");
  const bundleResult = await esbuild({
    absWorkingDir: stagingRoot,
    entryPoints: [entry],
    outfile: bundled,
    bundle: true,
    platform: "node",
    target: "node20",
    // ESM, because the server reads its own version and finds the bundled
    // Studio plugin through `import.meta.url`. A CommonJS bundle would leave
    // both of those with nothing to resolve against.
    format: "esm",
    nodePaths: [path.join(repoRoot, "node_modules")],
    // express and its dependencies are CommonJS and call `require` for Node's
    // own builtins. In an ESM bundle there is no `require` to call, and esbuild
    // throws "Dynamic require of \"path\" is not supported" at startup. Giving
    // the bundle a real one built from its own URL is what makes those work.
    banner: {
      js: [
        "import { createRequire as __roqerCreateRequire } from \"node:module\";",
        "const require = __roqerCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    metafile: true,
    logLevel: "warning",
  });
  verifyBundledDependencies({
    metafile: bundleResult.metafile,
    lock: rootLock,
    repoRoot,
    stagingRoot,
  });
  renameSync(bundled, entry);
} finally {
  rmSync(tarballDir, { recursive: true, force: true });
}

const missing = REQUIRED.filter((entry) => !existsSync(path.join(stagingRoot, entry)));
if (missing.length > 0) {
  throw new Error(`The staged bridge is incomplete: ${missing.join(", ")}`);
}

console.log(`Staged the Studio bridge in ${path.relative(repoRoot, stagingRoot)}`);
