import { TOOL_HANDLERS } from '../http-server.js';
import { getAllTools } from '../tools/definitions.js';

/**
 * Every tool handler copies its arguments into a RobloxStudioTools call by
 * hand, for the HTTP bridge and the stdio server alike. A property the schema
 * offers and the handler never passes on is silently ignored, which a model
 * cannot tell from the option having no effect. This changes one property at
 * a time between two well-formed values and checks that the call the handler
 * makes changes with it.
 */

type PropertySchema = { type?: string | string[]; enum?: unknown[]; items?: PropertySchema };

/** Two different, well-formed values for one property. */
function samples(name: string, schema: PropertySchema): [unknown, unknown] {
  // The handlers parse these themselves, so the values must be ones they accept.
  if (name === 'line_range') return ['1-1', '2-2'];
  if (Array.isArray(schema.enum) && schema.enum.length > 1) return [schema.enum[0], schema.enum[1]];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'number':
    case 'integer':
      return [1, 2];
    case 'boolean':
      return [true, false];
    case 'array': {
      const [first, second] = samples(`${name}[]`, schema.items ?? {});
      return [[first], [second]];
    }
    case 'object':
      return [{ probe: 1 }, { probe: 2 }];
    default:
      return [`${name}-a`, `${name}-b`];
  }
}

/** Every tools method a handler calls for `body`, with its arguments, or the error it raises. */
async function callsFor(tool: string, body: Record<string, unknown>): Promise<string> {
  const calls: unknown[] = [];
  const recorder = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      calls.push([String(method), args]);
      return Promise.resolve(undefined);
    },
  });
  try {
    await TOOL_HANDLERS[tool](recorder as never, body);
  } catch (error) {
    calls.push(['threw', error instanceof Error ? error.message : String(error)]);
  }
  return JSON.stringify(calls);
}

describe('tool handlers pass on every argument their schema offers', () => {
  for (const tool of getAllTools()) {
    const properties = (tool.inputSchema as { properties?: Record<string, PropertySchema> }).properties ?? {};

    test(tool.name, async () => {
      const base = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, samples(name, schema)[0]]),
      );
      const baseCalls = await callsFor(tool.name, base);
      expect(baseCalls).not.toContain('"threw"');

      const ignored: string[] = [];
      for (const [name, schema] of Object.entries(properties)) {
        const changed = { ...base, [name]: samples(name, schema)[1] };
        if (await callsFor(tool.name, changed) === baseCalls) ignored.push(name);
      }
      expect(ignored).toEqual([]);
    });
  }
});
