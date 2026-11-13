import type { PubSub, ScreenKind } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lte,
  ne,
  or,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { plainLine } from "@agenteschat/ui/markdown";
import { decidableBySql } from "./approvals";
import { NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { cutText } from "./format";
import type { PreviewMeta } from "./message-preview";
import { noticeOn, noticePrefsOf, readNoticePrefs } from "./notice-prefs";
import { listMemberships, requirePermission } from "./organizations";
import { enqueuePush } from "./push";
import type { ApprovalOrigin } from "./tools/run-policy";

const { notifications, organizationMembers } = schema;

/**
 * In-app notifications: one inbox per person per organization.
 *
 * - People only: agents are never recipients, and nobody is notified of
 *   their own action.
 * - Grouping: while an unread, not-done row of the same `(user, groupKey)`
 *   exists, a new event of a merging kind (thread replies, issue comments,
 *   reactions) merges into it. Other kinds are one row per event, and the
 *   same `groupKey` twice is a no-op (jobs may run more than once).
 * - Realtime goes to the recipient only (`userTopic`, cross-replica):
 *   `notification.upserted`, `notification.removed`, `notification.counts`.
 * - Auto-resolve: the source closed (question answered, approval decided,
 *   issue unassigned) sets `done_at` and emits `removed`.
 * - Push (ADR 0035): the first event of a group of a pushing kind enqueues
 *   `push.send` for the person's phones (`push.ts`).
 */

export const NOTIFICATION_KINDS = [
  "mention",
  "thread_reply",
  "dm",
  /**
   * An agent answered the person behind its run (ADR 0071): merged per conversation (`agentReplyGroup`), resolved
   * when they read it there. So someone can close the tab while an agent works and still hear when it's done.
   */
  "agent_reply",
  "agent_question",
  "issue_assigned",
  "issue_comment",
  "issue_status",
  "approval",
  "mission_finished",
  "mission_stopped",
  "routine_finished",
  "routine_failed",
  /**
   * A conversation run failed for good (ADR 0097): the person accountable for it, else the agent's owner, once per
   * agent and conversation, its coded reason in `latest.reason`. Resolved by the agent's next good run there.
   */
  "run_failed",
  /** A routine paused itself (its reason in `latest.reason`), ADR 0053. */
  "routine_paused",
  /** A routine waits for its computer (once per outage), ADR 0053. */
  "routine_stalled",
  /**
   * A routine named an agent its creator can't talk to (`reach.ts`): the agent's owner, once per routine
   * and agent, `source.agentId` the agent, opening the message.
   */
  "agent_unreached",
  /** A routine's run waits for its agent's plan to reset (once per outage, like `routine_stalled`). */
  "routine_waiting_plan",
  /**
   * An agent's work waited a day on its plan's limit and the plan never said when it resets (the agent's owner,
   * once per wait): `latest.title` the plan's name, `source.label` the agent's.
   */
  "plan_reset_unknown",
  /**
   * An agent back from its plan or budget skipped catch-ups that looked handled (ADR 0136): its owner, one row per line
   * (`count` the conversations they can read), opening the latest skipped note. Inbox only (no category, no push).
   */
  "catch_up_closed",
  /**
   * The person who asked, when the agent skipped their catch-up crediting someone else (ADR 0136): `latest.reason`
   * `solved` or `task_canceled`, `latest.title` who, `source.label` the conversation. Inbox only, opening the note
   * with "Responder mesmo assim".
   */
  "catch_up_closed_asker",
  "reaction",
  "machine_connected",
  /** An agent needs a person in its browser (ADR 0040 §6). */
  "browser_handoff",
  /** An agent waits for a secret only that person can give (ADR 0027): `latest.title` its name, `text` its purpose. */
  "secret_request",
  /**
   * The workspace was held, suspended or restored, with the notice shown (owners and admins, ADR 0056 §8), or on
   * agentes.chat Cloud one of its agents was held (`statusTo: "agent_hold"`, also its responsible person, §9).
   */
  "org_standing",
  /** The workspace's own computer is ready (owners, ADR 0056 §10). */
  "computer_ready",
  /**
   * Someone asks to join through the invitation link (owners and admins, ADR 0068): waiting, one row per workspace
   * merging the burst, `latest.title` the newest name and `latest.names` the first ones, `source.label` the
   * workspace's. No actor: the person isn't a member. Never their note.
   */
  "join_request",
  /**
   * Someone accepted the email invitation this person sent (ADR 0090): one row per person who joined, the person as
   * actor, `latest.title` their name, `source.label` the workspace's. Inbox only (no category, so never a push).
   */
  "invitation_accepted",
  /**
   * The workspace used its Composio calls for the month (`COMPOSIO_CALLS_PER_MONTH`, ADR 0107 §7): who manages its
   * connectors hears it once that month, `latest.title` the month (`2026-11`) and `latest.calls` the cap.
   */
  "composio_limit",
  /**
   * An agent's owner asks for one more browser profile for it (ADR 0110): the people who can grant profiles
   * (`manage_connectors`), one row per agent, `source.agentId` and its name in `source.label`. Waiting until seen.
   */
  "browser_profile_request",
  /**
   * A connected MCP server changed a tool's description or input. Never created: a changed tool applies itself
   * (ADR 0117, addendum), and rows of this kind are never listed or counted (`listed`).
   */
  "connector_tool_changed",
  /**
   * A computer's workspace disk passed `DISK_WARN_USE` in use (ADR 0115): who configures the workspace hears it once
   * each time it crosses, `source.machineId` and its name in `source.label`, `latest.diskUse` the share in use and
   * `latest.diskFreeGb` what is left.
   */
  "computer_disk_full",
  /**
   * A computer's runner drives its Google Chrome (ADR 0133) and it has none: the person who connected it (else who
   * configures the workspace) hears it once each time it goes missing, `source.machineId` and its name in
   * `source.label`. Never for the Cloud's computers, whose operators get an error report instead.
   */
  "computer_no_chrome",
  /**
   * Someone other than the agent's owner took control of its desktop (ADR 0059 §8): its owner, once a day per agent,
   * the person as actor, `source.agentId` and its name in `source.label`. Inbox only (no category, no push).
   */
  "desktop_taken",
  /**
   * Someone gave an agent a plan of this person's that isn't theirs (`use_others_plans`, ADR 0059 §3): the plan's
   * owner, one row per agent and account (`plan_lent:{accountId}:{agentId}`), the person as actor, `source.agentId` and
   * its name in `source.label`, `source.accountId`, the plan's name in `latest.plan`. Inbox only, with "Tirar de volta";
   * done once taken back.
   */
  "plan_lent",
  /**
   * A model an agent thinks with left its plan's live list (`droppedPlanModel`), so its turns run another one: the
   * agent's owner, once per agent and model (`planModelDroppedGroup`), the agent as actor, `source.agentId` and its
   * name in `source.label`, the model in `latest.title`, the plan's name in `latest.plan` and what it runs now in
   * `latest.nowModel`. Inbox only, with "Escolher outro modelo"; done once its model changes.
   */
  "plan_model_dropped",
  /**
   * An AI app connected as the person created agents, routines, skills, memories or channels for them (ADR 0119):
   * one row per connection merging while unread, `latest.title` the app's name and `latest.created` how many of each
   * kind; `source.agentId` or `source.routineId` the newest one it opens. Inbox only.
   */
  "app_created",
  /**
   * A widget's alert condition was met (ADR 0135 §6): whoever turned its alert on hears what the agent saw, waiting,
   * one row per widget merging while open (`widget-alert:<widgetId>`), `source.widgetId`, `source.dashboardId`,
   * `source.agentId`, the widget's title in `source.label`, the agent's words in `latest.text`.
   */
  "widget_alert",
  /**
   * A widget stopped updating (ADR 0135 §6): its creator, once per failure streak (`widget-failed:<widgetId>`), the
   * coded reason in `latest.reason` (`agent_reported`: the agent's words in `latest.text`). Resolved by its next good
   * update. Inbox only.
   */
  "widget_failed",
  /**
   * An agent asks to show a board to more people (ADR 0135 §11): the person it was made for, waiting
   * (`dashboard-proposal:<dashboardId>`), `source.dashboardId`, `source.agentId`, the board's title in `source.label`,
   * the audience in `latest.statusTo` (`workspace` or `roles`, the roles' names in `latest.names`) and the agent's
   * reason in `latest.text`. Resolved by Publish or Keep only for me.
   */
  "dashboard_proposal",
  /**
   * An update of a skill from its link (`skill-updates.ts`), `source.skillId` and its name in `source.label`;
   * `latest.statusTo`: `updated` (who turned "Atualizar sozinha" on), `waiting` (it changes what runs: who manages
   * skills, waiting, the files in `latest.title`, resolved once applied or refused) or `failed` (once per reason, its
   * code in `latest.reason`) or `edited` (an agent changed a skill a person made: its author, the agents as actors,
   * one row while unread). Inbox only.
   */
  "skill_update",
  /**
   * Someone asked the team's right hand for a change only others may decide, and sent it to them ("Pedir a um
   * admin", ADR 0137): each person who may decide it, one row per proposal (`source.proposalId`, or `source.messageId`
   * for a new agent's card), `source.agentId` and its name in `label` the agent it changes, `latest.text` why.
   * Waiting; done once someone decides it.
   */
  "change_request",
  /**
   * Proposals wait on this person (`proposals-waiting`, one row per person): the agents that made them as actors.
   * Waiting; done once none is left for them to decide.
   */
  "proposal_waiting",
  /**
   * A person's monthly AI limit (ADR 0141), `source.userId` the person, `latest.statusTo` what happened: `warning`
   * (the person, at 80%), `reached` (who decides, with `limitUsd`, `limitFrom`, `runs` and the agent most used in
   * `title` with its `share`; `reached_notify` to the person when the limit only notifies), `request` (who decides,
   * waiting, with `raiseToUsd`: "Aumentar para US$ X este mês" or "Recusar"), `raised` or `refused` (the person,
   * from who answered). The person's own rows carry percentages only.
   */
  "usage_limit",
  /**
   * "Quem aprova por mim" (ADR 0139): the person chosen to cover someone hears it (`latest.statusTo` the mode,
   * `always` or `while_out`, and `latest.expiresAt` its end), and the covered person hears when the cover said no
   * (`declined`) or an admin ended it (`ended`). The covered person or who ended it is the actor. Inbox only.
   */
  "approval_cover",
  /**
   * The right hand approved a card for this person (ADR 0139 §2): one row a day while unread, `count` how many,
   * `latest.title` the newest one's agent, `source.agentId` the right hand (its name in `label`). Inbox only.
   */
  "right_hand_decided",
  /**
   * The right hand stopped deciding for this person: three of its decisions undone in a week (ADR 0139 §2). Waiting
   * until they turn it back on, so it reaches their devices.
   */
  "right_hand_paused",
  /**
   * A computer ran a connect link this person made and asks to join (bring your own devices): its maker, waiting, one
   * row per request (`source.requestId`), the computer's name in `source.label`, the workspace's in `latest.title`
   * and its OS, address and rough location in `latest.text`. Done once let in or denied.
   */
  "device.join_request",
  /**
   * Bring your own devices, to a device's owner; for all three the agent is the actor, whom it works for is
   * `source.userId` (their first name in `latest.title`), the device is `source.machineId` (and `phoneId` for a phone)
   * with its name in `source.label`, and the run is `source.runId`.
   * `device.in_use`: someone else's agent is using it, once per run and device; what it does in `latest.text`. Stop
   * ends it (`POST …/devices/phones/{id}/stop`).
   */
  "device.in_use",
  /**
   * An agent asks to use the device for someone its rule leaves out: waiting, one per request
   * (`source.requestId`), the agent's reason in `latest.text`. Allow once, Always or No; done once answered.
   */
  "device.access_request",
  /** Someone else's agent waits for the device to be back or free, one per wait; done once the wait ends. */
  "device.waiting",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** `done`: "Concluídas", what the person marked done in the last `DONE_KEPT_MS`, the latest first (not counted). */
export const NOTIFICATION_FILTERS = ["all", "mentions", "waiting", "unread", "reactions", "done"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export interface NotificationActor {
  type: "user" | "agent";
  id: string;
}

export interface NotificationSource {
  channelId?: string;
  threadId?: string;
  messageId?: string;
  dmId?: string;
  issueId?: string;
  issueNumber?: number;
  topicId?: string;
  approvalId?: string;
  questionId?: string;
  missionId?: string;
  routineId?: string;
  /** A computer connected to the organization (ADR 0036). */
  machineId?: string;
  /** An agent's browser handoff (ADR 0040). */
  handoffId?: string;
  /** Which of the agent's screens it is on, when not its browser (ADR 0058). */
  screen?: ScreenKind;
  /** `change_request`: the proposed change to decide (ADR 0137). */
  proposalId?: string;
  /** `change_request` of a right hand's catalog card (`messageId`): the action's id. */
  action?: string;
  /** `agent_unreached`: the routine's creator, whom the agent's owner may let talk to `agentId`. */
  userId?: string;
  /** The agent held on agentes.chat Cloud (`org_standing` to `agent_hold`, its name in `label`); a widget's agent. */
  agentId?: string;
  /** A board (ADR 0135): `widget_alert`, `widget_failed`, `dashboard_proposal`. */
  dashboardId?: string;
  /** A widget (ADR 0135): `widget_alert`, `widget_failed`. */
  widgetId?: string;
  /** A skill of the library (`skill_update`). */
  skillId?: string;
  /** A plan's account (`plan_lent`). */
  accountId?: string;
  /**
   * `device.join_request`: the computer asking to join (`POST …/devices/requests/{id}/approve`);
   * `device.access_request`: the agent's request to use a device (`POST …/devices/access-requests/{id}/decide`).
   */
  requestId?: string;
  /** A phone reached through a connected computer (bring your own devices). */
  phoneId?: string;
  /** `device.in_use`, `device.waiting`, `device.access_request`: the agent's run on the device. */
  runId?: string;
  /** Channel name, thread title, issue title, topic title, mission or routine name, widget or board title. */
  label?: string;
}

export interface NotificationLatest {
  /** Snippet of the latest message, comment, question or summary (plain text, ≤ 280 chars); an approval's why. */
  text?: string;
  /** A message with only a GIF or a sticker (ADR 0091), or a voice message (ADR 0100): which one, so the apps say it in the person's language. */
  media?: "gif" | "sticker" | "voice";
  /** A body the server wrote (`previewMeta`): `text` is its English, the apps say it in the reader's language. */
  meta?: PreviewMeta;
  title?: string;
  emojis?: string[];
  quote?: string;
  statusFrom?: string;
  statusTo?: string;
  /** `org_standing`: the billing hold put on (`payment`, `unpaid`, `ended`; ADR 0079), in place of `text`. */
  billingHold?: string;
  steps?: { done: number; total: number; failedAt?: number };
  suggestions?: string[];
  expiresAt?: string;
  round?: number;
  rounds?: number;
  /**
   * `routine_paused`: why it paused itself; `routine_failed`: its failed run's code (coded reasons the app
   * translates).
   */
  reason?: string;
  /** `approval`: asked while nobody watched, by a routine (its name) or an unattended run (ADR 0053 §8). */
  origin?: ApprovalOrigin;
  /** `org_standing` to `agent_hold`: the hold's kind, `network` or `operator`, never its reason. */
  holdKind?: string;
  /** `org_standing` on agentes.chat Cloud: the apps read `text` as the restriction does, with how to contest it. */
  cloud?: boolean;
  /**
   * `join_request`: who asked, by name (they aren't members, so no actors), the first `MAX_NAMES` in the order they
   * asked: a merged row names whoever its time is from, and `count` says how many asked in all.
   */
  names?: string[];
  /** `join_request` from a member's suggestion (ADR 0090): who suggested, so a row of one says so. */
  suggestedBy?: string;
  /** `composio_limit`: the calls a month allows. */
  calls?: number;
  /** `computer_disk_full`: the share of the disk in use (0 to 1) and the GB left. */
  diskUse?: number;
  diskFreeGb?: number;
  /** `device.join_request`: the computer's system (`darwin`, `windows`, `linux`), address and rough place. */
  os?: string;
  ip?: string;
  location?: string;
  /** `app_created`: how many of each kind (`agent`, `routine`, `skill`, `memory`, `channel`), summed as rows merge. */
  created?: Record<string, number>;
  /** `browser_handoff` still unanswered an hour later (`remindNotifications`): its push says the agent still needs them. */
  reminder?: boolean;
  /** `run_failed`: every run it stands for (`joinRunFailure`), one per agent and conversation. */
  failures?: RunFailure[];
  /** `run_failed` on a computer brain: the plan's name its cause may name ("the Claude account was disconnected"). */
  plan?: string;
  /** `plan_model_dropped`: the model the agent's turns run now. */
  nowModel?: string;
  /** `usage_limit`: the share of the person's limit used. */
  percent?: number;
  /** `usage_limit` to who decides: the limit, what "Aumentar" raises it to, where it comes from, this month's requests. */
  limitUsd?: number;
  raiseToUsd?: number;
  limitFrom?: string;
  runs?: number;
  /** `usage_limit`: the share of the requests made with the agent in `title`. */
  share?: number;
}

/** A run that failed, as its `run_failed` row lists it: `key` its agent and conversation, the rest its source. */
export interface RunFailure {
  key: string;
  agentId: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  label?: string;
}

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  waiting: boolean;
  actors: NotificationActor[];
  count: number;
  source: NotificationSource;
  latest: NotificationLatest;
  readAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationCounts {
  all: number;
  mentions: number;
  waiting: number;
  unread: number;
  reactions: number;
}

export interface NotificationDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

type Row = typeof notifications.$inferSelect;

/** Kinds whose events merge into one open row of their group. */
const MERGING: ReadonlySet<NotificationKind> = new Set([
  "thread_reply",
  "agent_reply",
  "issue_comment",
  "reaction",
  "join_request",
  // One per approval card: requests joining it update it, read or not (`notifyApproval`).
  "approval",
  "app_created",
  // A widget's alerts while one is open: the latest words replace the older ones.
  "widget_alert",
  // An agent's changes to a skill gather in one row while unread (`notifySkillUpdate` `edited`); its other notices
  // have a key of their own each.
  "skill_update",
  // An agent's skipped catch-ups of one line gather in one row while unread, counting them.
  "catch_up_closed",
  // The day's decisions the right hand made for the person, one row while unread.
  "right_hand_decided",
  // One per person, read or not, until nothing waits on them.
  "proposal_waiting",
]);
/** "Menções" in the inbox: what was said to me. */
const MENTION_KINDS: NotificationKind[] = ["mention", "dm", "agent_reply", "agent_question"];
/** A read reaction row still takes new reactions for this long (the "9 min" span on the card). */
export const REACTION_MERGE_MS = 30 * 60_000;
export const MAX_ACTORS = 10;
export const SNIPPET_LENGTH = 280;
export const MAX_PAGE = 100;
/** How far ahead a notification can be snoozed. */
export const MAX_SNOOZE_MS = 365 * 24 * 3600_000;
/** How far back "Concluídas" lists. */
export const DONE_KEPT_MS = 30 * 24 * 3600_000;

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/** How many people a merged row names (`latest.names`); the rest are counted. */
const MAX_NAMES = 2;

/** Plain text for a card (`plainLine`), at most `max` chars. `@mentions` stay. */
export function notificationSnippet(text: string | null | undefined, max = SNIPPET_LENGTH): string {
  if (!text) return "";
  const plain = plainLine(text, max);
  return plain.length > max ? `${cutText(plain, max - 1).trimEnd()}…` : plain;
}

export function notificationView(r: Row): NotificationView {
  return {
    id: r.id,
    kind: r.kind as NotificationKind,
    waiting: r.waiting,
    actors: r.actors,
    count: r.count,
    source: r.source as NotificationSource,
    latest: r.latest as NotificationLatest,
    readAt: r.readAt?.toISOString() ?? null,
    doneAt: r.doneAt?.toISOString() ?? null,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const sameActor = (a: NotificationActor, b: NotificationActor) => a.type === b.type && a.id === b.id;

/** The newest actor first, no duplicates, at most `MAX_ACTORS`. */
export function mergeActors(newest: NotificationActor | null | undefined, before: NotificationActor[]) {
  const list = newest ? [newest, ...before.filter((a) => !sameActor(a, newest))] : before;
  return list.slice(0, MAX_ACTORS);
}

/** A merge's `latest`: the newest event's, the names the row had kept first (each once, `MAX_NAMES`). */
function mergeLatest(next: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> {
  if (next.created && before.created) {
    const sum = { ...(before.created as Record<string, number>) };
    for (const [kind, n] of Object.entries(next.created as Record<string, number>)) sum[kind] = (sum[kind] ?? 0) + n;
    return { ...next, created: sum };
  }
  if (!Array.isArray(next.names) || !Array.isArray(before.names)) return next;
  return { ...next, names: [...new Set([...before.names, ...next.names])].slice(0, MAX_NAMES) };
}

/** Drops empty values so the stored JSON holds only what is set. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

// ── Writing ───────────────────────────────────────────────────────────────────

export interface NotifyInput {
  orgId: string;
  /** Recipients (people). Empty values, the actor and non-members are dropped. */
  userIds: Iterable<string | null | undefined>;
  kind: NotificationKind;
  groupKey: string;
  waiting?: boolean;
  /** Who did it (newest actor); a person is never notified of their own action. */
  actor?: NotificationActor | null;
  source: NotificationSource;
  latest?: NotificationLatest;
}

/**
 * Creates or merges a notification for each recipient and tells them. Best
 * effort for callers: wrap in `.catch` where a failure must not undo the
 * action that caused it.
 */
export async function notify(deps: NotificationDeps, input: NotifyInput): Promise<NotificationView[]> {
  const actorUser = input.actor?.type === "user" ? input.actor.id : null;
  const wanted = [...new Set([...input.userIds].filter((u): u is string => !!u && u !== actorUser))];
  if (wanted.length === 0) return [];
  // People of this organization only (an agent's id never matches a member).
  const members = await deps.db
    .select({ userId: organizationMembers.userId, prefs: organizationMembers.noticePrefs })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, input.orgId), inArray(organizationMembers.userId, wanted)));
  const out: NotificationView[] = [];
  for (const member of members) {
    const { userId } = member;
    const row = await upsertOne(deps, input, userId);
    if (!row) continue;
    const view = notificationView(row);
    out.push(view);
    // Whether it reaches their devices as a notification (ADR 0071 §8): the desktop app's banner reads `alert`.
    const prefs = noticePrefsOf(member.prefs);
    const snoozed = row.snoozedUntil && row.snoozedUntil.getTime() > nowOf(deps).getTime();
    if (!snoozed)
      await publishUserEvent(deps.pubsub, input.orgId, userId, {
        type: "notification.upserted",
        notification: view,
        alert: noticeOn(prefs, row.kind, row.waiting),
      });
    await publishCounts(deps, input.orgId, userId);
    // Their phone and browsers too (ADR 0035, 0071), through the outbox; never undoes the notification. A group pushes
    // once while unread: only the event that opened its row.
    if (row.count === 1) await enqueuePush(deps.db, row, nowOf(deps), prefs).catch(() => false);
  }
  return out;
}

async function upsertOne(deps: NotificationDeps, input: NotifyInput, userId: string): Promise<Row | null> {
  const { db } = deps;
  const now = nowOf(deps);
  const source = compact(input.source) as Record<string, unknown>;
  const latest = compact(input.latest ?? {}) as Record<string, unknown>;
  const fresh = () =>
    db
      .insert(notifications)
      .values({
        orgId: input.orgId,
        userId,
        kind: input.kind,
        waiting: input.waiting ?? false,
        groupKey: input.groupKey,
        actors: mergeActors(input.actor, []),
        count: 1,
        source,
        latest,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
  const sameGroup = and(
    eq(notifications.orgId, input.orgId),
    eq(notifications.groupKey, input.groupKey),
    eq(notifications.userId, userId),
  );

  if (!MERGING.has(input.kind)) {
    // One row per event: the same key again (a retried job) changes nothing.
    const [seen] = await db.select({ id: notifications.id }).from(notifications).where(sameGroup).limit(1);
    if (seen) return null;
    const [row] = await fresh();
    return row ?? null;
  }

  const reaction = input.kind === "reaction";
  for (let attempt = 0; attempt < 4; attempt++) {
    const [open] = await db
      .select()
      .from(notifications)
      .where(
        and(
          sameGroup,
          isNull(notifications.doneAt),
          input.kind === "approval" || input.kind === "proposal_waiting"
            ? undefined
            : reaction
              ? or(
                  isNull(notifications.readAt),
                  gt(notifications.updatedAt, new Date(now.getTime() - REACTION_MERGE_MS)),
                )
              : isNull(notifications.readAt),
        ),
      )
      .orderBy(sql`${notifications.readAt} is not null`, desc(notifications.updatedAt))
      .limit(1);
    if (open) {
      try {
        // Optimistic: only if nobody merged into it meanwhile (else read it again).
        const [row] = await db
          .update(notifications)
          .set({
            actors: mergeActors(input.actor, open.actors),
            count: sql`${notifications.count} + 1`,
            latest: Object.keys(latest).length ? mergeLatest(latest, open.latest) : open.latest,
            source: { ...open.source, ...source },
            readAt: null,
            updatedAt: now,
          })
          .where(and(eq(notifications.id, open.id), eq(notifications.updatedAt, open.updatedAt)))
          .returning();
        if (row) return row;
      } catch {
        // A concurrent unread row of the same group appeared: read again.
      }
      continue;
    }
    const [row] = await fresh();
    if (row) return row;
  }
  return null;
}

/**
 * Auto-resolve: the open notifications of a group (or of every group with
 * this prefix) are done, for everyone or for some people. Emits `removed`.
 */
export async function resolveNotifications(
  deps: NotificationDeps,
  orgId: string,
  match: { groupKey?: string; groupKeyPrefix?: string; ids?: string[]; userIds?: string[]; kind?: NotificationKind },
): Promise<number> {
  if (!match.groupKey && !match.groupKeyPrefix && !match.ids?.length) return 0;
  if (match.userIds && match.userIds.length === 0) return 0;
  const rows = await deps.db
    .update(notifications)
    .set({ doneAt: nowOf(deps) })
    .where(
      and(
        eq(notifications.orgId, orgId),
        isNull(notifications.doneAt),
        match.groupKey ? eq(notifications.groupKey, match.groupKey) : undefined,
        match.groupKeyPrefix ? like(notifications.groupKey, `${escapeLike(match.groupKeyPrefix)}%`) : undefined,
        match.ids ? inArray(notifications.id, match.ids) : undefined,
        match.userIds ? inArray(notifications.userId, match.userIds) : undefined,
        match.kind ? eq(notifications.kind, match.kind) : undefined,
      ),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  const users = new Set<string>();
  for (const r of rows) {
    users.add(r.userId);
    await publishUserEvent(deps.pubsub, orgId, r.userId, { type: "notification.removed", id: r.id });
  }
  for (const userId of users) await publishCounts(deps, orgId, userId);
  return rows.length;
}

// ── Failures of one cause ─────────────────────────────────────────────────────

/**
 * Runs failing for one cause this close together (a signed-out account, a computer refusing turns) share one
 * `run_failed` row while it is open: "15 agents couldn't go on: the Claude account was disconnected".
 */
export const RUN_FAILED_GROUP_MS = 15 * 60_000;
/** How many runs a row lists (`count` goes on counting). */
const MAX_FAILURES = 100;

/** The runs a `run_failed` row stands for (a row from before `failures` stands for its own source). */
function failuresOf(r: Row): RunFailure[] {
  const l = r.latest as NotificationLatest;
  if (l.failures) return l.failures;
  const s = r.source as NotificationSource;
  return s.agentId && s.channelId && s.messageId
    ? [
        compact({
          key: r.groupKey,
          agentId: s.agentId,
          channelId: s.channelId,
          threadId: s.threadId,
          messageId: s.messageId,
          label: s.label,
        }),
      ]
    : [];
}

const hasFailure = (key: string) => sql`${notifications.latest}->'failures' @> ${JSON.stringify([{ key }])}::jsonb`;

async function publishRow(deps: NotificationDeps, row: Row) {
  await publishUserEvent(deps.pubsub, row.orgId, row.userId, {
    type: "notification.upserted",
    notification: notificationView(row),
  });
  await publishCounts(deps, row.orgId, row.userId);
}

/**
 * A run failed for `cause` (`latest.reason`, `latest.plan`): when the person has an open `run_failed` row already
 * listing it, nothing; when one of that cause moved within `RUN_FAILED_GROUP_MS`, it joins that row (unread again,
 * no push). False when it needs a row of its own. Call it under a lock on the person's failures, with the insert.
 */
export async function joinRunFailure(
  deps: NotificationDeps,
  orgId: string,
  userId: string,
  failure: RunFailure,
  cause: { reason: string; plan?: string },
): Promise<boolean> {
  const { db } = deps;
  const now = nowOf(deps);
  const mine = and(
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    eq(notifications.kind, "run_failed"),
    isNull(notifications.doneAt),
  );
  const [listed] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(mine, hasFailure(failure.key)))
    .limit(1);
  if (listed) return true;
  const [open] = await db
    .select()
    .from(notifications)
    .where(
      and(
        mine,
        sql`${notifications.latest}->>'reason' = ${cause.reason}`,
        sql`${notifications.latest}->>'plan' is not distinct from ${cause.plan ?? null}`,
        gt(notifications.updatedAt, new Date(now.getTime() - RUN_FAILED_GROUP_MS)),
      ),
    )
    .orderBy(desc(notifications.updatedAt))
    .limit(1);
  if (!open) return false;
  const before = failuresOf(open);
  if (before.some((f) => f.key === failure.key)) return true;
  const [row] = await db
    .update(notifications)
    .set({
      actors: mergeActors({ type: "agent", id: failure.agentId }, open.actors),
      count: sql`${notifications.count} + 1`,
      latest: { ...open.latest, failures: [...before, failure].slice(0, MAX_FAILURES) },
      readAt: null,
      updatedAt: now,
    })
    .where(eq(notifications.id, open.id))
    .returning();
  if (row) await publishRow(deps, row);
  return true;
}

/**
 * The agent's run in that conversation (`key`) ended well: it leaves every open `run_failed` row listing it, and a
 * row left with none is done. A row left with one reads as that one's again.
 */
export async function dropRunFailure(deps: NotificationDeps, orgId: string, key: string): Promise<void> {
  const open = and(eq(notifications.orgId, orgId), eq(notifications.kind, "run_failed"), isNull(notifications.doneAt));
  // A shared row keeps its creator's groupKey after the creator leaves it, so groupKey only names rows from before
  // `failures`.
  const candidates = await deps.db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        open,
        or(hasFailure(key), and(eq(notifications.groupKey, key), sql`${notifications.latest}->'failures' is null`)),
      ),
    );
  for (const c of candidates) {
    // Same lock as `notifyRunFailed`, so a join and a drop on one row never overwrite each other.
    await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`run-failed:${orgId}:${c.userId}`}))`);
      const d = { ...deps, db: tx };
      const [r] = await tx
        .select()
        .from(notifications)
        .where(and(open, eq(notifications.id, c.id)));
      if (!r) return;
      const before = failuresOf(r);
      const rest = before.filter((f) => f.key !== key);
      if (rest.length === before.length) return;
      const first = rest[0];
      if (!first) {
        await resolveNotifications(d, orgId, { ids: [r.id] });
        return;
      }
      const { key: _, ...source } = first;
      const [row] = await tx
        .update(notifications)
        .set({
          actors: rest.reduce<NotificationActor[]>(
            (list, f) => mergeActors({ type: "agent", id: f.agentId }, list),
            [],
          ),
          count: Math.max(rest.length, r.count - 1),
          source,
          latest: { ...r.latest, failures: rest },
        })
        .where(eq(notifications.id, r.id))
        .returning();
      if (row) await publishRow(d, row);
    });
  }
}

/**
 * Access lost: a person's notifications from a channel they left go for good, snippets included. Approvals stay:
 * who is told is `notifiedIds` and who keeps one is who may decide it (`stillDecides`), not the channel.
 */
export async function clearChannelNotifications(
  deps: NotificationDeps,
  orgId: string,
  userId: string,
  channelId: string,
): Promise<number> {
  const rows = await deps.db
    .delete(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        sql`${notifications.source}->>'channelId' = ${channelId}`,
        ne(notifications.kind, "approval"),
      ),
    )
    .returning({ id: notifications.id });
  for (const r of rows) await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.removed", id: r.id });
  if (rows.length) await publishCounts(deps, orgId, userId);
  return rows.length;
}

/** A task is gone: everyone's notifications about it go too, live. */
export async function clearIssueNotifications(deps: NotificationDeps, orgId: string, issueIds: readonly string[]) {
  if (issueIds.length === 0) return;
  const rows = await deps.db
    .delete(notifications)
    .where(and(eq(notifications.orgId, orgId), inArray(sql`${notifications.source}->>'issueId'`, issueIds)))
    .returning({ id: notifications.id, userId: notifications.userId });
  for (const r of rows)
    await publishUserEvent(deps.pubsub, orgId, r.userId, { type: "notification.removed", id: r.id });
  for (const userId of new Set(rows.map((r) => r.userId))) await publishCounts(deps, orgId, userId);
}

/**
 * A group's open notifications describe something else now (an approval card whose first waiting request was
 * decided): each person's row gets what `pick` says for them, in place (no new count, no push, same order), or
 * is resolved when `pick` has nothing left for them.
 */
export async function retargetNotifications(
  deps: NotificationDeps,
  orgId: string,
  groupKey: string,
  pick: (userId: string) => { source: Partial<NotificationSource>; latest: NotificationLatest } | null,
): Promise<void> {
  const rows = await deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, orgId), eq(notifications.groupKey, groupKey), isNull(notifications.doneAt)));
  const done: string[] = [];
  for (const r of rows) {
    const next = pick(r.userId);
    if (!next) {
      done.push(r.userId);
      continue;
    }
    const [row] = await deps.db
      .update(notifications)
      .set({ source: { ...r.source, ...next.source }, latest: compact({ ...r.latest, ...next.latest }) })
      .where(eq(notifications.id, r.id))
      .returning();
    if (row)
      await publishUserEvent(deps.pubsub, orgId, r.userId, {
        type: "notification.upserted",
        notification: notificationView(row),
      });
  }
  if (done.length) await resolveNotifications(deps, orgId, { groupKey, userIds: done });
}

/**
 * A reminder: a group's open notifications come back unread and on top, `latest` patched, and go to the person's
 * devices once more (`push.send` keyed by `key`, so once per reminder). Rows done meanwhile stay done.
 */
export async function remindNotifications(
  deps: NotificationDeps,
  orgId: string,
  groupKey: string,
  latest: NotificationLatest,
  key: string,
): Promise<number> {
  const now = nowOf(deps);
  const rows = await deps.db
    .update(notifications)
    .set({ readAt: null, updatedAt: now, latest: sql`${notifications.latest} || ${JSON.stringify(latest)}::jsonb` })
    .where(and(eq(notifications.orgId, orgId), eq(notifications.groupKey, groupKey), isNull(notifications.doneAt)))
    .returning();
  for (const row of rows) {
    const prefs = await readNoticePrefs(deps.db, orgId, row.userId);
    if (!(row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime()))
      await publishUserEvent(deps.pubsub, orgId, row.userId, {
        type: "notification.upserted",
        notification: notificationView(row),
        alert: noticeOn(prefs, row.kind, row.waiting),
      });
    await publishCounts(deps, orgId, row.userId);
    await enqueuePush(deps.db, row, now, prefs, `push.send:${row.id}:${key}`).catch(() => false);
  }
  return rows.length;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Snoozed notifications whose time came (worker, every 30 s): back in the inbox on top and unread, as "Volto a avisar"
 * promised, so they reach the person as a new one does (the island and its sound, the desktop banner, one more push
 * keyed by this wake). An approval the person may no longer decide stays out.
 */
export async function wakeSnoozedNotifications(deps: NotificationDeps): Promise<number> {
  const now = nowOf(deps);
  const rows = await deps.db
    .update(notifications)
    .set({ snoozedUntil: null, updatedAt: now })
    .where(and(lte(notifications.snoozedUntil, now), isNull(notifications.doneAt)))
    .returning();
  const users = new Map<string, string>();
  for (const woke of rows) {
    users.set(`${woke.orgId}:${woke.userId}`, woke.orgId);
    if (woke.kind === "approval") {
      const [still] = await deps.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, woke.id), stillDecides(woke.orgId, woke.userId)));
      if (!still) continue;
    }
    const r = woke.readAt ? await unreadAgain(deps.db, woke) : woke;
    const prefs = await readNoticePrefs(deps.db, r.orgId, r.userId);
    await publishUserEvent(deps.pubsub, r.orgId, r.userId, {
      type: "notification.upserted",
      notification: notificationView(r),
      alert: noticeOn(prefs, r.kind, r.waiting),
    });
    await enqueuePush(deps.db, r, now, prefs, `push.send:${r.id}:woke:${now.getTime()}`).catch(() => false);
  }
  for (const [key, orgId] of users) await publishCounts(deps, orgId, key.slice(orgId.length + 1));
  return rows.length;
}

/** A read row unread again, unless a newer unread row of its group holds the group's one open slot. */
async function unreadAgain(db: Database, row: Row): Promise<Row> {
  try {
    const [back] = await db.update(notifications).set({ readAt: null }).where(eq(notifications.id, row.id)).returning();
    return back ?? row;
  } catch {
    return row;
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * An approval stays only while the person may still decide it (`decidableBySql`, the rule `decideApproval` applies).
 * Checked on read, so a role or a key taken away by any path takes the row with it.
 */
function stillDecides(orgId: string, userId: string): SQL {
  return or(
    ne(notifications.kind, "approval"),
    sql`exists (select 1 from ${schema.approvals} where ${schema.approvals.orgId} = ${orgId}
      and ${schema.approvals.id} = (${notifications.source}->>'approvalId')::uuid and ${decidableBySql(userId)})`,
  ) as SQL;
}

/** Rows the inbox may show: a `connector_tool_changed` row asks for a review that no longer exists. */
const listed = ne(notifications.kind, "connector_tool_changed");

/** Not done, not snoozed into the future, and still the person's to see. */
function visible(orgId: string, userId: string, now: Date): SQL {
  return and(
    listed,
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    isNull(notifications.doneAt),
    or(isNull(notifications.snoozedUntil), lte(notifications.snoozedUntil, now)),
    stillDecides(orgId, userId),
  ) as SQL;
}

function filterSql(filter: NotificationFilter): SQL | undefined {
  switch (filter) {
    case "mentions":
      return inArray(notifications.kind, MENTION_KINDS);
    case "waiting":
      return eq(notifications.waiting, true);
    case "unread":
      return isNull(notifications.readAt);
    case "reactions":
      return eq(notifications.kind, "reaction");
    case "done":
      return undefined;
    default:
      return undefined;
  }
}

/** Marked done by the person, recently enough to list. */
function doneByMe(orgId: string, userId: string, now: Date): SQL {
  return and(
    listed,
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    eq(notifications.doneByUser, true),
    gte(notifications.doneAt, new Date(now.getTime() - DONE_KEPT_MS)),
  ) as SQL;
}

/**
 * Opaque keyset cursor over `(waiting desc, updated_at desc, id desc)`; for "Concluídas", `(done_at desc, id desc)`
 * with a 0 in front.
 */
function encodeCursor(r: Row, done: boolean) {
  const at = done ? (r.doneAt ?? r.updatedAt) : r.updatedAt;
  return Buffer.from(JSON.stringify([!done && r.waiting ? 1 : 0, at.toISOString(), r.id])).toString("base64url");
}

function decodeCursor(cursor: string): [number, Date, string] {
  try {
    const [w, u, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [unknown, unknown, unknown];
    const at = new Date(String(u));
    if ((w !== 0 && w !== 1) || Number.isNaN(at.getTime()) || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("bad cursor");
    return [w, at, id];
  } catch {
    throw new ValidationError("Invalid cursor", "notifications.bad_cursor");
  }
}

async function countsOf(db: Database, orgId: string, userId: string, now: Date): Promise<NotificationCounts> {
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      mentions: sql<number>`(count(*) filter (where ${inArray(notifications.kind, MENTION_KINDS)}))::int`,
      waiting: sql<number>`(count(*) filter (where ${notifications.waiting}))::int`,
      unread: sql<number>`(count(*) filter (where ${notifications.readAt} is null))::int`,
      reactions: sql<number>`(count(*) filter (where ${notifications.kind} = 'reaction'))::int`,
    })
    .from(notifications)
    .where(visible(orgId, userId, now));
  return {
    all: Number(row?.all ?? 0),
    mentions: Number(row?.mentions ?? 0),
    waiting: Number(row?.waiting ?? 0),
    unread: Number(row?.unread ?? 0),
    reactions: Number(row?.reactions ?? 0),
  };
}

/** The inbox: waiting first, then newest; with the counts of every filter (the same visible set). */
export async function listNotifications(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  options: { filter?: NotificationFilter; cursor?: string | null; limit?: number } = {},
): Promise<{ items: NotificationView[]; counts: NotificationCounts; nextCursor: string | null }> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "read");
  const now = nowOf(deps);
  const filter = options.filter ?? "all";
  if (!NOTIFICATION_FILTERS.includes(filter)) throw new ValidationError("Unknown filter");
  const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_PAGE));
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const done = filter === "done";
  const [rows, counts] = await Promise.all([
    done
      ? db
          .select()
          .from(notifications)
          .where(
            and(
              doneByMe(orgId, userId, now),
              after
                ? sql`(${notifications.doneAt}, ${notifications.id}) < (${after[1].toISOString()}::timestamptz, ${after[2]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(notifications.doneAt), desc(notifications.id))
          .limit(limit + 1)
      : db
          .select()
          .from(notifications)
          .where(
            and(
              visible(orgId, userId, now),
              filterSql(filter),
              after
                ? sql`(${notifications.waiting}::int, ${notifications.updatedAt}, ${notifications.id}) < (${after[0]}::int, ${after[1].toISOString()}::timestamptz, ${after[2]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(notifications.waiting), desc(notifications.updatedAt), desc(notifications.id))
          .limit(limit + 1),
    countsOf(db, orgId, userId, now),
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(notificationView),
    counts,
    nextCursor: rows.length > limit && last ? encodeCursor(last, done) : null,
  };
}

/** The badge: unread and waiting, over the visible inbox. */
export async function notificationCounts(deps: NotificationDeps, userId: string, orgId: string) {
  await requirePermission(deps.db, userId, orgId, "read");
  const c = await countsOf(deps.db, orgId, userId, nowOf(deps));
  return { unread: c.unread, waiting: c.waiting };
}

/**
 * Unread and waiting in every workspace the person reads, in one call: the apps list workspaces from several servers
 * with their unread counts, one request per server instead of one per workspace (ADR 0154).
 */
export async function notificationCountsByOrg(
  deps: NotificationDeps,
  userId: string,
): Promise<{ orgId: string; unread: number; waiting: number }[]> {
  const now = nowOf(deps);
  const memberships = (await listMemberships(deps.db, userId)).filter((m) => m.permissions.has("read"));
  return Promise.all(
    memberships.map(async (m) => {
      const c = await countsOf(deps.db, m.orgId, userId, now);
      return { orgId: m.orgId, unread: c.unread, waiting: c.waiting };
    }),
  );
}

async function publishCounts(deps: NotificationDeps, orgId: string, userId: string) {
  if (!deps.pubsub) return;
  const c = await countsOf(deps.db, orgId, userId, nowOf(deps)).catch(() => null);
  if (c)
    await publishUserEvent(deps.pubsub, orgId, userId, {
      type: "notification.counts",
      unread: c.unread,
      waiting: c.waiting,
    });
}

// ── The person's actions ──────────────────────────────────────────────────────

async function mine(deps: NotificationDeps, userId: string, orgId: string, id: string) {
  await requirePermission(deps.db, userId, orgId, "read");
  const [row] = await deps.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        stillDecides(orgId, userId),
      ),
    );
  if (!row) throw new NotFoundError("Notification not found");
  return row;
}

/**
 * Applies a change to one of the person's notifications. Bringing a row back
 * to "unread, not done" while another open row of its group exists would
 * break the one-open-row rule: then nothing changes.
 */
async function change(deps: NotificationDeps, row: Row, set: Partial<typeof notifications.$inferInsert>) {
  try {
    const [updated] = await deps.db.update(notifications).set(set).where(eq(notifications.id, row.id)).returning();
    return updated ?? row;
  } catch {
    return row;
  }
}

export async function markNotificationRead(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  id: string,
  read: boolean,
): Promise<NotificationView> {
  const row = await mine(deps, userId, orgId, id);
  const updated = await change(deps, row, { readAt: read ? (row.readAt ?? nowOf(deps)) : null });
  const view = notificationView(updated);
  if (!updated.doneAt) {
    await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.upserted", notification: view });
  }
  await publishCounts(deps, orgId, userId);
  return view;
}

/** "Concluir" (out of the inbox, into "Concluídas") or its undo ("Mover de volta"). */
export async function markNotificationDone(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  id: string,
  done: boolean,
): Promise<NotificationView> {
  const row = await mine(deps, userId, orgId, id);
  let updated = await change(
    deps,
    row,
    done ? { doneAt: row.doneAt ?? nowOf(deps), doneByUser: true } : { doneAt: null, doneByUser: false },
  );
  // A newer unread row of the same group holds the open-group slot (notifications_open_group):
  // the restored one comes back read, which the index allows.
  if (!done && updated.doneAt)
    updated = await change(deps, row, { doneAt: null, doneByUser: false, readAt: row.readAt ?? nowOf(deps) });
  const view = notificationView(updated);
  await publishUserEvent(
    deps.pubsub,
    orgId,
    userId,
    updated.doneAt
      ? { type: "notification.removed", id: row.id }
      : { type: "notification.upserted", notification: view },
  );
  await publishCounts(deps, orgId, userId);
  return view;
}

/**
 * "Lembrar depois": hidden until `until`, then back on top (`notification.upserted`).
 * `until: null` undoes it: back in the inbox now, nothing else changes.
 */
export async function snoozeNotification(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  id: string,
  until: Date | null,
): Promise<NotificationView> {
  if (until === null) {
    const row = await mine(deps, userId, orgId, id);
    const updated = await change(deps, row, { snoozedUntil: null });
    const view = notificationView(updated);
    if (!updated.doneAt) {
      await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.upserted", notification: view });
    }
    await publishCounts(deps, orgId, userId);
    return view;
  }
  if (Number.isNaN(until.getTime())) throw new ValidationError("Invalid date", "notifications.bad_snooze");
  const now = nowOf(deps);
  if (until.getTime() <= now.getTime())
    throw new ValidationError("Pick a time in the future", "notifications.snooze_in_past");
  if (until.getTime() - now.getTime() > MAX_SNOOZE_MS)
    throw new ValidationError("At most a year ahead", "notifications.snooze_too_far");
  const row = await mine(deps, userId, orgId, id);
  const updated = await change(deps, row, { snoozedUntil: until });
  await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.removed", id: row.id });
  await publishCounts(deps, orgId, userId);
  return notificationView(updated);
}

/** "Marcar tudo como lido" (in a filter): the ids changed, for the undo. */
export async function markAllNotificationsRead(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  filter: NotificationFilter = "all",
): Promise<{ ids: string[] }> {
  await requirePermission(deps.db, userId, orgId, "read");
  if (!NOTIFICATION_FILTERS.includes(filter)) throw new ValidationError("Unknown filter");
  // What is done is out of the inbox: nothing there to mark.
  if (filter === "done") return { ids: [] };
  const now = nowOf(deps);
  const rows = await deps.db
    .update(notifications)
    .set({ readAt: now })
    .where(and(visible(orgId, userId, now), filterSql(filter), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (rows.length > 0) await publishCounts(deps, orgId, userId);
  return { ids: rows.map((r) => r.id) };
}
