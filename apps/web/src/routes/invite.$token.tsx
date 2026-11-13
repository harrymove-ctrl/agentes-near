import { INVITATION_MAIL_PARAM, invitationMailProof } from "@agenteschat/client/lib/guards";
import { createFileRoute } from "@tanstack/react-router";
import { InvitePage } from "@/pages/InvitePage";

/**
 * The server builds invitation links as `${PUBLIC_URL}/invite/${token}`. `?join=1`: back from a provider's sign-in
 * started on the page, which then accepts by itself for the invited address (ADR 0090). `?mail=`: the proof only the
 * invitation's own email puts on its link, which the page passes on so accepting confirms the address.
 */
export const Route = createFileRoute("/invite/$token")({
  validateSearch: (search: Record<string, unknown>): { join?: true; mail?: string } => {
    const mail = invitationMailProof(search[INVITATION_MAIL_PARAM]);
    return {
      ...(search.join === 1 || search.join === "1" || search.join === true ? { join: true as const } : {}),
      ...(mail ? { mail } : {}),
    };
  },
  component: function Invite() {
    const { token } = Route.useParams();
    const { join, mail } = Route.useSearch();
    return <InvitePage token={token} join={join === true} mail={mail} />;
  },
});
