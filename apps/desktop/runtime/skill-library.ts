import fs from "node:fs/promises";
import path from "node:path";

export type SkillSummary = Readonly<{
  name: string;
  description: string;
}>;

export type SkillDocument = Readonly<{
  name: string;
  resource: string;
  content: string;
}>;

export type SkillLoadOptions = Readonly<{
  /** The file is for `set_script_source {template}`: Roqer writes it into Studio and the model never reads it. */
  write?: boolean;
}>;

export interface SkillLibrary {
  readonly catalog: readonly SkillSummary[];
  load(name: string, resource?: string, options?: SkillLoadOptions): Promise<SkillDocument>;
}

const MAX_SKILLS = 64;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_DOCUMENT_BYTES = 64 * 1024;
/**
 * Modules a skill installs into the place unchanged, such as a UI kit and its
 * icon registry. They are written with `set_script_source {template}` and
 * never loaded into the conversation: one is larger than a tool result can
 * carry, and the model never needs its code, only the API its references
 * describe. So they may be larger than a document, and `load_skill` refuses
 * them.
 */
const INSTALL_TEMPLATES = ["templates", "install"];
const MAX_INSTALL_TEMPLATE_BYTES = 256 * 1024;
const SKILL_NAME = /^[a-z0-9-]{1,63}$/;

function yamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("Skill frontmatter string was invalid.");
    return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function frontmatterField(source: string, field: string): string {
  const newline = source.indexOf("\n");
  if (source.slice(0, newline).trim() !== "---") throw new Error("SKILL.md has no YAML frontmatter.");
  const end = source.indexOf("\n---", newline + 1);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed.");
  const frontmatter = source.slice(newline + 1, end);
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) throw new Error(`SKILL.md frontmatter is missing ${field}.`);
  return yamlScalar(match[1]);
}

function validateResource(name: string, resource: string, options: SkillLoadOptions): { relativePath: string; maxBytes: number } {
  if (resource === "" || resource.includes("\\") || path.posix.isAbsolute(resource)) {
    throw new Error("Skill resources must use relative POSIX-style paths.");
  }
  const segments = resource.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Skill resource path traversal is not allowed.");
  }
  const extension = path.posix.extname(resource).toLowerCase();
  const isMarkdown = extension === ".md";
  const isLuaTemplate = extension === ".lua" && segments[0] === "templates";
  if (!isMarkdown && !isLuaTemplate) {
    throw new Error("Only Markdown skill resources and Lua files below templates/ can be loaded.");
  }
  const isInstallTemplate = isLuaTemplate && INSTALL_TEMPLATES.every((segment, index) => segments[index] === segment);
  if (isInstallTemplate && options.write !== true) {
    throw new Error(`${name}/${resource} is a module Roqer installs unchanged with set_script_source {template: "${name}/${resource}"}, so it is not loaded. The skill's references describe its API.`);
  }
  return { relativePath: segments.join(path.sep), maxBytes: isInstallTemplate ? MAX_INSTALL_TEMPLATE_BYTES : MAX_DOCUMENT_BYTES };
}

export async function openSkillLibrary(root: string): Promise<SkillLibrary> {
  const realRoot = await fs.realpath(root);
  const entries = (await fs.readdir(realRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (entries.length === 0) throw new Error("The client skill library is empty.");
  if (entries.length > MAX_SKILLS) throw new Error(`The client skill library exceeds ${MAX_SKILLS} skills.`);

  const directories = new Map<string, string>();
  const catalog: SkillSummary[] = [];
  for (const entry of entries) {
    const directory = await fs.realpath(path.join(realRoot, entry.name));
    const source = await fs.readFile(path.join(directory, "SKILL.md"), "utf8");
    const name = frontmatterField(source, "name");
    const description = frontmatterField(source, "description");
    if (name !== entry.name || !SKILL_NAME.test(name)) {
      throw new Error(`Skill folder ${entry.name} does not match its frontmatter name.`);
    }
    if (description.length === 0 || description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`Skill ${name} has an invalid description length.`);
    }
    directories.set(name, directory);
    catalog.push(Object.freeze({ name, description }));
  }

  return Object.freeze({
    catalog: Object.freeze(catalog),
    async load(name: string, resource = "SKILL.md", options: SkillLoadOptions = {}): Promise<SkillDocument> {
      const directory = directories.get(name);
      if (!directory) throw new Error(`Unknown client skill: ${name}`);
      const { relativePath, maxBytes } = validateResource(name, resource, options);
      let resolved: string;
      try {
        resolved = await fs.realpath(path.join(directory, relativePath));
      } catch {
        throw new Error(`Skill resource not found: ${name}/${resource}`);
      }
      const boundary = `${directory}${path.sep}`;
      if (!resolved.startsWith(boundary)) throw new Error("Skill resource path traversal is not allowed.");
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > maxBytes) {
        throw new Error(`Skill resource must be a supported file no larger than ${maxBytes} bytes.`);
      }
      const content = await fs.readFile(resolved, "utf8").catch(() => {
        throw new Error(`Skill resource could not be read: ${name}/${resource}`);
      });
      return Object.freeze({
        name,
        resource: resource.split("\\").join("/"),
        // A Windows checkout writes CRLF; the carriage returns carry nothing,
        // yet they counted against each call's character cap and split the VFX
        // core pair (891 of them) across two calls there but not on Linux.
        content: content.replace(/\r\n/g, "\n"),
      });
    },
  });
}
