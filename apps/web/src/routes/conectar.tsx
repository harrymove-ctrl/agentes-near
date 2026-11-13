import { normalizeUserCode } from "@agenteschat/client/lib/machines";
import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { ConnectPage } from "@/pages/ConnectPage";

/**
 * `/conectar?code=K7Q4ZP` (ADR 0036 §5): the link a computer shows. Signed out,
 * the person signs in first and comes back here with the code.
 */
export const Route = createFileRoute("/conectar")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    const code = typeof search.code === "string" ? normalizeUserCode(search.code) : "";
    return code ? { code } : {};
  },
  beforeLoad: ({ context, location }) => requireUser(context, location.href),
  component: function Connect() {
    return <ConnectPage code={Route.useSearch().code ?? ""} />;
  },
});
