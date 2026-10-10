/** Confirmed identity transitions outlive the transport's idle alias TTL. */
export interface RojoIdentityHistory { groups: Map<string, Set<string>>; overflow: boolean }
/** Private host proof: a canonical place observed on an accepted edit peer. */
export interface StudioOwner { physicalSessionId: string; instanceId: string }
export interface StudioIdentityTransition extends StudioOwner { previousInstanceId?: string }
type EditPeer = StudioOwner & { role: string };
export function studioOwnerAt(peers: readonly EditPeer[], instanceId: string): StudioOwner | undefined {
  const matches = peers.filter(peer => peer.role === 'edit' && peer.instanceId === instanceId);
  const physicals = new Set(matches.map(peer => peer.physicalSessionId));
  return physicals.size === 1 ? { instanceId, physicalSessionId: [...physicals][0] } : undefined;
}
export function currentStudioOwner(peers: readonly EditPeer[], owner: StudioOwner): StudioOwner | undefined {
  const matches = peers.filter(peer => peer.role === 'edit' && peer.physicalSessionId === owner.physicalSessionId);
  const identities = new Set(matches.map(peer => peer.instanceId));
  return identities.size === 1 ? { physicalSessionId: owner.physicalSessionId, instanceId: [...identities][0] } : undefined;
}
const MAX_IDENTITIES = 4096;
export const createIdentityHistory = (): RojoIdentityHistory => ({ groups: new Map(), overflow: false });
export function rememberIdentities(history: RojoIdentityHistory, ids: readonly string[]): void {
  const merged = new Set(ids);
  for (const id of ids) for (const previous of history.groups.get(id) ?? []) merged.add(previous);
  if (new Set([...history.groups.keys(), ...merged]).size > MAX_IDENTITIES) { history.overflow = true; return; }
  for (const id of merged) history.groups.set(id, merged);
}
export function historicalIdentities(history: RojoIdentityHistory, id: string, current: readonly string[] = []): string[] {
  rememberIdentities(history, [id, ...current]);
  return [...(history.groups.get(id) ?? new Set([id]))];
}
