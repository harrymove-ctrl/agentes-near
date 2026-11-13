import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/** Settings › Devices › one computer. */
export const Route = createFileRoute("/org/$orgId/settings_/devices/$deviceId")({
  component: function ComputerRoute() {
    const { deviceId } = Route.useParams();
    return (
      <Main>
        <SettingsPage section="devices" device={deviceId} />
      </Main>
    );
  },
});
