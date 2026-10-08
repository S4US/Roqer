/**
 * Whether a Rojo server answers on this machine's port, and for which
 * project. A diagnostic for "sync pending" only: a server answering does not
 * mean Studio is connected to it.
 */
export async function probeRojoServer(port: number, fetchImpl: typeof fetch = fetch): Promise<{ reachable: boolean; projectName?: string }> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/rojo`, {
      signal: AbortSignal.timeout(1_000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { reachable: false };
    // Rojo 7.7 answers with content-type: application/msgpack, not JSON.
    // response.ok already means a Rojo server is reachable; only parse the
    // body, and only report projectName, when it actually claims JSON.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return { reachable: true };
    const body = await response.json() as { projectName?: unknown };
    return { reachable: true, ...(typeof body.projectName === 'string' ? { projectName: body.projectName } : {}) };
  } catch {
    return { reachable: false };
  }
}
