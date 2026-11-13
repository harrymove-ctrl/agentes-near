import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { ThreadsPage } from "@/pages/ThreadsPage";
import { THREAD_TABS, type ThreadsTab } from "@/pages/thread-tabs";

/** Threads: `?tab=`, `?channel=` (from a channel's "Threads (N)") and `?open=` (a thread's details). */
export const Route = createFileRoute("/org/$orgId/threads/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: ThreadsTab; channel?: string; open?: string | number } => ({
    ...openSearch(search),
    ...(THREAD_TABS.includes(search.tab as ThreadsTab) ? { tab: search.tab as ThreadsTab } : {}),
    ...(typeof search.channel === "string" && search.channel ? { channel: search.channel } : {}),
  }),
  component: function Threads() {
    const { tab, channel } = Route.useSearch();
    return (
      <Main>
        <ThreadsPage key={`${tab ?? ""}:${channel ?? ""}`} initialTab={tab} initialChannel={channel} />
      </Main>
    );
  },
});
