import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  ditherTile,
  formatWidgetNumber,
  formatWithUnit,
  WidgetBody,
  WidgetCard,
  WidgetGlyph,
  widgetTileVars,
  widgetTones,
} from "../src";
import { chartBlockToWidgetSpec, type WidgetSpec } from "../src/widgets/spec";

afterEach(() => cleanup());

const card = (spec: WidgetSpec | null, over: Partial<Parameters<typeof WidgetCard>[0]> = {}) =>
  render(
    <WidgetCard
      title="Vendas hoje"
      spec={spec}
      status="ok"
      color="amber"
      size={{ w: 2, h: 1 }}
      locale="pt-BR"
      footer={<span>Theo · há 12 min · a cada hora</span>}
      {...over}
    />,
  );

describe("the widget's numbers (ADR 0135)", () => {
  test("in the reader's language: grouped, fractions only for small numbers, the unit where the chat puts it", () => {
    expect(formatWidgetNumber(18420, "pt-BR")).toBe("18.420");
    expect(formatWidgetNumber(18420, "en")).toBe("18,420");
    expect(formatWidgetNumber(3.94, "pt-BR")).toBe("3,94");
    expect(formatWidgetNumber(31.26, "en")).toBe("31.3");
    expect(formatWithUnit(41, "R$", "pt-BR")).toBe("R$ 41");
    expect(formatWithUnit(41, "%", "en")).toBe("41%");
    expect(formatWithUnit(120, "ms", "en")).toBe("120 ms");
    expect(formatWithUnit(7, undefined, "en")).toBe("7");
  });
});

