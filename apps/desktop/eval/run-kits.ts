/**
 * Can one Blender job and one upload carry a whole kit set? See kits.ts.
 *
 * Usage, from the repository root:
 *   npm run eval:kits -- [--blender <path|auto>] [--endpoint http://127.0.0.1:58741]
 *
 * Like eval:colors it needs Roqer's own bridge with an Open Cloud key and a
 * place you do not mind changing. It uploads two small Models and leaves them
 * under Workspace.WorkbenchKitProbe for you to look at.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { readGlbSummary } from "./colors";
import {
  judgeKitProbe, KIT_PROBE_READBACK, KIT_PROBE_ROOT, KIT_PROBE_SCRIPT, KIT_PROBE_SEED, KIT_VARIANTS,
  kitFileProblem, kitProbeAnswer,
} from "./kits";
import { runProbe, StudioProbe } from "./probe-support";

runProbe(async () => {
  const probe = await StudioProbe.open(process.argv.slice(2));

  // 1. One Blender job makes both files; check each holds what it should before publishing it.
  const outputDirectory = await probe.blender(KIT_PROBE_SCRIPT);
  for (const variant of KIT_VARIANTS) {
    const summary = readGlbSummary(await readFile(path.join(outputDirectory, variant.file)));
    const problem = kitFileProblem(variant, summary);
    if (problem !== undefined) throw new Error(`Blender did not export what the probe needs: ${problem}. Nothing was uploaded.`);
    process.stdout.write(`${variant.file}: ${summary.meshes} meshes, ${summary.materials} material(s), ${summary.attributes.join(", ")}\n`);
  }
  await probe.luau("Preparing Workspace.WorkbenchKitProbe", KIT_PROBE_SEED);

  // 2. One upload per file, as a map's whole kit set would be.
  const assets: Record<string, string> = {};
  for (const variant of KIT_VARIANTS) {
    const assetId = await probe.uploadModel(path.join(outputDirectory, variant.file), variant.displayName);
    assets[variant.id] = assetId;
    await probe.insert(assetId, `${KIT_PROBE_ROOT}.${variant.id}`, variant.position);
  }

  // 3. What arrived: how many parts, which piece is which, colours, sizes, layout.
  const readback = await probe.luau("Reading back the inserted models", KIT_PROBE_READBACK, 90_000);
  const findings = judgeKitProbe(readback);
  const screenshot = await probe.screenshot(KIT_PROBE_ROOT, "kit-probe");
  const report = await probe.report("kit-probe", { assets, findings, readback });

  process.stdout.write("\n");
  for (const finding of findings) {
    const variant = KIT_VARIANTS.find((entry) => entry.id === finding.id)!;
    process.stdout.write(`${finding.id.toUpperCase()} (${variant.description}): ${finding.result} · ${finding.detail}\n`);
  }
  process.stdout.write(`\n${kitProbeAnswer(findings)}\n`);
  process.stdout.write(`\nReport: ${report}\n${screenshot === undefined ? "No screenshot was captured." : `Screenshot: ${screenshot}`}\n`);
  process.stdout.write(`Both uploads stay in ${KIT_PROBE_ROOT}: each should show a cliff section, a tree and a rock in their colours.\n`);
});
