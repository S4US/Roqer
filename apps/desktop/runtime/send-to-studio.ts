import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { timeoutForTool } from "../shared/mcp-tools";
import type { SendToStudioResult } from "../shared/project-files";
import type { McpCallOptions, McpToolOutcome } from "./mcp-types";
import { uploadedAsset } from "./upload-assets";

/**
 * One click from a model file to the user's place: upload it to Roblox as a
 * Model, wait for Roblox to finish processing it, and insert it into the
 * place.
 *
 * The user asked for this by clicking, having looked at the model, and the
 * window asked them to confirm the upload: `upload_asset` from a model is an
 * irreversible call that always asks, and the click is no looser. The place is
 * chosen before anything is uploaded (`chooseSendPlace`), so a send that could
 * not be inserted never uploads.
 *
 * Every send is recorded by the file's contents in a `SendLedger`: the
 * operation id the moment the upload returns, the asset id once Roblox has
 * processed it. Sending the same file again (after a timeout, a failed insert,
 * a stop, or a second click) waits on that operation or inserts that asset
 * instead of uploading a second copy. Only a changed file uploads again.
 */

type Caller = (tool: string, args: Record<string, unknown>, options?: McpCallOptions) => Promise<McpToolOutcome>;

const POLL_MS = 2_000;
/** How long Roblox may take to process an upload before the click stops waiting. */
const PROCESSING_WAIT_MS = 90_000;
const STATUS_TIMEOUT_MS = 20_000;
const MAX_DISPLAY_NAME = 50;

export function displayNameFor(fileName: string): string {
  const base = path.parse(fileName).name.replace(/[_-]+/g, " ").trim() || "Model";
  return base.slice(0, MAX_DISPLAY_NAME);
}

/** The SHA-256 of a file's contents, read in chunks so a large model is never held whole. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// -- What was sent -------------------------------------------------------------

export type SendRecord = {
  /** SHA-256 of the file that was uploaded. */
  hash: string;
  operationId?: string;
  assetId?: string;
  updatedAt: string;
};

export class SendLedgerError extends Error {}

