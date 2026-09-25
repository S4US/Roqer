/**
 * Encrypts a secret at rest with the operating system's credential store.
 *
 * The Electron main process supplies the real one (`electron/secret-protector.ts`,
 * over `safeStorage`); tests supply their own. Model connection keys and the
 * Open Cloud key are stored through it and never reach the renderer.
 */
export interface SecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
