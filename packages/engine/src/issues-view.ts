import { and, type Database, eq, schema } from "@agenteschat/db";
import { requirePermission } from "./organizations";

const { organizationMembers } = schema;

/**
 * How a person looks at Tarefas in a workspace (`organization_members.issues_view`): a board or a list, grouped by
 * stage, assignee or priority, the order inside each group, what the cards show, the assignee and priority filters,
 * and whether canceled tasks show. It lives on the server so the web, the desktop app and the phone open the screen
 * the same way; the search text is never kept. Mirrors `ISSUES_VIEW_DEFAULT` in packages/client/src/lib/issues-view.ts.
 */
export const ISSUES_LAYOUTS = ["board", "list"] as const;
export type IssuesLayout = (typeof ISSUES_LAYOUTS)[number];
export const ISSUES_GROUPS = ["stage", "assignee", "priority"] as const;
export type IssuesGroup = (typeof ISSUES_GROUPS)[number];
export const ISSUES_SORTS = ["manual", "priority", "due"] as const;
export type IssuesSort = (typeof ISSUES_SORTS)[number];
/** What a card can show besides its number and title. */
export const ISSUE_CARD_FIELDS = ["assignee", "priority", "due", "criteria", "pullRequest", "label"] as const;
export type IssueCardField = (typeof ISSUE_CARD_FIELDS)[number];
export const ISSUES_VIEW_PRIORITIES = ["high", "normal", "low"] as const;
/** An assignee filter: `agent:<id>`, `person:<id>` or `none` (no assignee). */
export const ISSUES_VIEW_ASSIGNEE = /^(none|agent:[A-Za-z0-9_-]{1,100}|person:[A-Za-z0-9_-]{1,100})$/;
/** More than anyone picks by hand: a row never grows past this. */
export const ISSUES_VIEW_MAX_ASSIGNEES = 50;

/** A type, not an interface: the row's jsonb column takes it as a plain record. */
export type IssuesView = {
  layout: IssuesLayout;
  group: IssuesGroup;
  sort: IssuesSort;
  fields: Record<IssueCardField, boolean>;
  /** Only tasks with one of these assignees (empty: every task). */
  assignees: string[];
  /** Only tasks with one of these priorities (empty: every task). */
  priorities: (typeof ISSUES_VIEW_PRIORITIES)[number][];
  showCanceled: boolean;
};

/** What someone who never changed the screen sees: today's board by stage, every field, no filter. */
export const ISSUES_VIEW_DEFAULT: IssuesView = {
  layout: "board",
  group: "stage",
  sort: "manual",
  fields: { assignee: true, priority: true, due: true, criteria: true, pullRequest: true, label: true },
  assignees: [],
  priorities: [],
  showCanceled: false,
};

const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;

const record = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

/**
 * A view from what a row (or a request) holds: known keys with known values only, each missing or unknown one at its
 * default, filters without repeats. What is stored is never trusted as is.
 */
export function issuesViewOf(raw: unknown): IssuesView {
  const v = record(raw);
  const fields = record(v.fields);
  const assignees = Array.isArray(v.assignees) ? v.assignees : [];
  const priorities = Array.isArray(v.priorities) ? v.priorities : [];
  return {
    layout: pick(ISSUES_LAYOUTS, v.layout, ISSUES_VIEW_DEFAULT.layout),
    group: pick(ISSUES_GROUPS, v.group, ISSUES_VIEW_DEFAULT.group),
    sort: pick(ISSUES_SORTS, v.sort, ISSUES_VIEW_DEFAULT.sort),
    fields: Object.fromEntries(
      ISSUE_CARD_FIELDS.map((f) => [f, typeof fields[f] === "boolean" ? fields[f] : ISSUES_VIEW_DEFAULT.fields[f]]),
    ) as IssuesView["fields"],
    assignees: [
      ...new Set(assignees.filter((a): a is string => typeof a === "string" && ISSUES_VIEW_ASSIGNEE.test(a))),
    ].slice(0, ISSUES_VIEW_MAX_ASSIGNEES),
    priorities: ISSUES_VIEW_PRIORITIES.filter((p) => priorities.includes(p)),
    showCanceled: typeof v.showCanceled === "boolean" ? v.showCanceled : ISSUES_VIEW_DEFAULT.showCanceled,
  };
}

const mine = (orgId: string, userId: string) =>
  and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId));

/** How the person left Tarefas in this workspace (the default when they never changed it). */
export async function myIssuesView(db: Database, orgId: string, userId: string): Promise<IssuesView> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ view: organizationMembers.issuesView })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return issuesViewOf(row?.view);
}

/** Saves how the person looks at Tarefas in this workspace, cleaned first; answers with what was kept. */
export async function setMyIssuesView(db: Database, orgId: string, userId: string, view: unknown): Promise<IssuesView> {
  await requirePermission(db, userId, orgId, "read");
  const clean = issuesViewOf(view);
  await db.update(organizationMembers).set({ issuesView: clean }).where(mine(orgId, userId));
  return clean;
}
