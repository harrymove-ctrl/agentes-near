import { describe, expect, test } from "bun:test";
import {
  codeAndBoldParts,
  detailsAt,
  firstMentioned,
  parseMarkdown,
  readsAsPageTitle,
  tableAt,
} from "../src/lib/markdown";

describe("mentions", () => {
  test("the first agent a text @mentions, as the backend reads it: any case, never an email", () => {
    const team = [{ handle: "theo" }, { handle: "Lia" }];
    expect(firstMentioned("oi @maria, e @LIA e @theo", team)).toBe(team[1]);
    expect(firstMentioned("@theo!", team)).toBe(team[0]);
    expect(firstMentioned("mande para lia@acme.com.br", team)).toBeUndefined();
    expect(firstMentioned("bom dia, time", team)).toBeUndefined();
  });
});

const TABLE = [
  "| Gatilho | Exibições | Compras | Taxa |",
  "|---|---|---|---|",
  "| `first_trip_soft` | 67 | 10 | ~15% |",
  "| generic | 435 | 29 | ~6,7% |",
].join("\n");

describe("tables", () => {
  test("a table right under a sentence is still a table (not swallowed by the paragraph)", () => {
    const blocks = parseMarkdown(`Usei a semana desde 18/10:\n${TABLE}\nO primeiro converte melhor.`, { breaks: true });
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table", "paragraph"]);
    const table = blocks[1];
    expect(table?.type === "table" && table.rows).toEqual([
      ["`first_trip_soft`", "67", "10", "~15%"],
      ["generic", "435", "29", "~6,7%"],
    ]);
  });

  test("number columns align right; the separator's colons win", () => {
    expect(tableAt(TABLE.split("\n"), 0)?.table.align).toEqual(["left", "right", "right", "right"]);
    const marked = tableAt(["| a | b | c |", "|:---:|:---|---:|", "| x | 1 | y |"], 0);
    expect(marked?.table.align).toEqual(["center", "left", "right"]);
    expect(marked?.next).toBe(3);
  });

  test("a line with pipes but no rule under it is text", () => {
    expect(tableAt(["a | b", "c | d"], 0)).toBeNull();
    expect(parseMarkdown("a | b\nc | d").map((b) => b.type)).toEqual(["paragraph"]);
  });
});

describe("collapsed details (ADR 0147)", () => {
  const text = [
    "Falta dar acesso ao repositório.",
    "<details>",
    "<summary>Detalhes</summary>",
    "",
    "<details><summary>Mais</summary>",
    "dentro",
    "</details>",
    "```",
    "</details>",
    "```",
    "</details>",
    "Depois.",
  ].join("\n");

  test("a block of its own, right under a sentence; one nested or fenced inside doesn't close it", () => {
    const blocks = parseMarkdown(text, { breaks: true, details: true });
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "details", "paragraph"]);
    expect(blocks[1]).toEqual({
      type: "details",
      summary: "Detalhes",
      body: "<details><summary>Mais</summary>\ndentro\n</details>\n```\n</details>\n```",
    });
  });

  test("off by default (an editor keeps the source as written), and unclosed it runs to the end", () => {
    expect(parseMarkdown(text).some((b) => b.type === "details")).toBe(false);
    expect(detailsAt(["<details>", "linha"], 0)).toEqual({
      details: { type: "details", summary: "", body: "linha" },
      next: 2,
    });
    expect(detailsAt(["<details open>"], 0)).toBeNull();
  });

  test("on one line, as the prompt shows it, or closed at the end of its last line", () => {
    const one = parseMarkdown(
      "Feito.\n\n<details><summary>Detalhes</summary> O GitHub respondeu 404. </details>\nDepois.",
      {
        breaks: true,
        details: true,
      },
    );
    expect(one.map((b) => b.type)).toEqual(["paragraph", "details", "paragraph"]);
    expect(one[1]).toEqual({ type: "details", summary: "Detalhes", body: "O GitHub respondeu 404." });
    expect(detailsAt(["<details>", "<summary>Mais</summary>", "linha", "fim</details>", "fora"], 0)).toEqual({
      details: { type: "details", summary: "Mais", body: "linha\nfim" },
      next: 4,
    });
    expect(
      detailsAt(["<details><summary>A</summary>", "<details><summary>B</summary>x</details>", "y</details>"], 0),
    ).toEqual({
      details: { type: "details", summary: "A", body: "<details><summary>B</summary>x</details>\ny" },
      next: 3,
    });
  });
});

test("a [[link]] to no page reads as a page's name; a bracketed sentence doesn't", () => {
  expect(readsAsPageTitle("Plano de férias")).toBe(true);
  expect(readsAsPageTitle("Processos/Onboarding#Primeiro dia")).toBe(true);
  expect(readsAsPageTitle("Ada está verificando os registros de recebimento e envio.")).toBe(false);
  expect(readsAsPageTitle("Isso já foi resolvido?")).toBe(false);
  expect(readsAsPageTitle("a".repeat(81))).toBe(false);
});

test("a title's `code` and **bold**, the rest as typed: no link or mention, nothing half marked", () => {
  expect(codeAndBoldParts("Corrigir `bun test` no **CI** de https://example.com @ana")).toEqual([
    { text: "Corrigir " },
    { text: "bun test", mark: "code" },
    { text: " no " },
    { text: "CI", mark: "bold" },
    { text: " de https://example.com @ana" },
  ]);
  expect(codeAndBoldParts("um ` sozinho e **meio")).toEqual([{ text: "um ` sozinho e **meio" }]);
  expect(codeAndBoldParts("vazio: ``")).toEqual([{ text: "vazio: ``" }]);
  expect(codeAndBoldParts("")).toEqual([]);
});
