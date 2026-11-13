import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, comfortable, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ROOT = new URL("../../../", import.meta.url).pathname;

/** A message in #eng, `minutes` before now; people by user id ("u-walter" is me), agents by agent id. */
const said = (id: string, who: string, body: string, minutes: number, extra: Partial<Message> = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: who.startsWith("u-") ? { type: "person", id: who } : { type: "agent", id: who },
    body,
    mentionedAgentIds: [],
    agentRunId: who.startsWith("u-") ? null : `r-${id}`,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    ...extra,
  }) as Message;

async function open(messages: Message[]) {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(comfortable(seedState({ messages }))) });
  await settle(10);
}

/** The kit's rules, by selector: their bodies joined. */
const rules = async () => {
  const css = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const [, list = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    for (const raw of list.split(",")) {
      const selector = raw.trim().replace(/\s+/g, " ");
      out.set(selector, `${out.get(selector) ?? ""}${body}`);
    }
  return out;
};

const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};

describe("my own messages sit on the right", () => {
  test("mine get the own class and their place in the run; others' rows stay as they were", async () => {
    await open([
      said("j1", "u-joao", "Bom dia!", 10),
      said("w1", "u-walter", "Vi o alerta também", 9),
      said("w2", "u-walter", "Estou no celular", 9),
      said("w3", "u-walter", "@ada consegue olhar?", 8, { mentionedAgentIds: [ADA_ID] }),
      said("a1", ADA_ID, "Olhando.", 7),
      said("w4", "u-walter", "Valeu", 6),
    ]);
    expect(
      ["w1", "w2", "w3", "w4"].map((id) => [row(id).classList.contains("ac-msg--own"), row(id).dataset.run]),
    ).toEqual([
      [true, "start"],
      [true, "mid"],
      [true, "end"],
      [true, "solo"],
    ]);
    for (const id of ["j1", "a1"]) {
      expect(row(id).classList.contains("ac-msg--own")).toBe(false);
      expect(row(id).dataset.run).toBeUndefined();
    }
    // No face; the name and time stay for screen readers, and the bar is still named after me.
    expect(row("w1").querySelector(".ac-msg__avatar")).toBeNull();
    const head = row("w1").querySelector(".ac-msg__body > div");
    expect(head?.className).toBe("ac-visually-hidden");
    expect(head?.textContent).toContain("Walter");
    expect(within(row("w1")).getByRole("toolbar", { name: "Ações da mensagem de Walter" })).toBeTruthy();
    // The time once per run, under its last row (never read twice).
    expect(["w1", "w2", "w3", "w4"].map((id) => Boolean(row(id).querySelector(".ac-msg__own-time")))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(row("w3").querySelector(".ac-msg__own-time")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the receipt follows the time under the turn's last bubble, and no time hangs in the far-left column", async () => {
    await open([
      said("w1", "u-walter", "Vi o alerta também", 9),
      said("w2", "u-walter", "Estou no celular", 9),
      said("w3", "u-walter", "@ada consegue olhar?", 8, {
        mentionedAgentIds: [ADA_ID],
        receipts: { seenBy: [ADA_ID], pickedBy: [], handled: [] },
      }),
    ]);
    // Time, then the check, one line under the turn's last bubble ("8:39 PM ✓"); nothing left of the bubble.
    const foot = row("w3").querySelector(".ac-msg__own-foot") as HTMLElement;
    expect([...foot.children].map((part) => part.className)).toEqual(["ac-msg__own-time", "ac-msg__aside"]);
    expect(foot.querySelector(".ac-msg__aside .ac-receipt__check")?.tagName).toBe("BUTTON");
    expect(row("w3").querySelector(".ac-msg__aside--floating")).toBeNull();
    // The rows before a run's last: no hover time in the far-left column, where everyone else's grouped rows have it.
    for (const id of ["w1", "w2", "w3"])
      expect(row(id).querySelector(".ac-msg__gutter, .ac-msg__gutter-time")).toBeNull();
    for (const id of ["w1", "w2"]) expect(row(id).querySelector(".ac-msg__own-foot")).toBeNull();
  });

  test("something under a bubble ends the run's look: the next bubble doesn't square off against it", async () => {
    await open([
      said("w1", "u-walter", "Vi o alerta também", 9, {
        reactions: [{ reaction: "+1", count: 1, userIds: ["u-joao"] }] as Message["reactions"],
      }),
      said("w2", "u-walter", "Estou no celular", 9),
      said("w3", "u-walter", "Já volto", 8),
    ]);
    // The rule finds what hangs as the bubble's later siblings (its style is checked in Chrome: happy-dom's :has is
    // unreliable): the reactions here, and on the rows under it only the bar and an empty foot, which don't count.
    expect(row("w1").querySelector(".ac-msg__text ~ .ac-reacts")).toBeTruthy();
    for (const id of ["w2", "w3"])
      expect(
        [...row(id).querySelectorAll(".ac-msg__text ~ *")].every(
          (e) => e.matches(".ac-msg__actions") || e.childNodes.length === 0,
        ),
      ).toBe(true);
    const css = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text())
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")");
    const hanging =
      ".ac-msg--own:has(> .ac-msg__body > .ac-msg__text ~ :not(.ac-msg__actions, .ac-msg__own-foot, :empty))";
    expect(css).toContain(`${hanging} .ac-msg__text { border-bottom-right-radius: var(--own-cut); }`);
    expect(css).toContain(`${hanging} + .ac-msg--own .ac-msg__text { border-top-right-radius: 18px; }`);
  });

  test("a code block or a table takes the whole width; plain words stay a bubble", async () => {
    await open([
      said("w1", "u-walter", "Assim:\n\n```ts\nconst a = 1;\n```", 9),
      said("j1", "u-joao", "ok", 8),
      said("w2", "u-walter", "| a | b |\n| --- | --- |\n| 1 | 2 |", 7),
      said("j2", "u-joao", "ok", 6),
      said("w3", "u-walter", "só texto, com `código` e a | barra", 5),
    ]);
    expect(["w1", "w2", "w3"].map((id) => row(id).classList.contains("ac-msg--wide"))).toEqual([true, true, false]);
  });

  test("sending says so in the time's place; a send that failed keeps its words and Tentar de novo", async () => {
    await open([
      said("w1", "u-walter", "Mandando o resumo", 2, { local: "failed", clientId: "c-1" }),
      said("j1", "u-joao", "ok", 1),
      said("w2", "u-walter", "E o link", 0, { local: "pending", clientId: "c-2" }),
    ]);
    expect(row("w1").classList.contains("ac-msg--failed")).toBe(true);
    expect(row("w1").textContent).toContain("Não enviada");
    expect(within(row("w1")).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(row("w2").classList.contains("ac-msg--pending")).toBe(true);
    const status = row("w2").querySelector(".ac-msg__own-time");
    expect(status?.classList.contains("ac-msg__status")).toBe(true);
    expect(status?.textContent).toContain("enviando");
    expect(status?.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("own message styles", () => {
  test("the bar stands left of the bubble, never over my words; the check ends the time's line, always on screen", async () => {
    const r = await rules();
    const css = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    // With a mouse: flat icons 2px left of the bubble, their middle on its first line (7px padding + half the words'
    // line at the person's text size - half a 30px button), inside the row, so never in the gap above.
    const mouse =
      css
        .split(
          "@media not ((hover: none) or (pointer: coarse)) {\n  .ac-msg--own > .ac-msg__body > .ac-msg__actions {",
        )[1]
        ?.split("\n}")[0] ?? "";
    expect(mouse).toContain("right: calc(100% + 2px);");
    const bar = r.get(".ac-msg--own > .ac-msg__body > .ac-msg__actions") ?? "";
    expect(bar).toContain("right: calc(100% + 2px)");
    expect(bar).toContain("top: calc(7px + var(--msg-line) / 2 - var(--cap-mid) - 14px)");
    expect(bar).toMatch(/background: transparent;\s*box-shadow: none;\s*transform: none;/);
    expect(bar).not.toContain("top: 0");
    // A check at a row's end moves no row's bar, so mine needs no rule of its own to stay put beside one.
    expect(
      [...r.keys()].filter(
        (sel) => sel.includes(".ac-msg__actions") && sel.includes(":has(> .ac-msg__body .ac-msg__aside"),
      ),
    ).toEqual([]);
    // Three 28px square icons fit the row's 96px left padding beside a full-width bubble.
    expect(mouse).toMatch(/\.ac-msg__actions \.ac-btn--sm \{\s*min-width: 28px;\s*width: 28px;\s*height: 28px;/);
    // The bubble's padding and line, which the bar's top is computed from.
    expect(r.get(".ac-msg--own .ac-msg__text")).toContain("padding: 7px 14px");
    expect(r.get(".ac-msg__text")).toMatch(/font-size: var\(--msg-text\);\s*line-height: var\(--msg-line\)/);
    // The check in the time's line, on the bubble's right edge: no line of its own, and no room while it's empty.
    expect(r.get(".ac-msg__own-foot")).toContain("justify-content: flex-end");
    expect(r.get(".ac-msg__own-foot > .ac-msg__aside")).toContain("height: 16px");
    expect(r.get(".ac-msg__own-foot .ac-receipt__check")).toContain("padding: 0");
    // No hover, focus or open menu hides it.
    const kit = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const own = [...kit.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, list = ""]) =>
      list.includes(".ac-msg__own-foot"),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const [, , body = ""] of own) expect(body).not.toMatch(/opacity|visibility|display:\s*none/);
  });

  test("every bar keeps Reagir first; only beside my bubble does the screen reverse it, and nowhere on touch", async () => {
    await open([said("j1", "u-joao", "Bom dia!", 10), said("w1", "u-walter", "Vi o alerta também", 9)]);
    const names = (id: string) =>
      within(row(id))
        .getAllByRole("button")
        .filter((b) => b.closest(".ac-msg__actions"))
        .map((b) => b.getAttribute("aria-label"));
    expect(names("w1")).toEqual(["Reagir", "Responder", "Mais ações da mensagem"]);
    expect(names("j1")).toEqual(["Reagir", "Responder", "Mais ações da mensagem"]);
    const css = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    const blocks = css.split(/\n@media /).map((b) => b.split("\n}\n")[0] ?? "");
    const reversing = blocks.filter((b) => /\.ac-msg--own[^{]*\.ac-msg__actions \{[^}]*row-reverse/.test(b));
    // The left-of-bubble block is the touch block's exact complement, so no pointer setup gets neither.
    expect(reversing.map((b) => b.split(" {")[0])).toEqual(["not ((hover: none) or (pointer: coarse))"]);
    expect(blocks.some((b) => b.startsWith("(hover: none), (pointer: coarse) {\n  .ac-msg--own"))).toBe(true);
  });

  test("a turn's bubble ends on the cut corner, on the side it stands", async () => {
    const r = await rules();
    const css = (await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text()).replace(/\s+/g, " ");
    expect(css).toContain(
      '.ac-msg--own:is([data-run="solo"], [data-run="end"]) .ac-msg__text { border-bottom-right-radius: var(--own-cut); }',
    );
    expect(r.get('.ac-msg--own[data-run="start"] .ac-msg__text')).toContain("border-bottom-right-radius: 6px");
  });

  test("a narrow window keeps room for the bar left of the bubble; a touch screen's bar sits over its top edge", async () => {
    const r = await rules();
    // Beside a full-width bubble, at any width with a mouse, the 96px padding holds it (82px) left of the bubble.
    expect(r.get(".ac-msg--own")).toContain("padding-left: 96px");
    const css = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    // Any bubble may take a narrow row, so wrapped words, code, a table and a file share one left edge; a phone
    // keeps 64px of it.
    expect(css).toContain("@media (max-width: 600px) {\n  .ac-msg--own > .ac-msg__body {\n    --own-max: 100%;");
    expect(css).toContain("@media (max-width: 600px) and (hover: none) {\n  .ac-msg--own {\n    padding-left: 64px;");
    expect(css).not.toContain(".ac-msg--own > .ac-msg__gutter");
    const narrow = css.split("@media (hover: none), (pointer: coarse) {")[1]?.split("\n}")[0] ?? "";
    expect(narrow).toContain(".ac-msg--own > .ac-msg__body > .ac-msg__actions");
    expect(narrow).toContain("top: -4px;\n    right: 8px;");
  });

  test("the bubble's colors come from the theme's tokens, and wide rows take the row", async () => {
    const r = await rules();
    const bubble = r.get(".ac-msg--own .ac-msg__text") ?? "";
    expect(bubble).toContain("background: var(--own-bubble)");
    expect(bubble).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(r.get(".ac-msg--own.ac-msg--wide > .ac-msg__body")).toContain("--own-max: 100%");
    // It may grow to the row but stays as wide as what it holds: a small table never sits in a wide empty bubble.
    expect(r.get(".ac-msg--own.ac-msg--wide > .ac-msg__body")).not.toContain("flex:");
    expect(r.get(".ac-msg--own.ac-msg--wide .ac-msg__text")).toBeUndefined();
    // 70% of a wide row; a narrow column (a thread beside the chat) lets it take the row up to 400px.
    expect(r.get(".ac-msg--own > .ac-msg__body")).toContain("--own-max: max(min(70%, 640px), min(100%, 400px))");
    expect(r.get(".ac-msg--own.ac-msg--failed .ac-msg__text")).toContain("var(--danger)");
  });
});

describe("code, tables and reactions on my bubble", () => {
  test("words and a code block in one message are one bubble, the code inside it", async () => {
    await open([
      said("j1", "u-joao", "Alguém olhou?", 9),
      said("w1", "u-walter", "Achei a consulta:\n\n```sql\ncreate index orders_idx on orders (created_at);\n```", 8),
    ]);
    const bubbles = row("w1").querySelectorAll(".ac-msg__text");
    expect(bubbles.length).toBe(1);
    expect(bubbles[0]?.querySelector("p")?.textContent).toBe("Achei a consulta:");
    expect(bubbles[0]?.querySelector(".code-card pre")?.textContent).toContain("create index");
    expect(row("w1").classList.contains("ac-msg--wide")).toBe(true);
  });

  test("a code card in a message is one plate: the kit's bare-pre plate stays off it, a table takes the page color", async () => {
    const css = (await Bun.file(`${ROOT}apps/web/src/layout.css`).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    const code = block(".ac-msg__text .code-card__code");
    for (const decl of ["margin: 0;", "padding: 0 16px 14px;", "background: none;", "border-radius: 0;"])
      expect(code).toContain(decl);
    expect(block(".ac-msg--own .ac-msg__text .md__table")).toContain("background: var(--bg);");
    const kit = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    // As far from the bubble's top or bottom edge as from its sides.
    expect(kit).toContain(
      ".ac-msg--own .ac-msg__text .md > :is(.code-card, .md__table):first-child {\n  margin-top: 7px;",
    );
    expect(kit).toContain(
      ".ac-msg--own .ac-msg__text .md > :is(.code-card, .md__table):last-child {\n  margin-bottom: 7px;",
    );
  });

  test("the reactions' add button shows on touch screens for everyone's rows; mine only puts it first", async () => {
    const kit = await Bun.file(`${ROOT}packages/ui/src/styles/components.css`).text();
    expect(kit).toContain("@media (hover: none) {\n  .ac-react--add {\n    opacity: 1;");
    const own = kit.split("\n.ac-msg--own .ac-react--add {")[1]?.split("}")[0] ?? "";
    expect(own.trim()).toBe("order: -1;");
    await open([
      said("j1", "u-joao", "Alguém olhou?", 9, {
        reactions: [{ reaction: "+1", count: 1, userIds: ["u-walter"] }] as Message["reactions"],
      }),
      said("w1", "u-walter", "Olhei agora", 8, {
        reactions: [{ reaction: "+1", count: 1, userIds: ["u-joao"] }] as Message["reactions"],
      }),
    ]);
    for (const id of ["j1", "w1"]) expect(row(id).querySelector(".ac-reacts .ac-react--add")).toBeTruthy();
  });
});

describe("the bar hugs my message, a GIF or a picture too", () => {
  const GIF = { kind: "gif", provider: "giphy", id: "gif-party", title: "party cat", width: 498, height: 280 };
  /** What takes room in a row's body: its hidden head, the bar (which floats) and empty parts left out. */
  const taking = (el: HTMLElement) =>
    [...(el.querySelector(".ac-msg__body")?.children ?? [])]
      .filter((c) => !c.matches(".ac-visually-hidden, .ac-msg__actions") && c.childNodes.length > 0)
      .map((c) => c.className);

  test("my GIF's row holds the GIF and its time only, the bar beside them; someone else's row keeps its bar", async () => {
    await open([
      said("j1", "u-joao", "", 9, { meta: { media: GIF } }),
      said("w1", "u-walter", "nao ne amigao", 8),
      said("j2", "u-joao", "ok", 7),
      said("w2", "u-walter", "", 6, { meta: { media: GIF } }),
    ]);
    for (const id of ["w1", "w2"]) {
      // Off touch the bar stands at `right: calc(100% + 2px)` of the body: the body is the bubble's (or GIF's) width.
      expect(row(id).querySelector(".ac-msg__body > .ac-msg__actions")?.getAttribute("role")).toBe("toolbar");
    }
    expect(taking(row("w1"))).toEqual(["ac-msg__text", "ac-msg__own-foot"]);
    expect(taking(row("w2"))).toEqual(["ac-gif", "ac-msg__own-foot"]);
    expect((row("w2").querySelector(".ac-gif") as HTMLElement).style.getPropertyValue("--gif-w")).toBe("300px");
    // Someone else's GIF: their face and the bar on the row's right, as before.
    expect(row("j1").classList.contains("ac-msg--own")).toBe(false);
    expect(row("j1").querySelector(".ac-msg__avatar")).toBeTruthy();
    expect(row("j1").querySelector(".ac-msg__body > .ac-msg__actions")).toBeTruthy();
  });

  test("a GIF and a picture cap their width with a length, so a row sized to what it holds is no wider than they are", async () => {
    const r = await rules();
    // A percentage (`min(100%, 300px)`) counts as no cap while a box sizes to its content: my row would take the
    // file's whole width (498px here) and its bar would stand that far left of a 300px GIF.
    const gif = r.get(".ac-gif") ?? "";
    expect(gif).toContain("width: var(--gif-w, 300px);");
    expect(gif).toContain("max-width: 100%;");
    expect(gif).not.toContain("min(100%");
    const app = (await Bun.file(`${ROOT}apps/web/src/layout.css`).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (selector: string) => app.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(block(".artifact-tile")).toContain("--tile-w: 206px;");
    expect(block(".artifact-cards > .artifact-tile:only-child")).toContain("--tile-w: 320px;");
    for (const sel of [".artifact-tile", ".artifact-cards > .artifact-tile:only-child"])
      expect(block(sel)).not.toContain("min(100%");
    // Others' rows keep their bar on the row's right, a keyboard's focus shows it too.
    expect(r.get(".ac-msg__actions")).toContain("right: 12px");
    expect(r.get("html:not([data-pointer]) .ac-msg:focus-within .ac-msg__actions")).toContain(
      "transform: translateY(-50%)",
    );
  });
});

describe("a message I send keeps its size when the server has it", () => {
  /** Everything about a row that sets its size: its classes but the sending ones, its place in the run, its parts. */
  const shape = (el: HTMLElement) => ({
    row: [...el.classList].filter((c) => c !== "ac-msg--local" && c !== "ac-msg--pending").sort(),
    run: el.dataset.run,
    parts: [...(el.querySelector(".ac-msg__body")?.children ?? [])]
      .filter((c) => !c.matches(".ac-msg__actions") && c.childNodes.length > 0)
      .map((c) => c.className),
  });
  // By the message's own words: a row's hidden head also reads its day ("segunda-feira, 9 de novembro").
  const rowWith = (text: string) =>
    [...document.querySelectorAll<HTMLElement>("article")].find((a) =>
      a.querySelector(".ac-msg__text")?.textContent?.includes(text),
    ) as HTMLElement;

  test("sending and sent: the same row, the same parts, the time in the sending state's box; nothing scrolls", async () => {
    let release = () => {};
    const state = comfortable(seedState({ messages: [said("j1", "u-joao", "Bom dia!", 10)] }));
    state.holdPosts = new Promise<void>((r) => {
      release = r;
    });
    const api = createFakeApi(state);
    // The server writes them in the order they came, a moment apart.
    const post = api.chat.post;
    let sent = 0;
    api.chat.post = async (...args: Parameters<typeof post>) => {
      const later = sent++ * 5;
      await state.holdPosts;
      await new Promise((r) => setTimeout(r, later));
      return post(...args);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    const composer = screen().getByRole("combobox", { name: /Mensagem para/ });
    // Two quick ones: the first is still on its way when the second goes (a run's first row and its last).
    for (const text of ["primeira", "segunda"]) {
      await act(async () => fireEvent.change(composer, { target: { value: text } }));
      await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    }
    await settle(2);
    const [first, last] = [rowWith("primeira"), rowWith("segunda")];
    expect(last.classList.contains("ac-msg--pending")).toBe(true);
    const before = [shape(first), shape(last)];
    expect(before.map((s) => s.run)).toEqual(["start", "end"]);
    // The run's first row has no line under its bubble while it sends either (its state is read in its hidden head).
    expect(before[0]?.parts).toEqual(["ac-visually-hidden", "ac-msg__text"]);
    expect(first.querySelector(".ac-visually-hidden")?.textContent).toContain("enviando");
    expect(before[1]?.parts).toEqual(["ac-visually-hidden", "ac-msg__text", "ac-msg__own-foot"]);
    const foot = last.querySelector(".ac-msg__own-foot");
    expect(foot?.querySelector(".ac-msg__status")?.textContent).toContain("enviando");
    const list = screen().getByRole("region", { name: "Mensagens" });
    const scrolled: unknown[] = [];
    list.scrollTo = ((opts: ScrollToOptions) => scrolled.push(opts)) as typeof list.scrollTo;
    const top = list.scrollTop;
    await act(async () => release());
    await act(() => new Promise((r) => setTimeout(r, 20)));
    await settle(4);
    expect(rowWith("segunda")).toBe(last);
    expect(last.classList.contains("ac-msg--pending")).toBe(false);
    expect([shape(first), shape(last)]).toEqual(before);
    // The time took the sending state's place in the same box.
    expect(last.querySelector(".ac-msg__own-foot") === foot).toBe(true);
    expect(foot?.querySelector(".ac-msg__own-time")?.textContent).toMatch(/\d/);
    expect(scrolled).toEqual([]);
    expect(list.scrollTop).toBe(top);
  });
});
