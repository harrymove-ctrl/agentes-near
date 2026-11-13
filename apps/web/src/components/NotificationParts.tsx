import type { AppNotification, NotificationActor } from "@agenteschat/client";
import { appCreatedLine } from "@agenteschat/client/lib/apps";
import { WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { deviceNoticeOf } from "@agenteschat/client/lib/devices";
import { formatUsd, namesText } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  askersOf,
  channelOf,
  runFailedGroupOf,
  widgetNoticeOf,
  workspaceHeadline,
} from "@agenteschat/client/lib/notifications";
import type { Words } from "@agenteschat/client/lib/routine-view";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Avatar, ComputerIcon, cx, Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { DeviceFace, DeviceHeadline } from "@/components/devices/DeviceNotice";
import { useOrg } from "@/components/org-context";
import type { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";

/**
 * A notification's pieces, the same wherever one shows: the inbox (Atividade), Início's "Para você" and the island
 * (ADR 0071 §9). Who did it (a face), and the line saying who did what, where.
 */

export type Dir = ReturnType<typeof useDirectory>;

/** Words from the client's rules (a key and its values) in the person's language; `otherwise` for an unknown key. */
export function sayWords(t: TFunction, w: Words, otherwise = "") {
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
}

export const nameOf = (t: TFunction, dir: Dir, a: NotificationActor | undefined) =>
  !a
    ? ""
    : a.type === "agent"
      ? (dir.anyAgent(a.id)?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(a.id)?.name ?? t("channel.unknownPerson"));

/**
 * Who an accepted invitation brought in (ADR 0090): the directory's name, else the one the notice carries, while
 * the members list catches up with someone who just joined.
 */
export const joinerOf = (t: TFunction, dir: Dir, n: AppNotification) => {
  const a = n.actors[0];
  return (a && dir.memberById.get(a.id)?.name) || n.latest.title || nameOf(t, dir, a);
};

/** A face for an actor: agents are the living symbol, people their photo or initials. */
export function Face({
  actor,
  dir,
  className,
  size = "md",
  state,
  name: given,
}: {
  actor: NotificationActor | undefined;
  dir: Dir;
  className?: string;
  size?: "sm" | "md";
  state?: "idle" | "waiting" | "writing";
  /** The name when the directory may not have it yet (`joinerOf`). */
  name?: string;
}) {
  const { t } = useTranslation();
  if (!actor) return null;
  const name = given ?? nameOf(t, dir, actor);
  if (actor.type === "agent")
    return <AgentAvatar agentId={actor.id} name={name} size={size} state={state} className={className} labelled />;
  return (
    <ActorAvatar actor={{ type: "person", id: actor.id }} name={name} size={size} className={className} labelled />
  );
}

/**
 * Nobody to show, the workspace itself telling (its computer, its standing): what it is about, as an icon. Someone
 * asking to join isn't a member yet: their initials.
 */
export function SystemFace({ n, className = "nt-av24" }: { n: AppNotification; className?: string }) {
  // A board's notice with nobody named: its agent (ADR 0135).
  const widget = widgetNoticeOf(n);
  if (widget?.agentId) return <AgentAvatar agentId={widget.agentId} name="" size="md" className={className} />;
  if (deviceNoticeOf(n)) return <DeviceFace n={n} className={className} />;
  if (n.kind === "join_request") return <Avatar name={askersOf(n).names[0] ?? ""} size="sm" className={className} />;
  if (n.kind === "computer_ready")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <ComputerIcon kind={WORKSPACE_COMPUTER_KIND} size={16} />
      </span>
    );
  if (n.kind === "composio_limit")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <Icon name="plug" size={16} />
      </span>
    );
  if (n.kind === "skill_update")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <Icon name="book" size={16} />
      </span>
    );
  if (n.kind === "computer_disk_full")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <Icon name="drive" size={16} />
      </span>
    );
  if (n.kind === "computer_no_chrome")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <Icon name="globe" size={16} />
      </span>
    );
  if (n.kind === "app_created")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <Icon name="agent" size={16} />
      </span>
    );
  if (n.kind === "usage_limit")
    return (
      <span className={cx("nt-sys", className)} aria-hidden="true">
        <Icon name="wallet" size={16} />
      </span>
    );
  if (n.kind !== "org_standing") return null;
  const status = n.latest.statusTo;
  return (
    <span className={cx("nt-sys", className)} aria-hidden="true">
      <Icon name={status === "active" ? "check" : status === "suspended" ? "block" : "pause"} size={16} />
    </span>
  );
}

