import { ACCOUNT_KINDS } from "@agenteschat/client/lib/ai-accounts";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectingPage } from "@/pages/ConnectingPage";

/**
 * `/conectando?kind=claude_code`: what a sign-in's popup shows from the click until the computer gives the provider's
 * address (`lib/popup.ts`). No session needed: it reads nothing.
 */
export const Route = createFileRoute("/conectando")({
  validateSearch: (search: Record<string, unknown>): { kind?: (typeof ACCOUNT_KINDS)[number] } => {
    const kind = ACCOUNT_KINDS.find((k) => k === search.kind);
    return kind ? { kind } : {};
  },
  component: function Connecting() {
    return <ConnectingPage kind={Route.useSearch().kind} />;
  },
});
