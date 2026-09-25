import fs from "node:fs/promises";
import path from "node:path";

import { openSkillLibrary, type SkillLibrary, type SkillSummary } from "./skill-library";

export type AgentDefinition = Readonly<{
  id: string;
  version: string;
  systemInstructions: string;
  developerInstructions: string;
  skills: readonly SkillSummary[];
}>;

export type AgentRuntime = Readonly<{
  definition: AgentDefinition;
  skillLibrary: SkillLibrary;
  provenance: AgentProvenance;
}>;

export type AgentProvenance = Readonly<{
  skillPack: Readonly<{
    name: string;
    version: string;
    commit: string;
    source: string;
    licenseSpdx: string;
    licenseNotice: string;
    customizedSkills: readonly string[];
  }>;
}>;

type AgentManifest = {
  schemaVersion: 1;
  id: string;
  version: string;
  skillPack: {
    name: string;
    version: string;
    commit: string;
    source: string;
    license: {
      spdx: string;
      notice: string;
    };
    customizedSkills: string[];
  };
};

const MAX_INSTRUCTION_CHARS = 64_000;

function isManifest(value: unknown): value is AgentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const skillPack = record.skillPack;
  if (typeof skillPack !== "object" || skillPack === null || Array.isArray(skillPack)) return false;
  const pack = skillPack as Record<string, unknown>;
  const license = pack.license;
  if (typeof license !== "object" || license === null || Array.isArray(license)) return false;
  const licenseRecord = license as Record<string, unknown>;
  return record.schemaVersion === 1 &&
    typeof record.id === "string" && record.id !== "" &&
    typeof record.version === "string" && record.version !== "" &&
    typeof pack.name === "string" && pack.name !== "" &&
    typeof pack.version === "string" && pack.version !== "" &&
    typeof pack.commit === "string" && /^[0-9a-f]{40}$/i.test(pack.commit) &&
    typeof pack.source === "string" && /^https:\/\//.test(pack.source) &&
    typeof licenseRecord.spdx === "string" && licenseRecord.spdx !== "" &&
    typeof licenseRecord.notice === "string" && licenseRecord.notice !== "" &&
    Array.isArray(pack.customizedSkills) &&
    pack.customizedSkills.every((entry) => typeof entry === "string" && entry !== "");
}

function bundleFile(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("Agent bundle file paths must be relative.");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent bundle file paths must stay inside the bundle.");
  }
  return resolved;
}

function boundedInstructions(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`${label} must contain 1-${MAX_INSTRUCTION_CHARS} characters.`);
  }
  return trimmed;
}

function catalogInstructions(catalog: readonly SkillSummary[]): string {
  const rows = catalog.map((skill) => `- \`${skill.name}\`: ${skill.description}`);
  return [
    "## Available client skills",
    "",
    "Load a matching entrypoint with `load_skill`. Load one linked reference or canonical template only when needed.",
    "",
    ...rows,
  ].join("\n");
}

/** Load the provider-neutral client agent bundle copied beside the Electron main process. */
export async function loadAgentRuntime(root: string): Promise<AgentRuntime> {
  const manifestValue: unknown = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  if (!isManifest(manifestValue)) throw new Error("The client agent manifest is invalid.");

  const [systemSource, developerSource, skillLibrary, licenseNotice] = await Promise.all([
    fs.readFile(path.join(root, "system.md"), "utf8"),
    fs.readFile(path.join(root, "developer.md"), "utf8"),
    openSkillLibrary(path.join(root, "skills")),
    fs.readFile(bundleFile(root, manifestValue.skillPack.license.notice), "utf8"),
  ]);
  const systemInstructions = boundedInstructions("System instructions", systemSource);
  const developerBase = boundedInstructions("Developer instructions", developerSource);
  const developerInstructions = boundedInstructions(
    "Resolved developer instructions",
    `${developerBase}\n\n${catalogInstructions(skillLibrary.catalog)}`,
  );

  return Object.freeze({
    definition: Object.freeze({
      id: manifestValue.id,
      version: manifestValue.version,
      systemInstructions,
      developerInstructions,
      skills: skillLibrary.catalog,
    }),
    skillLibrary,
    provenance: Object.freeze({
      skillPack: Object.freeze({
        name: manifestValue.skillPack.name,
        version: manifestValue.skillPack.version,
        commit: manifestValue.skillPack.commit,
        source: manifestValue.skillPack.source,
        licenseSpdx: manifestValue.skillPack.license.spdx,
        licenseNotice: boundedInstructions("Skill pack license notice", licenseNotice),
        customizedSkills: Object.freeze([...manifestValue.skillPack.customizedSkills]),
      }),
    }),
  });
}
