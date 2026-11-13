import { safeRedirect } from "@agenteschat/client/lib/guards";
import { createFileRoute } from "@tanstack/react-router";
import { DesktopHandoverPage } from "@/pages/DesktopHandoverPage";

/**
 * The app's window, opened on this server by a connect link with a one-time sign-in from another device
 * (`agenteschat://connect?server=…&token=…`): the token comes in the fragment, which never reaches a server.
 */
export const Route = createFileRoute("/desktop/handover")({
  validateSearch: (search: Record<string, unknown>): { to?: string } => ({ to: safeRedirect(search.to) }),
  component: function DesktopHandover() {
    const { to } = Route.useSearch();
    return <DesktopHandoverPage to={to} />;
  },
});
