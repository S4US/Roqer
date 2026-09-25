import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceDirectory = fileURLToPath(new URL("..", import.meta.url));
// Electron's own answer for where its binary is. Since Electron 44 the binary
// is downloaded on first use rather than at install, and requiring the package
// is what fetches it, so a path into node_modules/electron/dist can be missing
// after a fresh install.
const electronExecutable = createRequire(import.meta.url)("electron");
const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), "studio-workbench-smoke-"));

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronExecutable, ["."], {
      cwd: workspaceDirectory,
      env: {
        ...process.env,
        WORKBENCH_SMOKE_TEST: "1",
        WORKBENCH_USER_DATA: temporaryData,
      },
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await fs.rm(temporaryData, { recursive: true, force: true });
}
