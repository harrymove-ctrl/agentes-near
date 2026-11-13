import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Issue, IssueColumn } from "@agenteschat/client";
import { githubLinkLabel, isGithubLink } from "@agenteschat/client/lib/github-link";
import { conversationLine } from "@agenteschat/client/lib/issues";
import { cardPreview, cardShape, driveSections, gridRows, kindKey, matchesType } from "../../src/features/drive/logic";
import {
  columnChoices,
  columnOfIssue,
  criteriaProgress,
  currentStep,
  dueDateOf,
  isLate,
  issueBoard,
  issueNumberOf,
  issueSections,
  issueState,
  latestPr,
  listState,
  minutesSince,
  passesFilter,
  taskConversationHref,
  taskListSections,
  waitsOnYou,
  workLines,
} from "../../src/features/issues/logic";
import { at, translator } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);

function issue(over: Partial<Issue> & { number: number }): Issue {
  return {
    id: `i${over.number}`,
    title: `Issue ${over.number}`,
    description: "",
    status: "todo",
    priority: "normal",
    assignee: null,
    labels: [],
    dueDate: null,
    criteria: [],
    createdBy: { type: "person", id: "me" },
    source: { type: "manual" },
    channelId: null,
    pullRequests: [],
    githubUrl: null,
    artifacts: [],
    work: null,
    columnId: null,
    boardRank: 0,
    createdAt: at(60, NOW),
    updatedAt: at(30, NOW),
    ...over,
  };
}

const work = (state: NonNullable<Issue["work"]>["state"], steps: { tool: string; at: string }[] = []) => ({
  agentId: "a1",
  runId: state === "stalled" ? null : "r1",
  state,
  since: at(6, NOW),
  steps,
});

describe("a row's state in the list", () => {
  test("says only what its section doesn't", () => {
    // The section already says these.
    expect(listState(issue({ number: 1 }))).toBeNull();
    expect(listState(issue({ number: 2, status: "in_progress" }))).toBeNull();
    expect(listState(issue({ number: 3, status: "in_review" }))).toBeNull();
    expect(listState(issue({ number: 4, status: "done" }))).toBeNull();
    // What happens inside a section shows.
    expect(listState(issue({ number: 5, status: "in_progress", work: work("running") }))).toBe("running");
    expect(listState(issue({ number: 6, work: work("waiting_input") }))).toBe("waiting");
    expect(listState(issue({ number: 7, status: "in_progress", work: work("stalled") }))).toBe("stalled");
    const pr = [{ number: 212, url: "https://x", openedBy: null }];
    expect(listState(issue({ number: 8, status: "in_review", pullRequests: pr }))).toBe("review");
  });
});

describe("issue state", () => {
  test("follows the run, then the status (no manual 'working')", () => {
    expect(issueState(issue({ number: 1 }))).toBe("todo");
    expect(issueState(issue({ number: 2, status: "in_progress", work: work("running") }))).toBe("running");
    expect(issueState(issue({ number: 3, status: "in_progress", work: work("waiting_input") }))).toBe("waiting");
    expect(issueState(issue({ number: 4, status: "in_progress", work: work("waiting_approval") }))).toBe("waiting");
    expect(issueState(issue({ number: 5, status: "in_progress", work: work("stalled") }))).toBe("stalled");
    expect(issueState(issue({ number: 6, status: "in_review" }))).toBe("review");
    // A run alive on an issue in review still reads as working.
    expect(issueState(issue({ number: 7, status: "in_review", work: work("running") }))).toBe("running");
    expect(issueState(issue({ number: 8, status: "in_progress" }))).toBe("progress");
    expect(issueState(issue({ number: 9, status: "done", work: work("running") }))).toBe("done");
    expect(issueState(issue({ number: 10, status: "canceled" }))).toBe("canceled");
  });

  test("waits on you only while open and the agent waits", () => {
    expect(waitsOnYou(issue({ number: 1, status: "in_progress", work: work("waiting_input") }))).toBe(true);
    expect(waitsOnYou(issue({ number: 2, status: "in_progress", work: work("running") }))).toBe(false);
  });
});

