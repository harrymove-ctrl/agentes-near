import { createFileRoute, redirect } from "@tanstack/react-router";

/** Members live in the workspace settings; the old address keeps working. */
export const Route = createFileRoute("/org/$orgId/members")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$orgId/settings/$section", params: { orgId: params.orgId, section: "members" } });
  },
});
