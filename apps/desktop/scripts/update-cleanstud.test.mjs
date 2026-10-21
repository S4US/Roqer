import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildSkill, digest, HAND_WRITTEN, iconCatalogEntries, kitApi, LOCK_FILE, registryEntries, rewriteText, scanLuau, SKILL_DIR,
  splitIconCatalog,
} from "./update-cleanstud.mjs";

const read = (file) => fs.readFileSync(path.join(SKILL_DIR, ...file.split("/")), "utf8");
const lock = JSON.parse(read(LOCK_FILE));

/** Every file in the skill, as a path relative to it. */
function skillFiles() {
  return fs.readdirSync(SKILL_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(SKILL_DIR, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/**
 * The skill is generated, so a hand edit would be lost at the next update
 * without anyone noticing. Its hashes must be the ones the generator wrote.
 */
test("the committed skill is exactly what the update script wrote for the locked commit", () => {
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  for (const [file, hash] of Object.entries(lock.files)) {
    assert.equal(digest(read(file)), hash, `${file} differs from what the update script wrote. Change the script and run npm run update:cleanstud -w apps/desktop instead of editing it.`);
  }
  assert.deepEqual(skillFiles(), [...Object.keys(lock.files), ...HAND_WRITTEN].sort(), "the skill holds only generated files and SKILL.md");
});

test("every icon the catalog lists has the id the installed registry gives it", () => {
  const catalog = new Map(skillFiles().filter((file) => file.startsWith("references/icons/")).map((file) => [file, read(file)]));
  const registrySource = read("templates/install/CheckUIIcons.lua");
  const entries = iconCatalogEntries(catalog);
  assert.deepEqual(entries, registryEntries(registrySource));
  assert.equal(entries.size, Number(/TotalCount = (\d+)/.exec(registrySource)?.[1]));
});

test("the skill names only files it has, and the one roblox-ui-design reference it borrows", () => {
  for (const file of skillFiles().filter((name) => name.endsWith(".md"))) {
    for (const [, resource] of read(file).matchAll(/`(?:roblox-cleanstud\/)?((?:templates|references)\/[\w./-]+\.(?:lua|md))`/g)) {
      const here = fs.existsSync(path.join(SKILL_DIR, resource));
      const borrowed = resource === "references/core/validation.md" && fs.existsSync(path.join(SKILL_DIR, "..", "roblox-ui-design", resource));
      assert.ok(here || borrowed, `${file} names ${resource}, which does not exist`);
    }
  }
});

test("the installed modules and examples do nothing beyond building and animating UI", () => {
  for (const file of skillFiles().filter((name) => name.endsWith(".lua"))) {
    assert.deepEqual(scanLuau(file, read(file)), [], file);
  }
});

test("upstream's paths and Studio MCP tool names become the skill's", () => {
  assert.equal(
    rewriteText("Read `src/StudUI.luau`, copy `examples/01_ShopWindow.luau` (or 06_MenuController.client.luau), then `screen_capture`."),
    "Read `templates/install/StudUI.lua`, copy `templates/examples/01_ShopWindow.lua` (or templates/examples/06_MenuController.client.lua), then `capture_screenshot`.",
  );
  assert.equal(rewriteText("Put `CheckUIIcons.luau` here (Rojo: `src/` maps directly)."), "Put `templates/install/CheckUIIcons.lua` here.");
  assert.equal(rewriteText("Numbers refer to `assets/screenshots/`."), "Numbers refer to `references/screenshots.md`.");
});

test("the Luau scan finds catalog code, remotes and HTTP, but not a comment about them", () => {
  assert.deepEqual(scanLuau("a.lua", "-- replace with RemoteFunction:InvokeServer(x)\n--[[ require(123) ]]\nlocal t = 1\n"), []);
  const findings = scanLuau("a.lua", [
    "local m = require(4111)",
    "local h = game:GetService(\"HttpService\")",
    "remote:FireServer(1)",
    "loadstring(code)()",
  ].join("\n"));
  assert.equal(findings.length, 4);
  assert.match(findings[0], /^a\.lua:1: require\(<asset id>\)/);
});

test("the icon catalog splits into an index and one file per category without losing an icon", () => {
  const catalog = [
    "# Icon catalog",
    "",
    "Generated from `src/CheckUIIcons.luau`.",
    "",
    "## Index",
    "",
    "- **Animal**: Cat",
    "- **UI**: X",
    "",
    "## Animal",
    "",
    "| Subcategory | Name → asset id |",
    "|---|---|",
    "| Cat | `Cat 1st` 11<br>★ `Cat 1st Outline` 12 |",
    "",
    "## UI",
    "",
    "| Subcategory | Name → asset id |",
    "|---|---|",
    "| X | `X 1st Outline` 21 |",
    "",
  ].join("\n");
  const files = splitIconCatalog(catalog);
  assert.deepEqual([...files.keys()], ["references/icons/index.md", "references/icons/animal.md", "references/icons/ui.md"]);
  assert.match(files.get("references/icons/index.md"), /Generated from `templates\/install\/CheckUIIcons\.lua`/);
  assert.match(files.get("references/icons/index.md"), /- UI: `references\/icons\/ui\.md`/);
  assert.deepEqual(iconCatalogEntries(files), new Map([
    ["Animal/Cat/Cat 1st", "11"], ["Animal/Cat/Cat 1st Outline", "12"], ["UI/X/X 1st Outline", "21"],
  ]));
});

test("the kit API keeps each public function's own comment, its whole signature, and what an alias names", () => {
  const api = kitApi([{
    name: "StudMotion",
    alias: "Motion",
    source: [
      "--!nonstrict",
      "--[[",
      "\tStudMotion - motion",
      "]]",
      "local M = {}",
      "",
      "local function play(sounds, name)",
      "end",
      "M.Play = play",
      "",
      "--[[ Window controller.",
      "\topts: Keep ]]",
      "local openMenu = nil",
      "function M.Window(gui: ScreenGui, fenetre: Frame, opts)",
      "end",
      "",
      "--- Hover and press.",
      "function M.BindButton(button: GuiButton, onActivated: (() -> ())?)",
      "end",
      "return M",
    ].join("\n"),
  }]);
  assert.match(api, /StudMotion - motion/);
  assert.match(api, /- `Motion\.Play\(sounds, name\)`/);
  assert.match(api, /- `Motion\.Window\(gui: ScreenGui, fenetre: Frame, opts\)`\n\n {2}```text\n {2}Window controller\.\n {5}opts: Keep\n {2}```/);
  assert.match(api, /- `Motion\.BindButton\(button: GuiButton, onActivated: \(\(\) -> \(\)\)\?\)`\n\n {2}```text\n {2}Hover and press\./);
});

test("an upstream file with no rule, or kit code that reaches past the UI, stops the update", () => {
  const upstream = new Map([
    ["LICENSE", "MIT License\n\nPermission is hereby granted, free of charge, to any person\n"],
    ["src/StudUI.luau", "local UI = {}\nreturn UI\n"],
    ["src/StudMotion.luau", "local M = {}\nreturn M\n"],
    ["src/CheckUIIcons.luau", "local Icons = {}\nlocal FlatMap = {\n}\nreturn Icons\n"],
    ["references/icon-catalog.md", "# Icons\n\n## Index\n\n- none\n\n## UI\n\n| Subcategory | Name → asset id |\n|---|---|\n"],
  ]);
  assert.doesNotThrow(() => buildSkill(upstream));
  assert.throws(() => buildSkill(new Map([...upstream, ["tools/sync.sh", "#!/bin/sh\n"]])), /upstream added tools\/sync\.sh, which has no rule/);
  assert.throws(
    () => buildSkill(new Map([...upstream, ["src/StudUI.luau", "local UI = {}\nrequire(12345)\nreturn UI\n"]])),
    /templates\/install\/StudUI\.lua:2: require\(<asset id>\)/,
  );
  assert.throws(() => buildSkill(new Map([...upstream, ["LICENSE", "All rights reserved.\n"]])), /no longer the MIT licence/);
});
