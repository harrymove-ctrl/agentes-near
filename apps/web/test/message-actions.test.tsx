import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { messageLink } from "@/components/MessageMore";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return screen().getByRole("menu");
};
/** A phone: no hover, touch points. Returns what puts the browser back. */
const onTouch = () => {
  const media = spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("hover: none"),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const points = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  return () => {
    media.mockRestore();
    if (points) Object.defineProperty(navigator, "maxTouchPoints", points);
    else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
  };
};
/** No agent has an AI: a message nobody can answer says so under it, with Conectar. */
const withoutAi = () =>
  seedState({
    aiStatus: {
      any: false,
      agents: [ADA_ID, ATLAS_ID].map((agentId) => ({ agentId, state: "no_ai" as const, reason: "no_key" })),
    },
  });
const noAi = { seenBy: [], pickedBy: [], handled: [], noAi: true };
/** A person's message in #eng, `minutes` before now. */
const said = (id: string, body: string, minutes: number, receipts?: Message["receipts"], who = "u-walter") =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: who },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    receipts,
  }) as Message;

describe("message action bars", () => {
  test("people's messages get the glass bar with '…': the same list as the right click", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    expect(bar.className).toContain("ac-msg__actions");
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.getAttribute("aria-label") ?? i.textContent),
    ).toEqual([
      "👍",
      "🎉",
      "👀",
      "✅",
      "❤️",
      "Adicionar reação",
      "Responder",
      "Copiar texto",
      "Copiar link da mensagem",
      "Fixar mensagem",
      "Salvar na wiki",
    ]);
  });

  test("agents keep 👍 👎 ✏️, get Reagir and Responder, and the same '…'", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    expect(within(bar).getByRole("button", { name: "Útil" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Não ajudou" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Corrigir resposta" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Reagir" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Responder" })).toBeTruthy();
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    // Não ajudou and Corrigir stay on the bar: the "…" is the right click's list.
    expect(within(menu).queryByRole("menuitem", { name: "Não ajudou" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Fixar mensagem" })).toBeTruthy();
  });

  test("Copiar link da mensagem copies the message's address", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => void copied.push(s) },
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    await click(within(menu).getByRole("menuitem", { name: "Copiar link da mensagem" }));
    await settle(2);
    expect(copied[0]).toBe(messageLink(window.location.origin, ORG_ID, { id: "m-1", channelId: ENG_ID }));
    expect(document.body.textContent).toContain("Link copiado.");
  });

  test("Responder opens the message's thread in the panel; the reply there takes the rest out of the channel", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    await click(within(bar).getByRole("button", { name: "Responder" }));
    await settle(6);
    // The thread beside the channel: João's message on top. Ada answered in the channel, so her
    // reply stays there and is not repeated in the new thread.
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(within(panel).getByRole("button", { name: "Fechar a thread" })).toBeTruthy();
    expect(panel.textContent).toContain("o login está devolvendo 401");
    expect(panel.textContent).not.toContain("Achei a causa");
    const box = within(panel).getByRole("combobox", { name: "Responder na thread" });
    await act(async () => fireEvent.change(box, { target: { value: "vou olhar" } }));
    await click(within(panel).getByRole("button", { name: "Enviar" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toMatchObject({
      body: "vou olhar",
      threadId: "m-1",
      openThread: true,
    });
    // From my reply on, the thread leaves the channel: one line where it was (pressed while open).
    // The panel floats over the channel (inside its region): only the channel's own messages count.
    const channel = screen()
      .getAllByRole("region", { name: /Mensagens/ })
      .find((r) => !panel.contains(r)) as HTMLElement;
    const inChannel = [...channel.querySelectorAll("[data-message-id]")].filter((m) => !panel.contains(m));
    expect(inChannel.map((m) => m.textContent).join(" ")).not.toContain("vou olhar");
    expect(
      within(channel)
        .getByRole("button", { name: /1 resposta/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("a check ends the first line, words go under the text, and the bar keeps one place on every row", async () => {
    const state = withoutAi();
    const answered = {
      seenBy: [ADA_ID],
      pickedBy: [ADA_ID],
      handled: [{ agentId: ADA_ID, runId: "r-a", status: "done" as const }],
      blocked: [],
    };
    state.messages = [
      said("w1", "Bom dia! Esta semana a gente fecha os rótulos.", 20, noAi),
      said("w2", "Mando os arquivos para a gráfica na sexta.", 19.5, noAi),
      said("j1", "Subi a correção do login.", 10, answered, "u-joao"),
      said("j2", "E aumentei o tempo da sessão.", 9.5, answered, "u-joao"),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
    // Words with an action: the message's last line, on a first and a grouped message alike, never in the header.
    for (const id of ["w1", "w2"]) {
      const foot = row(id).querySelector(".ac-msg__body > .ac-msg__foot:last-child") as HTMLElement;
      // The words, then the dot and its action as one piece that wraps whole, on the words' own column.
      const words = foot.querySelector(".ac-receipt > .ac-receipt__words");
      expect([...(words?.children ?? [])].map((part) => part.textContent)).toEqual([
        "Ninguém vai responder: falta uma IA",
        "·Conectar",
      ]);
      expect(
        words?.querySelector(":scope > .ac-receipt__then > .ac-receipt__dot[aria-hidden='true']")?.textContent,
      ).toBe("·");
      expect(within(foot).getByRole("button", { name: "Conectar" })).toBeTruthy();
      expect(row(id).querySelector(".ac-msg__head .ac-receipt, .ac-msg__aside .ac-receipt")).toBeNull();
    }
    expect(row("w2").className).toContain("ac-msg--grouped");
    // A check alone: at the end of the name's line, or of a grouped message's first line; nothing under the text.
    expect(row("j1").querySelector(".ac-msg__head .ac-msg__aside .ac-receipt__check")).not.toBeNull();
    expect(row("j2").querySelector(".ac-msg__aside--floating .ac-receipt__check")).not.toBeNull();
    // The part a message doesn't use is left empty, which the kit hides: no row's bar moves for what ends its line.
    for (const id of ["j1", "j2"]) expect(row(id).querySelector(".ac-msg__foot")?.childNodes.length).toBe(0);
    for (const id of ["w1", "w2"]) expect(row(id).querySelector(".ac-msg__aside")?.childNodes.length ?? 0).toBe(0);
    // The bar's place is the kit's (components.test.tsx): no stylesheet of the app moves it, and a row's side padding
    // is set through `--msg-inline`.
    const src = join(import.meta.dir, "../src");
    const sheets = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
      );
    const rules = sheets(src).flatMap((file) =>
      [
        ...readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .matchAll(/([^{}]+)\{([^{}]*)\}/g),
      ].map((m) => ({
        at: `${file.slice(src.length)} ${(m[1] ?? "").trim()}`,
        selector: m[1] ?? "",
        body: m[2] ?? "",
      })),
    );
    const moved = rules.filter(
      (r) => r.selector.includes("ac-msg__actions") && /(^|;)\s*(top|bottom|inset)\s*:/.test(r.body),
    );
    expect(moved.map((r) => r.at)).toEqual([]);
    const rows = rules.filter((r) => /\.channel__messages[^,]*\.ac-msg\s*$/.test(r.selector));
    expect(rows.filter((r) => /(^|;)\s*padding(-left|-right|-inline)?\s*:/.test(r.body)).map((r) => r.at)).toEqual([]);
    expect(rows.some((r) => /--msg-inline:\s*12px/.test(r.body))).toBe(true);
  });

  test("past the platform AI cap the receipt's words go under the text, never by the name", async () => {
    const state = seedState();
    state.messages = [
      {
        id: "c1",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-walter" },
        body: "Alguém revisa o contrato?",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: NOW.toISOString(),
        receipts: { seenBy: [], pickedBy: [], handled: [], platformCap: true },
      } as Message,
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const row = document.querySelector('article[data-message-id="c1"]') as HTMLElement;
    const foot = row.querySelector(".ac-msg__body > .ac-msg__foot:last-child") as HTMLElement;
    expect(foot.querySelector(".ac-receipt > .ac-receipt__words")?.textContent).toBe(
      "Mencione um agente com @ para ele responder.",
    );
    expect(row.querySelector(".ac-msg__head .ac-receipt, .ac-msg__aside .ac-receipt")).toBeNull();
  });

  test("on touch a tap on a message opens its bar's actions in a menu off its text, an agent's with its feedback", async () => {
    const restore = onTouch();
    try {
      const state = seedState();
      // A file with no words.
      state.messages.push({
        id: "m-file",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      });
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
      await settle(8);
      const tap = (id: string) =>
        click(document.querySelector(`article[data-message-id="${id}"] .ac-msg__text`) as HTMLElement);
      await tap("m-1");
      const menu = screen().getByRole("menu", { name: "Ações da mensagem de João" });
      // The quick reactions, then every emoji, as the bar's Reagir has.
      const reactions = within(menu).getByRole("group", { name: "Reagir" });
      expect(
        within(reactions)
          .getAllByRole("menuitem")
          .map((c) => c.getAttribute("aria-label") ?? c.textContent),
      ).toEqual(["👍", "🎉", "👀", "✅", "❤️", "Adicionar reação"]);
      const items = (m: HTMLElement) =>
        within(m)
          .getAllByRole("menuitem")
          .filter((i) => !i.classList.contains("ac-menu__reaction"))
          .map((i) => i.textContent);
      // What the bar and its "…" have, as the desktop app's right click lists it.
      expect(items(menu)).toEqual([
        "Responder",
        "Copiar texto",
        "Copiar link da mensagem",
        "Fixar mensagem",
        "Salvar na wiki",
      ]);
      expect(document.querySelector('article[data-message-id="m-1"]')?.getAttribute("data-menu-open")).toBe("true");
      await click(within(reactions).getByRole("menuitem", { name: "Adicionar reação" }));
      await settle(1);
      expect(screen().queryByRole("menu")).toBeNull();
      const picker = screen().getByRole("dialog", { name: "Emojis" });
      await click(within(picker).getByRole("button", { name: "rocket" }));
      await settle(3);
      expect(state.calls.find((c) => c.method === "chat.react")?.args).toEqual([ORG_ID, "m-1", "🚀"]);
      expect(screen().queryByRole("dialog", { name: "Emojis" })).toBeNull();
      await tap("m-file");
      // No words: nothing to copy or to save, as on the phone app.
      expect(items(screen().getByRole("menu", { name: "Ações da mensagem de João" }))).toEqual([
        "Responder",
        "Copiar link da mensagem",
        "Fixar mensagem",
      ]);
      await act(async () => fireEvent.keyDown(screen().getByRole("menu"), { key: "Escape" }));
      expect(screen().queryByRole("menu")).toBeNull();
      await tap("m-2");
      const agent = screen().getByRole("menu", { name: "Ações da mensagem de Ada" });
      expect(items(agent)).toEqual([
        "Responder",
        "Não ajudou",
        "Corrigir resposta",
        "Copiar texto",
        "Copiar link da mensagem",
        "Fixar mensagem",
        "Salvar na wiki",
      ]);
      await click(within(agent).getByRole("menuitem", { name: "Corrigir resposta" }));
      await settle(2);
      expect(screen().getByRole("dialog", { name: "Corrigir a resposta da Ada" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  test("on touch the first tap on a message opens its actions while another row holds focus (Conectar's dialog closed, a link tapped)", async () => {
    const restore = onTouch();
    try {
      const state = withoutAi();
      state.messages = [
        said("w1", "Mando os arquivos para a gráfica na sexta.", 20, noAi),
        said("w2", "O briefing está em https://agentes.chat/help/who-answers, confere?", 19),
        said("w3", "Os rótulos ficam com o verde antigo?", 18),
      ];
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
      await settle(8);
      const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
      // As a phone sends a tap: the finger goes down (focus leaves the row that held it), lifts, then the click.
      const tap = (id: string) =>
        act(async () => {
          const text = row(id).querySelector(".ac-msg__text") as HTMLElement;
          fireEvent.pointerDown(text);
          fireEvent.mouseDown(text);
          (document.activeElement as HTMLElement | null)?.blur();
          fireEvent.pointerUp(text);
          fireEvent.mouseUp(text);
          fireEvent.click(text);
        });
      const actionsOpen = (id: string) => {
        expect(screen().getByRole("menu", { name: "Ações da mensagem de Walter" })).toBeTruthy();
        expect([...document.querySelectorAll('[data-menu-open="true"]')]).toEqual([row(id)]);
      };
      // Conectar's dialog, closed: focus is back on Conectar, in its row.
      const conectar = within(row("w1")).getByRole("button", { name: "Conectar" });
      conectar.focus();
      await click(conectar);
      await settle(2);
      await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Fechar" }));
      await settle(2);
      expect(document.activeElement === conectar).toBe(true);
      await tap("w2");
      actionsOpen("w2");
      await act(async () => fireEvent.keyDown(screen().getByRole("menu"), { key: "Escape" }));
      // A link tapped (it opens in a new tab), and back to the page: the link keeps the focus, in its row.
      within(row("w2")).getByRole("link").focus();
      expect(row("w2").contains(document.activeElement)).toBe(true);
      await tap("w3");
      actionsOpen("w3");
    } finally {
      restore();
    }
  });

  test("a thread opened with Responder: the channel keeps what came before, one line opens the rest", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-3",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "person", id: "u-walter" },
      body: "vou olhar o refresh",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    const api = createFakeApi(state);
    await state.openThread?.(ORG_ID, "m-1", state.messages.at(-1)?.createdAt ?? "");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const channel = screen().getByRole("region", { name: /Mensagens/ });
    expect(channel.textContent).toContain("Achei a causa");
    expect(channel.textContent).not.toContain("vou olhar o refresh");
    const line = within(channel).getByRole("button", { name: /1 resposta/ });
    expect(line.getAttribute("aria-pressed")).toBe("false");
    await click(line);
    await settle(6);
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(panel.textContent).toContain("vou olhar o refresh");
    expect(line.getAttribute("aria-pressed")).toBe("true");
    await click(within(panel).getByRole("button", { name: "Fechar a thread" }));
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
  });
});
