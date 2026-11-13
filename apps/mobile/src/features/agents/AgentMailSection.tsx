import { type AgentMailbox, useAgentMail, useMailAccounts, useSetAgentMail } from "@agenteschat/client";
import { LEVELS, type Level, nextLevel } from "@agenteschat/client/lib/access-levels";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { defaultPolicy, mailAccessOf, toMailLevel } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";

const toLevel = (l: AgentMailbox["level"]): Level => (l === "read_write" ? "write" : l);

/** One connected mailbox as a row of the agent's "Can use". */
export interface MailboxLine {
  id: string;
  address: string;
  /** Its level in words, the row's value. */
  level: string;
  /** On a mailbox someone else connected: who gives access to it. */
  sub: string | null;
  /** On one's own mailbox: a tap moves the agent to the next level. */
  onPress: (() => void) | null;
  /** On someone else's, for admins and the agent's owner while it has access: take it away. */
  remove: { label: string; busy: boolean; onPress: () => void } | null;
}

/**
 * The agent's access to each connected mailbox (ADR 0038), as rows for its profile's "Can use" (beside its apps,
 * so what it can use is one list). Only who connected a mailbox gives access to it: on their own a tap changes the
 * level; on anyone else's the row says who gives it, and admins and the agent's owner may remove it. Rules stay on
 * the web. None while the mailboxes load, and none asked for while `enabled` is off (who doesn't see the agent's
 * details).
 */
export function useAgentMailboxes(agentId: string, enabled = true): MailboxLine[] {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const org = useOrg().org;
  const dir = useDirectory();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const accounts = useMailAccounts(orgId, enabled);
  const list = (accounts.data ?? []).filter((a) => a.status !== "pending");
  const mail = useAgentMail(orgId, agentId, enabled && list.length > 0);
  const set = useSetAgentMail(orgId);
  if (!enabled || list.length === 0 || !mail.data) return [];
  const managesAgent = can(org, "manage_agents") || (!!meId && agent?.ownerUserId === meId);
  const save = (accountId: string, saved: AgentMailbox | undefined, level: Level) =>
    set.mutate(
      {
        agentId,
        accountId,
        input: {
          level: toMailLevel(level),
          canDelete: level === "none" ? false : (saved?.canDelete ?? false),
          policy: saved?.policy ?? defaultPolicy(),
        },
      },
      { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) },
    );
  return list.map((account): MailboxLine => {
    const saved = mail.data?.find((m) => m.accountId === account.id);
    const level = toLevel(saved?.level ?? "none");
    const may = mailAccessOf(account, { userId: meId, talks: canTalk(agent), managesAgent });
    const owner = account.ownerUserId ? dir.memberById.get(account.ownerUserId)?.name : undefined;
    const theirs = account.ownerUserId !== meId;
    return {
      id: account.id,
      address: account.address,
      level: t(`access.level.${level}`),
      sub: theirs ? (owner ? t("mail.agent.ownerOnly", { name: owner }) : t("mail.agent.ownerOnlyUnknown")) : null,
      onPress: may.gives && !set.isPending ? () => save(account.id, saved, nextLevel({ levels: LEVELS }, level)) : null,
      remove:
        !may.gives && may.removes && level !== "none"
          ? { label: t("mail.agent.remove"), busy: set.isPending, onPress: () => save(account.id, saved, "none") }
          : null,
    };
  });
}
