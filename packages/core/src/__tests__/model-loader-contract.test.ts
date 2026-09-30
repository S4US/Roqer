import * as fs from 'fs';
import * as path from 'path';
import { LOADER_PACE, MAX_GROUND_SPEED, MODEL_STATES } from '../animation/animation-tool.js';

/**
 * The model loader's code lives in the plugin (MODEL_LOADER_SOURCE in
 * studio-plugin/src/modules/handlers/AnimationHandlers.ts), while `wire`
 * validates what it is given, and `verify` judges what it plays, by core's
 * constants. The repository runs no Luau, so its behaviour is the live
 * animation suite's to check; this keeps the two sides of the contract in
 * step: the pace verify expects is the loader's own, the loader plays the
 * states wire sets, and the plugin caps a ground speed where core does.
 */

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

const HANDLERS = fs.readFileSync(path.join(repositoryRoot(), 'studio-plugin/src/modules/handlers/AnimationHandlers.ts'), 'utf8');

function loaderSource(): string {
  const match = /const MODEL_LOADER_SOURCE = `([\s\S]*?)`;/.exec(HANDLERS);
  if (!match) throw new Error('MODEL_LOADER_SOURCE was not found in the plugin');
  return match[1];
}

test('the loader paces a gait within the limits verify judges it by', () => {
  expect(loaderSource()).toContain(`\nlocal SLOWEST, FASTEST = ${LOADER_PACE.slowest}, ${LOADER_PACE.fastest}\n`);
});

test('the loader plays the states wire sets, and no others', () => {
  const priorities = /\nlocal PRIORITY = \{([\s\S]*?)\n\}/.exec(loaderSource())?.[1] ?? '';
  const states = [...priorities.matchAll(/^\s*(\w+) = Enum\.AnimationPriority\.\w+,$/gm)].map((match) => match[1]);
  expect(states).toEqual([...MODEL_STATES]);
  expect(HANDLERS).toContain(`const MODEL_STATES = [${MODEL_STATES.map((state) => `"${state}"`).join(', ')}];`);
});

test('the plugin caps a ground speed where core does', () => {
  expect(HANDLERS).toContain(`const MAX_GROUND_SPEED = ${MAX_GROUND_SPEED};`);
});

test('the loader is written exactly as the plugin compares it', () => {
  // A substitution or an escape would make the Script's Source differ from
  // the text it is compared with, so every loader would read as edited.
  const source = loaderSource();
  expect(source).not.toContain('${');
  expect(source).not.toContain('\\');
  expect(source.startsWith('-- Built by Roqer (RoqerModelAnimate 1).')).toBe(true);
});
