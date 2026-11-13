import type { TFunction } from "i18next";
import type {
  AgentPresence,
  AgentStatus,
  AgentStatusKind,
  AgentStatusLine,
  Availability,
  MemberPresence,
  MemberStatus,
} from "../api/types";
import { clockHour } from "./format";
import { workStatusText } from "./long-work";
import { usageWhen } from "./plan-usage";
import { usageWaitingText } from "./usage-queue";

/**
 * Presence and written status (ADR 0084), platform-neutral: what you pick, the suggestions, when a status
 * clears, and how an agent's line reads. Web and phone draw it their own way.
 */

/** What a person picks, in the order the apps list them. */
export const AVAILABILITIES: readonly Availability[] = ["auto", "away", "busy", "out", "hidden"];

/** How you appear for what you picked (to yourself: hidden stays hidden). */
export const presenceOfAvailability = (a: Availability): MemberPresence => (a === "auto" ? "online" : a);

/** Any presence a badge draws: people's and agents'. */
export type AnyPresence = MemberPresence | AgentPresence;

export type UntilChoice = "never" | "m30" | "h1" | "h2" | "h4" | "today" | "week";
export const UNTIL_CHOICES: readonly UntilChoice[] = ["never", "m30", "h1", "h2", "h4", "today", "week"];

/** The suggestions under the field: a line, its emoji, when it clears and how you appear. */
export const STATUS_SUGGESTIONS = [
  { key: "meeting", emoji: "📅", until: "h1", availability: "busy" },
  { key: "lunch", emoji: "🍽️", until: "m30", availability: "away" },
  { key: "focus", emoji: "🎧", until: "h2", availability: "busy" },
  { key: "sick", emoji: "🤒", until: "today", availability: "away" },
  { key: "vacation", emoji: "🏖️", until: "week", availability: "out" },
] as const satisfies readonly { key: string; emoji: string; until: UntilChoice; availability: Availability }[];

/** When a status picked with `choice` at `now` clears (ISO), or null; "today"/"week" end at local midnight. */
export function untilFor(choice: UntilChoice, now = new Date()): string | null {
  const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();
  switch (choice) {
    case "never":
      return null;
    case "m30":
      return plus(30 * 60_000);
    case "h1":
      return plus(3600_000);
    case "h2":
      return plus(2 * 3600_000);
    case "h4":
      return plus(4 * 3600_000);
    case "today": {
      const end = new Date(now);
      end.setHours(23, 59, 0, 0);
      return end.toISOString();
    }
    case "week": {
      // Up to Sunday night (the week ends with the weekend).
      const end = new Date(now);
      end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
      end.setHours(23, 59, 0, 0);
      return end.toISOString();
    }
  }
}

/** "Some às 15:00" today, "Some sexta" within the week, else the date. */
export function clearsText(t: TFunction, language: string, until: string, now = new Date()): string {
  const at = new Date(until);
  if (at.toDateString() === now.toDateString()) {
    return t("presence.clearsAt", {
      time: at.toLocaleTimeString(language, { hour: clockHour(language), minute: "2-digit" }),
    });
  }
  const days = (at.getTime() - now.getTime()) / 86_400_000;
  const when =
    days < 7
      ? at.toLocaleDateString(language, { weekday: "long" })
      : at.toLocaleDateString(language, { day: "numeric", month: "short" });
  return t("presence.clearsOn", { when });
}

/**
 * The line under a status: when it clears. With no end, "Até você mudar" talks to its owner about their own choice:
 * for anyone else's status, nothing.
 */
export function statusEndNote(t: TFunction, language: string, until: string | null, own: boolean): string | null {
  if (until) return clearsText(t, language, until);
  return own ? t("presence.untilChanged") : null;
}

/** A person's line as one string: "📅 Em reunião". */
export const memberStatusText = (s: MemberStatus) => (s.emoji ? `${s.emoji} ${s.text}` : s.text);

/** The emoji of a line the server picked; a limit (the plan or the budget) draws `LIMIT_ICON` instead. */
export const AGENT_KIND_EMOJI: Record<Exclude<AgentStatusKind, LimitKind>, string> = {
  task: "🧩",
  routine: "🔁",
  mission: "🚀",
  channel: "💬",
  browsing: "🌐",
  coding: "💻",
  files: "📁",
  wiki: "📝",
  planning: "🗂️",
  data: "📊",
  mail: "✉️",
  connector: "🔌",
  computer: "🖥️",
  waiting_approval: "⏳",
  waiting_answer: "⏳",
  waiting_computer: "⏳",
  queued_computer: "⏳",
  provider_down: "⚠️",
  work: "🛠️",
};

