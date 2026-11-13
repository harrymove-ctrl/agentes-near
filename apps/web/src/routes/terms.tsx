import { createFileRoute } from "@tanstack/react-router";
import { legalPage } from "@/app/guards";
import { LegalPage, NoLegalPage } from "@/pages/LegalPage";

/** Terms of Use, public: agentes.chat Cloud's on the Cloud, else this server's own (`legalPage`). */
export const Route = createFileRoute("/terms")({
  loader: ({ context }) => legalPage(context, "terms"),
  component: function Terms() {
    return Route.useLoaderData() ? <LegalPage kind="terms" /> : <NoLegalPage kind="terms" />;
  },
});
