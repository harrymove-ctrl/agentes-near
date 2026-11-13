import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "@/pages/NewAgentPage";

/**
 * The full form, a focused flow: the org layout leaves the sidebar out while it's open (see `org.$orgId.tsx`). The app
 * creates agents in the new agent's dialog (ADR 0164); this page stays for an agent's proposal (`?proposal=`, ADR
 * 0081: filled in with the draft, on its last step), the import, and a link that still names it. `?channel=` starts
 * the agent in that channel.
 */
export const Route = createFileRoute("/org/$orgId/agents/new")({
  validateSearch: (search: Record<string, unknown>): { proposal?: string; channel?: string } => ({
    proposal: typeof search.proposal === "string" ? search.proposal : undefined,
    channel: typeof search.channel === "string" ? search.channel : undefined,
  }),
  component: function NewAgent() {
    const { proposal, channel } = Route.useSearch();
    return <NewAgentPage proposalId={proposal ?? null} channelId={channel ?? null} />;
  },
});
