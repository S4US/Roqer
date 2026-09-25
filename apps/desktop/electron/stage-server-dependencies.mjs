import { readFileSync } from "node:fs";
import path from "node:path";

export function verifyLockedRuntimeDependencies({ manifest, lock, repoRoot, readJson = readJsonFile }) {
  const dependencies = Object.keys(manifest.dependencies ?? {});
  for (const dependency of dependencies) {
    const lockKey = `node_modules/${dependency}`;
    const lockedVersion = lock.packages?.[lockKey]?.version;
    if (typeof lockedVersion !== "string") {
      throw new Error(`Bridge dependency ${dependency} is absent from the committed root package-lock.json.`);
    }

    const installedManifest = readJson(path.join(repoRoot, lockKey, "package.json"));
    if (installedManifest.version !== lockedVersion) {
      throw new Error(
        `Bridge dependency ${dependency} is installed at ${String(installedManifest.version)}, but package-lock.json requires ${lockedVersion}. Run npm ci.`,
      );
    }
  }
  return dependencies.map((dependency) => path.join(repoRoot, "node_modules", dependency));
}

export function verifyBundledDependencies({ metafile, lock, repoRoot, stagingRoot, readJson = readJsonFile }) {
  const lockPackages = lock.packages ?? {};
  const lockKeys = Object.keys(lockPackages)
    .filter((key) => key.includes("node_modules/") && typeof lockPackages[key]?.version === "string")
    .sort((left, right) => right.length - left.length);
  const verified = new Set();

  for (const input of Object.keys(metafile.inputs ?? {})) {
    const absoluteInput = path.isAbsolute(input) ? input : path.resolve(stagingRoot, input);
    const repoRelative = path.relative(repoRoot, absoluteInput).split(path.sep).join("/");
    if (!repoRelative.includes("node_modules/")) continue;

    const lockKey = lockKeys.find((candidate) => repoRelative === candidate || repoRelative.startsWith(`${candidate}/`));
    if (lockKey === undefined) {
      throw new Error(`Bundled dependency input ${repoRelative} is absent from the committed root package-lock.json. Run npm ci.`);
    }
    if (verified.has(lockKey)) continue;

    const lockEntry = lockPackages[lockKey];
    if (typeof lockEntry.integrity !== "string") {
      throw new Error(`Bundled dependency ${lockKey} has no integrity record in the committed root package-lock.json. Run npm ci.`);
    }
    const installedManifest = readJson(path.join(repoRoot, ...lockKey.split("/"), "package.json"));
    if (installedManifest.version !== lockEntry.version) {
      throw new Error(
        `Bundled dependency ${lockKey} is installed at ${String(installedManifest.version)}, but package-lock.json requires ${lockEntry.version}. Run npm ci.`,
      );
    }
    verified.add(lockKey);
  }

  return [...verified];
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
