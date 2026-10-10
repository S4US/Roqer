import { randomUUID } from 'crypto';
import { captureSourceEnvironment } from './client-environment.js';
import type { RojoScopeSnapshot } from './client-context.js';
import { ROJO_DELEGATE_PROTOCOL, isRojoSourceCall, type RojoDelegateRequest, type RojoDelegateReply } from './primary-service.js';

export interface RojoDelegateTransport {
  rojoCapabilities(): Promise<{ protocol: number; epoch: string } | undefined>;
  rojoRequest(request: RojoDelegateRequest): Promise<RojoDelegateReply>;
}
export type SourceToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const refusal = (errorCode: string, error: string): SourceToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ errorCode, error }) }], isError: true });

/** Lives with the client process, not a replaceable proxy bridge object. */
export class RojoProxyState {
  readonly clientId = randomUUID();
  checkpoint: RojoScopeSnapshot = { version: 0, defaultAttempted: false, bindings: [] };
  epoch?: string;
  uncertain?: RojoDelegateRequest;
  intent: boolean;
  busy = false;
  constructor(readonly defaultProject?: string) { this.intent = defaultProject !== undefined; }
}

function validCheckpoint(value: RojoScopeSnapshot | undefined): value is RojoScopeSnapshot {
  return !!value && Number.isSafeInteger(value.version) && value.version >= 0 && typeof value.defaultAttempted === 'boolean' &&
    Array.isArray(value.bindings) && value.bindings.every((binding) => typeof binding.instanceId === 'string' && typeof binding.projectFile === 'string'
      && typeof binding.studioOwner?.physicalSessionId === 'string' && binding.studioOwner.physicalSessionId.length > 0 && binding.studioOwner.instanceId === binding.instanceId);
}

/** Source-only private transport; model tool arguments never supply metadata. */
export class RojoPrimaryClient {
  constructor(private readonly transport: RojoDelegateTransport, readonly state: RojoProxyState) {}

  private packet(kind: RojoDelegateRequest['kind'], epoch: string, toolName?: string, args?: Record<string, unknown>): RojoDelegateRequest {
    return {
      protocol: ROJO_DELEGATE_PROTOCOL, clientId: this.state.clientId, operationId: randomUUID(), kind, epoch,
      defaultProject: this.state.defaultProject, cwd: process.cwd(), environment: captureSourceEnvironment(process.env),
      state: { ...this.state.checkpoint, bindings: this.state.checkpoint.bindings.map((binding) => ({ ...binding })) },
      ...(toolName ? { toolName, args } : {}),
    };
  }

  private accept(reply: RojoDelegateReply, request: RojoDelegateRequest): void {
    if (reply.protocol !== ROJO_DELEGATE_PROTOCOL || reply.epoch !== request.epoch || reply.applied !== true || !validCheckpoint(reply.state)) throw new Error('The primary returned an invalid source acknowledgment.');
    if (reply.state.version <= this.state.checkpoint.version) throw new Error('The primary returned an out-of-order source acknowledgment.');
    this.state.checkpoint = { ...reply.state, bindings: reply.state.bindings.map((binding) => ({ ...binding })) };
    this.state.epoch = reply.epoch;
    this.state.uncertain = undefined;
    // A status reconciliation is the same acknowledgment as the original reply.
    if (request.toolName === 'manage_instance' && request.args?.action === 'unlink_project'
      && !this.state.defaultProject && this.state.checkpoint.bindings.length === 0) this.state.intent = false;
  }

  private async recover(epoch: string): Promise<void> {
    const pending = this.state.uncertain;
    if (!pending) return;
    if (pending.epoch !== epoch) throw new Error('A previous Rojo operation has an unknown outcome on another primary. Restart this MCP client and relink before writing.');
    const reply = await this.transport.rojoRequest({ ...pending, kind: 'status' });
    if (!reply.applied) throw new Error('The previous Rojo operation is not confirmed. No old binding was replayed; restart this MCP client and relink.');
    this.accept(reply, pending);
  }

  private async run(kind: 'call' | 'prepare', toolName?: string, args?: Record<string, unknown>): Promise<SourceToolResult | undefined> {
    if (this.state.busy) return refusal('rojo_client_busy', 'This client has a source operation in progress; wait for its result.');
    this.state.busy = true;
    try {
      const capability = await this.transport.rojoCapabilities();
      if (!capability || capability.protocol !== ROJO_DELEGATE_PROTOCOL) return refusal('rojo_primary_outdated', 'The primary bridge does not support this Rojo client context. Restart or upgrade the matching bridge before editing or starting a new playtest.');
      await this.recover(capability.epoch);
      const request = this.packet(kind, capability.epoch, toolName, args);
      // Kept before dispatch: losing an unlink/default ACK must never replay its old map.
      this.state.uncertain = request;
      const reply = await this.transport.rojoRequest(request);
      if (reply.applied !== true) {
        const notAccepted = new Set(['rojo_primary_changed', 'rojo_delegate_tool_refused', 'read_only_inspector', 'rojo_client_busy', 'rojo_context_capacity', 'rojo_context_changed', 'rojo_checkpoint_mismatch']);
        if (reply.protocol === ROJO_DELEGATE_PROTOCOL && reply.applied === false && notAccepted.has(reply.errorCode ?? '')) this.state.uncertain = undefined;
        return refusal(reply.errorCode ?? 'rojo_authority_unknown', reply.error ?? 'The primary source operation could not be confirmed.');
      }
      this.accept(reply, request);
      if (kind === 'prepare') return undefined;
      const result = reply.result as SourceToolResult;
      if (!result || !Array.isArray(result.content)) return refusal('rojo_reply_invalid', 'The primary returned an invalid source result. Read the target before retrying.');
      return result;
    } catch {
      // No environment/configuration values are reflected into model results.
      return refusal('rojo_authority_unknown', 'The Rojo client context could not be confirmed. Resolve the previous operation or restart this MCP client and relink before retrying.');
    } finally { this.state.busy = false; }
  }

  invoke(toolName: string, args: Record<string, unknown>): Promise<SourceToolResult> | undefined {
    if (!isRojoSourceCall(toolName, args)) return undefined;
    if (toolName === 'manage_instance' && args.action === 'link_project') this.state.intent = true;
    if (!this.state.intent && !this.state.uncertain) return undefined;
    return this.run('call', toolName, args).then((result) => result ?? refusal('rojo_reply_invalid', 'The primary returned no source result. Read the target before retrying.'));
  }

  prepareStart(endpoint: string): Promise<Record<string, unknown> | undefined> | undefined {
    if (!['/api/start-playtest', '/api/multiplayer-test-start'].includes(endpoint) || (!this.state.intent && !this.state.uncertain)) return undefined;
    return this.run('prepare').then((result) => result ? JSON.parse(result.content[0].text) as Record<string, unknown> : undefined);
  }

  async release(): Promise<void> {
    if (!this.state.epoch || this.state.busy || this.state.uncertain) return;
    await this.transport.rojoRequest(this.packet('release', this.state.epoch));
  }
}
