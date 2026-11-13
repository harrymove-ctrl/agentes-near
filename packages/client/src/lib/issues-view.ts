import type { IssueCardField, IssuePriority, IssuesView } from "../api/types";

/** What a card can show besides its number and title, in the order the screen offers them. */
export const ISSUE_CARD_FIELDS: readonly IssueCardField[] = [
  "assignee",
  "priority",
  "due",
  "criteria",
  "pullRequest",
  "label",
];

/** The groups a board or list can be split into, and the orders inside each group. */
export const ISSUES_GROUPS: readonly IssuesView["group"][] = ["stage", "assignee", "priority"];
export const ISSUES_SORTS: readonly IssuesView["sort"][] = ["manual", "priority", "due"];

/** Priorities from the most to the least urgent: the priority groups and the priority order. */
export const PRIORITY_ORDER: readonly IssuePriority[] = ["high", "normal", "low"];

/**
 * What someone who never changed Tarefas sees: the board by stage, every field, no filter (mirrors
 * `ISSUES_VIEW_DEFAULT`, packages/engine/src/issues-view.ts).
 */
export const ISSUES_VIEW_DEFAULT: IssuesView = {
  layout: "board",
  group: "stage",
  sort: "manual",
  fields: { assignee: true, priority: true, due: true, criteria: true, pullRequest: true, label: true },
  assignees: [],
  priorities: [],
  showCanceled: false,
};

/** A change to a view: any of its parts, the fields one by one. */
export type IssuesViewChange = Partial<Omit<IssuesView, "fields">> & { fields?: Partial<IssuesView["fields"]> };

/** `view` with `change` applied. */
export const withIssuesView = (view: IssuesView, change: IssuesViewChange): IssuesView => ({
  ...view,
  ...change,
  fields: { ...view.fields, ...change.fields },
});

/** Whether the view is the one everybody starts with ("Voltar ao padrão" only shows when it isn't). */
export function isDefaultIssuesView(view: IssuesView) {
  const d = ISSUES_VIEW_DEFAULT;
  return (
    view.layout === d.layout &&
    view.group === d.group &&
    view.sort === d.sort &&
    view.showCanceled === d.showCanceled &&
    view.assignees.length === 0 &&
    view.priorities.length === 0 &&
    ISSUE_CARD_FIELDS.every((f) => view.fields[f] === d.fields[f])
  );
}

const PRIORITY_RANK: Record<IssuePriority, number> = { high: 0, normal: 1, low: 2 };
/** Without a due date: after every dated one. */
const NO_DUE = "9999-12-31";

/**
 * A group's cards in the view's order: as they are (`manual`, the board's own order), most urgent first, or soonest
 * due first. Ties keep the order they came in.
 */
export function sortIssues<T extends { priority: IssuePriority; dueDate: string | null }>(
  list: T[],
  sort: IssuesView["sort"],
): T[] {
  if (sort === "priority") return [...list].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  if (sort === "due") return [...list].sort((a, b) => (a.dueDate ?? NO_DUE).localeCompare(b.dueDate ?? NO_DUE));
  return list;
}
