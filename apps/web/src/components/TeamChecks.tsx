import type { Message, TeamCheck } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { targetKind, teamChecksOf } from "@agenteschat/client/lib/team-checks";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Icon, type IconName } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "./org-context";
import "./agent-actions.css";

const ICONS: Record<ReturnType<typeof targetKind>, IconName> = {
  email: "mail",
  phone: "phone",
  code: "pullRequest",
  url: "globe",
  other: "repeat",
};

/**
 * Team actions (ADR 0064): under an agent's reply, what it didn't do because
 * the team already had (the same address, number, page or pull request), and
 * whose action it found, with Ver where it happened. Same rows as the receipts
 * (agent-actions.css); nothing to undo, so no button but Ver.
 */
export function TeamChecks({ message }: { message: Message }) {
  const { t } = useTranslation();
  const list = teamChecksOf(message.meta);
  if (message.author.type !== "agent" || list.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcs ag-rcs--stack" role="group" aria-label={t("teamChecks.group")}>
      {list.map((c) => (
        <TeamCheckRow key={c.id} check={c} selfId={message.author.id} />
      ))}
    </div>
  );
}

function TeamCheckRow({ check, selfId }: { check: TeamCheck; selfId: string | null }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const match = check.matches[0];
  const target = check.targets[0] ?? "";
  if (!match) return null;
  const when = relativeTime(t, i18n.language, match.at);
  const values = { target, when, who: match.agentName ?? "" };
  // Whoever it was can't be shown: a personal workspace (ADR 0159) has no team to name.
  const key = !match.agentId
    ? modeKey(org, "teamChecks.someone")
    : match.agentId === selfId
      ? "teamChecks.self"
      : "teamChecks.teammate";
  const detail = [match.summary, match.channelName ? t("teamChecks.inChannel", { channel: match.channelName }) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="ag-rc">
      <span className="ag-rc__ic" aria-hidden="true">
        <Icon name={ICONS[targetKind(target)]} size={16} />
      </span>
      <span className="ac-actline">
        <span className="ag-rc__tx">
          <span className="ag-rc__sentence" title={check.targets.join(", ")}>
            <Trans i18nKey={key as "teamChecks.teammate"} values={values} components={{ b: <b /> }} />
          </span>
          {detail && <span className="ag-rc__by">{detail}</span>}
        </span>
        {match.channelId && (
          <Link
            to="/org/$orgId/c/$channelId"
            params={{ orgId: org.id, channelId: match.channelId }}
            className="ag-rc__btn"
          >
            {t("teamChecks.open")}
          </Link>
        )}
      </span>
    </div>
  );
}
