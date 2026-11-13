import { afterEach, describe, expect, test } from "bun:test";
import {
  createIssue,
  createIssueColumn,
  deleteIssueColumn,
  ForbiddenError,
  listIssueColumns,
  updateIssue,
  updateIssueColumn,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};

describe("board columns", () => {
  test("one column per stage at first; custom columns sit in a stage; the status moves to the stage's first column", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const first = await listIssueColumns(f.db, f.owner.id, f.org.id);
    expect(first.map((c) => [c.stage, c.name])).toEqual([
      ["todo", null],
      ["in_progress", null],
      ["in_review", null],
      ["done", null],
      ["canceled", null],
    ]);
    const todo = must(first[0]).id;
    let cols = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Esta semana", stage: "todo" });
    cols = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Ideias", stage: "todo", afterId: todo });
    expect(cols.filter((c) => c.stage === "todo").map((c) => c.name)).toEqual([null, "Ideias", "Esta semana"]);
    cols = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Design", stage: "in_progress" });
    const thisWeek = must(cols.find((c) => c.name === "Esta semana"));
    const design = must(cols.find((c) => c.name === "Design"));

    const issue = await createIssue(deps, ana, f.org.id, { title: "Tela nova" });
    expect(issue.columnId).toBe(todo);
    // A column moves the issue to its stage.
    const moved = await updateIssue(deps, ana, f.org.id, issue.id, { columnId: thisWeek.id, boardRank: 5 });
    expect(moved).toMatchObject({ status: "todo", columnId: thisWeek.id, boardRank: 5 });
    const working = await updateIssue(deps, ana, f.org.id, issue.id, { columnId: design.id });
    expect(working).toMatchObject({ status: "in_progress", columnId: design.id });
    // A bare status change (as the system does) lands in the stage's first column, on top.
    const review = await updateIssue(deps, ana, f.org.id, issue.id, { status: "in_review" });
    const reviewCol = must(cols.find((c) => c.stage === "in_review"));
    expect(review.columnId).toBe(reviewCol.id);
    expect(review.boardRank).toBeLessThan(0);

    // Reorder inside the stage, rename.
    cols = await updateIssueColumn(deps, f.owner.id, f.org.id, thisWeek.id, { index: 0, name: "Semana" });
    expect(cols.filter((c) => c.stage === "todo").map((c) => c.name)).toEqual(["Semana", null, "Ideias"]);
  });

  test("a stage holds at most 10 columns: the eleventh is refused with a code the apps word", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    for (let i = 1; i < 10; i++) await createIssueColumn(deps, f.owner.id, f.org.id, { name: `C${i}`, stage: "todo" });
    const refused = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "C10", stage: "todo" }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ValidationError);
    expect(refused).toMatchObject({ code: "issue_column.stage_full", params: { max: 10 } });
  });

  test("deleting a column moves its tasks; a stage keeps one column; members only", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const cols = await listIssueColumns(f.db, f.owner.id, f.org.id);
    const todo = must(cols[0]);
    const progress = must(cols[1]);
    await expect(deleteIssueColumn(deps, f.owner.id, f.org.id, todo.id, progress.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    const withQa = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "QA", stage: "todo" });
    const qa = must(withQa.find((c) => c.name === "QA"));
    const issue = await createIssue(deps, ana, f.org.id, { title: "Bug" });
    await updateIssue(deps, ana, f.org.id, issue.id, { columnId: qa.id });
    // The first column goes away: tasks with no column (here none) and the QA ones go to "in progress".
    const left = await deleteIssueColumn(deps, f.owner.id, f.org.id, qa.id, progress.id);
    expect(left.some((c) => c.id === qa.id)).toBe(false);
    const after = await updateIssue(deps, ana, f.org.id, issue.id, {});
    expect(after).toMatchObject({ status: "in_progress", columnId: progress.id });

    await expect(listIssueColumns(f.db, "someone-else", f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
