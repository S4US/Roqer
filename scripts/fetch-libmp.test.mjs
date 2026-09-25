import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureLibMP, LIBMP_SHA256 } from './fetch-libmp.mjs';

const directory = () => mkdtempSync(join(tmpdir(), 'roqer-libmp-'));
const quiet = () => undefined;
const refusingFetch = async () => {
  throw new Error('no network in this test');
};

test('a download whose bytes do not match the pinned hash is refused and not written', async () => {
  const destination = join(directory(), 'LibMP.lua');
  const fetchImpl = async () => new Response('-- something else');
  await assert.rejects(ensureLibMP({ destination, localPath: undefined, fetchImpl, log: quiet }), /not the pinned/);
  assert.throws(() => readFileSync(destination), /ENOENT/);
});

test('a failed download says how to build offline', async () => {
  const destination = join(directory(), 'LibMP.lua');
  await assert.rejects(
    ensureLibMP({ destination, localPath: undefined, fetchImpl: refusingFetch, log: quiet }),
    /LIBMP_PATH/,
  );
  const notFound = async () => new Response('missing', { status: 404 });
  await assert.rejects(ensureLibMP({ destination, localPath: undefined, fetchImpl: notFound, log: quiet }), /HTTP 404/);
});

test('a local copy is checked against the pin like a download', async () => {
  const root = directory();
  const local = join(root, 'LibMP.luau');
  writeFileSync(local, '-- tampered');
  await assert.rejects(
    ensureLibMP({ destination: join(root, 'out.lua'), localPath: local, fetchImpl: refusingFetch, log: quiet }),
    /not the pinned/,
  );
});

test('the pin is a SHA-256 digest', () => {
  assert.match(LIBMP_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update('').digest('hex').length, LIBMP_SHA256.length);
});
