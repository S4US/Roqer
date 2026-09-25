export type StorageStatus = {
  required: boolean;
  message: string | null;
};

export type WorkspaceExportTarget = { projectId: string; chatId: string };

export function isStorageStatus(value: unknown): value is StorageStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return typeof status.required === "boolean" && (status.message === null || typeof status.message === "string");
}
