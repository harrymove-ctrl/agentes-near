import { safeRedirect } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The Mac app's window lands here once the browser handed the sign-in over
 * (ADR 0036): loading it brings the window to the front (main_window.rs), then on to `to`.
 */
export const Route = createFileRoute("/desktop/signed-in")({
  validateSearch: (search: Record<string, unknown>): { to?: string } => ({ to: safeRedirect(search.to) }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: search.to ?? "/" });
  },
});
