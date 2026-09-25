/**
 * Resolving an icon name to the catalog ID it stands for.
 *
 * The 106-icon catalog is already vendored, indexed, and correct. What it cost
 * was model turns: picking an icon meant loading a 7 KB index, often a category
 * file after it, and then scanning both in context — for a question with one
 * deterministic answer that this machine can compute for free.
 *
 * So the lookup moves here. The catalog is still the same files the skill
 * carries, read through the same validated skill loader, and nothing is
 * invented: an ID is only ever returned because a row in those files says so.
 * A query that matches nothing says so rather than reaching for the nearest
 * vaguely related picture, which is exactly the failure the skill's own
 * guidance warns about.
 *
 * The catalog's names are semantic slots rather than descriptions of the
 * drawing, and the recovered phrasings are the searches each icon was found
 * under rather than authored synonyms. Both distinctions survive into the
 * answer: a name match is stated as one, a phrasing match is offered as a
 * candidate worth confirming.
 */

import type { SkillLibrary } from "./skill-library";

type JsonRecord = Record<string, unknown>;

export const ICON_TOOL_NAME = "resolve_icon";

/** The skill whose references hold the catalog. */
const ICON_SKILL = "roblox-ui-design";
const ICON_INDEX = "references/icons/index.md";

/** Candidates returned beside the best match. Enough to choose from, not a list to scan. */
const MAX_CANDIDATES = 3;

/** Queries one call may resolve. A screen names a handful of icons, not a catalog. */
export const MAX_ICON_QUERIES = 12;

export type IconEntry = Readonly<{
  name: string;
  category: string;
  assetId: string;
  /** Searches this icon was recovered under. Evidence, not authored synonyms. */
  recoveredUnder: readonly string[];
}>;

export type IconCatalog = Readonly<{ entries: readonly IconEntry[] }>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `| Coin | `rbxassetid://84697600263846` |` and its three-column alias form. */
const ROW = /^\|\s*([^|]+?)\s*\|\s*`(rbxassetid:\/\/\d+)`\s*\|(?:\s*([^|]*?)\s*\|)?\s*$/;
const CATEGORY = /^##\s+(.+?)\s+—\s+\[aliases\]\(([^)]+)\)\s*$/;

/**
 * Read the catalog out of the skill's own Markdown.
 *
 * Parsing the shipped reference rather than keeping a second copy means the
 * table a person edits and the table the tool answers from cannot drift, and a
 * row that stops matching this shape drops out rather than resolving to a
 * stale ID.
 */
export function parseIconIndex(source: string): Array<{ category: string; aliasFile: string; entries: IconEntry[] }> {
  const sections: Array<{ category: string; aliasFile: string; entries: IconEntry[] }> = [];
  let current: { category: string; aliasFile: string; entries: IconEntry[] } | undefined;
  for (const line of source.split("\n")) {
    const heading = line.match(CATEGORY);
    if (heading) {
      current = { category: heading[1], aliasFile: heading[2], entries: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      current = undefined;
      continue;
    }
    const row = current === undefined ? null : line.match(ROW);
    if (!row || current === undefined) continue;
    current.entries.push({
      name: row[1], category: current.category, assetId: row[2], recoveredUnder: [],
    });
  }
  return sections;
}

/** The phrasings each icon in one category file was recovered under. */
export function parseIconAliases(source: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const line of source.split("\n")) {
    const row = line.match(ROW);
    if (!row || row[3] === undefined || row[3] === "") continue;
    aliases.set(row[1], row[3].split(",").map((phrase) => phrase.trim()).filter((phrase) => phrase !== ""));
  }
  return aliases;
}

/**
 * Words a query and a catalog entry are compared on.
 *
 * "icon" is dropped because every phrasing in the catalog carries it, so it
 * separates nothing and would let any two queries share a token.
 */
const IGNORED_TOKENS = new Set(["icon", "a", "an", "the", "of", "for"]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "" && !IGNORED_TOKENS.has(token));
}

function normalize(value: string): string {
  return tokens(value).join(" ");
}

type Scored = { entry: IconEntry; score: number; basis: "name" | "phrasing" | "overlap" };

/**
 * Rank the catalog against one query.
 *
 * The order is the skill's own: an exact catalog name is a decision, an exact
 * recovered phrasing is a strong candidate, and token overlap is a suggestion.
 * A category hint breaks ties within a tier rather than overriding a better
 * match in another category, because a caller's guess at the category is worth
 * less than the words it actually used.
 */
export function rankIcons(catalog: IconCatalog, query: string, categoryHint?: string): Scored[] {
  const wanted = normalize(query);
  const queryTokens = new Set(tokens(query));
  if (wanted === "") return [];
  const hint = categoryHint === undefined ? undefined : normalize(categoryHint);

  const scored: Scored[] = [];
  for (const entry of catalog.entries) {
    const inHintedCategory = hint !== undefined && normalize(entry.category) === hint;
    const bonus = inHintedCategory ? 0.5 : 0;

    if (normalize(entry.name) === wanted) {
      scored.push({ entry, score: 100 + bonus, basis: "name" });
      continue;
    }
    if (entry.recoveredUnder.some((phrase) => normalize(phrase) === wanted)) {
      scored.push({ entry, score: 60 + bonus, basis: "phrasing" });
      continue;
    }

    const entryTokens = new Set([...tokens(entry.name), ...entry.recoveredUnder.flatMap(tokens)]);
    let shared = 0;
    for (const token of queryTokens) if (entryTokens.has(token)) shared += 1;
    if (shared === 0) continue;
    // Divided by the query's own length so a two-word query matching both words
    // outranks a five-word query matching two, and by the entry's token count
    // so an icon with many recovered phrasings does not win on breadth alone.
    const coverage = shared / queryTokens.size;
    scored.push({
      entry,
      score: 10 * coverage + shared / Math.sqrt(entryTokens.size) + bonus,
      basis: "overlap",
    });
  }

  return scored.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name));
}

