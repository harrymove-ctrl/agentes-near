import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { messagePath } from "@agenteschat/client/lib/message-links";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { messageLink } from "@/components/MessageMore";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const SECRET_ID = "00000000-0000-4000-8000-0000000000c9";
const DM_ID = "00000000-0000-4000-8000-0000000000d9";
const TARGET = "00000000-0000-4000-8000-0000000000e1";
const REPLY = "00000000-0000-4000-8000-0000000000e2";
const HIDDEN = "00000000-0000-4000-8000-0000000000e3";
const IN_DM = "00000000-0000-4000-8000-0000000000e4";

/** #eng's message and a reply to it, one in a private channel I'm not in, one in my DM with Ada; `body` in #general. */
function withLinks(body: string) {
  const state = seedState();
  state.channels.push({
    id: SECRET_ID,
    name: "diretoria",
    topic: "",
    visibility: "private",
    isMember: false,
    createdAt: new Date().toISOString(),
  });
  state.dms.push({ channelId: DM_ID, with: { type: "agent", id: ADA_ID, name: "Ada", handle: "ada" } });
  const at = Date.now() - 60_000;
  const message = (id: string, channelId: string, text: string, threadId: string | null = null, author = "u-joao") => ({
    id,
    channelId,
    threadId,
    author: { type: "person" as const, id: author },
    body: text,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(at).toISOString(),
  });
  state.messages.push(
    message(TARGET, ENG_ID, "o deploy das 9h quebrou o login"),
    message(REPLY, ENG_ID, "já revertemos", TARGET),
    message(HIDDEN, SECRET_ID, "orçamento do trimestre"),
    message(IN_DM, DM_ID, "os acessos de hoje", null, "u-walter"),
    { ...message("00000000-0000-4000-8000-0000000000e9", GENERAL_ID, body), createdAt: new Date().toISOString() },
  );
  return state;
}

const at = (path: string) => `${window.location.origin}${path}`;

describe("a message link in a message is a pill", () => {
  test("# eng › 💬, named for the reader, opening the message in the app", async () => {
    const link = at(messagePath(ORG_ID, { id: TARGET, channelId: ENG_ID }));
    const { router } = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, {
      api: createFakeApi(withLinks(`olha isso ${link}`)),
    });
    await settle(6);
    const pill = screen().getByRole("link", { name: "Mensagem de João em #eng" });
    expect(pill.textContent).toBe("eng");
    expect(pill.getAttribute("target")).toBeNull();
    expect(pill.getAttribute("href")).toBe(`/org/${ORG_ID}/c/${ENG_ID}?m=${TARGET}`);
    expect(document.body.textContent).not.toContain(link);
    await act(async () => fireEvent.click(pill));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(router.state.location.search).toEqual({ m: TARGET });
  });

  test("a pill to a message of the same conversation jumps to it there", async () => {
    const state = withLinks("");
    const earlier = "00000000-0000-4000-8000-0000000000ea";
    state.messages.push({
      id: earlier,
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "person" as const, id: "u-joao" },
      body: "a pauta de sexta",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const last = state.messages.find((m) => m.id === "00000000-0000-4000-8000-0000000000e9");
    if (last) last.body = `vê ${at(messagePath(ORG_ID, { id: earlier, channelId: GENERAL_ID }))}`;
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const row = document.querySelector(`[data-message-id="${earlier}"]`);
    expect(row?.classList.contains("ac-msg--focus")).toBe(false);
    await act(async () => fireEvent.click(screen().getByRole("link", { name: "Mensagem de João em #general" })));
    await settle(6);
    expect(document.querySelector(`[data-message-id="${earlier}"]`)?.classList.contains("ac-msg--focus")).toBe(true);
  });

  test("a reply's pill says Thread and opens its thread; a DM's names who it's with", async () => {
    const reply = at(messagePath(ORG_ID, { id: REPLY, channelId: ENG_ID, threadId: TARGET }));
    const dm = at(messagePath(ORG_ID, { id: IN_DM, channelId: DM_ID }));
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(withLinks(`${reply} e ${dm}`)) });
    await settle(6);
    const inThread = screen().getByRole("link", { name: "Mensagem de João em uma thread de #eng" });
    expect(inThread.textContent).toBe("engThread");
    expect(inThread.getAttribute("href")).toBe(`/org/${ORG_ID}/threads/${TARGET}?m=${REPLY}`);
    const inDm = screen().getByRole("link", { name: "Mensagem de Walter na DM com Ada" });
    expect(inDm.textContent).toBe("@Ada");
  });

  test("one the reader can't see says so, and nothing of where it is", async () => {
    const link = at(messagePath(ORG_ID, { id: HIDDEN, channelId: SECRET_ID }));
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(withLinks(`veja ${link}`)) });
    await settle(6);
    const pill = document.querySelector(".message-ref--none");
    expect(pill?.textContent).toBe("Mensagem sem acesso");
    expect(pill?.closest("article")?.textContent).not.toContain("diretoria");
    expect(screen().queryByRole("link", { name: /Mensagem sem acesso/ })).toBeNull();
  });

  test("another server's link stays a plain link", async () => {
    const link = `https://elsewhere.example${messagePath(ORG_ID, { id: TARGET, channelId: ENG_ID })}`;
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(withLinks(link)) });
    await settle(6);
    expect(screen().getByRole("link", { name: link }).getAttribute("target")).toBe("_blank");
  });
});

describe("one permalink for every message", () => {
  test("a thread's reply links to its thread; a DM's link opens the DM at the message", async () => {
    expect(messageLink("https://x", ORG_ID, { id: REPLY, channelId: ENG_ID, threadId: TARGET })).toBe(
      `https://x/org/${ORG_ID}/threads/${TARGET}?m=${REPLY}`,
    );
    const { router } = await renderApp(`/org/${ORG_ID}/c/${DM_ID}?m=${IN_DM}`, {
      api: createFakeApi(withLinks("oi")),
    });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(router.state.location.search).toEqual({ m: IN_DM });
  });
});
