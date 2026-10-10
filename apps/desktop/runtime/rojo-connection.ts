import path from "node:path";

import { isPlaceInstanceId, rojoPillState, type RojoResult, type RojoScriptCounts, type RojoView } from "../shared/rojo";
import type { McpToolOutcome } from "./mcp-types";
import type { RojoLinksStore } from "./rojo-links";

/**
 * Remembered Rojo links and live detection, for the pill and its popover.
 *
 * Pure logic with everything that touches the outside world injected: the
 * bridge call, a port probe, and a project file's own serve-port reader. The
 * main process wires this to the real `McpClient`, `probeRojoServer`, and a
 * small `fs.readFile` helper; tests wire it to fakes. Nothing here imports
 * Electron.
 *
 * `manage_instance link_project` is the only way a link happens, so every
 * success or failure this class sees is kept per instance in memory -- that
 * memory, not the store, is what the pill's `linked` and `error` states read,
 * because the store only knows what to *try* again, not whether the current
 * bridge process is actually holding that link right now.
 */

const DEFAULT_SERVE_PORT = 34872;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type LinkedMemory = Readonly<{
  kind: "linked";
  project: string;
  root: string;
  rojoVersion: string;
  scripts: RojoScriptCounts;
  problems: readonly string[];
  port: number;
}>;

type ErrorMemory = Readonly<{ kind: "error"; message: string }>;

type Memory = LinkedMemory | ErrorMemory;

type LinkedData = Readonly<{
  project: string;
  root: string;
  rojoVersion: string;
  scripts: RojoScriptCounts;
  problems: readonly string[];
  port: number;
}>;

/** `undefined` means the payload did not look like a real `link_project` success -- never fabricated. */
function parseLinkedData(value: unknown): LinkedData | undefined {
  if (!isRecord(value) || value.linked !== true) return undefined;
  const { project, root, rojoVersion, scripts, problems, rojoServer } = value;
  if (typeof project !== "string" || typeof root !== "string" || typeof rojoVersion !== "string") return undefined;
  if (!isRecord(scripts) || typeof scripts.file !== "number" || typeof scripts.generated !== "number" || typeof scripts.unsupported !== "number") {
    return undefined;
  }
  if (!Array.isArray(problems) || !problems.every((entry) => typeof entry === "string")) return undefined;
  if (!isRecord(rojoServer) || typeof rojoServer.port !== "number") return undefined;
  return {
    project, root, rojoVersion,
    scripts: { file: scripts.file, generated: scripts.generated, unsupported: scripts.unsupported },
    problems,
    port: rojoServer.port,
  };
}

export type RojoToolCaller = (tool: string, args: Record<string, unknown>) => Promise<McpToolOutcome>;
export type RojoProbe = (port: number) => Promise<{ answering: boolean; projectName?: string }>;
export type RojoReadServePort = (projectFile: string) => Promise<number | undefined>;

export type RojoConnectionOptions = Readonly<{
  store: RojoLinksStore;
  callTool: RojoToolCaller;
  probe: RojoProbe;
  readServePort: RojoReadServePort;
}>;

export class RojoConnection {
  private readonly store: RojoLinksStore;
  private readonly callTool: RojoToolCaller;
  private readonly probe: RojoProbe;
  private readonly readServePort: RojoReadServePort;
  /** The last link attempt's outcome, per instance, for as long as this bridge process runs. */
  private readonly memory = new Map<string, Memory>();
  /** Instances this bridge has already linked, so a Studio status refresh does not relink them again. */
  private readonly linkedThisBridge = new Set<string>();
  /**
   * Instances whose last automatic relink failed, so repeated Studio-status
   * refreshes (every few seconds, from Task 3) do not re-run `rojo sourcemap`
   * against a broken or moved project indefinitely. Cleared by
   * `bridgeRestarted()`, by the instance dropping out of and back into the
   * connected list, or bypassed outright by an explicit `retry()`.
   */
  private readonly failedThisBridge = new Set<string>();
  /** The connected ids `relinkConnected` last saw, to detect a drop-then-reappear. */
  private lastConnected = new Set<string>();
  /**
   * One `link_project` attempt per instance at a time. A status poll's
   * `relinkConnected` is fired every few seconds and never awaited, and a
   * link can take rojo up to 20 s, so without this a slow instance would get
   * a new concurrent `link_project` call on every poll until the first one
   * finally resolves. `link()` (and so `retry()`, `linkRecent()`) checks this
   * first and hands back the attempt already running instead of starting
   * another.
   */
  private readonly inFlight = new Map<string, Promise<RojoResult>>();

