/**
 * Push notification text (ADR 0035). The one documented exception to "server
 * strings in English": the phone shows it as is, so it is written in the
 * device's language (pt-BR or en, from the locale the app registered).
 *
 * Short and friendly. Never internal names (the router's or the judge's
 * model, vendors, tools): only the agent's or the person's own name and what
 * they wrote. A high-risk approval only says to open the app: it is never
 * approved from the notification.
 */

import { type AppLocale, appLocale } from "@agenteschat/i18n/locale";
import { pushStrings } from "./push/messages";

export type PushLocale = AppLocale;
export { pushStrings };

export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 180;

/** The first language of the app among these tags (`pt_PT` → pt-BR, `ja-JP` → ja), else English. */
export function pushLocale(...tags: (string | null | undefined)[]): PushLocale {
  return appLocale(tags, true) ?? "en";
}

export interface PushTextInput {
  /** Notification kind. */
  kind: string;
  /** In "Esperando você". */
  waiting: boolean;
  /** Who did it: the agent's or the person's name. */
  actorName?: string | null;
  actorType?: "user" | "agent" | null;
  /** Channel, thread, topic, mission or routine name. */
  label?: string | null;
  /** Title of the thing (approval, mission, routine, topic). */
  title?: string | null;
  /** `join_request` from a member's suggestion (ADR 0090): who suggested. */
  suggestedBy?: string | null;
  /** Snippet of what was said. */
  text?: string | null;
  /** A GIF or a sticker with no words (ADR 0091), or a voice message (ADR 0100): the push says so in place of the snippet. */
  media?: "gif" | "sticker" | "voice" | null;
  /** An approval of a production, irreversible or external action. */
  highRisk?: boolean;
  /** The routine that asked for an approval while nobody watched (ADR 0053 §8): the push says so. */
  routine?: string | null;
  /** `browser_handoff`: the agent's screen it is on, when not its browser. */
  screen?: string | null;
  /** `browser_handoff` still unanswered an hour later: the title says the agent still needs them. */
  reminder?: boolean;
  /** `usage_limit`: what happened (`latest.statusTo`) and the share of the limit used. */
  status?: string | null;
  percent?: number | null;
  /** `widget_failed`: its coded reason (ADR 0135 §6); `agent_reported` sends the agent's words in `text`. */
  reason?: string | null;
  /** The workspace is personal (ADR 0159): the words for one person and their agents, where a team's would differ. */
  personal?: boolean;
}

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** Title and body of one push, in the device's language. */
export function renderPush(locale: PushLocale, input: PushTextInput): { title: string; body: string } {
  const s = pushStrings(locale);
  const actor = input.actorName?.trim() || (input.actorType === "agent" ? s.anAgent : s.someone);
  // A GIF or a sticker alone (ADR 0091) says what it was where its words would go.
  const sent = input.media ? { gif: s.sentGif, sticker: s.sentSticker, voice: s.sentVoice }[input.media] : "";
  const text = input.text?.trim() || sent;
  const what = input.title?.trim() || input.label?.trim() || "";
  const out = (title: string, body: string) => ({
    title: clip(title, PUSH_TITLE_MAX),
    body: clip(body, PUSH_BODY_MAX),
  });
  switch (input.kind) {
    case "approval": {
      // Asked by a routine while nobody watched: its name leads, so the person knows where it comes from.
      const routine = input.routine?.trim();
      const from = (body: string) => (routine ? `${s.approvalFromRoutine(routine)}: ${body}` : body);
      // Its title is the tool's, in English: the apps word it (`approvalTitle`), a push in another language can't.
      const asked = locale === "en" ? what : "";
      // High risk and no title to show: the warning alone.
      if (input.highRisk)
        return out(s.approvalTitle(actor), from(asked ? s.approvalHighRisk(clip(asked, 120)) : s.approvalHighRiskBody));
      return out(s.approvalTitle(actor), from(asked || s.approvalBody));
    }
    case "agent_question":
      return out(s.questionTitle(actor), text || s.questionBody);
    case "mention":
      return out(s.mentionTitle(actor), text || s.openBody);
    case "dm":
      return out(actor, text || s.openBody);
    case "agent_reply":
      // What it answered, from its first words: the person asked and closed the tab.
      return out(s.replyTitle(actor), text || s.openBody);
    case "mission_stopped":
      // Only its name: the reason it stopped may carry technical details.
      return out(s.missionStoppedTitle, what || s.openBody);
    case "routine_failed":
      return out(s.routineFailedTitle, what || s.routineFailedBody);
    case "run_failed":
      return out(s.runFailedTitle(actor), s.routineFailedBody);
    case "routine_paused":
      // Its name only: the app says why, in the person's words.
      return out(s.routinePausedTitle, what || s.routinePausedBody);
    case "right_hand_paused":
      // The right hand's name (what the workspace calls it).
      return out(s.rightHandPausedTitle(actor), s.rightHandPausedBody);
    case "agent_unreached":
      return out(
        s.agentUnreachedTitle(actor),
        what || (input.personal ? s.agentUnreachedBodyPersonal : s.agentUnreachedBody),
      );
    case "routine_stalled":
      // The computer's name (what the person calls it), else the routine's.
      return out(s.routineStalledTitle, text ? s.routineStalledBody(text) : what || s.openBody);
    case "routine_waiting_plan":
      // The routine's name, then when it runs (the push has no time zone to say the hour in).
      return out(s.routineWaitingPlanTitle, [what, s.routineWaitingPlanBody].filter(Boolean).join(" · "));
    case "plan_reset_unknown":
      // `title`: the plan's name; `label`: the agent's.
      return out(
        s.planResetUnknownTitle(input.title?.trim() || "AI"),
        s.planResetUnknownBody(input.label?.trim() || actor),
      );
    case "machine_connected":
      // Its name and who connected it: if nobody here expected it, it can be removed at once.
      return out(
        input.personal ? s.machineConnectedTitlePersonal : s.machineConnectedTitle,
        [what, input.actorName?.trim()].filter(Boolean).join(" · ") || s.openBody,
      );
    case "computer_ready":
      return out(input.personal ? s.computerReadyTitlePersonal : s.computerReadyTitle, s.computerReadyBody);
    case "browser_handoff":
      // What the agent asked for, in its words ("Entrar no Stripe com a conta de teste"). A desktop doesn't
      // open on the phone: its body says where it does.
      if (input.screen === "desktop")
        return out(
          (input.reminder ? s.desktopHandoffReminderTitle : s.desktopHandoffTitle)(actor),
          text || s.desktopHandoffBody,
        );
      return out(
        (input.reminder ? s.browserHandoffReminderTitle : s.browserHandoffTitle)(actor),
        text || s.browserHandoffBody,
      );
    case "secret_request":
      // What it is for, in the agent's words: the value is typed in the app, sealed there, never here.
      return out(s.secretTitle(actor), text || what || s.secretBody);
    case "widget_alert":
      // What the agent saw, in its words; never in the chat (ADR 0135 §6).
      return out(s.widgetAlertTitle(actor, what), text || s.openBody);
    case "widget_failed": {
      // The agent's own words when it said why, else its coded reason in words.
      const reason = input.reason ?? "";
      const why = (input.personal ? s.widgetFailedReasonsPersonal[reason] : undefined) || s.widgetFailedReasons[reason];
      return out(s.widgetFailedTitle(what), text || why || s.widgetFailedBody);
    }
    case "proposal_waiting":
      return out(s.proposalWaitingTitle(actor), s.dashboardProposalBody(""));
    case "dashboard_proposal":
      // Only the board's name: publishing happens in the app, never from the notification.
      return out(s.dashboardProposalTitle(actor), s.dashboardProposalBody(what));
    case "join_request": {
      // The name the person typed, never their note: approving happens in the app, never from the notification.
      const who = input.title?.trim() || s.someone;
      const by = input.suggestedBy?.trim();
      // A personal workspace's name ("Personal") reads as no place: theirs is "your workspace".
      if (input.personal)
        return out(by ? s.joinSuggestionTitlePersonal(by, who) : s.joinRequestTitlePersonal(who), s.joinRequestBody);
      if (by) return out(s.joinSuggestionTitle(by, who, input.label?.trim() || ""), s.joinRequestBody);
      return out(s.joinRequestTitle(who, input.label?.trim() || ""), s.joinRequestBody);
    }
    case "device.join_request":
      // The computer's name as it said it; letting it in happens in the app, never from the notification.
      return out(
        s.deviceJoinRequestTitle(input.label?.trim() || s.someone, input.title?.trim() || ""),
        s.deviceJoinRequestBody,
      );
    // The agent's name, whom it works for (`title`) and the device's name (`label`); what it does in `text`.
    case "device.in_use":
      return out(
        s.deviceInUseTitle(actor, input.title?.trim() ?? "", input.label?.trim() ?? ""),
        text || s.deviceInUseBody,
      );
    case "device.access_request":
      return out(s.deviceAccessTitle(actor, input.title?.trim() ?? "", input.label?.trim() ?? ""), s.deviceAccessBody);
    case "device.waiting":
      return out(s.deviceWaitingTitle(input.title?.trim() || actor, input.label?.trim() ?? ""), s.deviceWaitingBody);
    case "usage_limit":
      // Percentages only for the person; who decides reads the person's name (ADR 0141).
      switch (input.status) {
        case "warning":
          return out(s.usageWarningTitle(Math.round(input.percent ?? 80)), s.usageMineBody);
        case "reached_notify":
          return out(s.usageReachedMineTitle, s.usageMineBody);
        case "reached":
          return out(s.usageReachedTitle(actor), s.openBody);
        case "request":
          return out(s.usageRequestTitle(actor), s.usageRequestBody);
        case "raised":
          return out(s.usageRaisedTitle(actor), s.usageRaisedBody);
        default:
          return out(s.usageRefusedTitle(actor), s.openBody);
      }
    default:
      return out(input.waiting ? s.waitingTitle : actor, text || what || s.openBody);
  }
}