describe("issue filters and sections", () => {
  const list = [
    issue({
      number: 134,
      status: "in_progress",
      priority: "high",
      assignee: { type: "agent", id: "a1" },
      work: work("running"),
    }),
    issue({
      number: 131,
      status: "in_review",
      assignee: { type: "agent", id: "a2" },
      pullRequests: [{ number: 212, url: "https://x", openedBy: null }],
    }),
    issue({ number: 129, status: "in_progress", assignee: { type: "agent", id: "a3" }, work: work("waiting_input") }),
    issue({ number: 127, dueDate: "2026-10-23", assignee: { type: "agent", id: "a4" } }),
    issue({ number: 126, assignee: { type: "person", id: "me" } }),
    issue({ number: 120, status: "done", updatedAt: at(5, NOW) }),
    issue({ number: 119, status: "canceled", updatedAt: at(50, NOW) }),
  ];

  test("each filter", () => {
    const nums = (f: Parameters<typeof passesFilter>[1]) =>
      list.filter((i) => passesFilter(i, f, "me")).map((i) => i.number);
    expect(nums("open")).toEqual([134, 131, 129, 127, 126]);
    expect(nums("mine")).toEqual([129, 126]);
    expect(nums("agents")).toEqual([134, 131, 129, 127]);
    expect(nums("done")).toEqual([120, 119]);
  });

  test("the board: always four columns in the web's order, what waits first, canceled under Feito", () => {
    const board = issueBoard([
      issue({ number: 1, status: "in_progress" }),
      issue({ number: 2, status: "in_progress", work: work("running") }),
      issue({ number: 3, status: "in_progress", work: work("waiting_input") }),
      issue({ number: 4, status: "canceled" }),
    ]);
    expect(board.map((b) => [b.stage, b.count])).toEqual([
      ["todo", 0],
      ["in_progress", 3],
      ["in_review", 0],
      ["done", 1],
    ]);
    const working = board.find((b) => b.stage === "in_progress");
    expect(working?.groups[0]?.items.map((i) => i.number)).toEqual([3, 2, 1]);
  });

  const shape = (sections: ReturnType<typeof issueSections>) =>
    sections.map((s) => [
      s.key,
      s.count,
      s.showColumns,
      s.groups.map((g) => [g.column?.id ?? null, g.items.map((i) => i.number)]),
    ]);

  test("open tasks by stage: in progress, in review, to do; columns not loaded yet", () => {
    expect(shape(issueSections(list, "open", "me"))).toEqual([
      ["in_progress", 2, false, [[null, [134, 129]]]],
      ["in_review", 1, false, [[null, [131]]]],
      ["todo", 2, false, [[null, [127, 126]]]],
    ]);
  });

  test("closed ones: done, then canceled; empty stages are left out", () => {
    expect(shape(issueSections(list, "done", "me"))).toEqual([
      ["done", 1, false, [[null, [120]]]],
      ["canceled", 1, false, [[null, [119]]]],
    ]);
    expect(issueSections([], "open", "me")).toEqual([]);
  });

  const col = (id: string, stage: IssueColumn["stage"], position: number, name: string | null = null): IssueColumn => ({
    id,
    stage,
    name,
    position,
  });
  const plain = [col("c1", "todo", 0), col("c2", "in_progress", 1), col("c3", "in_review", 2), col("c4", "done", 3)];

  test("one default column per stage: no column names, the board's order inside", () => {
    const tasks = [
      issue({ number: 1, columnId: "c1", boardRank: 3 }),
      issue({ number: 2, columnId: "c1", boardRank: 1 }),
      issue({ number: 3, columnId: "c1", boardRank: 2 }),
    ];
    expect(shape(issueSections(tasks, "open", null, plain))).toEqual([["todo", 3, false, [["c1", [2, 3, 1]]]]]);
  });

  test("a customized stage shows its columns in board order; empty columns are left out", () => {
    const board = [
      col("backlog", "todo", 0, "Backlog"),
      col("week", "todo", 1, "Esta semana"),
      col("idle", "todo", 2, "Algum dia"),
      col("doing", "in_progress", 3),
    ];
    const tasks = [
      issue({ number: 1, columnId: "week", boardRank: 2 }),
      issue({ number: 2, columnId: "backlog" }),
      issue({ number: 3, columnId: "week", boardRank: 1 }),
      // No column, or one of another stage: the stage's first column.
      issue({ number: 4, columnId: null, boardRank: 5 }),
      issue({ number: 5, status: "in_progress", columnId: "backlog" }),
    ];
    expect(shape(issueSections(tasks, "open", null, board))).toEqual([
      ["in_progress", 1, false, [["doing", [5]]]],
      [
        "todo",
        4,
        true,
        [
          ["backlog", [2, 4]],
          ["week", [3, 1]],
        ],
      ],
    ]);
  });

  test('on the board a customized A fazer shows each of its columns, empty ones too, for their "+"', () => {
    const board = [
      col("backlog", "todo", 0, "Backlog"),
      col("week", "todo", 1, "Esta semana"),
      col("doing", "in_progress", 2),
      col("later", "in_progress", 3, "Depois"),
    ];
    const tasks = [
      issue({ number: 1, columnId: "week" }),
      issue({ number: 2, status: "in_progress", columnId: "doing" }),
    ];
    const stages = issueBoard(tasks, board);
    const todo = stages.find((b) => b.stage === "todo");
    expect(todo?.showColumns).toBe(true);
    expect(todo?.groups.map((g) => [g.column?.id, g.items.map((i) => i.number)])).toEqual([
      ["backlog", []],
      ["week", [1]],
    ]);
    // Only A fazer takes a new task in a column: elsewhere an empty column stays out, as in the list.
    expect(stages.find((b) => b.stage === "in_progress")?.groups.map((g) => g.column?.id)).toEqual(["doing"]);
    // The default board: no column names, nothing added.
    expect(issueBoard([], plain).find((b) => b.stage === "todo")).toMatchObject({ showColumns: false, groups: [] });
  });

  test("a single column with its own name counts as customized", () => {
    const board = [col("triage", "todo", 0, "Triagem")];
    expect(issueSections([issue({ number: 1, columnId: "triage" })], "open", null, board)[0]?.showColumns).toBe(true);
  });

  test("the column a task sits in, and the picker's stages", () => {
    const board = [col("a", "todo", 0), col("b", "todo", 1, "Depois"), col("c", "done", 2)];
    expect(columnOfIssue({ columnId: "b", status: "todo" }, board)?.id).toBe("b");
    expect(columnOfIssue({ columnId: "c", status: "todo" }, board)?.id).toBe("a");
    expect(columnOfIssue({ columnId: null, status: "in_review" }, board)).toBeNull();
    expect(columnChoices(board).map((s) => [s.stage, s.columns.map((c) => c.id)])).toEqual([
      ["todo", ["a", "b"]],
      ["done", ["c"]],
    ]);
  });
});

