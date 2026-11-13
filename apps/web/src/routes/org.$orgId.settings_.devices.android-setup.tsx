import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/**
 * `/settings/devices/android-setup?computer=<id>`: the link the Android QR carries. The phone app opens its own guide
 * there (an App Link), and a browser shows the same steps in the connect dialog.
 */
export const Route = createFileRoute("/org/$orgId/settings_/devices/android-setup")({
  validateSearch: (search: Record<string, unknown>): { computer?: string } => ({
    computer: typeof search.computer === "string" ? search.computer : undefined,
  }),
  component: function AndroidSetupRoute() {
    const { computer } = Route.useSearch();
    return (
      <Main>
        <SettingsPage section="devices" connect={{ step: "android", hostId: computer ?? null }} />
      </Main>
    );
  },
});
