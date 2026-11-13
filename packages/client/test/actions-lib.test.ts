import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { AGENT_ACTION_KINDS, type AgentAction } from "../src/api/types";
import {
  actionErrorKey,
  actionTextKey,
  actionTextValues,
  formatTimeLeft,
  hookToCopy,
  type ReceiptRow,
  receiptPieces,
  receiptRows,
  receiptTip,
  receiptUnder,
  rowFiles,
} from "../src/lib/actions";

const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  id: "a1",
  kind: "issue.created",
  agentId: "ag",
  messageId: "m1",
  requestedByUserId: "u1",
  target: { type: "issue", id: "i1", number: 23, title: "Prompt" },
  params: { number: 23, title: "Prompt" },
  createdAt: "2026-10-18T11:59:00Z",
  undoableUntil: "2026-10-18T12:04:00Z",
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

describe("receipts", () => {
  test("a countdown's minutes and seconds", () => {
    expect(formatTimeLeft(238_000)).toBe("3:58");
    expect(formatTimeLeft(0)).toBe("0:00");
  });

  test("a webhook routine the agent made offers its address to who asked or manages routines; nothing else does", () => {
    const made = action({
      kind: "routine.created",
      target: { type: "routine", id: "rt1", title: "Avisar" },
      params: { name: "Avisar", trigger: "webhook" },
    });
    expect(hookToCopy(made, { userId: "u1", managesRoutines: false })).toBe("rt1");
    expect(hookToCopy(made, { userId: "u2", managesRoutines: true })).toBe("rt1");
    expect(hookToCopy(made, { userId: "u2", managesRoutines: false })).toBeNull();
    expect(
      hookToCopy({ ...made, undoneAt: "2026-10-18T11:59:30Z" }, { userId: "u1", managesRoutines: true }),
    ).toBeNull();
    expect(
      hookToCopy({ ...made, params: { name: "Avisar", trigger: "schedule" } }, { userId: "u1", managesRoutines: true }),
    ).toBeNull();
    expect(hookToCopy(action(), { userId: "u1", managesRoutines: true })).toBeNull();
    // Changed into a webhook routine (or its methods changed): the same button.
    expect(hookToCopy({ ...made, kind: "routine.updated" }, { userId: "u1", managesRoutines: false })).toBe("rt1");
  });

  test("i18n keys", () => {
    expect(actionTextKey(action())).toBe("agentActions.issue.created");
    expect(actionErrorKey("action.changed_since")).toBe("agentActions.errors.changed_since");
  });
});

