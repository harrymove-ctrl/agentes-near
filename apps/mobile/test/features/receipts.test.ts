import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ACTION_KINDS, type AgentAction, type AgentActionKind } from "@agenteschat/client";
import {
  type ReceiptRow,
  receiptLines,
  receiptPieces,
  receiptRows,
  receiptUnder,
  rowFiles,
} from "@agenteschat/client/lib/actions";
import {
  boldRuns,
  groupStart,
  RECEIPT_ICONS,
  receiptIcon,
  receiptLayout,
  targetHref,
} from "../../src/features/chat/actions";
import { translator } from "./fixtures";

const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  id: "a1",
  kind: "issue.created",
  agentId: "ag",
  messageId: "m1",
  requestedByUserId: "u1",
  target: { type: "issue", id: "i1", number: 23, title: "Prompt" },
  params: { number: 23, title: "Prompt" },
  createdAt: "2026-10-18T11:59:00Z",
  undoableUntil: "2026-10-18T12:04:58Z",
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

describe("receipts under an agent's reply", () => {
  test("one change is a row (A), two or more a group (B)", () => {
    expect(receiptLayout(undefined)).toBe("none");
    expect(receiptLayout([])).toBe("none");
    expect(receiptLayout([action()])).toBe("one");
    expect(receiptLayout([action(), action({ id: "a2" })])).toBe("group");
  });

  test("the group's age is its first change", () => {
    expect(
      groupStart([action({ createdAt: "2026-10-18T11:59:30Z" }), action({ createdAt: "2026-10-18T11:58:00Z" })]),
    ).toBe("2026-10-18T11:58:00Z");
    expect(groupStart([])).toBeNull();
  });

  test("tapping the target opens what the phone has", () => {
    expect(targetHref({ type: "issue", id: "i1", number: 23 }, "c1")).toBe("/issues/23");
    expect(targetHref({ type: "issue", id: "i1" }, "c1")).toBeNull();
    expect(targetHref({ type: "channel", id: "c9", title: "tech" }, "c1")).toBe("/chat/c9");
    expect(targetHref({ type: "thread", id: "t1" }, "c1")).toBe("/chat/c1?thread=t1");
    expect(targetHref({ type: "wiki_page", id: "w1", slug: "x" }, "c1")).toBeNull();
    // A memory opens its own screen, where it is fixed or forgotten; a skill its page.
    expect(targetHref({ type: "memory", id: "m1" }, "c1")).toBe("/memory/m1");
    expect(targetHref({ type: "memory", id: "../x" }, "c1")).toBeNull();
    expect(targetHref({ type: "skill", id: "s1" }, "c1")).toBe("/settings/skills/s1");
    expect(targetHref({ type: "routine", id: "r1" }, "c1")).toBe("/routines/r1");
    expect(targetHref({ type: "routine", id: "" }, "c1")).toBeNull();
  });

  test("icons per kind and bold runs of the sentence", () => {
    expect(receiptIcon("issue.created")).toBe("issue");
    expect(receiptIcon("memory.saved")).toBe("brain");
    expect(receiptIcon("routine.updated")).toBe("clock");
    expect(boldRuns("Criei a issue <b>#23</b> · Prompt")).toEqual([
      { text: "Criei a issue ", bold: false },
      { text: "#23", bold: true },
      { text: " · Prompt", bold: false },
    ]);
    expect(boldRuns("sem marca")).toEqual([{ text: "sem marca", bold: false }]);
  });

  test("every kind the app knows has its icon; one it doesn't yet gets the plain check", () => {
    expect(Object.keys(RECEIPT_ICONS).sort()).toEqual([...AGENT_ACTION_KINDS].sort());
    expect(receiptIcon("channel.created")).toBe("hash");
    expect(receiptIcon("something.new" as AgentActionKind)).toBe("checkc");
  });
});

