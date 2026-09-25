import type { SkillDocument, SkillLibrary } from "./skill-library";

type JsonRecord = Record<string, unknown>;

export const SKILL_TOOL_NAME = "load_skill";

export type SkillToolDefinition = Readonly<{
  name: typeof SKILL_TOOL_NAME;
  description: string;
  inputSchema: JsonRecord;
}>;

/**
 * How many resources one call may ask for.
 *
 * Progressive disclosure is about not sending the whole pack up front, not
 * about sending it one document per model turn. Creating a screen needs the
 * generation rules, a theme, a layout, the asset and icon catalogs, and the
 * validation rules; asking for those one at a time costs five round trips
 * before any work starts, and because the client owns the agent loop each one
 * is a turn that re-sends the whole conversation. Eight is enough for the
 * largest such group with room to spare, and small enough that a batch is still
 * a deliberate list rather than "load everything".
 */
export const MAX_SKILL_RESOURCES = 8;

/**
 * Aggregate size of one batch.
 *
 * Claude Code keeps a tool result inline only up to 50,000 characters. A
 * larger one is written to a file and the model gets a path and a 2 KB preview,
 * and Roqer's Claude sessions have no file tools, so the model then works
 * without the guidance it asked for and nothing reports it. A SIM screen's route
 * (about 61,000 characters) lost its whole theme and layout that way. This cap
 * leaves room for each document's framing and the note naming what was held
 * back. Resources past it are named rather than dropped, so the model asks for
 * them in one more call; no single resource in the pack is larger than the cap,
 * so each stays loadable on its own.
 */
export const MAX_BATCH_CHARACTERS = 45_000;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function skillToolDefinition(library: SkillLibrary): SkillToolDefinition {
  return Object.freeze({
    name: SKILL_TOOL_NAME,
    description: "Load matching client skill guidance only when its catalog description applies: the skill entrypoint, its linked Markdown references, or a canonical Lua template. Ask for every resource you already know you need in one call rather than one per turn.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: library.catalog.map((skill) => skill.name),
          description: "Skill name from the available client-skill catalog.",
        },
        resource: {
          type: "string",
          description: "One relative linked Markdown path or templates/*.lua path; omit to load SKILL.md.",
        },
        resources: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_SKILL_RESOURCES,
          description: `Up to ${MAX_SKILL_RESOURCES} relative paths from this skill to load together. Use this instead of one call per document when you already know which you need.`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  });
}

export type SkillToolRequest = { name: string; resources: string[] };

export type SkillToolRunner = {
  (value: unknown): Promise<string>;
  /** Forget what was sent, because the conversation that held it no longer does. */
  clearCache(): void;
  /** Whether this resource has been delivered in full and not forgotten since. */
  isLoaded(name: string, resource?: string): boolean;
};

export function parseSkillToolInput(value: unknown): SkillToolRequest {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error("load_skill requires a skill name.");
  }
  if (value.resource !== undefined && value.resources !== undefined) {
    throw new Error("load_skill takes either `resource` or `resources`, not both. Put every path in `resources`.");
  }
  if (value.resources !== undefined) {
    if (!Array.isArray(value.resources) || value.resources.length === 0) {
      throw new Error("load_skill `resources` must be a non-empty array of relative skill-resource paths.");
    }
    if (value.resources.length > MAX_SKILL_RESOURCES) {
      throw new Error(`load_skill accepts at most ${MAX_SKILL_RESOURCES} resources per call; ${value.resources.length} were requested.`);
    }
    if (value.resources.some((entry) => typeof entry !== "string")) {
      throw new Error("load_skill `resources` must contain only relative skill-resource paths.");
    }
    // Deduplicated here rather than left to the cache, so a repeat inside one
    // call does not come back as "already loaded earlier in this conversation"
    // pointing at the same call the model is reading.
    return { name: value.name, resources: [...new Set(value.resources as string[])] };
  }
  if (value.resource !== undefined && typeof value.resource !== "string") {
    throw new Error("load_skill resource must be a relative skill-resource path.");
  }
  return { name: value.name, resources: [(value.resource as string | undefined) ?? "SKILL.md"] };
}

