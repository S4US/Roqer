import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIconToolRunner,
  iconToolDefinition,
  loadIconCatalog,
  parseIconAliases,
  parseIconIndex,
  rankIcons,
  MAX_ICON_QUERIES,
} from "./icon-tool";
import { openSkillLibrary, type SkillLibrary } from "./skill-library";

const INDEX = `# Curated Icon Catalog — index

## Using an ID

Not a category, and its table must not be read as one.

| Name | ID |
|---|---|

## Currency — [aliases](currency.md)

| Name | ID |
|---|---|
| Cash | \`rbxassetid://70565105539676\` |
| Coin | \`rbxassetid://84697600263846\` |
| Diamond | \`rbxassetid://75581768563141\` |

## UI — [aliases](ui.md)

| Name | ID |
|---|---|
| Settings | \`rbxassetid://11111111111111\` |
`;

const CURRENCY_ALIASES = `# Icon aliases — Currency

| Name | ID | Recovered under |
|---|---|---|
| Cash | \`rbxassetid://70565105539676\` | cash icon, money icon, dollar icon |
| Coin | \`rbxassetid://84697600263846\` | coin icon, gold coin icon, currency icon |
| Diamond | \`rbxassetid://75581768563141\` | diamond icon, gem icon, ruby icon |
`;

const UI_ALIASES = `# Icon aliases — UI

| Name | ID | Recovered under |
|---|---|---|
| Settings | \`rbxassetid://11111111111111\` | settings icon, gear icon, cog icon |
`;

function fakeLibrary(files: Record<string, string>, onLoad?: (resource: string) => void): SkillLibrary {
  return {
    catalog: [{ name: "roblox-ui-design", description: "UI." }],
    load: async (name, resource = "SKILL.md") => {
      onLoad?.(resource);
      const content = files[resource];
      if (content === undefined) throw new Error(`Skill resource not found: ${name}/${resource}`);
      return { name, resource, content };
    },
  };
}

const FILES = {
  "references/icons/index.md": INDEX,
  "references/icons/currency.md": CURRENCY_ALIASES,
  "references/icons/ui.md": UI_ALIASES,
};

test("the catalog is read out of the skill's own tables", async () => {
  const catalog = await loadIconCatalog(fakeLibrary(FILES));
  assert.deepEqual(catalog.entries.map((entry) => entry.name), ["Cash", "Coin", "Diamond", "Settings"]);
  assert.equal(catalog.entries[1].assetId, "rbxassetid://84697600263846");
  assert.equal(catalog.entries[1].category, "Currency");
  assert.deepEqual(catalog.entries[1].recoveredUnder, ["coin icon", "gold coin icon", "currency icon"]);
});

test("recovered phrasings are split into the searches they were, not one string", () => {
  const aliases = parseIconAliases(CURRENCY_ALIASES);
  assert.deepEqual(aliases.get("Cash"), ["cash icon", "money icon", "dollar icon"]);
  assert.equal(aliases.get("Nothing"), undefined);
});

test("a table outside a category heading is not read as catalog rows", () => {
  // "## Using an ID" carries an example table; treating its rows as entries
  // would invent icons out of documentation.
  const sections = parseIconIndex(INDEX);
  assert.deepEqual(sections.map((section) => section.category), ["Currency", "UI"]);
});

test("an exact catalog name is a decision rather than a suggestion", async () => {
  const run = createIconToolRunner(fakeLibrary(FILES));
  const result = await run({ queries: ["Coin"] });
  assert.match(result, /Coin \(Currency\) rbxassetid:\/\/84697600263846 — exact catalog name/);
  assert.doesNotMatch(result.split("\n")[0], /confirm with get_asset_thumbnail/);
});

test("a recovered phrasing is offered as a candidate to confirm, not as a decision", async () => {
  const run = createIconToolRunner(fakeLibrary(FILES));
  const result = await run({ queries: ["gem icon"] });
  assert.match(result, /Diamond \(Currency\) rbxassetid:\/\/75581768563141/);
  assert.match(result, /recovered under — confirm with get_asset_thumbnail/);
});

