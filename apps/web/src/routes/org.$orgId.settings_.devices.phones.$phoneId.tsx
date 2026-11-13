import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/** Settings › Devices › one phone. */
export const Route = createFileRoute("/org/$orgId/settings_/devices/phones/$phoneId")({
  component: function PhoneRoute() {
    const { phoneId } = Route.useParams();
    return (
      <Main>
        <SettingsPage section="devices" device={`phones/${phoneId}`} />
      </Main>
    );
  },
});
