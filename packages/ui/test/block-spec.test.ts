import { describe, expect, test } from "bun:test";
import { createBudget, EXPR_LIMITS, evalExpr, namesIn, parseExpr, type Value } from "../src/blocks/expr";
import {
  type BlockSpec,
  BlockSpecError,
  blockSpecText,
  compileBlock,
  dryRunBlock,
  formatBlockValue,
  inputValue,
  parseBlockSpec,
  viewBlock,
} from "../src/blocks/spec";

const run = (src: string, values: Record<string, Value> = {}) =>
  evalExpr(parseExpr(src), (n) => (Object.hasOwn(values, n) ? values[n] : undefined));

const words = { locale: "pt-BR", thousand: "mil" };

describe("formulas (ADR 0113)", () => {
  test("arithmetic, power, comparisons and the ternary, as a spreadsheet reads them", () => {
    expect(run("(preco - 40) / preco * 100", { preco: 100 })).toBe(60);
    expect(run("2 ^ 3 ^ 2")).toBe(512);
    expect(run("-2 ^ 2")).toBe(-4);
    expect(run("10 ** 2")).toBe(100);
    expect(run("7 % 3")).toBe(1);
    expect(run("a > 5 ? 'alto' : 'baixo'", { a: 7 })).toBe("alto");
    expect(run("a == '12'", { a: 12 })).toBe(true);
    expect(run("'R$ ' + 12")).toBe("R$ 12");
    expect(run("!x && y || 'z'", { x: false, y: 0 })).toBe("z");
  });

  test("lists, records and the list functions with a step", () => {
    const items = [
      { nome: "A", preco: 10, qtd: 2 },
      { nome: "B", preco: 5, qtd: 4 },
    ];
    expect(run("sum(items, x => x.preco * x.qtd)", { items })).toBe(40);
    expect(run("map(range(3), m => {label: 'M' + (m + 1), value: m * 2})")).toEqual([
      { label: "M1", value: 0 },
      { label: "M2", value: 2 },
      { label: "M3", value: 4 },
    ]);
    expect(run("filter(items, x => x.preco > 6)[0].nome", { items })).toBe("A");
    expect(run("sort(items, x => x.preco)[0].nome", { items })).toBe("B");
    expect(run("map(items, (x, i) => i)", { items })).toEqual([0, 1]);
    expect(run("count(items, x => x.qtd > 1)", { items })).toBe(2);
    expect(run("round(2 / 3, 2)")).toBe(0.67);
    expect(run("max([3, 9, 4])")).toBe(9);
    expect(run("join(['a', 'b'], ' · ')")).toBe("a · b");
    expect(run("items.length", { items })).toBe(2);
  });

  test("names a formula reads, without the ones its own steps bring in", () => {
    expect([...namesIn(parseExpr("sum(items, x => x.v * taxa)"))].sort()).toEqual(["items", "taxa"]);
  });

  test("reaches nothing but the values handed to it", () => {
    const o = { a: 1 };
    expect(run("o.constructor", { o })).toBeNull();
    expect(run("o.__proto__", { o })).toBeNull();
    expect(run("o['toString']", { o })).toBeNull();
    expect(() => run("constructor")).toThrow('There is no value "constructor"');
    expect(() => parseExpr("eval('1')")).toThrow('There is no function "eval"');
    expect(() => parseExpr("o.f()")).toThrow("Only a function name can be called");
    expect(() => parseExpr("a = 1")).toThrow();
    expect(() => parseExpr("`x`")).toThrow();
  });

  test("an endless or huge computation stops with an error, never a hang", () => {
    expect(() => run("range(100000)")).toThrow("too long");
    expect(() => run("map(range(1000), a => map(range(1000), b => a * b))")).toThrow();
    const budget = createBudget();
    expect(() =>
      evalExpr(parseExpr("sum(range(1999), a => sum(range(1999), b => 1))"), () => undefined, budget),
    ).toThrow("computes too much");
    expect(() => parseExpr("(".repeat(EXPR_LIMITS.depth + 2))).toThrow();
    expect(() => parseExpr("1+".repeat(2000))).toThrow("too long");
  });

  test("a wrong formula says where", () => {
    expect(() => parseExpr("a +")).toThrow("ends too soon");
    expect(() => parseExpr("a b")).toThrow('Unexpected "b" at 3');
    expect(() => parseExpr("'aberto")).toThrow("never ends");
  });
});

