import { createFileRoute } from "@tanstack/react-router";
import { WikiPage } from "@/pages/WikiPage";

/** One wiki page (`processos/onboarding`, the folder kept in the slug). */
export const Route = createFileRoute("/org/$orgId/wiki_/$slug")({
  component: function Page() {
    const { slug } = Route.useParams();
    return (
      <main className="shell__main shell__main--wiki">
        <WikiPage slug={slug} />
      </main>
    );
  },
});
