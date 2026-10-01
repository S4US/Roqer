import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TOOL_CATALOG_DIGEST } from '../tools/catalog-digest.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';

/**
 * A bridge reports TOOL_CATALOG_DIGEST on /health, and Roqer's eval refuses
 * one whose digest is not the checkout's, which the desktop's schema generator
 * records in apps/desktop/shared/mcp-tool-schemas.ts. The two are computed in
 * different packages, so this holds them to one value: were they to drift,
 * every eval run would be refused, or a stale bridge let through.
 */

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'apps', 'desktop')) ? cwd : path.resolve(cwd, '../..');
}

test('the digest is the tool definitions as JSON', () => {
  expect(TOOL_CATALOG_DIGEST).toBe(createHash('sha256').update(JSON.stringify(TOOL_DEFINITIONS), 'utf8').digest('hex'));
});

test('the desktop records the digest a bridge built from these definitions reports', () => {
  const generated = fs.readFileSync(path.join(repositoryRoot(), 'apps/desktop/shared/mcp-tool-schemas.ts'), 'utf8');
  const recorded = /export const TOOL_CATALOG_DIGEST = "([0-9a-f]{64})";/.exec(generated)?.[1];
  expect({ recorded, hint: 'Run: npm run generate:tool-schemas -w apps/desktop' })
    .toEqual({ recorded: TOOL_CATALOG_DIGEST, hint: 'Run: npm run generate:tool-schemas -w apps/desktop' });
});
