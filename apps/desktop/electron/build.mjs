import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDiscordClientId } from "./build-config.mjs";

// The main process and the preload script are written in TypeScript so they can
// share the run-event schema and the approval policy with the renderer instead
// of restating them in untyped CommonJS. esbuild bundles each entry point into
// a single CommonJS file, which is what Electron loads.

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const discordClientId = resolveDiscordClientId();

const shared = {
  absWorkingDir: desktopRoot,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // Electron supplies its own runtime; bundling it would break the process.
  external: ["electron"],
  logLevel: "warning",
  define: {
    __ROQER_DISCORD_CLIENT_ID__: JSON.stringify(discordClientId),
  },
};

export async function buildDesktopRuntime() {
  const agentSource = path.join(desktopRoot, "agent");
  const agentOutput = path.join(desktopRoot, "dist-electron", "agent");
  await fs.rm(agentOutput, { recursive: true, force: true });
  await Promise.all([
    build({ ...shared, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" }),
    build({ ...shared, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" }),
    fs.cp(agentSource, agentOutput, { recursive: true }),
    // The Windows window/taskbar icon is read from beside the compiled main at
    // runtime, so it has to travel with it rather than being resolved out of
    // the source tree.
    fs.cp(
      path.join(desktopRoot, "public", "roqer-app-icon.ico"),
      path.join(desktopRoot, "dist-electron", "roqer-app-icon.ico"),
    ),
  ]);
}

const invokedDirectly = process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  await buildDesktopRuntime();
}