const SIMULATOR: BlockSpec = {
  data: { custo: 40 },
  compute: { margem: "(preco - custo) / preco * 100", alerta: "margem < 50" },
  parts: [
    { type: "slider", name: "preco", label: "Preço", min: 50, max: 200, step: 10, value: 100, format: "brl" },
    { type: "stat", label: "Margem", value: "margem", format: "pct", tone: "alerta ? 'down' : 'up'" },
    { type: "note", text: "Margem baixa", when: "alerta" },
  ],
  send: { label: "Usar este preço", text: "Usar {preco:brl}." },
};

describe("a block's spec", () => {
  test("checks names and formulas up front, and says where something is wrong", () => {
    expect(parseBlockSpec(SIMULATOR)).toEqual(SIMULATOR);
    expect(parseBlockSpec(JSON.stringify(SIMULATOR))).toEqual(SIMULATOR);
    const wrong = (spec: unknown, message: string) => expect(() => parseBlockSpec(spec)).toThrow(message);
    wrong({ parts: [] }, "parts must be a list of parts");
    wrong({ parts: [{ type: "iframe" }] }, 'parts[0]: type "iframe" is not a part');
    wrong({ parts: [{ type: "stat", label: "X", value: "nada" }] }, 'parts[0].value: there is no value "nada"');
    wrong({ parts: [{ type: "text", text: "Oi {quem}" }] }, 'parts[0].text: there is no value "quem"');
    wrong(
      {
        parts: [
          { type: "slider", name: "a", label: "A", min: 0, max: 1 },
          { type: "switch", name: "a", label: "B" },
        ],
      },
      'the name "a" is used twice',
    );
    wrong(
      { compute: { b: "a + 1", a: "1" }, parts: [{ type: "text", text: "x" }] },
      'compute.b: there is no value "a"',
    );
    wrong({ parts: [{ type: "slider", name: "a", label: "A", min: 5, max: 1 }] }, "max must be more than min");
    wrong({ parts: [{ type: "actions", buttons: [{ label: "Nada" }] }] }, "needs set or draw");
    expect(() => parseBlockSpec({ parts: [{ type: "stat", label: "X", value: "a +" }] })).toThrow(BlockSpecError);
  });

  test("a value a button sets or a draw picks needs no declaring", () => {
    const spec = parseBlockSpec({
      parts: [
        { type: "result", label: "Sorteado", value: "nome" },
        { type: "actions", buttons: [{ label: "Sortear", draw: { name: "nome", options: ["Ana", "Bia"] } }] },
      ],
    });
    const view = viewBlock(compileBlock(spec), {}, words);
    expect(view.parts[0]).toMatchObject({ kind: "result", text: "–", name: "nome" });
    expect(view.parts[1]).toMatchObject({
      kind: "actions",
      buttons: [{ label: "Sortear", draw: { name: "nome", options: ["Ana", "Bia"] }, lead: true }],
    });
    expect(viewBlock(compileBlock(spec), { nome: "Bia" }, words).parts[0]).toMatchObject({ text: "Bia" });
  });

  test("drawn from everyone's state: inputs, results, hidden parts and the text to send", () => {
    const compiled = compileBlock(parseBlockSpec(SIMULATOR));
    const start = viewBlock(compiled, {}, words);
    expect(start.parts.map((p) => p.kind)).toEqual(["slider", "stats"]);
    expect(start.parts[0]).toMatchObject({ value: 100, shown: "R$ 100" });
    expect(start.parts[1]).toMatchObject({ items: [{ label: "Margem", text: "60%", tone: "up" }] });
    expect(start.send).toEqual({ label: "Usar este preço", text: "Usar R$ 100.", ready: true, hint: "" });
    expect(start.values.margem).toBe(60);

    const low = viewBlock(compiled, { preco: 70 }, words);
    expect(low.parts.map((p) => p.kind)).toEqual(["slider", "stats", "note"]);
    expect(low.parts[1]).toMatchObject({ items: [{ text: "42,9%", tone: "down" }] });
    // A value out of the slider's range is brought into it.
    expect(viewBlock(compiled, { preco: 999 }, words).parts[0]).toMatchObject({ value: 200 });
    expect(start.errors).toEqual([]);
  });

  test("charts, tables and cards that are choices", () => {
    const spec = parseBlockSpec({
      data: {
        lojas: [
          { nome: "Centro", venda: 120 },
          { nome: "Batel", venda: 80 },
        ],
      },
      parts: [
        { type: "choice", name: "plano", options: ["A", "B"] },
        { type: "chart", chart: "bar", label: "Vendas", data: "map(lojas, l => {label: l.nome, value: l.venda})" },
        {
          type: "table",
          columns: [
            { label: "Loja", key: "nome" },
            { label: "Venda", key: "venda", format: "brl" },
          ],
          rows: "lojas",
        },
        { type: "card", label: "Plano B", name: "plano", value: "B", parts: [{ type: "note", text: "Mais caro" }] },
      ],
    });
    const view = viewBlock(compileBlock(spec), {}, words);
    expect(view.parts[0]).toMatchObject({ kind: "choice", value: "A" });
    expect(view.parts[1]).toMatchObject({ kind: "chart", labels: ["Centro", "Batel"], values: [120, 80] });
    expect(view.parts[2]).toMatchObject({
      kind: "table",
      rows: [
        ["Centro", "R$ 120"],
        ["Batel", "R$ 80"],
      ],
    });
    expect(view.parts[3]).toMatchObject({ kind: "card", pick: { name: "plano", value: "B" }, selected: false });
    expect(viewBlock(compileBlock(spec), { plano: "B" }, words).parts[3]).toMatchObject({ selected: true });
  });

  test("a formula that fails on the block's own data is caught before it is shown", () => {
    expect(dryRunBlock(parseBlockSpec(SIMULATOR))).toEqual([]);
    const bad = parseBlockSpec({ data: { n: 3 }, parts: [{ type: "stat", label: "X", value: "sum(n)" }] });
    expect(dryRunBlock(bad)[0]).toContain("parts.0.value: sum() needs a list");
  });

  test("what a person types is taken as the part allows", () => {
    const view = viewBlock(compileBlock(parseBlockSpec(SIMULATOR)), {}, words);
    const slider = view.parts[0];
    if (!slider) throw new Error("no slider");
    expect(inputValue(slider, "137")).toBe(140);
    expect(inputValue({ key: "k", kind: "choice", name: "c", label: "", options: ["A"], value: null }, "Z")).toBe(
      undefined,
    );
  });

  test("values written like the kit wrote them", () => {
    expect(formatBlockValue(1200, "brl", undefined, words)).toBe("R$ 1.200");
    expect(formatBlockValue(12, "mil", undefined, words)).toBe("R$ 12 mil");
    expect(formatBlockValue(12.34, "pct", undefined, words)).toBe("12,3%");
    expect(formatBlockValue(3, undefined, "h", words)).toBe("3 h");
    expect(formatBlockValue(Number.NaN, "brl", undefined, words)).toBe("–");
    expect(formatBlockValue(null, undefined, undefined, words)).toBe("–");
  });

  test("its words are what search finds", () => {
    expect(blockSpecText(SIMULATOR)).toContain("Preço");
    expect(blockSpecText(SIMULATOR)).toContain("Usar este preço");
  });
});