test("a query with no catalog match is answered as no match", async () => {
  const run = createIconToolRunner(fakeLibrary(FILES));
  const result = await run({ queries: ["medieval siege trebuchet"] });
  assert.match(result, /no catalog match/);
  assert.match(result, /Do not substitute a loosely related catalog icon/);
  assert.doesNotMatch(result, /rbxassetid:\/\/\d+ —/);
});

test("one call answers every icon a screen needs", async () => {
  const loads: string[] = [];
  const run = createIconToolRunner(fakeLibrary(FILES, (resource) => loads.push(resource)));
  const result = await run({ queries: ["coin counter", "settings button"] });

  assert.match(result, /coin counter: Coin \(Currency\)/);
  assert.match(result, /settings button: Settings \(UI\)/);

  await run({ queries: ["cash"] });
  assert.deepEqual(loads, [
    "references/icons/index.md",
    "references/icons/currency.md",
    "references/icons/ui.md",
  ], "the catalog is parsed once per run and later calls answer from memory");
});

test("a category hint breaks a tie without overriding a better match elsewhere", async () => {
  const catalog = await loadIconCatalog(fakeLibrary(FILES));
  const hinted = rankIcons(catalog, "settings", "Currency");
  assert.equal(hinted[0].entry.name, "Settings", "a name match still wins outside the hinted category");
});

test("a failed catalog read stays retryable", async () => {
  let attempts = 0;
  const flaky: SkillLibrary = {
    catalog: [{ name: "roblox-ui-design", description: "UI." }],
    load: async (name, resource = "SKILL.md") => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary read failure");
      const content = FILES[resource as keyof typeof FILES];
      if (content === undefined) throw new Error("missing");
      return { name, resource, content };
    },
  };
  const run = createIconToolRunner(flaky);
  await assert.rejects(() => run({ queries: ["coin"] }), /temporary read failure/);
  assert.match(await run({ queries: ["coin"] }), /Coin \(Currency\)/);
});

test("a malformed request is refused before the catalog is read", async () => {
  const run = createIconToolRunner(fakeLibrary(FILES));
  await assert.rejects(() => run({ queries: [] }), /non-empty `queries` array/);
  await assert.rejects(() => run({ queries: ["  "] }), /only non-empty strings/);
  await assert.rejects(
    () => run({ queries: Array.from({ length: MAX_ICON_QUERIES + 1 }, () => "coin") }),
    new RegExp(`at most ${MAX_ICON_QUERIES} queries`),
  );
  await assert.rejects(() => run({ queries: ["coin"], categoryHint: 7 }), /categoryHint/);
});

test("the shipped catalog parses and resolves the icons the skill promises", async () => {
  // The tool answers instead of the model scanning these files, so a change to
  // their shape has to fail here rather than silently return nothing.
  const agentRoot = path.join(fileURLToPath(new URL("../agent/skills", import.meta.url)));
  const library = await openSkillLibrary(agentRoot);
  const catalog = await loadIconCatalog(library);

  assert.equal(catalog.entries.length, 107);
  assert.ok(catalog.entries.every((entry) => /^rbxassetid:\/\/\d+$/.test(entry.assetId)));
  assert.ok(
    catalog.entries.filter((entry) => entry.recoveredUnder.length > 0).length > 100,
    "nearly every icon carries the phrasings it was recovered under",
  );

  const run = createIconToolRunner(library);
  const result = await run({ queries: ["coin counter", "settings", "diamond"] });
  assert.match(result, /Coin \(Currency\) rbxassetid:\/\/84697600263846/);
  assert.match(result, /Diamond \(Currency\) rbxassetid:\/\/75581768563141/);
});

test("the tool says an exact theme or layout asset outranks its answer", () => {
  const definition = iconToolDefinition();
  assert.match(definition.description, /theme or layout still wins/);
  assert.match(definition.description, /no match rather than with the nearest picture/);
});