  constructor(options: RojoConnectionOptions) {
    this.store = options.store;
    this.callTool = options.callTool;
    this.probe = options.probe;
    this.readServePort = options.readServePort;
  }

  /**
   * Whether a removal on the place may delete Rojo project files: what the
   * run engine rates such a removal by. It errs toward yes: any link this
   * bridge holds or is making counts, since an unpublished place linked as
   * `anon:` is reached as `place:` once published (the bridge follows the
   * alias, this memory does not), and a call with no place of its own
   * (`null`) may be routed to a linked one.
   */
  isLinked(instanceId: string | null): boolean {
    if (instanceId !== null && (this.memory.get(instanceId)?.kind === "linked" || this.inFlight.has(instanceId))) return true;
    for (const memory of this.memory.values()) if (memory.kind === "linked") return true;
    return this.inFlight.size > 0;
  }

  /** The unknown-action rejection a bridge built before `link_project` existed gives back. */
  private isOlderBridgeError(outcome: McpToolOutcome): boolean {
    const message = outcome.message ?? "";
    return message.includes("manage_instance requires action=") && !message.includes("link_project");
  }

  private describeFailure(outcome: McpToolOutcome): string {
    if (this.isOlderBridgeError(outcome)) {
      return "This Roqer bridge is older than the app; quit other Roqer or Codex bridges and restart Roqer.";
    }
    if (isRecord(outcome.data) && typeof outcome.data.error === "string") return outcome.data.error;
    return outcome.message ?? "Rojo could not complete that request.";
  }

  /** Probes the default port, then each recent project's own serve port, stopping at the first answer. */
  private async detectServer(recent: readonly string[]): Promise<{ answering: boolean; port: number; projectName?: string }> {
    const ports: number[] = [DEFAULT_SERVE_PORT];
    for (const projectFile of recent) {
      const port = await this.readServePort(projectFile).catch(() => undefined);
      if (port !== undefined && !ports.includes(port)) ports.push(port);
    }
    for (const port of ports) {
      const probed = await this.probe(port).catch((): { answering: boolean; projectName?: string } => ({ answering: false }));
      if (probed.answering) return { answering: true, port, projectName: probed.projectName };
    }
    return { answering: false, port: DEFAULT_SERVE_PORT };
  }

  /** The view for one instance, assuming it is the one this action just touched -- so it is connected by definition. */
  private viewFor(instanceId: string): Promise<RojoView> {
    return this.view(instanceId, [instanceId]);
  }

  async view(instanceId: string | null, connectedIds: readonly string[]): Promise<RojoView> {
    const snapshot = await this.store.get();
    const recent = snapshot.recent.map((projectFile, index) => ({
      index,
      fileName: path.basename(projectFile),
      folder: path.dirname(projectFile),
    }));

    if (instanceId === null || !connectedIds.includes(instanceId)) {
      return { instanceId, published: instanceId !== null && isPlaceInstanceId(instanceId), state: "no-place", recent };
    }

    const published = isPlaceInstanceId(instanceId);
    const memory = this.memory.get(instanceId);

    if (memory?.kind === "linked") {
      const probed = await this.probe(memory.port).catch((): { answering: boolean; projectName?: string } => ({ answering: false }));
      return {
        instanceId, published, recent,
        state: rojoPillState({ connected: true, linked: true, answering: probed.answering, errored: false }),
        project: {
          fileName: memory.project, folder: memory.root, rojoVersion: memory.rojoVersion,
          scripts: memory.scripts, problems: memory.problems,
        },
        server: { port: memory.port, answering: probed.answering, projectName: probed.projectName },
      };
    }

    if (memory?.kind === "error") {
      return {
        instanceId, published, recent,
        state: rojoPillState({ connected: true, linked: false, answering: false, errored: true }),
        message: memory.message,
      };
    }

    const detected = await this.detectServer(snapshot.recent);
    return {
      instanceId, published, recent,
      state: rojoPillState({ connected: true, linked: false, answering: detected.answering, errored: false }),
      ...(detected.answering ? { server: { port: detected.port, answering: true, projectName: detected.projectName } } : {}),
    };
  }

