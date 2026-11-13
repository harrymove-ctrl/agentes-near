import { createFileRoute, redirect } from "@tanstack/react-router";

/** Workspace `/org/$orgId/updates` forwards cleanly to the full-bleed `/updates` changelog page. */
export const Route = createFileRoute("/org/$orgId/updates")({
  beforeLoad: () => {
    throw redirect({ to: "/updates" });
  },
});
