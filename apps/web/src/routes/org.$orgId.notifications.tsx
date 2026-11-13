import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { OpeningNotification } from "@/components/NotificationOpen";
import { notificationsSearch } from "@/lib/push-open";
import { NotificationsPage } from "@/pages/NotificationsPage";

/**
 * Notificações: one inbox for everything that involves me. `?open=<id>` opens that notification where the inbox
 * would (a click on a browser notification, ADR 0071), in place of this page.
 */
export const Route = createFileRoute("/org/$orgId/notifications")({
  validateSearch: notificationsSearch,
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const { open } = Route.useSearch();
  return <Main>{open ? <OpeningNotification id={open} /> : <NotificationsPage />}</Main>;
}