type LimitKind = "out_of_plan" | "out_of_budget" | "waiting_plan" | "waiting_budget";
const isLimit = (kind: AgentStatusKind): kind is LimitKind =>
  kind === "out_of_plan" || kind === "out_of_budget" || kind === "waiting_plan" || kind === "waiting_budget";

/** In both apps' icon sets. An emoji there would read as the agent's own words. */
export const LIMIT_ICON = "pause";

/** What leads a line the server picked: its own emoji, else the limit's icon, else the kind's emoji. */
const markOf = (line: AgentStatusLine, kind: AgentStatusKind): { emoji: string | null; icon?: typeof LIMIT_ICON } =>
  line.emoji
    ? { emoji: line.emoji }
    : isLimit(kind)
      ? { emoji: null, icon: LIMIT_ICON }
      : { emoji: AGENT_KIND_EMOJI[kind] };

/** Out of office (§12): its plan or its budget hit the limit, so it sleeps until it is back. */
export const isOutOfOffice = (line: Pick<AgentStatusLine, "kind"> | null | undefined) =>
  line?.kind === "out_of_plan" || line?.kind === "out_of_budget";

/**
 * An agent's line in words (its own, or the server's kind worded in the app's language), with its emoji or, for a
 * limit, our icon. Out of office (§12) says when it is back ("Sem limite do plano · volta às 15:00"), in `locale`.
 */
export function agentStatusText(
  t: TFunction,
  line: AgentStatusLine,
  locale?: string,
  now = new Date(),
): { emoji: string | null; icon?: typeof LIMIT_ICON; text: string } | null {
  if (line.text) return { emoji: line.emoji ?? AGENT_KIND_EMOJI.task, text: line.text };
  if (!line.kind) return null;
  if (line.kind === "work") return { emoji: line.emoji ?? AGENT_KIND_EMOJI.work, text: workStatusText(t, line) };
  if (isOutOfOffice(line)) {
    const what = t(`presence.agent.${line.kind}`);
    const back = line.until ? t("presence.agent.backAt", { when: usageWhen(t, locale, line.until, now) }) : null;
    // How many conversations wait for it (ADR 0118): the same count its queue shows.
    const waiting = line.count ? usageWaitingText(t, line.count) : null;
    return { ...markOf(line, line.kind), text: [what, back, waiting].filter(Boolean).join(" · ") };
  }
  return {
    ...markOf(line, line.kind),
    text: t(`presence.agent.${line.kind}`, { subject: line.subject ?? "" }),
  };
}

/**
 * The members column's line: one short line. Out of office is "Sem limite · volta às 01:00" with no emoji (the face's
 * badge already says it), the waiting count left to the profile card and the queue; any other line as
 * `agentStatusText`.
 */
export function agentStatusShort(
  t: TFunction,
  line: AgentStatusLine,
  locale?: string,
  now = new Date(),
): { emoji: string | null; text: string } | null {
  if (line.text || (line.kind !== "out_of_plan" && line.kind !== "out_of_budget"))
    return agentStatusText(t, line, locale, now);
  const back = line.until ? t("presence.agent.backAt", { when: usageWhen(t, locale, line.until, now) }) : null;
  return { emoji: null, text: [t(`presence.agent.${line.kind}Short`), back].filter(Boolean).join(" · ") };
}

/**
 * An agent's presence as the apps draw it: no AI to think with reads as offline (ADR 0084 §3). At work it is online
 * (busy on heavy work) whatever this person reads of its AI, which for the right hand is their own, and before the
 * list says it: `working` is a run of its this app hears. Held by the server's operators, it stays offline.
 */
export function agentPresenceShown(status: AgentStatus | undefined, hasAi: boolean, working = false): AgentPresence {
  const presence = status?.presence ?? "away";
  if (presence === "offline") return "offline";
  if (working || status?.working) return presence === "busy" ? "busy" : "online";
  return hasAi ? presence : "offline";
}
