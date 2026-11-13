import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const article = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text)) as HTMLElement;
const ASK = "Quer que Ada refaça ou explique o que faltou?";
const askCard = () => screen().queryByRole("form", { name: ASK });

/** "Não ajudou" on Ada's reply (the hover bar). */
const thumbsDown = async () => {
  const reply = article("Achei a causa");
  await act(async () => fireEvent.mouseEnter(reply));
  const bar = within(reply).getByRole("toolbar", { name: "Ações da mensagem de Ada" });
  await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Não ajudou" })));
  await settle(4);
};

describe("agents' reactions", () => {
  test("an agent's reaction is in the same pills, with its mini avatar and its name", async () => {
    const state = seedState();
    const first = state.messages.find((m) => m.id === "m-1");
    if (first) first.reactions = [{ reaction: "🙌", count: 1, userIds: [], agentIds: [ADA_ID] }];
    await open(state);
    const pills = within(article("o login está devolvendo 401")).getByRole("group", { name: "Reações" });
    const pill = within(pills).getByRole("button", { name: "Ada reagiu com 🙌" });
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(pill.textContent).toContain("1");
    const avatars = pill.querySelector(".msg-react__agents");
    expect(avatars?.getAttribute("aria-hidden")).toBe("true");
    expect(avatars?.querySelector(".ac-avatar")).not.toBeNull();
  });

  test("live: people and agents on one pill", async () => {
    const { socket } = await open();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.reactions",
          channelId: ENG_ID,
          messageId: "m-1",
          reactions: [{ reaction: "🎉", count: 2, userIds: ["u-joao"], agentIds: [ADA_ID] }],
        },
      }),
    );
    await settle(2);
    const pills = within(article("o login está devolvendo 401")).getByRole("group", { name: "Reações" });
    expect(within(pills).getByRole("button", { name: "João e Ada reagiram com 🎉" })).toBeTruthy();
  });
});

describe("👎 becomes a private question", () => {
  test("my 👎 shows the card under the reply; someone else's 👎 doesn't", async () => {
    const { socket } = await open();
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "message.reactions",
          channelId: ENG_ID,
          messageId: "m-2",
          reactions: [{ reaction: "-1", count: 1, userIds: ["u-joao"], agentIds: [] }],
        },
      }),
    );
    await settle(2);
    expect(askCard()).toBeNull();

    await thumbsDown();
    const card = askCard() as HTMLElement;
    expect(card).not.toBeNull();
    expect(article("Achei a causa").contains(card)).toBe(true);
    expect(within(card).getByRole("button", { name: "Pedir correção" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Agora não" })).toBeTruthy();
  });

  test("Pedir correção posts my reply mentioning the agent, quoting its answer, in the same conversation", async () => {
    const { state } = await open();
    await thumbsDown();
    const card = askCard() as HTMLElement;
    await act(async () =>
      fireEvent.change(within(card).getByRole("textbox", { name: "O que faltou" }), {
        target: { value: "faltou o teste de regressão" },
      }),
    );
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Pedir correção" })));
    await settle(4);
    const post = state.calls.find((c) => c.method === "chat.post")?.args[2] as Record<string, unknown>;
    expect(post).toMatchObject({ body: "@ada faltou o teste de regressão", replyTo: "m-2" });
    // Ada answered in the channel: the correction goes there too, not into a thread.
    expect(post.threadId ?? null).toBeNull();
    expect(askCard()).toBeNull();
    expect(localStorage.getItem("agentes:correction-ask:m-2")).toBe("1");
  });

  test("Agora não hides it, and it doesn't come back for that message", async () => {
    const { state } = await open();
    await thumbsDown();
    await act(async () => fireEvent.click(within(askCard() as HTMLElement).getByRole("button", { name: "Agora não" })));
    await settle(1);
    expect(askCard()).toBeNull();
    expect(state.calls.some((c) => c.method === "chat.post")).toBe(false);
    // Taking the 👎 back and giving it again: still no question.
    await thumbsDown();
    await thumbsDown();
    expect(askCard()).toBeNull();
  });
});
