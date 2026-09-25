#!/usr/bin/env node
/**
 * Puts Roblox's LibMP into studio-plugin/include/LibMP.lua for the plugin build.
 *
 * The micro-profiler reads captures through LibMP (https://github.com/Roblox/libmp).
 * Its repository carries no licence, so the library is not committed here;
 * each build fetches the published release and checks it byte for byte against
 * the hash below. Roblox publishes it under a moving `latest` tag, so when they
 * ship a new version this check fails on purpose: confirm the new file still
 * offers what MicroProfilerHandlers.ts calls, then update LIBMP_SHA256.
 *
 * Offline, or to use a copy you already have, set LIBMP_PATH to that file. A
 * copy already in place with the pinned hash is used as it is.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const LIBMP_URL = 'https://github.com/Roblox/libmp/releases/download/latest/LibMP.luau';
export const LIBMP_SHA256 = 'ab9579e592e8751386a01537152f2b739cc7942ce565d3c11337cddaa250d231';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIBMP_DESTINATION = join(rootDir, 'studio-plugin', 'include', 'LibMP.lua');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verified(bytes, source) {
  const actual = sha256(bytes);
  if (actual !== LIBMP_SHA256) {
    throw new Error(
      `LibMP from ${source} has SHA-256 ${actual}, not the pinned ${LIBMP_SHA256}. `
      + 'If Roblox published a new LibMP, check it still offers what '
      + 'studio-plugin/src/modules/handlers/MicroProfilerHandlers.ts calls, then update LIBMP_SHA256 in scripts/fetch-libmp.mjs.',
    );
  }
  return bytes;
}

/** Ensure the pinned LibMP is at `destination`, fetching it only when needed. */
export async function ensureLibMP({
  destination = LIBMP_DESTINATION,
  localPath = process.env.LIBMP_PATH,
  fetchImpl = globalThis.fetch,
  log = (message) => console.log(message),
} = {}) {
  if (existsSync(destination) && sha256(readFileSync(destination)) === LIBMP_SHA256) return 'present';

  let bytes;
  if (localPath) {
    bytes = verified(readFileSync(localPath), localPath);
  } else {
    log(`Fetching LibMP from ${LIBMP_URL}`);
    let response;
    try {
      response = await fetchImpl(LIBMP_URL, { redirect: 'follow' });
    } catch (error) {
      throw new Error(`Could not download LibMP (${error instanceof Error ? error.message : error}). `
        + 'Set LIBMP_PATH to a local copy to build offline.');
    }
    if (!response.ok) {
      throw new Error(`Could not download LibMP: HTTP ${response.status}. Set LIBMP_PATH to a local copy to build offline.`);
    }
    bytes = verified(Buffer.from(await response.arrayBuffer()), LIBMP_URL);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return localPath ? 'copied' : 'downloaded';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  ensureLibMP().then((result) => console.log(`LibMP ${result}.`)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
