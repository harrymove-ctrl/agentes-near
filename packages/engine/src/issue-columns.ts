import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import type { IssueStatus } from "./issues";
import { can, requireActiveMembership } from "./organizations";

const { issueColumns, issues, issueActivity } = schema;

/** The stages a board column can sit in, in board order (canceled stays out of the board). */
export const BOARD_STAGES: readonly IssueStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];

/** A board column. `name` null: the stage's own name, in the reader's language. */
export interface IssueColumnView {
  id: string;
  stage: IssueStatus;
  name: string | null;
  position: number;
}

type ColumnRow = typeof issueColumns.$inferSelect;

const view = (c: ColumnRow): IssueColumnView => ({ id: c.id, stage: c.stage, name: c.name, position: c.position });
const stageOrder = (s: IssueStatus) => BOARD_STAGES.indexOf(s);
const sortColumns = (rows: ColumnRow[]) =>
  [...rows].sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.position - b.position);

/** The org's columns, board order; the first use creates one per stage. */
export async function boardColumns(db: Database, orgId: string): Promise<ColumnRow[]> {
  const rows = await db.select().from(issueColumns).where(eq(issueColumns.orgId, orgId));
  if (rows.length > 0) return sortColumns(rows);
  // Two first readers at once must not both seed: the lock serializes them.
  const seeded = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue_columns:${orgId}`}))`);
    const again = await tx.select().from(issueColumns).where(eq(issueColumns.orgId, orgId));
    if (again.length > 0) return again;
    return tx
      .insert(issueColumns)
      .values(BOARD_STAGES.map((stage) => ({ orgId, stage, name: null, position: 0 })))
      .returning();
  });
  return sortColumns(seeded);
}

/** Where an issue sits on the board: its column, or the first column of its stage. */
export function columnOf(columns: ColumnRow[], issue: { status: IssueStatus; columnId: string | null }) {
  const own = issue.columnId ? columns.find((c) => c.id === issue.columnId && c.stage === issue.status) : undefined;
  return own ?? columns.find((c) => c.stage === issue.status) ?? null;
}

/** On top of a column: lower ranks come first, and later moves get lower ranks. */
export const topRank = () => -Date.now();

export interface ColumnDeps {
  db: Database;
  pubsub?: PubSub;
}

async function requirePoster(db: Database, userId: string, orgId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError();
}

async function announce(deps: ColumnDeps, orgId: string) {
  const columns = (await boardColumns(deps.db, orgId)).map(view);
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "issue.columns", columns } });
  return columns;
}

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 40);
  if (!n) throw new ValidationError("name is required");
  return n;
};

export async function listIssueColumns(db: Database, userId: string, orgId: string): Promise<IssueColumnView[]> {
  await requireActiveMembership(db, userId, orgId);
  return (await boardColumns(db, orgId)).map(view);
}

/** Columns a stage holds at most (the board's add dialog mirrors it: packages/client/src/lib/issues.ts). */
const STAGE_COLUMNS_MAX = 10;

/** Adds a column to a stage: right after `afterId` when it is in the same stage, else at the stage's end. */
export async function createIssueColumn(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  input: { name: string; stage: IssueStatus; afterId?: string | null },
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  if (!BOARD_STAGES.includes(input.stage)) throw new ValidationError("invalid stage");
  const name = cleanName(input.name);
  const inStage = (await boardColumns(deps.db, orgId)).filter((c) => c.stage === input.stage);
  if (inStage.length >= STAGE_COLUMNS_MAX) {
    throw new ValidationError(`A stage holds at most ${STAGE_COLUMNS_MAX} columns`, "issue_column.stage_full", {
      max: STAGE_COLUMNS_MAX,
    });
  }
  const at = input.afterId ? inStage.findIndex((c) => c.id === input.afterId) : -1;
  const before = at >= 0 ? inStage[at] : inStage.at(-1);
  const next = at >= 0 ? inStage[at + 1] : undefined;
  const position = !before ? 0 : next ? (before.position + next.position) / 2 : before.position + 1;
  await deps.db.insert(issueColumns).values({ orgId, stage: input.stage, name, position });
  return announce(deps, orgId);
}

/** Renames a column, or moves it inside its stage (`index`: its place among the stage's columns). */
export async function updateIssueColumn(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  columnId: string,
  patch: { name?: string; index?: number },
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  const columns = await boardColumns(deps.db, orgId);
  const column = columns.find((c) => c.id === columnId);
  if (!column) throw new NotFoundError("Column not found");
  if (patch.name !== undefined) {
    await deps.db
      .update(issueColumns)
      .set({ name: cleanName(patch.name) })
      .where(eq(issueColumns.id, column.id));
  }
  if (patch.index !== undefined) {
    const others = columns.filter((c) => c.stage === column.stage && c.id !== column.id);
    const at = Math.max(0, Math.min(others.length, Math.trunc(patch.index)));
    const order = [...others.slice(0, at), column, ...others.slice(at)];
    await deps.db.transaction(async (tx) => {
      for (const [i, c] of order.entries()) {
        if (c.position !== i) await tx.update(issueColumns).set({ position: i }).where(eq(issueColumns.id, c.id));
      }
    });
  }
  return announce(deps, orgId);
}

/**
 * Deletes a column; its issues go to `moveTo` (and to that column's stage,
 * which is an event in each one's activity). A stage keeps at least one column.
 */
export async function deleteIssueColumn(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  columnId: string,
  moveTo: string,
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  const columns = await boardColumns(deps.db, orgId);
  const column = columns.find((c) => c.id === columnId);
  const target = columns.find((c) => c.id === moveTo);
  if (!column) throw new NotFoundError("Column not found");
  if (!target || target.id === column.id) throw new ValidationError("Choose another column for its tasks");
  if (!columns.some((c) => c.stage === column.stage && c.id !== column.id)) {
    throw new ValidationError("Each stage keeps at least one column");
  }
  // Issues with no column sit in the stage's first column: when that is the one going away, they move too.
  const firstOfStage = columns.find((c) => c.stage === column.stage)?.id === column.id;
  await deps.db.transaction(async (tx) => {
    const moving = await tx
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, orgId),
          firstOfStage
            ? sql`(${issues.columnId} = ${column.id} or (${issues.columnId} is null and ${issues.status} = ${column.stage}))`
            : eq(issues.columnId, column.id),
        ),
      );
    for (const m of moving) {
      await tx
        .update(issues)
        .set({ columnId: target.id, status: target.stage, updatedAt: new Date() })
        .where(eq(issues.id, m.id));
      if (m.status !== target.stage) {
        await tx.insert(issueActivity).values({
          orgId,
          issueId: m.id,
          kind: "event",
          authorType: "person",
          authorId: userId,
          text: `moved to ${target.name ?? target.stage} (its column was deleted)`,
          event: "status_changed",
          data: { from: m.status, to: target.stage },
        });
      }
    }
    await tx.delete(issueColumns).where(eq(issueColumns.id, column.id));
  });
  return announce(deps, orgId);
}

/** Validates a column of the org for an issue move. */
export async function columnForMove(db: Database, orgId: string, columnId: string) {
  const [column] = await db
    .select()
    .from(issueColumns)
    .where(and(eq(issueColumns.id, columnId), eq(issueColumns.orgId, orgId)));
  if (!column) throw new ValidationError("That column does not exist");
  return column;
}
