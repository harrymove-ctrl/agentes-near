import { useSyncExternalStore } from "react";

/**
 * A remembered list of keys seen once (a one-time "Novo"), read and written through each app's own synchronous
 * storage, that every screen showing it hears change: marking it seen anywhere clears it everywhere at once.
 */
export function seenList(read: () => string | null, write: (value: string) => void) {
  const listeners = new Set<() => void>();
  const current = (): string[] => {
    try {
      const v: unknown = JSON.parse(read() ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    mark(key: string) {
      const list = current();
      if (list.includes(key)) return;
      write(JSON.stringify([...list, key]));
      for (const listener of listeners) listener();
    },
    /** Not seen yet. */
    useFresh: (key: string) => useSyncExternalStore(subscribe, () => !current().includes(key)),
  };
}
