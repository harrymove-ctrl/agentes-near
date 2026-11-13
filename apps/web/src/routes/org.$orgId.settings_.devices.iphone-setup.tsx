import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/**
 * `/settings/devices/iphone-setup?computer=<id>`: the link the desktop app's iPhone setup QR carries. The phone app
 * opens its own guide there (an App Link), and a browser shows the same steps in the connect dialog.
 */
export const Route = createFileRoute("/org/$orgId/settings_/devices/iphone-setup")({
  validateSearch: (search: Record<string, unknown>): { computer?: string } => ({
    computer: typeof search.computer === "string" ? search.computer : undefined,
  }),
  component: function IphoneSetupRoute() {
    const { computer } = Route.useSearch();
    return (
      <Main>
        <SettingsPage section="devices" connect={{ step: "iphone", hostId: computer ?? null }} />
      </Main>
    );
  },
});
