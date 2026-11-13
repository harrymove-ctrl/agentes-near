import { createFileRoute } from "@tanstack/react-router";
import { DesktopConnectorPage } from "@/pages/DesktopConnectorPage";

const text = (value: unknown) => (typeof value === "string" && value.length <= 2000 ? value : undefined);

/**
 * The app's window, opened by the app with what a connector's provider sent back to the browser
 * (`agenteschat://desktop/connectors/oauth`, deep_link.rs): it finishes the connection with the window's session.
 */
export const Route = createFileRoute("/desktop/connector")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { org?: string; state?: string; code?: string; error?: string } => ({
    org: text(search.org),
    state: text(search.state),
    code: text(search.code),
    error: text(search.error),
  }),
  component: function DesktopConnector() {
    return <DesktopConnectorPage {...Route.useSearch()} />;
  },
});