describe("a widget's body, by kind", () => {
  test("a number: its prefix, the value in the app's bold tabular style, how it moved, the note and the trend", () => {
    const { container } = card({
      kind: "kpi",
      value: 18420,
      prefix: "R$",
      delta: { text: "+12%", up: true },
      note: "vs. ontem até agora",
      spark: [2, 3, 5, 4, 7],
    });
    const num = container.querySelector(".wk-num");
    expect(num?.textContent).toBe("R$18.420");
    expect(num?.querySelector(".wk-num__pre")?.textContent).toBe("R$");
    expect(container.querySelector(".wk-up")?.textContent).toBe("+12%");
    expect(container.querySelector(".wk-sub")?.textContent).toBe("+12% vs. ontem até agora");
    expect(container.querySelector(".wk-spark")).toBeTruthy();
    // Down is the attention tone, whatever the sign says.
    cleanup();
    const down = card({ kind: "kpi", value: 4, suffix: "abertos", delta: { text: "+2", up: false } });
    expect(down.container.querySelector(".wk-down")?.textContent).toBe("+2");
    expect(down.container.querySelector(".wk-num__suf")?.textContent).toBe("abertos");
  });

  test("a number's trend runs edge to edge at the card's bottom, under the footer", () => {
    const { container } = card({ kind: "kpi", value: 7, spark: [1, 3, 2, 5] });
    const article = container.querySelector("article") as HTMLElement;
    expect(article.getAttribute("data-kind")).toBe("kpi");
    // Not in the padded body: after the footer, in its own clipped strip.
    expect(article.querySelector(".wg__body .wk-spark")).toBeNull();
    const bleed = article.querySelector(".wg__bleed");
    expect(bleed?.querySelector(".wk-spark")).toBeTruthy();
    expect(bleed?.previousElementSibling?.classList.contains("wg__foot")).toBe(true);
    // Alone (the chat's own renderers), the body still draws it.
    cleanup();
    const alone = render(
      <WidgetBody
        spec={{ kind: "kpi", value: 7, spark: [1, 3, 2, 5] }}
        status="ok"
        color="sky"
        size={{ w: 1, h: 1 }}
        locale="en"
      />,
    );
    expect(alone.container.querySelector(".wk-spark")).toBeTruthy();
    // A number without a trend has no strip.
    cleanup();
    expect(card({ kind: "kpi", value: 7 }).container.querySelector(".wg__bleed")).toBeNull();
  });

  test("bars read only their numbers; the unit is one tag above them and the note a caption under them", () => {
    const { container } = card({
      kind: "bars",
      labels: ["Theo", "Atlas", "Ada"],
      values: [48, 1240, 0],
      unit: "rodadas por dia",
      note: "Ada não tem rotina, mas carrega 35 issues abertas.",
    });
    expect(container.querySelector(".wk-cap")?.textContent).toBe("rodadas por dia");
    expect([...container.querySelectorAll(".wk-bar__v")].map((v) => v.textContent)).toEqual(["48", "1.240", "0"]);
    // The unit still reads in each bar's tip.
    expect(container.querySelector(".wk-bar")?.getAttribute("title")).toBe("Theo: 48 rodadas por dia");
    const note = container.querySelector(".wk-note");
    expect(note?.textContent).toBe("Ada não tem rotina, mas carrega 35 issues abertas.");
    expect(note?.classList.contains("wk-clamp")).toBe(true);
  });

  test("the agent's face leads the title when given", () => {
    const { container } = card({ kind: "kpi", value: 1 }, { face: <span className="face">T</span> });
    const head = container.querySelector(".wg__head");
    expect(head?.firstElementChild?.classList.contains("wg__face")).toBe(true);
    expect(head?.querySelector(".wg__face .face")).toBeTruthy();
  });

  test("a goal: its share, the track filled that far, its line and its note", () => {
    const { container } = card({ kind: "goal", pct: 62, line: "R$ 248 mil de R$ 400 mil", note: "Bate no dia 27." });
    expect(container.querySelector(".wk-num")?.textContent).toBe("62%");
    expect((container.querySelector(".wk-goal__fill") as HTMLElement).style.width).toBe("62%");
    expect(container.querySelector(".wk-sub")?.textContent).toBe("R$ 248 mil de R$ 400 milBate no dia 27.");
  });

  test("bars: one per label with its value, the alert's bar called out, the tallest full height", () => {
    const { container } = card({
      kind: "bars",
      labels: ["Novos", "Separando", "Enviados", "Atrasados"],
      values: [14, 9, 31, 2],
      alertIndex: 3,
    });
    const bars = [...container.querySelectorAll(".wk-bar")];
    expect(bars.map((b) => b.querySelector(".wk-bar__v")?.textContent)).toEqual(["14", "9", "31", "2"]);
    expect(bars[3]?.hasAttribute("data-alert")).toBe(true);
    expect((bars[2]?.querySelector(".wk-bar__b") as HTMLElement | null)?.style.height).toBe("100%");
    expect([...container.querySelectorAll(".wk-axis span")].map((s) => s.textContent)).toEqual([
      "Novos",
      "Separando",
      "Enviados",
      "Atrasados",
    ]);
  });

  test("a line: the dither line, its labels and its note", () => {
    const { container } = card({
      kind: "line",
      labels: ["qua", "qui", "sex", "sáb", "dom", "seg", "ter"],
      values: [6.1, 5.8, 6.4, 4.9, 4.2, 4.4, 3.9],
      note: "3,9 min no último · −36%",
    });
    expect(container.querySelector(".wk-line")).toBeTruthy();
    expect(container.querySelectorAll(".wk-axis span")).toHaveLength(7);
    expect(container.querySelector(".wk-note")?.textContent).toBe("3,9 min no último · −36%");
  });

  test("a list: each row with its word, in its tone; a summary: its sentences", () => {
    const list = card({
      kind: "list",
      rows: [
        { text: "PR #212 · frete", meta: "falhou", tone: "warn" },
        { text: "PR #210 · login", meta: "aprovado", tone: "ok" },
        { text: "PR #208 · busca" },
      ],
    });
    const rows = [...list.container.querySelectorAll(".wk-list li")];
    expect(rows.map((r) => r.querySelector(".wk-list__t")?.textContent)).toEqual([
      "PR #212 · frete",
      "PR #210 · login",
      "PR #208 · busca",
    ]);
    expect(rows[0]?.querySelector(".wk-list__s")?.getAttribute("data-tone")).toBe("warn");
    expect(rows[2]?.querySelector(".wk-list__s")).toBeNull();
    cleanup();
    const text = card({ kind: "text", items: ["A Loja Norte baixou o frete.", "Nenhuma mudança de preço."] });
    expect([...text.container.querySelectorAll(".wk-text li")].map((li) => li.textContent)).toEqual([
      "A Loja Norte baixou o frete.",
      "Nenhuma mudança de preço.",
    ]);
  });

  test("a pinned chat chart reads the same as the widget it became", () => {
    const read = chartBlockToWidgetSpec(
      JSON.stringify({
        type: "bar",
        title: "Pedidos por canal",
        labels: ["Site", "App"],
        series: [{ values: [41, 26] }],
      }),
    );
    if (!read) throw new Error("not a chart");
    const { container } = render(
      <WidgetBody spec={read.spec} status="ok" color="sky" size={{ w: 2, h: 1 }} locale="pt-BR" />,
    );
    expect([...container.querySelectorAll(".wk-bar__v")].map((v) => v.textContent)).toEqual(["41", "26"]);
  });
});

