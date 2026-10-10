import { AsyncLocalStorage } from 'async_hooks';
import * as path from 'path';
import { RojoIntegration } from './index.js';
import { gitIgnored } from './ownership.js';
import { execRojoWithEnvironment } from './sourcemap.js';
import { createIdentityHistory, type RojoIdentityHistory, type StudioOwner } from './identity-history.js';

export interface RojoBindingSnapshot {
  instanceId: string;
  projectFile: string;
  aliases?: string[];
  studioOwner?: StudioOwner;
}

export interface RojoScopeSnapshot {
  version: number;
  defaultAttempted: boolean;
  bindings: RojoBindingSnapshot[];
}

export interface RojoClientScope {
  readonly id: string;
  defaultProject?: string;
  defaultAttempted: boolean;
  linking: boolean;
  rojo: RojoIntegration;
  environment?: Record<string, string>;
  version: number;
  identities: RojoIdentityHistory;
}

export interface RojoCallContext {
  scope: RojoClientScope;
  cwd: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
}

const calls = new AsyncLocalStorage<RojoCallContext>();

export const currentRojoCall = (): RojoCallContext | undefined => calls.getStore();
export const withRojoCall = <T>(context: RojoCallContext, run: () => T): T => calls.run(context, run);
export const clientProjectPath = (project: string): string => path.resolve(currentRojoCall()?.cwd ?? process.cwd(), project);

/** Only source/link handlers enter this context; lifecycle tools keep their owner. */
export function createRojoClientScope(id: string, defaultProject?: string, delegated = false): RojoClientScope {
  const scope: RojoClientScope = {
    id, defaultProject, defaultAttempted: false, linking: false, version: 0, identities: createIdentityHistory(),
    rojo: new RojoIntegration(),
  };
  if (delegated) {
    const environment = () => {
      const current = currentRojoCall();
      return current?.scope === scope ? current.environment : scope.environment;
    };
    scope.rojo = new RojoIntegration({
      run: (args, cwd) => execRojoWithEnvironment(args, cwd, environment()),
      ignored: (root, files) => gitIgnored(root, files, environment(), currentRojoCall()?.cwd),
    });
  }
  return scope;
}

export function snapshotRojoScope(scope: RojoClientScope): RojoScopeSnapshot {
  return {
    version: scope.version,
    defaultAttempted: scope.defaultAttempted,
    bindings: scope.rojo.getLinks().map(({ instanceId, projectFile, studioOwner }) => ({ instanceId, projectFile,
      ...(studioOwner ? { studioOwner: { ...studioOwner } } : {}),
      aliases: [...(scope.identities.groups.get(instanceId) ?? new Set([instanceId]))] })),
  };
}
