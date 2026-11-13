import { useAuthConfig, useWorkspaceLimits } from "@agenteschat/client";
import { membersFull, membersFullText, membersFullWhoPhone } from "@agenteschat/client/lib/limits";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter } from "@/ui";

/**
 * No one more fits (ADR 0079): who can make room, in the phone's words (no purchase, App Store 3.1.1). Nothing
 * while there is room or no limit.
 */
export function MembersFullNote() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const limits = useWorkspaceLimits(orgId).data;
  const full = membersFull(limits);
  const billingService = Boolean(useAuthConfig().data?.billingUrl);
  if (!full) return null;
  return (
    <GroupedFooter>{`${membersFullText(t, full.members, full.limit)} ${membersFullWhoPhone(t, limits, billingService)}`}</GroupedFooter>
  );
}
