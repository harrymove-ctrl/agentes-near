import { consentErrorParam } from "@agenteschat/client/lib/apps";
import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { AuthorizePage } from "@/pages/AuthorizePage";

/**
 * `/autorizar?req=` (ADR 0119): where an AI app's sign-in lands. Signed out, the person signs in first and comes back
 * with the request. `?erro=` is the server's refusal before there was a request: it shows without signing in.
 */
export const Route = createFileRoute("/autorizar")({
  validateSearch: (search: Record<string, unknown>): { req?: string; erro?: string } => ({
    ...(typeof search.req === "string" && search.req ? { req: search.req.slice(0, 64) } : {}),
    ...(typeof search.erro === "string" ? { erro: search.erro } : {}),
  }),
  beforeLoad: async ({ context, location, search }) => {
    if (search.req && !search.erro) await requireUser(context, location.href);
  },
  component: function Authorize() {
    const { req, erro } = Route.useSearch();
    return (
      <AuthorizePage
        requestId={req ?? ""}
        error={erro === undefined ? null : (consentErrorParam(erro) ?? "indisponivel")}
      />
    );
  },
});
