import { createFileRoute, redirect } from "@tanstack/react-router";

/** The Portuguese address of the Terms of Use (older links and the phone app) goes to `/terms`. */
export const Route = createFileRoute("/termos")({
  beforeLoad: () => {
    throw redirect({ to: "/terms", replace: true });
  },
});