describe("receipt sentence values", () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    key === "format.list"
      ? new Intl.ListFormat("pt-BR").format(o?.names as string[])
      : key.startsWith("agentActions.")
        ? (key.split(".").pop() ?? key)
        : String(o?.defaultValue ?? key)) as unknown as TFunction;

  test("issue: number and title; one field picks a context", () => {
    expect(actionTextValues(action(), t)).toEqual({ number: "23", title: "Prompt" });
    const status = action({
      kind: "issue.updated",
      params: { number: 23, title: "P", fields: ["status"], status: "done" },
    });
    expect(actionTextValues(status, t)).toMatchObject({ context: "status", status: "done" });
    const two = action({ kind: "issue.updated", params: { number: 23, title: "P", fields: ["title", "labels"] } });
    expect(actionTextValues(two, t).fields).toBe("title e labels");
    expect(actionTextValues(two, t).context).toBeUndefined();
  });

  test("assigned: to the agent itself, or to the viewer", () => {
    const self = action({ kind: "issue.assigned", params: { number: 2, title: "T", assigneeIsSelf: true } });
    expect(actionTextValues(self, t).context).toBe("self");
    const viewer = action({
      kind: "issue.assigned",
      params: { number: 2, title: "T", assigneeType: "person", assigneeId: "u9", assigneeName: "Bia" },
    });
    expect(actionTextValues(viewer, t, "u9").assignee).toBe("you");
    expect(actionTextValues(viewer, t, "u1").assignee).toBe("Bia");
  });

  test("a change applied at once says what it changed; a card's settings stay settings", () => {
    const applied = action({
      kind: "agent.settings_changed",
      target: { type: "agent", id: "a" },
      params: { agentName: "Ada", fields: ["instructions"] },
    });
    expect(actionTextValues(applied, t)).toEqual({ agentName: "Ada", context: "instructions" });
    const card = action({
      kind: "agent.settings_changed",
      target: { type: "agent", id: "a" },
      params: { agentName: "Ada", fields: ["model"] },
    });
    expect(actionTextValues(card, t)).toEqual({ agentName: "Ada" });
  });

  test("routine paused, channel, thread", () => {
    const paused = action({
      kind: "routine.updated",
      target: { type: "routine", id: "r" },
      params: { name: "Daily", fields: ["active"], active: false },
    });
    expect(actionTextValues(paused, t)).toMatchObject({ name: "Daily", context: "paused" });
    const added = action({
      kind: "channel.agent_added",
      target: { type: "channel", id: "c", title: "tech" },
      params: { agentName: "Theo" },
    });
    expect(actionTextValues(added, t)).toEqual({ agentName: "Theo", channel: "tech" });
    const renamed = action({
      kind: "thread.renamed",
      target: { type: "thread", id: "t" },
      params: { from: "a", to: "b" },
    });
    expect(actionTextValues(renamed, t).to).toBe("b");
  });

  test("a deleted routine says its name; a kind this build doesn't know still gives values", () => {
    const deleted = action({
      kind: "routine.deleted",
      target: { type: "routine", id: "r", title: "Daily" },
      params: { name: "Daily" },
    });
    expect(actionTextValues(deleted, t)).toEqual({ name: "Daily" });
    const unknown = action({ kind: "something.new" as AgentAction["kind"] });
    expect(actionTextValues(unknown, t)).toEqual({});
    // Its sentence: "Fiz uma mudança", never the raw key.
    expect(actionTextKey(unknown)).toBe("agentActions.other");
  });

  test("a merge done without asking: its pull request, or the branch of a plain git merge", () => {
    const pr = action({
      kind: "pr.merged",
      target: { type: "repository", id: "acme/app", title: "acme/app" },
      params: { repo: "acme/app", number: 12 },
    });
    expect(actionTextValues(pr, t)).toEqual({ repo: "acme/app", number: "12" });
    expect(actionTextKey(pr)).toBe("agentActions.pr.merged");
    const branch = action({ ...pr, params: { repo: "acme/app", ref: "feature/x" } });
    expect(actionTextValues(branch, t)).toEqual({ repo: "acme/app", ref: "feature/x", context: "branch" });
  });

  test("a workspace change: its words, and its action as the context when this build knows it", () => {
    const made = action({
      kind: "workspace.changed",
      target: { type: "role", id: "r1", title: "Marketing" },
      params: { action: "create_role", name: "Marketing" },
    });
    expect(actionTextValues(made, t)).toEqual({ name: "Marketing", context: "create_role" });
    expect(actionTextKey(made)).toBe("agentActions.workspace.changed");
    // A newer server's action reads the plain sentence.
    const newer = action({ ...made, params: { action: "paint_office", color: "red" } });
    expect(actionTextValues(newer, t)).toEqual({ color: "red", context: "" });
    // A variant picks its own sentence, and a bare availability is said in the reader's words.
    const back = action({ ...made, params: { action: "archive_channel", channel: "vendas", variant: "back" } });
    expect(actionTextValues(back, t).context).toBe("archive_channel_back");
    const away = action({ ...made, params: { action: "set_my_status", what: "", availability: "auto" } });
    const keyOnly = ((key: string) => key) as unknown as TFunction;
    expect(actionTextValues(away, keyOnly).what).toBe("presence.lower.online");
  });

  test("every kind the app knows has its own case (the default gives no values)", () => {
    const missing = AGENT_ACTION_KINDS.filter((kind) => !Object.keys(actionTextValues(action({ kind }), t)).length);
    expect(missing).toEqual([]);
  });
});