describe("receipts on one line, as on the web", () => {
  const task = (n: number) =>
    action({
      id: `a${n}`,
      target: {
        type: "issue",
        id: `i${n}`,
        number: n,
        title: `Página de preços: o botão Assinar não responde no tablet ${n}`,
      },
      params: {
        number: n,
        title: `Página de preços: o botão Assinar não responde no tablet ${n}`,
        audience: "everyone",
      },
    });

  test("tasks made together are one row, each number opening its own task", async () => {
    const t = await translator("pt-BR");
    const [row, ...rest] = receiptRows([task(58), task(59), task(60)], t);
    expect(rest).toEqual([]);
    const pieces = receiptPieces(row as never, t);
    expect(pieces.map((p) => p.text).join("")).toBe("Criei as tarefas #58, #59 e #60");
    expect(pieces.flatMap((p) => (p.opens ? [[p.text, targetHref(p.opens.target, "c1")]] : []))).toEqual([
      ["#58", "/issues/58"],
      ["#59", "/issues/59"],
      ["#60", "/issues/60"],
    ]);
    const en = await translator("en");
    expect(
      receiptPieces(receiptRows([task(58), task(59)], en)[0] as never, en)
        .map((p) => p.text)
        .join(""),
    ).toBe("Created tasks #58 and #59");
  });

  test("a tap on a row's words lists each change whole, each opening its own; one with nothing to open is words", async () => {
    const t = await translator("pt-BR");
    const merged = action({
      id: "pr",
      kind: "pr.merged",
      target: { type: "repository", id: "acme/loja", title: "acme/loja" },
      params: { repo: "acme/loja", number: 12 },
    });
    const files = action({ ...task(61), params: { ...task(61).params, files: ["print.png"] } });
    const [tasks, merge] = receiptRows([task(58), files, merged], t);
    const sheet = (row: ReceiptRow | undefined) =>
      receiptLines(row as ReceiptRow, t).map((l) => [l.text, l.files, targetHref(l.action.target, "c1")]);
    expect(sheet(tasks)).toEqual([
      ["Criei a tarefa #58 · Página de preços: o botão Assinar não responde no tablet 58", null, "/issues/58"],
      [
        "Criei a tarefa #61 · Página de preços: o botão Assinar não responde no tablet 61",
        "Anexei print.png",
        "/issues/61",
      ],
    ]);
    expect(sheet(merge)).toEqual([["Fiz o merge do PR #12 em acme/loja", null, null]]);
    // The line under the row names the files once.
    expect(rowFiles(tasks as ReceiptRow)).toEqual(["print.png"]);
  });

  test("a row is one line and opens its sheet; the message's double tap and long press still work on it", () => {
    // No renderer for the phone's components in these tests: what only the source can say is read from it.
    const src = readFileSync(join(import.meta.dir, "../../src/features/chat/Receipts.tsx"), "utf8");
    const sentence = src.slice(src.indexOf("function Sentence("), src.indexOf("function ChangesSheet("));
    expect(sentence).toContain("numberOfLines={1}");
    // A second tap in the message's window is its double tap, so the sheet waits for that window first.
    expect(sentence).toContain("onPress={whole || onTap ? press : undefined}");
    expect(sentence).toContain("}, DOUBLE_TAP_MS);");
    expect(sentence.match(/onLongPress=\{onLongPress\}/g)).toHaveLength(1);
    expect(sentence).toContain("onLongPress={href ? onLongPress : undefined}");
    expect(src).toContain("onPress={() => close(() => router.push(href))}");
    expect(src).not.toContain("WhoSeesLine");
    const row = readFileSync(join(import.meta.dir, "../../src/features/chat/MessageRow.tsx"), "utf8");
    expect(row).toContain("<Receipts message={m} onTap={onTap} onLongPress={press} />");
  });

  test("the sheet ends with the row's own lines whole: what a routine does alone, who undid it", async () => {
    const t = await translator("pt-BR");
    const made = action({
      id: "rt",
      kind: "routine.created",
      target: { type: "routine", id: "rt" },
      params: { name: "Resumo semanal", ownActions: ["GMAIL_SEND_EMAIL"] },
      undoneAt: "2026-10-18T12:00:00Z",
      undoneByUserId: "u2",
    });
    const [row] = receiptRows([made], t);
    const lines = receiptUnder(row as ReceiptRow, t, "Marina");
    expect([lines.own, lines.undone]).toEqual(["Faz sozinha, sem pedir: Enviar e-mail (Gmail)", "Desfeito por Marina"]);
  });
});
