import { createFileRoute } from "@tanstack/react-router";
import { legalPage } from "@/app/guards";
import { LegalPage, NoLegalPage } from "@/pages/LegalPage";

/** Privacy Policy, public: agentes.chat Cloud's on the Cloud, else this server's own (`legalPage`). */
export const Route = createFileRoute("/privacy")({
  loader: ({ context }) => legalPage(context, "privacy"),
  component: function Privacy() {
    return Route.useLoaderData() ? <LegalPage kind="privacy" /> : <NoLegalPage kind="privacy" />;
  },
});
