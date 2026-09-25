/**
 * Does colour made in Blender survive a Roblox Model upload? See colors.ts.
 *
 * Usage, from the repository root:
 *   npm run eval:colors -- [--blender <path|auto>] [--endpoint http://127.0.0.1:58741]
 *
 * It needs Roqer's own bridge (the one with your Open Cloud key) and a Studio
 * place you do not mind changing: it uploads two small Models to your Roblox
 * account and inserts them under Workspace.WorkbenchColorProbe, which it leaves
 * there for you to look at. Rerunning replaces them in the place, not the
 * uploaded assets.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  COLOR_CASES, COLOR_PROBE_READBACK, COLOR_PROBE_ROOT, COLOR_PROBE_SCRIPT, COLOR_PROBE_SEED,
  glbProblem, judgeColorProbe, readGlbSummary,
} from "./colors";
import { runProbe, StudioProbe } from "./probe-support";

runProbe(async () => {
  const probe = await StudioProbe.open(process.argv.slice(2));

  // 1. Make both cubes, and prove each file carries its colour before publishing it.
  const outputDirectory = await probe.blender(COLOR_PROBE_SCRIPT);
  for (const colorCase of COLOR_CASES) {
    const summary = readGlbSummary(await readFile(path.join(outputDirectory, colorCase.file)));
    const problem = glbProblem(colorCase, summary);
    if (problem !== undefined) throw new Error(`Blender did not export what the probe needs: ${problem}. Nothing was uploaded.`);
    process.stdout.write(`${colorCase.file}: ${summary.attributes.join(", ")}; ${summary.images} image(s)\n`);
  }
  await probe.luau("Preparing Workspace.WorkbenchColorProbe", COLOR_PROBE_SEED);

  // 2. Upload and insert each one.
  const assets: Record<string, string> = {};
  for (const colorCase of COLOR_CASES) {
    const assetId = await probe.uploadModel(path.join(outputDirectory, colorCase.file), colorCase.displayName);
    assets[colorCase.id] = assetId;
    await probe.insert(assetId, `${COLOR_PROBE_ROOT}.${colorCase.id}`, colorCase.position);
  }

  // 3. Read back what Roblox made, and look at it.
  const readback = await probe.luau("Reading back the inserted models", COLOR_PROBE_READBACK, 90_000);
  const findings = judgeColorProbe(readback);
  const screenshot = await probe.screenshot(COLOR_PROBE_ROOT, "color-probe");
  const report = await probe.report("color-probe", { assets, findings, readback });

  process.stdout.write("\n");
  for (const finding of findings) process.stdout.write(`${finding.id.toUpperCase()}: ${finding.result} · ${finding.detail}\n`);
  process.stdout.write(`\nReport: ${report}\n${screenshot === undefined ? "No screenshot was captured." : `Screenshot: ${screenshot}`}\n`);
  process.stdout.write(`The cubes stay in ${COLOR_PROBE_ROOT} so you can look at them: the textured one should show red, green, blue and yellow patches, the vertex one a different colour per side.\n`);
});
