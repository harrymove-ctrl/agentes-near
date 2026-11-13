import { type InvalidateOptions, type InvalidateQueryFilters, type Query, QueryClient } from "@tanstack/react-query";

/** Queries already set to be read again when their first read lands. */
const waiting = new WeakSet<Query>();

/**
 * A QueryClient whose invalidations hold for a list's first read still in flight. TanStack hands such a read's promise
 * to the refetch an invalidation asks for (it cancels a read only when the query already has data), and that read's
 * answer then clears the invalidation, though the server may have answered before the change: an event landing during
 * a first read was lost until something else read the list again (my own `member.status` while the people loaded left
 * me offline). Here that query is read again once its first read lands.
 */
export class LiveQueryClient extends QueryClient {
  override invalidateQueries(filters?: InvalidateQueryFilters, options?: InvalidateOptions): Promise<void> {
    const cache = this.getQueryCache();
    for (const query of cache.findAll(filters)) {
      if (query.state.fetchStatus === "idle" || query.state.data !== undefined || waiting.has(query)) continue;
      waiting.add(query);
      const off = cache.subscribe((e) => {
        if (e.query !== query || (e.type !== "removed" && query.state.fetchStatus !== "idle")) return;
        off();
        waiting.delete(query);
        if (e.type !== "removed") void super.invalidateQueries({ queryKey: query.queryKey, exact: true });
      });
    }
    return super.invalidateQueries(filters, options);
  }
}
