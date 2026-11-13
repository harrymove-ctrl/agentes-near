import { createFileRoute, redirect } from "@tanstack/react-router";

/** The old address of a computer's page (links in emails and notifications): it is a device's page now. */
export const Route = createFileRoute("/org/$orgId/settings_/computers/$machineId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/org/$orgId/settings/devices/$deviceId",
      params: { orgId: params.orgId, deviceId: params.machineId },
      replace: true,
    });
  },
});
