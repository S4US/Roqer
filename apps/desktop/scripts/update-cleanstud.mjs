/**
 * Builds the `roblox-cleanstud` skill from its upstream,
 * TemporaryLooker22/Stud-UI-Clean-Roblox.
 *
 * Upstream is an agent skill written for an agent that has file tools. Roqer's
 * skill pack serves only Markdown and `templates/**.lua`, a document of at most
 * 64 KB and a tool result of at most 48,000 characters, and its models have no
 * file tools. So every upstream file is carried over by a fixed rule rather
 * than by hand, and an update is a re-run of this script:
 *
 * - the kit's three modules unchanged, below `templates/install/`, which Roqer
 *   writes into the place with `set_script_source {template}` and never loads;
 * - the example builders unchanged, below `templates/examples/`;
 * - the references with upstream's paths and tool names rewritten to Roqer's;
 * - the icon catalog split into one file per category;
 * - the kit's own doc comments gathered into `references/kit-api.md`, since
 *   upstream tells the agent to read them in the 56 KB module.
 *
 * Only `SKILL.md`, which fits upstream's workflow to Roqer's tools, is written
 * by hand; this script never touches it, and says when upstream's own changed.
 * `UPSTREAM.json` records the commit and a hash of every generated file, and
 * `update-cleanstud.test.mjs` fails if any of them is edited by hand.
 *
 * The kit's Luau ends up in users' games, so an update stops, rather than
 * writes, when that code starts doing more than building UI, when the licence
 * changes, or when upstream adds a file this script has no rule for. It
 * reports new asset ids, so whoever updates can check who uploaded them.
 *
 * Run: npm run update:cleanstud -w apps/desktop -- [--commit <sha|ref>] [--source <git checkout>] [--check] [--accept-license-change]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "https://github.com/TemporaryLooker22/Stud-UI-Clean-Roblox";
export const SKILL_DIR = fileURLToPath(new URL("../agent/skills/roblox-cleanstud/", import.meta.url));
export const LOCK_FILE = "UPSTREAM.json";
/** Files in the skill this script does not write. */
export const HAND_WRITTEN = ["SKILL.md", LOCK_FILE];

/** The kit's modules, and the name each module's table goes by in the examples. */
const KIT = { StudUI: "UI", StudMotion: "Motion", CheckUIIcons: "Icons" };

/** Upstream files the skill leaves out, and why. Any file with no rule stops the update. */
const LEFT_OUT = [
  [/^README\.md$/, "the GitHub page; the skill and its references carry its content"],
  [/^SKILL\.md$/, "fitted to Roqer by hand in this skill's SKILL.md"],
  [/^default\.project\.json$/, "a Rojo mapping; Roqer installs the modules itself"],
  [/^\.gitattributes$/, "a repository setting"],
  [/^assets\/screenshots\/[^/]+\.jpg$/, "screenshots of the reference game; the model cannot view them, and references/screenshots.md keeps their descriptions"],
];

/** Upstream's Studio MCP tool names, and the Roqer operation that does the same. */
const TOOL_NAMES = { screen_capture: "capture_screenshot", start_stop_play: "solo_playtest", get_console_output: "get_runtime_logs" };

const MODULE_NAMES = Object.keys(KIT).join("|");
const PATH_REWRITES = [
  // Rojo is upstream's other way to install the modules; Roqer installs them itself.
  [/ \(Rojo: `src\/` maps directly\)/g, ""],
  [new RegExp(`\\bsrc/(${MODULE_NAMES})\\.luau\\b`, "g"), "templates/install/$1.lua"],
  [new RegExp(`(?<![\\w/])(${MODULE_NAMES})\\.luau\\b`, "g"), "templates/install/$1.lua"],
  [/\bexamples\/([\w.]+?)\.luau\b/g, "templates/examples/$1.lua"],
  [/(?<![\w/])(\d\d_[\w.]+?)\.luau\b/g, "templates/examples/$1.lua"],
  [/\breferences\/icon-catalog\.md\b/g, "references/icons/index.md"],
  [/\bassets\/screenshots\/README\.md\b/g, "references/screenshots.md"],
  [/\bassets\/screenshots\/?/g, "references/screenshots.md"],
];

