import type { SnapshotStorage } from "@agenteschat/client";
import { File, Paths } from "expo-file-system";
import { perServer } from "./server";

/**
 * A server's conversations snapshot (`createSnapshot`) in a file of the app, one per server (ADR 0154): never throws,
 * a failure just means no snapshot. In the cache folder: not backed up, and the system may clear it (the app then
 * loads from the server).
 */
export const snapshotStoreFor = (server: string): SnapshotStorage => {
  const file = () => new File(Paths.cache, `${perServer("chats-snapshot", server)}.json`);
  return {
    read: async () => {
      try {
        const f = file();
        return f.exists ? await f.text() : null;
      } catch {
        return null;
      }
    },
    write: async (value) => {
      try {
        file().write(value);
      } catch {
        // Not saved: the next launch loads from the server.
      }
    },
    remove: async () => {
      try {
        const f = file();
        if (f.exists) f.delete();
      } catch {
        // Ignore.
      }
    },
  };
};