type WhatKey =
  | "mention"
  | "mentionIn"
  | "mentionComment"
  | "replied"
  | "repliedThread"
  | "answered"
  | "answeredIn"
  | "dm"
  | "question"
  | "issueAssigned"
  | "issueComment"
  | "issueStatus"
  | "issueDone"
  | "approval"
  | "missionFinished"
  | "missionStopped"
  | "routineFinished"
  | "routineFailed"
  | "runFailed"
  | "runFailedMany"
  | "runFailedManyAny"
  | "routinePaused"
  | "routineStalled"
  | "agentUnreached"
  | "routineWaitingPlan"
  | "planResetUnknown"
  | "catchUpClosed"
  | "catchUpClosedAsker"
  | "catchUpClosedAskerAny"
  | "catchUpClosedAskerTask"
  | "catchUpClosedAskerTaskAny"
  | "machineConnected"
  | "machineConnectedAny"
  | "browserHandoff"
  | "desktopHandoff"
  | "secretRequest"
  | "joinRequest"
  | "joinRequestMany"
  | "browserProfileRequest"
  | "desktopTaken"
  | "planLent"
  | "planModelDropped"
  | "joinSuggestion"
  | "invitationAccepted"
  | "invitationAcceptedAny"
  | "proposalWaiting"
  | "changeRequest"
  | "changeRequestAgent"
  | "usageLimitWarning"
  | "usageLimitReachedSelf"
  | "usageLimitReached"
  | "usageLimitRequest"
  | "usageLimitRaised"
  | "usageLimitRefused"
  | "approvalCover"
  | "approvalCoverDeclined"
  | "approvalCoverEnded"
  | "rightHandDecided"
  | "rightHandPaused"
  | "reaction";