/** What, once rewritten, must not be left in the text: a path or tool the skill does not have. */
const LEFTOVERS = [
  [/\.luau\b/, "an upstream .luau path"],
  [/\bassets\//, "an upstream assets/ path"],
  [/\bsrc\//, "an upstream src/ path"],
  [new RegExp(`\\b(${Object.keys(TOOL_NAMES).join("|")})\\b`), "an upstream tool name"],
];

/**
 * Code the kit must not run. It is installed into users' games, where it should
 * build and animate UI and nothing more. Comments are stripped first, so an
 * example's "replace with RemoteFunction:InvokeServer" note is not code.
 */
const RISKY_CODE = [
  [/\brequire\s*\(\s*\d/, "require(<asset id>) loads code from the Roblox catalog"],
  [/\b(loadstring|getfenv|setfenv)\b/, "runs or rewrites code at run time"],
  [/GetService\s*\(\s*["'](HttpService|InsertService|MarketplaceService|TeleportService|DataStoreService|MessagingService|AssetService)["']/, "uses a service that reaches past the UI"],
  [/:(FireServer|InvokeServer|FireClient|FireAllClients|InvokeClient|Kick)\s*\(/, "talks to the server or other players"],
  [/Instance\.new\s*\(\s*["'](RemoteEvent|RemoteFunction|UnreliableRemoteEvent|Script|LocalScript|ModuleScript)["']/, "creates remotes or scripts"],
  [/\.Source\s*=[^=]/, "writes script source"],
  [/:(GetObjects|LoadAsset)\s*\(/, "loads instances from the catalog"],
];

/** A load_skill result wraps a document in about 300 characters; the batch limit is 48,000. */
const MAX_DOCUMENT_CHARS = 47_000;
const MAX_INSTALL_BYTES = 256 * 1024;

/** Hashed with newlines normalised, so a CRLF checkout and an LF one agree. */
export const digest = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

export function stripLuauComments(code) {
  return code.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/--[^\n]*/g, "");
}

/** What in this Luau goes past building UI, one line each. */
export function scanLuau(file, code) {
  const findings = [];
  stripLuauComments(code).split("\n").forEach((line, index) => {
    for (const [pattern, reason] of RISKY_CODE) {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${reason}: ${line.trim()}`);
    }
  });
  return findings;
}

/** Upstream's paths and tool names, as this skill has them. */
export function rewriteText(text) {
  let result = text;
  for (const [pattern, replacement] of PATH_REWRITES) result = result.replace(pattern, replacement);
  for (const [from, to] of Object.entries(TOOL_NAMES)) result = result.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  return result;
}

function leftovers(file, text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    for (const [pattern, what] of LEFTOVERS) {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${what}: ${line.trim()}`);
    }
  });
  return findings;
}

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The 42,000-character catalog as an index plus one file per category, so a
 * screen loads the few categories it uses rather than every id.
 */
export function splitIconCatalog(text) {
  const [head, ...sections] = text.split(/^(?=## )/m);
  const index = sections.find((section) => /^## Index\s*$/m.test(section.split("\n")[0]));
  const categories = sections.filter((section) => section !== index).map((section) => {
    const title = section.split("\n")[0].replace(/^## /, "").trim();
    return { title, file: `references/icons/${slug(title)}.md`, body: section.slice(section.indexOf("\n") + 1).trim() };
  });
  if (index === undefined || categories.length === 0) {
    throw new Error("references/icon-catalog.md no longer has an Index section and category sections; update splitIconCatalog.");
  }
  const files = new Map();
  files.set("references/icons/index.md", [
    rewriteText(head).trimEnd(),
    "",
    index.trimEnd(),
    "",
    "Each category's icons and ids are in a file of its own. Load only the categories the screen uses:",
    "",
    ...categories.map(({ title, file }) => `- ${title}: \`${file}\``),
    "",
  ].join("\n"));
  for (const { title, file, body } of categories) {
    files.set(file, [
      `# Icons: ${title}`,
      "",
      `Part of the icon catalog (\`references/icons/index.md\`). An icon's path for \`Icons.Get(path)\` is \`${title}/<Subcategory>/<Name>\`: the row's subcategory, then the name in backticks. ★ = used by the reference game.`,
      "",
      rewriteText(body),
      "",
    ].join("\n"));
  }
  return files;
}

/** Path → id for every icon a category file lists. */
export function iconCatalogEntries(files) {
  const entries = new Map();
  for (const [file, text] of files) {
    const title = /^# Icons: (.+)$/m.exec(text)?.[1];
    if (title === undefined) continue;
    for (const row of text.split("\n")) {
      const cells = /^\| ([^|]+?) \| (.+) \|$/.exec(row);
      if (cells === null || cells[1] === "Subcategory" || /^-+$/.test(cells[1])) continue;
      for (const entry of cells[2].split("<br>")) {
        const icon = /`([^`]+)` (\d+)/.exec(entry);
        if (icon === null) throw new Error(`${file}: an icon entry did not parse: ${entry}`);
        entries.set(`${title}/${cells[1].trim()}/${icon[1]}`, icon[2]);
      }
    }
  }
  return entries;
}

/** Path → id from the registry module's flat map, the table `Icons.Get` reads. */
export function registryEntries(source) {
  const flat = /local FlatMap = \{([\s\S]*?)\n\}/.exec(source);
  if (flat === null) throw new Error("CheckUIIcons no longer has a FlatMap table; update registryEntries.");
  const entries = new Map();
  for (const [, iconPath, id] of flat[1].matchAll(/\["([^"]+)"\] = "rbxassetid:\/\/(\d+)"/g)) entries.set(iconPath, id);
  return entries;
}

/**
 * The doc comments of the kit's public functions and values, in file order.
 * Upstream tells the agent to read a function's header comment for its
 * parameters; that comment is the same text here, without loading the module.
 */
export function kitApi(modules) {
  const out = [
    "# Kit API",
    "",
    "Every public function of the installed modules with its doc comment, copied from the modules by the update script. The modules are installed in `ReplicatedStorage`; never load them.",
    "",
  ];
  const fenced = (comment) => ["", "  ```text", ...trimBlock(comment).map((text) => (text === "" ? "" : `  ${text}`)), "  ```"];
  for (const { name, alias, source } of modules) {
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    const table = /^local (\w+) = \{\}\s*$/m.exec(source)?.[1];
    if (table === undefined) throw new Error(`${name} no longer starts its module table with "local X = {}"; update kitApi.`);
    out.push(`## ${name} (\`local ${alias} = require(ReplicatedStorage.${name})\`)`, "");
    const header = /^(?:--![^\n]*\n)*--\[\[([\s\S]*?)\]\]/.exec(lines.join("\n"));
    if (header !== null) out.push("```text", ...trimBlock(header[1].split("\n")), "```", "");

    const locals = new Map();
    lines.forEach((line, index) => {
      const local = /^local function (\w+)\(/.exec(line);
      if (local !== null) locals.set(local[1], { parameters: parameters(line), comment: commentAbove(lines, index) });
    });
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const section = /^-- (\d+\.\s+.+?)\s*$/.exec(line);
      if (section !== null && /^-- =+/.test(lines[index - 1] ?? "")) {
        out.push(`### ${section[1]}`, "");
        continue;
      }
      const fn = new RegExp(`^function ${table}\\.(\\w+)\\(`).exec(line);
      const value = new RegExp(`^${table}\\.(\\w+)(?:, ${table}\\.\\w+)* = (.*)$`).exec(line);
      if (fn !== null) {
        const comment = commentAbove(lines, index);
        out.push(`- \`${alias}.${fn[1]}(${parameters(line)})\``, ...(comment.length > 0 ? fenced(comment) : []), "");
      } else if (value !== null && locals.has(value[2].trim())) {
        // A public name for a local function: show the function it names.
        const local = locals.get(value[2].trim());
        const comment = commentAbove(lines, index);
        const notes = comment.length > 0 ? comment : local.comment;
        out.push(`- \`${alias}.${value[1]}(${local.parameters})\``, ...(notes.length > 0 ? fenced(notes) : []), "");
      } else if (value !== null) {
        const statement = line.trim().replace(new RegExp(`\\b${table}\\.`, "g"), `${alias}.`);
        const comment = commentAbove(lines, index);
        out.push(/[{(]\s*$/.test(statement) ? `- \`${alias}.${value[1]}\` (a table)` : `- \`${statement}\``, ...(comment.length > 0 ? fenced(comment) : []), "");
      }
    }
  }
  return `${rewriteText(out.join("\n")).trimEnd()}\n`;
}

/** A function line's parameter list, read to its matching parenthesis so a function type inside it survives. */
function parameters(line) {
  const start = line.indexOf("(");
  let depth = 0;
  for (let index = start; index < line.length; index++) {
    if (line[index] === "(") depth++;
    else if (line[index] === ")" && --depth === 0) return line.slice(start + 1, index);
  }
  return line.slice(start + 1);
}

/**
 * The comment written just above a line: a `--[[ … ]]` block, or a run of `--`
 * lines. A simple local declaration between them, as the menu state above
 * `StudMotion.Window` is, does not separate a comment from its function.
 */
function commentAbove(lines, index) {
  let at = index - 1;
  while (at >= 0 && /^local \w+ = [^{(]*$/.test(lines[at]) && index - at <= 2) at--;
  if (at >= 0 && /\]\]\s*$/.test(lines[at]) && !/^\s*--(?!\[\[)/.test(lines[at])) {
    let start = at;
    while (start >= 0 && at - start < 40 && !/^\s*--\[\[/.test(lines[start])) start--;
    if (start < 0 || !/^\s*--\[\[/.test(lines[start])) return [];
    const block = lines.slice(start, at + 1).join("\n").replace(/^\s*--\[\[/, "").replace(/\]\]\s*$/, "");
    return block.split("\n");
  }
  const run = [];
  while (at >= 0 && /^--(?!\[\[)/.test(lines[at]) && !/^-- =+/.test(lines[at]) && !lines[at].startsWith("--!")) {
    run.unshift(lines[at].replace(/^---?\s?/, ""));
    at--;
  }
  return run;
}

/** A comment block without its shared indentation or blank edges. */
function trimBlock(lines) {
  const text = lines.map((line) => line.replace(/\t/g, "    ").trimEnd());
  while (text.length > 0 && text[0].trim() === "") text.shift();
  while (text.length > 0 && text[text.length - 1].trim() === "") text.pop();
  const indent = Math.min(...text.filter((line) => line.trim() !== "").map((line) => /^ */.exec(line)[0].length));
  return text.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
}

/**
 * The skill's generated files from upstream's, keyed by path. Throws, writing
 * nothing, when any rule no longer holds.
 *
 * @param {Map<string, string>} upstream every upstream text file, by path; screenshots may be absent
 * @param {string[]} paths every upstream path, text or not
 */
export function buildSkill(upstream, paths = [...upstream.keys()]) {
  const outputs = new Map();
  const problems = [];
  const text = (file) => {
    const value = upstream.get(file);
    if (value === undefined) throw new Error(`upstream ${file} is missing`);
    return value.replace(/\r\n/g, "\n");
  };

  for (const file of paths) {
    const install = /^src\/(\w+)\.luau$/.exec(file);
    const example = /^examples\/([\w.]+)\.luau$/.exec(file);
    const reference = /^references\/([\w-]+)\.md$/.exec(file);
    if (file === "LICENSE") {
      const license = text(file);
      if (!/^MIT License\b/.test(license) || !license.includes("Permission is hereby granted, free of charge")) {
        problems.push("LICENSE is no longer the MIT licence; stop and review it before carrying anything over.");
      }
      outputs.set("LICENSE.txt", license);
    } else if (file === "THIRD_PARTY_NOTICES.md") {
      outputs.set(file, rewriteText(text(file)));
    } else if (install !== null) {
      if (!(install[1] in KIT)) {
        problems.push(`upstream added the module ${file}; add it to KIT here and to the install step in SKILL.md, then run again.`);
        continue;
      }
      outputs.set(`templates/install/${install[1]}.lua`, text(file));
    } else if (example !== null) {
      outputs.set(`templates/examples/${example[1]}.lua`, text(file));
    } else if (file === "references/icon-catalog.md") {
      for (const [iconFile, iconText] of splitIconCatalog(text(file))) outputs.set(iconFile, iconText);
    } else if (reference !== null) {
      outputs.set(file, rewriteText(text(file)));
    } else if (file === "assets/screenshots/README.md") {
      const [title, ...rest] = rewriteText(text(file)).split("\n");
      outputs.set("references/screenshots.md", [
        title,
        "",
        "> The images are not shipped with Roqer: they are captures of the reference game, and the model cannot view them. Their descriptions below are.",
        ...rest,
      ].join("\n"));
    } else if (!LEFT_OUT.some(([pattern]) => pattern.test(file))) {
      problems.push(`upstream added ${file}, which has no rule; add one to buildSkill or LEFT_OUT, then run again.`);
    }
  }

  for (const name of Object.keys(KIT)) {
    if (!outputs.has(`templates/install/${name}.lua`)) problems.push(`upstream no longer has src/${name}.luau, which SKILL.md installs.`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));

  outputs.set("references/kit-api.md", kitApi(
    ["StudUI", "StudMotion"].map((name) => ({ name, alias: KIT[name], source: outputs.get(`templates/install/${name}.lua`) })),
  ));

  for (const [file, value] of outputs) {
    if (file.endsWith(".lua")) problems.push(...scanLuau(file, value));
    if (file.endsWith(".md")) problems.push(...leftovers(file, value));
    const install = file.startsWith("templates/install/");
    if (install ? Buffer.byteLength(value) > MAX_INSTALL_BYTES : value.length > MAX_DOCUMENT_CHARS) {
      problems.push(`${file} is ${install ? `${Buffer.byteLength(value)} bytes` : `${value.length} characters`}, past what Roqer can ${install ? "install" : "load in one result"}.`);
    }
  }

  const catalog = iconCatalogEntries(outputs);
  const registry = registryEntries(outputs.get("templates/install/CheckUIIcons.lua"));
  for (const [iconPath, id] of catalog) {
    if (registry.get(iconPath) !== id) problems.push(`the catalog gives ${iconPath} the id ${id}, the registry ${registry.get(iconPath) ?? "nothing"}.`);
  }
  for (const iconPath of registry.keys()) {
    if (!catalog.has(iconPath)) problems.push(`the registry has ${iconPath}, which the catalog does not list.`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return { outputs };
}

/** Every asset id the text names. */
export function assetIds(texts) {
  const ids = new Set();
  for (const value of texts) for (const [, id] of value.matchAll(/rbxasset(?:id)?:\/\/(\d+)/g)) ids.add(id);
  return ids;
}

function git(cwd, args, options = {}) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function readLock() {
  const file = path.join(SKILL_DIR, LOCK_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

function readCommitted(lock) {
  const files = new Map();
  for (const file of Object.keys(lock?.files ?? {})) {
    const absolute = path.join(SKILL_DIR, ...file.split("/"));
    if (fs.existsSync(absolute)) files.set(file, fs.readFileSync(absolute, "utf8"));
  }
  return files;
}

function parseArgs(argv) {
  const options = { check: false, acceptLicenseChange: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--accept-license-change") options.acceptLicenseChange = true;
    else if (arg === "--commit" || arg === "--source") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
}

function list(title, items, limit = 40) {
  if (items.length === 0) return;
  console.log(`${title}:`);
  for (const item of items.slice(0, limit)) console.log(`  ${item}`);
  if (items.length > limit) console.log(`  … and ${items.length - limit} more`);
}

function main(argv) {
  const options = parseArgs(argv);
  const temporary = options.source === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), "cleanstud-")) : undefined;
  try {
    let repository = options.source === undefined ? undefined : path.resolve(options.source);
    if (repository === undefined) {
      repository = path.join(temporary, "upstream");
      console.log(`Cloning ${UPSTREAM}`);
      execFileSync("git", ["clone", "--quiet", UPSTREAM, repository], { stdio: "inherit" });
    }
    const commit = git(repository, ["rev-parse", "--verify", `${options.commit ?? "HEAD"}^{commit}`]).trim();
    const committed = git(repository, ["show", "-s", "--format=%cI", commit]).trim();
    const paths = git(repository, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean);
    const upstream = new Map();
    for (const file of paths) {
      if (!/\.(jpg|png)$/i.test(file)) upstream.set(file, git(repository, ["show", `${commit}:${file}`]));
    }

    const lock = readLock();
    const { outputs } = buildSkill(upstream, paths);
    const license = digest(upstream.get("LICENSE"));
    if (lock !== undefined && lock.license?.sha256 !== license && !options.acceptLicenseChange) {
      throw new Error("Upstream's LICENSE changed since the last update. Read it; if it still allows shipping the kit, run again with --accept-license-change.");
    }

    const before = readCommitted(lock);
    const added = [...outputs.keys()].filter((file) => !before.has(file));
    const changed = [...outputs.keys()].filter((file) => before.has(file) && digest(before.get(file)) !== digest(outputs.get(file)));
    const removed = [...before.keys()].filter((file) => !outputs.has(file));
    const oldIds = assetIds(before.values());
    const registry = registryEntries(outputs.get("templates/install/CheckUIIcons.lua"));
    const iconIds = new Set(registry.values());
    const newIds = [...assetIds(outputs.values())].filter((id) => !oldIds.has(id));

    console.log(`Upstream ${lock?.commit === undefined ? "" : `${lock.commit.slice(0, 12)} → `}${commit.slice(0, 12)} (${committed})`);
    list("Added", added);
    list("Changed", changed);
    list("Removed", removed);
    list("New icon ids (in the CheckUIIcons registry)", newIds.filter((id) => iconIds.has(id)));
    list("New other asset ids: check who uploaded each before shipping", newIds.filter((id) => !iconIds.has(id)));

    const skill = digest(upstream.get("SKILL.md"));
    if (lock !== undefined && lock.skillSha256 !== skill) {
      console.log("\nUpstream's SKILL.md changed. Review roblox-cleanstud/SKILL.md against it:");
      try {
        console.log(git(repository, ["diff", lock.commit, commit, "--", "SKILL.md"]).slice(0, 20_000));
      } catch {
        console.log(`  (the old commit is not in ${repository}; compare by hand)`);
      }
    }

    const nextLock = {
      schemaVersion: 1,
      source: UPSTREAM,
      commit,
      committed,
      license: { spdx: "MIT", sha256: license },
      skillSha256: skill,
      files: Object.fromEntries([...outputs.keys()].sort().map((file) => [file, digest(outputs.get(file))])),
    };
    if (options.check) {
      const current = added.length === 0 && changed.length === 0 && removed.length === 0 && lock?.commit === commit;
      console.log(current ? "\nThe skill is current with this commit." : "\nThe skill differs from what this commit builds.");
      process.exitCode = current ? 0 : 1;
      return;
    }

    for (const file of removed) fs.rmSync(path.join(SKILL_DIR, ...file.split("/")), { force: true });
    for (const [file, value] of outputs) {
      if (HAND_WRITTEN.includes(file)) throw new Error(`refusing to write ${file}, which is written by hand.`);
      const absolute = path.join(SKILL_DIR, ...file.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, value);
    }
    fs.writeFileSync(path.join(SKILL_DIR, LOCK_FILE), `${JSON.stringify(nextLock, null, 2)}\n`);
    console.log([
      "",
      "Wrote the skill. Before committing:",
      "  1. Read the diff, above all of templates/install/: it is installed into users' games.",
      "  2. Fit roblox-cleanstud/SKILL.md to anything upstream's SKILL.md changed.",
      "  3. Bump the version in apps/desktop/agent/manifest.json.",
      "  4. npm run test:desktop, then build a screen in Studio.",
    ].join("\n"));
  } finally {
    if (temporary !== undefined) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
