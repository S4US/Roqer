/**
 * What every Studio probe (`eval:colors`, `eval:kits`) does the same way: reach
 * Roqer's bridge, run a Blender job, upload and insert a Model, read Luau back,
 * and save a screenshot. A probe drives no model; it answers one question about
 * Roblox with real uploads, so its steps have to be the ones Roqer's tools take.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BlenderWorker } from "../runtime/blender-worker";
import { McpClient } from "../runtime/mcp-client";
import type { McpToolOutcome } from "../runtime/mcp-types";
import { requireUploads, resolveBlender } from "./harness";
import { luauReturnValue } from "./reset";

const DEFAULT_ENDPOINT = "http://127.0.0.1:58741";
const UPLOAD_WAIT_MS = 180_000;
const POLL_MS = 5_000;

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function failure(step: string, outcome: McpToolOutcome): Error {
  return new Error(`${step} failed: ${outcome.message ?? outcome.errorCode ?? ""} ${outcome.text}`.trim());
}

export type Vector = Readonly<{ x: number; y: number; z: number }>;

export class StudioProbe {
  readonly outputFolder = path.join(process.cwd(), "eval", "results");

  private constructor(
    private readonly client: McpClient,
    private readonly place: Readonly<{ instance_id?: string }>,
    private readonly worker: BlenderWorker,
  ) {}

  /** Connects to the bridge, finds Blender, and refuses a bridge that cannot upload. */
  static async open(argv: readonly string[]): Promise<StudioProbe> {
    const flag = (name: string) => {
      const index = argv.indexOf(`--${name}`);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const endpoint = flag("endpoint") ?? DEFAULT_ENDPOINT;
    const client = new McpClient({ endpoint });
    const health = await client.health();
    if (!health.reachable) throw new Error(`The MCP bridge at ${endpoint} is not reachable: ${health.message}`);
    if (!health.pluginConnected) throw new Error("The MCP bridge is running but no Roblox Studio instance is connected.");
    const instanceId = health.instances[0]?.instanceId ?? null;
    const worker = new BlenderWorker({
      executable: await resolveBlender(flag("blender") ?? "auto"),
      jobsRoot: path.join(os.tmpdir(), "roqer-eval-blender-jobs"),
    });
    await requireUploads(client, instanceId, endpoint);
    return new StudioProbe(client, instanceId === null ? {} : { instance_id: instanceId }, worker);
  }

  /** Runs one Blender job and returns its output folder. */
  async blender(script: string): Promise<string> {
    const job = await this.worker.run({ script });
    if (!job.ok) throw new Error(`The Blender job failed: ${job.message ?? job.text}`);
    return String(record(job.data).outputDirectory);
  }

  /** Runs Luau in the place and returns what it returned. */
  async luau(step: string, code: string, timeoutMs = 30_000): Promise<unknown> {
    const outcome = await this.client.callTool("execute_luau", { code, ...this.place }, { timeoutMs });
    if (!outcome.ok) throw failure(step, outcome);
    return luauReturnValue(outcome.data);
  }

  /** Uploads a file as a Model, waiting out Roblox's processing, and returns its asset ID. */
  async uploadModel(filePath: string, displayName: string): Promise<string> {
    let outcome = await this.client.callTool("upload_asset", {
      action: "upload", filePath, assetType: "Model", displayName, ...this.place,
    }, { timeoutMs: 90_000 });
    const deadline = Date.now() + UPLOAD_WAIT_MS;
    while (outcome.ok && record(outcome.data).status === "processing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      outcome = await this.client.callTool("upload_asset", {
        action: "status", operationId: record(outcome.data).operation_id, ...this.place,
      }, { timeoutMs: 30_000 });
    }
    const upload = record(outcome.data);
    if (!outcome.ok || upload.status !== "complete" || upload.asset_id === undefined) {
      throw failure(`Uploading ${path.basename(filePath)}`, outcome);
    }
    const assetId = String(upload.asset_id);
    process.stdout.write(`${path.basename(filePath)}: uploaded as ${assetId} (${String(upload.moderation_state ?? "moderation not reported")})\n`);
    return assetId;
  }

  async insert(assetId: string, parentPath: string, position: Vector): Promise<void> {
    const inserted = await this.client.callTool("insert_asset", {
      assetId: Number(assetId), parentPath, position, ...this.place,
    }, { timeoutMs: 60_000 });
    if (!inserted.ok) throw failure(`Inserting ${assetId}`, inserted);
  }

  /** Frames `framePath` and saves a screenshot as `name`, or returns undefined when none came back. */
  async screenshot(framePath: string, name: string): Promise<string | undefined> {
    await mkdir(this.outputFolder, { recursive: true });
    await this.client.callTool("selection", { action: "view", path: framePath, from: 225, angleY: 30, padding: 1.4, ...this.place });
    const shot = await this.client.callTool("capture_screenshot", this.place, { timeoutMs: 30_000 });
    const image = shot.images?.[0];
    if (image === undefined) return undefined;
    const file = path.join(this.outputFolder, `${name}.${image.mediaType === "image/png" ? "png" : "jpg"}`);
    await writeFile(file, Buffer.from(image.data, "base64"));
    return file;
  }

  async report(name: string, body: object): Promise<string> {
    await mkdir(this.outputFolder, { recursive: true });
    const file = path.join(this.outputFolder, `${name}.json`);
    await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2)}\n`);
    return file;
  }
}

/** Runs a probe's main and turns a thrown error into a message and exit code. */
export function runProbe(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