describe("a widget's states", () => {
  test("being built: the agent's dither and what it is doing; no data yet", () => {
    const { container, getByRole } = card(null, {
      status: "building",
      buildingText: "Theo está montando o widget e a rotina que vai atualizar…",
    });
    expect(container.querySelector(".wk-build__dither")).toBeTruthy();
    expect(container.querySelector(".wk-build p")?.textContent).toBe(
      "Theo está montando o widget e a rotina que vai atualizar…",
    );
    const article = getByRole("article", { name: "Vendas hoje" });
    expect(article.getAttribute("data-state")).toBe("building");
    expect(article.getAttribute("aria-busy")).toBe("true");
  });

  test("updating keeps the last data under the sweep; failed keeps it, greyed; new data flashes once", async () => {
    const spec: WidgetSpec = { kind: "kpi", value: 100 };
    const view = card(spec, { status: "updating" });
    const article = view.getByRole("article", { name: "Vendas hoje" });
    expect(article.getAttribute("data-state")).toBe("updating");
    expect(article.querySelector(".wg__sweep")).toBeTruthy();
    expect(article.querySelector(".wk-num")?.textContent).toBe("100");
    view.rerender(
      <WidgetCard
        title="Vendas hoje"
        spec={{ kind: "kpi", value: 140 }}
        status="ok"
        color="amber"
        size={{ w: 2, h: 1 }}
        locale="pt-BR"
        footer={null}
      />,
    );
    await act(async () => {});
    expect(article.querySelector(".wg__body")?.classList.contains("wg__flash")).toBe(true);
    expect(article.querySelector(".wk-num")?.getAttribute("data-value")).toBe("140");
    view.rerender(
      <WidgetCard
        title="Vendas hoje"
        spec={{ kind: "kpi", value: 140 }}
        status="failed"
        color="amber"
        size={{ w: 2, h: 1 }}
        locale="pt-BR"
        footer={<span className="wg__warn">Não atualizou</span>}
      />,
    );
    expect(article.getAttribute("data-state")).toBe("failed");
    expect(article.querySelector(".wk-num")).toBeTruthy();
    expect(article.querySelector(".wg__foot")?.textContent).toBe("Não atualizou");
  });

  test("its title opens it; its actions sit in the head", () => {
    let opened = 0;
    const view = card(
      { kind: "kpi", value: 1 },
      { onOpen: () => opened++, actions: <button type="button">Mais</button> },
    );
    fireEvent.click(view.getByRole("button", { name: "Vendas hoje" }));
    expect(opened).toBe(1);
    expect(view.container.querySelector(".wg__acts")?.textContent).toBe("Mais");
  });
});

describe("Organize on a widget", () => {
  test("the size, remove and the grip take the actions' place; the grip's arrows move it", () => {
    const calls: string[] = [];
    const view = card(
      { kind: "kpi", value: 1 },
      {
        actions: <button type="button">Mais</button>,
        organize: {
          sizeLabel: "Tamanho",
          sizeText: "M",
          removeLabel: "Tirar do Início",
          dragLabel: "Arraste para mover",
          onSize: () => calls.push("size"),
          onRemove: () => calls.push("remove"),
          onMove: (d) => calls.push(`move ${d}`),
        },
      },
    );
    expect(view.queryByRole("button", { name: "Mais" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Tamanho: M" }));
    fireEvent.click(view.getByRole("button", { name: "Tirar do Início" }));
    const grip = view.getByRole("button", { name: "Arraste para mover" });
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    fireEvent.keyDown(grip, { key: "a" });
    expect(calls).toEqual(["size", "remove", "move 1", "move -1"]);
    // The title doesn't open while organizing.
    expect(view.queryByRole("button", { name: "Vendas hoje" })).toBeNull();
  });
});

describe("the agent's tones", () => {
  test("the stroke deep on a light page and light on a dark one; the fill a 2px Bayer tile", () => {
    const light = widgetTones("amber", false);
    const dark = widgetTones("amber", true);
    expect(light.stroke).not.toBe(dark.stroke);
    const vars = widgetTileVars("amber", false) as unknown as Record<string, string>;
    expect(vars["--wg-s"]).toBe(light.stroke);
    expect(vars["--wg-f"]).toBe(light.fill);
    expect(vars["--wg-tile"]).toBe(ditherTile(light.fill));
    const svg = decodeURIComponent(vars["--wg-tile"] ?? "");
    expect(svg).toContain('width="8" height="8"');
    expect(svg).toContain('width="2" height="2"');
    // Cached: the same string for the same tone.
    expect(ditherTile(light.fill)).toBe(vars["--wg-tile"] as string);
  });

  test("each format has its glyph, decorative", () => {
    for (const kind of ["auto", "kpi", "goal", "bars", "line", "list", "text"] as const) {
      const { container } = render(<WidgetGlyph kind={kind} size={28} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.children.length).toBeGreaterThan(0);
      cleanup();
    }
  });
});
