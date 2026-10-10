import { randomUUID } from 'crypto';
import * as path from 'path';
import type { BridgeService } from '../bridge-service.js';
import type { PluginVariant } from '../install-plugin-helpers.js';
import { createRojoClientScope, snapshotRojoScope, withRojoCall, type RojoClientScope, type RojoScopeSnapshot } from './client-context.js';
import { validateSourceEnvironment } from './client-environment.js';
import { createIdentityHistory, currentStudioOwner, rememberIdentities, type StudioOwner } from './identity-history.js';
import { publicToolErrorBody } from '../mcp-runtime.js';

export const ROJO_DELEGATE_PROTOCOL = 1;
export const ROJO_SOURCE_TOOLS = new Set(['get_script_source', 'set_script_source', 'edit_script_lines', 'edit_script_batch', 'insert_script_lines', 'delete_script_lines', 'find_and_replace_in_scripts']);
export const isRojoSourceCall = (name: string, args: Record<string, unknown>): boolean => ROJO_SOURCE_TOOLS.has(name) || (name === 'manage_instance' && (args.action === 'link_project' || args.action === 'unlink_project'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCOPES = 64;
const MAX_BINDINGS = 256;
class OwnerReplayError extends Error {}

export interface RojoDelegateRequest {
  protocol: number;
  clientId: string;
  operationId: string;
  epoch?: string;
  kind: 'call' | 'prepare' | 'status' | 'release';
  toolName?: string;
  args?: Record<string, unknown>;
  defaultProject?: string;
  cwd: string;
  environment: Record<string, string>;
  state: RojoScopeSnapshot;
}

export interface RojoDelegateReply {
  protocol: number;
  epoch: string;
  applied?: boolean;
  state?: RojoScopeSnapshot;
  result?: unknown;
  error?: string;
  errorCode?: string;
}

interface Client {
  scope: RojoClientScope;
  active?: { id: string; result: Promise<RojoDelegateReply> };
  last?: { id: string; result: RojoDelegateReply };
}

function snapshot(value: unknown): RojoScopeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid client binding checkpoint.');
  const input = value as Partial<RojoScopeSnapshot>;
  if (!Number.isSafeInteger(input.version) || input.version! < 0 || typeof input.defaultAttempted !== 'boolean' || !Array.isArray(input.bindings) || input.bindings.length > MAX_BINDINGS) throw new Error('Invalid client binding checkpoint.');
  const bindings = input.bindings.map((binding) => {
    if (!binding || typeof binding.instanceId !== 'string' || binding.instanceId.length > 512 ||
        typeof binding.projectFile !== 'string' || !path.isAbsolute(binding.projectFile) || binding.projectFile.length > 16384 || binding.projectFile.includes('\0')) throw new Error('Invalid client binding checkpoint.');
    if (binding.aliases !== undefined && (!Array.isArray(binding.aliases) || binding.aliases.length > 256 || binding.aliases.some((id) => typeof id !== 'string' || id.length > 512))) throw new Error('Invalid client identity checkpoint.');
    const owner = binding.studioOwner;
    if (!owner || typeof owner.physicalSessionId !== 'string' || owner.physicalSessionId.length === 0 || owner.physicalSessionId.length > 512 || owner.physicalSessionId.includes('\0') ||
        typeof owner.instanceId !== 'string' || owner.instanceId !== binding.instanceId) throw new OwnerReplayError();
    return { instanceId: binding.instanceId, projectFile: binding.projectFile, aliases: binding.aliases ? [...binding.aliases] : undefined, studioOwner: { ...owner } };
  });
  return { version: input.version!, defaultAttempted: input.defaultAttempted, bindings };
}

/** Authentication/edition checks precede this service in the HTTP boundary. */
export class RojoPrimaryService {
  readonly epoch = randomUUID();
  private readonly clients = new Map<string, Client>();
  private readonly creating = new Map<string, Promise<Client>>();
  private readonly shutdown = new AbortController();
  private readonly identities = createIdentityHistory();
  constructor(private readonly bridge: BridgeService, private readonly invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>, private readonly variant: PluginVariant = 'main', private readonly allowedTools?: ReadonlySet<string>) {}

  private refusal(errorCode: string, error: string): RojoDelegateReply {
    return { protocol: ROJO_DELEGATE_PROTOCOL, epoch: this.epoch, applied: false, errorCode, error };
  }

  async handle(raw: unknown, signal?: AbortSignal): Promise<RojoDelegateReply> {
    try {
      signal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
      signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid source delegation packet.');
      const request = raw as RojoDelegateRequest;
      if (request.protocol !== ROJO_DELEGATE_PROTOCOL || !UUID.test(request.clientId ?? '') || !UUID.test(request.operationId ?? '') ||
          !['call', 'prepare', 'status', 'release'].includes(request.kind) || typeof request.cwd !== 'string' ||
          !path.isAbsolute(request.cwd) || request.cwd.includes('\0') || request.cwd.length > 16384 ||
          (request.defaultProject !== undefined && (typeof request.defaultProject !== 'string' || request.defaultProject.length > 16384 || request.defaultProject.includes('\0')))) throw new Error('Invalid source delegation packet.');
      const checkpoint = snapshot(request.state);
      const environment = validateSourceEnvironment(request.environment);
      if (request.epoch !== this.epoch) return this.refusal('rojo_primary_changed', 'The primary changed before accepting this request. Confirm its client context before retrying.');
      if (this.variant === 'inspector' && (request.defaultProject !== undefined || checkpoint.defaultAttempted || checkpoint.bindings.length > 0)) return this.refusal('read_only_inspector', 'The inspector cannot configure or replay a Rojo project.');
      if (this.variant === 'inspector' && request.kind === 'call' && request.toolName !== 'get_script_source') return this.refusal('read_only_inspector', 'The inspector cannot delegate link or source mutations.');
      if (request.kind === 'call' && (!request.toolName || !request.args || typeof request.args !== 'object' || Array.isArray(request.args) ||
          !isRojoSourceCall(request.toolName, request.args) || (this.allowedTools && !this.allowedTools.has(request.toolName)))) return this.refusal('rojo_delegate_tool_refused', 'This tool is outside source delegation.');
      let client = this.clients.get(request.clientId);
      if (request.kind === 'status') {
        if (request.epoch !== this.epoch) return this.refusal('rojo_authority_unknown', 'The previous source operation belongs to another primary. Restart this MCP client and relink before writing.');
        if (!client && this.creating.has(request.clientId)) client = await this.creating.get(request.clientId)!;
        if (client?.active?.id === request.operationId) return await client.active.result;
        if (client?.last?.id === request.operationId) return client.last.result;
        return this.refusal('rojo_operation_unknown', 'The source operation is not recorded by this primary. No operation was replayed.');
      }
      if (request.kind === 'release') {
        if (client?.active) return this.refusal('rojo_client_busy', 'A source operation is still active.');
        this.clients.delete(request.clientId);
        return { protocol: ROJO_DELEGATE_PROTOCOL, epoch: this.epoch, applied: true };
      }
      if (client?.active?.id === request.operationId) return await client.active.result;
      if (client?.last?.id === request.operationId) return client.last.result;
      if (client?.active) return this.refusal('rojo_client_busy', 'This client has a source operation in progress; wait for its result.');
      if (!client) {
        if (!this.creating.has(request.clientId)) {
          if (this.clients.size + this.creating.size >= MAX_SCOPES) return this.refusal('rojo_context_capacity', 'The primary source context limit was reached. Close unused MCP clients or restart the bridge.');
          const creating = (async (): Promise<Client> => {
            const scope = createRojoClientScope(request.clientId, request.defaultProject, true);
            scope.environment = environment;
            // A cache miss never executes a handler against an empty replacement map.
            await withRojoCall({ scope, cwd: request.cwd, environment, signal }, async () => {
              for (const binding of checkpoint.bindings) {
                signal?.throwIfAborted();
                const owner = currentStudioOwner(this.bridge.getInstances(), binding.studioOwner!);
                if (!owner) throw new OwnerReplayError();
                rememberIdentities(scope.identities, [owner.instanceId]);
                await scope.rojo.link(owner.instanceId, binding.projectFile, scope.rojo.ownedKeys(owner), owner, () => {
                  const current = currentStudioOwner(this.bridge.getInstances(), owner);
                  if (current?.instanceId !== owner.instanceId) throw new OwnerReplayError();
                });
              }
            });
            signal?.throwIfAborted();
            scope.defaultAttempted = checkpoint.defaultAttempted;
            scope.version = checkpoint.version;
            const created = { scope };
            this.clients.set(request.clientId, created);
            return created;
          })();
          this.creating.set(request.clientId, creating);
        }
        try { client = await this.creating.get(request.clientId)!; }
        finally { this.creating.delete(request.clientId); }
      }
      // A retry may have waited behind the same cache-creation/replay barrier.
      if (client.active?.id === request.operationId) return await client.active.result;
      if (client.last?.id === request.operationId) return client.last.result;
      if (client.active) return this.refusal('rojo_client_busy', 'This client has a source operation in progress; wait for its result.');
      if (client.scope.defaultProject !== request.defaultProject) return this.refusal('rojo_context_changed', 'The client source configuration changed. Restart this MCP client before writing.');
      if (checkpoint.version !== client.scope.version) return this.refusal('rojo_checkpoint_mismatch', 'The client binding checkpoint is stale. Resolve its previous operation before writing.');
      const scope = client.scope;
      scope.environment = environment;
      const result = (async (): Promise<RojoDelegateReply> => {
        let output: unknown;
        try {
          signal?.throwIfAborted();
          if (request.kind === 'call') output = await withRojoCall({ scope, cwd: request.cwd, environment, signal }, () => this.invoke(request.toolName!, request.args!));
        } catch (error) {
          // State changes such as a consumed default attempt must also be ACKed on errors.
          output = { content: [{ type: 'text', text: JSON.stringify(publicToolErrorBody(request.toolName ?? 'source', error, { log: false })) }], isError: true };
        }
        scope.version += 1;
        return { protocol: ROJO_DELEGATE_PROTOCOL, epoch: this.epoch, applied: true, state: snapshotRojoScope(scope), result: output };
      })();
      client.active = { id: request.operationId, result };
      const reply = await result;
      client.last = { id: request.operationId, result: reply };
      client.active = undefined;
      return reply;
    } catch (error) {
      if (error instanceof OwnerReplayError) return this.refusal('rojo_binding_owner_unknown', 'The confirmed Studio session is unavailable or lacks ownership proof. Restart this MCP client and explicitly relink the intended place; no source operation was replayed.');
      // Private metadata and configuration values never appear in an error or log.
      return this.refusal('rojo_context_invalid', 'The client source context could not be validated. Resolve its state before retrying.');
    }
  }

  close(): void { this.shutdown.abort(); this.clients.clear(); this.creating.clear(); }

  rememberInstanceIds(ids: readonly string[]): void {
    rememberIdentities(this.identities, ids);
    for (const client of this.clients.values()) rememberIdentities(client.scope.identities, ids);
  }

  rememberStudioOwner(owner: StudioOwner): void {
    for (const client of this.clients.values()) client.scope.rojo.followStudioIdentity(owner);
  }
}