  /** Runs one real `link_project` attempt; only ever called through `link()`'s in-flight guard. */
  private async performLink(instanceId: string, projectFile: string): Promise<RojoResult> {
    // Core refuses to replace an existing link with a failed one (the same
    // "one project per place" rule `link_project` itself enforces), so a
    // working link survives a failed "Change project..." attempt: only
    // overwrite memory with the error when this instance was not already
    // linked to something else.
    const wasLinked = this.memory.get(instanceId)?.kind === "linked";
    const outcome = await this.callTool("manage_instance", { action: "link_project", project: projectFile, instance_id: instanceId });
    if (!outcome.ok) {
      const message = this.describeFailure(outcome);
      if (!wasLinked) {
        this.memory.set(instanceId, { kind: "error", message });
        this.linkedThisBridge.delete(instanceId);
        this.failedThisBridge.add(instanceId);
      }
      return { ok: false, message, view: await this.viewFor(instanceId) };
    }
    const parsed = parseLinkedData(outcome.data);
    if (parsed === undefined) {
      const message = "Rojo returned an unexpected response.";
      if (!wasLinked) {
        this.memory.set(instanceId, { kind: "error", message });
        this.failedThisBridge.add(instanceId);
      }
      return { ok: false, message, view: await this.viewFor(instanceId) };
    }
    this.memory.set(instanceId, {
      kind: "linked", project: parsed.project, root: parsed.root, rojoVersion: parsed.rojoVersion,
      scripts: parsed.scripts, problems: parsed.problems, port: parsed.port,
    });
    this.linkedThisBridge.add(instanceId);
    this.failedThisBridge.delete(instanceId);
    await this.store.remember(instanceId, projectFile);
    await this.store.touchRecent(projectFile);
    return { ok: true, view: await this.viewFor(instanceId) };
  }

