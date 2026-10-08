import { describe, expect, test } from '@jest/globals';
import { probeRojoServer } from '../rojo/rojo-server.js';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

describe('probeRojoServer', () => {
  test('a reachable server with a project name', async () => {
    let requested: string | undefined;
    let acceptHeader: string | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requested = String(input);
      acceptHeader = (init?.headers as Record<string, string> | undefined)?.Accept;
      return jsonResponse({ projectName: 'Foo' });
    };
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: true, projectName: 'Foo' });
    expect(requested).toBe('http://127.0.0.1:34872/api/rojo');
    expect(acceptHeader).toBe('application/json');
  });

  test('a reachable server whose JSON body has no project name', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({});
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: true });
  });

  // Rojo 7.7 answers GET /api/rojo with content-type: application/msgpack.
  // response.ok alone must mean reachable; a non-JSON body carries no
  // projectName, and must not be passed to response.json().
  test('a Rojo 7.7 server answering with msgpack is reachable with no project name', async () => {
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/msgpack' : null) },
      json: async () => { throw new Error('body is msgpack, not JSON'); },
    } as unknown as Response);
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: true });
  });

  test('a non-ok response is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({}, false);
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: false });
  });

  test('a fetch that rejects (timeout or abort) is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error('aborted'); };
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: false });
  });

  test('a response claiming JSON whose json() rejects is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => { throw new Error('bad json'); },
    } as unknown as Response);
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: false });
  });
});
