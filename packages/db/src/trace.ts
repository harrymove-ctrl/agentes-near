import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Counts SQL statements per unit of work (a run, a request) without touching
 * call sites: Drizzle's logger increments the counter of the current async
 * context. Used for per-run breakdowns and for tests that bound round trips.
 */
export interface QueryTrace {
  count: number;
}

export const queryTrace = new AsyncLocalStorage<QueryTrace>();

/** Statements run by this process since start (tests compare before/after). */
export const queryTotals = { count: 0 };

export const tracingLogger = {
  logQuery() {
    queryTotals.count++;
    const store = queryTrace.getStore();
    if (store) store.count++;
  },
};

/** Runs `fn` with a fresh counter; returns its result and how many statements it ran. */
export async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const store: QueryTrace = { count: 0 };
  const result = await queryTrace.run(store, fn);
  return { result, queries: store.count };
}

/** Current count in this async context (0 outside a traced unit). */
export const currentQueryCount = () => queryTrace.getStore()?.count ?? 0;
