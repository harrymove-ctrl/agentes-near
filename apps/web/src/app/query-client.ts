import { ApiError } from "@agenteschat/client";
import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { MutationCache, QueryCache } from "@tanstack/react-query";

/**
 * Queries show their errors inline; a
 * 401 anywhere means the session ended (back to sign-in); every failed write
 * gets a toast in the person's words.
 */
export function createQueryClient(handlers: {
  onUnauthorized: () => void;
  onMutationError: (message: string) => void;
  /** A failed write in the person's words (`errorText`). */
  describeError: (error: unknown) => string;
}) {
  return new LiveQueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) handlers.onUnauthorized();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (error instanceof ApiError && error.status === 401) return handlers.onUnauthorized();
        // Mutations that show their own inline error opt out with `meta: { silent: true }`.
        if (mutation.meta?.silent) return;
        handlers.onMutationError(handlers.describeError(error));
      },
    }),
  });
}
