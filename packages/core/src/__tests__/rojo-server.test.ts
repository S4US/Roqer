import { describe, expect, test } from '@jest/globals';
import { probeRojoServer } from '../rojo/rojo-server.js';

describe('probeRojoServer', () => {
  test('a reachable server with a project name', async () => {
    let requested: string | undefined;
    const fetchImpl: typeof fetch = async (input) => {
      requested = String(input);
      return { ok: true, json: async () => ({ projectName: 'Foo' }) } as Response;
    };
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: true, projectName: 'Foo' });
    expect(requested).toBe('http://127.0.0.1:34872/api/rojo');
  });

  test('a reachable server whose body has no project name', async () => {
    const fetchImpl: typeof fetch = async () => ({ ok: true, json: async () => ({}) } as Response);
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: true });
  });

  test('a non-ok response is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => ({ ok: false, json: async () => ({}) } as Response);
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: false });
  });

  test('a fetch that rejects (timeout or abort) is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error('aborted'); };
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: false });
  });

  test('a response whose json() rejects is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } } as unknown as Response);
    await expect(probeRojoServer(34872, fetchImpl)).resolves.toEqual({ reachable: false });
  });
});
