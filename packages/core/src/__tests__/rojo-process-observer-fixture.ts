import childProcess from 'child_process';
import * as path from 'path';
import { jest } from '@jest/globals';

/**
 * Unit-only OS boundary. Parallel Windows Jest workers otherwise each start
 * PowerShell under the production 2s budget. Real native identity observation
 * stays covered by tests/rojo-write-concurrency.mjs, not by this fixture.
 */
export function stubWindowsProcessObserver() {
  if (process.platform !== 'win32') return;
  const original = childProcess.execFileSync;
  const interpreter = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const implementation = ((command: string, ...args: unknown[]) => {
    if (command === interpreter) return '12345';
    return Reflect.apply(original, childProcess, [command, ...args]);
  }) as typeof childProcess.execFileSync;
  return jest.spyOn(childProcess, 'execFileSync').mockImplementation(implementation);
}
