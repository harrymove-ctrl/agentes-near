import type { OutboxStorage } from "@agenteschat/client";
import { File, Paths } from "expo-file-system";
import { perServer } from "./server";

/**
 * My messages waiting for the connection on a server (the shared `outbox`), kept when the system closes the app, one
 * file per server (ADR 0154: a message goes to the server it was written on): never throws. In the app's own documents
 * (not the cache, which the system may clear).
 */
export const outboxStoreFor = (server: string): OutboxStorage => {
  const file = () => new File(Paths.document, `${perServer("outbox", server)}.json`);
  return {
    read: () => {
      try {
        const f = file();
        return f.exists ? f.textSync() : null;
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        file().writeSync(value);
      } catch {
        // Not kept: it still goes out while the app stays open.
      }
    },
  };
};
