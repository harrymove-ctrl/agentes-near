import { useApprovalRules, useRemoveApprovalRule } from "@agenteschat/client";
import { approvalRuleServer, approvalRuleWords } from "@agenteschat/client/lib/approval-words";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ResourceIcon, useConnectedById } from "@/components/AccessLevels";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Aprovado sempre: what the agent runs without asking, approved for good from a request
 * ("Aprovar sempre"). Shown only when there is something. Admins and the agent's owner take one back with its ×,
 * at once, outside the page's save bar.
 */
export function ApprovalRulesCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, viewer } = useAgentEdit();
  const rules = useApprovalRules(org.id, agent.id);
  const remove = useRemoveApprovalRule(org.id, agent.id);
  const dir = useDirectory(org.id);
  const items = useConnectedById();
  const toast = useToast();
  const list = rules.data ?? [];
  if (list.length === 0) return null;
  const mayRemove = can(org, "approve_actions") || viewer === "owner";
  return (
    <Card as="section" className="agp-card" aria-labelledby="ac-always">
      <CardHead
        id="ac-always"
        icon="shield"
        title={t("agentPage.access.always.title")}
        action={<span className="small muted">{t("agentPage.access.always.help")}</span>}
      />
      <ul className="level-list" aria-label={t("agentPage.access.always.title")}>
        {list.map((rule) => {
          const what = approvalRuleWords(t, rule);
          const who = rule.createdByUserId ? dir.memberById.get(rule.createdByUserId)?.name : undefined;
          const when = relativeTime(t, i18n.language, rule.createdAt);
          return (
            <li key={rule.id} className="level-row ac-mediarow">
              <span className="ac-mediarow__face">
                <ResourceIcon
                  resource={{ connectionId: rule.connectionId, area: rule.connectionId ? null : "sandbox" }}
                  items={items}
                  name={approvalRuleServer(t, rule)}
                />
              </span>
              <span className="ac-mediarow__head">
                <span className="level-row__name">{approvalRuleServer(t, rule)}</span>
              </span>
              <span className="ac-mediarow__body level-row__text">
                <span title={rule.action || rule.tool}>{what}</span>
                <span className="small muted">
                  {who
                    ? t("agentPage.access.always.by", { name: who, when })
                    : t("agentPage.access.always.byNobody", { when })}
                </span>
              </span>
              {mayRemove && (
                <span className="ac-mediarow__end">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon="close"
                    aria-label={t("agentPage.access.always.remove", { what })}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(rule.id, {
                        onSuccess: () => toast.show(t("agentPage.access.always.removed", { name: agent.name })),
                      })
                    }
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