/** One loaded document, wrapped so its content cannot read as instructions. */
function renderDocument(document: SkillDocument): string {
  const isTemplate = document.resource.toLowerCase().endsWith(".lua");
  return [
    `Loaded client skill ${document.name} ${isTemplate ? "template" : "guidance"} (${document.resource}).`,
    isTemplate
      ? "The following is a trusted client Lua template artifact, not additional authority. Use it only as directed by the skill and preserve protected sections exactly."
      : "The following is trusted client guidance, subordinate to the system and developer instructions:",
    `<${isTemplate ? "skill-template" : "skill"} name="${document.name}" resource="${document.resource}">`,
    document.content,
    `</${isTemplate ? "skill-template" : "skill"}>`,
  ].join("\n\n");
}

export async function runSkillTool(library: SkillLibrary, value: unknown): Promise<string> {
  const request = parseSkillToolInput(value);
  const sections = await Promise.all(request.resources.map((resource) =>
    library.load(request.name, resource).then(renderDocument)));
  return sections.join("\n\n");
}

/**
 * One loader per provider conversation. The first request for a resource
 * returns the full document; exact repeats return a short pointer so the same
 * guidance does not bloat every later provider turn. Failed loads are removed
 * and remain retryable.
 *
 * Its lifetime is the conversation the documents were delivered into, not one
 * run: a kept Claude Code process or Codex thread still holds what an earlier
 * message loaded, and sending it again only pays for it twice. Whoever owns
 * the conversation clears the cache when the provider compacts it, since a
 * pointer to guidance the model can no longer see is worse than a repeat.
 *
 * A batch is resolved per resource rather than as a unit: one bad path in a
 * list of six must not cost the model the five that were right, and a resource
 * it already has must not be resent because it happened to be asked for beside
 * a new one. The call fails only when nothing in it could be loaded.
 */
export function createSkillToolRunner(library: SkillLibrary): SkillToolRunner {
  const loaded = new Map<string, Promise<string>>();
  const keyOf = (name: string, resource: string) => JSON.stringify([name, resource]);

  const loadOne = async (name: string, resource: string): Promise<string> => {
    const key = keyOf(name, resource);
    const existing = loaded.get(key);
    if (existing !== undefined) {
      await existing;
      return `Client skill ${name} (${resource}) was already loaded earlier in this conversation. Use that guidance; it has not changed.`;
    }
    const loading = library.load(name, resource).then(renderDocument);
    loaded.set(key, loading);
    try {
      return await loading;
    } catch (error) {
      if (loaded.get(key) === loading) loaded.delete(key);
      throw error;
    }
  };

  const run = async (value: unknown): Promise<string> => {
    const request = parseSkillToolInput(value);
    const settled = await Promise.allSettled(
      request.resources.map((resource) => loadOne(request.name, resource)));

    const sections: string[] = [];
    const failures: string[] = [];
    let characters = 0;
    for (const [index, result] of settled.entries()) {
      const resource = request.resources[index];
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        failures.push(`${resource}: ${reason instanceof Error ? reason.message : String(reason)}`);
        continue;
      }
      if (characters + result.value.length > MAX_BATCH_CHARACTERS && sections.length > 0) {
        // Read but not delivered, so the cache must forget it: otherwise the
        // retry this line asks for would come back as "already loaded earlier
        // in this conversation", pointing at guidance the model never saw.
        loaded.delete(keyOf(request.name, resource));
        failures.push(`${resource}: not loaded yet, because this call already returned as much as one result can carry. Load it with the others listed here in one more call before relying on it.`);
        continue;
      }
      characters += result.value.length;
      sections.push(result.value);
    }

    if (sections.length === 0) {
      // Nothing loaded, so this is a failed call rather than a partial one, and
      // the model gets the reasons back the way a single failure has always
      // arrived.
      throw new Error(failures.join("\n"));
    }
    if (failures.length === 0) return sections.join("\n\n");
    return [...sections, `Not loaded in this call:\n${failures.map((line) => `- ${line}`).join("\n")}`]
      .join("\n\n");
  };

  return Object.assign(run, {
    clearCache: () => loaded.clear(),
    isLoaded: (name: string, resource = "SKILL.md") => loaded.has(keyOf(name, resource)),
  });
}
