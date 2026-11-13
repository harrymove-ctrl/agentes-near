import type { AppNotification } from "@agenteschat/client";
import { appCreatedLine } from "@agenteschat/client/lib/apps";
import { formatUsd } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { restrictionOf, workspaceHeadline } from "@agenteschat/client/lib/notifications";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { isDashboardNotice } from "../dashboards/logic";
import { deviceNoticeOf, deviceNoticeTitle } from "../devices/logic";
import { useNoticePerson } from "../devices/notices";
import { useDirectory } from "../shared/hooks";
import { runFailedLines, whoOf } from "./logic";

/** Stands in for the names in the translated title, so they can be drawn bold. */
const NAMES = "⁣names⁣";

/**
 * Who did what, as Atividade and the island (ADR 0071 §9) say it: the sentence's pieces around the names (drawn
 * bold between them), the names, and the whole sentence (for VoiceOver). With a restriction on agentes.chat Cloud
 * or several agents' failures of one cause, what goes under it too.
 */
export function useNoticeTitle(n: AppNotification) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  // A restriction on agentes.chat Cloud: its whole line under the headline, and a held agent's name heads it.
  const restriction = restrictionOf(n);
  const held = restriction?.code === "agent.paused";
  const who = whoOf(n.actors, (a) => dir.nameOf({ type: a.type === "agent" ? "agent" : "person", id: a.id }));
  const names = held
    ? (n.source.label ?? "")
    : who.second
      ? who.more > 0
        ? t("mobile.names.more", { first: who.first, second: who.second, count: who.more })
        : t("mobile.names.two", { first: who.first, second: who.second })
      : who.first;
  const kind =
    n.kind === "browser_handoff" && n.source.screen === "desktop"
      ? "desktop_handoff"
      : n.kind === "catch_up_closed_asker" && n.latest.reason === "task_canceled"
        ? "catch_up_closed_asker_task"
        : n.kind === "usage_limit"
          ? `usage_limit_${n.latest.statusTo ?? "refused"}`
          : n.kind === "approval_cover" && (n.latest.statusTo === "declined" || n.latest.statusTo === "ended")
            ? `approval_cover_${n.latest.statusTo}`
            : n.kind;
  const device = deviceNoticeOf(n);
  const person = useNoticePerson(n);
  const orgName = useOrg().org?.name ?? "";
  // A widget's alert or failure, an agent asking to publish a dashboard (ADR 0135): the dashboards' own words.
  const template = held
    ? t("standing.notification.agentHold", { name: NAMES })
    : device
      ? deviceNoticeTitle(t, device, NAMES, person, orgName)
      : n.kind === "app_created"
        ? appCreatedLine(t, n)
        : isDashboardNotice(n.kind)
          ? t(`mobile.dashboards.notice.${n.kind}`, { names: NAMES, count: who.total, defaultValue: NAMES })
          : n.kind === "skill_update"
            ? t(workspaceHeadline(n) ?? "skills.notice.updated", { name: n.source.label ?? "" })
            : t(`mobile.activity.kind.${kind}`, {
                names: NAMES,
                // `catch_up_closed`: the conversations it skipped.
                count: n.kind === "catch_up_closed" ? n.count : who.total,
                // `plan_reset_unknown`: the plan's name (`plan_lent`, `plan_model_dropped`: in `plan`).
                plan:
                  (n.kind === "plan_lent" || n.kind === "plan_model_dropped" ? n.latest.plan : n.latest.title) ?? "",
                // `plan_model_dropped`: the model that left the plan's list and what runs now.
                model: n.latest.title ?? "",
                runs: n.latest.nowModel ?? "",
                // `catch_up_closed_asker`: who was credited.
                who: n.latest.title ?? "",
                // `usage_limit`: the limit (who decides only) and the share used.
                amount: n.latest.limitUsd !== undefined ? formatUsd(i18n.language, n.latest.limitUsd) : "",
                percent: Math.round(n.latest.percent ?? 0),
                // `desktop_taken`: whose computer, said with its name's gender; `plan_lent`: the agent given the plan.
                ...(n.kind === "desktop_taken" || n.kind === "plan_lent"
                  ? { agent: n.source.label ?? "", context: agentGrammar(n.source.label ?? "").context }
                  : {}),
                defaultValue: NAMES,
              });
  // Agents that failed for one cause close together: one line for all, who they are under it.
  const failed = runFailedLines(t, n, (id) => dir.nameOf({ type: "agent", id }));
  const parts = failed ? [failed.title] : template.split(NAMES);
  const title = parts.join(names);
  return { parts, names, title, restriction, failed };
}
