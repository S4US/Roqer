import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { verifyBundledDependencies, verifyLockedRuntimeDependencies } from "./stage-server-dependencies.mjs";

const manifest = { dependencies: { express: "^4.18.2", ws: "^8.14.2" } };

test("accepts installed dependencies matching the committed lock", () => {
  const result = verifyLockedRuntimeDependencies({
    manifest,
    lock: { packages: { "node_modules/express": { version: "4.22.1" }, "node_modules/ws": { version: "8.19.0" } } },
    repoRoot: "C:/repo",
    readJson: (file) => ({ version: file.includes("express") ? "4.22.1" : "8.19.0" }),
  });
  assert.equal(result.length, 2);
});

test("rejects a dependency missing from the committed lock", () => {
  assert.throws(() => verifyLockedRuntimeDependencies({
    manifest,
    lock: { packages: {} },
    repoRoot: "C:/repo",
    readJson: () => ({ version: "0.0.0" }),
  }), /absent from the committed root package-lock/);
});

test("rejects an install that drifted from the committed lock", () => {
  assert.throws(() => verifyLockedRuntimeDependencies({
    manifest: { dependencies: { express: "^4.18.2" } },
    lock: { packages: { "node_modules/express": { version: "4.22.1" } } },
    repoRoot: "C:/repo",
    readJson: () => ({ version: "4.18.2" }),
  }), /Run npm ci/);
});

test("rejects a transitive bundle input that drifted from the committed lock", () => {
  const repoRoot = path.resolve("C:/repo");
  const stagingRoot = path.join(repoRoot, "apps", "desktop", "resources", "mcp-server");
  assert.throws(() => verifyBundledDependencies({
    metafile: { inputs: { [path.join(repoRoot, "node_modules", "express", "index.js")]: {}, [path.join(repoRoot, "node_modules", "express", "node_modules", "debug", "src", "index.js")]: {} } },
    lock: { packages: {
      "node_modules/express": { version: "4.22.1", integrity: "sha512-express" },
      "node_modules/express/node_modules/debug": { version: "2.6.9", integrity: "sha512-debug" },
    } },
    repoRoot,
    stagingRoot,
    readJson: (file) => ({ version: file.includes(`${path.sep}debug${path.sep}`) ? "2.6.8" : "4.22.1" }),
  }), /debug.*installed at 2\.6\.8.*requires 2\.6\.9/);
});

test("rejects an untracked dependency input from the staging tree", () => {
  const repoRoot = path.resolve("C:/repo");
  const stagingRoot = path.join(repoRoot, "apps", "desktop", "resources", "mcp-server");
  assert.throws(() => verifyBundledDependencies({
    metafile: { inputs: { [path.join(stagingRoot, "node_modules", "surprise", "index.js")]: {} } },
    lock: { packages: {} },
    repoRoot,
    stagingRoot,
    readJson: () => ({ version: "1.0.0" }),
  }), /absent from the committed root package-lock/);
});
