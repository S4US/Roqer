import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildDesktopRuntime } from "./build.mjs";

// Electron loads bundled CommonJS from dist-electron, so the main process and
// preload must be compiled before anything is spawned. Building in-process
// keeps the launcher to the two child processes it already had.
await buildDesktopRuntime();

const workspaceDirectory = fileURLToPath(new URL("..", import.meta.url));
const viteCli = fileURLToPath(new URL("../../../node_modules/vite/bin/vite.js", import.meta.url));
// Electron's own answer for where its binary is. Since Electron 44 the binary
// is downloaded on first use rather than at install, and requiring the package
// is what fetches it, so a path into node_modules/electron/dist can be missing
// after a fresh install.
const electronExecutable = createRequire(import.meta.url)("electron");

const renderer = spawn(process.execPath, [viteCli], {
  cwd: workspaceDirectory,
  stdio: "inherit",
  shell: false,
});
let rendererError;
renderer.once("error", (error) => {
  rendererError = error;
});

const waitForRenderer = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (rendererError) throw rendererError;
    if (renderer.exitCode !== null) {
      throw new Error(`The Roqer renderer exited with code ${renderer.exitCode}.`);
    }
    try {
      const response = await fetch("http://127.0.0.1:4173/");
      if (response.ok) return;
    } catch {
      // The renderer is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The Roqer renderer did not start within 30 seconds.");
};

let desktop;
try {
  await waitForRenderer();
  const desktopEnvironment = { ...process.env, WORKBENCH_DEV_SERVER_URL: "http://127.0.0.1:4173/" };
  delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
  desktop = spawn(electronExecutable, ["."], {
    cwd: workspaceDirectory,
    env: desktopEnvironment,
    stdio: "inherit",
    shell: false,
  });
  desktop.once("error", (error) => {
    renderer.kill();
    console.error(error);
    process.exitCode = 1;
  });
  desktop.on("exit", (code) => {
    renderer.kill();
    process.exitCode = code ?? 0;
  });
} catch (error) {
  renderer.kill();
  throw error;
}

const stop = () => {
  desktop?.kill();
  renderer.kill();
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
