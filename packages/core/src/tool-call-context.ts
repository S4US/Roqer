import { AsyncLocalStorage } from 'node:async_hooks';

/** Host request lifecycle, never an argument the model or renderer supplies. */
const cancellation = new AsyncLocalStorage<AbortSignal>();
export const toolCallSignal = (): AbortSignal | undefined => cancellation.getStore();
export const withToolCallSignal = <T>(signal: AbortSignal, invoke: () => T): T => cancellation.run(signal, invoke);