describe("issue row details", () => {
  test("criteria, PR, current step, minutes", () => {
    expect(criteriaProgress(issue({ number: 1 }))).toBeNull();
    expect(
      criteriaProgress(
        issue({
          number: 2,
          criteria: [
            { id: "c1", text: "a", done: true },
            { id: "c2", text: "b", done: false },
          ],
        }),
      ),
    ).toEqual({ done: 1, total: 2 });
    expect(latestPr(issue({ number: 3 }))).toBeNull();
    const w = work("running", [
      { tool: "sentry", at: at(5, NOW) },
      { tool: "read_file", at: at(2, NOW) },
    ]);
    expect(currentStep(w)?.tool).toBe("read_file");
    expect(currentStep({ ...w, state: "stalled" })).toBeNull();
    expect(minutesSince(at(6, NOW), NOW.getTime())).toBe(6);
    expect(minutesSince(at(-3, NOW), NOW.getTime())).toBe(0);
  });

  test("the work card's steps: the same words in a row once with how many, refused or waiting never 'Rodou'", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    const check = (detail: string, minutes: number, outcome?: "refused" | "waiting") => ({
      tool: "permission_prompt",
      detail,
      at: at(minutes, NOW),
      ...(outcome ? { outcome } : {}),
    });
    const steps = [
      check("Run the unit tests", 6),
      check("Run the unit tests", 5),
      check("Run the unit tests", 4),
      check("rm /etc/agentes", 3, "refused"),
      { tool: "update_issue", detail: "#129", at: at(2, NOW) },
    ];
    // The last one goes on while the run works ("…").
    expect(workLines(pt, steps, true).map((l) => [l.text, l.step.at, l.last, l.going])).toEqual([
      ["Rodou: Run the unit tests ×3", at(4, NOW), false, false],
      ["Recusado: rm /etc/agentes", at(3, NOW), false, false],
      ["Atualizou uma tarefa · #129…", at(2, NOW), true, true],
    ]);
    expect(workLines(en, steps, false).map((l) => l.text)).toEqual([
      "Ran: Run the unit tests ×3",
      "Refused: rm /etc/agentes",
      "Updated a task · #129",
    ]);
    // One waiting on a person isn't going on by itself: its words without "…".
    expect(workLines(pt, [check("npm publish", 1, "waiting")], true).map((l) => l.text)).toEqual([
      "Rodando: npm publish",
    ]);
  });

  test("late only while open", () => {
    expect(isLate(issue({ number: 1, dueDate: "2026-10-16" }), NOW)).toBe(true);
    expect(isLate(issue({ number: 2, dueDate: "2026-10-17" }), NOW)).toBe(false);
    expect(isLate(issue({ number: 3, dueDate: "2026-10-16", status: "done" }), NOW)).toBe(false);
  });

  test("due choices (Saturday 17 Oct 2026)", () => {
    expect(dueDateOf("none", NOW)).toBeNull();
    expect(dueDateOf("today", NOW)).toBe("2026-10-17");
    expect(dueDateOf("tomorrow", NOW)).toBe("2026-10-18");
    expect(dueDateOf("friday", NOW)).toBe("2026-10-23");
    expect(dueDateOf("friday", new Date(2026, 9, 23, 9))).toBe("2026-10-30");
    expect(dueDateOf("friday", new Date(2026, 9, 21, 9))).toBe("2026-10-23");
    expect(dueDateOf("nextWeek", NOW)).toBe("2026-10-24");
  });

  test("Conversar: the task's own conversation, at a message when one is named", () => {
    const at = { channelId: "c1", rootId: "r1" };
    expect(taskConversationHref(at)).toBe("/chat/c1?thread=r1");
    expect(taskConversationHref(at, "m1")).toBe("/chat/c1?thread=r1&m=m1");
  });

  test("the conversation line: nothing until someone writes, then who, how many, working or when", () => {
    expect(conversationLine(issue({ number: 1 }))).toBeNull();
    const quiet = { channelId: "c1", rootId: "r1", count: 0, lastAt: null, participants: [], working: false };
    expect(conversationLine(issue({ number: 2, conversation: quiet }))).toBeNull();
    const people = ["u1", "u2", "u3", "u4"].map((id) => ({ type: "person" as const, id }));
    const busy = { ...quiet, count: 6, lastAt: "2026-11-04T10:00:00.000Z", participants: people, working: true };
    expect(conversationLine(issue({ number: 3, conversation: busy }))).toEqual({
      count: 6,
      people: people.slice(0, 3),
      working: true,
      lastAt: "2026-11-04T10:00:00.000Z",
    });
  });

  test("route numbers", () => {
    expect(issueNumberOf("134")).toBe(134);
    expect(issueNumberOf("0")).toBeNull();
    expect(issueNumberOf("12a")).toBeNull();
    expect(issueNumberOf(undefined)).toBeNull();
  });
});

