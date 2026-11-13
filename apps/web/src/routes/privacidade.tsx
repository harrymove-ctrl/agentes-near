import { createFileRoute, redirect } from "@tanstack/react-router";

/** The Portuguese address of the Privacy Policy (older links and the phone app) goes to `/privacy`. */
export const Route = createFileRoute("/privacidade")({
  beforeLoad: () => {
    throw redirect({ to: "/privacy", replace: true });
  },
});
