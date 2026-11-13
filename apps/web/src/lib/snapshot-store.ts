import type { SnapshotStorage } from "@agenteschat/client";

const DB = "agentes";
const STORE = "snapshot";
const KEY = "chats";

/** One IndexedDB connection, opened on first use (null where IndexedDB is blocked: private mode, old browsers). */
let db: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return db;
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const conn = await open();
  if (!conn) return null;
  return new Promise((resolve) => {
    try {
      const req = op(conn.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** The conversations snapshot (`createSnapshot`) in IndexedDB: never throws, a failure just means no snapshot. */
export const snapshotStore: SnapshotStorage = {
  read: async () => {
    const value = await run<unknown>("readonly", (s) => s.get(KEY));
    return typeof value === "string" ? value : null;
  },
  write: async (value) => {
    await run("readwrite", (s) => s.put(value, KEY));
  },
  remove: async () => {
    await run("readwrite", (s) => s.delete(KEY));
  },
};