describe("receipts in rows, one line each", () => {
  const lang = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
    return instance.t;
  };
  const pt = lang("pt-BR");
  const en = lang("en");
  const task = (n: number, over: Partial<AgentAction> = {}) =>
    action({
      id: `a${n}`,
      target: { type: "issue", id: `i${n}`, number: n, title: `Tarefa ${n}` },
      params: { number: n, title: `Tarefa ${n}` },
      ...over,
    });
  const memory = (id: string, text: string) =>
    action({ id, kind: "memory.saved", target: { type: "memory", id: `m-${id}` }, params: { text } });
  const words = (row: ReceiptRow | undefined, t = pt) =>
    row
      ? receiptPieces(row, t)
          .map((p) => (p.bold ? `[${p.text}]` : p.text))
          .join("")
      : null;

  test("tasks made together are one row, each number opening its own; another kind keeps its row, in order", () => {
    const rows = receiptRows([task(58), memory("m1", "o deploy é às 18h"), task(59), task(60)], pt);
    expect(rows.map((r) => words(r))).toEqual([
      "Criei as tarefas [#58], [#59] e [#60]",
      "Guardei na [memória]: o deploy é às 18h",
    ]);
    expect(receiptPieces(rows[0] as ReceiptRow, pt).flatMap((p) => (p.opens ? [p.opens.id] : []))).toEqual([
      "a58",
      "a59",
      "a60",
    ]);
    expect(words(rows[0], en)).toBe("Created tasks [#58], [#59], and [#60]");
  });

  test("a change on its own keeps its sentence, its target in bold opening it", () => {
    const [row] = receiptRows([task(23)], pt);
    expect(words(row)).toBe("Criei a tarefa [#23] · Tarefa 23");
    expect(receiptPieces(row as ReceiptRow, pt).find((p) => p.bold)?.opens?.id).toBe("a23");
  });

  test("what the changes of a row share comes first: one assignee, my own, the rule they keep", () => {
    const assigned = (n: number, id: string, to: string) =>
      task(n, {
        kind: "issue.assigned",
        params: { number: n, title: "T", assigneeType: "person", assigneeId: id, assigneeName: to },
      });
    // One person by id, whatever the name read; two people of one name stay apart.
    const rows = receiptRows(
      [assigned(1, "u-ana", "Ana"), assigned(2, "u-ana", "Ana S."), assigned(3, "u-ana2", "Ana")],
      pt,
    );
    expect(rows.map((r) => words(r))).toEqual(["Passei para Ana as tarefas [#1] e [#2]", "Passei a [#3] para Ana · T"]);
    // The viewer reads "você".
    const toMe = receiptRows([assigned(4, "u-me", "Eu"), assigned(5, "u-me", "Eu")], pt, "u-me")[0] as ReceiptRow;
    expect(
      receiptPieces(toMe, pt, "u-me")
        .map((p) => (p.bold ? `[${p.text}]` : p.text))
        .join(""),
    ).toBe("Passei para você as tarefas [#4] e [#5]");
    const mine = (n: number) =>
      task(n, { kind: "issue.assigned", params: { number: n, title: "T", assigneeIsSelf: true } });
    expect(words(receiptRows([mine(4), mine(5)], pt)[0])).toBe("Peguei para mim as tarefas [#4] e [#5]");
    // What a memory keeps is words, not a name: its own sentence says them all, opening the first.
    const rule = (id: string) => action({ ...memory(id, id), params: { text: `regra ${id}`, rule: true } });
    const rules = receiptRows([rule("r1"), rule("r2")], pt)[0] as ReceiptRow;
    expect(words(rules)).toBe("Guardei nas [minhas regras]: regra r1 e regra r2");
    // Each memory's words open that memory, in the sentence's own weight; "minhas regras" opens the first.
    expect(
      receiptPieces(rules, pt).flatMap((p) => (p.opens ? [`${p.text}${p.bold ? "*" : ""}:${p.opens.id}`] : [])),
    ).toEqual(["minhas regras*:r1", "regra r1:r1", "regra r2:r2"]);
  });

  test("a change that says what changed keeps its row; the same fields changed on several say them once", () => {
    const updated = (n: number, params: Record<string, unknown>) =>
      task(n, { kind: "issue.updated", params: { number: n, title: "T", ...params } });
    const moved = [
      updated(7, { fields: ["status"], status: "done" }),
      updated(8, { fields: ["status"], status: "done" }),
    ];
    expect(receiptRows(moved, pt).map((r) => words(r))).toEqual([
      "Mudei a [#7] para feito · T",
      "Mudei a [#8] para feito · T",
    ]);
    const urgent = [1, 2].map((n) => updated(n, { fields: ["priority"], priority: "urgent" }));
    expect(receiptRows(urgent, pt).every((r) => r.refs === null)).toBe(true);
    const titled = [
      updated(9, { fields: ["title"] }),
      updated(10, { fields: ["title"] }),
      updated(11, { fields: ["labels"] }),
    ];
    expect(receiptRows(titled, pt).map((r) => words(r))).toEqual([
      "Mudei o título das tarefas [#9] e [#10]",
      "Mudei as etiquetas da [#11] · T",
    ]);
    const routine = (id: string, params: Record<string, unknown>) =>
      action({ id, kind: "routine.updated", target: { type: "routine", id }, params: { name: id, ...params } });
    const paused = [
      routine("r1", { fields: ["active"], active: false }),
      routine("r2", { fields: ["active"], active: false }),
    ];
    expect(receiptRows(paused, pt).map((r) => words(r))).toEqual(["Pausei a rotina [r1]", "Pausei a rotina [r2]"]);
    // What a routine may do alone and when it posts are one routine's words: each keeps its row.
    for (const field of ["access", "report"]) {
      const own = [routine("r3", { fields: [field] }), routine("r4", { fields: [field] })];
      expect(receiptRows(own, pt).every((r) => r.refs === null)).toBe(true);
    }
    const renamed = [
      routine("r5", { fields: ["name"], name: "Resumo" }),
      routine("r5", { fields: ["name"], name: "Resumo semanal" }),
      routine("r6", { fields: ["name"], name: "Backup" }),
    ].map((r, i) => ({ ...r, id: `rn${i}` }));
    // One routine renamed twice is still one: its newest name.
    expect(words(receiptRows(renamed, pt)[0])).toBe("Mudei o nome das rotinas [Resumo semanal] e [Backup]");
    const settings = (id: string, field: string) =>
      action({
        id,
        kind: "agent.settings_changed",
        target: { type: "agent", id },
        params: { agentName: id, fields: [field] },
      });
    expect(
      receiptRows([settings("a1", "instructions"), settings("a2", "instructions")], pt).map((r) => words(r)),
    ).toEqual(["Mudei as instruções de [a1]", "Mudei as instruções de [a2]"]);
  });

  test("a language without a context's sentence falls back to the kind's, alone or several", () => {
    const instance = i18next.createInstance();
    void instance.init({
      lng: "xx",
      initAsync: false,
      interpolation: { escapeValue: false },
      resources: {
        xx: {
          translation: {
            format: { list: "{{names, list}}" },
            agentActions: {
              issue: { assigned: "Gave <b>#{{number}}</b> to {{assignee}}" },
              several: { issue: { assigned: "Gave {{assignee}} tasks {{refs}}" } },
            },
          },
        },
      },
    });
    const mine = (n: number) =>
      task(n, { kind: "issue.assigned", params: { number: n, title: "T", assigneeIsSelf: true, assigneeName: "Ada" } });
    expect(words(receiptRows([mine(1)], instance.t)[0], instance.t)).toBe("Gave [#1] to Ada");
    expect(words(receiptRows([mine(1), mine(2)], instance.t)[0], instance.t)).toBe("Gave Ada tasks [#1] and [#2]");
  });

  test("one thing changed twice keeps a row per change; beside another, it is named once", () => {
    const edit = (id: string, n: number) =>
      task(n, { id, kind: "issue.updated", params: { number: n, title: "T", fields: ["title"] } });
    expect(receiptRows([edit("x1", 9), edit("x2", 9)], pt)).toHaveLength(2);
    const [row] = receiptRows([edit("x1", 9), edit("x2", 9), edit("x3", 10)], pt);
    expect(words(row)).toBe("Mudei o título das tarefas [#9] e [#10]");
    expect(row?.actions).toHaveLength(3);
  });

  test("undone ones blend only with others undone by the same person; a webhook routine keeps its own row", () => {
    const undone = (n: number, by: string) => task(n, { undoneAt: "2026-10-18T12:00:00Z", undoneByUserId: by });
    expect(
      receiptRows([undone(1, "u1"), undone(2, "u1"), undone(3, "u2"), task(4)], pt).map((r) => r.actions.length),
    ).toEqual([2, 1, 1]);
    const hook = (id: string) =>
      action({
        id,
        kind: "routine.created",
        target: { type: "routine", id },
        params: { name: id, trigger: "webhook" },
      });
    expect(receiptRows([hook("r1"), hook("r2")], pt).every((r) => r.refs === null)).toBe(true);
  });

  test("a workspace change stays a row of its own", () => {
    const archived = (id: string) =>
      action({
        id,
        kind: "workspace.changed",
        target: { type: "channel", id },
        params: { action: "archive_channel", channel: id },
      });
    expect(receiptRows([archived("c1"), archived("c2")], pt).map((r) => r.refs)).toEqual([null, null]);
  });

  test("the tip says each change whole, with the files that went with it", () => {
    const [row] = receiptRows(
      [task(58, { params: { number: 58, title: "Login lento", files: ["print.png"] } }), task(59)],
      pt,
    );
    expect(receiptTip(row as ReceiptRow, pt)).toBe(
      "Criei a tarefa #58 · Login lento\nAnexei print.png\nCriei a tarefa #59 · Tarefa 59",
    );
  });

  test("two of a kind blend for every kind but a workspace change and a renamed conversation, with their real targets", () => {
    // Each kind's target as the server writes it: a merge's is its repository, the same for every pull request there.
    const targetOf = (kind: AgentAction["kind"], n: number): AgentAction["target"] => {
      const [group] = kind.split(".");
      if (kind === "pr.merged") return { type: "repository", id: "acme/app", title: "acme/app" };
      if (kind === "channel.agent_added") return { type: "channel", id: `c${n}`, title: `c${n}` };
      if (kind === "agent.settings_changed") return { type: "agent", id: `ag${n}` };
      if (kind === "workspace.changed") return { type: "channel", id: `c${n}`, title: `c${n}` };
      const type = ({ wiki: "wiki_page", issue: "issue" } as Record<string, string>)[group ?? ""] ?? group;
      return {
        type: type as AgentAction["target"]["type"],
        id: `${kind}-${n}`,
        number: n,
        title: `T${n}`,
        slug: `p${n}`,
      };
    };
    const two = (kind: AgentAction["kind"]) =>
      [1, 2].map((n) =>
        action({
          id: `${kind}-${n}`,
          kind,
          target: targetOf(kind, n),
          params: {
            number: n,
            title: `T${n}`,
            text: `t${n}`,
            name: `N${n}`,
            agentId: "ag-ada",
            agentName: "Ada",
            channel: `c${n}`,
            repo: "acme/app",
            action: "archive_channel",
          },
        }),
      );
    const blended = AGENT_ACTION_KINDS.filter((kind) => receiptRows(two(kind), pt)[0]?.refs);
    expect(AGENT_ACTION_KINDS.filter((kind) => !blended.includes(kind))).toEqual([
      "thread.renamed",
      "workspace.changed",
    ]);
    expect(words(receiptRows(two("pr.merged"), pt)[0])).toBe("Fiz o merge em [acme/app] dos PRs [#1] e [#2]");
    for (const t of [pt, en])
      for (const kind of blended) expect(words(receiptRows(two(kind), t)[0], t)).not.toContain("agentActions");
  });

  test("assigned to the reader or to nobody: each language's own sentence, alone or several", () => {
    const es = lang("es");
    const toMe = (n: number) =>
      task(n, {
        kind: "issue.assigned",
        params: { number: n, title: "T", assigneeType: "person", assigneeId: "u-me", assigneeName: "Eu" },
      });
    const said = (row: ReceiptRow | undefined, t = pt) =>
      receiptPieces(row as ReceiptRow, t, "u-me")
        .map((p) => (p.bold ? `[${p.text}]` : p.text))
        .join("");
    expect(said(receiptRows([toMe(1)], pt, "u-me")[0])).toBe("Passei a [#1] para você · T");
    expect(said(receiptRows([toMe(1)], es, "u-me")[0], es)).toBe("Te asigné [#1] · T");
    expect(said(receiptRows([toMe(1), toMe(2)], es, "u-me")[0], es)).toBe("Te asigné las tareas [#1] y [#2]");
    const nobody = (n: number) =>
      task(n, { kind: "issue.assigned", params: { number: n, title: "T", assigneeType: null, assigneeId: null } });
    expect(words(receiptRows([nobody(7)], pt)[0])).toBe("Tirei o responsável da [#7] · T");
    expect(words(receiptRows([nobody(7), nobody(8)], pt)[0])).toBe("Tirei o responsável das tarefas [#7] e [#8]");
  });

  test("a merged pull request is its number: the same one twice is one, two of one repository are two", () => {
    const merge = (id: string, n: number) =>
      action({
        id,
        kind: "pr.merged",
        target: { type: "repository", id: "acme/app", title: "acme/app" },
        params: { repo: "acme/app", number: n },
      });
    expect(receiptRows([merge("m1", 12), merge("m2", 12)], pt).every((r) => r.refs === null)).toBe(true);
    expect(receiptRows([merge("m1", 12), merge("m2", 13)], pt)[0]?.refs?.map((r) => r.text)).toEqual(["#12", "#13"]);
  });

  test("the lines under a row: its files once, what a routine does alone, who undid it", () => {
    const routine = action({
      id: "rt",
      kind: "routine.created",
      target: { type: "routine", id: "rt" },
      params: { name: "Resumo", ownActions: ["SLACK_SEND_MESSAGE"] },
      undoneAt: "2026-10-18T12:00:00Z",
      undoneByUserId: "u2",
    });
    expect(receiptUnder({ actions: [routine], refs: null }, pt, "Bia")).toEqual({
      files: null,
      own: "Faz sozinha, sem pedir: Enviar mensagem (Slack)",
      undone: "Desfeito por Bia",
    });
  });

  test("the line under a row names each file its changes brought, once", () => {
    const [row] = receiptRows(
      [
        task(1, { params: { number: 1, title: "T", files: ["print.png", "log.txt"] } }),
        task(2, { params: { number: 2, title: "T", files: ["print.png"] } }),
      ],
      pt,
    );
    expect(rowFiles(row as ReceiptRow)).toEqual(["print.png", "log.txt"]);
  });
});
