import { describe, expect, test } from "bun:test";
import type { ActivityEntry } from "@agenteschat/adapters/runner-control";
import i18next from "i18next";
import { groupByDay, hasMore, homesToFetch, mergePages, saidText, startCursor } from "../src/control/activity";
import { desktopEn } from "../src/i18n/keys.en";
import { desktopPtBR } from "../src/i18n/keys.pt-BR";

const at = (min: number) => new Date(Date.UTC(2026, 9, 17, 12, 0) - min * 60_000).toISOString();
const entry = (min: number, summary = `e${min}`): ActivityEntry => ({ at: at(min), kind: "file", summary });

describe("activity paging across organizations", () => {
  test("merges newest first and keeps only the page size", () => {
    const cursor = startCursor(["a", "b"]);
    const { entries, cursor: next } = mergePages(
      [
        { homeId: "a", entries: [entry(1), entry(5), entry(9)], more: false },
        { homeId: "b", entries: [entry(2), entry(3), entry(20)], more: false },
      ],
      cursor,
      4,
    );
    expect(entries.map((e) => `${e.homeId}:${e.summary}`)).toEqual(["a:e1", "b:e2", "b:e3", "a:e5"]);
    // a showed e1 and e5; e9 is left over, so a has more, starting before e5.
    expect(next.a).toEqual({ before: at(5), more: true });
    // b showed e2 and e3; e20 is left over.
    expect(next.b).toEqual({ before: at(3), more: true });
    expect(hasMore(next)).toBe(true);
  });

  test("the next page asks again from each home's cursor", () => {
    const first = mergePages(
      [
        { homeId: "a", entries: [entry(1), entry(5), entry(9)], more: false },
        { homeId: "b", entries: [entry(2), entry(3), entry(20)], more: false },
      ],
      startCursor(["a", "b"]),
      4,
    );
    expect(homesToFetch(first.cursor).sort()).toEqual(["a", "b"]);
    const second = mergePages(
      [
        { homeId: "a", entries: [entry(9)], more: false },
        { homeId: "b", entries: [entry(20)], more: false },
      ],
      first.cursor,
      4,
    );
    expect(second.entries.map((e) => e.summary)).toEqual(["e9", "e20"]);
    expect(hasMore(second.cursor)).toBe(false);
    expect(homesToFetch(second.cursor)).toEqual([]);
  });

  test("a home that shows nothing keeps its cursor", () => {
    const cursor = { a: { before: at(1), more: true }, b: { more: true } };
    const { cursor: next } = mergePages(
      [
        { homeId: "a", entries: [entry(50)], more: true },
        { homeId: "b", entries: [entry(2)], more: false },
      ],
      cursor,
      1,
    );
    expect(next.a).toEqual({ before: at(1), more: true });
    expect(next.b).toEqual({ before: at(2), more: false });
  });

  test("a runner saying it has more keeps paging", () => {
    const { cursor } = mergePages([{ homeId: "a", entries: [entry(1)], more: true }], startCursor(["a"]), 40);
    expect(cursor.a?.more).toBe(true);
  });
});

describe("groupByDay", () => {
  test("today, yesterday, then dates", () => {
    const now = new Date(2026, 9, 17, 15, 0);
    const local = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
    const groups = groupByDay(
      [{ at: local(17, 14) }, { at: local(17, 9) }, { at: local(16, 20) }, { at: local(12, 8) }],
      now,
    );
    expect(groups.map((g) => [g.kind, g.entries.length])).toEqual([
      ["today", 2],
      ["yesterday", 1],
      ["date", 1],
    ]);
  });
});

describe("each line in the person's words", () => {
  const lang = (strings: Record<string, unknown>, lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({
      lng,
      resources: { [lng]: { translation: { desktop: strings } } },
      initAsync: false,
      interpolation: { escapeValue: false },
    });
    return instance.t;
  };
  const pt = lang(desktopPtBR as unknown as Record<string, unknown>, "pt-BR");
  const en = lang(desktopEn as unknown as Record<string, unknown>, "en");
  const clock = (iso: string) => iso.slice(11, 16);
  const line = (summary: string, said?: ActivityEntry["said"]): ActivityEntry => ({
    at: at(0),
    kind: "file",
    summary,
    ...(said ? { said } : {}),
  });

  test("what the runner says it was, never its English, with what it names as it came", () => {
    expect(saidText(pt, line("wrote /home/x/report.md", { key: "wrote", path: "/home/x/report.md" }), clock)).toBe(
      "escreveu /home/x/report.md",
    );
    expect(saidText(pt, line("thinking with Codex", { key: "thinking", brain: "Codex" }), clock)).toBe(
      "pensando com o Codex",
    );
    expect(saidText(pt, line("started: Codex task", { key: "taskStarted", executor: "codex" }), clock)).toBe(
      "começou: tarefa do Codex",
    );
    expect(
      saidText(pt, line("failed (exit 2): npm test", { key: "taskFailed", exit: "2", what: "npm test" }), clock),
    ).toBe("falhou (saída 2): npm test");
    expect(
      saidText(pt, line("the browser turned on", { key: "toolOn", tool: "browser", name: "the browser" }), clock),
    ).toBe("ligou o navegador");
    // A product's name stays its name.
    expect(saidText(pt, line("Codex turned off", { key: "toolOff", tool: "codex", name: "Codex" }), clock)).toBe(
      "desligou Codex",
    );
    expect(saidText(pt, line("allowed /p for no agent", { key: "folderAllowed", path: "/p", agents: "" }), clock)).toBe(
      "liberou /p para nenhum agente",
    );
    expect(
      saidText(pt, line("paused until 16:24", { key: "pausedUntil", until: "2026-10-17T16:24:00.000Z" }), clock),
    ).toBe("pausado até 16:24");
    expect(saidText(en, line("connected to Acme", { key: "connected", org: "Acme" }), clock)).toBe("connected to Acme");
  });

  test("a line from an older runner, or with words this app doesn't have, reads as it came", () => {
    expect(saidText(pt, line("looked at /home/x"), clock)).toBe("looked at /home/x");
    expect(saidText(pt, line("something new", { key: "somethingNew" }), clock)).toBe("something new");
  });
});
