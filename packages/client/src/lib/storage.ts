import type { TFunction } from "i18next";
import type { StorageConfig } from "../api/types";
import { formatBytes } from "./files";
import { keepWhole } from "./format";

/**
 * The line under the storage option in use (Settings › Storage, web and phone): what the workspace keeps there and,
 * where that is a folder on a server of its own, what its disk has left (the server never sends the Cloud's). Null
 * from a server that doesn't say.
 */
export function storageUsageLine(t: TFunction, locale: string, config: StorageConfig): string | null {
  const { usage } = config;
  if (!usage) return null;
  // Whole sizes, so a narrow card breaks the line only after its "·".
  const size = (bytes: number) => keepWhole(formatBytes(locale, bytes));
  const bytes = config.kind === "s3" ? usage.ownBucketBytes : usage.platformBytes;
  const files = bytes > 0 ? t("storage.usage.files", { size: size(bytes) }) : t("storage.usage.none");
  const disk = config.kind === "agentes" ? usage.disk : null;
  return disk ? t("storage.usage.free", { files, size: size(disk.freeBytes) }) : files;
}
