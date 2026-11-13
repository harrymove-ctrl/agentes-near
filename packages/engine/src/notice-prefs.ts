import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import type { NotificationKind } from "./notifications";
import { requirePermission } from "./organizations";

const { organizationMembers, pushDevices } = schema;

/**
 * What reaches a person's devices as a notification (ADR 0071 §8): the phone's and the browser's pushes and the
 * desktop app's banners. Kinds come in categories the person reads, each on or off per person in each workspace
 * (`organization_members.notice_prefs`). The inbox keeps everything either way. The defaults are what pushed
 * before anyone could choose.
 */
export const NOTICE_CATEGORIES = [
  "waiting",
  "replies",
  "mentions",
  "threads",
  "tasks",
  "routines",
  "computers",
  "reactions",
] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

/** The kinds of each category. Anything waiting on the person is `waiting`, whatever its kind. */
export const NOTICE_KINDS: Record<NoticeCategory, readonly NotificationKind[]> = {
  waiting: ["approval", "agent_question", "browser_handoff", "secret_request", "join_request"],
  replies: ["agent_reply", "run_failed"],
  mentions: ["mention", "dm"],
  threads: ["thread_reply"],
  tasks: ["issue_assigned", "issue_comment", "issue_status"],
  routines: [
    "mission_stopped",
    "routine_failed",
    "routine_paused",
    "routine_stalled",
    "agent_unreached",
    "routine_waiting_plan",
  ],
  computers: ["machine_connected", "computer_ready", "plan_reset_unknown", "device.in_use", "device.waiting"],
  reactions: ["reaction"],
};

export const NOTICE_DEFAULTS: Record<NoticeCategory, boolean> = {
  waiting: true,
  replies: true,
  mentions: true,
  threads: false,
  tasks: false,
  routines: true,
  computers: true,
  reactions: false,
};

export type NoticePrefs = Partial<Record<NoticeCategory, boolean>>;

const isCategory = (value: unknown): value is NoticeCategory =>
  typeof value === "string" && (NOTICE_CATEGORIES as readonly string[]).includes(value);

/** The category a notification falls in; null for kinds that never notify a device (the inbox shows them). */
export function noticeCategoryOf(kind: string, waiting: boolean): NoticeCategory | null {
  if (waiting) return "waiting";
  return NOTICE_CATEGORIES.find((c) => (NOTICE_KINDS[c] as readonly string[]).includes(kind)) ?? null;
}

/** Whether this notification reaches the person's devices, given their choices. */
export function noticeOn(prefs: NoticePrefs, kind: string, waiting: boolean): boolean {
  const category = noticeCategoryOf(kind, waiting);
  return category !== null && (prefs[category] ?? NOTICE_DEFAULTS[category]);
}

/** Only known categories with a boolean: what a row holds is never trusted as is. */
export function noticePrefsOf(raw: unknown): NoticePrefs {
  if (!raw || typeof raw !== "object") return {};
  const out: NoticePrefs = {};
  for (const [key, value] of Object.entries(raw)) if (isCategory(key) && typeof value === "boolean") out[key] = value;
  return out;
}

export async function readNoticePrefs(db: Database, orgId: string, userId: string): Promise<NoticePrefs> {
  const [row] = await db
    .select({ prefs: organizationMembers.noticePrefs })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return noticePrefsOf(row?.prefs);
}

export interface NoticePrefsView {
  categories: { id: NoticeCategory; on: boolean }[];
  /** The person's phones that get pushes (the phone app, any workspace): the settings say where they arrive. */
  phones: number;
}

/** The person's choices in this workspace, every category in order, and how many phones they have. */
export async function noticePrefsView(db: Database, orgId: string, userId: string): Promise<NoticePrefsView> {
  await requirePermission(db, userId, orgId, "read");
  const prefs = await readNoticePrefs(db, orgId, userId);
  const [phones] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pushDevices)
    .where(and(eq(pushDevices.userId, userId), sql`${pushDevices.platform} <> 'web'`));
  return {
    categories: NOTICE_CATEGORIES.map((id) => ({ id, on: prefs[id] ?? NOTICE_DEFAULTS[id] })),
    phones: phones?.n ?? 0,
  };
}

/** Turns one category on or off for the person in this workspace (one key of the row's JSON). */
export async function setNoticePref(
  db: Database,
  orgId: string,
  userId: string,
  category: NoticeCategory,
  on: boolean,
): Promise<NoticePrefsView> {
  await requirePermission(db, userId, orgId, "read");
  await db
    .update(organizationMembers)
    .set({
      noticePrefs: sql`${organizationMembers.noticePrefs} || jsonb_build_object(${category}::text, ${on}::boolean)`,
    })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return noticePrefsView(db, orgId, userId);
}
