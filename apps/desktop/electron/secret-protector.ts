import { safeStorage } from "electron";

import type { SecretProtector } from "../runtime/secret-protector";

/** Electron adapter kept out of the testable runtime and renderer contracts. */
export const electronSecretProtector: SecretProtector = {
  isEncryptionAvailable: () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
  },
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
};
