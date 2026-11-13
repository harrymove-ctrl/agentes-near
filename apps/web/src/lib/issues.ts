import type { Issue, IssueColumn, IssueStatus } from "@agenteschat/client";
import { BOARD, STATUSES } from "@agenteschat/client/lib/issues";
import { stepPhrase } from "@agenteschat/client/lib/work";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { lookOf } from "@/lib/look";

export * from "@agenteschat/client/lib/issues";

/** The agent's color for the pixel pieces (people and nobody: neutral). */
export function useAssigneeColor() {
  const { dir } = useActors();
  return (i: Pick<Issue, "assignee">) =>
    i.assignee?.type === "agent" ? (lookOf(dir.agentById.get(i.assignee.id))?.color ?? "sky") : null;
}

/** The step an agent is on, in the person's words ("Atualizou uma tarefa · #131", "Rodou: Rerun the tests"). */
export function useStepText() {
  const { t } = useTranslation();
  return (step: Parameters<typeof stepPhrase>[1] | undefined) => (step ? stepPhrase(t, step) : "");
}

// ── The board: one per org, custom columns, each in a fixed stage ───────────

/** A column's title: its own name, or the stage's ("A fazer"; "Canceladas" for the canceled one). */
export function columnTitle(col: Pick<IssueColumn, "name" | "stage">, stageName: (stage: IssueStatus) => string) {
  return col.name?.trim() || stageName(col.stage);
}

/** Customized: some stage has more than one column, or a column has its own name. */
export function isCustomBoard(columns: IssueColumn[]) {
  return (
    columns.some((c) => c.name !== null && c.name.trim() !== "") ||
    BOARD.some((st) => columns.filter((c) => c.stage === st).length > 1)
  );
}

/** A stage's columns, in board order. */
export const columnsOf = (columns: IssueColumn[], stage: IssueStatus) =>
  columns.filter((c) => c.stage === stage).sort((a, b) => a.position - b.position);

/** The stages on the board with their columns (canceled only when asked). */
export function boardStages(columns: IssueColumn[], showCanceled: boolean) {
  const stages: IssueStatus[] = showCanceled ? STATUSES : BOARD;
  return stages.map((stage) => ({ stage, columns: columnsOf(columns, stage) }));
}

/** Where an issue sits: its column when it is one of its stage, else the first column of its stage. */
export function columnIdOf(issue: Pick<Issue, "columnId" | "status">, columns: IssueColumn[]) {
  const own = issue.columnId ? columns.find((c) => c.id === issue.columnId) : undefined;
  if (own && own.stage === issue.status) return own.id;
  return columnsOf(columns, issue.status)[0]?.id ?? null;
}

/** Issues by column id, each column ordered by `boardRank` (lowest first, then newest number). */
export function groupByColumn<T extends Pick<Issue, "columnId" | "status" | "boardRank" | "number">>(
  issues: T[],
  columns: IssueColumn[],
) {
  const out = new Map<string, T[]>(columns.map((c) => [c.id, []]));
  for (const i of issues) {
    const id = columnIdOf(i, columns);
    if (id) out.get(id)?.push(i);
  }
  for (const list of out.values()) list.sort((a, b) => a.boardRank - b.boardRank || b.number - a.number);
  return out;
}

/** The rank for a card dropped at `index` among `others` (the column's cards without it, in order). */
export function rankAt(others: Pick<Issue, "boardRank">[], index: number, now = Date.now()) {
  const first = others[0];
  const last = others.at(-1);
  if (!first || !last) return -now;
  if (index <= 0) return first.boardRank - 1000;
  if (index >= others.length) return last.boardRank + 1000;
  const before = others[index - 1]?.boardRank ?? first.boardRank;
  const after = others[index]?.boardRank ?? last.boardRank;
  return (before + after) / 2;
}

/** A stage's name in the person's language ("Canceladas" for the canceled stage, as a column holds many). */
export function useStageName() {
  const { t } = useTranslation();
  return (stage: IssueStatus) => (stage === "canceled" ? t("issues.canceledColumn") : t(`issues.status.${stage}`));
}

/** A column's title: its own name, or its stage's. */
export function useColumnTitle() {
  const stageName = useStageName();
  return (col: Pick<IssueColumn, "name" | "stage">) => columnTitle(col, stageName);
}