  /** `link_project` for one instance, de-duplicated against any attempt already running for it (see `inFlight`'s doc comment). */
  async link(instanceId: string, projectFile: string): Promise<RojoResult> {
    const existing = this.inFlight.get(instanceId);
    if (existing !== undefined) return existing;
    const attempt = this.performLink(instanceId, projectFile);
    this.inFlight.set(instanceId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.inFlight.get(instanceId) === attempt) this.inFlight.delete(instanceId);
    }
  }

  async linkRecent(instanceId: string, index: number): Promise<RojoResult> {
    const snapshot = await this.store.get();
    const projectFile = snapshot.recent[index];
    if (!Number.isInteger(index) || index < 0 || projectFile === undefined) {
      return { ok: false, message: "That recent project is no longer available." };
    }
    return this.link(instanceId, projectFile);
  }

  async unlink(instanceId: string): Promise<RojoResult> {
    const outcome = await this.callTool("manage_instance", { action: "unlink_project", instance_id: instanceId });
    if (!outcome.ok) {
      return { ok: false, message: this.describeFailure(outcome), view: await this.viewFor(instanceId) };
    }
    this.memory.delete(instanceId);
    this.linkedThisBridge.delete(instanceId);
    this.failedThisBridge.delete(instanceId);
    await this.store.forget(instanceId);
    return { ok: true, view: await this.viewFor(instanceId) };
  }

  /** "Forget this link" (spec §5): drops the stored and remembered link without the bridge, even if it is unreachable. */
  async forget(instanceId: string): Promise<RojoResult> {
    try {
      await this.store.forget(instanceId);
    } catch {
      return { ok: false, message: "The Rojo link could not be forgotten." };
    }
    this.memory.delete(instanceId);
    this.linkedThisBridge.delete(instanceId);
    this.failedThisBridge.delete(instanceId);
    return { ok: true, view: await this.viewFor(instanceId) };
  }

  /**
   * Relinks every connected, remembered place not already settled (linked or
   * failed) on this bridge. A failed relink is not retried on a later call --
   * only `bridgeRestarted()`, the instance dropping out of and back into
   * `instanceIds`, or an explicit `retry()` tries it again -- so a broken or
   * moved project does not run `rojo sourcemap` on every Studio-status
   * refresh indefinitely. Never throws for one instance's failure.
   */
  async relinkConnected(instanceIds: readonly string[]): Promise<void> {
    for (const instanceId of instanceIds) {
      if (isPlaceInstanceId(instanceId) && !this.lastConnected.has(instanceId)) this.failedThisBridge.delete(instanceId);
    }
    this.lastConnected = new Set(instanceIds);

    const snapshot = await this.store.get();
    for (const instanceId of instanceIds) {
      if (!isPlaceInstanceId(instanceId)) continue;
      if (this.linkedThisBridge.has(instanceId) || this.failedThisBridge.has(instanceId)) continue;
      const stored = snapshot.links.find((link) => link.instanceId === instanceId);
      if (stored === undefined) continue;
      await this.link(instanceId, stored.projectFile);
    }
  }

  /**
   * Re-attempts a remembered link regardless of whether an earlier automatic
   * relink failed (the popover's Retry button).
   *
   * Retry must always reflect a fresh attempt, never the stale result of one
   * dispatched before whatever was wrong got fixed. `relinkConnected`'s
   * periodic poll can have its own `link()` call in flight for this instance
   * right when the user clicks Retry -- started while the project file was
   * still missing, say -- and `link()`'s normal in-flight dedup would hand
   * that same shared promise straight to Retry, which resolves to the old
   * failure even after the file has since been restored. So: if an attempt
   * is already in flight, await it rather than racing a second bridge call
   * against it; a success is Retry's own result, nothing more to do. A
   * failure is stale by definition -- Retry dispatches a brand new attempt
   * instead (the in-flight one's own `finally` has already cleared the slot
   * by the time its result resolves, so `link()` below genuinely calls the
   * bridge again, not another shared promise).
   */
  async retry(instanceId: string): Promise<RojoResult> {
    const snapshot = await this.store.get();
    const stored = snapshot.links.find((link) => link.instanceId === instanceId);
    if (stored === undefined) {
      return { ok: false, message: "There is no remembered project to retry.", view: await this.viewFor(instanceId) };
    }
    const existing = this.inFlight.get(instanceId);
    if (existing !== undefined) {
      const result = await existing;
      if (result.ok) return result;
    }
    return this.link(instanceId, stored.projectFile);
  }

  /**
   * The bridge restarted or was adopted: every remembered place needs
   * relinking again. `memory` is cleared too, not just the two sets -- a new
   * bridge process has linked nothing yet, so an unpublished place's old
   * "linked" memory would otherwise keep showing green with no link behind
   * it. A published place's memory is refilled by the relink `relinkConnected`
   * runs next; an unpublished one has no stored link to replay, so it goes
   * back to "not linked" until the user links it again this session.
   */
  bridgeRestarted(): void {
    this.memory.clear();
    this.linkedThisBridge.clear();
    this.failedThisBridge.clear();
  }

  /** The linked project's folder, for "Open folder" -- only while this instance is actually linked. */
  projectFolderFor(instanceId: string): string | undefined {
    const memory = this.memory.get(instanceId);
    return memory?.kind === "linked" ? memory.root : undefined;
  }
}
