import { can } from "@agenteschat/client/lib/permissions";
import { Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { MyUsage, PeopleTab } from "@/components/PeopleUsage";

/**
 * Equipe › Governança e uso (ADR 0148): Settings' Uso › Pessoas (ADR 0141) where the team is, the same component and
 * data (each person's use, the limits, what they do now); members see their own month. Settings keeps it too.
 */
export function TeamUsage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <section className="team-usage" aria-label={t("team.view.usage")}>
      <p className="team-usage__lead muted">
        {t("team.usage.lead")}{" "}
        <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "usage" }} className="ac-link">
          {t("team.usage.settings")}
          <Icon name="arrowRight" size={14} />
        </Link>
      </p>
      {can(org, "view_usage") ? <PeopleTab /> : <MyUsage />}
    </section>
  );
}