/** The ledger format this build reads and writes. */
export const SEND_LEDGER_VERSION = 1;
/** The most sends remembered; the oldest go first. */
const MAX_SEND_RECORDS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecord(value: unknown): SendRecord | null {
  if (!isRecord(value) || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash)) return null;
  const operationId = typeof value.operationId === "string" && value.operationId !== "" ? value.operationId : undefined;
  const assetId = typeof value.assetId === "string" && /^\d{1,20}$/.test(value.assetId) ? value.assetId : undefined;
  if (operationId === undefined && assetId === undefined) return null;
  return {
    hash: value.hash,
    ...(operationId === undefined ? {} : { operationId }),
    ...(assetId === undefined ? {} : { assetId }),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

/**
 * Which files were sent to Roblox, by their contents. One JSON file, written
 * whole through a temporary file and a rename.
 *
 * A send is refused when the ledger cannot be read, rather than risk a second
 * upload of a file that was already sent: locked just now, or saved by a newer
 * Roqer. A damaged ledger is set aside and a new one started.
 */
export class SendLedger {
  private records: Map<string, SendRecord> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<Map<string, SendRecord>> {
    if (this.records !== null) return this.records;
    const records = new Map<string, SendRecord>();
    let text: string | null = null;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SendLedgerError("Roqer could not check which models it already sent. Nothing was uploaded; try again.");
      }
    }
    if (text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > SEND_LEDGER_VERSION) {
        throw new SendLedgerError("A newer version of Roqer recorded the models sent to Studio. Update Roqer to send from this one.");
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.sends)) {
        await fs.rename(this.file, `${this.file}.damaged-${Date.now()}`).catch(() => undefined);
      } else {
        for (const entry of parsed.sends) {
          const record = parseRecord(entry);
          if (record !== null) records.set(record.hash, record);
        }
      }
    }
    this.records = records;
    return records;
  }

  private async save(records: Map<string, SendRecord>): Promise<void> {
    const sends = [...records.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-MAX_SEND_RECORDS);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify({ version: SEND_LEDGER_VERSION, sends }, null, 1)}\n`, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, this.file);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new SendLedgerError("Roqer could not record the upload. Check the asset in Roblox before sending again.");
    }
  }

  get(hash: string): Promise<SendRecord | undefined> {
    return this.serial(async () => (await this.load()).get(hash));
  }

  /** Record what Roblox said about the upload of this file, merged into what was known. */
  record(hash: string, change: { operationId?: string; assetId?: string }): Promise<SendRecord> {
    return this.serial(async () => {
      const records = await this.load();
      const next: SendRecord = { ...records.get(hash), hash, ...stripUndefined(change), updatedAt: new Date().toISOString() };
      records.set(hash, next);
      await this.save(records);
      return next;
    });
  }

  /** Forget a send Roblox refused, so the next one uploads again. */
  forget(hash: string): Promise<void> {
    return this.serial(async () => {
      const records = await this.load();
      if (records.delete(hash)) await this.save(records);
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

// -- Sending -------------------------------------------------------------------

const stoppedResult = (detail: string, assetId?: string): SendToStudioResult => ({
  ok: false, cancelled: true, message: `Stopped. ${detail}`, ...(assetId === undefined ? {} : { assetId }),
});

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  }
  signal?.addEventListener("abort", done, { once: true });
});

export async function sendModelToStudio(
  call: Caller,
  request: { filePath: string; displayName: string; instanceId: string },
  ledger: SendLedger,
  options: {
    signal?: AbortSignal;
    /** For tests: how a poll waits, and how long processing may take. */
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    processingWaitMs?: number;
  } = {},
): Promise<SendToStudioResult> {
  const { signal } = options;
  const wait = options.wait ?? pause;
  const hash = await hashFile(request.filePath);
  let record = await ledger.get(hash);
  const uploadedBefore = record?.assetId !== undefined;
  let moderationState: string | undefined;
  const uploadRequest = { filePath: request.filePath, assetType: "Model" as const, displayName: request.displayName.slice(0, MAX_DISPLAY_NAME) };

  if (record === undefined) {
    if (signal?.aborted) return stoppedResult("Nothing was uploaded.");
    // Not stopped part way: once Roblox may have taken the upload, its answer
    // is recorded before anything else, or a retry would upload it again.
    const outcome = await call("upload_asset", { action: "upload", ...uploadRequest }, { timeoutMs: timeoutForTool("upload_asset") });
    if (outcome.errorCode === "timeout") {
      // No answer, so no operation id to record: the upload may have gone
      // through. Sending again could make a second copy, so the user is told.
      return { ok: false, message: "Roblox did not answer the upload in time, so it may or may not have gone through. Check your Roblox creations before sending it again." };
    }
    const asset = uploadedAsset(uploadRequest, outcome);
    if (asset.status === "failed" || (asset.assetId === undefined && asset.operationId === undefined)) {
      const reason = asset.error ?? "Roblox gave no asset or operation id";
      const keyHint = /api[ _-]?key|open ?cloud|creator|unauthori[sz]ed|401|403/i.test(reason)
        ? " Check the Open Cloud key and creator in Settings → Open Cloud."
        : "";
      return { ok: false, message: `Roblox did not take the upload: ${reason}.${keyHint}` };
    }
    moderationState = asset.moderationState;
    record = await ledger.record(hash, { operationId: asset.operationId, assetId: asset.assetId });
  }

  const deadline = Date.now() + (options.processingWaitMs ?? PROCESSING_WAIT_MS);
  while (record.assetId === undefined) {
    if (signal?.aborted) {
      return stoppedResult("Roblox is still processing the upload. Send to Studio again picks it up without uploading again.");
    }
    if (Date.now() >= deadline) {
      return { ok: false, message: "Roblox is still processing the upload. Send to Studio again in a minute: it checks this upload instead of uploading another." };
    }
    await wait(POLL_MS, signal);
    if (signal?.aborted) continue;
    let status: McpToolOutcome;
    try {
      status = await call("upload_asset", { action: "status", operationId: record.operationId }, { timeoutMs: STATUS_TIMEOUT_MS, signal });
    } catch (error) {
      if (signal?.aborted) continue;
      throw error;
    }
    if (!status.ok) {
      // No word from Roblox is not a refusal: the upload is kept for next time.
      return { ok: false, message: `Roqer could not check the upload with Roblox: ${status.message ?? (status.text || "no answer")}. Send to Studio again to check it again; it will not upload another.` };
    }
    const next = uploadedAsset(uploadRequest, status);
    if (next.status === "failed") {
      // Roblox refused it (moderation, a bad file): the next send tries afresh.
      await ledger.forget(hash);
      return { ok: false, message: `Roblox could not process the model: ${next.error ?? "unknown error"}. Sending again uploads it again.` };
    }
    moderationState = next.moderationState ?? moderationState;
    if (next.assetId !== undefined) record = await ledger.record(hash, { assetId: next.assetId });
  }

  const assetId = record.assetId;
  if (signal?.aborted) {
    return stoppedResult(`The model is uploaded as asset ${assetId}. Send to Studio again inserts it without uploading again.`, assetId);
  }
  // Not stopped part way either: an insert that started may already be in the place.
  const inserted = await call("insert_asset", {
    assetId: Number(assetId),
    instance_id: request.instanceId,
  }, { timeoutMs: timeoutForTool("insert_asset") });
  if (!inserted.ok) {
    return {
      ok: false,
      assetId,
      message: `Uploaded as asset ${assetId}, but Studio could not insert it: ${inserted.message ?? inserted.text ?? "unknown error"}. Send to Studio again inserts the same asset without uploading again.`,
    };
  }
  const moderation = moderationState !== undefined && moderationState !== "Approved" ? ` Roblox moderation: ${moderationState}.` : "";
  return {
    ok: true,
    assetId,
    message: uploadedBefore
      ? `Inserted asset ${assetId} into the place's Workspace. This file was uploaded before, so it was not uploaded again.`
      : `Uploaded as asset ${assetId} and inserted into the place's Workspace.${moderation}`,
  };
}
