import { dateOnly, toYmd } from "@agenteschat/client/lib/format";
import { createFileRoute } from "@tanstack/react-router";
import { openSearch } from "@/lib/open-param";
import { CalendarPage } from "@/pages/CalendarPage";

/** Calendário; `?open={eventId}&day={YYYY-MM-DD}` (an invitation's email) opens that event on its week. */
export const Route = createFileRoute("/org/$orgId/calendar")({
  validateSearch: (search: Record<string, unknown>): { open?: string | number; day?: string } => ({
    ...openSearch(search),
    // Only a day that exists ("2026-13-45" is an invalid date). Undefined, not left out: the router keeps a raw
    // value that the check leaves out.
    day: typeof search.day === "string" && toYmd(dateOnly(search.day)) === search.day ? search.day : undefined,
  }),
  component: () => (
    <main className="shell__main shell__main--chat">
      <CalendarPage day={Route.useSearch().day} />
    </main>
  ),
});
