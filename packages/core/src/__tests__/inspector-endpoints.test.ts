import * as fs from 'fs';
import * as path from 'path';
import { TOOL_HANDLERS } from '../http-server.js';
import { getAllTools } from '../tools/definitions.js';

/**
 * The inspector plugin refuses every endpoint missing from its own list
 * (INSPECTOR_ENDPOINTS in studio-plugin/src/modules/Communication.ts). This
 * keeps that list and the inspector's tools in step: a read tool that starts
 * sending a new endpoint must list it, and an endpoint only write tools send
 * must never be listed.
 */

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function read(relative: string): string {
  return fs.readFileSync(path.join(repositoryRoot(), relative), 'utf8');
}

/** The RobloxStudioTools method each tool's handler calls, found by running it. */
function toolMethod(tool: string): string {
  const handler = TOOL_HANDLERS[tool];
  let called: string | undefined;
  const recorder = new Proxy({}, {
    get: (_target, property) => () => {
      called ??= String(property);
      return Promise.resolve(undefined);
    },
  });
  // Handlers validate some arguments before calling; well-formed ones pass.
  void handler(recorder as never, { line_range: '1-1', old_string: 'x', edits: [] });
  if (called === undefined) throw new Error(`${tool} called no tools method`);
  return called;
}

/** Plugin endpoints a method sends, following the other methods it calls. */
function endpointsByMethod(): (method: string) => Set<string> {
  const source = read('packages/core/src/tools/index.ts');
  const body = source.slice(source.indexOf('export class RobloxStudioTools'));
  const declaration = /\n {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/g;
  const starts = [...body.matchAll(declaration)].map((match) => ({ name: match[1], index: match.index! }));
  const bodies = new Map<string, string>();
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : body.length;
    bodies.set(start.name, (bodies.get(start.name) ?? '') + body.slice(start.index, end));
  });
  return (method) => {
    const found = new Set<string>();
    const visit = (name: string, seen: Set<string>) => {
      if (seen.has(name)) return;
      seen.add(name);
      const text = bodies.get(name) ?? '';
      for (const match of text.matchAll(/['"`](\/api\/[a-z0-9-]+)/g)) found.add(match[1]);
      for (const match of text.matchAll(/this\.([A-Za-z_]\w*)\(/g)) visit(match[1], seen);
    };
    visit(method, new Set());
    return found;
  };
}

function inspectorAllowlist(): Set<string> {
  const source = read('studio-plugin/src/modules/Communication.ts');
  const block = source.slice(source.indexOf('const INSPECTOR_ENDPOINTS'));
  return new Set([...block.slice(0, block.indexOf(']);')).matchAll(/"(\/api\/[a-z0-9-]+)"/g)].map((match) => match[1]));
}

describe('inspector plugin endpoint list', () => {
  const endpointsFor = endpointsByMethod();
  const allowed = inspectorAllowlist();
  const tools = getAllTools();
  const readEndpoints = new Set<string>();
  const writeEndpoints = new Set<string>();
  for (const tool of tools) {
    const target = tool.category === 'read' ? readEndpoints : writeEndpoints;
    for (const endpoint of endpointsFor(toolMethod(tool.name))) target.add(endpoint);
  }

  test('the analysis sees the endpoints it is meant to', () => {
    expect(readEndpoints.has('/api/get-script-source')).toBe(true);
    expect(writeEndpoints.has('/api/set-properties')).toBe(true);
    expect(allowed.size).toBeGreaterThan(10);
  });

  test('every endpoint a read-only tool sends is answered by the inspector plugin', () => {
    expect([...readEndpoints].filter((endpoint) => !allowed.has(endpoint))).toEqual([]);
  });

  test('no endpoint that only write tools send is answered by the inspector plugin', () => {
    const writeOnly = [...writeEndpoints].filter((endpoint) => !readEndpoints.has(endpoint));
    expect(writeOnly.length).toBeGreaterThan(10);
    expect(writeOnly.filter((endpoint) => allowed.has(endpoint))).toEqual([]);
  });

  test('every listed endpoint is one the plugin routes', () => {
    const routes = read('studio-plugin/src/modules/Communication.ts');
    const routeBlock = routes.slice(routes.indexOf('const routeMap'), routes.indexOf('const INSPECTOR_ENDPOINTS'));
    for (const endpoint of allowed) expect(routeBlock).toContain(`"${endpoint}"`);
  });
});
