import { describe, expect, test } from "bun:test";
import type { IssueColumn, IssueStatus } from "@agenteschat/client";
import { boardStages, columnIdOf, columnTitle, groupByColumn, isCustomBoard, rankAt } from "../src/lib/issues";

const col = (id: string, stage: IssueStatus, position = 0, name: string | null = null): IssueColumn => ({
  id,
  stage,
  name,
  position,
});
const defaults = [
  col("todo", "todo"),
  col("prog", "in_progress"),
  col("rev", "in_review"),
  col("done", "done"),
  col("cx", "canceled"),
];
const issue = (number: number, status: IssueStatus, columnId: string | null, boardRank: number) => ({
  number,
  status,
  columnId,
  boardRank,
});

describe("the task board", () => {
  test("a default board is not customized; a second column or a name makes it so", () => {
    expect(isCustomBoard(defaults)).toBe(false);
    expect(isCustomBoard([...defaults, col("week", "todo", 1)])).toBe(true);
    expect(isCustomBoard([col("todo", "todo", 0, "Ideias"), ...defaults.slice(1)])).toBe(true);
    // A second canceled column alone doesn't show stage headers.
    expect(isCustomBoard([...defaults, col("cx2", "canceled", 1)])).toBe(false);
  });

  test("stages in board order with their columns by position; canceled only when asked", () => {
    const cols = [...defaults, col("ideas", "todo", -1, "Ideias")];
    const stages = boardStages(cols, false);
    expect(stages.map((s) => s.stage)).toEqual(["todo", "in_progress", "in_review", "done"]);
    expect(stages[0]?.columns.map((c) => c.id)).toEqual(["ideas", "todo"]);
    expect(boardStages(cols, true).at(-1)?.stage).toBe("canceled");
  });

  test("a column's title: its name, else its stage's", () => {
    const stageName = (s: IssueStatus) => `stage:${s}`;
    expect(columnTitle(col("a", "todo"), stageName)).toBe("stage:todo");
    expect(columnTitle(col("a", "todo", 0, "Ideias"), stageName)).toBe("Ideias");
    expect(columnTitle(col("a", "todo", 0, "  "), stageName)).toBe("stage:todo");
  });

  test("an issue sits in its column, or the first of its stage when the column is missing or of another stage", () => {
    const cols = [...defaults, col("week", "todo", 1)];
    expect(columnIdOf(issue(1, "todo", "week", 0), cols)).toBe("week");
    expect(columnIdOf(issue(1, "todo", null, 0), cols)).toBe("todo");
    expect(columnIdOf(issue(1, "in_review", "week", 0), cols)).toBe("rev");
    expect(columnIdOf(issue(1, "todo", "gone", 0), cols)).toBe("todo");
  });

  test("cards group by column, lowest rank first (newest number on ties)", () => {
    const cols = [...defaults, col("week", "todo", 1)];
    const map = groupByColumn(
      [
        issue(1, "todo", "todo", 5),
        issue(2, "todo", "todo", -3),
        issue(3, "todo", "week", 0),
        issue(4, "todo", "todo", 5),
      ],
      cols,
    );
    expect(map.get("todo")?.map((i) => i.number)).toEqual([2, 4, 1]);
    expect(map.get("week")?.map((i) => i.number)).toEqual([3]);
    expect(map.get("done")).toEqual([]);
  });

  test("the rank where a card is dropped", () => {
    const others = [{ boardRank: -10 }, { boardRank: 0 }, { boardRank: 20 }];
    expect(rankAt([], 0, 5000)).toBe(-5000);
    expect(rankAt(others, 0)).toBe(-1010);
    expect(rankAt(others, 3)).toBe(1020);
    expect(rankAt(others, 1)).toBe(-5);
    expect(rankAt(others, 2)).toBe(10);
  });
});
