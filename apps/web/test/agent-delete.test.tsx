import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

/** Ada was deleted: out of the team, named only by what she left (ADR 0082). */
const adaDeleted = () => {
  const state = seedState();
  state.agents = state.agents.filter((a) => a.id !== ADA_ID);
  state.former = [{ id: ADA_ID, name: "Ada", role: "Dev", appearance: null, deleted: true }];
  return state;
};

describe("deleting an agent (ADR 0082)", () => {
  test("Zona de perigo: what goes and what stays, the name typed to confirm, then the workspace", async () => {
    const { state, router } = await go(`agents/${ADA_ID}?tab=settings&sec=danger`);
    await click(screen().getByRole("button", { name: "Apagar" }));
    const dialog = screen().getByRole("dialog", { name: "Apagar a Ada de vez?" });
    expect(dialog.textContent).toContain("Sai agora: instruções, memória, rotinas");
    expect(dialog.textContent).toContain("Fica: as mensagens e threads, com o nome e o rosto");
    const field = within(dialog).getByRole("textbox", { name: "Digite Ada para confirmar" });
    const confirm = within(dialog).getByRole("button", { name: "Apagar" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(field, "Adas");
    expect(confirm.disabled).toBe(true);
    await type(field, " ada ");
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.purge")?.args).toEqual([ORG_ID, ADA_ID]);
    expect(state.calls.some((c) => c.method === "agents.archive")).toBe(false);
    // The workspace's home (it opens a channel): no page of hers to come back to.
    expect(router.state.location.pathname).not.toContain("/agents/");
    expect(document.body.textContent).toContain("A Ada foi apagada.");
  });

  test("an old message still names a deleted agent; its card says it left, with nothing to do", async () => {
    const state = adaDeleted();
    // A question she asked, answered before she went.
    state.messages.push({
      id: "msg-q",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-1",
      meta: {
        question: {
          id: "q1",
          agentId: ADA_ID,
          channelId: ENG_ID,
          threadId: null,
          messageId: "msg-q",
          text: "Faço o deploy agora ou depois das 18h?",
          choices: ["Agora", "Depois das 18h"],
          status: "answered",
          answer: "Agora",
          answeredByUserId: "u-joao",
        },
      },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const names = screen().getAllByRole("button", { name: "Perfil de Ada" });
    expect(names.length).toBeGreaterThan(0);
    expect(screen().getByRole("group", { name: "Pergunta de Ada" })).toBeTruthy();
    // Her face, never a person's initial.
    const faces = [...document.querySelectorAll('[aria-label="Perfil de Ada"] [data-kind]')].map((e) =>
      e.getAttribute("data-kind"),
    );
    expect(faces).toContain("agent");
    expect(faces).not.toContain("person");
    await click(names[0] as HTMLElement);
    await settle(4);
    const card = screen().getByRole("dialog", { name: "Perfil" });
    expect(card.textContent).toContain("Não faz mais parte deste workspace");
    expect(within(card).queryByRole("link", { name: "Mensagem direta" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Ver perfil" })).toBeNull();
  });

  test("the mention list never offers it", async () => {
    await go(`c/${ENG_ID}`, adaDeleted());
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => {
      fireEvent.change(box, { target: { value: "@a", selectionStart: 2, selectionEnd: 2 } });
    });
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    expect(list.textContent).toContain("Atlas");
    expect(list.textContent).not.toContain("Ada");
  });

  test("an archived agent has no page: admins delete it from Equipe › Arquivados", async () => {
    const state = seedState();
    state.former = [{ id: "agent-old", name: "New agent", role: "", appearance: null, deleted: false }];
    await go("team", state);
    const card = screen().getByRole("heading", { name: "Arquivados" }).closest(".team-archived") as HTMLElement;
    expect(card.textContent).toContain("New agent");
    await click(within(card).getByRole("button", { name: "Apagar o New agent" }));
    const dialog = screen().getByRole("dialog", { name: "Apagar o New agent de vez?" });
    await type(within(dialog).getByRole("textbox", { name: "Digite New agent para confirmar" }), "new agent");
    await click(within(dialog).getByRole("button", { name: "Apagar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.purge")?.args).toEqual([ORG_ID, "agent-old"]);
    expect(screen().queryByRole("heading", { name: "Arquivados" })).toBeNull();
  });

  test("an archived agent comes back from Equipe › Arquivados with Restaurar", async () => {
    const state = seedState();
    state.former = [{ id: "agent-old", name: "New agent", role: "", appearance: null, deleted: false }];
    await go("team", state);
    const card = screen().getByRole("heading", { name: "Arquivados" }).closest(".team-archived") as HTMLElement;
    await click(within(card).getByRole("button", { name: "Restaurar o New agent" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.unarchive")?.args).toEqual([ORG_ID, "agent-old"]);
    expect(document.body.textContent).toContain("O New agent voltou para o time.");
    expect(screen().queryByRole("heading", { name: "Arquivados" })).toBeNull();
  });

  test("archiving an agent: Desfazer in its toast brings it back, on its page", async () => {
    const { state, router } = await go(`agents/${ADA_ID}`);
    const more = screen().getByRole("button", { name: "Mais ações" });
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Arquivar a Ada" }));
    await click(
      within(screen().getByRole("dialog", { name: "Arquivar a Ada?" })).getByRole("button", { name: "Arquivar" }),
    );
    await settle(6);
    expect(state.calls.some((c) => c.method === "agents.archive")).toBe(true);
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.unarchive")?.args).toEqual([ORG_ID, ADA_ID]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
  });

  test("members see no archived list", async () => {
    const state = seedState();
    state.former = [{ id: "agent-old", name: "New agent", role: "", appearance: null, deleted: false }];
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go("team", state);
    expect(screen().queryByRole("heading", { name: "Arquivados" })).toBeNull();
  });

  test("the inbox still names it", async () => {
    const state = adaDeleted();
    state.notifications = [
      notification({
        id: "n-thread",
        kind: "thread_reply",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { channelId: ENG_ID, threadId: "m-1", label: "Login 401" },
        latest: { text: "Corrigi o refresh." },
      }),
    ];
    await go("notifications", state);
    expect(screen().getByRole("main").textContent).toContain("Ada respondeu em Login 401");
  });

  test("its page is gone", async () => {
    await go(`agents/${ADA_ID}`, adaDeleted());
    expect(screen().queryByRole("tablist", { name: "Seções da Ada" })).toBeNull();
  });
});
