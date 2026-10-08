import { describe, expect, test } from '@jest/globals';
import { parseInstancePath } from '../rojo/instance-path.js';

describe('parseInstancePath', () => {
  test('simple segments', () => {
    expect(parseInstancePath('game.ServerScriptService.Main')).toEqual(['ServerScriptService', 'Main']);
  });
  test('quoted segments with spaces, dots and escapes', () => {
    expect(parseInstancePath('game.Workspace["My Model"]["a.b"]["q\\"uote\\\\"]'))
      .toEqual(['Workspace', 'My Model', 'a.b', 'q"uote\\']);
  });
  test('keywords are quoted by the plugin and parsed back', () => {
    expect(parseInstancePath('game.ReplicatedStorage["end"]')).toEqual(['ReplicatedStorage', 'end']);
  });
  test('game alone is the root', () => {
    expect(parseInstancePath('game')).toEqual([]);
  });
  test.each(['', 'Workspace.Main', 'game.', 'game["unterminated', 'game..A', 'game["a"]b'])('rejects %p', (bad) => {
    expect(parseInstancePath(bad)).toBeUndefined();
  });
});
