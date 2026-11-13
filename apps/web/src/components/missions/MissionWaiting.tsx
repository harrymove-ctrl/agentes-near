import type { Mission, MissionCommand } from "@agenteschat/client";
import { useMissionCommands, useMissionDecisions, useMissionList, useMissionReviews } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Chip, GroupHeading, type IconName } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ExecutorChip } from "./MissionBits";
import { MissionCommandCard } from "./MissionCommandCard";
import "./missions.css";

/**
 * Aprovações, for missions (ADR 0029): the executor's pending commands
 * ("Claude Code quer rodar `cmd`", with the mission, its agent, who programs
 * and where, and the same Aprovar / Recusar / Aprovar sempre as in the
 * thread), and "Esperando você em missões": the decisions and reviews that
 * wait on you, each a link to its card in the thread. Only missions you own
 * or decide in (`status=waiting_you`); live through the mission events
 * (`mission.needs_you` reaches you in any channel). Drawn in the Approvals
 * screen's own language: request cards and rows.
 */
export function useMissionsWaitingYou() {
  const { org } = useOrg();
  const list = useMissionList(org.id, { status: "waiting_you", limit: 50 });
  const missions: Mission[] = (list.data?.missions ?? []).filter((m) => m.canAct);
  return { list, missions };
}

/** How many command cards wait on me across missions (counted with the requests waiting for you). */
export const pendingCommandCount = (missions: Mission[]) => missions.reduce((n, m) => n + m.pending.commands, 0);

/** Missions with a decision or review waiting on you. */
export const missionsWaiting = (missions: Mission[]) =>
  missions.filter((m) => m.pending.decisions + m.pending.provisional + m.pending.reviews > 0);

/** The search box: a mission matches by its title, a command by its text too. */
const hit = (query: string, ...texts: string[]) => !query || texts.join(" ").toLowerCase().includes(query);

export function MissionCommandsPending({ missions, query = "" }: { missions: Mission[]; query?: string }) {
  const { t } = useTranslation();
  const asking = missions.filter((m) => m.pending.commands > 0);
  if (asking.length === 0) return null;
  return (
    <section className="ap-mi" aria-label={t("approvals.missions.commands")}>
      <GroupHeading title={t("approvals.missions.commands")} count={pendingCommandCount(asking)} />
      <div className="ap-cards">
        {asking.map((m) => (
          <MissionCommands key={m.id} mission={m} query={query} />
        ))}
      </div>
    </section>
  );
}

/** One request card per pending command: the agent, its mission and who programs, then the command card itself. */
function MissionCommands({ mission: m, query }: { mission: Mission; query: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const commands = useMissionCommands(org.id, m.id);
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  const pending: MissionCommand[] = (commands.data?.commands ?? []).filter(
    (c) => c.state === "pending" && hit(query, c.command, m.title, agentName),
  );
  return (
    <>
      {pending.map((c) => (
        <article key={c.id} className="ap-card ap-mi-cmd" tabIndex={-1} aria-label={c.command}>
          <span className="ap-card__face">
            <AgentAvatar agentId={m.agentId} name={agentName} size="md" state="waiting" />
          </span>
          <div className="ap-card__meta">
            <b>{agentName}</b>
            <span>·</span>
            <Link
              to="/org/$orgId/threads/$threadId"
              params={{ orgId: org.id, threadId: m.threadId }}
              className="ap-mi__mission"
            >
              {m.title}
            </Link>
            <span>· {relativeTime(t, i18n.language, c.createdAt)}</span>
            <span className="ap-grow" />
            {m.machine && <ExecutorChip mission={m} agentName={agentName} />}
          </div>
          <div className="ap-card__body">
            <MissionCommandCard
              command={{ id: c.id, missionId: m.id, taskId: c.taskId, tool: c.tool, command: c.command }}
            />
          </div>
        </article>
      ))}
    </>
  );
}

/** "Esperando você em missões": one row per pending decision or review, linking to its card. */
export function MissionsWaitingList({ missions, query = "" }: { missions: Mission[]; query?: string }) {
  const { t } = useTranslation();
  const waiting = missionsWaiting(missions);
  if (waiting.length === 0) return null;
  return (
    <section className="ap-mi" aria-label={t("approvals.missions.waiting")}>
      <GroupHeading title={t("approvals.missions.waiting")} />
      <ul className="list-card ap-mi__list">
        {waiting.map((m) => (
          <MissionWaitingRows key={m.id} mission={m} query={query} />
        ))}
      </ul>
    </section>
  );
}

function MissionWaitingRows({ mission: m, query }: { mission: Mission; query: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  const decisions = useMissionDecisions(org.id, m.pending.decisions + m.pending.provisional > 0 ? m.id : null);
  const reviews = useMissionReviews(org.id, m.pending.reviews > 0 ? m.id : null);
  const rows: { key: string; icon: IconName; kind: string; text: string; messageId: string | null; at: string }[] = [
    ...(decisions.data ?? [])
      .filter((d) => d.status !== "taken")
      .map((d) => ({
        key: `d:${d.id}`,
        icon: "waiting" as IconName,
        kind: d.status === "provisional" ? t("approvals.missions.provisional") : t("approvals.missions.decision"),
        text: d.question,
        messageId: d.messageId,
        at: d.createdAt,
      })),
    ...(reviews.data ?? [])
      .filter((r) => r.status === "pending")
      .map((r) => ({
        key: `r:${r.id}`,
        icon: "checks" as IconName,
        kind: t("approvals.missions.review"),
        text: r.title,
        messageId: r.messageId,
        at: r.createdAt,
      })),
  ].filter((row) => hit(query, row.text, m.title, agentName));
  return (
    <>
      {rows.map((row) => (
        <li key={row.key} className="ap-row ap-mi__row ac-mediarow ac-mediarow--row">
          <span className="ac-mediarow__face">
            <AgentAvatar agentId={m.agentId} name={agentName} size="sm" state="waiting" />
          </span>
          <span className="ac-mediarow__head">
            <b>{row.text}</b>
          </span>
          <span className="ac-mediarow__body ap-row__sub">
            {m.title} · {relativeTime(t, i18n.language, row.at)}
          </span>
          <div className="ap-row__end ac-mediarow__end ac-mediarow__end--wrap">
            <Chip icon={row.icon}>{row.kind}</Chip>
            <Link
              to="/org/$orgId/threads/$threadId"
              params={{ orgId: org.id, threadId: m.threadId }}
              search={row.messageId ? { m: row.messageId } : {}}
              className="ac-btn ac-btn--sm"
            >
              {t("approvals.missions.open")}
            </Link>
          </div>
        </li>
      ))}
    </>
  );
}