export type IconToolDefinition = Readonly<{
  name: typeof ICON_TOOL_NAME;
  description: string;
  inputSchema: JsonRecord;
}>;

export function iconToolDefinition(): IconToolDefinition {
  return Object.freeze({
    name: ICON_TOOL_NAME,
    description: "Resolve icon names to exact IDs from Roqer's curated 106-icon catalog, without loading or scanning the catalog files. Ask for every icon a screen needs in one call. An exact asset named by the active theme or layout still wins over anything this returns, and a query with no match is answered as no match rather than with the nearest picture.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ICON_QUERIES,
          description: "What each icon is for, e.g. \"coin counter\" or \"settings button\".",
        },
        categoryHint: {
          type: "string",
          description: "Optional catalog category to prefer on a tie, e.g. \"Currency\".",
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  });
}

export function parseIconToolInput(value: unknown): { queries: string[]; categoryHint?: string } {
  if (!isRecord(value) || !Array.isArray(value.queries) || value.queries.length === 0) {
    throw new Error("resolve_icon requires a non-empty `queries` array of what each icon is for.");
  }
  if (value.queries.length > MAX_ICON_QUERIES) {
    throw new Error(`resolve_icon accepts at most ${MAX_ICON_QUERIES} queries per call; ${value.queries.length} were sent.`);
  }
  if (value.queries.some((query) => typeof query !== "string" || query.trim() === "")) {
    throw new Error("resolve_icon `queries` must contain only non-empty strings.");
  }
  if (value.categoryHint !== undefined && typeof value.categoryHint !== "string") {
    throw new Error("resolve_icon `categoryHint` must be a catalog category name.");
  }
  return {
    queries: (value.queries as string[]).map((query) => query.trim()),
    ...(typeof value.categoryHint === "string" ? { categoryHint: value.categoryHint } : {}),
  };
}

/** Load and cache the catalog for one run, from the skill's own reference files. */
export async function loadIconCatalog(library: SkillLibrary): Promise<IconCatalog> {
  const index = await library.load(ICON_SKILL, ICON_INDEX);
  const sections = parseIconIndex(index.content);
  const entries: IconEntry[] = [];
  for (const section of sections) {
    let aliases = new Map<string, string[]>();
    try {
      const file = await library.load(ICON_SKILL, `references/icons/${section.aliasFile}`);
      aliases = parseIconAliases(file.content);
    } catch {
      // A missing alias file costs ranking quality, never correctness: every ID
      // still comes from the index, which is the file that carries them.
    }
    for (const entry of section.entries) {
      entries.push({ ...entry, recoveredUnder: aliases.get(entry.name) ?? [] });
    }
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

function describeMatch(query: string, ranked: Scored[]): string {
  if (ranked.length === 0 || ranked[0].basis === "overlap" && ranked[0].score < 5) {
    return `${query}: no catalog match. Omit it if it is decoration, or search the Creator Store if it is essential content art. Do not substitute a loosely related catalog icon.`;
  }
  const [best, ...rest] = ranked;
  const basis = best.basis === "name"
    ? "exact catalog name"
    : best.basis === "phrasing"
      ? "matches a phrasing this icon was recovered under — confirm with get_asset_thumbnail before committing"
      : "closest wording — confirm with get_asset_thumbnail before committing";
  const candidates = rest.slice(0, MAX_CANDIDATES)
    .map((item) => `${item.entry.name} (${item.entry.category})`)
    .join(", ");
  return [
    `${query}: ${best.entry.name} (${best.entry.category}) ${best.entry.assetId} — ${basis}.`,
    ...(candidates === "" ? [] : [`  Other candidates: ${candidates}.`]),
  ].join("\n");
}

/**
 * One run-scoped resolver. The catalog is parsed once per run and answers every
 * later call from memory, so a screen with eight icons reads the reference
 * files once rather than eight times — and puts none of them in the
 * conversation.
 */
export function createIconToolRunner(library: SkillLibrary): (value: unknown) => Promise<string> {
  let catalog: Promise<IconCatalog> | undefined;
  return async (value: unknown): Promise<string> => {
    const request = parseIconToolInput(value);
    if (catalog === undefined) catalog = loadIconCatalog(library);
    let resolved: IconCatalog;
    try {
      resolved = await catalog;
    } catch (error) {
      catalog = undefined;
      throw error;
    }
    return [
      ...request.queries.map((query) =>
        describeMatch(query, rankIcons(resolved, query, request.categoryHint))),
      "Use an ID verbatim in ImageLabel.Image, ImageButton.Image, or Decal.Texture. Never tint one with ImageColor3, and never run one through the decal-to-image resolution flow.",
    ].join("\n");
  };
}
