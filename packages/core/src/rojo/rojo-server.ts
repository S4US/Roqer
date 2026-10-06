/**
 * Whether a Rojo server answers on this machine's port, and for which
 * project. A diagnostic for "sync pending" only: a server answering does not
 * mean Studio is connected to it.
 */
export async function probeRojoServer(port: number, fetchImpl: typeof fetch = fetch): Promise<{ reachable: boolean; projectName?: string }> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/rojo`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return { reachable: false };
    const body = await response.json() as { projectName?: unknown };
    return { reachable: true, ...(typeof body.projectName === 'string' ? { projectName: body.projectName } : {}) };
  } catch {
    return { reachable: false };
  }
}