/** The line on top of a row: who did what, where. */
export function Headline({
  n,
  dir,
  channelName,
}: {
  n: AppNotification;
  dir: Dir;
  channelName: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  // A personal workspace (ADR 0159): its computer is its person's agents', and its name ("Personal") says no place.
  const personal = isPersonal(useOrg().org);
  const name = nameOf(t, dir, n.actors[0]);
  const names = namesText(
    t,
    n.actors.map((a) => nameOf(t, dir, a)),
  );
  const count = n.actors.length;
  // A thread without a title is labelled with its channel: show it as "#canal".
  const channel = channelOf(n);
  const label =
    n.source.label && channel && n.source.label === channelName(channel) ? `#${n.source.label}` : n.source.label;
  // Names and titles are typed by people (someone asking to join is not even a member): text, never markup.
  const k = (key: WhatKey, values: Record<string, unknown>) => (
    <Trans i18nKey={`notifications.what.${key}`} values={values} components={{ b: <b /> }} {...TYPED_VALUES} />
  );
  const own = workspaceHeadline(n);
  if (own === "computerSetup.notification.ready" && personal) return t("computerSetup.notification.readyPersonal");
  if (own) return t(own, { name: n.source.label });
  if (n.kind === "app_created") return appCreatedLine(t, n);
  if (deviceNoticeOf(n)) return <DeviceHeadline n={n} dir={dir} />;
  // A board's notice (ADR 0135): the agent who looks after the widget or asks to publish the board.
  const widget = widgetNoticeOf(n);
  if (widget) {
    const agent = widget.agentId ? (dir.anyAgent(widget.agentId)?.name ?? t("channel.unknownAgent")) : name;
    const key =
      widget.kind === "alert"
        ? "widgets.notice.alert"
        : widget.kind === "failed"
          ? "widgets.notice.failed"
          : "widgets.notice.proposal";
    return (
      <Trans i18nKey={key} values={{ name: agent, title: widget.title }} components={{ b: <b /> }} {...TYPED_VALUES} />
    );
  }
  switch (n.kind) {
    case "mention":
      if (n.source.issueId) return k("mentionComment", { name });
      return n.source.threadId && label ? k("mentionIn", { name, label }) : k("mention", { name });
    case "thread_reply":
      return label ? k("replied", { names, label, count }) : k("repliedThread", { names, count });
    case "dm":
      return k("dm", { name });
    case "agent_reply":
      return label ? k("answeredIn", { name, label }) : k("answered", { name });
    case "agent_question":
      return k("question", { name });
    case "issue_assigned":
      return k("issueAssigned", { name });
    case "issue_comment":
      return k("issueComment", { names, count });
    case "issue_status":
      return n.latest.statusTo === "done" ? k("issueDone", { name }) : k("issueStatus", { name });
    case "approval":
      return k("approval", { name });
    case "mission_finished":
      return k("missionFinished", { name });
    case "mission_stopped":
      return k("missionStopped", { name });
    case "routine_finished":
      return k("routineFinished", { name });
    case "routine_failed":
      return k("routineFailed", { name });
    case "run_failed": {
      // Agents that failed for one cause close together: one line for all of them.
      const group = runFailedGroupOf(n);
      if (!group) return k("runFailed", { name });
      return group.cause
        ? k("runFailedMany", { count: group.agents, cause: sayWords(t, group.cause) })
        : k("runFailedManyAny", { count: group.agents });
    }
    case "routine_paused":
      return k("routinePaused", { name });
    case "routine_stalled":
      return k("routineStalled", { name });
    case "agent_unreached":
      return k("agentUnreached", { name });
    case "browser_profile_request":
      return k("browserProfileRequest", { name, agent: n.source.label ?? "" });
    case "desktop_taken": {
      const agent = n.source.label ?? "";
      return k("desktopTaken", { name, agent, context: agentGrammar(agent).context });
    }
    case "plan_lent": {
      const agent = n.source.label ?? "";
      return k("planLent", { name, agent, plan: n.latest.plan ?? "", context: agentGrammar(agent).context });
    }
    case "plan_model_dropped":
      return k("planModelDropped", {
        name,
        model: n.latest.title ?? "",
        plan: n.latest.plan ?? "",
        runs: n.latest.nowModel ?? "",
      });
    case "routine_waiting_plan":
      return k("routineWaitingPlan", { name });
    case "plan_reset_unknown":
      return k("planResetUnknown", { name, plan: n.latest.title ?? "" });
    case "catch_up_closed":
      return k("catchUpClosed", { name, count: n.count });
    case "catch_up_closed_asker": {
      const who = n.latest.title ?? "";
      const task = n.latest.reason === "task_canceled";
      return label
        ? k(task ? "catchUpClosedAskerTask" : "catchUpClosedAsker", { name, label, who })
        : k(task ? "catchUpClosedAskerTaskAny" : "catchUpClosedAskerAny", { name, who });
    }
    case "machine_connected":
      return n.source.label
        ? k("machineConnected", { name, label: n.source.label })
        : k("machineConnectedAny", { name });
    case "browser_handoff":
      return k(n.source.screen === "desktop" ? "desktopHandoff" : "browserHandoff", { name });
    case "secret_request":
      return k("secretRequest", { name });
    case "join_request": {
      // Merged while unread: the first ones to ask, by name, then how many more.
      const asked = askersOf(n);
      // A member's suggestion says who suggested it (ADR 0090); a merged row counts everyone as asking.
      if (asked.total === 1 && n.latest.suggestedBy)
        return k("joinSuggestion", { by: n.latest.suggestedBy, name: asked.names[0] });
      return asked.total > 1
        ? k("joinRequestMany", { names: namesText(t, asked.names, 2, asked.total) })
        : k("joinRequest", { name: asked.names[0] });
    }
    case "invitation_accepted":
      return n.source.label && !personal
        ? k("invitationAccepted", { name: joinerOf(t, dir, n), org: n.source.label })
        : k("invitationAcceptedAny", { name: joinerOf(t, dir, n) });
    case "reaction":
      return k("reaction", { names, count });
    case "proposal_waiting":
      return k("proposalWaiting", { names });
    case "change_request":
      return k(n.source.proposalId ? "changeRequest" : "changeRequestAgent", { name, agent: n.source.label ?? "" });
    case "usage_limit": {
      // The person's own rows say a percent only; who decides reads the amount (ADR 0141).
      const l = n.latest;
      const amount = l.limitUsd !== undefined ? formatUsd(i18n.language, l.limitUsd) : "";
      const percent = Math.round(l.percent ?? 0);
      switch (l.statusTo) {
        case "warning":
          return k("usageLimitWarning", { percent });
        case "reached_notify":
          return k("usageLimitReachedSelf", {});
        case "reached":
          return k("usageLimitReached", { name, amount });
        case "request":
          return k("usageLimitRequest", { name, amount });
        case "raised":
          return k("usageLimitRaised", { name });
        default:
          return k("usageLimitRefused", { name });
      }
    }
    case "right_hand_decided":
      return k("rightHandDecided", { name, count: n.count });
    case "right_hand_paused":
      return k("rightHandPaused", { name });
    case "approval_cover":
      return k(
        n.latest.statusTo === "declined"
          ? "approvalCoverDeclined"
          : n.latest.statusTo === "ended"
            ? "approvalCoverEnded"
            : "approvalCover",
        { name },
      );
  }
}