function artifact(over: Partial<Artifact> & { id: string }): Artifact {
  return {
    kind: "document",
    title: "Doc",
    version: 1,
    channelId: null,
    threadId: null,
    createdBy: { type: "agent", id: "a1" },
    updatedBy: { type: "agent", id: "a1" },
    createdAt: at(60, NOW),
    updatedAt: at(60, NOW),
    canEdit: false,
    untrusted: false,
    ...over,
  };
}

describe("drive", () => {
  test("types by kind and, for uploads, by name", () => {
    const png = artifact({ id: "1", kind: "file", title: "home.png" });
    const pdf = artifact({ id: "2", kind: "file", title: "contrato.pdf" });
    const csv = artifact({ id: "3", kind: "file", title: "vendas.csv" });
    const doc = artifact({ id: "4" });
    const diff = artifact({ id: "5", kind: "diff" });
    const table = artifact({ id: "6", kind: "table" });
    const all = [png, pdf, csv, doc, diff, table];
    const ids = (t: Parameters<typeof matchesType>[1]) => all.filter((a) => matchesType(a, t)).map((a) => a.id);
    expect(ids("all")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(ids("documents")).toEqual(["2", "4"]);
    expect(ids("images")).toEqual(["1"]);
    expect(ids("tables")).toEqual(["3", "6"]);
    expect(ids("diffs")).toEqual(["5"]);
    expect(cardShape(png)).toBe("image");
    expect(cardShape(pdf)).toBe("file");
    expect(cardShape(artifact({ id: "7", kind: "diagram" }))).toBe("file");
    expect(kindKey(pdf)).toBe("document");
    expect(kindKey(artifact({ id: "8", kind: "file", title: "x.zip" }))).toBe("file");
  });

  test("sections: today, this week, then by month, newest first", () => {
    const list = [
      artifact({ id: "old", updatedAt: new Date(2026, 7, 3, 10).toISOString() }),
      artifact({ id: "today", updatedAt: at(30, NOW) }),
      artifact({ id: "sep2", updatedAt: new Date(2026, 8, 2, 10).toISOString() }),
      artifact({ id: "week", updatedAt: new Date(2026, 9, 14, 10).toISOString() }),
      artifact({ id: "sep1", updatedAt: new Date(2026, 8, 20, 10).toISOString() }),
    ];
    const s = driveSections(list, NOW);
    expect(s.map((x) => [x.key, x.items.map((a) => a.id)])).toEqual([
      ["today", ["today"]],
      ["week", ["week"]],
      ["2026-09", ["sep1", "sep2"]],
      ["2026-08", ["old"]],
    ]);
    expect(s[2]?.label).toEqual({ kind: "month", year: 2026, month: 8 });
    expect(gridRows([1, 2, 3])).toEqual([[1, 2], [3]]);
  });

  test("previews: document, table, diff, file", () => {
    expect(
      cardPreview("T", { kind: "document", markdown: "# Resultado\n\nVendas *subiram*.\n- 12%\n```\ncode\n```\nFim" }),
    ).toEqual({
      kind: "document",
      head: "Resultado",
      lines: ["Vendas subiram.", "12%", "Fim"],
    });
    expect(cardPreview("T", { kind: "document", markdown: "" })).toEqual({ kind: "document", head: "T", lines: [] });
    expect(
      cardPreview("T", {
        kind: "table",
        columns: ["Mês", "Meta", "Real", "Obs"],
        rows: [
          ["Set", "120k", "134k", "x"],
          ["Ago", "110k"],
          ["Jul", "1", "2"],
          ["Jun", "1", "2"],
          ["Mai", "1", "2"],
        ],
      }),
    ).toEqual({
      kind: "table",
      columns: ["Mês", "Meta", "Real"],
      rows: [
        ["Set", "120k", "134k"],
        ["Ago", "110k", ""],
        ["Jul", "1", "2"],
        ["Jun", "1", "2"],
      ],
    });
    const patch =
      "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-if (token) redirect()\n+if (token && !expired)\n+  redirect(next)\n same\n";
    expect(cardPreview("T", { kind: "diff", files: [{ path: "x", patch }] })).toEqual({
      kind: "diff",
      lines: [
        { kind: "del", text: "if (token) redirect()" },
        { kind: "add", text: "if (token && !expired)" },
        { kind: "add", text: "  redirect(next)" },
        { kind: "same", text: "same" },
      ],
    });
    const file = { kind: "file" as const, size: 1, sha256: "" };
    expect(cardPreview("x", { ...file, name: "a.png", contentType: "image/png" })).toEqual({ kind: "image" });
    expect(cardPreview("x", { ...file, name: "contrato.pdf", contentType: "application/pdf" })).toEqual({
      kind: "file",
      ext: "PDF",
    });
    expect(cardPreview("x", { kind: "html", html: "" })).toEqual({ kind: "file", ext: "HTML" });
  });
});

const read = (file: string) => Bun.file(new URL(`../../src/features/${file}`, import.meta.url).pathname).text();

describe("a task's number and title on one row; its conversation on the card", () => {
  test("the conversation line: how many, who (three faces), working or when; none before anyone wrote", () => {
    const talk = (count: number, working = false) => ({
      channelId: "c",
      rootId: "m",
      count,
      lastAt: at(4, NOW),
      participants: ["a", "b", "c", "d"].map((id) => ({ type: "person" as const, id })),
      working,
    });
    expect(conversationLine(issue({ number: 1 }))).toBeNull();
    expect(conversationLine(issue({ number: 2, conversation: null }))).toBeNull();
    expect(conversationLine(issue({ number: 3, conversation: talk(0) }))).toBeNull();
    const line = conversationLine(issue({ number: 4, conversation: talk(4) }));
    expect(line).toEqual({
      count: 4,
      people: ["a", "b", "c"].map((id) => ({ type: "person", id })),
      working: false,
      lastAt: at(4, NOW),
    });
    expect(conversationLine(issue({ number: 5, conversation: talk(2, true) }))?.working).toBe(true);
  });

  test("the board card in the web card's three parts: the title whole, one row of facts, who has it and one state", async () => {
    const parts = await read("issues/parts.tsx");
    const card = parts.slice(
      parts.indexOf("export const BoardCard"),
      parts.indexOf("const styles = StyleSheet.create("),
    );
    // The title whole: no number in it, never cut, its `code` as the inline code pill (as the web's card).
    expect(card).toContain('<TaskTitle title={i.title} variant="callout" style={styles.title} />');
    expect(card).not.toContain("numberOfLines");
    const title = parts.slice(parts.indexOf("export function TaskTitle("), parts.indexOf("const STATE_ICON"));
    expect(title).toContain("codeAndBoldParts(title)");
    expect(title).not.toContain("numberOfLines");
    // Then its facts, then who has it with its state.
    expect(card.indexOf("<CardFacts")).toBeGreaterThan(card.indexOf("{i.title}"));
    expect(card.indexOf("<AssigneeFace issue={i} size={24}")).toBeGreaterThan(card.indexOf("<CardFacts"));
    expect(card.indexOf("<StateWords")).toBeGreaterThan(card.indexOf("<AssigneeFace"));
    // One state, from the client's shared cardState (the web's too); waiting on a person, the agent's sky on top.
    expect(parts).toContain("cardState(i, Boolean(i.conversation?.working))");
    expect(parts).toContain("cardStateText(t, state)");
    expect(card).toContain("cardWaits(state) ?");
    expect(card.indexOf("cardWaits(state) ?")).toBeLessThan(card.indexOf("{i.title}"));
    // What the task's screen has leaves the card.
    for (const gone of ["StateLine", "CriteriaTrack", "BoardWork", "CardConversation"])
      expect(parts).not.toContain(gone);
    const facts = parts.slice(parts.indexOf("function CardFacts("), parts.indexOf("export const BoardCard"));
    // The number first, the label the only pill (+N after it in words), the date in words with its mark, GitHub's
    // mark with the PR and with the linked item, the mentions beside the conversation's count.
    expect(facts.indexOf("#{i.number}")).toBeLessThan(facts.indexOf("<Chip label={label} />"));
    expect(facts.match(/<Chip\b/g)).toHaveLength(1);
    expect(facts).toContain("+{labels.length}");
    expect(facts).toMatch(
      /<Icon name="clock" size=\{12\}[^>]*\/>\s*<Text[^>]*>\s*\{t\("mobile\.issues\.until", \{ date: due\.text \}\)\}/,
    );
    expect(facts).toContain("<MentionCount count={mentions} />");
    expect(facts.match(/provider="github"/g)).toHaveLength(2);
    expect(facts).toContain("{githubLinkLabel(i.githubUrl)}");
    expect(facts).not.toContain("GithubChip");
    const screen = await read("issues/IssueScreen.tsx");
    const head = screen.slice(screen.indexOf("function Head("), screen.indexOf("function WorkCard("));
    expect(head).toMatch(
      /accessibilityRole="header"[^>]*>\s*<Text variant="display2" tone="faint"[^>]*>\s*#\{i\.number\}/,
    );
    // "Criada por…" under the title, the number no longer in it.
    expect(head.indexOf('accessibilityRole="header"')).toBeLessThan(head.indexOf("{line}"));
    expect(head).not.toMatch(/`#\$\{i\.number\}`,/);
  });

  test("who has it: the face never alone on a line, on the name's first line; the sky fades in", async () => {
    const parts = await read("issues/parts.tsx");
    const card = parts.slice(
      parts.indexOf("export const BoardCard"),
      parts.indexOf("const styles = StyleSheet.create("),
    );
    // The face and the name in one group that doesn't wrap (the name wraps beside the face), the state after it.
    expect(card).toMatch(
      /<View style=\{styles\.person\}>\s*<View style=\{\[styles\.face, \{ marginTop: axis\.face \}\]\}>\s*<AssigneeFace/,
    );
    expect(card).toContain("paddingTop: axis.words");
    expect(card).toContain('mediaRowAxis(24, textLineOf("small", useFontScale()))');
    expect(parts).toMatch(/person: \{ flexDirection: "row", alignItems: "flex-start", gap: 8, flexShrink: 1 \}/);
    // An agent waiting on a person: its sky fades in over 200 ms, at once under reduced motion.
    expect(card).toContain("entering={reduced ? undefined : FadeIn.duration(200)}");
  });

  test("a row in the list says the card's one state in its words, else its due date; its title and name whole", async () => {
    const screen = await read("issues/IssuesScreen.tsx");
    const row = screen.slice(screen.indexOf("function TaskRow("), screen.indexOf("function Board("));
    expect(row).toContain("useCardState(i)");
    expect(row).toContain("<StateWords issue={i} state={state} words={words} />");
    expect(row).not.toContain("mobile.issues.waitsYou");
    expect(row).toContain('title={<TaskTitle title={i.title} variant="title" />}');
    expect(row).not.toContain("numberOfLines");
    expect(screen).toMatch(/subLine: \{ flexDirection: "row", flexWrap: "wrap",/);
  });

  test('A fazer\'s columns on the board take "+" for a task in them, for who may create tasks', async () => {
    const parts = await read("issues/parts.tsx");
    const header = parts.slice(
      parts.indexOf("export function ColumnHeader("),
      parts.indexOf("export function TaskTitle("),
    );
    expect(header).toContain(
      '<IconButton small icon="plus" label={t("issues.newIn", { column: label })} onPress={onNew} />',
    );
    // The name whole, its first line on the button's middle.
    expect(header).not.toContain("numberOfLines");
    expect(header).toContain("paddingTop: Math.max(0, (TOOL_H - line) / 2)");
    const screen = await read("issues/IssuesScreen.tsx");
    expect(screen).toContain('{...(mayNew && g.column.stage === "todo" ? { onNew: newIn(g.column.id) } : {})}');
    expect(screen).toContain('router.push({ pathname: "/issues/new", params: { column } })');
    expect(screen).toContain("<Board right={right} views={views} mayNew={mayNew} />");
    // Nova tarefa says the column and puts the task there (an agent picked starts it and moves it on).
    const form = await read("issues/NewIssueForm.tsx");
    expect(form).toContain("useLocalSearchParams<{ column?: string }>()");
    expect(form).toContain(
      '<GroupedRow icon="circle" label={t("issues.column")} sub={columnLabel(column)} subLines={0} />',
    );
    expect(form).toMatch(
      /if \(column && who\?\.type !== "agent" && columnOfIssue\(issue, columns\.data \?\? \[\]\)\?\.id !== column\.id\)\s*action\.mutate\(\{ type: "update", id: issue\.id, patch: \{ columnId: column\.id \} \}\);/,
    );
  });

  test("the task's head: its fields as the web's strip, in its order, each 32 high and opening its picker", async () => {
    const screen = await read("issues/IssueScreen.tsx");
    const head = screen.slice(screen.indexOf("function Head("), screen.indexOf("/** Pastes, changes or removes"));
    const fields = [...head.matchAll(/<PropChip\s+label=\{t\("([\w.]+)"\)\}[\s\S]*?onPress=\{pickers\.(\w+)\}/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(fields).toEqual([
      ["issues.column", "pickColumn"],
      ["issues.form.assignee", "pickAssignee"],
      ["issues.form.priority", "pickPriority"],
      ["issues.due", "pickDue"],
      ["whoSees.label", "pickWhoSees"],
    ]);
    // A control, not a pill: 32 high (the toolbar's), the web's control radius, its target grown to a finger's.
    expect(screen).toMatch(/prop: \{[^}]*minHeight: TOOL_H,[^}]*borderRadius: 10,/);
    // A long value (a column's name, seven people) wraps inside it, never cut, its mark on the first line.
    const chip = screen.slice(screen.indexOf("function PropChip("), screen.indexOf("/** Pastes, changes or removes"));
    expect(chip).not.toContain("numberOfLines");
    expect(chip).toContain('<View style={{ height: line, justifyContent: "center" }}>');
    expect(screen).toMatch(/prop: \{[^}]*alignItems: "flex-start",[^}]*paddingVertical: \(TOOL_H - PROP_LINE\) \/ 2,/);
    expect(head).toContain("hitSlop={{ top: (TOUCH - TOOL_H) / 2, bottom: (TOUCH - TOOL_H) / 2 }}");
    // The head and "…" open the same pickers.
    const menu = screen.slice(screen.indexOf("function IssueMenu("));
    for (const picker of ["pickColumn", "pickPriority", "pickAssignee", "pickWhoSees"])
      expect(menu).toContain(`pickers.${picker}`);
  });
});

describe("a task's GitHub link", () => {
  test("its chip says the repository and the number; only an issue or a PR is a link", () => {
    expect(githubLinkLabel("https://github.com/acme/app/pull/40/files")).toBe("app#40");
    expect(githubLinkLabel("https://github.com/acme/app/issues/12")).toBe("app#12");
    expect(isGithubLink("https://github.com/acme/app/issues/12")).toBe(true);
    expect(isGithubLink("https://github.com/acme/app")).toBe(false);
    expect(isGithubLink("https://evil.example/acme/app/issues/1")).toBe(false);
  });

  const source = (file: string) => readFileSync(join(import.meta.dir, "../../src/features/issues", file), "utf8");

  test("the card says the link with GitHub's mark, the task shows the chip and opens it, the menu edits it locked", () => {
    const parts = source("parts.tsx");
    const card = parts.slice(parts.indexOf("function CardFacts("), parts.indexOf("export const BoardCard"));
    expect(card).toContain("{githubLinkLabel(i.githubUrl)}");
    const screen = source("IssueScreen.tsx");
    expect(screen).toContain("<GithubChip url={i.githubUrl} />");
    expect(screen).toContain("webUrl(i.githubUrl)");
    expect(screen).toContain("sheet.open(<GithubLinkForm issue={i} />)");
    expect(screen).toContain("<Locked when={action.isPending}>");
  });

  test("on a narrow card the facts wrap between facts, and the state under the name, instead of running past its edge", () => {
    expect(source("parts.tsx")).toMatch(/facts: \{ flexDirection: "row", flexWrap: "wrap",/);
    expect(source("parts.tsx")).toMatch(/who: \{ flexDirection: "row", flexWrap: "wrap",/);
    // A state longer than the card (a stopped run's reason) wraps inside it, never past the card's clipped edge.
    expect(source("parts.tsx")).toContain('state: { flexShrink: 1, maxWidth: "100%" }');
    expect(source("parts.tsx")).toContain("style={[styles.bold, styles.shrink,");
    // A repository's link wider than the card wraps its words inside it, GitHub's mark on the first line's middle.
    expect(source("parts.tsx")).toContain('wraps: { maxWidth: "100%", alignItems: "flex-start" }');
    expect(source("parts.tsx")).toMatch(
      /<View style=\{\[styles\.inline, styles\.wraps\]\}>\s*<View style=\{\{ marginTop: mark \}\}>\s*<SocialMark provider="github"[^>]*\/>\s*<\/View>\s*<Text variant="caption" tone="muted" style=\{styles\.shrink\}>\s*\{githubLinkLabel\(i\.githubUrl\)\}/,
    );
  });
});

describe("an agent picked for a task that couldn't start", () => {
  test("Nova tarefa and Responsável start it through one hook, which says why with Pedir de novo", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "../../src/features/issues", f), "utf8");
    expect(src("NewIssueForm.tsx")).toContain("start.run(issue, who.id, { created: true })");
    expect(src("IssueScreen.tsx")).toContain('start.run(i, who.id, { done: t("mobile.issues.changed") })');
    const hook = src("useStartAgent.ts");
    for (const piece of [
      "useStartAgentOnTask(",
      "errorText(t, error)",
      't("issues.form.askAgain")',
      't("issues.form.notStarted"',
      't("issues.notStarted"',
    ])
      expect([piece, hook.includes(piece)]).toEqual([piece, true]);
  });
});

describe("the Drive past what loaded", () => {
  test("Mostrar mais brings the server's next page once the loaded files are shown", () => {
    const screen = readFileSync(join(import.meta.dir, "../../src/features/drive/DriveScreen.tsx"), "utf8");
    expect(screen).toContain("void list.fetchNextPage()");
    expect(screen).toContain("visible < total || list.hasNextPage");
  });
});

describe("Tarefas as one list", () => {
  test("for you first, then each open stage without what is above, then what was finished today", () => {
    const agent = { type: "agent" as const, id: "a1" };
    const me = { type: "person" as const, id: "me" };
    const list = [
      issue({ number: 1, status: "in_progress", assignee: agent, work: work("running") }),
      issue({ number: 2, status: "in_progress", assignee: agent, work: work("waiting_input") }),
      issue({ number: 3, status: "todo", assignee: me }),
      issue({ number: 4, status: "in_review", assignee: agent }),
      issue({ number: 5, status: "todo" }),
      issue({ number: 6, status: "done", updatedAt: at(30, NOW) }),
      issue({ number: 7, status: "done", updatedAt: new Date(2026, 9, 15, 10, 0).toISOString() }),
      issue({ number: 8, status: "canceled" }),
    ];
    const shape = taskListSections(list, "me", NOW).map((s) => [s.key, s.items.map((i) => i.number)]);
    expect(shape).toEqual([
      // What waits on you comes before what is simply yours.
      ["mine", [2, 3]],
      ["in_progress", [1]],
      ["in_review", [4]],
      ["todo", [5]],
      ["doneToday", [6]],
    ]);
    // Each task once, and nothing left as an empty section.
    const doneOnly = [issue({ number: 9, status: "done", updatedAt: at(30, NOW) })];
    expect(taskListSections(doneOnly, null, NOW).map((s) => s.key)).toEqual(["doneToday"]);
    expect(taskListSections([], "me", NOW)).toEqual([]);
  });
});
